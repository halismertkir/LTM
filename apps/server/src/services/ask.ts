import type { AskRequest, AskResponse, SearchHit } from "@ltm/protocol";
import type { Ctx } from "../context.js";
import { ApiError, isProviderError } from "../errors.js";
import { askSystemPrompt } from "../pipeline/prompts.js";
import { search } from "./search.js";
import { resolveProviders } from "./settings.js";

const EVIDENCE = 12;

const LABEL: Record<SearchHit["type"], string> = {
  memory: "stored memory",
  conversation: "conversation summary",
  utterance: "transcript excerpt",
};

/** A transcript hit is more useful with the lines around it. */
async function expand(ctx: Ctx, userId: string, hit: SearchHit): Promise<string> {
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

export async function ask(
  ctx: Ctx,
  user: { id: string; role: "owner" | "member" },
  req: AskRequest,
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
  const prompt = `<question>\n${req.question}\n</question>\n\n<evidence>\n${blocks.length ? blocks.join("\n\n") : "(no evidence found)"}\n</evidence>`;
  try {
    const res = await llm.complete({ system: askSystemPrompt(), prompt, maxTokens: 2000 });
    return { answer: res.text.trim(), citations: hits };
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
