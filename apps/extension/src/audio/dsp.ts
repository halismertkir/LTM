import { downmixToMono, floatToS16 } from "./pcm.js";
import { StreamingResampler } from "./resampler.js";

/** Name under which worklet.ts registers its processor. */
export const PROCESSOR_NAME = "ltm-capture";
/** Built file name of the worklet module (see vite.config.ts). */
export const WORKLET_FILE = "capture-worklet.js";

export const TARGET_SAMPLE_RATE = 16_000;
/** 200 ms at 16 kHz — the protocol's recommended frame duration. */
export const BLOCK_SAMPLES = 3_200;

export interface DspBlock {
  /** 16 kHz mono PCM, exactly `blockSamples` long. Owns its buffer (safe to transfer). */
  pcm: Int16Array;
  /**
   * AudioContext frame (at the context's sample rate) of the block's first sample. Usually
   * fractional because 16 kHz samples fall between 44.1/48 kHz frames.
   */
  contextFrame: number;
  /** True when input was missing right before this block (gap in the render clock). */
  discontinuity: boolean;
}

/**
 * Everything the AudioWorklet does, as a plain class so it can be tested in Node:
 * downmix → resample → cut into fixed blocks → s16. One instance per captured source.
 */
export class CaptureDsp {
  private resampler: StreamingResampler;
  private mono = new Float32Array(128);
  private block: Float32Array;
  private fill = 0;
  /** Output-sample index (since the last reset) of block[0]. */
  private blockFirstOut = 0;
  /** Context frame of input sample 0 of the current segment. */
  private segmentStartFrame: number | null = null;
  private expectedFrame: number | null = null;
  private pendingDiscontinuity = false;

  constructor(
    private readonly inRate: number,
    private readonly outRate = TARGET_SAMPLE_RATE,
    private readonly blockSamples = BLOCK_SAMPLES,
  ) {
    this.resampler = new StreamingResampler(inRate, outRate);
    this.block = new Float32Array(blockSamples);
  }

  /**
   * @param channels one render quantum (normally 128 frames) per channel
   * @param contextFrame AudioWorkletGlobalScope.currentFrame of channels[*][0]
   */
  push(channels: readonly Float32Array[], contextFrame: number): DspBlock[] {
    const n = channels[0]?.length ?? 0;
    if (n === 0) return [];
    if (this.expectedFrame !== null && contextFrame !== this.expectedFrame) {
      // The node was not fed for a while (input disconnected, context suspended). The
      // samples before and after are not adjacent, so restart the filter state rather than
      // smearing across the gap, and tell the server.
      this.reset();
      this.pendingDiscontinuity = true;
    }
    if (this.segmentStartFrame === null) this.segmentStartFrame = contextFrame;
    this.expectedFrame = contextFrame + n;

    if (this.mono.length < n) this.mono = new Float32Array(n);
    const mono = downmixToMono(channels, this.mono);
    const out = this.resampler.process(mono);

    const blocks: DspBlock[] = [];
    let i = 0;
    while (i < out.length) {
      const take = Math.min(out.length - i, this.blockSamples - this.fill);
      this.block.set(out.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === this.blockSamples) {
        blocks.push({
          pcm: floatToS16(this.block),
          contextFrame: this.segmentStartFrame + this.resampler.inputPositionOf(this.blockFirstOut),
          discontinuity: this.pendingDiscontinuity,
        });
        this.pendingDiscontinuity = false;
        this.blockFirstOut += this.blockSamples;
        this.fill = 0;
      }
    }
    return blocks;
  }

  /** Drops the partial block and filter history; the next push starts a new segment. */
  reset(): void {
    this.resampler = new StreamingResampler(this.inRate, this.outRate);
    this.fill = 0;
    this.blockFirstOut = 0;
    this.segmentStartFrame = null;
    this.expectedFrame = null;
  }
}
