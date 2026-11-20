// Runtime-neutral entry: nothing here touches Web Audio, the DOM or extension APIs.
// Web Audio capture lives in "@ltm/capture/browser", the worklet in "@ltm/capture/worklet".
export { type BackoffOptions, backoffDelay, DEFAULT_BACKOFF } from "./backoff.js";
export {
  globalWebSocketFactory,
  PERMANENT_ERRORS,
  StreamClient,
  type StreamClientOptions,
  type StreamErrorCode,
  type StreamEvent,
  type StreamPhase,
  type WebSocketFactory,
  type WebSocketLike,
} from "./client.js";
export { CaptureClock, type ClockOptions } from "./clock.js";
export {
  BLOCK_SAMPLES,
  CaptureDsp,
  type DspBlock,
  PROCESSOR_NAME,
  TARGET_SAMPLE_RATE,
  WORKLET_FILE,
} from "./dsp.js";
export { EnergyGate, type GateOptions, type StampedBlock } from "./gate.js";
export { downmixToMono, floatToS16, leBytesToS16, rmsDbfs, s16ToLeBytes } from "./pcm.js";
export { type ResamplerOptions, StreamingResampler } from "./resampler.js";
export {
  type CaptureEnd,
  type CaptureEvent,
  type CapturePhase,
  CaptureSession,
  type CaptureSessionOptions,
} from "./session.js";
export type { Transcriber } from "./transcriber.js";
export { apiUrl, ingestWsUrl } from "./url.js";
export { type SpeechWindow, SpeechWindower } from "./windower.js";
