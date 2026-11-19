import { normalizeText } from "@ltm/core";
import type {
  ActionItem,
  AudioSource,
  ConversationDetail,
  ConversationStatus,
  ConversationSummary,
  Page,
  SegmentOrigin,
  SpeakerHint,
  StreamContext,
  Utterance,
} from "@ltm/protocol";
import { iso } from "../context.js";
import { one, type Queryable } from "../db/types.js";
import { badRequest } from "../errors.js";

export interface ConversationRow {
  id: string;
  user_id: string;
  status: ConversationStatus;
  start_ms: number;
  end_ms: number;
  title: string | null;
  title_edited: boolean;
  summary: string | null;
  notes: string | null;
  notes_edited: boolean;
  decisions: string[];
  participants: string[];
  topics: string[];
  language: string | null;
  status_detail: string | null;
  device_ids: string[];
  contexts: StreamContext[];
  utterance_count: number;
  revision: number;
  consolidated_revision: number | null;
  embedded_revision: number | null;
  search_text: string;
  created_at: number;
  updated_at: number;
}

export interface UtteranceRow {
  id: string;
  conversation_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker: SpeakerHint;
  language: string | null;
  origin: SegmentOrigin;
  device_ids: string[];
  sources: AudioSource[];
  segment_ids: string[];
}

export interface ActionItemRow {
  id: string;
  conversation_id: string;
  text: string;
  owner: string | null;
  due: string | null;
  done: boolean;
  text_edited: boolean;
  position: number;
}

type SummaryRow = ConversationRow & { open_items: number };

function summaryDto(r: SummaryRow): ConversationSummary {
  return {
    id: r.id,
    status: r.status,
    startMs: r.start_ms,
    endMs: r.end_ms,
    title: r.title,
    summary: r.summary,
    topics: r.topics ?? [],
    participants: r.participants ?? [],
    language: r.language,
    deviceIds: r.device_ids ?? [],
    utteranceCount: r.utterance_count,
    openActionItems: r.open_items ?? 0,
    updatedAt: iso(r.updated_at),
  };
}

export function utteranceDto(u: UtteranceRow): Utterance {
  return {
    id: u.id,
    startMs: u.start_ms,
    endMs: u.end_ms,
    text: u.text,
    speaker: u.speaker,
    language: u.language,
    deviceIds: u.device_ids,
    sources: u.sources,
    origin: u.origin,
  };
}

export function actionItemDto(a: ActionItemRow): ActionItem {
  return { id: a.id, text: a.text, owner: a.owner, due: a.due, done: a.done };
}

const SUMMARY_SELECT = `SELECT c.*, (SELECT count(*)::int FROM action_items a WHERE a.conversation_id = c.id AND NOT a.done) AS open_items
  FROM conversations c`;

export async function conversationSummaries(
  q: Queryable,
  userId: string,
  ids: string[],
): Promise<ConversationSummary[]> {
  if (ids.length === 0) return [];
  const rows = await q.query<SummaryRow>(
    `${SUMMARY_SELECT} WHERE c.user_id = $1 AND c.id = ANY($2::text[])`,
    [userId, ids],
  );
  return rows.map(summaryDto);
}

export async function getConversationRow(
  q: Queryable,
  userId: string,
  id: string,
): Promise<ConversationRow | null> {
  return one<ConversationRow>(q, "SELECT * FROM conversations WHERE id = $1 AND user_id = $2", [
    id,
    userId,
  ]);
}

export async function conversationDetail(
  q: Queryable,
  userId: string,
  id: string,
): Promise<ConversationDetail | null> {
  const row = await one<SummaryRow>(q, `${SUMMARY_SELECT} WHERE c.user_id = $1 AND c.id = $2`, [
    userId,
    id,
  ]);
  if (!row) return null;
  const [utterances, items, memories] = await Promise.all([
    q.query<UtteranceRow>(
      "SELECT * FROM utterances WHERE conversation_id = $1 ORDER BY start_ms, id",
      [id],
    ),
    q.query<ActionItemRow>(
      "SELECT * FROM action_items WHERE conversation_id = $1 ORDER BY position, created_at",
      [id],
    ),
    q.query<{ id: string }>(
      "SELECT id FROM memories WHERE source_conversation_id = $1 AND user_id = $2 ORDER BY created_at",
      [id, userId],
    ),
  ]);
  return {
    ...summaryDto(row),
    notes: row.notes,
    decisions: row.decisions ?? [],
    actionItems: items.map(actionItemDto),
    utterances: utterances.map(utteranceDto),
    memoryIds: memories.map((m) => m.id),
    statusDetail: row.status_detail,
  };
}

// --------------------------------------------------------------------------- cursors

export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

export function decodeCursor(cursor: string): [number, string] {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "string")
      return [v[0], v[1]];
  } catch {
    // fall through
  }
  throw badRequest("Invalid cursor.");
}

/** Search tokens of a user query: normalised like stored text, duplicates and 1-letter tokens dropped. */
export function queryTokens(q: string): string[] {
  const toks = normalizeText(q)
    .split(" ")
    .filter((t) => t.length >= 2 || /\d/.test(t));
  return [...new Set(toks)].slice(0, 12);
}

/** LIKE pattern with the wildcard characters of the token escaped. */
export function likePattern(token: string): string {
  return `%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function listConversations(
  q: Queryable,
  userId: string,
  query: {
    limit: number;
    cursor?: string | undefined;
    from?: number | undefined;
    to?: number | undefined;
    q?: string | undefined;
  },
): Promise<Page<ConversationSummary>> {
  const where = ["c.user_id = $1"];
  const params: unknown[] = [userId];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (query.from !== undefined) add("c.end_ms >= ?", query.from);
  if (query.to !== undefined) add("c.start_ms <= ?", query.to);
  if (query.cursor) {
    const [start, id] = decodeCursor(query.cursor);
    params.push(start, id);
    where.push(`(c.start_ms, c.id) < ($${params.length - 1}, $${params.length})`);
  }
  if (query.q) {
    // Every token must appear in the title/summary/notes or somewhere in the transcript.
    for (const t of queryTokens(query.q)) {
      add(
        "(c.search_text LIKE ? OR EXISTS (SELECT 1 FROM utterances u WHERE u.conversation_id = c.id AND u.search_text LIKE ?))",
        likePattern(t),
      );
    }
  }
  params.push(query.limit + 1);
  const rows = await q.query<SummaryRow>(
    `${SUMMARY_SELECT} WHERE ${where.join(" AND ")} ORDER BY c.start_ms DESC, c.id DESC LIMIT $${params.length}`,
    params,
  );
  const items = rows.slice(0, query.limit);
  const last = items[items.length - 1];
  return {
    items: items.map(summaryDto),
    nextCursor: rows.length > query.limit && last ? encodeCursor([last.start_ms, last.id]) : null,
  };
}

/** Text the keyword search and the list filter match against. */
export function conversationSearchText(c: {
  title: string | null;
  summary: string | null;
  notes: string | null;
  topics?: string[];
  participants?: string[];
}): string {
  return normalizeText(
    [c.title, c.summary, c.notes, ...(c.topics ?? []), ...(c.participants ?? [])]
      .filter(Boolean)
      .join("\n"),
  );
}
