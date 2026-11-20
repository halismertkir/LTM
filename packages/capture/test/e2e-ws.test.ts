/**
 * End-to-end check of the network path in Node: the real DSP chain (CaptureDsp as run by
 * the worklet → CaptureClock), CaptureSession (re-blocking → EnergyGate → StreamClient),
 * Node's built-in WebSocket, and a local `ws` server speaking the ingest protocol.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaptureClock } from "../src/clock.js";
import { CaptureDsp } from "../src/dsp.js";
import { floatToS16, leBytesToS16 } from "../src/pcm.js";
import { type CaptureEvent, CaptureSession } from "../src/session.js";
import { FakeIngestServer } from "./fakes/fakeServer.js";
import { amplitudeAt } from "./fakes/signals.js";

const CTX_RATE = 48_000;

/**
 * Stands in for the browser pipeline: renders `seconds` of synthetic audio in 128-frame
 * quanta through the worklet DSP, maps context frames to wall-clock time with CaptureClock
 * and pushes the blocks into the session, paced at `speed`× real time. The wall clock it
 * reports is *virtual* real time (start + audio position), as if captured live.
 */
function syntheticPipeline(
  session: CaptureSession,
  pattern: (t: number) => number,
  seconds: number,
  speed: number,
) {
  const started = Date.now();
  const dsp = new CaptureDsp(CTX_RATE);
  const clock = new CaptureClock();
  const quantum = new Float32Array(128);
  const totalQuanta = Math.floor((seconds * CTX_RATE) / 128);
  let q = 0;
  const done = new Promise<void>((resolve) => {
    const tick = () => {
      // render ~100 ms of audio per tick
      const until = Math.min(totalQuanta, q + Math.ceil((0.1 * CTX_RATE) / 128));
      for (; q < until; q++) {
        for (let i = 0; i < 128; i++) quantum[i] = pattern((q * 128 + i) / CTX_RATE);
        for (const b of dsp.push([quantum], q * 128)) {
          const ctxSec = (q * 128) / CTX_RATE;
          clock.observe(ctxSec, started + ctxSec * 1000);
          session.pushPcm(
            b.pcm,
            clock.toEpochMs(b.contextFrame / CTX_RATE),
            b.discontinuity || clock.takeStep(),
          );
        }
      }
      if (q < totalQuanta) setTimeout(tick, 100 / speed);
      else setTimeout(resolve, 100);
    };
    setTimeout(tick, 0);
  });
  return { started, done };
}

/** 1 s of 440 Hz "speech", 3 s silence, 1 s speech, 1 s silence (+ hangover) */
const pattern = (t: number) =>
  (t >= 0.5 && t < 1.5) || (t >= 4.5 && t < 5.5) ? 0.3 * Math.sin(2 * Math.PI * 440 * t) : 0;

let server: FakeIngestServer;
let base: string;

beforeEach(async () => {
  server = new FakeIngestServer();
  base = await server.start();
});
afterEach(async () => {
  await server.stop();
});

function session(
  events: CaptureEvent[],
  extra: Partial<ConstructorParameters<typeof CaptureSession>[0]> = {},
) {
  return new CaptureSession({
    serverUrl: base,
    token: "tok_e2e_0123456789abcdef",
    source: "tab",
    context: { app: "meet.google.com", title: "Weekly sync" },
    onEvent: (e) => events.push(e),
    ...extra,
  });
}

const phases = (events: CaptureEvent[]) =>
  events.flatMap((e) => (e.type === "phase" ? [e.phase] : []));

describe("network path end to end (Node WebSocket ↔ local ws server)", () => {
  it("delivers gated, timestamped frames that decode with the protocol codec", async () => {
    const events: CaptureEvent[] = [];
    const r = session(events);
    await r.start();
    const pipe = syntheticPipeline(r, pattern, 7, 10);
    await pipe.done;
    await r.stop();

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

    expect(phases(events)).toEqual(["connecting", "streaming", "ending", "ended"]);
    expect(await r.closed).toEqual({ reason: "ended" });
    // level events are throttled by wall time (this ran at 10× speed: ~0.7 s of wall time)
    const levels = events.filter((e) => e.type === "level");
    expect(levels.length).toBeGreaterThanOrEqual(2);
    expect(levels.length).toBeLessThanOrEqual(Math.ceil((Date.now() - pipe.started) / 190) + 1);
  }, 20_000);

  it("resumes the same stream after the server drops the connection", async () => {
    let killed = false;
    server.onFrame = (frame, ws) => {
      if (!killed && frame.seq === 3) {
        killed = true;
        ws.terminate();
      }
    };
    const events: CaptureEvent[] = [];
    const tone440 = (t: number) => 0.3 * Math.sin(2 * Math.PI * 440 * t);
    const r = session(events, { source: "mic" });
    await r.start();
    const pipe = syntheticPipeline(r, tone440, 4, 4);
    await pipe.done;
    await r.stop();

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
    expect(phases(events)).toContain("reconnecting");
    expect(phases(events).at(-1)).toBe("ended");
    expect(events.some((e) => e.type === "error" && e.fatal)).toBe(false);
  }, 20_000);

  it("reports a fatal consent_required and does not retry", async () => {
    server.rejectNextHelloWith = "consent_required";
    const events: CaptureEvent[] = [];
    const r = session(events);
    await r.start();
    syntheticPipeline(r, () => 0.2, 1, 4);
    expect(await r.closed).toEqual({ reason: "fatal", code: "consent_required" });
    await new Promise((res) => setTimeout(res, 1500)); // would have retried by now
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toEqual([
      {
        type: "error",
        code: "consent_required",
        message: "refused: consent_required",
        fatal: true,
      },
    ]);
    // "ended" comes after the error event, and nothing reconnects
    expect(events.indexOf(errors[0]!)).toBeLessThan(
      events.findIndex((e) => e.type === "phase" && e.phase === "ended"),
    );
    expect(phases(events)).not.toContain("reconnecting");
    expect(server.streams.size).toBe(0);
    await r.stop(); // no-op after the end, resolves
  }, 10_000);

  it("re-blocks arbitrary chunk sizes from a sample-counting source (agent style)", async () => {
    const events: CaptureEvent[] = [];
    const r = session(events, { source: "ambient", context: { title: "desk" } });
    await r.start();
    const t0 = Date.now();
    // 2 s of tone in odd-sized chunks (like ffmpeg's pipe reads), stamped by sample count
    const total = 32_000;
    const all = floatToS16(
      Float32Array.from(
        { length: total },
        (_, i) => 0.3 * Math.sin((2 * Math.PI * 300 * i) / 16_000),
      ),
    );
    let off = 0;
    while (off < total) {
      const n = Math.min(1777, total - off);
      r.pushPcm(all.subarray(off, off + n), t0 + (off / 16_000) * 1000);
      off += n;
    }
    await r.stop();
    const stream = [...server.streams.values()][0]!;
    expect(stream.hello.source).toBe("ambient");
    const frames = stream.frames;
    // 10 full 200 ms frames; the tail (none here) would be a short final frame
    expect(frames.map((f) => f.payload.byteLength)).toEqual(Array(10).fill(6400));
    frames.forEach((f, i) => {
      expect(f.captureTimeMs).toBeCloseTo(t0 + i * 200, 6);
    });
  }, 10_000);
});
