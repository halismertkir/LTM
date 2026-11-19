import { describe, expect, it } from "vitest";
import { CaptureClock } from "../src/audio/clock.js";
import { EnergyGate, type StampedBlock } from "../src/audio/gate.js";
import { floatToS16 } from "../src/audio/pcm.js";
import { SpeechWindower } from "../src/audio/windower.js";
import { mulberry32, tone } from "./fakes/signals.js";

const BLOCK = 3200;
const BLOCK_MS = 200;
const T0 = 1_763_000_000_000;

function block(
  i: number,
  kind: "silence" | "speech" | "quiet" | "noise",
  rand = mulberry32(i),
): StampedBlock {
  let f: Float32Array;
  if (kind === "silence") f = new Float32Array(BLOCK);
  else if (kind === "speech")
    f = tone(300, 16_000, BLOCK, 0.3); // ≈ −13.5 dBFS
  else if (kind === "quiet")
    f = tone(300, 16_000, BLOCK, 0.008); // ≈ −45 dBFS
  else f = Float32Array.from({ length: BLOCK }, () => (rand() * 2 - 1) * 0.005 * Math.sqrt(3)); // ≈ −49 dBFS
  return { pcm: floatToS16(f), captureTimeMs: T0 + i * BLOCK_MS, discontinuity: false };
}

function run(gate: EnergyGate, kinds: Array<"silence" | "speech" | "quiet" | "noise">) {
  const out: StampedBlock[] = [];
  for (const [i, k] of kinds.entries()) out.push(...gate.push(block(i, k)));
  return out;
}

const rep = <T>(x: T, n: number): T[] => Array.from({ length: n }, () => x);

