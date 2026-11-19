/**
 * End-to-end check of the network path without Chrome: the real DSP chain (CaptureDsp as
 * run by the worklet → CaptureClock → EnergyGate), the real session runner and stream
 * client, Node's built-in WebSocket, and a local `ws` server speaking the ingest protocol.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaptureClock } from "../src/audio/clock.js";
import { CaptureDsp } from "../src/audio/dsp.js";
import type { StampedBlock } from "../src/audio/gate.js";
import { leBytesToS16 } from "../src/audio/pcm.js";
import { CaptureSessionRunner, type SessionDeps } from "../src/offscreen/session.js";
import type { CaptureStartSpec, FromOffscreen } from "../src/shared/messages.js";
import type { WebSocketLike } from "../src/stream/client.js";
import { FakeIngestServer } from "./fakes/fakeServer.js";
import { amplitudeAt } from "./fakes/signals.js";

const CTX_RATE = 48_000;

/**
 * Stands in for CapturePipeline: renders `seconds` of synthetic audio in 128-frame quanta
 * through the worklet DSP, maps context frames to wall-clock time with CaptureClock
 * (anchored to Date.now(), as in the browser), and paces itself at `speed`× real time. The
 * wall clock it reports is *virtual* real time (start + audio position), as it would be if
 * the audio had been captured live.
 */
function syntheticPipeline(pattern: (t: number) => number, seconds: number, speed: number) {
  const started = Date.now();
  let stopped = false;
  const startPipeline: SessionDeps["startPipeline"] = async ({ onBlock }) => {
    const dsp = new CaptureDsp(CTX_RATE);
    const clock = new CaptureClock();
    const quantum = new Float32Array(128);
    const totalQuanta = Math.floor((seconds * CTX_RATE) / 128);
    let q = 0;
    const tick = () => {
      if (stopped) return;
      // render ~100 ms of audio per tick
      const until = Math.min(totalQuanta, q + Math.ceil((0.1 * CTX_RATE) / 128));
      for (; q < until; q++) {
        for (let i = 0; i < 128; i++) quantum[i] = pattern((q * 128 + i) / CTX_RATE);
        for (const b of dsp.push([quantum], q * 128)) {
          const ctxSec = (q * 128) / CTX_RATE;
          clock.observe(ctxSec, started + ctxSec * 1000);
          const block: StampedBlock = {
            pcm: b.pcm,
            captureTimeMs: clock.toEpochMs(b.contextFrame / CTX_RATE),
            discontinuity: b.discontinuity || clock.takeStep(),
          };
          onBlock(block);
        }
      }
      if (q < totalQuanta) setTimeout(tick, 100 / speed);
    };
    setTimeout(tick, 0);
    return {
      stop() {
        stopped = true;
      },
    };
  };
  return {
    startPipeline,
    started,
    done: () => new Promise((r) => setTimeout(r, (seconds * 1000) / speed + 300)),
  };
}

/** 1 s of 440 Hz "speech", 3 s silence, 1 s speech, 1 s silence (+ hangover) */
const pattern = (t: number) =>
  (t >= 0.5 && t < 1.5) || (t >= 4.5 && t < 5.5) ? 0.3 * Math.sin(2 * Math.PI * 440 * t) : 0;

