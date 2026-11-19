import { z } from "zod";
import { describeIssues, extractJson, type JsonSchema } from "./json.js";
import {
  type EmbeddingProvider,
  type LlmJsonRequest,
  type LlmProvider,
  type LlmRequest,
  ProviderError,
  type SttProvider,
  type SttRequest,
  type SttResult,
} from "./types.js";
import { wavDurationSec } from "./util.js";

export const MOCK_LLM_MODEL = "mock-llm";
export const MOCK_STT_MODEL = "mock-stt";

function minimalFromJsonSchema(schema: unknown, defs: Record<string, unknown>, depth = 0): unknown {
  if (depth > 32 || !schema || typeof schema !== "object") return null;
  const s = schema as JsonSchema;
  if (typeof s.$ref === "string") {
    const name = s.$ref.replace(/^#\/(\$defs|definitions)\//, "");
    return minimalFromJsonSchema(defs[name], defs, depth + 1);
  }
  if ("default" in s) return s.default;
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  const variants = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants) && variants.length > 0) {
    const nullable = variants.find((v) => (v as JsonSchema)?.type === "null");
    return nullable ? null : minimalFromJsonSchema(variants[0], defs, depth + 1);
  }
  if (Array.isArray(s.allOf) && s.allOf.length > 0) {
    const parts = s.allOf.map((p) => minimalFromJsonSchema(p, defs, depth + 1));
    return parts.every((p) => p && typeof p === "object" && !Array.isArray(p))
      ? Object.assign({}, ...parts)
      : parts[0];
  }
  const type = Array.isArray(s.type) ? (s.type.includes("null") ? "null" : s.type[0]) : s.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      for (const [k, v] of Object.entries(props)) {
        if (required.has(k)) out[k] = minimalFromJsonSchema(v, defs, depth + 1);
      }
      return out;
    }
    case "array": {
      const n = typeof s.minItems === "number" ? s.minItems : 0;
      return Array.from({ length: n }, () => minimalFromJsonSchema(s.items, defs, depth + 1));
    }
    case "string": {
      if (s.format === "date-time") return "1970-01-01T00:00:00.000Z";
      if (s.format === "date") return "1970-01-01";
      if (s.format === "email") return "mock@example.com";
      if (s.format === "uri" || s.format === "url") return "https://example.com/";
      if (s.format === "uuid") return "00000000-0000-4000-8000-000000000000";
      const n = typeof s.minLength === "number" ? s.minLength : 0;
      return "x".repeat(n);
    }
    case "integer":
    case "number": {
      const min =
        typeof s.minimum === "number"
          ? s.minimum
          : typeof s.exclusiveMinimum === "number"
            ? s.exclusiveMinimum + 1
            : 0;
      const max = typeof s.maximum === "number" ? s.maximum : undefined;
      const v = max !== undefined && min > max ? max : min;
      return type === "integer" ? Math.ceil(v) : v;
    }
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return null;
  }
}

/** The smallest value the schema accepts, as far as JSON Schema can tell. */
export function minimalValue(schema: z.ZodType): unknown {
  let js: JsonSchema;
  try {
    js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  } catch {
    return {};
  }
  return minimalFromJsonSchema(js, (js.$defs ?? js.definitions ?? {}) as Record<string, unknown>);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
    return out;
  }
  return over === undefined ? base : over;
}

function defaultReply(request: LlmRequest): string {
  return `mock reply (${request.prompt.length} characters of input)`;
}

/**
 * Deterministic LLM double.
 * - `complete`: the handler's string, or its object as JSON; without a handler a fixed
 *   reply that mentions only the prompt length.
 * - `completeJson`: the handler's value if it validates; otherwise the handler's value
 *   laid over the schema's minimal value; otherwise the minimal value alone. Throws
 *   ProviderError("bad_response") only when even that does not validate (e.g. a refine).
 */
export function createMockLlm(handler?: (request: LlmRequest) => string | object): LlmProvider {
  return {
    kind: "none",
    model: MOCK_LLM_MODEL,
    async complete(request) {
      const out = handler ? handler(request) : defaultReply(request);
      return {
        text: typeof out === "string" ? out : JSON.stringify(out),
        model: MOCK_LLM_MODEL,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    async completeJson<T>(request: LlmJsonRequest<T>) {
      let given: unknown;
      if (handler) {
        const out = handler(request);
        if (typeof out === "string") {
          try {
            given = extractJson(out);
          } catch {
            given = undefined;
          }
        } else {
          given = out;
        }
      }
      if (given !== undefined) {
        const direct = request.schema.safeParse(given);
        if (direct.success)
          return {
            value: direct.data,
            model: MOCK_LLM_MODEL,
            usage: { inputTokens: 0, outputTokens: 0 },
          };
      }
      const candidate =
        given === undefined
          ? minimalValue(request.schema)
          : deepMerge(minimalValue(request.schema), given);
      let res = request.schema.safeParse(candidate);
      if (!res.success && given !== undefined)
        res = request.schema.safeParse(minimalValue(request.schema));
      if (!res.success) {
        throw new ProviderError(
          "none",
          "bad_response",
          `mock could not produce a valid "${request.schemaName}":\n${describeIssues(res.error)}`,
        );
      }
      return { value: res.data, model: MOCK_LLM_MODEL, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

/**
 * Deterministic STT double. With a string list, call n returns entry n (cycling) as one
 * segment spanning the audio (duration read from the WAV header, else 1 s).
 */
export function createMockStt(
  script?: string[] | ((request: SttRequest) => SttResult),
): SttProvider {
  let calls = 0;
  return {
    kind: "none",
    model: MOCK_STT_MODEL,
    async transcribe(request) {
      if (typeof script === "function") return script(request);
      const lines = script && script.length > 0 ? script : ["mock transcript"];
      const text = lines[calls++ % lines.length]!;
      const durationSec = wavDurationSec(request.audio) ?? 1;
      const result: SttResult = {
        text,
        durationSec,
        segments:
          text.trim() === "" ? [] : [{ startSec: 0, endSec: durationSec, text, confidence: 1 }],
      };
      if (request.language) result.language = request.language;
      return result;
    },
  };
}

function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function mockTokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/[İIı]/gu, "i")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Hashed bag-of-words vectors: similar texts → similar vectors (unit length). */
export function createMockEmbedding(dimensions = 384): EmbeddingProvider {
  const dims = Math.max(8, Math.floor(dimensions));
  return {
    kind: "none",
    model: `mock-embedding-${dims}`,
    async embed(texts) {
      return texts.map((text) => {
        const v = new Array<number>(dims).fill(0);
        for (const t of mockTokens(text)) {
          const h = fnv1a(t, 0);
          v[h % dims]! += (fnv1a(t, 1) & 1) === 0 ? 1 : -1;
        }
        const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0));
        return norm === 0 ? v : v.map((x) => x / norm);
      });
    },
  };
}
