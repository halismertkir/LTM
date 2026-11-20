/**
 * The real CLI, end to end: the agent is bundled exactly like `pnpm build`, run as a child
 * process with `--file` on a WAV synthesised here (44.1 kHz stereo, so ffmpeg really
 * resamples and downmixes), and streams to a local server implementing the ingest protocol.
 * Needs ffmpeg on PATH (or LTM_AGENT_FFMPEG).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import { FakeLtm } from "./fakes/server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "ltm-agent-e2e-"));
const cli = join(work, "ltm-agent.mjs");
const ffmpeg = process.env.LTM_AGENT_FFMPEG ?? "ffmpeg";

/** 16-bit PCM WAV. `signal(t)` in [-1, 1] for each channel. */
function writeWav(
  path: string,
  seconds: number,
  rate: number,
  channels: number,
  signal: (t: number) => number,
) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * channels * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, signal(i / rate)));
    for (let c = 0; c < channels; c++)
      data.writeInt16LE(Math.round(v * 32767), (i * channels + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

const burst = (t: number) => 0.3 * Math.sin(2 * Math.PI * 440 * t);
/** 0.6 s silence · 1.4 s tone · 3 s silence · 1.4 s tone · 1 s silence = 7.4 s */
const bursts = (t: number) => ((t >= 0.6 && t < 2.0) || (t >= 5.0 && t < 6.4) ? burst(t) : 0);

function runCli(args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LTM_AGENT_FFMPEG: ffmpeg },
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
  const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
  return { child, exited, output: () => ({ stderr, stdout }) };
}

beforeAll(() => {
  execFileSync(process.execPath, [join(root, "scripts/build.mjs"), cli], { stdio: "inherit" });
  writeWav(join(work, "bursts.wav"), 7.4, 44_100, 2, bursts);
  writeWav(join(work, "long.wav"), 30, 48_000, 1, burst);
});

let server: FakeLtm;
let config: string;
beforeEach(async () => {
  server = new FakeLtm();
  await server.start();
  server.consent = { recording_responsibility: true, data_processing: true };
  config = join(mkdtempSync(join(tmpdir(), "ltm-agent-e2e-cfg-")), "config.json");
  saveConfig(config, { serverUrl: server.url, token: server.token, deviceId: "dev-agent" });
});
afterEach(async () => {
  await server.stop();
});

describe("ltm-agent run (real CLI, real ffmpeg)", () => {
  it("streams a file at real-time speed: 16 kHz mono frames, silence gated, timestamps on the wall clock", async () => {
    const started = Date.now();
    const run = runCli([
      "run",
      "--file",
      join(work, "bursts.wav"),
      "--config",
      config,
      "--captions",
      "--title",
      "E2E desk",
      "--language",
      "en",
    ]);
    const code = await run.exited;
    const wall = Date.now() - started;
    const { stderr } = run.output();
    expect(code, stderr).toBe(0);
    expect(server.errors).toEqual([]);
    expect(server.streams.size).toBe(1);
    const s = [...server.streams.values()][0]!;

    expect(s.hello).toMatchObject({
      source: "mic",
      mode: "audio",
      language: "en",
      audio: { codec: "pcm_s16le", sampleRate: 16_000, channels: 1 },
      context: { app: "ltm-agent", title: "E2E desk" },
    });
    expect(s.ended).toBe(true); // `end` → `closed` at end of input
    // -re: the 7.4 s file took about 7.4 s
    expect(wall).toBeGreaterThan(7000);

    const f = s.frames;
    // ~2.8 s of tone (+ pre-roll/hangover); 7.4 s would be 37 frames ungated
    expect(f.length).toBeGreaterThanOrEqual(14);
    expect(f.length).toBeLessThanOrEqual(28);
    for (const x of f) {
      expect(x.payload.byteLength % 2).toBe(0);
      expect(x.payload.byteLength).toBeLessThanOrEqual(6400);
    }
    expect(f.map((x) => x.seq)).toEqual(f.map((_, i) => i));
    for (let i = 1; i < f.length; i++)
      expect(f[i]!.captureTimeMs).toBeGreaterThan(f[i - 1]!.captureTimeMs);
    // full frames inside a burst are exactly 200 ms of audio apart
    const contiguous = f
      .slice(1)
      .filter((x, i) => !x.discontinuity && f[i]!.payload.byteLength === 6400);
    expect(contiguous.length).toBeGreaterThan(8);
    for (const x of contiguous) {
      const prev = f[f.indexOf(x) - 1]!;
      expect(x.captureTimeMs - prev.captureTimeMs).toBeCloseTo(200, 6);
    }
    // the gated gap shows up as a discontinuity whose timestamp jumps by ≈ the silence
    const gap = f.findIndex(
      (x, i) => i > 0 && x.discontinuity && x.captureTimeMs - f[i - 1]!.captureTimeMs > 1500,
    );
    expect(gap).toBeGreaterThan(0);
    // second burst starts 5.0 s into the file, first at 0.6 s (pre-roll ≤ 400 ms each)
    const firstTone = f[0]!.captureTimeMs;
    const secondTone = f[gap]!.captureTimeMs;
    expect(secondTone - firstTone).toBeGreaterThan(4000);
    expect(secondTone - firstTone).toBeLessThan(4900);
    // timestamps are wall-clock capture times: within the run and close to arrival
    expect(firstTone).toBeGreaterThanOrEqual(started - 1000);
    for (const x of f) {
      const lag = x.receivedAt - x.captureTimeMs;
      expect(lag).toBeGreaterThan(-100);
      expect(lag).toBeLessThan(2500);
    }
    // the audio is a 440 Hz tone at about the level we wrote
    const mid = new Int16Array(
      f[3]!.payload.buffer,
      f[3]!.payload.byteOffset,
      f[3]!.payload.byteLength / 2,
    );
    const peak = Math.max(...Array.from(mid, Math.abs));
    expect(peak).toBeGreaterThan(0.25 * 32767);
    expect(peak).toBeLessThan(0.35 * 32767);

    expect(stderr).toContain("[ltm-agent] streaming");
    expect(stderr).toContain("» fake caption line");
    expect(stderr).toContain("stream ended cleanly");
    expect(stderr).not.toContain(server.token);
  }, 30_000);

  it("ends the stream cleanly on SIGTERM (end → closed) and exits 0", async () => {
    const run = runCli([
      "run",
      "--file",
      join(work, "long.wav"),
      "--config",
      config,
      "--source",
      "ambient",
    ]);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const s = [...server.streams.values()][0];
      if (s && s.frames.length >= 5) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    run.child.kill("SIGTERM");
    const code = await run.exited;
    const s = [...server.streams.values()][0]!;
    expect(code, run.output().stderr).toBe(0);
    expect(s.hello.source).toBe("ambient");
    expect(s.ended).toBe(true);
    expect(s.closedSent).toBe(true);
    expect(s.frames.length).toBeLessThan(100); // stopped well before the 30 s file ended
    expect(run.output().stderr).toContain("stopping");
  }, 30_000);

  it("exits non-zero with a clear message when the file cannot be read", async () => {
    const run = runCli(["run", "--file", join(work, "missing.wav"), "--config", config]);
    const code = await run.exited;
    expect(code).toBe(1);
    expect(run.output().stderr).toMatch(/ffmpeg failed: .*No such file/);
  }, 20_000);

  it("exits with code 3 and points to `ltm-agent consent` when the server refuses the stream", async () => {
    // consent was withdrawn after the preflight passed: the WebSocket refuses with consent_required
    const run = runCli(["run", "--file", join(work, "long.wav"), "--config", config]);
    await new Promise((r) => setTimeout(r, 200));
    server.consent = { recording_responsibility: false, data_processing: true };
    for (const c of (server as unknown as { wss: { clients: Set<{ terminate(): void }> } }).wss
      .clients)
      c.terminate();
    const code = await run.exited;
    expect(code, run.output().stderr).toBe(3);
    expect(run.output().stderr).toMatch(/consent_required/);
    expect(run.output().stderr).toMatch(/ltm-agent consent/);
  }, 30_000);
});
