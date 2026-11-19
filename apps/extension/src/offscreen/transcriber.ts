import type { TranscriptSegment } from "@ltm/protocol";
import type { SpeechWindow } from "../audio/windower.js";

/**
 * On-device speech recognition for streams in mode "transcript": gated speech windows go
 * in, segments with device-clock timestamps come out, and only text leaves the device.
 *
 * The plumbing around it is complete (windowing, `transcript` messages on the socket,
 * REST fallback via /ingest/transcripts). No recogniser ships in this version: a real one
 * (e.g. Whisper on WebGPU/WASM) needs a model download from a third-party host behind an
 * explicit opt-in, bundled WASM runtimes and a matching CSP, and it has not been verified
 * end to end yet — so the option is shown disabled rather than faked.
 */
export interface Transcriber {
  /** Human-readable engine name, e.g. "whisper-tiny (WebGPU)". */
  readonly engine: string;
  transcribe(window: SpeechWindow, language?: string): Promise<TranscriptSegment[]>;
  dispose(): void;
}

export const ON_DEVICE_TRANSCRIPTION_AVAILABLE = false;

/** Resolves to a ready recogniser, or null when none is available in this build. */
export async function createTranscriber(): Promise<Transcriber | null> {
  return null;
}
