import { randomUUID } from "node:crypto";
import {
  type MergedUtterance,
  mergeSegments,
  normalizeText,
  type RawSegment,
  splitConversations,
} from "@ltm/core";
import type { StreamContext } from "@ltm/protocol";
import type { Ctx } from "../context.js";
import { json, type Queryable } from "../db/types.js";
import { type ConversationRow, conversationSummaries } from "../services/conversations.js";
import type { RawSegmentRow } from "../services/ingest.js";
import { getPipeline } from "../services/settings.js";
import type { JobHandler } from "./worker.js";

/** Re-check closure at least this often while conversations are open. */
const RECHECK_MS = 60_000;

function toRaw(row: RawSegmentRow, priorities: Map<string, number | null>): RawSegment {
  const seg: RawSegment = {
    id: row.id,
    streamId: row.stream_id,
    deviceId: row.device_id,
    source: row.source,
    origin: row.origin,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
    devicePriority: priorities.get(row.device_id) ?? null,
  };
  if (row.confidence !== null) seg.confidence = row.confidence;
  if (row.language) seg.language = row.language;
  if (row.speaker) seg.speaker = row.speaker;
  return seg;
}

async function devicePriorities(q: Queryable, userId: string): Promise<Map<string, number | null>> {
  const rows = await q.query<{ id: string; priority: number | null }>(
    "SELECT id, priority FROM devices WHERE user_id = $1",
    [userId],
  );
  return new Map(rows.map((r) => [r.id, r.priority]));
}

/**
 * Keeps utterance ids stable across re-merges: a new utterance takes the id of the old
 * utterance it shares most raw segments with (each old id is reused at most once), so
 * links and search hits do not churn when late data refines a transcript.
 */
function assignIds(
  next: MergedUtterance[],
  old: { id: string; segment_ids: string[] }[],
): string[] {
  const owner = new Map<string, string>();
  for (const u of old) for (const s of u.segment_ids) owner.set(s, u.id);
  const used = new Set<string>();
  return next.map((u) => {
    const votes = new Map<string, number>();
    u.segmentIds.forEach((s, i) => {
      const id = owner.get(s);
      // The winner's segments come first; weigh them so the text source decides ties.
      if (id && !used.has(id)) votes.set(id, (votes.get(id) ?? 0) + (i === 0 ? 2 : 1));
    });
    let best: string | null = null;
    let bestVotes = 0;
    for (const [id, v] of votes) if (v > bestVotes) [best, bestVotes] = [id, v];
    const id = best ?? randomUUID();
    used.add(id);
    return id;
  });
}

/**
 * Re-runs the multi-device merge over every raw segment of one conversation and replaces
 * its utterances. Returns false when the conversation has no segments left.
 */
export async function remergeConversation(
  ctx: Ctx,
  q: Queryable,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const segs = await q.query<RawSegmentRow>(
    "SELECT * FROM raw_segments WHERE conversation_id = $1 AND user_id = $2 ORDER BY start_ms, id",
    [conversationId, userId],
  );
  const old = await q.query<{ id: string; segment_ids: string[] }>(
    "SELECT id, segment_ids FROM utterances WHERE conversation_id = $1",
    [conversationId],
  );
  await q.query("DELETE FROM utterances WHERE conversation_id = $1", [conversationId]);
  if (segs.length === 0) return false;

  const priorities = await devicePriorities(q, userId);
  const merged = mergeSegments(segs.map((s) => toRaw(s, priorities)));
  const ids = assignIds(merged, old);
  const deviceIds = new Set<string>();
  const segById = new Map(segs.map((s) => [s.id, s]));
  for (let i = 0; i < merged.length; i++) {
    const u = merged[i]!;
    for (const d of u.deviceIds) deviceIds.add(d);
    // Clients read sources[i] as the source of deviceIds[i] (winner first), so align them:
    // one source per device, from that device's first contributing segment.
    const sources = u.deviceIds.map((d) => {
      const segId = u.segmentIds.find((id) => segById.get(id)?.device_id === d);
      return (segId ? segById.get(segId)?.source : undefined) ?? u.sources[0] ?? "mic";
    });
    await q.query(
      `INSERT INTO utterances (id, conversation_id, user_id, start_ms, end_ms, text, speaker, language, origin, device_ids, sources, segment_ids, search_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13)`,
      [
        ids[i],
        conversationId,
        userId,
        u.startMs,
        u.endMs,
        u.text,
        u.speaker,
        u.language ?? null,
        u.origin,
        json(u.deviceIds),
        json(sources),
        json(u.segmentIds),
        normalizeText(u.text),
      ],
    );
  }
  const streamIds = [...new Set(segs.map((s) => s.stream_id))];
  const contexts = (
    await q.query<{ context: StreamContext | null }>(
      "SELECT context FROM streams WHERE id = ANY($1::text[])",
      [streamIds],
    )
  )
    .map((r) => r.context)
    .filter((c): c is StreamContext => !!c && (!!c.title || !!c.app));
  const start = Math.min(...segs.map((s) => s.start_ms));
  const end = Math.max(...segs.map((s) => s.end_ms));
  await q.query(
    `UPDATE conversations SET start_ms = $2, end_ms = $3, device_ids = $4::jsonb, contexts = $5::jsonb,
            utterance_count = $6, revision = revision + 1, updated_at = $7
     WHERE id = $1`,
    [
      conversationId,
      start,
      end,
      json([...deviceIds]),
      json(contexts),
      merged.length,
      ctx.clock.now(),
    ],
  );
  return true;
}

