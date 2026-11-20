import type { StampedBlock } from "./gate.js";

export interface SpeechWindow {
  /** Device-clock epoch ms of the first sample. */
  startMs: number;
  endMs: number;
  sampleRate: number;
  pcm: Int16Array;
}

/**
 * Groups gated blocks into speech windows for an on-device recogniser: a window ends at a
 * gated gap (the gate's DISCONTINUITY flag), when the timestamps jump, or at `maxMs` —
 * the same ~28 s limit the server uses, which keeps Whisper-style models (30 s context)
 * within their window.
 */
export class SpeechWindower {
  private blocks: StampedBlock[] = [];
  private samples = 0;
  private readonly maxSamples: number;

  constructor(
    private readonly sampleRate = 16_000,
    maxMs = 28_000,
    /** Gap between consecutive block timestamps that counts as a break. */
    private readonly gapToleranceMs = 50,
  ) {
    this.maxSamples = Math.floor((maxMs / 1000) * sampleRate);
  }

  /** Returns the windows that were completed by this block. */
  push(block: StampedBlock): SpeechWindow[] {
    const out: SpeechWindow[] = [];
    const last = this.blocks[this.blocks.length - 1];
    if (last) {
      const expected = last.captureTimeMs + (last.pcm.length / this.sampleRate) * 1000;
      const jumped = Math.abs(block.captureTimeMs - expected) > this.gapToleranceMs;
      if (block.discontinuity || jumped) {
        const w = this.flush();
        if (w) out.push(w);
      }
    }
    if (this.samples + block.pcm.length > this.maxSamples && this.blocks.length > 0) {
      const w = this.flush();
      if (w) out.push(w);
    }
    this.blocks.push(block);
    this.samples += block.pcm.length;
    return out;
  }

  /** Emits whatever is pending (call on stop). */
  flush(): SpeechWindow | null {
    if (this.blocks.length === 0) return null;
    const pcm = new Int16Array(this.samples);
    let off = 0;
    for (const b of this.blocks) {
      pcm.set(b.pcm, off);
      off += b.pcm.length;
    }
    const startMs = this.blocks[0]!.captureTimeMs;
    this.blocks = [];
    this.samples = 0;
    return {
      startMs,
      endMs: startMs + (pcm.length / this.sampleRate) * 1000,
      sampleRate: this.sampleRate,
      pcm,
    };
  }
}
