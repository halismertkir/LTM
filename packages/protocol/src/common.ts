import { z } from "zod";

/** Bumped only on breaking wire changes. Servers accept exactly this version in `hello`. */
export const PROTOCOL_VERSION = 1;

/** Every REST and WebSocket route lives under this prefix. */
export const API_PREFIX = "/api/v1";

/** Milliseconds since the Unix epoch. All media timestamps on the wire use this unit. */
export const zEpochMs = z.number().finite().nonnegative();
export const zIsoDate = z.string().min(10).max(40);
export const zId = z.string().min(1).max(64);
export const zUuid = z.uuid();

/** BCP-47-ish language tag ("tr", "en", "en-US"). */
export const zLanguage = z
  .string()
  .min(2)
  .max(16)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);

export const zLocale = z.enum(["en", "tr"]);
export type Locale = z.infer<typeof zLocale>;

// ---------------------------------------------------------------------------
// Devices and audio sources
// ---------------------------------------------------------------------------

export const zDeviceKind = z.enum([
  "browser_extension",
  "iphone",
  "apple_watch",
  "web",
  "desktop",
  "other",
]);
export type DeviceKind = z.infer<typeof zDeviceKind>;

/**
 * Where the audio physically came from.
 * - `tab`: audio rendered by a browser tab (the *other* participants of a call) — cleanest signal.
 * - `mic`: a microphone close to the user.
 * - `system`: loopback capture of all system audio.
 * - `ambient`: a far-field / wearable microphone (Apple Watch, phone on a table).
 */
export const zAudioSource = z.enum(["tab", "mic", "system", "ambient"]);
export type AudioSource = z.infer<typeof zAudioSource>;

/**
 * Default preference order when the same speech is heard by several sources.
 * Higher wins. Users can override per device with `Device.priority`.
 */
export const SOURCE_PRIORITY: Record<AudioSource, number> = {
  tab: 40,
  system: 30,
  mic: 20,
  ambient: 10,
};

/** Where speech-to-text ran for a segment. */
export const zSegmentOrigin = z.enum(["server_stt", "edge_stt"]);
export type SegmentOrigin = z.infer<typeof zSegmentOrigin>;

/** Coarse speaker hint. Real diarization is out of scope for protocol v1. */
export const zSpeakerHint = z.enum(["self", "other", "unknown"]);
export type SpeakerHint = z.infer<typeof zSpeakerHint>;

// ---------------------------------------------------------------------------
// Transcript segments (shared by WS `transcript`, REST batch upload, and live feedback)
// ---------------------------------------------------------------------------

/** A piece of recognised speech with absolute timestamps on the *device* clock. */
export const zTranscriptSegment = z.object({
  /** Client-generated id, unique within the stream. Used for idempotent re-delivery. */
  id: zId.optional(),
  startMs: zEpochMs,
  endMs: zEpochMs,
  text: z.string().min(1).max(8000),
  /** 0..1 — recogniser confidence if known. */
  confidence: z.number().min(0).max(1).optional(),
  language: zLanguage.optional(),
  speaker: zSpeakerHint.optional(),
});
export type TranscriptSegment = z.infer<typeof zTranscriptSegment>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const zErrorCode = z.enum([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "payload_too_large",
  "unsupported_protocol",
  "unsupported_codec",
  /** Ingest refused because the account has not accepted the current consent documents. */
  "consent_required",
  /** Ingest refused because the user paused capture account-wide. */
  "ingest_paused",
  "setup_required",
  "provider_not_configured",
  "provider_error",
  "internal",
]);
export type ErrorCode = z.infer<typeof zErrorCode>;

/** Body of every non-2xx REST response. */
export const zErrorResponse = z.object({
  error: z.object({
    code: zErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof zErrorResponse>;