interface MergeResult {
  changed: Set<string>;
  deleted: Set<string>;
}

/** Assigns unassigned raw segments to conversations (creating, extending, re-opening and joining them). */
async function assignSegments(
  ctx: Ctx,
  q: Queryable,
  userId: string,
  gapMs: number,
): Promise<MergeResult> {
  const result: MergeResult = { changed: new Set(), deleted: new Set() };
  const fresh = await q.query<RawSegmentRow>(
    "SELECT * FROM raw_segments WHERE user_id = $1 AND conversation_id IS NULL ORDER BY start_ms",
    [userId],
  );
  if (fresh.length === 0) return result;
  const minStart = Math.min(...fresh.map((s) => s.start_ms));
  const maxEnd = Math.max(...fresh.map((s) => s.end_ms));
  const candidates = await q.query<ConversationRow>(
    "SELECT * FROM conversations WHERE user_id = $1 AND end_ms >= $2 AND start_ms <= $3 ORDER BY start_ms",
    [userId, minStart - gapMs, maxEnd + gapMs],
  );
  const known = candidates.length
    ? await q.query<RawSegmentRow>(
        "SELECT * FROM raw_segments WHERE conversation_id = ANY($1::text[])",
        [candidates.map((c) => c.id)],
      )
    : [];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const slices = splitConversations(
    [...fresh, ...known].map((r) => ({ startMs: r.start_ms, endMs: r.end_ms, row: r })),
    { gapMs },
  );

  const claimed = new Set<string>();
  const absorbed = new Set<string>();
  const now = ctx.clock.now();
  for (const slice of slices) {
    const rows = slice.items.map((i) => i.row);
    const present = [
      ...new Set(
        rows.map((r) => r.conversation_id).filter((c): c is string => !!c && !claimed.has(c)),
      ),
    ]
      .map((id) => byId.get(id)!)
      // Keep the conversation the user has touched (edited title/notes), else the earliest one.
      .sort(
        (a, b) =>
          Number(b.title_edited || b.notes_edited) - Number(a.title_edited || a.notes_edited) ||
          a.start_ms - b.start_ms,
      );
    const hasFresh = rows.some((r) => r.conversation_id === null);
    const target = present[0];
    if (!target && !hasFresh) continue;
    let targetId: string;
    if (target) {
      targetId = target.id;
    } else {
      targetId = randomUUID();
      await q.query(
        `INSERT INTO conversations (id, user_id, status, start_ms, end_ms, created_at, updated_at)
         VALUES ($1, $2, 'open', $3, $4, $5, $5)`,
        [targetId, userId, slice.startMs, slice.endMs, now],
      );
    }
    claimed.add(targetId);
    const moving = rows.filter((r) => r.conversation_id !== targetId).map((r) => r.id);
    if (moving.length === 0) continue;
    await q.query("UPDATE raw_segments SET conversation_id = $1 WHERE id = ANY($2::text[])", [
      targetId,
      moving,
    ]);
    // Late data bridged two conversations: fold the others into the target.
    for (const other of present.slice(1)) {
      claimed.add(other.id);
      absorbed.add(other.id);
      await q.query("UPDATE action_items SET conversation_id = $1 WHERE conversation_id = $2", [
        targetId,
        other.id,
      ]);
      await q.query(
        "UPDATE memories SET source_conversation_id = $1 WHERE source_conversation_id = $2",
        [targetId, other.id],
      );
    }
    result.changed.add(targetId);
  }
  // Conversations that lost all their segments to another one disappear.
  for (const c of candidates) {
    if (result.changed.has(c.id)) continue;
    const left = await q.query("SELECT 1 FROM raw_segments WHERE conversation_id = $1 LIMIT 1", [
      c.id,
    ]);
    if (left.length === 0) {
      await q.query("DELETE FROM conversations WHERE id = $1", [c.id]);
      result.deleted.add(c.id);
    } else if (absorbed.has(c.id)) {
      // Partly folded into another conversation (duration cap): re-merge what is left.
      result.changed.add(c.id);
    }
  }
  for (const id of result.changed) {
    const ok = await remergeConversation(ctx, q, id, userId);
    if (!ok) {
      await q.query("DELETE FROM conversations WHERE id = $1", [id]);
      result.changed.delete(id);
      result.deleted.add(id);
      continue;
    }
    // New speech re-opens a finished conversation; closing re-queues consolidation.
    await q.query(
      "UPDATE conversations SET status = 'open', status_detail = NULL WHERE id = $1 AND status <> 'open'",
      [id],
    );
  }
  return result;
}

