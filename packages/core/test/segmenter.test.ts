import { describe, expect, it } from "vitest";
import {
  int16ToBytes,
  PcmSegmenter,
  type SegmenterOptions,
  type SpeechWindow,
} from "../src/index.js";

const T0 = 1_700_000_000_000;

/** Deterministic noise in [-1, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

interface Part {
  ms: number;
  kind: "speech" | "silence" | "noise";
}

/** Speech-like bursts: a few tones, amplitude-modulated at a syllable rate. */
function synth(parts: Part[], rate: number, seed = 1, noiseAmp = 40): Int16Array {
  const total = parts.reduce((n, p) => n + Math.round((p.ms * rate) / 1000), 0);
  const out = new Int16Array(total);
  const rand = rng(seed);
  let o = 0;
  for (const p of parts) {
    const n = Math.round((p.ms * rate) / 1000);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      let v = noiseAmp * rand();
      if (p.kind === "speech") {
        const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
        v +=
          env *
          (6000 * Math.sin(2 * Math.PI * 220 * t) +
            3000 * Math.sin(2 * Math.PI * 660 * t) +
            1500 * rand());
      } else if (p.kind === "noise") {
        v += 4000 * rand();
      }
      out[o + i] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
    o += n;
  }
  return out;
}

function interleave(mono: Int16Array, channels: number): Int16Array {
  const out = new Int16Array(mono.length * channels);
  for (let i = 0; i < mono.length; i++)
    for (let c = 0; c < channels; c++) out[i * channels + c] = mono[i]!;
  return out;
}

function feed(
  seg: PcmSegmenter,
  pcm: Int16Array,
  rate: number,
  channels = 1,
  frameMs = 200,
  startMs = T0,
  skip?: (frameStartMs: number) => boolean,
): SpeechWindow[] {
  const out: SpeechWindow[] = [];
  const per = Math.round((rate * frameMs) / 1000) * channels;
  for (let i = 0; i < pcm.length; i += per) {
    const t = startMs + (i / channels / rate) * 1000;
    if (skip?.(t - startMs)) continue;
    out.push(...seg.push(int16ToBytes(pcm.subarray(i, i + per)), t));
  }
  out.push(...seg.flush());
  return out;
}

const opts = (o: Partial<SegmenterOptions> = {}): SegmenterOptions => ({
  sampleRate: 16000,
  channels: 1,
  ...o,
});

