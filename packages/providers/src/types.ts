import type { ProviderKind, ProviderRole } from "@ltm/protocol";
import type { z } from "zod";

/** Fully resolved configuration for one role (secrets already decrypted). */
export interface ResolvedProviderConfig {
  role: ProviderRole;
  kind: ProviderKind;
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  /** Per-request timeout. Default 120 000. */
  timeoutMs?: number;
}

export type ProviderErrorCode =
  | "not_configured"
  | "auth"
  | "rate_limited"
  | "refused"
  | "timeout"
  | "bad_response"
  | "unavailable"
  | "unknown";

/** Every adapter failure is normalised to this. `retryable` drives job back-off. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly provider: ProviderKind;
  constructor(
    provider: ProviderKind,
    code: ProviderErrorCode,
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.retryable =
      options?.retryable ??
      (code === "rate_limited" || code === "timeout" || code === "unavailable");
  }
}

// ------------------------------------------------------------------ LLM

export interface LlmRequest {
  system?: string;
  prompt: string;
  /** Upper bound for the visible answer. Default 16 000. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmJsonRequest<T> extends LlmRequest {
  /** Zod schema of the expected object. Adapters use native structured output where available. */
  schema: z.ZodType<T>;
  /** Short identifier, e.g. "conversation_notes". */
  schemaName: string;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmResult {
  text: string;
  model: string;
  usage?: LlmUsage;
}

export interface LlmProvider {
  readonly kind: ProviderKind;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResult>;
  /** Returns a value that has been validated against `schema` (retries once on invalid output). */
  completeJson<T>(
    request: LlmJsonRequest<T>,
  ): Promise<{ value: T; model: string; usage?: LlmUsage }>;
}

// ------------------------------------------------------------------ STT

export interface SttRequest {
  audio: Uint8Array;
  /** e.g. "audio/wav", "audio/mp4". */
  mimeType: string;
  /** Language hint; omit for auto-detection. */
  language?: string;
  /** Vocabulary/context hint (names, jargon). */
  prompt?: string;
  signal?: AbortSignal;
}

export interface SttSegment {
  /** Seconds from the start of the submitted audio. */
  startSec: number;
  endSec: number;
  text: string;
  /** 0..1 when the engine exposes something usable. */
  confidence?: number;
}

export interface SttResult {
  text: string;
  language?: string;
  durationSec?: number;
  /** May be a single segment covering everything when the engine has no timestamps. */
  segments: SttSegment[];
}

export interface SttProvider {
  readonly kind: ProviderKind;
  readonly model: string;
  transcribe(request: SttRequest): Promise<SttResult>;
}

// ------------------------------------------------------------------ Embeddings

export interface EmbeddingProvider {
  readonly kind: ProviderKind;
  /** Stored next to every vector; vectors of different models are never compared. */
  readonly model: string;
  embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}

// ------------------------------------------------------------------ Health

export interface ProviderProbe {
  ok: boolean;
  message: string;
  latencyMs: number | null;
}
