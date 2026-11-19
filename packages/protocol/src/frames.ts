/**
 * Binary audio frame used on the ingest WebSocket.
 *
 * Every binary WebSocket message is exactly one frame:
 *
 * ```
 * offset  size  field
 * 0       1     magic[0] = 0x4C ('L')
 * 1       1     magic[1] = 0x54 ('T')
 * 2       1     version  = 1
 * 3       1     flags    (bit 0: DISCONTINUITY — capture was interrupted before this frame)
 * 4       4     seq      (uint32 LE, starts at 0, increments by one per frame, wraps)
 * 8       8     captureTimeMs (float64 LE, device-clock epoch ms of the FIRST sample)
 * 16      n     payload  (codec declared in `hello`; v1: signed 16-bit LE PCM, interleaved)
 * ```
 *
 * The timestamp travels with every frame (instead of being derived from a sample
 * counter) so that clients may drop silence locally (VAD gating) without the server
 * losing track of wall-clock time — which is what multi-device merging relies on.
 */

export const FRAME_MAGIC_0 = 0x4c;
export const FRAME_MAGIC_1 = 0x54;
export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 16;
export const FRAME_FLAG_DISCONTINUITY = 0x01;

/** Recommended payload duration per frame. Servers must accept 10 ms – 2 s. */
export const RECOMMENDED_FRAME_MS = 200;
/** Hard cap on one binary message (header + payload). */
export const MAX_FRAME_BYTES = 256 * 1024;

export interface AudioFrame {
  seq: number;
  captureTimeMs: number;
  discontinuity: boolean;
  /** Raw codec payload. For `pcm_s16le` the byte length is a multiple of 2 × channels. */
  payload: Uint8Array;
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export function encodeAudioFrame(frame: AudioFrame): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(out.buffer);
  out[0] = FRAME_MAGIC_0;
  out[1] = FRAME_MAGIC_1;
  out[2] = FRAME_VERSION;
  out[3] = frame.discontinuity ? FRAME_FLAG_DISCONTINUITY : 0;
  view.setUint32(4, frame.seq >>> 0, true);
  view.setFloat64(8, frame.captureTimeMs, true);
  out.set(frame.payload, FRAME_HEADER_BYTES);
  return out;
}

/**
 * Decodes a frame. The returned payload is a view into `data` (no copy) — copy it if
 * the underlying buffer is reused.
 */
export function decodeAudioFrame(data: Uint8Array): AudioFrame {
  if (data.byteLength < FRAME_HEADER_BYTES) {
    throw new FrameError(`frame too short: ${data.byteLength} bytes`);
  }
  if (data.byteLength > MAX_FRAME_BYTES) {
    throw new FrameError(`frame too large: ${data.byteLength} bytes`);
  }
  if (data[0] !== FRAME_MAGIC_0 || data[1] !== FRAME_MAGIC_1) {
    throw new FrameError("bad frame magic");
  }
  if (data[2] !== FRAME_VERSION) {
    throw new FrameError(`unsupported frame version ${data[2]}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const captureTimeMs = view.getFloat64(8, true);
  if (!Number.isFinite(captureTimeMs) || captureTimeMs < 0) {
    throw new FrameError("invalid capture timestamp");
  }
  return {
    seq: view.getUint32(4, true),
    captureTimeMs,
    discontinuity: (data[3]! & FRAME_FLAG_DISCONTINUITY) !== 0,
    payload: data.subarray(FRAME_HEADER_BYTES),
  };
}
