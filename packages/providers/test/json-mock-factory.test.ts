import { zProviderCatalog } from "@ltm/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildProviderCatalog,
  createEmbeddingProvider,
  createLlmProvider,
  createMockEmbedding,
  createMockLlm,
  createMockStt,
  createSttProvider,
  DEFAULT_MODELS,
  LOCAL_PRESETS,
  ProviderError,
} from "../src/index.js";
import { completeJsonViaText, extractJson, toJsonSchema } from "../src/json.js";
import { minimalValue } from "../src/mock.js";
import { redact } from "../src/util.js";

describe("extractJson", () => {
  it("parses plain JSON, fences, and JSON inside prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(
      extractJson(
        'Sure! Here is the result:\n\n{"a": {"b": "x } y"}, "c": [1, 2]}\nHope that helps.',
      ),
    ).toEqual({ a: { b: "x } y" }, c: [1, 2] });
    expect(extractJson('<think>{"not": "this"}</think>\n{"a":3}')).toEqual({ a: 3 });
    expect(extractJson('note {broken} then {"a":4}')).toEqual({ a: 4 });
    expect(extractJson("[1,2]")).toEqual([1, 2]);
  });

  it("throws when there is no JSON", () => {
    expect(() => extractJson("")).toThrow();
    expect(() => extractJson("no json here")).toThrow();
    expect(() => extractJson('{"a": ')).toThrow();
  });
});

describe("completeJsonViaText", () => {
  const schema = z.object({ title: z.string(), n: z.number().int().min(1) });

  it("validates, repairs once with the error, and sums usage", async () => {
    const seen: Array<{ system: string; prompt: string }> = [];
    const replies = ['{"title":"x","n":0}', '{"title":"x","n":2}'];
    const out = await completeJsonViaText(
      "openai_compatible",
      async (system, prompt) => {
        seen.push({ system, prompt });
        return { text: replies.shift()!, model: "m", usage: { inputTokens: 1, outputTokens: 2 } };
      },
      { system: "base", prompt: "do it", schema, schemaName: "thing" },
    );
    expect(out).toEqual({
      value: { title: "x", n: 2 },
      model: "m",
      usage: { inputTokens: 2, outputTokens: 4 },
    });
    expect(seen[0]!.system).toMatch(/^base\n\n/);
    expect(seen[0]!.system).toContain('"thing"');
    expect(seen[0]!.system).toContain('"n"');
    expect(seen[1]!.prompt).toContain("do it");
    expect(seen[1]!.prompt).toContain("n:");
    expect(seen[1]!.prompt).toContain('{"title":"x","n":0}');
  });

  it("fails with bad_response after the repair attempt", async () => {
    let calls = 0;
    const err = await completeJsonViaText(
      "codex_cli",
      async () => {
        calls++;
        return { text: "I cannot do that", model: "m" };
      },
      { prompt: "p", schema, schemaName: "thing" },
    ).catch((e) => e);
    expect(calls).toBe(2);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("bad_response");
  });

  it("toJsonSchema returns null for unrepresentable schemas", () => {
    expect(toJsonSchema(z.object({ a: z.string() }))).toMatchObject({ type: "object" });
    expect(toJsonSchema(z.object({ d: z.date() }))).toBeNull();
  });
});

describe("redact", () => {
  it("removes keys and auth headers", () => {
    const key = "abcd1234efgh5678";
    const text = `Authorization: Bearer ${key} and x-api-key: other-secret-value, api_key="third" sk-proj-abcdefghijklmnop`;
    const out = redact(text, [key]);
    expect(out).not.toContain(key);
    expect(out).not.toContain("other-secret-value");
    expect(out).not.toContain("third");
    expect(out).not.toContain("sk-proj-abcdefghijklmnop");
    expect(out).toContain("[redacted]");
  });
});

