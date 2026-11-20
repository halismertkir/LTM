/**
 * Maps AudioContext time (seconds of rendered audio) to device-clock epoch milliseconds.
 *
 * Why not `Date.now()` when a frame is sent: blocks reach the main thread in bursts, sit in
 * the stream client's buffer while reconnecting, and silence may be gated — the send time
 * says little about when the sound happened. Instead the first anchor pairs a context time
 * with a wall-clock time once, and every block's timestamp is derived from its exact frame
 * position. Later anchors only *slew* the mapping (bounded rate), absorbing the slow drift
 * between the audio device's crystal and the system clock and averaging out the jitter of
 * main-thread scheduling, while keeping timestamps strictly monotonic. A large disagreement
 * (system clock set, laptop suspended) *steps* the mapping instead and is reported so the
 * next frame can carry the DISCONTINUITY flag.
 */
export interface ClockOptions {
  /** Maximum slew rate as a fraction (2e-3 = 2 ms per second of audio). */
  maxSlew?: number;
  /** Fraction of the observed error corrected per observation (low-pass on jitter). */
  gain?: number;
  /** Errors larger than this step the mapping instead of slewing it. */
  stepThresholdMs?: number;
}

export class CaptureClock {
  private offsetMs: number | null = null;
  private lastObsSec = 0;
  private stepped = false;
  private lastOutMs = -Infinity;
  private readonly maxSlew: number;
  private readonly gain: number;
  private readonly stepThresholdMs: number;

  constructor(opts: ClockOptions = {}) {
    this.maxSlew = opts.maxSlew ?? 2e-3;
    this.gain = opts.gain ?? 0.05;
    this.stepThresholdMs = opts.stepThresholdMs ?? 1000;
  }

  get anchored(): boolean {
    return this.offsetMs !== null;
  }

  /** epoch ms − context ms (for diagnostics and tests). */
  get offset(): number | null {
    return this.offsetMs;
  }

  /** Feed a simultaneous (contextTime, wall clock) pair. */
  observe(contextSec: number, epochMs: number): void {
    const measured = epochMs - contextSec * 1000;
    if (this.offsetMs === null) {
      this.offsetMs = measured;
      this.lastObsSec = contextSec;
      return;
    }
    const err = measured - this.offsetMs;
    const dtSec = Math.max(0, contextSec - this.lastObsSec);
    this.lastObsSec = contextSec;
    if (Math.abs(err) > this.stepThresholdMs) {
      this.offsetMs = measured;
      this.stepped = true;
      // A step may go backwards (clock set back); do not clamp it away.
      this.lastOutMs = -Infinity;
      return;
    }
    const limit = dtSec * 1000 * this.maxSlew;
    const adj = Math.max(-limit, Math.min(limit, err * this.gain));
    this.offsetMs += adj;
  }

  /**
   * Epoch ms for a context time. Strictly increasing across calls with increasing input,
   * except right after a step (reported once by `takeStep`).
   */
  toEpochMs(contextSec: number): number {
    if (this.offsetMs === null) throw new Error("clock not anchored");
    let ms = contextSec * 1000 + this.offsetMs;
    if (ms <= this.lastOutMs) ms = this.lastOutMs + 0.001;
    this.lastOutMs = ms;
    return ms;
  }

  /** True once after the mapping stepped. */
  takeStep(): boolean {
    const s = this.stepped;
    this.stepped = false;
    return s;
  }
}
