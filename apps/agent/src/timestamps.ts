/**
 * Capture timestamps for a sample stream that has no clock of its own (ffmpeg's stdout).
 *
 * Model: a wall-clock anchor for the first sample, then advance by sample count — exact and
 * smooth. The anchor is the tightest bound the arrivals allow: a sample cannot arrive before
 * it was captured, so for every chunk `anchor ≤ arrival − (audio received so far)`. Taking
 * the minimum of that bound over a short warm-up window (samples are held meanwhile) absorbs
 * start-up bursts — ffmpeg delivers the first ~0.5 s of a `-re` file or of a device's
 * buffer almost at once — which would otherwise put every timestamp in the future.
 *
 * If sample time and wall clock later disagree by more than `maxDriftMs` (ffmpeg stalled,
 * the machine was suspended, the device dropped out, audio arrived far faster than real
 * time), the stream is re-anchored at once and the chunk is flagged as a discontinuity, so
 * the server neither glues the two sides together nor drifts away from other devices.
 */
export interface SampleClockOptions {
  sampleRate?: number;
  maxDriftMs?: number;
  /** Wall time to observe arrivals before fixing a fresh anchor. */
  warmupMs?: number;
  now?: () => number;
}

export interface StampedChunk {
  samples: Int16Array;
  captureTimeMs: number;
  discontinuity: boolean;
}

export class SampleClock {
  private readonly rate: number;
  private readonly maxDriftMs: number;
  private readonly warmupMs: number;
  private readonly now: () => number;

  private anchorMs: number | null = null;
  /** Samples placed since the anchor. */
  private placed = 0;
  private pendingDiscontinuity = false;
  private anchors = 0;

  // warm-up state
  private held: Int16Array[] = [];
  private heldSamples = 0;
  private warmupStart = 0;
  private bound = Infinity;
  private lastDriftMs = 0;

  constructor(opts: SampleClockOptions = {}) {
    this.rate = opts.sampleRate ?? 16_000;
    this.maxDriftMs = opts.maxDriftMs ?? 1500;
    this.warmupMs = opts.warmupMs ?? 600;
    this.now = opts.now ?? (() => Date.now());
  }

  /** How many times the stream was (re-)anchored. */
  get anchorCount(): number {
    return this.anchors;
  }

  /** Wall clock minus sample time at the end of the last chunk (diagnostics). */
  get driftMs(): number {
    return this.lastDriftMs;
  }

  private ms(samples: number): number {
    return (samples / this.rate) * 1000;
  }

  /** Feed a chunk that just arrived; returns the chunks that can be stamped now. */
  push(samples: Int16Array): StampedChunk[] {
    if (samples.length === 0) return [];
    const now = this.now();
    if (this.anchorMs === null) {
      if (this.held.length === 0) this.warmupStart = now;
      this.held.push(samples);
      this.heldSamples += samples.length;
      this.bound = Math.min(this.bound, now - this.ms(this.heldSamples));
      if (
        now - this.warmupStart >= this.warmupMs ||
        this.ms(this.heldSamples) >= 2 * this.warmupMs + 1000
      ) {
        return this.release();
      }
      return [];
    }
    const expectedEnd = this.anchorMs + this.ms(this.placed + samples.length);
    this.lastDriftMs = now - expectedEnd;
    if (Math.abs(this.lastDriftMs) > this.maxDriftMs) {
      this.setAnchor(now - this.ms(samples.length));
      this.placed = samples.length;
      return [{ samples, captureTimeMs: this.anchorMs!, discontinuity: true }];
    }
    const captureTimeMs = this.anchorMs + this.ms(this.placed);
    this.placed += samples.length;
    return [{ samples, captureTimeMs, discontinuity: false }];
  }

  /** Stamp whatever is held in the warm-up (call before stopping). */
  flush(): StampedChunk[] {
    return this.anchorMs === null && this.held.length ? this.release() : [];
  }

  /** The source restarted (new ffmpeg process): warm up again, flag the next chunk. */
  reset(): void {
    if (this.anchorMs !== null || this.held.length) this.pendingDiscontinuity = true;
    this.anchorMs = null;
    this.placed = 0;
    this.held = [];
    this.heldSamples = 0;
    this.bound = Infinity;
  }

  private release(): StampedChunk[] {
    this.setAnchor(this.bound);
    const out: StampedChunk[] = [];
    let first = true;
    for (const s of this.held) {
      out.push({
        samples: s,
        captureTimeMs: this.anchorMs! + this.ms(this.placed),
        discontinuity: first && this.pendingDiscontinuity,
      });
      this.placed += s.length;
      first = false;
    }
    this.pendingDiscontinuity = false;
    this.held = [];
    this.heldSamples = 0;
    this.bound = Infinity;
    return out;
  }

  private setAnchor(ms: number): void {
    this.anchorMs = ms;
    this.anchors++;
  }
}
