import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type AnthropicLikeClient, createAnthropicLlm } from "../src/anthropic.js";
import { DEFAULT_MODELS, ProviderError, probeProvider } from "../src/index.js";
import { sendJson, startServer } from "./helpers.js";

const KEY = "test-anthropic-key-abcdef";

type Msg = Anthropic.Beta.Messages.BetaMessage;

function message(text: string, extra: Partial<Msg> = {}): Msg {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "served-model",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text, citations: null },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
    ...extra,
  } as unknown as Msg;
}

function fakeClient(replies: Array<Msg | Error>) {
  const calls: any[] = [];
  const client: AnthropicLikeClient = {
    beta: {
      messages: {
        stream(params, options) {
          calls.push({ params: structuredClone(params), options });
          const next = replies.shift() ?? new Error("no more replies");
          return {
            finalMessage: async () => (next instanceof Error ? Promise.reject(next) : next),
          };
        },
      },
    },
    models: { retrieve: async () => ({}) },
  };
  return { client, calls };
}

const badRequest = (msg: string) =>
  new Anthropic.BadRequestError(
    400,
    { type: "error", error: { type: "invalid_request_error", message: msg } },
    msg,
    new Headers(),
  );

describe("anthropic request shaping", () => {
  it("streams with adaptive thinking, explicit effort, server-side fallbacks and no sampling params", async () => {
    const { client, calls } = fakeClient([message("hi")]);
    const llm = createAnthropicLlm({ role: "llm", kind: "anthropic", apiKey: KEY }, { client });
    expect(llm.model).toBe(DEFAULT_MODELS.anthropic.llm);
    const out = await llm.complete({ system: "sys", prompt: "hello", maxTokens: 1000 });
    expect(out).toEqual({
      text: "hi",
      model: "served-model",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const p = calls[0].params;
    expect(p).toMatchObject({
      model: DEFAULT_MODELS.anthropic.llm,
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      stream: true,
    });
    expect(p.max_tokens).toBe(1000 + 32_000);
    for (const k of ["temperature", "top_p", "top_k", "budget_tokens"])
      expect(p).not.toHaveProperty(k);
    // No prefill: the conversation always ends with the user turn.
    expect(p.messages.at(-1).role).toBe("user");
  });

  it("uses the configured model", async () => {
    const { client, calls } = fakeClient([message("x")]);
    await createAnthropicLlm(
      { role: "llm", kind: "anthropic", apiKey: KEY, model: "custom-model" },
      { client },
    ).complete({ prompt: "p" });
    expect(calls[0].params.model).toBe("custom-model");
  });

  it("maps refusal and max_tokens stop reasons", async () => {
    const { client } = fakeClient([
      message("", {
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: null },
      } as Partial<Msg>),
      message("cut", { stop_reason: "max_tokens" }),
    ]);
    const llm = createAnthropicLlm({ role: "llm", kind: "anthropic", apiKey: KEY }, { client });
    const r = await llm.complete({ prompt: "p" }).catch((e) => e);
    expect(r).toBeInstanceOf(ProviderError);
    expect([r.code, r.retryable]).toEqual(["refused", false]);
    expect(r.message).toContain("cyber");
    expect((await llm.complete({ prompt: "p" }).catch((e) => e)).code).toBe("bad_response");
  });

  it("drops a feature the model rejects and remembers it", async () => {
    const { client, calls } = fakeClient([
      badRequest("fallbacks: not supported for this model"),
      message("a"),
      message("b"),
    ]);
    const llm = createAnthropicLlm({ role: "llm", kind: "anthropic", apiKey: KEY }, { client });
    expect((await llm.complete({ prompt: "p" })).text).toBe("a");
    expect(calls[1].params).not.toHaveProperty("fallbacks");
    expect(calls[1].params).not.toHaveProperty("betas");
    expect(calls[1].params.thinking).toEqual({ type: "adaptive" });
    await llm.complete({ prompt: "p" });
    expect(calls).toHaveLength(3);
    expect(calls[2].params).not.toHaveProperty("fallbacks");
  });

  it("gives up after every optional feature has been dropped", async () => {
    const { client, calls } = fakeClient([
      badRequest("x"),
      badRequest("x"),
      badRequest("x"),
      badRequest("messages: bad"),
    ]);
    const llm = createAnthropicLlm({ role: "llm", kind: "anthropic", apiKey: KEY }, { client });
    const e = await llm.complete({ prompt: "p" }).catch((err) => err);
    expect(e.code).toBe("unknown");
    expect(calls).toHaveLength(4);
    expect(calls[3].params).not.toHaveProperty("thinking");
    expect(calls[3].params.max_tokens).toBe(16_000);
  });

  it("completeJson sends a structured-output JSON schema and validates the result", async () => {
    const schema = z.object({
      title: z.string().min(3),
      tags: z.array(z.enum(["a", "b"])),
      note: z.string().optional(),
    });
    const { client, calls } = fakeClient([
      message('{"title":"ab","tags":["a"]}'),
      message('{"title":"abc","tags":["b"]}'),
    ]);
    const llm = createAnthropicLlm({ role: "llm", kind: "anthropic", apiKey: KEY }, { client });
    const out = await llm.completeJson({ prompt: "p", schema, schemaName: "notes" });
    expect(out.value).toEqual({ title: "abc", tags: ["b"] });
    expect(out.usage).toEqual({ inputTokens: 20, outputTokens: 40 });
    const format = calls[0].params.output_config.format;
    expect(format.type).toBe("json_schema");
    expect(format.schema.additionalProperties).toBe(false);
    expect(format.schema.properties.title.type).toBe("string");
    // Length constraints are not accepted by the API; the SDK moves them out of the schema.
    expect(format.schema.properties.title.minLength).toBeUndefined();
    expect(calls[1].params.messages[0].content).toContain("title");
  });

  it("falls back to prompt-instructed JSON when the schema is rejected or unrepresentable", async () => {
    const schema = z.object({ title: z.string() });
    const { client, calls } = fakeClient([
      badRequest("output_config.format.schema: unsupported keyword"),
      message('Here: {"title":"t"}'),
      message('{"title":"u"}'),
    ]);
    const llm = createAnthropicLlm({ role: "llm", kind: "anthropic", apiKey: KEY }, { client });
    expect((await llm.completeJson({ prompt: "p", schema, schemaName: "n" })).value).toEqual({
      title: "t",
    });
    expect(calls[1].params.output_config?.format).toBeUndefined();
    expect(calls[1].params.system).toContain("JSON");
    expect(calls[1].params).toHaveProperty("fallbacks");
    // Remembered: the next call goes straight to the prompt path.
    await llm.completeJson({ prompt: "p", schema, schemaName: "n" });
    expect(calls[2].params.output_config?.format).toBeUndefined();

    const weird = z.object({ when: z.date() });
    const f = fakeClient([
      message('{"when":"2020-01-01"}'),
      message('{"when":"still not a Date"}'),
    ]);
    const llm2 = createAnthropicLlm(
      { role: "llm", kind: "anthropic", apiKey: KEY },
      { client: f.client },
    );
    const e = await llm2
      .completeJson({ prompt: "p", schema: weird, schemaName: "n" })
      .catch((err) => err);
    expect(f.calls[0].params.output_config?.format).toBeUndefined();
    expect(f.calls).toHaveLength(2);
    expect(e.code).toBe("bad_response");
  });

  it("maps SDK error classes", async () => {
    const h = new Headers();
    const cases: Array<[Error, string, boolean]> = [
      [new Anthropic.AuthenticationError(401, {}, `invalid x-api-key: ${KEY}`, h), "auth", false],
      [new Anthropic.RateLimitError(429, {}, "rate limited", h), "rate_limited", true],
      [new Anthropic.InternalServerError(529, {}, "overloaded", h), "unavailable", true],
      [new Anthropic.NotFoundError(404, {}, "model: nope", h), "not_configured", false],
      [new Anthropic.APIConnectionTimeoutError(), "timeout", true],
      [new Anthropic.APIConnectionError({ message: "ECONNREFUSED" }), "unavailable", true],
    ];
    for (const [err, code, retryable] of cases) {
      const { client } = fakeClient([err]);
      const e = await createAnthropicLlm(
        { role: "llm", kind: "anthropic", apiKey: KEY },
        { client },
      )
        .complete({ prompt: "p" })
        .catch((x) => x);
      expect([e.code, e.retryable], err.constructor.name).toEqual([code, retryable]);
      expect(e.message).not.toContain(KEY);
    }
  });

  it("requires an API key", () => {
    expect(() => createAnthropicLlm({ role: "llm", kind: "anthropic" })).toThrow(ProviderError);
  });
});

describe("anthropic through the real SDK against a local server", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  function sse(res: import("node:http").ServerResponse, text: string) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (type: string, data: object) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", {
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "served-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const part of [text.slice(0, 3), text.slice(3)])
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: part } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 9 },
    });
    ev("message_stop", {});
    res.end();
  }

  it("streams a completion, sends the key and beta header, and maps 401/429", async () => {
    let status = 200;
    const s = await startServer((req, res) => {
      if (status === 401)
        return sendJson(res, 401, {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        });
      if (status === 429)
        return sendJson(
          res,
          429,
          { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
          { "x-should-retry": "false" },
        );
      if (req.path.startsWith("/v1/models/")) return sendJson(res, 200, { id: "m", type: "model" });
      sse(res, '{"title":"streamed"}');
    });
    close = s.close;
    const llm = createAnthropicLlm({ role: "llm", kind: "anthropic", apiKey: KEY, baseUrl: s.url });
    const out = await llm.completeJson({
      prompt: "p",
      schema: z.object({ title: z.string() }),
      schemaName: "n",
    });
    expect(out).toEqual({
      value: { title: "streamed" },
      model: "served-model",
      usage: { inputTokens: 5, outputTokens: 9 },
    });
    const req = s.requests[0]!;
    expect(req.path).toMatch(/^\/v1\/messages/);
    expect(req.headers.authorization ?? req.headers["x-api-key"]).toMatch(new RegExp(`${KEY}$`));
    expect(String(req.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(req.json.stream).toBe(true);
    expect(req.json.output_config.format.type).toBe("json_schema");

    const probe = await probeProvider({
      role: "llm",
      kind: "anthropic",
      apiKey: KEY,
      baseUrl: s.url,
    });
    expect(probe.ok).toBe(true);

    status = 401;
    const e = await llm.complete({ prompt: "p" }).catch((x) => x);
    expect(e.code).toBe("auth");
    status = 429;
    const r = await llm.complete({ prompt: "p" }).catch((x) => x);
    expect(r.code).toBe("rate_limited");
    expect(r.retryable).toBe(true);
  });
});
