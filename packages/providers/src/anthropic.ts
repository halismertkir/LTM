import Anthropic from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import { DEFAULT_MODELS } from "./catalog.js";
import {
  completeJsonViaText,
  parseAgainst,
  repairPrompt,
  toJsonSchema,
  withUsage,
} from "./json.js";
import {
  type LlmJsonRequest,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  ProviderError,
  type ResolvedProviderConfig,
} from "./types.js";
import {
  addUsage,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  redact,
  requireValue,
  truncate,
} from "./util.js";

const PROVIDER = "anthropic" as const;
const API_BASE_URL = "https://api.anthropic.com";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Adaptive thinking spends from max_tokens too; keep room so the visible answer is not cut. */
const THINKING_HEADROOM_TOKENS = 32_000;
const MAX_OUTPUT_TOKENS = 128_000;

type Params = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

/**
 * Request features that not every model accepts. The adapter starts with all of them and
 * drops one when the API rejects it, so a user-chosen model works without the adapter
 * knowing model names.
 */
type Feature = "fallbacks" | "effort" | "thinking";
const FEATURE_ORDER: Feature[] = ["fallbacks", "effort", "thinking"];
const FEATURE_HINTS: Record<Feature, RegExp> = {
  fallbacks: /fallback|anthropic-beta/i,
  effort: /effort/i,
  thinking: /thinking|budget_tokens/i,
};
const FORMAT_HINT = /output_config\.format|json_schema|schema|structured/i;