describe("EnergyGate", () => {
  it("drops long silence and lets speech through with pre-roll and a DISCONTINUITY flag", () => {
    const gate = new EnergyGate({ blockMs: BLOCK_MS });
    const out = run(gate, [...rep("silence" as const, 20), ...rep("speech" as const, 5)]);
    // 400 ms pre-roll (2 blocks) + 5 speech blocks
    expect(out.length).toBe(7);
    expect(out[0]!.captureTimeMs).toBe(T0 + 18 * BLOCK_MS);
    expect(out[0]!.discontinuity).toBe(true);
    expect(out.slice(1).every((b) => !b.discontinuity)).toBe(true);
    // timestamps are the capture times, untouched and contiguous
    for (const [i, b] of out.entries()) expect(b.captureTimeMs).toBe(T0 + (18 + i) * BLOCK_MS);
  });

  it("keeps sending for a hangover of at least 500 ms after speech stops", () => {
    const gate = new EnergyGate({ blockMs: BLOCK_MS });
    const out = run(gate, [...rep("speech" as const, 3), ...rep("silence" as const, 20)]);
    const hangoverMs = (out.length - 3) * BLOCK_MS;
    expect(hangoverMs).toBeGreaterThanOrEqual(500);
    expect(hangoverMs).toBeLessThanOrEqual(1000);
    expect(gate.isOpen).toBe(false);
  });

  it("does not flag a discontinuity when nothing was dropped", () => {
    const gate = new EnergyGate({ blockMs: BLOCK_MS });
    // a short pause shorter than the hangover: all blocks sent, no flag
    const out = run(gate, ["speech", "speech", "silence", "silence", "speech", "speech"]);
    expect(out.length).toBe(6);
    expect(out.some((b) => b.discontinuity)).toBe(false);
  });

  it("flags the first block after every gated gap", () => {
    const gate = new EnergyGate({ blockMs: BLOCK_MS });
    const out = run(gate, [
      ...rep("speech" as const, 2),
      ...rep("silence" as const, 15),
      ...rep("speech" as const, 2),
    ]);
    const flagged = out.filter((b) => b.discontinuity);
    expect(flagged.length).toBe(1);
    // the flagged block is the first pre-roll block after the gap
    const idx = out.indexOf(flagged[0]!);
    expect(out[idx]!.captureTimeMs - out[idx - 1]!.captureTimeMs).toBeGreaterThan(BLOCK_MS);
  });

  it("passes quiet speech in a silent room", () => {
    const gate = new EnergyGate({ blockMs: BLOCK_MS });
    const out = run(gate, [...rep("silence" as const, 10), ...rep("quiet" as const, 3)]);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it("learns a steady noise floor and stays closed on it, but opens for speech", () => {
    const gate = new EnergyGate({ blockMs: BLOCK_MS });
    const noise = run(gate, rep("noise" as const, 50));
    expect(noise.length).toBe(0);
    const speech = gate.push(block(60, "speech"));
    expect(speech.length).toBeGreaterThan(0);
  });

  it("carries an upstream discontinuity over gated blocks", () => {
    const gate = new EnergyGate({ blockMs: BLOCK_MS });
    run(gate, rep("speech" as const, 10)); // floor adapts, gate open
    const out: StampedBlock[] = [];
    // hangover runs out on silence, then a gated block arrives with the flag set
    for (let i = 0; i < 8; i++) out.push(...gate.push(block(10 + i, "silence")));
    out.length = 0;
    out.push(...gate.push({ ...block(18, "silence"), discontinuity: true }));
    expect(out.length).toBe(0);
    out.push(...gate.push(block(19, "speech")));
    expect(out[0]!.discontinuity).toBe(true);
  });
});

describe("CaptureClock", () => {
  it("anchors once and then derives timestamps from the frame position", () => {
    const clock = new CaptureClock();
    clock.observe(10, T0);
    expect(clock.toEpochMs(10)).toBe(T0);
    expect(clock.toEpochMs(10.2)).toBeCloseTo(T0 + 200, 6);
    expect(() => new CaptureClock().toEpochMs(1)).toThrow();
  });

  it("tracks drift and smooths jitter over an hour, staying monotonic", () => {
    const clock = new CaptureClock();
    const rand = mulberry32(42);
    const ppm = 120e-6; // system clock runs 120 ppm faster than the audio clock
    const trueWall = (ctxSec: number) => T0 + ctxSec * 1000 * (1 + ppm);
    let prev = -Infinity;
    let maxErr = 0;
    for (let i = 0; i < 18_000; i++) {
      const ctxSec = i * 0.2;
      // main-thread scheduling jitter up to ±8 ms on the wall-clock reading
      clock.observe(ctxSec, trueWall(ctxSec) + (rand() * 2 - 1) * 8);
      expect(clock.takeStep()).toBe(false);
      const ts = clock.toEpochMs(ctxSec);
      if (i > 0) {
        const step = ts - prev;
        expect(step).toBeGreaterThan(199);
        expect(step).toBeLessThan(201);
      }
      prev = ts;
      if (i > 500) maxErr = Math.max(maxErr, Math.abs(ts - trueWall(ctxSec)));
    }
    // Without drift correction the error would reach 120 ppm × 3600 s = 432 ms.
    expect(maxErr).toBeLessThan(10);
  });

  it("steps (and reports it once) when the wall clock jumps", () => {
    const clock = new CaptureClock();
    clock.observe(0, T0);
    clock.observe(0.2, T0 + 200);
    clock.observe(0.4, T0 + 400 + 60_000); // NTP/user changed the clock by a minute
    expect(clock.takeStep()).toBe(true);
    expect(clock.takeStep()).toBe(false);
    expect(clock.toEpochMs(0.4)).toBeCloseTo(T0 + 60_400, 3);
  });

  it("allows a step backwards", () => {
    const clock = new CaptureClock();
    clock.observe(0, T0);
    expect(clock.toEpochMs(1)).toBe(T0 + 1000);
    clock.observe(1.2, T0 + 1200 - 30_000);
    expect(clock.takeStep()).toBe(true);
    expect(clock.toEpochMs(1.2)).toBeCloseTo(T0 + 1200 - 30_000, 3);
  });
});

describe("SpeechWindower", () => {
  const mk = (i: number, discontinuity = false): StampedBlock => ({
    pcm: new Int16Array(BLOCK).fill(i),
    captureTimeMs: T0 + i * BLOCK_MS,
    discontinuity,
  });

  it("cuts windows at gated gaps and keeps the first sample's timestamp", () => {
    const w = new SpeechWindower();
    const out = [mk(0), mk(1), mk(2), mk(10, true), mk(11)].flatMap((b) => w.push(b));
    expect(out.length).toBe(1);
    expect(out[0]!.startMs).toBe(T0);
    expect(out[0]!.pcm.length).toBe(3 * BLOCK);
    expect(out[0]!.endMs).toBe(T0 + 600);
    const last = w.flush()!;
    expect(last.startMs).toBe(T0 + 2000);
    expect(last.pcm.length).toBe(2 * BLOCK);
    expect(w.flush()).toBeNull();
  });

  it("caps windows at 28 s", () => {
    const w = new SpeechWindower();
    const out = Array.from({ length: 200 }, (_, i) => mk(i)).flatMap((b) => w.push(b));
    expect(out.length).toBe(1);
    expect(out[0]!.pcm.length).toBe(140 * BLOCK);
  });
});