describe("PcmSegmenter", () => {
  it("emits nothing for pure silence or a steady noise floor", () => {
    const silent = new PcmSegmenter(opts());
    expect(feed(silent, new Int16Array(16000 * 5), 16000)).toEqual([]);
    const hum = new PcmSegmenter(opts());
    expect(feed(hum, synth([{ ms: 10000, kind: "silence" }], 16000, 3, 300), 16000)).toEqual([]);
  });

  it("cuts bursts separated by silence, with timestamps from the frames", () => {
    const parts: Part[] = [
      { ms: 1000, kind: "silence" },
      { ms: 1500, kind: "speech" },
      { ms: 1500, kind: "silence" },
      { ms: 2000, kind: "speech" },
      { ms: 2000, kind: "silence" },
    ];
    const seg = new PcmSegmenter(opts());
    const windows = feed(seg, synth(parts, 16000), 16000);
    expect(windows).toHaveLength(2);
    const [a, b] = windows as [SpeechWindow, SpeechWindow];
    // Start = speech onset minus the 250 ms pre-roll; end = offset plus a short tail.
    expect(Math.abs(a.startMs - (T0 + 1000 - 250))).toBeLessThanOrEqual(40);
    expect(a.endMs).toBeGreaterThanOrEqual(T0 + 2500);
    expect(a.endMs).toBeLessThanOrEqual(T0 + 2500 + 400);
    expect(Math.abs(b.startMs - (T0 + 4000 - 250))).toBeLessThanOrEqual(40);
    expect(b.endMs).toBeLessThanOrEqual(T0 + 6000 + 400);
    for (const w of windows) {
      expect(w.sampleRate).toBe(16000);
      expect(Math.abs(w.pcm.length / 16 - (w.endMs - w.startMs))).toBeLessThanOrEqual(2);
    }
  });

  it("discards blips shorter than minSpeechMs", () => {
    const seg = new PcmSegmenter(opts());
    const windows = feed(
      seg,
      synth(
        [
          { ms: 1000, kind: "silence" },
          { ms: 120, kind: "speech" },
          { ms: 2000, kind: "silence" },
        ],
        16000,
      ),
      16000,
    );
    expect(windows).toEqual([]);
  });

  it("downmixes stereo 48 kHz input and resamples to 16 kHz", () => {
    const mono = synth(
      [
        { ms: 500, kind: "silence" },
        { ms: 1200, kind: "speech" },
        { ms: 1500, kind: "silence" },
      ],
      48000,
    );
    const seg = new PcmSegmenter(opts({ sampleRate: 48000, channels: 2 }));
    const windows = feed(seg, interleave(mono, 2), 48000, 2);
    expect(windows).toHaveLength(1);
    const w = windows[0]!;
    expect(w.sampleRate).toBe(16000);
    expect(Math.abs(w.startMs - (T0 + 250))).toBeLessThanOrEqual(40);
    expect(Math.abs(w.pcm.length / 16 - (w.endMs - w.startMs))).toBeLessThanOrEqual(2);
  });

  it("never emits windows longer than maxWindowMs and keeps all the speech", () => {
    // 40 s of speech with short dips every 3 s.
    const parts: Part[] = [{ ms: 500, kind: "silence" }];
    for (let i = 0; i < 13; i++)
      parts.push({ ms: 2900, kind: "speech" }, { ms: 200, kind: "silence" });
    parts.push({ ms: 2000, kind: "silence" });
    const seg = new PcmSegmenter(opts({ maxWindowMs: 10000 }));
    const windows = feed(seg, synth(parts, 16000), 16000);
    expect(windows.length).toBeGreaterThanOrEqual(4);
    for (const w of windows) expect(w.endMs - w.startMs).toBeLessThanOrEqual(10000);
    for (let i = 1; i < windows.length; i++)
      expect(windows[i]!.startMs).toBeGreaterThanOrEqual(windows[i - 1]!.endMs - 1);
    const covered = windows.reduce((n, w) => n + (w.endMs - w.startMs), 0);
    expect(covered).toBeGreaterThan(13 * 2900 * 0.95);
  });

  it("cuts at a quiet point rather than mid-burst when the cap is hit", () => {
    const parts: Part[] = [
      { ms: 300, kind: "silence" },
      { ms: 7000, kind: "speech" },
      { ms: 300, kind: "silence" },
      { ms: 5000, kind: "speech" },
      { ms: 1500, kind: "silence" },
    ];
    const seg = new PcmSegmenter(opts({ maxWindowMs: 10000 }));
    const windows = feed(seg, synth(parts, 16000), 16000);
    expect(windows).toHaveLength(2);
    const cut = windows[0]!.endMs - T0;
    expect(cut).toBeGreaterThanOrEqual(7300);
    expect(cut).toBeLessThanOrEqual(7600);
  });

  it("closes the window on a discontinuity or a large timestamp gap", () => {
    const burst = synth([{ ms: 1000, kind: "speech" }], 16000);
    for (const mode of ["flag", "gap"] as const) {
      const seg = new PcmSegmenter(opts());
      const out: SpeechWindow[] = [];
      for (let i = 0; i < 5; i++)
        out.push(...seg.push(int16ToBytes(burst.subarray(i * 3200, (i + 1) * 3200)), T0 + i * 200));
      expect(out).toEqual([]);
      const later = mode === "gap" ? T0 + 60_000 : T0 + 1000;
      for (let i = 0; i < 5; i++) {
        out.push(
          ...seg.push(
            int16ToBytes(burst.subarray(i * 3200, (i + 1) * 3200)),
            later + i * 200,
            mode === "flag" && i === 0,
          ),
        );
      }
      out.push(...seg.flush());
      expect(out, mode).toHaveLength(2);
      expect(out[0]!.endMs).toBeLessThanOrEqual(T0 + 1000 + 1);
      expect(Math.abs(out[1]!.startMs - later)).toBeLessThanOrEqual(1);
    }
  });

  it("fills short client-side gaps with silence so offsets match wall-clock time", () => {
    // Client drops 400 ms of audio in the middle of speech (VAD gating).
    const pcm = synth(
      [
        { ms: 400, kind: "silence" },
        { ms: 2000, kind: "speech" },
        { ms: 1500, kind: "silence" },
      ],
      16000,
    );
    const seg = new PcmSegmenter(opts());
    const windows = feed(seg, pcm, 16000, 1, 200, T0, (t) => t >= 1200 && t < 1600);
    expect(windows).toHaveLength(1);
    const w = windows[0]!;
    expect(Math.abs(w.pcm.length / 16 - (w.endMs - w.startMs))).toBeLessThanOrEqual(2);
    expect(w.endMs).toBeGreaterThanOrEqual(T0 + 2400);
  });

  it("is independent of the push size", () => {
    const pcm = synth(
      [
        { ms: 700, kind: "silence" },
        { ms: 1300, kind: "speech" },
        { ms: 1200, kind: "silence" },
      ],
      16000,
    );
    const a = feed(new PcmSegmenter(opts()), pcm, 16000, 1, 200).map((w) => [w.startMs, w.endMs]);
    const b = feed(new PcmSegmenter(opts()), pcm, 16000, 1, 37).map((w) => [w.startMs, w.endMs]);
    expect(b).toHaveLength(1);
    expect(Math.abs(a[0]![0]! - b[0]![0]!)).toBeLessThanOrEqual(25);
    expect(Math.abs(a[0]![1]! - b[0]![1]!)).toBeLessThanOrEqual(25);
  });

  it("flush emits a window that is still open", () => {
    const seg = new PcmSegmenter(opts());
    const pcm = synth(
      [
        { ms: 300, kind: "silence" },
        { ms: 1000, kind: "speech" },
      ],
      16000,
    );
    const pushed = seg.push(int16ToBytes(pcm), T0);
    expect(pushed).toEqual([]);
    const flushed = seg.flush();
    expect(flushed).toHaveLength(1);
    expect(seg.flush()).toEqual([]);
  });

  it("tracks a loud but steady noise floor and still finds speech above it", () => {
    const pcm = synth(
      [
        { ms: 4000, kind: "silence" },
        { ms: 1500, kind: "speech" },
        { ms: 2000, kind: "silence" },
      ],
      16000,
      7,
      600,
    );
    const windows = feed(new PcmSegmenter(opts()), pcm, 16000);
    expect(windows).toHaveLength(1);
    expect(Math.abs(windows[0]!.startMs - (T0 + 4000 - 250))).toBeLessThanOrEqual(60);
  });

  it("starts a window when the stream begins mid-sentence", () => {
    const pcm = synth(
      [
        { ms: 1500, kind: "speech" },
        { ms: 1500, kind: "silence" },
      ],
      16000,
    );
    const windows = feed(new PcmSegmenter(opts()), pcm, 16000);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.startMs).toBe(T0);
  });
});
