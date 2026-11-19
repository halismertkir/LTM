import type { ProviderKind } from "@ltm/protocol";
import { DEFAULT_MODELS } from "./catalog.js";
import {
  completeJsonViaText,
  type JsonSchema,
  jsonInstructions,
  parseAgainst,
  repairPrompt,
  toJsonSchema,
  withUsage,
} from "./json.js";
import {
  type EmbeddingProvider,
  type LlmJsonRequest,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  ProviderError,
  type ResolvedProviderConfig,
  type SttProvider,
  type SttRequest,
  type SttResult,
  type SttSegment,
} from "./types.js";
import {
  abortedError,
  addUsage,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  deadline,
  errorMessage,
  redact,
  requireValue,
  stripReasoning,
  truncate,
  wavDurationSec,
} from "./util.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
const EMBEDDING_BATCH = 64;

type Kind = Extract<ProviderKind, "openai" | "openai_compatible">;

interface Dialect {
  kind: Kind;
  baseUrl: string;
  apiKey: string | null;
  timeoutMs: number;
}

function resolveDialect(config: ResolvedProviderConfig): Dialect {
  const kind = config.kind as Kind;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (kind === "openai") {
    return {
      kind,
      baseUrl: OPENAI_BASE_URL,
      apiKey: requireValue(kind, config.apiKey, "an API key"),
      timeoutMs,
    };
  }
  const baseUrl = requireValue(kind, config.baseUrl, "a base URL").replace(/\/+$/, "");
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new ProviderError(kind, "not_configured", "the base URL must be an http(s) URL");
  }
  return { kind, baseUrl, apiKey: config.apiKey || null, timeoutMs };
}

function resolveModel(config: ResolvedProviderConfig, kind: Kind): string {
  const model = config.model || DEFAULT_MODELS[kind][config.role];
  return requireValue(kind, model, "a model name");
}

/** Status of a non-2xx answer, kept so callers can decide to degrade a request. */
export class HttpStatusError extends ProviderError {
  readonly status: number;
  readonly body: string;
  constructor(
    kind: ProviderKind,
    status: number,
    body: string,
    code: ProviderError["code"],
    message: string,
    retryable?: boolean,
  ) {
    super(kind, code, message, retryable === undefined ? undefined : { retryable });
    this.status = status;
    this.body = body;
  }
}

function serverMessage(body: string): string {
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
      detail?: unknown;
    };
    if (typeof j.error === "string") return j.error;
    if (j.error?.message) return j.error.message;
    if (typeof j.message === "string") return j.message;
    if (j.detail !== undefined)
      return typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
  } catch {
    // not JSON
  }
  return body;
}

function statusError(d: Dialect, status: number, body: string): HttpStatusError {
  const detail = truncate(redact(serverMessage(body), [d.apiKey]).replace(/\s+/g, " ").trim(), 300);
  const say = (text: string) => (detail ? `${text}: ${detail}` : text);
  if (status === 401 || status === 403)
    return new HttpStatusError(
      d.kind,
      status,
      body,
      "auth",
      say(`authentication failed (${status})`),
    );
  if (status === 429) {
    const quota = /insufficient_quota|quota|billing/i.test(body);
    return new HttpStatusError(d.kind, status, body, "rate_limited", say("rate limited"), !quota);
  }
  if (status === 404)
    return new HttpStatusError(
      d.kind,
      status,
      body,
      "not_configured",
      say("model or endpoint not found (404)"),
    );
  if (status === 408 || status === 504)
    return new HttpStatusError(
      d.kind,
      status,
      body,
      "timeout",
      say(`upstream timeout (${status})`),
    );
  if (status >= 500)
    return new HttpStatusError(
      d.kind,
      status,
      body,
      "unavailable",
      say(`server error (${status})`),
    );
  return new HttpStatusError(
    d.kind,
    status,
    body,
    "bad_response",
    say(`request rejected (${status})`),
    false,
  );
}

