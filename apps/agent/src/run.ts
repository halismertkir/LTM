import { hostname } from "node:os";
import {
  type CaptureEvent,
  CaptureSession,
  type StreamErrorCode,
  type WebSocketFactory,
} from "@ltm/capture";
import { AgentApi, ApiError } from "./api.js";
import type { Command } from "./args.js";
import { EXIT, type Io } from "./commands.js";
import type { AgentConfig } from "./config.js";
import {
  FfmpegSupervisor,
  ffmpegArgs,
  type InputChoice,
  InputError,
  type SpawnFn,
} from "./ffmpeg.js";
import { SampleClock } from "./timestamps.js";

type RunCommand = Extract<Command, { name: "run" }>;

export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", fn: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", fn: () => void): unknown;
}

export interface RunDeps {
  io: Io;
  signals: SignalSource;
  spawn?: SpawnFn;
  createSocket?: WebSocketFactory;
  /** Hard exit for a second Ctrl-C. */
  forceExit?: (code: number) => void;
  platform?: NodeJS.Platform;
}

const FATAL_HELP: Partial<Record<StreamErrorCode, string>> = {
  consent_required:
    "The server requires consent before it accepts audio (consent_required). Run: ltm-agent consent",
  ingest_paused:
    "Capture is paused for your account (ingest_paused). Resume it in the LTM dashboard, then start the agent again.",
  unauthorized:
    "The server rejected this device's token (removed in the dashboard?). Pair again: ltm-agent pair --server <url> --code <code>",
  forbidden: "This device is not allowed to capture. Check its access in the dashboard.",
  unsupported_protocol:
    "The server speaks a different protocol version. Update the agent or the server.",
};
const NEEDS_USER: ReadonlySet<string> = new Set([
  "consent_required",
  "ingest_paused",
  "unauthorized",
  "forbidden",
]);

/**
 * `ltm-agent run`: ffmpeg → SampleClock (wall-clock stamps) → CaptureSession (re-block →
 * gate → resumable stream). Runs until SIGINT/SIGTERM (or the end of `--file`), then ends
 * the stream cleanly. The stream id stays the same for the life of the process, across
 * server reconnects and ffmpeg restarts.
 */