describe("mocks", () => {
  const Notes = z.object({
    title: z.string().min(2),
    summary: z.string(),
    importance: z.number().int().min(1).max(5),
    tags: z.array(z.string()),
    kind: z.enum(["fact", "idea"]),
    when: z.string().nullable(),
    extra: z.string().optional(),
    nested: z.object({ ok: z.boolean() }),
  });

  it("derives a minimal valid value", () => {
    const v = minimalValue(Notes);
    expect(Notes.safeParse(v).success).toBe(true);
    expect(v).toEqual({
      title: "xx",
      summary: "",
      importance: 1,
      tags: [],
      kind: "fact",
      when: null,
      nested: { ok: false },
    });
  });

  it("completeJson returns the handler value when valid, otherwise merges it over the minimal value", async () => {
    const valid = {
      title: "Hi",
      summary: "s",
      importance: 3,
      tags: ["a"],
      kind: "idea",
      when: null,
      nested: { ok: true },
    };
    const llm = createMockLlm((req) => (req.prompt === "valid" ? valid : { summary: "only this" }));
    expect(
      (await llm.completeJson({ prompt: "valid", schema: Notes, schemaName: "n" })).value,
    ).toEqual(valid);
    const merged = await llm.completeJson({ prompt: "partial", schema: Notes, schemaName: "n" });
    expect(merged.value.summary).toBe("only this");
    expect(merged.value.importance).toBe(1);
    const plain = await createMockLlm().completeJson({
      prompt: "x",
      schema: Notes,
      schemaName: "n",
    });
    expect(Notes.safeParse(plain.value).success).toBe(true);
    const str = await createMockLlm(() => 'text {"title":"From string"}').completeJson({
      prompt: "x",
      schema: Notes,
      schemaName: "n",
    });
    expect(str.value.title).toBe("From string");
  });

  it("complete is deterministic", async () => {
    const llm = createMockLlm();
    const a = await llm.complete({ prompt: "abc" });
    expect(a).toEqual(await llm.complete({ prompt: "abc" }));
    expect((await createMockLlm(() => ({ a: 1 })).complete({ prompt: "x" })).text).toBe('{"a":1}');
  });

  it("mock STT cycles its script", async () => {
    const stt = createMockStt(["one", "two"]);
    const audio = new Uint8Array(10);
    expect((await stt.transcribe({ audio, mimeType: "audio/wav" })).text).toBe("one");
    expect((await stt.transcribe({ audio, mimeType: "audio/wav" })).text).toBe("two");
    const third = await stt.transcribe({ audio, mimeType: "audio/wav", language: "tr" });
    expect(third).toMatchObject({
      text: "one",
      language: "tr",
      segments: [{ startSec: 0, endSec: 1, text: "one" }],
    });
  });

  it("mock embeddings: deterministic unit vectors, similar texts closer", async () => {
    const emb = createMockEmbedding(64);
    const [a, b, c, d] = await emb.embed([
      "the cat sat on the mat",
      "the cat sat on a mat",
      "quarterly budget review",
      "",
    ]);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(a).toHaveLength(64);
    expect(dot(a!, a!)).toBeCloseTo(1);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
    expect(d!.every((x) => x === 0)).toBe(true);
    expect(await emb.embed(["İstanbul"])).toEqual(await emb.embed(["istanbul"]));
    expect(emb.model).toBe("mock-embedding-64");
  });
});

describe("factory and catalog", () => {
  it("throws not_configured for none and for kinds that do not serve the role", () => {
    for (const fn of [
      () => createLlmProvider({ role: "llm", kind: "none" }),
      () => createSttProvider({ role: "stt", kind: "anthropic", apiKey: "k" }),
      () => createEmbeddingProvider({ role: "embedding", kind: "claude_code_cli" }),
      () => createLlmProvider({ role: "llm", kind: "openai_compatible" }),
      () =>
        createSttProvider({
          role: "stt",
          kind: "openai_compatible",
          baseUrl: "http://localhost:1/v1",
        }),
      () =>
        createLlmProvider({
          role: "llm",
          kind: "openai_compatible",
          baseUrl: "ftp://x",
          model: "m",
        }),
    ]) {
      let err: unknown;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe("not_configured");
    }
  });

  it("creates every adapter kind", () => {
    expect(createLlmProvider({ role: "llm", kind: "anthropic", apiKey: "k" }).kind).toBe(
      "anthropic",
    );
    expect(createLlmProvider({ role: "llm", kind: "openai", apiKey: "k" }).model).toBe(
      DEFAULT_MODELS.openai.llm,
    );
    expect(createLlmProvider({ role: "llm", kind: "claude_code_cli" }).kind).toBe(
      "claude_code_cli",
    );
    expect(createLlmProvider({ role: "llm", kind: "codex_cli" }).kind).toBe("codex_cli");
    expect(createSttProvider({ role: "stt", kind: "openai", apiKey: "k" }).model).toBe(
      DEFAULT_MODELS.openai.stt,
    );
    expect(createEmbeddingProvider({ role: "embedding", kind: "openai", apiKey: "k" }).model).toBe(
      DEFAULT_MODELS.openai.embedding,
    );
  });

  it("builds a catalog that validates against the protocol schema", async () => {
    const catalog = await buildProviderCatalog({ pathEnv: "" });
    expect(zProviderCatalog.safeParse(catalog).success).toBe(true);
    expect(catalog.presets).toBe(LOCAL_PRESETS);
    const openai = catalog.entries.find((e) => e.kind === "openai")!;
    expect(openai).toMatchObject({
      roles: ["llm", "stt", "embedding"],
      needsApiKey: true,
      needsBaseUrl: false,
      thirdParty: true,
    });
    const compat = catalog.entries.find((e) => e.kind === "openai_compatible")!;
    expect(compat).toMatchObject({ needsApiKey: false, needsBaseUrl: true, thirdParty: false });
    expect(catalog.entries.find((e) => e.kind === "anthropic")!.roles).toEqual(["llm"]);
  });
});
