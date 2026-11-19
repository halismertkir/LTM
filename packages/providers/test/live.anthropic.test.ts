import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlmProvider } from "../src/index.js";

// Costs real money: runs only when ANTHROPIC_API_KEY is set in the test process.
const key = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!key)("anthropic (live)", () => {
  it("returns a schema-valid object via completeJson", async () => {
    const llm = createLlmProvider({
      role: "llm",
      kind: "anthropic",
      apiKey: key!,
      timeoutMs: 120_000,
    });
    const schema = z.object({ city: z.string(), country: z.string() });
    const out = await llm.completeJson({
      prompt: "Which city is the capital of Turkey? Answer with the city and the country.",
      schema,
      schemaName: "capital",
      maxTokens: 200,
    });
    expect(schema.safeParse(out.value).success).toBe(true);
    expect(out.value.city.toLowerCase()).toContain("ankara");
    expect(out.model).toBeTruthy();
    // The full request (adaptive thinking, effort, server-side fallbacks, structured
    // output) was accepted as sent, not degraded by the adapter's retry ladder.
    const internals = llm as unknown as { unsupported: Set<string>; formatUnsupported: boolean };
    expect([...internals.unsupported]).toEqual([]);
    expect(internals.formatUnsupported).toBe(false);
  }, 180_000);
});