export async function runCommand(
  cmd: RunCommand,
  cfg: AgentConfig,
  deps: RunDeps,
): Promise<number> {
  const { io } = deps;
  const log = (msg: string) => io.err(`[ltm-agent] ${msg}`);
  const verbose = (msg: string) => {
    if (cmd.verbose) log(msg);
  };

  let args: string[];
  try {
    const choice: InputChoice = {};
    if (cmd.input) choice.input = cmd.input;
    if (cmd.file) choice.file = cmd.file;
    args = ffmpegArgs(choice, deps.platform);
  } catch (err) {
    if (err instanceof InputError) {
      log(err.message);
      return EXIT.USAGE;
    }
    throw err;
  }

  // Preflight: fail fast with a precise message for problems only a person can fix. An
  // unreachable server is not one of them — at boot the network may not be up yet, and
  // the stream client keeps retrying.
  try {
    const me = await new AgentApi(cfg.serverUrl, cfg.token, 10_000).me();
    if (!me.consent.satisfied) {
      log(FATAL_HELP.consent_required!);
      return EXIT.NEEDS_USER;
    }
    if (me.ingestPaused) {
      log(FATAL_HELP.ingest_paused!);
      return EXIT.NEEDS_USER;
    }
  } catch (err) {
    if (err instanceof ApiError && err.code === "unauthorized") {
      log(FATAL_HELP.unauthorized!);
      return EXIT.NEEDS_USER;
    }
    log(
      `server check failed (${err instanceof Error ? err.message : String(err)}); will keep retrying`,
    );
  }

  let fatal: { code: StreamErrorCode; message: string } | null = null;
  let lastPhase = "";
  const onEvent = (e: CaptureEvent) => {
    switch (e.type) {
      case "phase": {
        const text =
          e.phase === "reconnecting"
            ? `reconnecting (${Math.round((e.bufferedMs ?? 0) / 1000)} s of audio buffered)`
            : e.phase === "streaming"
              ? "streaming"
              : e.phase;
        if (text !== lastPhase) log(text);
        lastPhase = text;
        return;
      }
      case "segment":
        if (cmd.captions) io.err(`» ${e.segment.text}`);
        return;
      case "error":
        if (e.fatal) fatal = { code: e.code, message: e.message };
        else verbose(`stream: ${e.code}: ${e.message}`);
        return;
      case "level":
        verbose(`level ${e.dbfs.toFixed(1)} dBFS${e.speaking ? " (sending)" : ""}`);
        return;
    }
  };

  const sessionOpts: ConstructorParameters<typeof CaptureSession>[0] = {
    serverUrl: cfg.serverUrl,
    token: cfg.token,
    source: cmd.source,
    context: { app: "ltm-agent", title: (cmd.title ?? `ltm-agent on ${hostname()}`).slice(0, 300) },
    onEvent,
  };
  if (cmd.language) sessionOpts.language = cmd.language;
  if (deps.createSocket) sessionOpts.createSocket = deps.createSocket;
  const session = new CaptureSession(sessionOpts);
  const clock = new SampleClock();

  let resolveStop!: (why: "signal" | "input_done") => void;
  const stopRequested = new Promise<"signal" | "input_done">((r) => {
    resolveStop = r;
  });
  let inputResult: { code: number | null; stderr: string; notFound: boolean } | null = null;

  const supervisorOpts: ConstructorParameters<typeof FfmpegSupervisor>[0] = {
    ffmpegPath: cmd.ffmpeg ?? "ffmpeg",
    args,
    restart: !cmd.file,
    onStart: (attempt) => {
      // A new ffmpeg process: its samples do not continue the previous ones.
      clock.reset();
      verbose(
        attempt === 0 ? "audio input started" : `audio input restarted (attempt ${attempt + 1})`,
      );
    },
    onPcm: (samples) => {
      for (const c of clock.push(samples)) {
        if (c.discontinuity && clock.anchorCount > 1) {
          verbose(`audio clock re-anchored (drift ${Math.round(clock.driftMs)} ms)`);
        }
        session.pushPcm(c.samples, c.captureTimeMs, c.discontinuity);
      }
    },
    onExit: ({ code, signal, stderr, restartInMs }) => {
      if (restartInMs === null) return;
      const why = stderr.split("\n").filter(Boolean).at(-1) ?? `exit ${code ?? signal}`;
      log(`audio input stopped (${why}); restarting in ${(restartInMs / 1000).toFixed(1)} s`);
    },
    onDone: ({ code, stderr }) => {
      inputResult = { code, stderr, notFound: /ENOENT/.test(stderr) };
      resolveStop("input_done");
    },
  };
  if (deps.spawn) supervisorOpts.spawn = deps.spawn;
  const supervisor = new FfmpegSupervisor(supervisorOpts);

  let signalCount = 0;
  const onSignal = () => {
    signalCount++;
    if (signalCount === 1) {
      log("stopping…");
      resolveStop("signal");
    } else {
      log("forced exit");
      (deps.forceExit ?? ((c) => process.exit(c)))(130);
    }
  };
  deps.signals.on("SIGINT", onSignal);
  deps.signals.on("SIGTERM", onSignal);

  try {
    await session.start();
    supervisor.start();
    const outcome = await Promise.race([
      stopRequested,
      session.closed.then(() => "closed" as const),
    ]);

    if (outcome === "closed") {
      await supervisor.stop();
      const f = fatal as { code: StreamErrorCode; message: string } | null;
      if (f) {
        log(`server refused the stream: ${f.code}${f.message ? ` (${f.message})` : ""}`);
        log(FATAL_HELP[f.code] ?? "Fix the problem above and start the agent again.");
        return NEEDS_USER.has(f.code) ? EXIT.NEEDS_USER : EXIT.FAILURE;
      }
      log("the server ended the stream");
      return EXIT.FAILURE;
    }

    // Signal or end of input: stop listening first, then flush and end the stream.
    await supervisor.stop();
    for (const c of clock.flush()) session.pushPcm(c.samples, c.captureTimeMs, c.discontinuity);
    await session.stop();
    const end = await session.closed;
    const result = inputResult as { code: number | null; stderr: string; notFound: boolean } | null;
    if (outcome === "input_done" && result) {
      if (result.notFound) {
        log(
          `ffmpeg not found ("${supervisorOpts.ffmpegPath}"). Install it or pass --ffmpeg <path>.`,
        );
        return EXIT.FAILURE;
      }
      if (result.code !== 0) {
        log(
          `ffmpeg failed: ${result.stderr.split("\n").filter(Boolean).at(-1) ?? `exit ${result.code}`}`,
        );
        return EXIT.FAILURE;
      }
    }
    if (end.reason === "fatal") {
      log(`stream ended with ${end.code ?? "an error"}`);
      return EXIT.FAILURE;
    }
    log("stream ended cleanly");
    return EXIT.OK;
  } finally {
    deps.signals.off("SIGINT", onSignal);
    deps.signals.off("SIGTERM", onSignal);
  }
}
