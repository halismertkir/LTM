import { z } from "zod";
import {
  zAudioSource,
  zDeviceKind,
  zEpochMs,
  zId,
  zIsoDate,
  zLanguage,
  zLocale,
  zSegmentOrigin,
  zSpeakerHint,
  zTranscriptSegment,
  zUuid,
} from "./common.js";
import { zStreamContext } from "./ws.js";

/**
 * REST API — all paths are relative to API_PREFIX ("/api/v1").
 *
 * Authentication: `Authorization: Bearer <token>` (devices, scripts) or the httpOnly
 * `ltm_session` cookie (web app). User sessions may call everything; device tokens may
 * only call `/me`, `/consents`, `/ingest/*` and `/devices/self`.
 *
 * Errors: non-2xx responses carry `ErrorResponse` (see common.ts).
 */
export const SESSION_COOKIE = "ltm_session";

export const ROUTES = {
  // --- auth
  authStatus: "/auth/status", // GET  → AuthStatus (public)
  authSetup: "/auth/setup", // POST SetupRequest → AuthResponse (public, only while no user exists)
  authRegister: "/auth/register", // POST RegisterRequest → AuthResponse (public, only if registration is open)
  authLogin: "/auth/login", // POST LoginRequest → AuthResponse (public)
  authLogout: "/auth/logout", // POST → 204
  me: "/me", // GET → Me

  // --- devices
  devices: "/devices", // GET → Device[]
  devicePairingCodes: "/devices/pairing-codes", // POST → PairingCode (user session)
  devicePair: "/devices/pair", // POST PairRequest → PairResponse (public; the code is the credential)
  deviceSelf: "/devices/self", // GET → Device (device token)
  device: "/devices/:id", // PATCH DeviceUpdate → Device, DELETE → 204 (revokes its token)

  // --- consent
  consents: "/consents", // GET → ConsentState, POST ConsentAccept → ConsentState
  consentWithdraw: "/consents/withdraw", // POST ConsentWithdraw → ConsentState (also pauses ingest)

  // --- ingest
  ingestWs: "/ingest/ws", // WebSocket, see ws.ts
  ingestChunks: "/ingest/chunks", // POST multipart: field "meta" (ChunkMeta JSON) + file "audio" → ChunkAccepted
  ingestTranscripts: "/ingest/transcripts", // POST TranscriptBatch → TranscriptAccepted
  ingestStreamEnd: "/ingest/streams/:streamId/end", // POST → 204

  // --- memory
  conversations: "/conversations", // GET ?from&to&q&limit&cursor → Page<ConversationSummary>
  conversation: "/conversations/:id", // GET → ConversationDetail, PATCH ConversationUpdate, DELETE → 204
  conversationReprocess: "/conversations/:id/reprocess", // POST → 202
  actionItem: "/conversations/:id/action-items/:itemId", // PATCH ActionItemUpdate → ActionItem
  memories: "/memories", // GET ?q&kind&limit&cursor → Page<Memory>, POST MemoryCreate → Memory
  memory: "/memories/:id", // PATCH MemoryUpdate → Memory, DELETE → 204
  search: "/search", // POST SearchRequest → SearchResponse
  ask: "/ask", // POST AskRequest → AskResponse
  streams: "/streams", // GET ?active=true → StreamInfo[]
  events: "/events", // GET text/event-stream of LiveEvent (JSON in `data:`)

  // --- settings
  settings: "/settings", // GET → Settings
  settingsProvider: "/settings/providers/:role", // PUT ProviderConfigInput → ProviderConfig
  settingsProviderTest: "/settings/providers/:role/test", // POST → ProviderTestResult
  settingsPrivacy: "/settings/privacy", // PUT PrivacySettings → PrivacySettings
  settingsPipeline: "/settings/pipeline", // PUT PipelineSettings → PipelineSettings
  providerCatalog: "/providers/catalog", // GET → ProviderCatalog

  // --- data rights
  exportData: "/export", // GET → application/json attachment with everything the server holds for the user
  deleteData: "/data", // DELETE DeleteDataRequest → 204 (erases captured data, keeps the account)
  deleteAccount: "/account", // DELETE DeleteAccountRequest → 204 (erases everything)

  // --- misc
  version: "/version", // GET → VersionInfo (public)
} as const;