async function http(
  d: Dialect,
  path: string,
  init: { method?: string; json?: unknown; form?: FormData },
  signal?: AbortSignal,
): Promise<unknown> {
  const dl = deadline(d.timeoutMs, signal);
  const headers: Record<string, string> = { accept: "application/json" };
  if (d.apiKey) headers.authorization = `Bearer ${d.apiKey}`;
  let body: string | FormData | undefined;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form) {
    body = init.form;
  }
  let res: Response;
  try {
    res = await fetch(`${d.baseUrl}${path}`, {
      method: init.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: dl.signal,
    });
  } catch (e) {
    dl.dispose();
    if (dl.signal.aborted) throw abortedError(d.kind, dl.timedOut(), d.timeoutMs, e);
    const host = (() => {
      try {
        return new URL(d.baseUrl).host;
      } catch {
        return d.baseUrl;
      }
    })();
    throw new ProviderError(
      d.kind,
      "unavailable",
      `could not reach ${host}: ${truncate(redact(errorMessage((e as Error & { cause?: Error }).cause ?? e), [d.apiKey]), 200)}`,
      { cause: e },
    );
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (dl.signal.aborted) throw abortedError(d.kind, dl.timedOut(), d.timeoutMs, e);
    throw new ProviderError(
      d.kind,
      "unavailable",
      "connection dropped while reading the response",
      { cause: e },
    );
  } finally {
    dl.dispose();
  }
  if (!res.ok) throw statusError(d, res.status, text);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json") || /^\s*[{[]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      if (type.includes("json"))
        throw new ProviderError(d.kind, "bad_response", "the server returned invalid JSON");
    }
  }
  return text;
}

// ------------------------------------------------------------------ LLM

/**
 * Did the server refuse an optional request feature (rather than the request itself)?
 * A 400 has to name the feature; local servers that answer unknown parameters with a
 * 422/415/501, or a 500 (some do), are taken at their word.
 */
function rejectsFormat(e: HttpStatusError, kind: Kind, hint: RegExp): boolean {
  if (e.status === 400 || e.status === 404) return hint.test(e.body);
  if (e.status === 415 || e.status === 422 || e.status === 501) return true;
  return e.status === 500 && kind === "openai_compatible";
}

type JsonMode = "json_schema" | "json_object" | "prompt";

interface ChatResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** OpenAI's strict mode needs every property required and closed objects. */
function strictCompatible(schema: unknown, depth = 0): boolean {
  if (depth > 64 || !schema || typeof schema !== "object") return true;
  const s = schema as JsonSchema;
  if (s.type === "object" || s.properties) {
    const props = Object.keys((s.properties ?? {}) as object);
    const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    if (props.some((p) => !req.has(p)) || s.additionalProperties !== false) return false;
  }
  for (const v of Object.values(s)) {
    if (Array.isArray(v)) {
      if (!v.every((x) => strictCompatible(x, depth + 1))) return false;
    } else if (v && typeof v === "object" && !strictCompatible(v, depth + 1)) return false;
  }
  return true;
}

class OpenAiLlm implements LlmProvider {
  readonly kind: Kind;
  readonly model: string;
  private readonly d: Dialect;
  /** Remembers the best JSON mode the server accepted, so rejections cost one request once. */
  private jsonMode: JsonMode = "json_schema";

  constructor(config: ResolvedProviderConfig) {
    this.d = resolveDialect(config);
    this.kind = this.d.kind;
    this.model = resolveModel({ ...config, role: "llm" }, this.kind);
  }

