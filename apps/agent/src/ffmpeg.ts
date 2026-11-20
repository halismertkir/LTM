import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { type BackoffOptions, backoffDelay } from "@ltm/capture";

/** Raised for configurations that cannot work (no default input on this platform, …). */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/**
 * ffmpeg input arguments for the platform's default microphone. Overridden by `--input`.
 * - Linux: PulseAudio / PipeWire-pulse default source (`-f alsa -i default` via --input
 *   for ALSA-only systems).
 * - macOS: the default AVFoundation audio device (":0" = no video, first audio input).
 * - Windows: DirectShow needs a device *name*; there is no portable "default", so the user
 *   picks one (`ltm-agent devices` lists them).
 */
export function defaultInputArgs(platform: NodeJS.Platform = process.platform): string[] {
  switch (platform) {
    case "linux":
      return ["-f", "pulse", "-i", "default"];
    case "darwin":
      return ["-f", "avfoundation", "-i", ":0"];
    case "win32":
      throw new InputError(
        "Windows needs a device: run `ltm-agent devices`, then `ltm-agent run --input '-f dshow -i audio=\"<name>\"'`.",
      );
    default:
      throw new InputError(
        `no default microphone input for ${platform}; pass --input "<ffmpeg input args>"`,
      );
  }
}

export interface InputChoice {
  input?: string[];
  file?: string;
}

/** Full ffmpeg argument list: input → 16 kHz mono s16le on stdout. */
export function ffmpegArgs(
  choice: InputChoice,
  platform: NodeJS.Platform = process.platform,
): string[] {
  let input: string[];
  if (choice.file) {
    // -re: read at the file's native rate, so the server sees real time. (ffmpeg still
    // delivers the first ~0.5 s at once; SampleClock's warm-up absorbs that.)
    input = ["-re", "-i", choice.file];
  } else if (choice.input) {
    input = choice.input;
  } else {
    input = defaultInputArgs(platform);
  }
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-acodec",
    "pcm_s16le",
    "-f",
    "s16le",
    "pipe:1",
  ];
}

/** Arguments that make ffmpeg print the platform's capture devices (best effort). */
export function listDevicesArgs(platform: NodeJS.Platform = process.platform): string[][] {
  switch (platform) {
    case "linux":
      return [
        ["-hide_banner", "-sources", "pulse"],
        ["-hide_banner", "-sources", "alsa"],
      ];
    case "darwin":
      return [["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]];
    case "win32":
      return [["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]];
    default:
      return [["-hide_banner", "-devices"]];
  }
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SupervisorOptions {
  ffmpegPath: string;
  args: string[];
  /** Restart ffmpeg when it exits (live input). For files, exit means "done". */
  restart: boolean;
  onPcm: (samples: Int16Array) => void;
  /** A (new) ffmpeg process started; the next samples do not follow the previous ones. */
  onStart?: (attempt: number) => void;
  onExit?: (info: {
    code: number | null;
    signal: string | null;
    stderr: string;
    restartInMs: number | null;
  }) => void;
  /** No more audio will come (file finished, or stop()). */
  onDone?: (info: { code: number | null; stderr: string }) => void;
  spawn?: SpawnFn;
  backoff?: BackoffOptions;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  /** A process that ran this long resets the back-off. */
  healthyAfterMs?: number;
  /** Grace period between SIGTERM and SIGKILL on stop. */
  killAfterMs?: number;
}

const FFMPEG_BACKOFF: BackoffOptions = { initialMs: 1000, maxMs: 30_000, factor: 2, jitter: 0.3 };
const STDERR_KEEP = 4000;

/**
 * Runs ffmpeg and turns its stdout into Int16 samples. For live input the process is
 * restarted with back-off when it dies (device unplugged, PulseAudio restarted); the
 * caller's stream keeps going, and `onStart` tells it the audio is discontinuous.
 */
export class FfmpegSupervisor {
  private child: ChildProcess | null = null;
  private attempt = 0;
  private startedAt = 0;
  private stopped = false;
  private leftover: Buffer | null = null;
  private stderr = "";
  private restartTimer: unknown = null;
  private exited: Promise<void> = Promise.resolve();
  private readonly spawnFn: SpawnFn;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly o: SupervisorOptions) {
    this.spawnFn = o.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = o.now ?? (() => Date.now());
  }

  get running(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.stopped || this.child) return;
    this.leftover = null;
    this.stderr = "";
    this.startedAt = this.now();
    let child: ChildProcess;
    try {
      child = this.spawnFn(this.o.ffmpegPath, this.o.args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      this.handleExit(null, null, `spawn failed: ${(err as Error).message}`);
      return;
    }
    this.child = child;
    this.o.onStart?.(this.attempt);
    let resolveExit!: () => void;
    this.exited = new Promise((r) => {
      resolveExit = r;
    });
    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_KEEP);
    });
    let done = false;
    const finish = (code: number | null, signal: string | null, extra = "") => {
      if (done) return;
      done = true;
      if (this.child === child) this.child = null;
      resolveExit();
      this.handleExit(code, signal, extra);
    };
    child.on("error", (err) => {
      // A missing binary will not appear by retrying: give up instead of looping.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") this.stopped = true;
      finish(null, null, `\n${err.message}`);
    });
    child.on("close", (code, signal) => finish(code, signal));
  }

  /** Stops ffmpeg (SIGTERM, then SIGKILL) and resolves once it is gone. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer !== null) {
      this.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    const killer = this.setTimer(() => child.kill("SIGKILL"), this.o.killAfterMs ?? 3000);
    await this.exited;
    this.clearTimer(killer);
  }

  private onData(chunk: Buffer): void {
    let buf = chunk;
    if (this.leftover) {
      buf = Buffer.concat([this.leftover, chunk]);
      this.leftover = null;
    }
    const usable = buf.length - (buf.length % 2);
    if (usable < buf.length) this.leftover = Buffer.from(buf.subarray(usable));
    if (usable === 0) return;
    // Copy into a fresh, aligned buffer; s16le → host order (little-endian everywhere Node runs).
    const samples = new Int16Array(usable / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2);
    this.o.onPcm(samples);
  }

  private handleExit(code: number | null, signal: string | null, extra: string): void {
    const stderr = (this.stderr + extra).trim();
    if (this.stopped || !this.o.restart) {
      this.o.onExit?.({ code, signal, stderr, restartInMs: null });
      this.o.onDone?.({ code, stderr });
      return;
    }
    if (this.now() - this.startedAt >= (this.o.healthyAfterMs ?? 10_000)) this.attempt = 0;
    const delay = backoffDelay(
      this.attempt,
      this.o.backoff ?? FFMPEG_BACKOFF,
      this.o.random ?? Math.random,
    );
    this.attempt++;
    this.o.onExit?.({ code, signal, stderr, restartInMs: delay });
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }
}