// ---------------------------------------------------------------------------
// Generic
// ---------------------------------------------------------------------------

export const zPageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export function zPage<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const zVersionInfo = z.object({
  name: z.literal("ltm"),
  version: z.string(),
  protocol: z.number().int(),
});
export type VersionInfo = z.infer<typeof zVersionInfo>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const zUser = z.object({
  id: zId,
  email: z.string(),
  displayName: z.string(),
  role: z.enum(["owner", "member"]),
  locale: zLocale,
  createdAt: zIsoDate,
});
export type User = z.infer<typeof zUser>;

export const zAuthStatus = z.object({
  setupRequired: z.boolean(),
  registrationOpen: z.boolean(),
});
export type AuthStatus = z.infer<typeof zAuthStatus>;

const zPassword = z.string().min(10).max(200);

export const zSetupRequest = z.object({
  email: z.email().max(254),
  password: zPassword,
  displayName: z.string().min(1).max(80),
  locale: zLocale.default("en"),
});
export type SetupRequest = z.input<typeof zSetupRequest>;
export const zRegisterRequest = zSetupRequest;
export type RegisterRequest = SetupRequest;

export const zLoginRequest = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof zLoginRequest>;

export const zAuthResponse = z.object({
  user: zUser,
  /** Session bearer token. The same value is also set as the httpOnly session cookie. */
  token: z.string(),
  expiresAt: zIsoDate,
});
export type AuthResponse = z.infer<typeof zAuthResponse>;

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export const zDevice = z.object({
  id: zId,
  name: z.string(),
  kind: zDeviceKind,
  platform: z.string().nullable(),
  appVersion: z.string().nullable(),
  /**
   * Merge preference override. `null` → use SOURCE_PRIORITY of the stream's source.
   * Higher wins when the same speech was captured by several devices.
   */
  priority: z.number().int().min(0).max(100).nullable(),
  createdAt: zIsoDate,
  lastSeenAt: zIsoDate.nullable(),
  /** True while at least one ingest stream is open. */
  online: z.boolean(),
});
export type Device = z.infer<typeof zDevice>;

export const zPairingCode = z.object({
  /** Human-typable, e.g. "K7QF-2MXD". Single use, valid for 10 minutes. */
  code: z.string(),
  expiresAt: zIsoDate,
  /**
   * `ltm://pair?server=<origin>&code=<code>` — render as QR for the phone.
   * The watch is paired through the phone and never scans this itself.
   */
  pairingUri: z.string(),
});
export type PairingCode = z.infer<typeof zPairingCode>;

export const zPairRequest = z.object({
  code: z.string().min(4).max(32),
  name: z.string().min(1).max(80),
  kind: zDeviceKind,
  platform: z.string().max(80).optional(),
  appVersion: z.string().max(40).optional(),
});
export type PairRequest = z.infer<typeof zPairRequest>;

export const zPairResponse = z.object({
  device: zDevice,
  /** Long-lived device token. Shown once; store it in the platform keychain. */
  token: z.string(),
  user: z.object({ id: zId, displayName: z.string(), locale: zLocale }),
});
export type PairResponse = z.infer<typeof zPairResponse>;

export const zDeviceUpdate = z.object({
  name: z.string().min(1).max(80).optional(),
  priority: z.number().int().min(0).max(100).nullable().optional(),
});
export type DeviceUpdate = z.infer<typeof zDeviceUpdate>;

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export const zConsentType = z.enum([
  /** The user is responsible for informing others and obtaining their consent to be recorded. */
  "recording_responsibility",
  /** Explicit consent to the processing of the user's own voice, transcripts and derived notes. */
  "data_processing",
  /** Transcripts/audio are sent to a third-party AI provider chosen by the user (BYOK / cloud). */
  "third_party_ai",
]);
export type ConsentType = z.infer<typeof zConsentType>;

export const zConsentRecord = z.object({
  type: zConsentType,
  version: z.string(),
  acceptedAt: zIsoDate,
  /** Which device/session recorded the acceptance. */
  via: z.string().nullable(),
});
export type ConsentRecord = z.infer<typeof zConsentRecord>;