  private async chat(
    request: LlmRequest,
    responseFormat?: object,
  ): Promise<LlmResult & { finish?: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) messages.push({ role: "system", content: request.system });
    messages.push({ role: "user", content: request.prompt });
    const maxTokens = Math.max(1, request.maxTokens ?? DEFAULT_MAX_TOKENS);
    const body: Record<string, unknown> = { model: this.model, messages };
    // OpenAI's reasoning models reject `max_tokens`; most local servers only know it.
    if (this.kind === "openai") body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
    if (responseFormat) body.response_format = responseFormat;
    const res = (await http(
      this.d,
      "/chat/completions",
      { json: body },
      request.signal,
    )) as ChatResponse;
    const choice = res?.choices?.[0];
    if (!choice?.message)
      throw new ProviderError(this.kind, "bad_response", "the server returned no choices");
    if (choice.message.refusal)
      throw new ProviderError(this.kind, "refused", "the model declined the request");
    if (choice.finish_reason === "content_filter")
      throw new ProviderError(this.kind, "refused", "the answer was blocked by a content filter");
    if (choice.finish_reason === "length") {
      throw new ProviderError(
        this.kind,
        "bad_response",
        "the answer was cut off at the token limit",
        { retryable: false },
      );
    }
    const usage: LlmUsage = {};
    if (typeof res.usage?.prompt_tokens === "number") usage.inputTokens = res.usage.prompt_tokens;
    if (typeof res.usage?.completion_tokens === "number")
      usage.outputTokens = res.usage.completion_tokens;
    return {
      text: stripReasoning(choice.message.content ?? ""),
      model: res.model || this.model,
      ...(Object.keys(usage).length ? { usage } : {}),
    };
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const { finish: _f, ...out } = await this.chat(request);
    return out;
  }

  async completeJson<T>(
    request: LlmJsonRequest<T>,
  ): Promise<{ value: T; model: string; usage?: LlmUsage }> {
    const schema = toJsonSchema(request.schema);
    if (!schema && this.jsonMode === "json_schema")
      return this.jsonWithMode(request, "json_object", null);
    return this.jsonWithMode(request, this.jsonMode, schema);
  }

  private formatFor(mode: JsonMode, name: string, schema: JsonSchema | null): object | undefined {
    if (mode === "json_schema" && schema) {
      const strict = strictCompatible(schema);
      return {
        type: "json_schema",
        json_schema: {
          name: name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "result",
          schema,
          strict,
        },
      };
    }
    if (mode === "json_object") return { type: "json_object" };
    return undefined;
  }

  private async jsonWithMode<T>(
    request: LlmJsonRequest<T>,
    mode: JsonMode,
    schema: JsonSchema | null,
  ): Promise<{ value: T; model: string; usage?: LlmUsage }> {
    if (mode === "prompt") {
      return completeJsonViaText(
        this.kind,
        (system, prompt) => this.complete({ ...request, system, prompt }),
        request,
      );
    }
    // json_object mode needs the word "JSON" in the messages (OpenAI enforces it) and the
    // schema in the prompt; json_schema mode benefits from the instructions too.
    const instructions = jsonInstructions(request.schemaName, schema);
    const system = request.system ? `${request.system}\n\n${instructions}` : instructions;
    let usage: LlmUsage | undefined;
    let prompt = request.prompt;
    let problem = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: LlmResult;
      try {
        res = await this.chat(
          { ...request, system, prompt },
          this.formatFor(mode, request.schemaName, schema),
        );
      } catch (e) {
        // Many local servers reject response_format (or one flavour of it) with a 4xx or
        // a 500; step down once per mode and remember it.
        if (
          e instanceof HttpStatusError &&
          rejectsFormat(e, this.kind, /response_format|json_schema|json_object|schema|structured/i)
        ) {
          const next: JsonMode = mode === "json_schema" ? "json_object" : "prompt";
          this.jsonMode = next;
          const out = await this.jsonWithMode(request, next, schema);
          return withUsage({ value: out.value, model: out.model }, addUsage(usage, out.usage));
        }
        throw e;
      }
      usage = addUsage(usage, res.usage);
      const parsed = parseAgainst(request.schema, res.text);
      if (parsed.ok) return withUsage({ value: parsed.value, model: res.model }, usage);
      problem = parsed.problem;
      prompt = repairPrompt(request.prompt, res.text, problem);
    }
    throw new ProviderError(
      this.kind,
      "bad_response",
      `model output did not match "${request.schemaName}": ${truncate(problem, 500)}`,
    );
  }

  async probe(signal?: AbortSignal): Promise<void> {
    await this.complete({
      prompt: "Reply with the single word OK.",
      maxTokens: 512,
      ...(signal ? { signal } : {}),
    });
  }
}

// ------------------------------------------------------------------ STT

type SttMode = "verbose_json" | "json" | "text";

interface VerboseSegment {
  start?: number;
  end?: number;
  text?: string;
  avg_logprob?: number;
  no_speech_prob?: number;
}

