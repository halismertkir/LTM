import type { AskRequest, AskResponse, SearchHit } from "@ltm/protocol";
import type { Ctx } from "../context.js";
import { ApiError, isProviderError } from "../errors.js";
import { languageName } from "../pipeline/language.js";
import { askSystemPrompt } from "../pipeline/prompts.js";
import { search } from "./search.js";
import { resolveProviders } from "./settings.js";

const EVIDENCE = 12;

const LABEL: Record<SearchHit["type"], string> = {
  memory: "stored memory",
  conversation: "conversation summary",
  utterance: "transcript excerpt",
};

/**
 * Search snippets are cut for display. The model gets more: the whole summary for a
 * conversation hit, and the surrounding lines for a transcript hit.
 */
async function expand(ctx: Ctx, userId: string, hit: SearchHit): Promise<string> {
  if (hit.type === "conversation") {
    const rows = await ctx.db.query<{ summary: string | null }>(
      "SELECT summary FROM conversations WHERE id = $1 AND user_id = $2",
      [hit.id, userId],
    );
    return rows[0]?.summary?.slice(0, 3000) || hit.snippet;
  }
  if (hit.type !== "utterance" || !hit.conversationId) return hit.snippet;
  const rows = await ctx.db.query<{ text: string; speaker: string }>(
    `WITH target AS (SELECT start_ms FROM utterances WHERE id = $1 AND user_id = $2)
     SELECT text, speaker FROM (
       (SELECT u.text, u.speaker, u.start_ms FROM utterances u, target t
         WHERE u.conversation_id = $3 AND u.start_ms < t.start_ms ORDER BY u.start_ms DESC LIMIT 2)
       UNION ALL
       (SELECT u.text, u.speaker, u.start_ms FROM utterances u, target t
         WHERE u.conversation_id = $3 AND u.start_ms >= t.start_ms ORDER BY u.start_ms LIMIT 4)
     ) x ORDER BY start_ms`,
    [hit.id, userId, hit.conversationId],
  );
  if (rows.length === 0) return hit.snippet;
  return rows
    .map((r) => `(${r.speaker}) ${r.text}`)
    .join("\n")
    .slice(0, 1500);
}

/**
 * Tidies citation markers: drops numbers that are not in the evidence list and collapses a
 * marker repeated right after itself ("… 15% [3]. [3]" → "… 15% [3].").
 */
export function cleanCitations(answer: string, evidenceCount: number): string {
  let out = answer.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_m, list: string) => {
    const nums = [...new Set(list.split(",").map((n) => Number(n.trim())))].filter(
      (n) => Number.isInteger(n) && n >= 1 && n <= evidenceCount,
    );
    return nums.length ? `[${nums.join(", ")}]` : "";
  });
  // "[3] [3]", "[3][3]", "[3]. [3]" → "[3]" (keeping the punctuation in between).
  for (let i = 0; i < 3; i++) out = out.replace(/(\[[\d, ]+\])([.,;:]?)\s*\1/g, "$1$2");
  return out
    .replace(/[ \t]+([.,;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export async function ask(
  ctx: Ctx,
  user: { id: string; role: "owner" | "member"; locale?: string },
  req: AskRequest,
  signal?: AbortSignal,
): Promise<AskResponse> {
  const { llm, embedding } = await resolveProviders(ctx, user, ["llm", "embedding"]);
  if (!llm)
    throw new ApiError(
      409,
      "provider_not_configured",
      "No language model is configured. Configure one in Settings → Providers.",
    );
  const { hits } = await search(ctx, user.id, embedding, {
    query: req.question,
    limit: EVIDENCE,
    from: req.from,
    to: req.to,
  });
  const blocks: string[] = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const when =
      h.atMs !== null
        ? new Date(h.atMs).toISOString().slice(0, 16).replace("T", " ")
        : "unknown time";
    const title = h.title ? `, "${h.title.replace(/"/g, "'")}"` : "";
    blocks.push(
      `[${i + 1}] ${LABEL[h.type]}, ${when} UTC${title}\n${await expand(ctx, user.id, h)}`,
    );
  }
  // Small models ignore "answer in the language of the question" unless reminded at the end.
  const likely = languageName(user.locale ?? "en");
  const prompt = `<question>\n${req.question}\n</question>\n\n<evidence>\n${blocks.length ? blocks.join("\n\n") : "(no evidence found)"}\n</evidence>\n\nThe question is most likely in ${likely}; answer in the language the question is written in.`;
  try {
    const res = await llm.complete({
      system: askSystemPrompt(),
      prompt,
      maxTokens: 2000,
      ...(signal ? { signal } : {}),
    });
    return { answer: cleanCitations(res.text, hits.length), citations: hits };
  } catch (err) {
    if (isProviderError(err)) {
      throw new ApiError(
        502,
        "provider_error",
        `The language model failed (${err.provider}: ${err.code}).`,
      );
    }
    throw err;
  }
}