/** Closes open conversations whose last speech is older than the gap and that nothing still feeds. */
async function closeQuiet(
  ctx: Ctx,
  q: Queryable,
  userId: string,
  gapMs: number,
): Promise<{ closed: string[]; nextCheckAt: number | null }> {
  const now = ctx.clock.now();
  const open = await q.query<ConversationRow>(
    "SELECT * FROM conversations WHERE user_id = $1 AND status = 'open'",
    [userId],
  );
  const closed: string[] = [];
  let nextCheckAt: number | null = null;
  for (const c of open) {
    const horizon = c.end_ms + gapMs;
    let waiting = now < horizon;
    if (!waiting) {
      // Audio cut before the horizon but not transcribed yet could still extend this conversation.
      const pending = await q.query(
        `SELECT 1 FROM audio_chunks a
           JOIN jobs j ON j.kind = 'transcribe' AND j.payload->>'chunkId' = a.id AND j.status IN ('pending', 'running')
          WHERE a.user_id = $1 AND a.status = 'pending' AND a.start_ms < $2 LIMIT 1`,
        [userId, horizon],
      );
      waiting = pending.length > 0;
    }
    if (waiting) {
      const at = Math.max(Math.min(horizon, now + RECHECK_MS), now + 1000);
      nextCheckAt = nextCheckAt === null ? at : Math.min(nextCheckAt, at);
      continue;
    }
    await q.query("UPDATE conversations SET status = 'processing', updated_at = $2 WHERE id = $1", [
      c.id,
      now,
    ]);
    await ctx.jobs.enqueue(q, {
      kind: "consolidate",
      userId,
      payload: { conversationId: c.id },
      dedupeKey: `consolidate:${c.id}`,
    });
    closed.push(c.id);
  }
  return { closed, nextCheckAt };
}

export async function runMerge(ctx: Ctx, userId: string): Promise<void> {
  const pipeline = await getPipeline(ctx.db, userId);
  const gapMs = pipeline.conversationGapMinutes * 60_000;
  const { changed, deleted, closed } = await ctx.db.tx(async (q) => {
    const r = await assignSegments(ctx, q, userId, gapMs);
    const c = await closeQuiet(ctx, q, userId, gapMs);
    if (c.nextCheckAt !== null) {
      await ctx.jobs.enqueue(q, {
        kind: "merge",
        userId,
        dedupeKey: `merge:${userId}`,
        runAt: c.nextCheckAt,
      });
    }
    return { ...r, ...c };
  });
  for (const id of deleted)
    ctx.bus.publish(userId, { type: "conversation_deleted", conversationId: id });
  const touched = [...new Set([...changed, ...closed])].filter((id) => !deleted.has(id));
  if (touched.length > 0) {
    for (const summary of await conversationSummaries(ctx.db, userId, touched)) {
      ctx.bus.publish(userId, { type: "conversation_updated", conversation: summary });
    }
  }
}

export const mergeHandler: JobHandler = {
  async run(ctx, job) {
    if (!job.user_id) return;
    await runMerge(ctx, job.user_id);
  },
};