function fakeTrackStream(): MediaStream {
  const track = { stop() {}, addEventListener() {} };
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

let server: FakeIngestServer;
let base: string;

beforeEach(async () => {
  server = new FakeIngestServer();
  base = await server.start();
});
afterEach(async () => {
  await server.stop();
});

function runner(
  spec: Partial<CaptureStartSpec>,
  pipeline: ReturnType<typeof syntheticPipeline>,
  reports: FromOffscreen[],
) {
  const full: CaptureStartSpec = {
    source: "tab",
    streamId: crypto.randomUUID(),
    serverUrl: base,
    token: "tok_e2e_0123456789abcdef",
    mode: "audio",
    context: { app: "meet.google.com", title: "Weekly sync" },
    ...spec,
  };
  return new CaptureSessionRunner(full, {
    openStream: async () => fakeTrackStream(),
    startPipeline: pipeline.startPipeline,
    createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
    createTranscriber: async () => null,
    report: (m) => reports.push(m),
    isPermissionError: () => false,
  });
}

describe("network path end to end (Node WebSocket ↔ local ws server)", () => {
  it("delivers gated, timestamped frames that decode with the protocol codec", async () => {
    const reports: FromOffscreen[] = [];
    const pipe = syntheticPipeline(pattern, 7, 10);
    const r = runner({}, pipe, reports);
    await r.start();
    await pipe.done();
    await r.stop("user");

    expect(server.errors).toEqual([]);
    expect(server.streams.size).toBe(1);
    const stream = [...server.streams.values()][0]!;
    expect(stream.hello).toMatchObject({
      type: "hello",
      source: "tab",
      mode: "audio",
      audio: { codec: "pcm_s16le", sampleRate: 16_000, channels: 1 },
    });
    expect(stream.hello.context).toEqual({ app: "meet.google.com", title: "Weekly sync" });
    expect(stream.ended).toBe(true);

    const frames = stream.frames;
    // 7 s of audio but only ~2 s of tone: the gate dropped most of the silence.
    expect(frames.length).toBeGreaterThan(8);
    expect(frames.length).toBeLessThan(25);
    // seq contiguous from 0
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
    // every payload is 200 ms of s16 mono
    for (const f of frames) expect(f.payload.byteLength).toBe(6400);
    // timestamps strictly increasing, plausible (capture happened within this test's window)
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.captureTimeMs).toBeGreaterThan(frames[i - 1]!.captureTimeMs);
    }
    expect(frames[0]!.captureTimeMs).toBeGreaterThanOrEqual(pipe.started);
    expect(frames.at(-1)!.captureTimeMs).toBeLessThanOrEqual(pipe.started + 7000);
    // The 0.5 s of leading silence fits in the pre-roll (nothing dropped, no flag); the
    // 3 s gap between the bursts is gated → exactly one DISCONTINUITY, on the frame after it.
    const flagged = frames.filter((f) => f.discontinuity);
    expect(flagged.length).toBe(1);
    const second = frames.indexOf(flagged[0]!);
    // the gated gap between bursts is visible in the timestamps (≈ 3 s minus hangover/pre-roll)
    expect(frames[second]!.captureTimeMs - frames[second - 1]!.captureTimeMs).toBeGreaterThan(1500);
    // the first frame is the first captured block (kept as pre-roll)
    expect(frames[0]!.captureTimeMs - pipe.started).toBeGreaterThanOrEqual(0);
    expect(frames[0]!.captureTimeMs - pipe.started).toBeLessThan(5);
    // contiguous frames are exactly 200 ms of audio apart
    expect(frames[2]!.captureTimeMs - frames[1]!.captureTimeMs).toBeCloseTo(200, 1);
    // the audio itself survived: the tone is there at 16 kHz
    const speech = frames
      .slice(3, 7) // 0.6–1.4 s, inside the first burst
      .flatMap((f) => Array.from(leBytesToS16(f.payload)));
    expect(
      amplitudeAt(
        speech.map((v) => v / 32768),
        440,
        16_000,
      ),
    ).toBeGreaterThan(0.25);

    const kinds = reports.map((m) => m.kind);
    expect(kinds).toContain("stream:phase");
    expect(reports.find((m) => m.kind === "stream:phase" && m.phase === "live")).toBeDefined();
    expect(kinds.at(-1)).toBe("capture:ended");
  }, 20_000);

  it("resumes the same stream after the server drops the connection", async () => {
    let killed = false;
    server.onFrame = (frame, ws) => {
      if (!killed && frame.seq === 3) {
        killed = true;
        ws.terminate();
      }
    };
    const reports: FromOffscreen[] = [];
    const tone440 = (t: number) => 0.3 * Math.sin(2 * Math.PI * 440 * t);
    const pipe = syntheticPipeline(tone440, 4, 4);
    const r = runner({ source: "mic" }, pipe, reports);
    await r.start();
    await pipe.done();
    await r.stop("user");

    expect(server.errors).toEqual([]);
    expect(server.streams.size).toBe(1);
    const stream = [...server.streams.values()][0]!;
    expect(stream.connections).toBe(2);
    expect(stream.ended).toBe(true);
    const seqs = stream.frames.map((f) => f.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    // 4 s ≈ 19 full blocks; nothing captured during the outage was lost (it was buffered)
    expect(seqs.at(-1)).toBeGreaterThanOrEqual(17);
    expect(stream.frames.length).toBeGreaterThanOrEqual(seqs.at(-1)! - 1);
    const ts = stream.frames.map((f) => f.captureTimeMs);
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThan(ts[i - 1]!);
    expect(reports.some((m) => m.kind === "stream:phase" && m.phase === "reconnecting")).toBe(true);
  }, 20_000);

  it("reports a fatal consent_required and does not retry", async () => {
    server.rejectNextHelloWith = "consent_required";
    const reports: FromOffscreen[] = [];
    const pipe = syntheticPipeline(() => 0.2, 1, 4);
    const r = runner({}, pipe, reports);
    await r.start();
    await new Promise((res) => setTimeout(res, 1500));
    const fatal = reports.find((m) => m.kind === "stream:fatal");
    expect(fatal).toMatchObject({ code: "consent_required", message: "refused: consent_required" });
    expect(reports.at(-1)?.kind).toBe("capture:ended");
    expect(server.streams.size).toBe(0);
  }, 10_000);
});
