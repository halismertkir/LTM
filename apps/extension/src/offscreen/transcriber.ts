import type { Transcriber } from "@ltm/capture";

/**
 * On-device transcription for streams in mode "transcript". The plumbing lives in
 * `@ltm/capture` (windowing, `transcript` messages, the /ingest/transcripts fallback); no
 * recogniser ships in this version. A real one (e.g. Whisper on WebGPU/WASM) needs a model
 * download from a third-party host behind an explicit opt-in, bundled WASM runtimes and a
 * matching CSP, and it has not been verified end to end — so the option is shown disabled
 * rather than faked.
 */
export const ON_DEVICE_TRANSCRIPTION_AVAILABLE = false;

/** Resolves to a ready recogniser, or null when none is available in this build. */
export async function createTranscriber(): Promise<Transcriber | null> {
  return null;
}
