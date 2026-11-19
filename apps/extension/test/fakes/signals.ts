export function tone(
  freq: number,
  rate: number,
  samples: number,
  amp = 0.5,
  phase = 0,
): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++)
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate + phase);
  return out;
}

/** Amplitude of the component at `freq` (single-bin DFT over the whole signal). */
export function amplitudeAt(x: ArrayLike<number>, freq: number, rate: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < x.length; i++) {
    const w = (2 * Math.PI * freq * i) / rate;
    re += x[i]! * Math.cos(w);
    im -= x[i]! * Math.sin(w);
  }
  return (2 * Math.hypot(re, im)) / x.length;
}

export function rms(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, x.length));
}

/** Frequency estimated from positive-going zero crossings (with sub-sample interpolation). */
export function zeroCrossingFrequency(x: ArrayLike<number>, rate: number): number {
  const crossings: number[] = [];
  for (let i = 1; i < x.length; i++) {
    const a = x[i - 1]!;
    const b = x[i]!;
    if (a < 0 && b >= 0) crossings.push(i - 1 + a / (a - b));
  }
  if (crossings.length < 2) return 0;
  const periods = crossings.length - 1;
  return (periods * rate) / (crossings[crossings.length - 1]! - crossings[0]!);
}

/** Deterministic PRNG for reproducible jitter/noise. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
