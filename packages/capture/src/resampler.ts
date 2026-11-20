/**
 * Streaming polyphase windowed-sinc resampler (Kaiser window) for arbitrary rational
 * ratios, e.g. 48000 → 16000 (3:1) or 44100 → 16000 (441:160).
 *
 * Why not linear interpolation: going down to 16 kHz without a proper low-pass folds
 * everything between 8 and 24 kHz (sibilants, keyboard clicks, music) back into the
 * speech band, which hurts recognition. The filter here passes up to ~6.4 kHz and is
 * ≥ ~75 dB down from 8 kHz.
 *
 * Positions are tracked with integer arithmetic (input index + phase numerator) so the
 * output never drifts against the input over hours of audio. Output sample `m`
 * corresponds exactly to input position `m · inRate / outRate`; the filter is symmetric,
 * so this mapping is also the right timestamp mapping (the only cost is `halfTaps`
 * samples of processing latency).
 */
export interface ResamplerOptions {
  /** Passband edge as a fraction of the lower Nyquist frequency. Default 0.8. */
  passband?: number;
  /** Stopband attenuation in dB (sets the Kaiser beta). Default 80. */
  attenuationDb?: number;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Zeroth-order modified Bessel function of the first kind (series expansion). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 50; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

export class StreamingResampler {
  readonly inRate: number;
  readonly outRate: number;
  /** Input samples on each side of the output position that contribute to it. */
  readonly halfTaps: number;

  private readonly up: number; // L
  private readonly down: number; // M
  /** taps[phase * width + k], width = 2 * halfTaps. */
  private readonly taps: Float32Array;
  private readonly width: number;

  /** Absolute input index of buf[0]. Starts negative: we pretend zeros came before the start. */
  private bufStart: number;
  private buf: Float32Array;
  private bufLen: number;

  /** Integer part of the next output's input position. */
  private ipos = 0;
  /** Fractional part numerator (0 ≤ phase < up). */
  private phase = 0;
  private produced = 0;

  private out: Float32Array = new Float32Array(0);

  constructor(inRate: number, outRate: number, opts: ResamplerOptions = {}) {
    if (!(inRate > 0 && outRate > 0) || !Number.isInteger(inRate) || !Number.isInteger(outRate)) {
      throw new Error(`invalid rates ${inRate} → ${outRate}`);
    }
    this.inRate = inRate;
    this.outRate = outRate;
    const g = gcd(inRate, outRate);
    this.up = outRate / g;
    this.down = inRate / g;

    const passband = opts.passband ?? 0.8;
    const atten = opts.attenuationDb ?? 80;
    // Design relative to the input rate. The transition band runs from the passband edge
    // to the lower Nyquist frequency, so nothing above the output Nyquist survives.
    const lowNyquist = Math.min(inRate, outRate) / 2;
    const fPass = passband * lowNyquist;
    const fStop = lowNyquist;
    const fc = (fPass + fStop) / 2 / inRate; // cycles per input sample
    const transition = (fStop - fPass) / inRate;
    const beta =
      atten > 50
        ? 0.1102 * (atten - 8.7)
        : atten > 21
          ? 0.5842 * (atten - 21) ** 0.4 + 0.07886 * (atten - 21)
          : 0;
    const order = Math.ceil((atten - 8) / (2.285 * 2 * Math.PI * transition));
    this.halfTaps = Math.max(2, Math.ceil(order / 2));
    this.width = 2 * this.halfTaps;

    const i0Beta = besselI0(beta);
    this.taps = new Float32Array(this.up * this.width);
    for (let p = 0; p < this.up; p++) {
      const frac = p / this.up;
      let sum = 0;
      for (let k = 0; k < this.width; k++) {
        // Input sample at ipos + (k - halfTaps + 1); distance from the output position:
        const t = frac - (k - this.halfTaps + 1);
        const x = 2 * fc * t;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const r = t / this.halfTaps;
        const win = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0Beta;
        const h = 2 * fc * sinc * win;
        this.taps[p * this.width + k] = h;
        sum += h;
      }
      // Normalise every phase to unity DC gain; otherwise the gain ripples slightly with
      // the phase, which is audible as a faint tone at the phase-cycle rate.
      for (let k = 0; k < this.width; k++) this.taps[p * this.width + k]! /= sum;
    }

    this.bufStart = -(this.halfTaps - 1);
    this.buf = new Float32Array(Math.max(4096, this.width * 4));
    this.bufLen = this.halfTaps - 1; // zeros of "history" before the first real sample
  }

  /** Number of output samples produced so far. */
  get outputCount(): number {
    return this.produced;
  }

  /** Input position (in input samples since the start) of output sample `m`. */
  inputPositionOf(m: number): number {
    return (m * this.down) / this.up;
  }

  /**
   * Feeds input and returns the output that became computable. The returned array is a
   * view into an internal buffer that is overwritten by the next call.
   */
  process(input: Float32Array): Float32Array {
    this.append(input);
    const available = this.bufStart + this.bufLen; // one past the last absolute input index
    // Output at ipos needs inputs up to ipos + halfTaps.
    // Upper bound of what this call can produce; sizing once keeps the realtime thread
    // allocation-free in the steady state.
    const maxOut = Math.ceil(((available - this.ipos) * this.up) / this.down) + 1;
    if (this.out.length < maxOut) this.out = new Float32Array(Math.max(maxOut, 1024));
    let n = 0;
    const { taps, width, up, down, buf } = this;
    while (this.ipos + this.halfTaps < available) {
      const base = this.ipos - this.halfTaps + 1 - this.bufStart;
      const tOff = this.phase * width;
      let acc = 0;
      for (let k = 0; k < width; k++) acc += buf[base + k]! * taps[tOff + k]!;
      if (n >= this.out.length) {
        const bigger = new Float32Array(this.out.length * 2);
        bigger.set(this.out);
        this.out = bigger;
      }
      this.out[n++] = acc;
      this.phase += down;
      while (this.phase >= up) {
        this.phase -= up;
        this.ipos++;
      }
    }
    this.produced += n;
    this.compact();
    return this.out.subarray(0, n);
  }

  private append(input: Float32Array): void {
    const need = this.bufLen + input.length;
    if (need > this.buf.length) {
      const bigger = new Float32Array(Math.max(need, this.buf.length * 2));
      bigger.set(this.buf.subarray(0, this.bufLen));
      this.buf = bigger;
    }
    this.buf.set(input, this.bufLen);
    this.bufLen += input.length;
  }

  /** Drops input samples that no future output can reach. */
  private compact(): void {
    const keepFrom = this.ipos - this.halfTaps + 1; // absolute index
    const drop = keepFrom - this.bufStart;
    if (drop <= 0) return;
    this.buf.copyWithin(0, drop, this.bufLen);
    this.bufLen -= drop;
    this.bufStart = keepFrom;
  }
}
