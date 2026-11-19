import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "@ltm/providers";
import type { Ctx } from "../context.js";
import { sha256Hex } from "../crypto.js";
import { type Queryable, vectorLiteral } from "../db/types.js";
import type { ConversationRow, UtteranceRow } from "../services/conversations.js";
import { scheduleEmbed } from "../services/memories.js";
import { resolveProvidersForUser } from "../services/settings.js";
import type { JobHandler } from "./worker.js";

/** Utterances per embedded transcript window, and how many consecutive windows share. */
export const WINDOW_SIZE = 4;
const WINDOW_STRIDE = 3;
const BATCH = 64;
const MAX_MEMORIES_PER_RUN = 256;
const MAX_CONVERSATIONS_PER_RUN = 10;

interface Item {
  ownerType: "memory" | "conversation" | "utterance";
  ownerId: string;
  memoryId: string | null;
  conversationId: string | null;
  text: string;
  atMs: number | null;
}

async function embedAll(
  provider: EmbeddingProvider,
  texts: string[],
  signal: AbortSignal,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await provider.embed(texts.slice(i, i + BATCH), { signal })));
  }
  return out;
}

async function insertItems(
  ctx: Ctx,
  q: Queryable,
  userId: string,
  model: string,
  items: Item[],
  vectors: number[][],
): Promise<void> {
  const now = ctx.clock.now();
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const v = vectors[i];
    if (!v || v.length === 0) continue;
    await q.query(
      `INSERT INTO embeddings (id, user_id, owner_type, owner_id, memory_id, conversation_id, model, dims, text_hash, snippet, at_ms, embedding, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector, $13)`,
      [
        randomUUID(),
        userId,
        it.ownerType,
        it.ownerId,
        it.memoryId,
        it.conversationId,
        model,
        v.length,
        sha256Hex(it.text),
        it.text.slice(0, 500),
        it.atMs,
        vectorLiteral(v),
        now,
      ],
    );
  }
}

/** Utterance windows of a conversation: a few consecutive lines per vector, overlapping by one. */
export function utteranceWindows(
  utterances: Pick<UtteranceRow, "id" | "text" | "start_ms">[],
): { id: string; text: string; atMs: number }[] {
  const out: { id: string; text: string; atMs: number }[] = [];
  for (let i = 0; i < utterances.length; i += WINDOW_STRIDE) {
    const w = utterances.slice(i, i + WINDOW_SIZE);
    if (w.length === 0) break;
    out.push({ id: w[0]!.id, text: w.map((u) => u.text).join(" "), atMs: w[0]!.start_ms });
    if (i + WINDOW_SIZE >= utterances.length) break;
  }
  return out;
}

export async function runEmbed(ctx: Ctx, userId: string, signal: AbortSignal): Promise<void> {
  const { embedding } = await resolveProvidersForUser(ctx, userId, ["embedding"]);
  if (!embedding) return;
  const model = embedding.model;

  // Memories whose current text has no vector for the current model.
  const memories = await ctx.db.query<{ id: string; content: string; created_at: number }>(
    `SELECT m.id, m.content, m.created_at FROM memories m
      WHERE m.user_id = $1 AND NOT EXISTS (
        SELECT 1 FROM embeddings e WHERE e.memory_id = m.id AND e.model = $2 AND e.text_hash = encode(sha256(convert_to(m.content, 'UTF8')), 'hex'))
      ORDER BY m.created_at LIMIT $3`,
    [userId, model, MAX_MEMORIES_PER_RUN],
  );
  if (memories.length > 0) {
    const items: Item[] = memories.map((m) => ({
      ownerType: "memory",
      ownerId: m.id,
      memoryId: m.id,
      conversationId: null,
      text: m.content,
      atMs: null,
    }));
    const vectors = await embedAll(
      embedding,
      items.map((i) => i.text),
      signal,
    );
    await ctx.db.tx(async (q) => {
      await q.query("DELETE FROM embeddings WHERE memory_id = ANY($1::text[])", [
        memories.map((m) => m.id),
      ]);
      await insertItems(ctx, q, userId, model, items, vectors);
    });
  }

  // Closed conversations whose transcript changed since they were last embedded (or never with this model).
  const convs = await ctx.db.query<ConversationRow>(
    `SELECT c.* FROM conversations c
      WHERE c.user_id = $1 AND c.status IN ('ready', 'transcript_only')
        AND (c.embedded_revision IS DISTINCT FROM c.revision
             OR NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.conversation_id = c.id AND e.model = $2))
      ORDER BY c.start_ms LIMIT $3`,
    [userId, model, MAX_CONVERSATIONS_PER_RUN + 1],
  );
  for (const c of convs.slice(0, MAX_CONVERSATIONS_PER_RUN)) {
    const utterances = await ctx.db.query<UtteranceRow>(
      "SELECT id, text, start_ms FROM utterances WHERE conversation_id = $1 ORDER BY start_ms, id",
      [c.id],
    );
    const items: Item[] = [];
    const summaryText = [c.title, c.summary].filter(Boolean).join(". ");
    if (summaryText)
      items.push({
        ownerType: "conversation",
        ownerId: c.id,
        memoryId: null,
        conversationId: c.id,
        text: summaryText,
        atMs: c.start_ms,
      });
    for (const w of utteranceWindows(utterances)) {
      items.push({
        ownerType: "utterance",
        ownerId: w.id,
        memoryId: null,
        conversationId: c.id,
        text: w.text,
        atMs: w.atMs,
      });
    }
    const vectors = items.length
      ? await embedAll(
          embedding,
          items.map((i) => i.text),
          signal,
        )
      : [];
    await ctx.db.tx(async (q) => {
      await q.query(
        "DELETE FROM embeddings WHERE conversation_id = $1 AND owner_type IN ('conversation', 'utterance')",
        [c.id],
      );
      await insertItems(ctx, q, userId, model, items, vectors);
      await q.query(
        "UPDATE conversations SET embedded_revision = $2 WHERE id = $1 AND revision = $2",
        [c.id, c.revision],
      );
    });
  }
  if (memories.length >= MAX_MEMORIES_PER_RUN || convs.length > MAX_CONVERSATIONS_PER_RUN)
    await scheduleEmbed(ctx, ctx.db, userId);
}

export const embedHandler: JobHandler = {
  async run(ctx, job, signal) {
    if (!job.user_id) return;
    await runEmbed(ctx, job.user_id, signal);
  },
};