export const zConsentRequirement = z.object({
  type: zConsentType,
  /** Current version of the document; acceptance of an older version does not satisfy it. */
  version: z.string(),
  accepted: z.boolean(),
});

export const zConsentState = z.object({
  /** True when every currently required document has been accepted at its current version. */
  satisfied: z.boolean(),
  required: z.array(zConsentRequirement),
  records: z.array(zConsentRecord),
});
export type ConsentState = z.infer<typeof zConsentState>;

export const zConsentAccept = z.object({
  accept: z.array(z.object({ type: zConsentType, version: z.string().max(40) })).min(1),
});
export type ConsentAccept = z.infer<typeof zConsentAccept>;

export const zConsentWithdraw = z.object({ types: z.array(zConsentType).min(1) });
export type ConsentWithdraw = z.infer<typeof zConsentWithdraw>;

export const zMe = z.object({
  user: zUser,
  principal: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user") }),
    z.object({ type: z.literal("device"), deviceId: zId }),
  ]),
  consent: zConsentState,
  ingestPaused: z.boolean(),
});
export type Me = z.infer<typeof zMe>;

// ---------------------------------------------------------------------------
// Ingest over HTTP (store-and-forward: watch, phone in background, offline catch-up)
// ---------------------------------------------------------------------------

/** MIME types accepted for uploaded audio chunks. */
export const CHUNK_MIME_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/flac",
] as const;

/** Upper bound for one uploaded chunk. Clients should cut chunks of 15–60 s. */
export const MAX_CHUNK_BYTES = 25 * 1024 * 1024;

export const zChunkMeta = z.object({
  streamId: zUuid,
  /** Monotonic per stream, starts at 0. `(streamId, seq)` is the idempotency key. */
  seq: z.number().int().nonnegative(),
  source: zAudioSource,
  /** Device-clock time of the first sample in this chunk. */
  startMs: zEpochMs,
  durationMs: z.number().positive().max(10 * 60 * 1000),
  /** Device clock "now" when the upload is attempted (clock-offset estimation). */
  clientTimeMs: zEpochMs,
  language: zLanguage.optional(),
  context: zStreamContext.optional(),
  /** Marks the last chunk of the stream. */
  final: z.boolean().optional(),
});
export type ChunkMeta = z.infer<typeof zChunkMeta>;

export const zChunkAccepted = z.object({
  streamId: zUuid,
  seq: z.number().int(),
  /** False when this `(streamId, seq)` had already been stored. */
  created: z.boolean(),
});
export type ChunkAccepted = z.infer<typeof zChunkAccepted>;

export const zTranscriptBatch = z.object({
  streamId: zUuid,
  source: zAudioSource,
  clientTimeMs: zEpochMs,
  segments: z.array(zTranscriptSegment).min(1).max(500),
  context: zStreamContext.optional(),
  final: z.boolean().optional(),
});
export type TranscriptBatch = z.infer<typeof zTranscriptBatch>;

export const zTranscriptAccepted = z.object({
  streamId: zUuid,
  accepted: z.number().int(),
  duplicates: z.number().int(),
});
export type TranscriptAccepted = z.infer<typeof zTranscriptAccepted>;

export const zStreamInfo = z.object({
  id: zUuid,
  deviceId: zId,
  deviceName: z.string(),
  source: zAudioSource,
  mode: z.enum(["audio", "transcript"]),
  startedAt: zIsoDate,
  endedAt: zIsoDate.nullable(),
  active: z.boolean(),
  context: zStreamContext.nullable(),
});
export type StreamInfo = z.infer<typeof zStreamInfo>;

// ---------------------------------------------------------------------------
// Conversations, utterances, notes
// ---------------------------------------------------------------------------

/** One canonical line of the merged, de-duplicated transcript. */
export const zUtterance = z.object({
  id: zId,
  startMs: zEpochMs,
  endMs: zEpochMs,
  text: z.string(),
  speaker: zSpeakerHint,
  language: zLanguage.nullable(),
  /** Devices that heard this utterance (the first one supplied the text). */
  deviceIds: z.array(zId),
  sources: z.array(zAudioSource),
  origin: zSegmentOrigin,
});
export type Utterance = z.infer<typeof zUtterance>;

