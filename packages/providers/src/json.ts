import type { ProviderKind } from "@ltm/protocol";
import { z } from "zod";
import { type LlmJsonRequest, type LlmResult, type LlmUsage, ProviderError } from "./types.js";
import { addUsage, stripReasoning, truncate } from "./util.js";

export type JsonSchema = Record<string, unknown>;

/**
 * JSON Schema of what the model has to *produce* (zod's input side, so fields with
 * defaults stay optional). Returns null when the schema contains something JSON Schema
 * cannot express (transforms to dates, custom refinements …); callers then fall back to
 * prompt-instructed JSON and rely on validation alone.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchema | null {
  try {
    const out = z.toJSONSchema(schema, {
      io: "input",
      reused: "ref",
      unrepresentable: "throw",
    }) as JsonSchema;
    delete out.$schema;
    return out;
  } catch {
    return null;
  }
}

/** Same, but never fails: unrepresentable parts become `{}` (used for prompt text only). */
export function toLooseJsonSchema(schema: z.ZodType): JsonSchema {
  try {
    const out = z.toJSONSchema(schema, {
      io: "input",
      reused: "inline",
      unrepresentable: "any",
    }) as JsonSchema;
    delete out.$schema;
    return out;
  } catch {
    return {};
  }
}

export class JsonExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonExtractError";
  }
}

/** Index just past the bracket that closes the one at `start`, or -1. String-aware. */
function matchBracket(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Pulls the first JSON value out of a model reply: plain JSON, a fenced code block, or
 * JSON surrounded by prose. Prefers objects, because every schema we ask for is one.
 */
export function extractJson(text: string): unknown {
  const body = stripReasoning(text).trim();
  if (body === "") throw new JsonExtractError("the reply was empty");
  try {
    return JSON.parse(body);
  } catch {
    // keep looking
  }
  const fences = body.matchAll(/```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g);
  for (const m of fences) {
    try {
      return JSON.parse(m[1]!.trim());
    } catch {
      // try the next one
    }
  }
  for (const open of ["{", "["]) {
    let from = body.indexOf(open);
    for (let tries = 0; from !== -1 && tries < 20; tries++) {
      const end = matchBracket(body, from);
      if (end !== -1) {
        try {
          return JSON.parse(body.slice(from, end));
        } catch {
          // not JSON after all
        }
      }
      from = body.indexOf(open, from + 1);
    }
  }
  throw new JsonExtractError("the reply contained no JSON value");
}

/** Validation problems, worded for a model to fix; never includes the offending values. */
export function describeIssues(error: z.ZodError): string {
  const lines = error.issues
    .slice(0, 8)
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
  if (error.issues.length > 8) lines.push(`- … and ${error.issues.length - 8} more`);
  return lines.join("\n");
}

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; problem: string };

export function parseAgainst<T>(schema: z.ZodType<T>, text: string): ParseOutcome<T> {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return {
      ok: false,
      problem: `Your reply could not be parsed as JSON (${(e as Error).message}).`,
    };
  }
  const res = schema.safeParse(raw);
  if (res.success) return { ok: true, value: res.data };
  return {
    ok: false,
    problem: `Your JSON did not match the schema:\n${describeIssues(res.error)}`,
  };
}

export function jsonInstructions(schemaName: string, schema: JsonSchema | null): string {
  const parts = [
    `Respond with a single JSON value named "${schemaName}" and nothing else: no prose, no explanation, no code fences.`,
  ];
  if (schema) parts.push(`It must validate against this JSON Schema:\n${JSON.stringify(schema)}`);
  return parts.join("\n");
}

export function repairPrompt(
  originalPrompt: string,
  previousReply: string,
  problem: string,
): string {
  return [
    originalPrompt,
    "",
    "---",
    "Your previous reply was not acceptable.",
    problem,
    "Previous reply (truncated):",
    truncate(previousReply, 4000),
    "",
    "Reply again with only the corrected JSON.",
  ].join("\n");
}

/**
 * completeJson for transports without native structured output: instruct, extract,
 * validate, and give the model one chance to repair with the validation errors.
 */
export async function completeJsonViaText<T>(
  provider: ProviderKind,
  complete: (system: string, prompt: string) => Promise<LlmResult>,
  request: LlmJsonRequest<T>,
): Promise<{ value: T; model: string; usage?: LlmUsage }> {
  const instructions = jsonInstructions(request.schemaName, toLooseJsonSchema(request.schema));
  const system = request.system ? `${request.system}\n\n${instructions}` : instructions;
  let usage: LlmUsage | undefined;
  let prompt = request.prompt;
  let last: ParseOutcome<T> = { ok: false, problem: "" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await complete(system, prompt);
    usage = addUsage(usage, res.usage);
    last = parseAgainst(request.schema, res.text);
    if (last.ok) return withUsage({ value: last.value, model: res.model }, usage);
    prompt = repairPrompt(request.prompt, res.text, last.problem);
  }
  throw new ProviderError(
    provider,
    "bad_response",
    `model output did not match "${request.schemaName}" after one repair attempt: ${truncate(last.ok ? "" : last.problem, 500)}`,
  );
}

export function withUsage<R extends object>(
  r: R,
  usage: LlmUsage | undefined,
): R & { usage?: LlmUsage } {
  return usage ? { ...r, usage } : r;
}