/** The slice of the SDK client this adapter uses (lets tests inject a fake). */
export interface AnthropicLikeClient {
  beta: {
    messages: {
      stream(
        params: Params,
        options?: { signal?: AbortSignal; timeout?: number },
      ): { finalMessage(): Promise<Message> };
    };
  };
  models: {
    retrieve(
      id: string,
      params?: object,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<unknown>;
  };
}

export interface AnthropicOptions {
  client?: AnthropicLikeClient;
}

export function mapAnthropicError(
  e: unknown,
  apiKey: string | null | undefined,
  timedOut = false,
): ProviderError {
  if (e instanceof ProviderError) return e;
  const msg = (text: string) => truncate(redact(text, [apiKey]), 500);
  if (e instanceof Anthropic.APIUserAbortError) {
    return timedOut
      ? new ProviderError(PROVIDER, "timeout", "request timed out", { cause: e })
      : new ProviderError(PROVIDER, "unknown", "request was aborted", {
          retryable: false,
          cause: e,
        });
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError)
    return new ProviderError(PROVIDER, "timeout", "request timed out", { cause: e });
  if (e instanceof Anthropic.APIConnectionError) {
    return new ProviderError(
      PROVIDER,
      "unavailable",
      `could not reach the Anthropic API: ${msg(e.message)}`,
      { cause: e },
    );
  }
  if (e instanceof Anthropic.AuthenticationError) {
    return new ProviderError(PROVIDER, "auth", "the Anthropic API rejected the API key", {
      cause: e,
    });
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(
      PROVIDER,
      "auth",
      `the API key is not allowed to do this: ${msg(e.message)}`,
      { cause: e },
    );
  }
  if (e instanceof Anthropic.PaymentRequiredError) {
    return new ProviderError(
      PROVIDER,
      "auth",
      `billing problem on the Anthropic account: ${msg(e.message)}`,
      { cause: e },
    );
  }
  if (e instanceof Anthropic.RateLimitError) {
    // A spend-cap 429 does not go away by waiting a few seconds.
    const spendCap = /spend|limit.*month|credit balance/i.test(e.message);
    return new ProviderError(PROVIDER, "rate_limited", msg(e.message), {
      cause: e,
      retryable: !spendCap,
    });
  }
  if (e instanceof Anthropic.NotFoundError) {
    return new ProviderError(
      PROVIDER,
      "not_configured",
      `model or endpoint not found: ${msg(e.message)}`,
      { cause: e },
    );
  }
  if (e instanceof Anthropic.RequestTimeoutError)
    return new ProviderError(PROVIDER, "timeout", "request timed out", { cause: e });
  if (e instanceof Anthropic.InternalServerError) {
    return new ProviderError(
      PROVIDER,
      "unavailable",
      `the Anthropic API is unavailable (${e.status}): ${msg(e.message)}`,
      { cause: e },
    );
  }
  if (e instanceof Anthropic.APIError) {
    return new ProviderError(
      PROVIDER,
      "unknown",
      `Anthropic API error ${e.status ?? ""}: ${msg(e.message)}`,
      { retryable: false, cause: e },
    );
  }
  return new ProviderError(PROVIDER, "unknown", msg(errorMessage(e)), {
    retryable: false,
    cause: e,
  });
}

function textOf(message: Message): string {
  return message.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function usageOf(message: Message): LlmUsage {
  return { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
}

class AnthropicLlm implements LlmProvider {
  readonly kind = PROVIDER;
  readonly model: string;
  private readonly client: AnthropicLikeClient;
  private readonly timeoutMs: number;
  private readonly apiKey: string;
  /** Features the configured model turned out not to accept. */
  private readonly unsupported = new Set<Feature>();
  private formatUnsupported = false;

  constructor(config: ResolvedProviderConfig, options?: AnthropicOptions) {
    this.apiKey = requireValue(PROVIDER, config.apiKey, "an API key");
    this.model = config.model || DEFAULT_MODELS.anthropic.llm!;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Credentials and endpoint are always explicit: this is a per-user BYOK client and
    // must never pick up the server's own ANTHROPIC_* environment. Logging is off so a
    // debug log level can never write prompts or transcripts anywhere.
    this.client =
      options?.client ??
      new Anthropic({
        apiKey: this.apiKey,
        baseURL: config.baseUrl || API_BASE_URL,
        timeout: this.timeoutMs,
        logLevel: "off",
      });
  }

  private params(request: LlmRequest, format: object | null): Params {
    const visible = Math.max(1, request.maxTokens ?? DEFAULT_MAX_TOKENS);
    const thinking = !this.unsupported.has("thinking");
    const params: Params = {
      model: this.model,
      max_tokens: Math.min(
        MAX_OUTPUT_TOKENS,
        thinking ? visible + THINKING_HEADROOM_TOKENS : visible,
      ),
      messages: [{ role: "user", content: request.prompt }],
      stream: true,
    };
    if (request.system) params.system = request.system;
    if (thinking) params.thinking = { type: "adaptive" };
    const outputConfig: NonNullable<Params["output_config"]> = {};
    if (!this.unsupported.has("effort")) outputConfig.effort = "medium";
    if (format) outputConfig.format = format as NonNullable<Params["output_config"]>["format"];
    if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;
    if (!this.unsupported.has("fallbacks")) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = "default";
    }
    return params;
  }

  /** One streamed request; retries without a feature the model rejected. */
  private async send(request: LlmRequest, format: object | null): Promise<Message> {
    for (;;) {
      try {
        const stream = this.client.beta.messages.stream(this.params(request, format), {
          ...(request.signal ? { signal: request.signal } : {}),
          timeout: this.timeoutMs,
        });
        return await stream.finalMessage();
      } catch (e) {
        if (e instanceof Anthropic.BadRequestError) {
          if (format && FORMAT_HINT.test(e.message) && !FEATURE_HINTS.thinking.test(e.message)) {
            this.formatUnsupported = true;
            throw new FormatRejected();
          }
          const active = FEATURE_ORDER.filter((f) => !this.unsupported.has(f));
          const culprit = active.find((f) => FEATURE_HINTS[f].test(e.message)) ?? active[0];
          if (culprit) {
            this.unsupported.add(culprit);
            continue;
          }
        }
        throw mapAnthropicError(e, this.apiKey);
      }
    }
  }

  private check(message: Message, what: string): void {
    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category;
      throw new ProviderError(
        PROVIDER,
        "refused",
        `the model declined the request${category ? ` (${category})` : ""}`,
      );
    }
    if (message.stop_reason === "max_tokens") {
      throw new ProviderError(PROVIDER, "bad_response", `${what} was cut off at max_tokens`, {
        retryable: false,
      });
    }
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const message = await this.send(request, null);
    this.check(message, "the answer");
    return { text: textOf(message), model: message.model, usage: usageOf(message) };
  }

  async completeJson<T>(
    request: LlmJsonRequest<T>,
  ): Promise<{ value: T; model: string; usage?: LlmUsage }> {
    const schema = this.formatUnsupported ? null : toJsonSchema(request.schema);
    let format: object | null = null;
    if (schema) {
      try {
        format = { type: "json_schema", schema: transformJSONSchema(schema) };
      } catch {
        format = null;
      }
    }
    if (!format) return this.viaText(request);

    let usage: LlmUsage | undefined;
    let prompt = request.prompt;
    let problem = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let message: Message;
      try {
        message = await this.send({ ...request, prompt }, format);
      } catch (e) {
        if (e instanceof FormatRejected) return this.viaText(request, usage);
        throw e;
      }
      usage = addUsage(usage, usageOf(message));
      this.check(message, "the JSON answer");
      const text = textOf(message);
      const parsed = parseAgainst(request.schema, text);
      if (parsed.ok) return withUsage({ value: parsed.value, model: message.model }, usage);
      // The API enforces the JSON shape, but constraints it cannot express (lengths,
      // ranges, refinements) are only checked here.
      problem = parsed.problem;
      prompt = repairPrompt(request.prompt, text, problem);
    }
    throw new ProviderError(
      PROVIDER,
      "bad_response",
      `model output did not match "${request.schemaName}": ${truncate(problem, 500)}`,
    );
  }

  private async viaText<T>(request: LlmJsonRequest<T>, usage?: LlmUsage) {
    const res = await completeJsonViaText(
      PROVIDER,
      (system, prompt) => this.complete({ ...request, system, prompt }),
      request,
    );
    return withUsage({ value: res.value, model: res.model }, addUsage(usage, res.usage));
  }

  async probe(signal?: AbortSignal): Promise<void> {
    try {
      await this.client.models.retrieve(
        this.model,
        {},
        { ...(signal ? { signal } : {}), timeout: Math.min(this.timeoutMs, 30_000) },
      );
    } catch (e) {
      throw mapAnthropicError(e, this.apiKey);
    }
  }
}

class FormatRejected extends Error {}

export function createAnthropicLlm(
  config: ResolvedProviderConfig,
  options?: AnthropicOptions,
): LlmProvider & {
  probe(signal?: AbortSignal): Promise<void>;
} {
  return new AnthropicLlm(config, options);
}