export const zActionItem = z.object({
  id: zId,
  text: z.string(),
  owner: z.string().nullable(),
  /** ISO date (YYYY-MM-DD) if one was mentioned. */
  due: z.string().nullable(),
  done: z.boolean(),
});
export type ActionItem = z.infer<typeof zActionItem>;
export const zActionItemUpdate = z.object({
  done: z.boolean().optional(),
  text: z.string().min(1).max(1000).optional(),
});
export type ActionItemUpdate = z.infer<typeof zActionItemUpdate>;

export const zConversationStatus = z.enum([
  /** Still receiving speech. */
  "open",
  /** Closed; waiting for or running LLM consolidation. */
  "processing",
  /** Notes are available. */
  "ready",
  /** Consolidation failed or no LLM is configured — transcript is still available. */
  "transcript_only",
]);
export type ConversationStatus = z.infer<typeof zConversationStatus>;

export const zConversationSummary = z.object({
  id: zId,
  status: zConversationStatus,
  startMs: zEpochMs,
  endMs: zEpochMs,
  title: z.string().nullable(),
  /** One-paragraph abstract. */
  summary: z.string().nullable(),
  topics: z.array(z.string()),
  participants: z.array(z.string()),
  language: zLanguage.nullable(),
  deviceIds: z.array(zId),
  utteranceCount: z.number().int(),
  openActionItems: z.number().int(),
  updatedAt: zIsoDate,
});
export type ConversationSummary = z.infer<typeof zConversationSummary>;

export const zConversationDetail = zConversationSummary.extend({
  /** Markdown notes written by the consolidation model (editable by the user). */
  notes: z.string().nullable(),
  decisions: z.array(z.string()),
  actionItems: z.array(zActionItem),
  utterances: z.array(zUtterance),
  /** Long-term memories extracted from this conversation. */
  memoryIds: z.array(zId),
  /** Human-readable reason when status is "transcript_only". */
  statusDetail: z.string().nullable(),
});
export type ConversationDetail = z.infer<typeof zConversationDetail>;

export const zConversationQuery = zPageQuery.extend({
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  /** Full-text filter over title, summary and transcript. */
  q: z.string().max(200).optional(),
});

export const zConversationUpdate = z.object({
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(100_000).optional(),
});
export type ConversationUpdate = z.infer<typeof zConversationUpdate>;

// ---------------------------------------------------------------------------
// Long-term memory
// ---------------------------------------------------------------------------

export const zMemoryKind = z.enum([
  "fact",
  "preference",
  "person",
  "commitment",
  "decision",
  "event",
  "idea",
]);
export type MemoryKind = z.infer<typeof zMemoryKind>;

export const zMemory = z.object({
  id: zId,
  kind: zMemoryKind,
  /** A single self-contained statement, e.g. "Ayşe prefers async status updates over meetings." */
  content: z.string(),
  /** 1 (trivia) … 5 (critical). */
  importance: z.number().int().min(1).max(5),
  /** People/projects/things this memory is about. */
  subjects: z.array(z.string()),
  sourceConversationId: zId.nullable(),
  /** Set by the user, or "manual" when created by hand. */
  origin: z.enum(["extracted", "manual"]),
  /** When the described thing happened / became true, if known. */
  occurredAt: zIsoDate.nullable(),
  createdAt: zIsoDate,
  updatedAt: zIsoDate,
});
export type Memory = z.infer<typeof zMemory>;

export const zMemoryQuery = zPageQuery.extend({
  q: z.string().max(200).optional(),
  kind: zMemoryKind.optional(),
});

export const zMemoryCreate = z.object({
  kind: zMemoryKind.default("fact"),
  content: z.string().min(1).max(2000),
  importance: z.number().int().min(1).max(5).default(3),
  subjects: z.array(z.string().max(120)).max(20).default([]),
});
export type MemoryCreate = z.input<typeof zMemoryCreate>;

export const zMemoryUpdate = z.object({
  kind: zMemoryKind.optional(),
  content: z.string().min(1).max(2000).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  subjects: z.array(z.string().max(120)).max(20).optional(),
});
export type MemoryUpdate = z.infer<typeof zMemoryUpdate>;

