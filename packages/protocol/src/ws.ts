import { z } from "zod";
import {
  zAudioSource,
  zEpochMs,
  zErrorCode,
  zLanguage,
  zSegmentOrigin,
  zTranscriptSegment,
  zUuid,
} from "./common.js";

/**
 * Ingest WebSocket — `GET {API_PREFIX}/ingest/ws`
 *
 * Lifecycle:
 *   1. Client opens the socket (no credentials in the URL — they would end up in logs).
 *   2. Client sends `hello` as the first text message, within 10 s.
 *   3. Server answers `ready` (or `error` and closes).
 *   4. `mode: "audio"`      → client sends binary audio frames (see frames.ts).
 *      `mode: "transcript"` → client sends `transcript` messages (on-device STT; no audio leaves the device).
 *   5. Either side may send `ping`/`pong` for liveness and clock-offset estimation.
 *   6. Client sends `end` and waits for `closed`, or just disconnects (server finalises after a grace period).
 *
 * One socket carries exactly one stream. A device that captures two sources at once
 * (e.g. the extension: tab + mic) opens two sockets with two `streamId`s.
 * Reconnecting with the same `streamId` resumes the stream.
 */
export const WS_INGEST_PATH = "/ingest/ws";

/** Seconds the server waits for `hello` before closing. */
export const WS_HELLO_TIMEOUT_S = 10;

export const zAudioCodec = z.enum(["pcm_s16le"]);
export type AudioCodec = z.infer<typeof zAudioCodec>;

export const zStreamMode = z.enum(["audio", "transcript"]);
export type StreamMode = z.infer<typeof zStreamMode>;

/** Free-form context that helps the note-taking model (never required). */
export const zStreamContext = z.object({
  /** e.g. the meeting title or tab title. */
  title: z.string().max(300).optional(),
  /** e.g. "meet.google.com" — hostname only, never a full URL with tokens. */
  app: z.string().max(120).optional(),
});
export type StreamContext = z.infer<typeof zStreamContext>;

export const zAudioFormat = z.object({
  codec: zAudioCodec,
  /** 16000 is strongly recommended; servers resample anything else. */
  sampleRate: z.number().int().min(8000).max(48000),
  channels: z.number().int().min(1).max(2),
});
export type AudioFormat = z.infer<typeof zAudioFormat>;

// ----------------------------- client → server -----------------------------

export const zClientHello = z.object({
  type: z.literal("hello"),
  protocol: z.number().int(),
  /** Device token obtained from pairing. */
  token: z.string().min(16).max(512),
  streamId: zUuid,
  source: zAudioSource,
  mode: zStreamMode,
  /** Required when `mode` is "audio". */
  audio: zAudioFormat.optional(),
  /** Device clock "now" at send time — lets the server estimate clock offset. */
  clientTimeMs: zEpochMs,
  /** Spoken language hint; omit for auto-detection. */
  language: zLanguage.optional(),
  context: zStreamContext.optional(),
});
export type ClientHello = z.infer<typeof zClientHello>;

export const zClientTranscript = z.object({
  type: z.literal("transcript"),
  segments: z.array(zTranscriptSegment).min(1).max(200),
});
export type ClientTranscript = z.infer<typeof zClientTranscript>;

export const zClientPing = z.object({
  type: z.literal("ping"),
  clientTimeMs: zEpochMs,
});
export type ClientPing = z.infer<typeof zClientPing>;

export const zClientEnd = z.object({ type: z.literal("end") });
export type ClientEnd = z.infer<typeof zClientEnd>;

export const zClientMessage = z.discriminatedUnion("type", [
  zClientHello,
  zClientTranscript,
  zClientPing,
  zClientEnd,
]);
export type ClientMessage = z.infer<typeof zClientMessage>;

// ----------------------------- server → client -----------------------------

export const zServerReady = z.object({
  type: z.literal("ready"),
  streamId: zUuid,
  serverTimeMs: zEpochMs,
  /** True when an existing stream was resumed. */
  resumed: z.boolean(),
});
export type ServerReady = z.infer<typeof zServerReady>;

/** Live feedback: a segment the server just recognised (or accepted) for this stream. */
export const zServerSegment = z.object({
  type: z.literal("segment"),
  segment: zTranscriptSegment.extend({ origin: zSegmentOrigin }),
});
export type ServerSegment = z.infer<typeof zServerSegment>;

export const zServerPong = z.object({
  type: z.literal("pong"),
  clientTimeMs: zEpochMs,
  serverTimeMs: zEpochMs,
});
export type ServerPong = z.infer<typeof zServerPong>;

export const zServerError = z.object({
  type: z.literal("error"),
  code: zErrorCode,
  message: z.string(),
  /** When true the server closes the socket right after this message. */
  fatal: z.boolean(),
});
export type ServerError = z.infer<typeof zServerError>;

export const zServerClosed = z.object({
  type: z.literal("closed"),
  streamId: zUuid,
});
export type ServerClosed = z.infer<typeof zServerClosed>;

export const zServerMessage = z.discriminatedUnion("type", [
  zServerReady,
  zServerSegment,
  zServerPong,
  zServerError,
  zServerClosed,
]);
export type ServerMessage = z.infer<typeof zServerMessage>;

/** WebSocket close codes used by the server. */
export const WS_CLOSE = {
  NORMAL: 1000,
  PROTOCOL_ERROR: 4400,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  HELLO_TIMEOUT: 4408,
} as const;
