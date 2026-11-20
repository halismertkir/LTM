import type { SearchHit, SearchHitType } from "@ltm/protocol";
import type { EmbeddingProvider } from "@ltm/providers";
import type { Ctx } from "../context.js";
import { type Queryable, vectorLiteral } from "../db/types.js";
import { isProviderError } from "../errors.js";
import { isSignificant, likePattern, queryTokens, wordColumn } from "./conversations.js";

/** Reciprocal-rank-fusion constant (the usual 60). */
/** Most a keyword match can add to a cosine similarity (which lives in 0..1). */
const KEYWORD_BONUS = 0.2;
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

/** Weight of a short token ("ne", "of"): it refines a match but never makes one. */
const SHORT_TOKEN_WEIGHT = 0.25;

function tokenWeight(t: string): number {
  return isSignificant(t) ? 1 : SHORT_TOKEN_WEIGHT;
}

/**
 * SQL for (weighted score, number of significant tokens matched). A row is a keyword hit
 * only when a significant token matches; otherwise the keyword list would hand arbitrary
 * rows to the rank fusion, and they would outrank genuinely similar vector hits.
 */
function tokenScoreSql(
  column: string,
  tokens: string[],
  firstParam: number,
): { score: string; sig: string } {
  const col = wordColumn(column);
  const cases = tokens.map((t, i) => ({ t, sql: `${col} LIKE $${firstParam + i}` }));
  const score = cases
    .map((c) => `(CASE WHEN ${c.sql} THEN ${tokenWeight(c.t)} ELSE 0 END)`)
    .join(" + ");
  const significant = cases.filter((c) => isSignificant(c.t));
  // A query made only of short words falls back to letting those match.
  const sig = (significant.length ? significant : cases)
    .map((c) => `(CASE WHEN ${c.sql} THEN 1 ELSE 0 END)`)
    .join(" + ");
  return { score, sig };
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
  const n = tokens.reduce((w, t) => w + tokenWeight(t), 0);
  if (types.includes("memory")) {
    const params: unknown[] = [userId, ...patterns];
    const { score, sig } = tokenScoreSql("m.normalized", tokens, 2);
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
      `SELECT * FROM (SELECT m.id, m.content, m.source_conversation_id, c.title, m.created_at, (${score}) AS s, (${sig}) AS g
         FROM memories m LEFT JOIN conversations c ON c.id = m.source_conversation_id
        WHERE m.user_id = $1 ${tf}) x WHERE g > 0 ORDER BY s DESC, created_at DESC LIMIT $${params.length}`,
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
    const { score, sig } = tokenScoreSql("c.search_text", tokens, 2);
    const tf = timeFilter("c.start_ms", opts, params);
    params.push(limit);
    const rows = await q.query<{
      id: string;
      title: string | null;
      summary: string | null;
      start_ms: number;
      s: number;
    }>(
      `SELECT * FROM (SELECT c.id, c.title, c.summary, c.start_ms, (${score}) AS s, (${sig}) AS g FROM conversations c
        WHERE c.user_id = $1 ${tf}) x WHERE g > 0 ORDER BY s DESC, start_ms DESC LIMIT $${params.length}`,
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
    const { score, sig } = tokenScoreSql("u.search_text", tokens, 2);
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
      `SELECT * FROM (SELECT u.id, u.text, u.conversation_id, c.title, u.start_ms, (${score}) AS s, (${sig}) AS g
         FROM utterances u JOIN conversations c ON c.id = u.conversation_id
        WHERE u.user_id = $1 ${tf}) x WHERE g > 0 ORDER BY s DESC, start_ms DESC LIMIT $${params.length}`,
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
 * Hybrid search: cosine similarity plus a keyword bonus. Without an embedding provider:
 * keyword only.
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
  // Fusion by similarity, not by rank. Rank fusion treats the 1st and the 5th vector hit
  // as almost equal, so any row sharing a single ordinary word with the query ("zaman")
  // used to leapfrog the best semantic match. Here cosine similarity is the base score
  // and keyword overlap adds a bonus that grows with the square of the share of the query
  // it covers: a full phrase match lifts a row clearly, one shared word barely moves it.
  const fused = new Map<string, { hit: Omit<Ranked, "raw">; score: number }>();
  const floor = vec.length > 0 ? Math.max(0, Math.min(...vec.map((v) => v.raw)) - 0.05) : 0;
  for (const { raw, ...hit } of vec) fused.set(`${hit.type}:${hit.id}`, { hit, score: raw });
  for (const { raw, ...hit } of kw) {
    const share = Math.max(0, Math.min(1, raw));
    const bonus = KEYWORD_BONUS * share * share;
    const key = `${hit.type}:${hit.id}`;
    const entry = fused.get(key);
    if (entry) entry.score += bonus;
    else fused.set(key, { hit, score: floor + bonus });
  }
  const hits = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit)
    .map((e) => ({ ...e.hit, score: Math.max(0, Math.min(1, e.score)) }));
  return { mode: "hybrid", hits };
}
