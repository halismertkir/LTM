import { randomUUID } from "node:crypto";
import { normalizeText } from "@ltm/core";
import type { Memory, MemoryKind, Page } from "@ltm/protocol";
import { type Ctx, iso } from "../context.js";
import { one, type Queryable } from "../db/types.js";
import {
  decodeCursor,
  encodeCursor,
  likePattern,
  queryTokens,
  substringPattern,
  wordColumn,
} from "./conversations.js";

export interface MemoryRow {
  id: string;
  user_id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  subjects: string[];
  source_conversation_id: string | null;
  origin: "extracted" | "manual";
  occurred_at: string | null;
  normalized: string;
  created_at: number;
  updated_at: number;
}

export function memoryDto(m: MemoryRow): Memory {
  return {
    id: m.id,
    kind: m.kind,
    content: m.content,
    importance: m.importance,
    subjects: m.subjects ?? [],
    sourceConversationId: m.source_conversation_id,
    origin: m.origin,
    occurredAt: m.occurred_at,
    createdAt: iso(m.created_at),
    updatedAt: iso(m.updated_at),
  };
}

export async function getMemory(
  q: Queryable,
  userId: string,
  id: string,
): Promise<MemoryRow | null> {
  return one<MemoryRow>(q, "SELECT * FROM memories WHERE id = $1 AND user_id = $2", [id, userId]);
}

export async function listMemories(
  q: Queryable,
  userId: string,
  query: {
    limit: number;
    cursor?: string | undefined;
    q?: string | undefined;
    kind?: MemoryKind | undefined;
    conversationId?: string | undefined;
  },
): Promise<Page<Memory>> {
  const where = ["user_id = $1"];
  const params: unknown[] = [userId];
  if (query.kind) {
    params.push(query.kind);
    where.push(`kind = $${params.length}`);
  }
  if (query.conversationId) {
    params.push(query.conversationId);
    where.push(`source_conversation_id = $${params.length}`);
  }
  if (query.q) {
    for (const t of queryTokens(query.q)) {
      params.push(likePattern(t), substringPattern(t));
      where.push(
        `(${wordColumn("normalized")} LIKE $${params.length - 1} OR subjects::text ILIKE $${params.length})`,
      );
    }
  }
  if (query.cursor) {
    const [created, id] = decodeCursor(query.cursor);
    params.push(created, id);
    where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }
  params.push(query.limit + 1);
  const rows = await q.query<MemoryRow>(
    `SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const items = rows.slice(0, query.limit);
  const last = items[items.length - 1];
  return {
    items: items.map(memoryDto),
    nextCursor: rows.length > query.limit && last ? encodeCursor([last.created_at, last.id]) : null,
  };
}

export interface NewMemory {
  kind: MemoryKind;
  content: string;
  importance: number;
  subjects: string[];
  occurredAt: string | null;
  origin: "extracted" | "manual";
  sourceConversationId: string | null;
}

export async function insertMemory(
  ctx: Ctx,
  q: Queryable,
  userId: string,
  m: NewMemory,
): Promise<MemoryRow> {
  const now = ctx.clock.now();
  const rows = await q.query<MemoryRow>(
    `INSERT INTO memories (id, user_id, kind, content, importance, subjects, source_conversation_id, origin, occurred_at, normalized, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $11) RETURNING *`,
    [
      randomUUID(),
      userId,
      m.kind,
      m.content.trim(),
      m.importance,
      JSON.stringify(m.subjects),
      m.sourceConversationId,
      m.origin,
      m.occurredAt,
      normalizeText(m.content),
      now,
    ],
  );
  return rows[0]!;
}

export async function scheduleEmbed(ctx: Ctx, q: Queryable, userId: string): Promise<void> {
  await ctx.jobs.enqueue(q, {
    kind: "embed",
    userId,
    dedupeKey: `embed:${userId}`,
    runAt: ctx.clock.now() + 1000,
  });
}
