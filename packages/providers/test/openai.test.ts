import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createEmbeddingProvider,
  createLlmProvider,
  createSttProvider,
  ProviderError,
  probeProvider,
} from "../src/index.js";
import { normalizeLanguage } from "../src/openai.js";
import { chatReply, sendJson, startServer } from "./helpers.js";

const KEY = "test-key-0123456789abcdef";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function server(handler: Parameters<typeof startServer>[0]) {
  const s = await startServer(handler);
  close = s.close;
  return s;
}

const Notes = z.object({
  title: z.string().min(1),
  items: z.array(z.string()),
  score: z.number().int().optional(),
});

function wav(seconds: number): Uint8Array {
  const data = Math.round(16000 * seconds) * 2;
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  out.set([82, 73, 70, 70], 0);
  v.setUint32(4, 36 + data, true);
  out.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  out.set([100, 97, 116, 97], 36);
  v.setUint32(40, data, true);
  return out;
}

describe("openai_compatible llm", () => {
  it("sends a chat completion and returns text, model and usage", async () => {
    const s = await server((_req, res) =>
      sendJson(res, 200, chatReply("<think>hmm</think>Hello there")),
    );
    const llm = createLlmProvider({
      role: "llm",
      kind: "openai_compatible",
      baseUrl: `${s.url}/v1/`,
      model: "local-model",
      apiKey: KEY,
    });
    const out = await llm.complete({ system: "Be brief.", prompt: "Say hello", maxTokens: 100 });
    expect(out).toEqual({
      text: "Hello there",
      model: "served-model",
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    const req = s.requests[0]!;
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.json).toMatchObject({
      model: "local-model",
      max_tokens: 100,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Say hello" },
      ],
    });
  });

  it("omits the Authorization header when no key is set", async () => {
    const s = await server((_req, res) => sendJson(res, 200, chatReply("ok")));
    const llm = createLlmProvider({
      role: "llm",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "m",
    });
    await llm.complete({ prompt: "x" });
    expect(s.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("maps 401 to auth and never echoes the key", async () => {
    const s = await server((req, res) =>
      sendJson(res, 401, {
        error: { message: `Incorrect API key provided: ${req.headers.authorization}` },
      }),
    );
    const llm = createLlmProvider({
      role: "llm",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "m",
      apiKey: KEY,
    });
    const err = await llm.complete({ prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("auth");
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain("0123456789");
  });

  it("maps 429 to a retryable rate limit, but not an exhausted quota", async () => {
    let quota = false;
    const s = await server((_req, res) =>
      sendJson(res, 429, {
        error: {
          message: quota ? "You exceeded your current quota" : "Slow down",
          code: quota ? "insufficient_quota" : "rate_limit",
        },
      }),
    );
    const llm = createLlmProvider({
      role: "llm",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "m",
    });
    const a = await llm.complete({ prompt: "x" }).catch((e) => e);
    expect([a.code, a.retryable]).toEqual(["rate_limited", true]);
    quota = true;
    const b = await llm.complete({ prompt: "x" }).catch((e) => e);
    expect([b.code, b.retryable]).toEqual(["rate_limited", false]);
  });

  it("maps 5xx, 404, refusals, truncation and unreachable servers", async () => {
    let mode = "500";
    const s = await server((_req, res) => {
      if (mode === "500") return sendJson(res, 503, { error: "overloaded" });
      if (mode === "404")
        return sendJson(res, 404, { error: { message: "model 'nope' not found" } });
      if (mode === "refusal")
        return sendJson(
          res,
          200,
          chatReply("", {
            choices: [{ finish_reason: "stop", message: { content: null, refusal: "no" } }],
          }),
        );
      return sendJson(
        res,
        200,
        chatReply("partial", {
          choices: [{ finish_reason: "length", message: { content: "partial" } }],
        }),
      );
    });
    const llm = createLlmProvider({
      role: "llm",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "m",
    });
    expect((await llm.complete({ prompt: "x" }).catch((e) => e)).code).toBe("unavailable");
    mode = "404";
    expect((await llm.complete({ prompt: "x" }).catch((e) => e)).code).toBe("not_configured");
    mode = "refusal";
    expect((await llm.complete({ prompt: "x" }).catch((e) => e)).code).toBe("refused");
    mode = "length";
    expect((await llm.complete({ prompt: "x" }).catch((e) => e)).code).toBe("bad_response");
    await close!();
    close = undefined;
    const dead = createLlmProvider({
      role: "llm",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "m",
    });
    const err = await dead.complete({ prompt: "x" }).catch((e) => e);
    expect(err.code).toBe("unavailable");
    expect(err.retryable).toBe(true);
  });

  it("times out", async () => {
    const s = await server(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 500));
      sendJson(res, 200, chatReply("late"));
    });
    const llm = createLlmProvider({
      role: "llm",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "m",
      timeoutMs: 50,
    });
    const err = await llm.complete({ prompt: "x" }).catch((e) => e);
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
  });

  it("uses json_schema structured output when accepted", async () => {
    const s = await server((_req, res) =>
      sendJson(res, 200, chatReply('{"title":"T","items":["a"]}')),
    );
    const llm = createLlmProvider({
      role: "llm",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "m",
    });
    const out = await llm.completeJson({
      prompt: "notes please",
      schema: Notes,
      schemaName: "conversation notes",
    });
    expect(out.value).toEqual({ title: "T", items: ["a"] });
    const rf = s.requests[0]!.json.response_format;
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("conversation_notes");
    expect(rf.json_schema.schema.properties.title.type).toBe("string");
    expect(rf.json_schema.strict).toBe(false);
  });

  it("falls back json_schema → json_object → prompt-only when a server rejects them, and remembers", async () => {
    const s = await server((req, res) => {
      const rf = req.json.response_format;
      if (rf?.type === "json_schema")
        return sendJson(res, 400, {
          error: { message: "response_format json_schema is not supported" },
        });
      if (rf?.type === "json_object")
        return sendJson(res, 422, { detail: "unknown field response_format" });
      sendJson(
        res,
        200,
        chatReply('Sure! Here it is:\n```json\n{"title":"From prompt","items":[]}\n```'),
      );
    });
    const llm = createLlmProvider({
      role: "llm",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "m",
    });
    const out = await llm.completeJson({ prompt: "p", schema: Notes, schemaName: "notes" });
    expect(out.value).toEqual({ title: "From prompt", items: [] });
    expect(s.requests.map((r) => r.json.response_format?.type ?? "none")).toEqual([
      "json_schema",
      "json_object",
      "none",
    ]);
    const prompted = s.requests[2]!.json.messages[0].content as string;
    expect(prompted).toContain("JSON");
    await llm.completeJson({ prompt: "p2", schema: Notes, schemaName: "notes" });
    expect(s.requests).toHaveLength(4);
    expect(s.requests[3]!.json.response_format).toBeUndefined();
  });

  it("does not downgrade on an unrelated 400", async () => {
    const s = await server((_req, res) =>
      sendJson(res, 400, { error: { message: "context length exceeded" } }),
    );
    const llm = createLlmProvider({
      role: "llm",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "m",
    });
    const err = await llm
      .completeJson({ prompt: "p", schema: Notes, schemaName: "notes" })
      .catch((e) => e);
    expect(err.code).toBe("bad_response");
    expect(s.requests).toHaveLength(1);
  });

  it("repairs once with the validation error, then gives up", async () => {
    const replies = ['{"title":"","items":"nope"}', '{"title":"Fixed","items":["x"]}'];
    const s = await server((_req, res) => sendJson(res, 200, chatReply(replies.shift() ?? "{}")));
    const llm = createLlmProvider({
      role: "llm",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "m",
    });
    const out = await llm.completeJson({ prompt: "orig", schema: Notes, schemaName: "notes" });
    expect(out.value.title).toBe("Fixed");
    expect(out.usage).toEqual({ inputTokens: 22, outputTokens: 14 });
    const repair = s.requests[1]!.json.messages[1].content as string;
    expect(repair).toContain("orig");
    expect(repair).toContain("title");
    expect(repair).toContain("items");

    const bad = await llm
      .completeJson({ prompt: "orig", schema: Notes, schemaName: "notes" })
      .catch((e) => e);
    expect(bad.code).toBe("bad_response");
  });
});

describe("openai llm", () => {
  it("requires an API key, uses max_completion_tokens and the default model", async () => {
    expect(() => createLlmProvider({ role: "llm", kind: "openai" })).toThrow(/API key/);
    const llm = createLlmProvider({ role: "llm", kind: "openai", apiKey: KEY });
    expect(llm.model).toBeTruthy();
  });
});

describe("openai_compatible stt", () => {
  it("requests verbose_json with segments and maps confidence and language", async () => {
    const s = await server((_req, res) =>
      sendJson(res, 200, {
        text: "merhaba dünya nasılsın",
        language: "turkish",
        duration: 3.2,
        segments: [
          { start: 0, end: 1.5, text: " merhaba dünya", avg_logprob: -0.1, no_speech_prob: 0.01 },
          { start: 1.5, end: 3.2, text: " nasılsın", avg_logprob: -0.5, no_speech_prob: 0.1 },
          { start: 3.2, end: 3.2, text: " Thank you.", avg_logprob: -1.5, no_speech_prob: 0.9 },
        ],
      }),
    );
    const stt = createSttProvider({
      role: "stt",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "whisper-large",
    });
    const out = await stt.transcribe({
      audio: wav(3.2),
      mimeType: "audio/wav",
      language: "tr",
      prompt: "LTM",
    });
    expect(out.language).toBe("tr");
    expect(out.durationSec).toBe(3.2);
    expect(out.segments.map((x) => x.text)).toEqual(["merhaba dünya", "nasılsın"]);
    expect(out.segments[0]!.confidence).toBeCloseTo(Math.exp(-0.1) * 0.99, 5);
    expect(out.text).toBe("merhaba dünya nasılsın");
    const form = s.requests[0]!.form!;
    expect(form.get("model")).toBe("whisper-large");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["segment"]);
    expect(form.get("language")).toBe("tr");
    expect(form.get("prompt")).toBe("LTM");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.wav");
    expect(file.size).toBe(wav(3.2).byteLength);
  });

  it("falls back to json (single segment from the WAV duration), then text, and remembers", async () => {
    const s = await server((req, res) => {
      const fmt = req.form!.get("response_format");
      if (fmt === "verbose_json")
        return sendJson(res, 400, {
          error: { message: "response_format 'verbose_json' is not compatible with this model" },
        });
      sendJson(res, 200, { text: " hello world " });
    });
    const stt = createSttProvider({
      role: "stt",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "m",
    });
    const out = await stt.transcribe({ audio: wav(2), mimeType: "audio/wav" });
    expect(out.segments).toEqual([{ startSec: 0, endSec: 2, text: "hello world" }]);
    expect(out.durationSec).toBe(2);
    await stt.transcribe({ audio: wav(1), mimeType: "audio/wav" });
    expect(s.requests.map((r) => r.form!.get("response_format"))).toEqual([
      "verbose_json",
      "json",
      "json",
    ]);
  });

  it("accepts a plain-text answer", async () => {
    const s = await server((req, res) => {
      if (req.form!.get("response_format") !== "text")
        return sendJson(res, 415, { error: "unsupported" });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("just text\n");
    });
    const stt = createSttProvider({
      role: "stt",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "m",
    });
    const out = await stt.transcribe({ audio: new Uint8Array([1, 2, 3]), mimeType: "audio/mp4" });
    expect(out.text).toBe("just text");
    expect(out.segments).toHaveLength(1);
    expect((s.requests[2]!.form!.get("file") as File).name).toBe("audio.m4a");
  });

  it("normalises language names", () => {
    expect(normalizeLanguage("english")).toBe("en");
    expect(normalizeLanguage("TR")).toBe("tr");
    expect(normalizeLanguage("en-US")).toBe("en-US");
    expect(normalizeLanguage("klingon")).toBeUndefined();
  });
});

describe("openai_compatible embeddings", () => {
  it("batches requests and preserves order even when the server shuffles", async () => {
    const s = await server((req, res) => {
      const input = req.json.input as string[];
      const data = input.map((t, i) => ({
        object: "embedding",
        index: i,
        embedding: [Number(t.split("-")[1] ?? -1), t.length],
      }));
      sendJson(res, 200, { object: "list", model: "e", data: data.reverse() });
    });
    const emb = createEmbeddingProvider({
      role: "embedding",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "e",
    });
    const texts = Array.from({ length: 150 }, (_, i) => `t-${i}`);
    texts[5] = "";
    const out = await emb.embed(texts);
    expect(out).toHaveLength(150);
    expect(out.map((v) => v[0])).toEqual(texts.map((t, i) => (i === 5 ? -1 : i)));
    expect(s.requests.map((r) => r.json.input.length)).toEqual([64, 64, 22]);
    expect(s.requests[0]!.json.input[5]).toBe(" ");
    expect(s.requests[0]!.json.model).toBe("e");
  });

  it("rejects a short answer", async () => {
    const s = await server((_req, res) =>
      sendJson(res, 200, { data: [{ index: 0, embedding: [1] }] }),
    );
    const emb = createEmbeddingProvider({
      role: "embedding",
      kind: "openai_compatible",
      baseUrl: s.url,
      model: "e",
    });
    expect((await emb.embed(["a", "b"]).catch((e) => e)).code).toBe("bad_response");
  });
});

describe("probeProvider (openai dialect)", () => {
  it("reports success with latency and failure without throwing", async () => {
    let ok = true;
    const s = await server((req, res) => {
      if (!ok)
        return sendJson(res, 401, { error: { message: `bad key ${req.headers.authorization}` } });
      if (req.path.endsWith("/embeddings"))
        return sendJson(res, 200, { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] });
      if (req.path.endsWith("/audio/transcriptions")) return sendJson(res, 200, { text: "" });
      sendJson(res, 200, chatReply("OK"));
    });
    const base = { kind: "openai_compatible" as const, baseUrl: s.url, model: "m", apiKey: KEY };
    for (const role of ["llm", "stt", "embedding"] as const) {
      const p = await probeProvider({ ...base, role });
      expect(p.ok, role).toBe(true);
      expect(p.latencyMs).toBeTypeOf("number");
    }
    expect((await probeProvider({ ...base, role: "embedding" })).message).toContain("3 dimensions");
    ok = false;
    const bad = await probeProvider({ ...base, role: "llm" });
    expect(bad.ok).toBe(false);
    expect(bad.latencyMs).toBeNull();
    expect(bad.message).not.toContain(KEY);
    const none = await probeProvider({ role: "stt", kind: "anthropic" });
    expect(none.ok).toBe(false);
  });
});
