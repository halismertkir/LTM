import type { TranscriptSegment } from "@ltm/protocol";
import type { SpeechWindow } from "./windower.js";

/**
 * On-device speech recognition for streams in mode "transcript": gated speech windows go
 * in, segments with device-clock timestamps come out, and only text leaves the device.
 * Pass one to `CaptureSession` / `startBrowserCapture` to switch the stream to that mode.
 */
export interface Transcriber {
  /** Human-readable engine name, e.g. "whisper-tiny (WebGPU)". */
  readonly engine: string;
  transcribe(window: SpeechWindow, language?: string): Promise<TranscriptSegment[]>;
  dispose(): void;
}