/** Whisper reports languages by English name; the rest of LTM wants BCP-47-ish codes. */
const LANGUAGE_CODES: Record<string, string> = {
  afrikaans: "af",
  arabic: "ar",
  armenian: "hy",
  azerbaijani: "az",
  belarusian: "be",
  bosnian: "bs",
  bulgarian: "bg",
  catalan: "ca",
  chinese: "zh",
  croatian: "hr",
  czech: "cs",
  danish: "da",
  dutch: "nl",
  english: "en",
  estonian: "et",
  finnish: "fi",
  french: "fr",
  galician: "gl",
  german: "de",
  greek: "el",
  hebrew: "he",
  hindi: "hi",
  hungarian: "hu",
  icelandic: "is",
  indonesian: "id",
  italian: "it",
  japanese: "ja",
  kannada: "kn",
  kazakh: "kk",
  korean: "ko",
  latvian: "lv",
  lithuanian: "lt",
  macedonian: "mk",
  malay: "ms",
  marathi: "mr",
  maori: "mi",
  nepali: "ne",
  norwegian: "no",
  persian: "fa",
  polish: "pl",
  portuguese: "pt",
  romanian: "ro",
  russian: "ru",
  serbian: "sr",
  slovak: "sk",
  slovenian: "sl",
  spanish: "es",
  swahili: "sw",
  swedish: "sv",
  tagalog: "tl",
  tamil: "ta",
  thai: "th",
  turkish: "tr",
  ukrainian: "uk",
  urdu: "ur",
  vietnamese: "vi",
  welsh: "cy",
  georgian: "ka",
  kurdish: "ku",
  uzbek: "uz",
  bengali: "bn",
  punjabi: "pa",
  gujarati: "gu",
  telugu: "te",
  malayalam: "ml",
  albanian: "sq",
};

export function normalizeLanguage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const v = value.trim();
  if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v))
    return v.toLowerCase().length <= 3 ? v.toLowerCase() : v;
  return LANGUAGE_CODES[v.toLowerCase()];
}

/** exp(avg_logprob) is the mean per-token probability; discount by the no-speech estimate. */
function confidenceOf(s: VerboseSegment): number | undefined {
  if (typeof s.avg_logprob !== "number") return undefined;
  const p = Math.exp(Math.min(0, s.avg_logprob));
  const speech =
    typeof s.no_speech_prob === "number" ? 1 - Math.min(1, Math.max(0, s.no_speech_prob)) : 1;
  return Math.max(0, Math.min(1, p * speech));
}

function mimeExtension(mime: string): string {
  const m = mime.toLowerCase().split(";")[0]!.trim();
  const table: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/webm": "webm",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "video/mp4": "mp4",
  };
  return table[m] ?? "bin";
}

class OpenAiStt implements SttProvider {
  readonly kind: Kind;
  readonly model: string;
  private readonly d: Dialect;
  private mode: SttMode = "verbose_json";

  constructor(config: ResolvedProviderConfig) {
    this.d = resolveDialect(config);
    this.kind = this.d.kind;
    this.model = resolveModel({ ...config, role: "stt" }, this.kind);
  }

  private form(request: SttRequest, mode: SttMode): FormData {
    const form = new FormData();
    const bytes = new Uint8Array(request.audio.byteLength);
    bytes.set(request.audio);
    form.append(
      "file",
      new Blob([bytes], { type: request.mimeType }),
      `audio.${mimeExtension(request.mimeType)}`,
    );
    form.append("model", this.model);
    form.append("response_format", mode);
    if (mode === "verbose_json") form.append("timestamp_granularities[]", "segment");
    if (request.language) form.append("language", request.language);
    if (request.prompt) form.append("prompt", request.prompt);
    return form;
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    for (;;) {
      const mode = this.mode;
      let raw: unknown;
      try {
        raw = await http(
          this.d,
          "/audio/transcriptions",
          { form: this.form(request, mode) },
          request.signal,
        );
      } catch (e) {
        if (
          e instanceof HttpStatusError &&
          mode !== "text" &&
          rejectsFormat(e, this.kind, /response_format|verbose_json|timestamp|format/i)
        ) {
          this.mode = mode === "verbose_json" ? "json" : "text";
          continue;
        }
        throw e;
      }
      return this.parse(raw, request);
    }
  }

