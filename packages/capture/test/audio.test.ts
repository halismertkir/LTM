import { describe, expect, it } from "vitest";
import { CaptureDsp } from "../src/dsp.js";
import { downmixToMono, floatToS16, leBytesToS16, rmsDbfs, s16ToLeBytes } from "../src/pcm.js";
import { StreamingResampler } from "../src/resampler.js";
import { amplitudeAt, mulberry32, rms, tone, zeroCrossingFrequency } from "./fakes/signals.js";

function resampleAll(
  inRate: number,
  outRate: number,
  input: Float32Array,
  chunk = 128,
): Float32Array {
  const r = new StreamingResampler(inRate, outRate);
  const parts: number[] = [];
  for (let i = 0; i < input.length; i += chunk) {
    parts.push(...r.process(input.subarray(i, i + chunk)));
  }
  return Float32Array.from(parts);
}

/** Skip the filter's start-up transient. */
function steady(x: Float32Array, skip = 400): Float32Array {
  return x.subarray(skip, x.length - skip);
}

describe("StreamingResampler", () => {
  for (const inRate of [48_000, 44_100]) {
    it(`keeps a 1 kHz tone at 1 kHz and the same level (${inRate} → 16000)`, () => {
      const out = steady(resampleAll(inRate, 16_000, tone(1000, inRate, inRate * 2, 0.5)));
      expect(zeroCrossingFrequency(out, 16_000)).toBeCloseTo(1000, 0);
      expect(amplitudeAt(out, 1000, 16_000)).toBeGreaterThan(0.5 * 0.99);
      expect(amplitudeAt(out, 1000, 16_000)).toBeLessThan(0.5 * 1.01);
    });

    it(`passes speech-band tones flat (${inRate} → 16000)`, () => {
      for (const f of [200, 3000, 6000]) {
        const out = steady(resampleAll(inRate, 16_000, tone(f, inRate, inRate, 0.5)));
        const db = 20 * Math.log10(amplitudeAt(out, f, 16_000) / 0.5);
        expect(Math.abs(db)).toBeLessThan(0.1);
      }
    });

    it(`does not alias content above 8 kHz into the speech band (${inRate} → 16000)`, () => {
      for (const f of [9000, 12_000, 15_000, 20_000]) {
        const out = steady(resampleAll(inRate, 16_000, tone(f, inRate, inRate, 0.5)));
        // A naive decimator would fold e.g. 12 kHz to 4 kHz at full level.
        const rel = 20 * Math.log10(rms(out) / (0.5 / Math.SQRT2));
        expect(rel, `${f} Hz`).toBeLessThan(-60);
      }
    });
  }

  it("is independent of how the input is chunked", () => {
    const rand = mulberry32(7);
    const input = Float32Array.from({ length: 30_000 }, () => rand() * 2 - 1);
    const whole = resampleAll(44_100, 16_000, input, input.length);
    const r = new StreamingResampler(44_100, 16_000);
    const parts: number[] = [];
    let i = 0;
    while (i < input.length) {
      const n = 1 + Math.floor(rand() * 300);
      parts.push(...r.process(input.subarray(i, i + n)));
      i += n;
    }
    expect(parts.length).toBe(whole.length);
    expect(Float32Array.from(parts)).toEqual(whole);
  });

  it("maps output samples to exact input positions (impulse keeps its time)", () => {
    for (const [inRate, at] of [
      [48_000, 6000],
      [44_100, 4410],
    ] as const) {
      const input = new Float32Array(inRate);
      input[at] = 1;
      const out = resampleAll(inRate, 16_000, input);
      let peak = 0;
      for (let i = 1; i < out.length; i++) if (out[i]! > out[peak]!) peak = i;
      const r = new StreamingResampler(inRate, 16_000);
      expect(Math.abs(r.inputPositionOf(peak) - at)).toBeLessThanOrEqual(inRate / 16_000);
    }
  });

  it("produces the expected number of samples, no drift over long runs", () => {
    const r = new StreamingResampler(44_100, 16_000);
    const chunk = new Float32Array(128);
    let fed = 0;
    for (let i = 0; i < (44_100 * 60) / 128; i++) {
      r.process(chunk);
      fed += 128;
    }
    const expected = (fed - r.halfTaps) * (16_000 / 44_100);
    expect(Math.abs(r.outputCount - expected)).toBeLessThan(2);
  });

  it("rejects non-integer rates", () => {
    expect(() => new StreamingResampler(44_100.5, 16_000)).toThrow();
  });
});

