import type { AudioSource, StreamContext } from "@ltm/protocol";
import type { WebSocketFactory } from "./client.js";
import { CaptureClock } from "./clock.js";
import { BLOCK_SAMPLES, PROCESSOR_NAME, TARGET_SAMPLE_RATE } from "./dsp.js";
import { type CaptureEvent, CaptureSession } from "./session.js";
import type { Transcriber } from "./transcriber.js";

export type { CaptureEvent, CapturePhase } from "./session.js";

export interface BrowserCaptureOptions {
  /** Origin of the LTM server, e.g. "https://ltm.example.com". */
  serverUrl: string;
  /** Device token from pairing. */
  token: string;
  source: AudioSource;
  /** The caller obtains the stream (getUserMedia, tabCapture) — permissions are a UI concern. */
  stream: MediaStream;
  /** URL of the built worklet module (`@ltm/capture/worklet`, built as its own file). */
  workletUrl: string | URL;
  /** Route the captured audio back to the speakers (needed for tab capture). Default false. */
  playthrough?: boolean;
  language?: string;
  context?: StreamContext;
  /** Resume an existing stream; default: a new random UUID. */
  streamId?: string;
  onEvent?: (event: CaptureEvent) => void;
  /** On-device transcription (stream mode "transcript"). */
  transcriber?: Transcriber;
  /** Defaults to the global WebSocket. */
  createSocket?: WebSocketFactory;
}

export interface BrowserCaptureHandle {
  readonly streamId: string;
  /** Sends `end`, waits for `closed` (bounded), stops tracks it was given and releases audio nodes. */
  stop(): Promise<void>;
}

/**
 * One AudioContext per worklet URL, shared by concurrent captures (the extension records
 * tab + mic at once) and closed when the last one stops.
 *
 * The context runs at the device's native rate on purpose: `new AudioContext({ sampleRate:
 * 16000 })` would make the browser resample for us, but with `playthrough` the user would
 * then hear the captured audio band-limited to 8 kHz. The worklet resamples instead.
 */
const contexts = new Map<string, { ctx: AudioContext; ready: Promise<void>; users: number }>();

async function acquireContext(workletUrl: string): Promise<AudioContext> {
  let entry = contexts.get(workletUrl);
  if (!entry) {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    entry = { ctx, ready: ctx.audioWorklet.addModule(workletUrl), users: 0 };
    contexts.set(workletUrl, entry);
  }
  entry.users++;
  try {
    await entry.ready;
  } catch (err) {
    releaseContext(workletUrl);
    throw err;
  }
  // Pages without a user gesture (offscreen documents, autoplay policy) may start the
  // context suspended.
  if (entry.ctx.state === "suspended") await entry.ctx.resume().catch(() => undefined);
  return entry.ctx;
}

function releaseContext(workletUrl: string): void {
  const entry = contexts.get(workletUrl);
  if (!entry) return;
  entry.users--;
  if (entry.users <= 0) {
    contexts.delete(workletUrl);
    void entry.ctx.close().catch(() => undefined);
  }
}

/**
 * A (context time, wall clock) pair for CaptureClock. `getOutputTimestamp()` relates context
 * time to the high-resolution clock far more precisely than reading `currentTime` next to
 * `Date.now()` on a busy main thread; it is converted into the `Date.now()` domain because
 * the wire carries device-clock epoch ms. Output latency is subtracted because the
 * timestamp describes when a frame reaches the speakers; input latency (~10–40 ms) is not
 * compensated (the server's merge tolerance absorbs it).
 */
function anchor(ctx: AudioContext): [number, number] {
  const ts = ctx.getOutputTimestamp?.();
  if (ts?.contextTime && ts.performanceTime) {
    const wall = Date.now() - (performance.now() - ts.performanceTime);
    return [ts.contextTime, wall - (ctx.outputLatency || 0) * 1000];
  }
  return [ctx.currentTime, Date.now()];
}

/**
 * Capture a MediaStream (microphone, tab, anything with an audio track) and stream it to
 * the LTM server: AudioContext + AudioWorklet (downmix → 16 kHz → 200 ms blocks) →
 * CaptureClock (wall-clock stamps) → CaptureSession (gate → stream client).
 *
 * Fatal server errors end the capture (`error` then `phase: "ended"`, no reconnect) and
 * release the audio; transport errors reconnect and resume the same stream. When every
 * audio track ends (tab closed, device unplugged) the capture stops itself cleanly.
 */
export async function startBrowserCapture(o: BrowserCaptureOptions): Promise<BrowserCaptureHandle> {
  const workletUrl = String(o.workletUrl);
  const sessionOpts: ConstructorParameters<typeof CaptureSession>[0] = {
    serverUrl: o.serverUrl,
    token: o.token,
    source: o.source,
  };
  if (o.language) sessionOpts.language = o.language;
  if (o.context) sessionOpts.context = o.context;
  if (o.streamId) sessionOpts.streamId = o.streamId;
  if (o.onEvent) sessionOpts.onEvent = o.onEvent;
  if (o.transcriber) sessionOpts.transcriber = o.transcriber;
  if (o.createSocket) sessionOpts.createSocket = o.createSocket;
  const session = new CaptureSession(sessionOpts);
  // Connect while the audio graph is built: blocks queue in the client until `ready`.
  await session.start();

  let ctx: AudioContext;
  try {
    ctx = await acquireContext(workletUrl);
  } catch (err) {
    session.abort();
    throw err;
  }

  let source: MediaStreamAudioSourceNode;
  let node: AudioWorkletNode;
  try {
    source = ctx.createMediaStreamSource(o.stream);
    node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      // One silent output connected to the destination: browsers only pull audio through
      // nodes that lead to the destination, so a sink-less worklet may never run.
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: TARGET_SAMPLE_RATE, blockSamples: BLOCK_SAMPLES },
    });
  } catch (err) {
    releaseContext(workletUrl);
    session.abort();
    throw err;
  }

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
    session.pushPcm(
      data.pcm,
      clock.toEpochMs(data.contextFrame / ctx.sampleRate),
      data.discontinuity || stepped,
    );
  };
  source.connect(node);
  node.connect(ctx.destination);
  // Tab capture diverts the tab's audio to us; without this the user would no longer hear it.
  if (o.playthrough) source.connect(ctx.destination);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      node.port.postMessage({ type: "stop" });
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
    } catch {
      // already disconnected
    }
    releaseContext(workletUrl);
    for (const t of o.stream.getTracks()) t.stop();
  };

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (!stopping) {
      stopping = (async () => {
        // Stop listening first, then flush and end the stream.
        release();
        await session.stop();
      })();
    }
    return stopping;
  };

  // Fatal error or any other end of the stream: release the microphone/tab right away.
  void session.closed.then(release);

  const audioTracks = o.stream.getAudioTracks();
  let liveTracks = audioTracks.length;
  for (const track of audioTracks) {
    track.addEventListener("ended", () => {
      liveTracks--;
      if (liveTracks <= 0) void stop();
    });
  }

  return { streamId: session.streamId, stop };
}
