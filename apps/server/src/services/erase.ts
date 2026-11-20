import type { Ctx } from "../context.js";
import { refreshDaysAfterDelete } from "./days.js";

/** Hard-deletes conversations with their transcript, raw segments, audio and extracted memories. */
export async function deleteConversations(ctx: Ctx, userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const chunks = await ctx.db.tx(async (q) => {
    const rows = await q.query<{ id: string; path: string | null }>(
      `SELECT DISTINCT a.id, a.path FROM audio_chunks a JOIN raw_segments r ON r.audio_chunk_id = a.id
        WHERE r.user_id = $1 AND r.conversation_id = ANY($2::text[])`,
      [userId, ids],
    );
    await q.query(
      "DELETE FROM memories WHERE user_id = $1 AND origin = 'extracted' AND source_conversation_id = ANY($2::text[])",
      [userId, ids],
    );
    const days = await q.query<{ local_date: string | null }>(
      "DELETE FROM conversations WHERE user_id = $1 AND id = ANY($2::text[]) RETURNING local_date",
      [userId, ids],
    );
    if (rows.length > 0)
      await q.query("DELETE FROM audio_chunks WHERE id = ANY($1::text[])", [rows.map((r) => r.id)]);
    return { rows, days: days.map((d) => d.local_date) };
  });
  for (const c of chunks.rows) if (c.path) await ctx.audio.remove(c.path);
  await refreshDaysAfterDelete(ctx, userId, chunks.days);
  for (const id of ids)
    ctx.bus.publish(userId, { type: "conversation_deleted", conversationId: id });
}

/**
 * Erases captured data (transcripts, notes, memories, audio, streams) but keeps the
 * account, devices, settings and consents. `beforeMs` limits it to older data.
 */
export async function eraseCapturedData(
  ctx: Ctx,
  userId: string,
  beforeMs?: number,
): Promise<void> {
  const cutoff = beforeMs ?? Number.MAX_SAFE_INTEGER;
  const convIds = (
    await ctx.db.query<{ id: string }>(
      "SELECT id FROM conversations WHERE user_id = $1 AND start_ms < $2",
      [userId, cutoff],
    )
  ).map((r) => r.id);
  const connected = await connectedStreamIds(ctx, userId);
  let erasedDays: (string | null)[] = [];
  const paths = await ctx.db.tx(async (q) => {
    const audio = await q.query<{ path: string | null }>(
      "DELETE FROM audio_chunks WHERE user_id = $1 AND start_ms < $2 RETURNING path",
      [userId, cutoff],
    );
    const days = await q.query<{ local_date: string | null }>(
      "DELETE FROM conversations WHERE user_id = $1 AND id = ANY($2::text[]) RETURNING local_date",
      [userId, convIds],
    );
    erasedDays = days.map((d) => d.local_date);
    if (beforeMs === undefined) await q.query("DELETE FROM days WHERE user_id = $1", [userId]);
    await q.query("DELETE FROM memories WHERE user_id = $1 AND created_at < $2", [userId, cutoff]);
    await q.query("DELETE FROM raw_segments WHERE user_id = $1 AND start_ms < $2", [
      userId,
      cutoff,
    ]);
    // Streams still connected keep their row (the socket keeps working); the rest go.
    await q.query(
      "DELETE FROM streams WHERE user_id = $1 AND started_at < $2 AND NOT (id = ANY($3::text[]))",
      [userId, cutoff, connected],
    );
    if (beforeMs === undefined) {
      await q.query(
        "DELETE FROM jobs WHERE user_id = $1 AND kind IN ('transcribe', 'merge', 'consolidate', 'embed', 'digest')",
        [userId],
      );
    }
    return audio.map((a) => a.path).filter((p): p is string => !!p);
  });
  for (const p of paths) await ctx.audio.remove(p);
  // Days that still have (newer) conversations get a fresh digest; empty ones disappear.
  if (beforeMs !== undefined) await refreshDaysAfterDelete(ctx, userId, erasedDays);
  if (beforeMs === undefined) {
    // Catch files whose rows were already gone (e.g. a crash between write and insert).
    const streams = await ctx.db.query<{ id: string }>(
      "SELECT id FROM streams WHERE user_id = $1",
      [userId],
    );
    if (streams.length === 0) await ctx.audio.removeUser(userId);
  }
  for (const id of convIds)
    ctx.bus.publish(userId, { type: "conversation_deleted", conversationId: id });
}

async function connectedStreamIds(ctx: Ctx, userId: string): Promise<string[]> {
  const rows = await ctx.db.query<{ id: string }>(
    "SELECT id FROM streams WHERE user_id = $1 AND ended_at IS NULL",
    [userId],
  );
  return rows.map((r) => r.id).filter((id) => ctx.live.isStreamConnected(id));
}

/** Deletes the account and everything that belongs to it (rows cascade from users; files explicitly). */
export async function deleteAccount(ctx: Ctx, userId: string): Promise<void> {
  ctx.live.refuseUser(userId, "unauthorized", "This account has been deleted.");
  await ctx.db.query("DELETE FROM users WHERE id = $1", [userId]);
  await ctx.audio.removeUser(userId);
}
