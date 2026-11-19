import type { SearchHit, SearchHitType } from "@ltm/protocol";
import type { EmbeddingProvider } from "@ltm/providers";
import type { Ctx } from "../context.js";
import { type Queryable, vectorLiteral } from "../db/types.js";
import { isProviderError } from "../errors.js";
import { likePattern, queryTokens } from "./conversations.js";

/** Reciprocal-rank-fusion constant (the usual 60). */
const RRF_K = 60;
const ALL_TYPES: SearchHitType[] = ["memory", "conversation", "utterance"];

export interface SearchOptions {
  query: string;
  limit: number;
  types?: SearchHitType[] | undefined;
  from?: number | undefined;
  to?: number | undefined;
}

type Ranked = Omit<SearchHit, "score"> & { raw: number };

function snippet(text: string, max = 280): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function tokenScoreSql(column: string, tokens: string[], firstParam: number): string {
  return tokens
    .map((_, i) => `(CASE WHEN ${column} LIKE $${firstParam + i} THEN 1 ELSE 0 END)`)
    .join(" + ");
}

function timeFilter(column: string, opts: SearchOptions, params: unknown[]): string {
  let sql = "";
  if (opts.from !== undefined) {
    params.push(opts.from);
    sql += ` AND ${column} >= $${params.length}`;
  }
  if (opts.to !== undefined) {
    params.push(opts.to);
    sql += ` AND ${column} <= $${params.length}`;
  }
  return sql;
}

/** Keyword retrieval: share of query tokens contained in the normalised text, per type. */
async function keyword(
  q: Queryable,
  userId: string,
  opts: SearchOptions,
  types: SearchHitType[],
  limit: number,
): Promise<Ranked[]> {
  const tokens = queryTokens(opts.query);
  if (tokens.length === 0) return [];
  const patterns = tokens.map(likePattern);
  const out: Ranked[] = [];
  const n = tokens.length;
  if (types.includes("memory")) {
    const params: unknown[] = [userId, ...patterns];
    const score = tokenScoreSql("m.normalized", tokens, 2);
    const tf = timeFilter("m.created_at", opts, params);
    params.push(limit);
    const rows = await q.query<{
      id: string;
      content: string;
      source_conversation_id: string | null;
      title: string | null;
      created_at: number;
      s: number;
    }>(
      `SELECT * FROM (SELECT m.id, m.content, m.source_conversation_id, c.title, m.created_at, (${score}) AS s
         FROM memories m LEFT JOIN conversations c ON c.id = m.source_conversation_id
        WHERE m.user_id = $1 ${tf}) x WHERE s > 0 ORDER BY s DESC, created_at DESC LIMIT $${params.length}`,
      params,
    );
    for (const r of rows) {
      out.push({
        type: "memory",
        id: r.id,
        conversationId: r.source_conversation_id,
        title: r.title,
        snippet: snippet(r.content),
        atMs: r.created_at,
        raw: r.s / n,
      });
    }
  }
  if (types.includes("conversation")) {
    const params: unknown[] = [userId, ...patterns];
    const score = tokenScoreSql("c.search_text", tokens, 2);
    const tf = timeFilter("c.start_ms", opts, params);
    params.push(limit);
    const rows = await q.query<{
      id: string;
      title: string | null;
      summary: string | null;
      start_ms: number;
      s: number;
    }>(
      `SELECT * FROM (SELECT c.id, c.title, c.summary, c.start_ms, (${score}) AS s FROM conversations c
        WHERE c.user_id = $1 ${tf}) x WHERE s > 0 ORDER BY s DESC, start_ms DESC LIMIT $${params.length}`,
      params,
    );
    for (const r of rows) {
      out.push({
        type: "conversation",
        id: r.id,
        conversationId: r.id,
        title: r.title,
        snippet: snippet(r.summary ?? r.title ?? ""),
        atMs: r.start_ms,
        raw: r.s / n,
      });
    }
  }
  if (types.includes("utterance")) {
    const params: unknown[] = [userId, ...patterns];
    const score = tokenScoreSql("u.search_text", tokens, 2);
    const tf = timeFilter("u.start_ms", opts, params);
    params.push(limit);
    const rows = await q.query<{
      id: string;
      text: string;
      conversation_id: string;
      title: string | null;
      start_ms: number;
      s: number;
    }>(
      `SELECT * FROM (SELECT u.id, u.text, u.conversation_id, c.title, u.start_ms, (${score}) AS s
         FROM utterances u JOIN conversations c ON c.id = u.conversation_id
        WHERE u.user_id = $1 ${tf}) x WHERE s > 0 ORDER BY s DESC, start_ms DESC LIMIT $${params.length}`,
      params,
    );
    for (const r of rows) {
      out.push({
        type: "utterance",
        id: r.id,
        conversationId: r.conversation_id,
        title: r.title,
        snippet: snippet(r.text),
        atMs: r.start_ms,
        raw: r.s / n,
      });
    }
  }
  return out.sort((a, b) => b.raw - a.raw);
}