describe("PCM conversion", () => {
  it("scales, rounds and clips to s16", () => {
    const out = floatToS16(Float32Array.from([0, 1, -1, 0.5, -0.5, 2, -3, Number.NaN, 1e-6]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 16384, -16384, 32767, -32768, 0, 0]);
  });

  it("downmixes by averaging (cannot clip)", () => {
    const l = Float32Array.from([1, 0.5, -1]);
    const r = Float32Array.from([1, -0.5, -1]);
    expect(Array.from(downmixToMono([l, r], new Float32Array(3)))).toEqual([1, 0, -1]);
    expect(Array.from(downmixToMono([l], new Float32Array(3)))).toEqual([1, 0.5, -1]);
  });

  it("serialises little-endian and round-trips", () => {
    const pcm = Int16Array.from([1, -2, 32767, -32768, 258]);
    const bytes = s16ToLeBytes(pcm);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([1, 0, 0xfe, 0xff]);
    expect(Array.from(bytes.subarray(8, 10))).toEqual([2, 1]);
    expect(Array.from(leBytesToS16(bytes))).toEqual(Array.from(pcm));
  });

  it("measures RMS in dBFS", () => {
    expect(rmsDbfs(new Int16Array(100))).toBe(-120);
    const sine = floatToS16(tone(1000, 16_000, 16_000, 1));
    expect(rmsDbfs(sine)).toBeCloseTo(-3.01, 1);
    const half = floatToS16(tone(1000, 16_000, 16_000, 0.1));
    expect(rmsDbfs(half)).toBeCloseTo(-23.01, 1);
  });
});

describe("CaptureDsp (worklet chain)", () => {
  function feed(dsp: CaptureDsp, channels: Float32Array[], startFrame: number) {
    const blocks = [];
    for (let i = 0; i + 128 <= channels[0]!.length; i += 128) {
      blocks.push(
        ...dsp.push(
          channels.map((c) => c.subarray(i, i + 128)),
          startFrame + i,
        ),
      );
    }
    return blocks;
  }

  it("emits exact 200 ms blocks of 16 kHz s16 with the context frame of the first sample", () => {
    const dsp = new CaptureDsp(48_000);
    const left = tone(440, 48_000, 48_000 * 2, 0.5);
    const right = tone(440, 48_000, 48_000 * 2, 0.5);
    const blocks = feed(dsp, [left, right], 96_000);
    expect(blocks.length).toBe(9); // 32000 samples minus filter latency → 9 full blocks
    blocks.forEach((b, k) => {
      expect(b.pcm).toBeInstanceOf(Int16Array);
      expect(b.pcm.length).toBe(3200);
      expect(b.contextFrame).toBe(96_000 + k * 9600);
      expect(b.discontinuity).toBe(false);
    });
    // Stereo was averaged, level preserved: 0.5 amplitude ≈ 16384.
    const mid = Array.from(blocks[4]!.pcm);
    expect(Math.max(...mid)).toBeGreaterThan(16_000);
    expect(Math.max(...mid)).toBeLessThan(16_700);
  });

  it("handles fractional positions at 44.1 kHz", () => {
    const dsp = new CaptureDsp(44_100);
    const blocks = feed(dsp, [new Float32Array(44_100 * 2)], 0);
    for (const [k, b] of blocks.entries()) {
      expect(b.contextFrame).toBeCloseTo((k * 3200 * 44_100) / 16_000, 6);
    }
  });

  it("flags a discontinuity and restarts timing when the render clock jumps", () => {
    const dsp = new CaptureDsp(48_000);
    const first = feed(dsp, [new Float32Array(48_000)], 0);
    expect(first.every((b) => !b.discontinuity)).toBe(true);
    const later = feed(dsp, [new Float32Array(48_000)], 480_000); // 10 s later
    expect(later[0]!.discontinuity).toBe(true);
    expect(later[0]!.contextFrame).toBe(480_000);
    expect(later.slice(1).every((b) => !b.discontinuity)).toBe(true);
  });
});