// ---------------------------------------------------------------------------
// Search & ask
// ---------------------------------------------------------------------------

export const zSearchHitType = z.enum(["memory", "conversation", "utterance"]);
export type SearchHitType = z.infer<typeof zSearchHitType>;

export const zSearchRequest = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(20),
  types: z.array(zSearchHitType).optional(),
  from: zEpochMs.optional(),
  to: zEpochMs.optional(),
});
export type SearchRequest = z.input<typeof zSearchRequest>;

export const zSearchHit = z.object({
  type: zSearchHitType,
  id: zId,
  /** Conversation the hit belongs to (for memories: the source conversation). */
  conversationId: zId.nullable(),
  title: z.string().nullable(),
  snippet: z.string(),
  /** Normalised 0..1, higher is better. */
  score: z.number(),
  atMs: zEpochMs.nullable(),
});
export type SearchHit = z.infer<typeof zSearchHit>;

export const zSearchResponse = z.object({
  hits: z.array(zSearchHit),
  /** "hybrid" when an embedding provider is configured, otherwise "keyword". */
  mode: z.enum(["hybrid", "keyword"]),
});
export type SearchResponse = z.infer<typeof zSearchResponse>;

export const zAskRequest = z.object({
  question: z.string().min(1).max(2000),
  from: zEpochMs.optional(),
  to: zEpochMs.optional(),
});
export type AskRequest = z.infer<typeof zAskRequest>;

export const zAskResponse = z.object({
  answer: z.string(),
  /** The evidence handed to the model, in the order it is cited as [1], [2], … */
  citations: z.array(zSearchHit),
});
export type AskResponse = z.infer<typeof zAskResponse>;

// ---------------------------------------------------------------------------
// Settings: providers (BYOK, local models, CLI subscriptions), privacy, pipeline
// ---------------------------------------------------------------------------

export const zProviderRole = z.enum(["llm", "stt", "embedding"]);
export type ProviderRole = z.infer<typeof zProviderRole>;

export const zProviderKind = z.enum([
  /** Role intentionally disabled. */
  "none",
  /** Anthropic API with the user's own key. Roles: llm. */
  "anthropic",
  /** OpenAI API with the user's own key. Roles: llm, stt, embedding. */
  "openai",
  /**
   * Any server speaking the OpenAI HTTP dialect at `baseUrl` — Ollama, LM Studio, vLLM,
   * llama.cpp, Speaches/faster-whisper, whisper.cpp… This is how local models plug in.
   * Roles: llm, stt, embedding.
   */
  "openai_compatible",
  /**
   * The official Claude Code CLI installed and logged in on the *server host* by its
   * owner (uses that person's Claude subscription). Self-hosted, single-user only. Roles: llm.
   */
  "claude_code_cli",
  /**
   * The official OpenAI Codex CLI installed and logged in ("Sign in with ChatGPT") on the
   * *server host* by its owner. Self-hosted, single-user only. Roles: llm.
   */
  "codex_cli",
]);
export type ProviderKind = z.infer<typeof zProviderKind>;

/** Which kinds are valid for which role. */
export const PROVIDER_KINDS_BY_ROLE: Record<ProviderRole, readonly ProviderKind[]> = {
  llm: ["none", "anthropic", "openai", "openai_compatible", "claude_code_cli", "codex_cli"],
  stt: ["none", "openai", "openai_compatible"],
  embedding: ["none", "openai", "openai_compatible"],
};

/** Kinds that run on infrastructure the user does not control (need `third_party_ai` consent). */
export const THIRD_PARTY_PROVIDER_KINDS: readonly ProviderKind[] = [
  "anthropic",
  "openai",
  "claude_code_cli",
  "codex_cli",
];

/** What the server returns — secrets are never echoed. */
export const zProviderConfig = z.object({
  role: zProviderRole,
  kind: zProviderKind,
  model: z.string().nullable(),
  baseUrl: z.string().nullable(),
  hasApiKey: z.boolean(),
  /** Where the effective config comes from. */
  origin: z.enum(["user", "instance_default", "unset"]),
  /** True when requests leave the user's own infrastructure. */
  thirdParty: z.boolean(),
});
export type ProviderConfig = z.infer<typeof zProviderConfig>;

