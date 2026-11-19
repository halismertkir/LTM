import { CaptureClock } from "../audio/clock.js";
import { BLOCK_SAMPLES, PROCESSOR_NAME, TARGET_SAMPLE_RATE, WORKLET_FILE } from "../audio/dsp.js";
import type { StampedBlock } from "../audio/gate.js";

/**
 * One AudioContext for the whole offscreen document, shared by the tab and mic pipelines
 * and closed when the last one stops.
 *
 * The context runs at the device's native rate (usually 48 kHz) on purpose: asking for
 * `new AudioContext({ sampleRate: 16000 })` would make Chrome resample internally, but the
 * captured tab is also played back through this context, and the user would then hear
 * their meeting band-limited to 8 kHz.
 */
let shared: { ctx: AudioContext; ready: Promise<void>; users: number } | null = null;

async function acquireContext(): Promise<AudioContext> {
  if (!shared) {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    shared = {
      ctx,
      ready: ctx.audioWorklet.addModule(chrome.runtime.getURL(WORKLET_FILE)),
      users: 0,
    };
  }
  shared.users++;
  const { ctx, ready } = shared;
  await ready;
  // Offscreen documents have no user activation; USER_MEDIA documents are allowed to run
  // audio, but a context may still start "suspended" on some platforms.
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
  return ctx;
}

function releaseContext(): void {
  if (!shared) return;
  shared.users--;
  if (shared.users <= 0) {
    const { ctx } = shared;
    shared = null;
    void ctx.close().catch(() => undefined);
  }
}

/**
 * A (context time, wall clock) pair for CaptureClock. `getOutputTimestamp()` relates a
 * context time to the high-resolution clock far more precisely than reading
 * `currentTime` next to `Date.now()` on a busy main thread; it is converted into the
 * `Date.now()` domain because the wire carries device-clock epoch ms. The output latency
 * is subtracted because the timestamp describes when a frame reaches the speakers, while
 * we want (approximately) when it was processed. Input latency (~10–40 ms) is not
 * compensated; the server's merge tolerance absorbs it.
 */
function anchor(ctx: AudioContext): [number, number] {
  const ts = ctx.getOutputTimestamp?.();
  if (ts?.contextTime && ts.performanceTime) {
    const wall = Date.now() - (performance.now() - ts.performanceTime);
    return [ts.contextTime, wall - (ctx.outputLatency || 0) * 1000];
  }
  return [ctx.currentTime, Date.now()];
}

export interface PipelineOptions {
  stream: MediaStream;
  /** Route the captured audio to the speakers (tab capture mutes the tab otherwise). */
  playthrough: boolean;
  onBlock: (block: StampedBlock) => void;
}

export class CapturePipeline {
  private constructor(
    private readonly ctx: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly node: AudioWorkletNode,
  ) {}

  static async start(opts: PipelineOptions): Promise<CapturePipeline> {
    const ctx = await acquireContext();
    try {
      const source = ctx.createMediaStreamSource(opts.stream);
      const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 1,
        // One silent output connected to the destination: Chrome only pulls audio through
        // nodes that lead to the destination, so a sink-less worklet may never run.
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetRate: TARGET_SAMPLE_RATE, blockSamples: BLOCK_SAMPLES },
      });
      const clock = new CaptureClock();
      node.port.onmessage = (ev: MessageEvent) => {
        const data = ev.data as {
          type: string;
          pcm: Int16Array;
          contextFrame: number;
          discontinuity: boolean;
        };
        if (data.type !== "block") return;
        const [ctxSec, wall] = anchor(ctx);
        clock.observe(ctxSec, wall);
        const stepped = clock.takeStep();
        opts.onBlock({
          pcm: data.pcm,
          captureTimeMs: clock.toEpochMs(data.contextFrame / ctx.sampleRate),
          discontinuity: data.discontinuity || stepped,
        });
      };
      source.connect(node);
      node.connect(ctx.destination);
      if (opts.playthrough) {
        // tabCapture diverts the tab's audio to us; without this the user would no longer
        // hear the meeting they are recording.
        source.connect(ctx.destination);
      }
      return new CapturePipeline(ctx, source, node);
    } catch (err) {
      releaseContext();
      throw err;
    }
  }

  stop(): void {
    try {
      this.node.port.postMessage({ type: "stop" });
      this.node.port.onmessage = null;
      this.source.disconnect();
      this.node.disconnect();
    } catch {
      // already disconnected
    }
    releaseContext();
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }
}