  private parse(raw: unknown, request: SttRequest): SttResult {
    const fallbackDuration = wavDurationSec(request.audio);
    if (typeof raw === "string")
      return this.single(raw.trim(), undefined, fallbackDuration, request.language);
    if (!raw || typeof raw !== "object")
      throw new ProviderError(this.kind, "bad_response", "unexpected transcription response");
    const r = raw as {
      text?: string;
      language?: string;
      duration?: number;
      segments?: VerboseSegment[];
    };
    const durationSec =
      typeof r.duration === "number" && r.duration > 0 ? r.duration : fallbackDuration;
    const language = normalizeLanguage(r.language) ?? request.language;
    if (!Array.isArray(r.segments) || r.segments.length === 0) {
      return this.single((r.text ?? "").trim(), language, durationSec);
    }
    const segments: SttSegment[] = [];
    for (const s of r.segments) {
      const text = (s.text ?? "").trim();
      if (!text) continue;
      // Whisper's own rule for "this was silence": its text is usually a hallucination.
      if ((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1) continue;
      const seg: SttSegment = {
        startSec: Math.max(0, s.start ?? 0),
        endSec: Math.max(s.start ?? 0, s.end ?? s.start ?? 0),
        text,
      };
      const c = confidenceOf(s);
      if (c !== undefined) seg.confidence = c;
      segments.push(seg);
    }
    const out: SttResult = { text: segments.map((s) => s.text).join(" "), segments };
    if (language) out.language = language;
    if (durationSec !== undefined) out.durationSec = durationSec;
    return out;
  }

  private single(
    text: string,
    language: string | undefined,
    durationSec: number | undefined,
    hint?: string,
  ): SttResult {
    const out: SttResult = {
      text,
      segments: text ? [{ startSec: 0, endSec: durationSec ?? 0, text }] : [],
    };
    const lang = language ?? hint;
    if (lang) out.language = lang;
    if (durationSec !== undefined) out.durationSec = durationSec;
    return out;
  }
}

// ------------------------------------------------------------------ Embeddings

class OpenAiEmbedding implements EmbeddingProvider {
  readonly kind: Kind;
  readonly model: string;
  private readonly d: Dialect;

  constructor(config: ResolvedProviderConfig) {
    this.d = resolveDialect(config);
    this.kind = this.d.kind;
    this.model = resolveModel({ ...config, role: "embedding" }, this.kind);
  }

  async embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH) {
      // The API rejects empty strings; a single space embeds as "nothing".
      const batch = texts.slice(i, i + EMBEDDING_BATCH).map((t) => (t.trim() === "" ? " " : t));
      const res = (await http(
        this.d,
        "/embeddings",
        { json: { model: this.model, input: batch, encoding_format: "float" } },
        options?.signal,
      )) as {
        data?: Array<{ index?: number; embedding?: number[] }>;
      };
      const data = res?.data;
      if (!Array.isArray(data) || data.length !== batch.length) {
        throw new ProviderError(
          this.kind,
          "bad_response",
          `expected ${batch.length} embeddings, got ${Array.isArray(data) ? data.length : 0}`,
        );
      }
      const ordered = data.every((x) => typeof x.index === "number")
        ? [...data].sort((a, b) => a.index! - b.index!)
        : data;
      for (const item of ordered) {
        if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
          throw new ProviderError(this.kind, "bad_response", "an embedding was missing or empty");
        }
        out.push(item.embedding);
      }
    }
    return out;
  }
}

export function createOpenAiLlm(
  config: ResolvedProviderConfig,
): LlmProvider & { probe(signal?: AbortSignal): Promise<void> } {
  return new OpenAiLlm(config);
}
export function createOpenAiStt(config: ResolvedProviderConfig): SttProvider {
  return new OpenAiStt(config);
}
export function createOpenAiEmbedding(config: ResolvedProviderConfig): EmbeddingProvider {
  return new OpenAiEmbedding(config);
}