/** Vector retrieval against stored embeddings of the same model (and therefore dimension). */
async function vectorSearch(
  q: Queryable,
  userId: string,
  opts: SearchOptions,
  types: SearchHitType[],
  limit: number,
  model: string,
  vector: number[],
): Promise<Ranked[]> {
  const params: unknown[] = [userId, model, vectorLiteral(vector), vector.length, types];
  const tf = timeFilter("COALESCE(e.at_ms, m.created_at)", opts, params);
  params.push(limit);
  const rows = await q.query<{
    owner_type: SearchHitType;
    owner_id: string;
    conversation_id: string | null;
    memory_conv: string | null;
    title: string | null;
    snippet: string;
    at_ms: number | null;
    m_created: number | null;
    sim: number;
  }>(
    `SELECT e.owner_type, e.owner_id, e.conversation_id, m.source_conversation_id AS memory_conv,
            c.title, COALESCE(m.content, e.snippet) AS snippet, e.at_ms, m.created_at AS m_created,
            1 - (e.embedding <=> $3::vector) AS sim
       FROM embeddings e
       LEFT JOIN memories m ON m.id = e.memory_id
       LEFT JOIN conversations c ON c.id = COALESCE(e.conversation_id, m.source_conversation_id)
      WHERE e.user_id = $1 AND e.model = $2 AND e.dims = $4 AND e.owner_type = ANY($5::text[]) ${tf}
      ORDER BY e.embedding <=> $3::vector
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    type: r.owner_type,
    id: r.owner_id,
    conversationId: r.owner_type === "memory" ? r.memory_conv : r.conversation_id,
    title: r.title,
    snippet: snippet(r.snippet),
    atMs: r.at_ms ?? r.m_created,
    raw: r.sim,
  }));
}

export interface SearchResult {
  hits: SearchHit[];
  mode: "hybrid" | "keyword";
}

/**
 * Hybrid search: keyword and vector lists fused by reciprocal rank (score normalised so a
 * hit ranked first in both lists scores 1). Without an embedding provider: keyword only.
 */
export async function search(
  ctx: Ctx,
  userId: string,
  embedding: EmbeddingProvider | null,
  opts: SearchOptions,
): Promise<SearchResult> {
  const types = opts.types && opts.types.length > 0 ? opts.types : ALL_TYPES;
  const pool = Math.max(opts.limit * 3, 30);
  const kw = await keyword(ctx.db, userId, opts, types, pool);
  let vec: Ranked[] | null = null;
  if (embedding) {
    try {
      const [v] = await embedding.embed([opts.query]);
      if (v && v.length > 0)
        vec = await vectorSearch(ctx.db, userId, opts, types, pool, embedding.model, v);
    } catch (err) {
      ctx.log.warn(
        { err: isProviderError(err) ? err.code : (err as Error).message },
        "query embedding failed; keyword search only",
      );
    }
  }
  if (!vec) {
    return {
      mode: "keyword",
      hits: kw
        .slice(0, opts.limit)
        .map(({ raw, ...h }) => ({ ...h, score: Math.max(0, Math.min(1, raw)) })),
    };
  }
  const fused = new Map<string, { hit: Omit<Ranked, "raw">; score: number }>();
  const addList = (list: Ranked[]) => {
    list.forEach((h, rank) => {
      const key = `${h.type}:${h.id}`;
      const { raw: _raw, ...hit } = h;
      const entry = fused.get(key) ?? { hit, score: 0 };
      entry.score += 1 / (RRF_K + rank + 1);
      fused.set(key, entry);
    });
  };
  addList(kw);
  addList(vec);
  const max = 2 / (RRF_K + 1);
  const hits = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit)
    .map((e) => ({ ...e.hit, score: Math.min(1, e.score / max) }));
  return { mode: "hybrid", hits };
}
