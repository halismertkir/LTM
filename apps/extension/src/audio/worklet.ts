/**
 * AudioWorklet module (built as its own file: `capture-worklet.js`). Runs on the realtime
 * audio thread: no allocation-heavy work, no awaiting, nothing that can block. It turns the
 * captured stream into 200 ms blocks of 16 kHz mono s16 and posts them to the offscreen
 * document together with the AudioContext frame of each block's first sample; gating and
 * wall-clock stamping happen on the main thread.
 */
import { CaptureDsp, PROCESSOR_NAME } from "./dsp.js";

interface Options {
  targetRate?: number;
  blockSamples?: number;
}

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly dsp: CaptureDsp;
  private stopped = false;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const opts = (options?.processorOptions ?? {}) as Options;
    this.dsp = new CaptureDsp(sampleRate, opts.targetRate, opts.blockSamples);
    this.port.onmessage = (event) => {
      if ((event.data as { type?: string })?.type === "stop") this.stopped = true;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const input = inputs[0];
    // An input with zero channels means nothing is connected (yet/anymore). Keep the
    // processor alive; CaptureDsp notices the frame gap when audio returns.
    if (!input || input.length === 0) return true;
    const blocks = this.dsp.push(input, currentFrame);
    for (const b of blocks) {
      this.port.postMessage(
        { type: "block", pcm: b.pcm, contextFrame: b.contextFrame, discontinuity: b.discontinuity },
        [b.pcm.buffer as ArrayBuffer],
      );
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, CaptureProcessor);