export const zProviderConfigInput = z.object({
  kind: zProviderKind,
  model: z.string().max(200).nullable().optional(),
  baseUrl: z.url().max(500).nullable().optional(),
  /**
   * Write-only. Omit to keep the stored key, `null` to delete it.
   * Stored encrypted at rest (AES-256-GCM) and never returned by any endpoint.
   */
  apiKey: z.string().min(1).max(1000).nullable().optional(),
});
export type ProviderConfigInput = z.infer<typeof zProviderConfigInput>;

export const zProviderTestResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().nullable(),
});
export type ProviderTestResult = z.infer<typeof zProviderTestResult>;

export const zProviderCatalogEntry = z.object({
  kind: zProviderKind,
  roles: z.array(zProviderRole),
  /** False when the instance operator disabled it or a required binary is missing. */
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  thirdParty: z.boolean(),
  needsApiKey: z.boolean(),
  needsBaseUrl: z.boolean(),
  defaultModels: z.partialRecord(zProviderRole, z.string()).optional(),
});
export const zProviderCatalog = z.object({
  entries: z.array(zProviderCatalogEntry),
  /** Ready-made `openai_compatible` presets for local runtimes. */
  presets: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      role: zProviderRole,
      baseUrl: z.string(),
      model: z.string(),
    }),
  ),
});
export type ProviderCatalog = z.infer<typeof zProviderCatalog>;

export const zPrivacySettings = z.object({
  /** Account-wide kill switch: while true every ingest path answers `ingest_paused`. */
  ingestPaused: z.boolean(),
  /** Keep raw audio after transcription. Default false: audio is deleted once transcribed. */
  retainAudio: z.boolean(),
  /** Only meaningful when `retainAudio` is true. `null` = keep until deleted by hand. */
  audioRetentionDays: z.number().int().min(1).max(3650).nullable(),
  /** Auto-delete transcripts, notes and memories older than this. `null` = keep forever. */
  dataRetentionDays: z.number().int().min(1).max(36500).nullable(),
});
export type PrivacySettings = z.infer<typeof zPrivacySettings>;

export const zPipelineSettings = z.object({
  /** Language hint for STT and the language notes are written in. `null` = auto / follow speech. */
  language: zLanguage.nullable(),
  /** Silence after which a conversation is considered finished. */
  conversationGapMinutes: z.number().int().min(1).max(240),
  /** Extract durable long-term memories from every conversation. */
  extractMemories: z.boolean(),
});
export type PipelineSettings = z.infer<typeof zPipelineSettings>;

export const zSettings = z.object({
  providers: z.object({ llm: zProviderConfig, stt: zProviderConfig, embedding: zProviderConfig }),
  privacy: zPrivacySettings,
  pipeline: zPipelineSettings,
});
export type Settings = z.infer<typeof zSettings>;

// ---------------------------------------------------------------------------
// Data rights
// ---------------------------------------------------------------------------

export const zDeleteDataRequest = z.object({
  /** Delete only data captured before this instant. Omit to delete all captured data. */
  beforeMs: zEpochMs.optional(),
  confirm: z.literal("DELETE"),
});
export type DeleteDataRequest = z.infer<typeof zDeleteDataRequest>;

export const zDeleteAccountRequest = z.object({
  password: z.string().min(1).max(200),
  confirm: z.literal("DELETE"),
});
export type DeleteAccountRequest = z.infer<typeof zDeleteAccountRequest>;

// ---------------------------------------------------------------------------
// Live events (SSE)
// ---------------------------------------------------------------------------

export const zLiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stream_started"), stream: zStreamInfo }),
  z.object({ type: z.literal("stream_ended"), streamId: zUuid }),
  z.object({
    type: z.literal("segment"),
    streamId: zUuid,
    deviceId: zId,
    segment: zTranscriptSegment.extend({ origin: zSegmentOrigin }),
  }),
  z.object({ type: z.literal("conversation_updated"), conversation: zConversationSummary }),
  z.object({ type: z.literal("conversation_deleted"), conversationId: zId }),
  z.object({ type: z.literal("memory_created"), memory: zMemory }),
]);
export type LiveEvent = z.infer<typeof zLiveEvent>;
