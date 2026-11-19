import type { Ctx } from "../context.js";
import { deleteConversations } from "../services/erase.js";
import { getPrivacy } from "../services/settings.js";
import type { JobHandler } from "./worker.js";

const DAY = 24 * 3600_000;

/** Enforces per-user audio/data retention and cleans up expired auth artefacts. */
export async function runRetention(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.query("DELETE FROM sessions WHERE expires_at < $1", [now]);
  await ctx.db.query("DELETE FROM pairing_codes WHERE expires_at < $1", [now]);
  await ctx.db.query("DELETE FROM jobs WHERE status = 'failed' AND updated_at < $1", [
    now - 7 * DAY,
  ]);

  const users = await ctx.db.query<{ id: string }>("SELECT id FROM users");
  for (const { id: userId } of users) {
    const privacy = await getPrivacy(ctx.db, userId);
    // Audio that has been dealt with (transcribed or given up on) and is past its keep time.
    const audioCutoff = !privacy.retainAudio
      ? now
      : privacy.audioRetentionDays !== null
        ? now - privacy.audioRetentionDays * DAY
        : null;
    if (audioCutoff !== null) {
      const rows = await ctx.db.query<{ id: string; path: string }>(
        "SELECT id, path FROM audio_chunks WHERE user_id = $1 AND status <> 'pending' AND path IS NOT NULL AND created_at <= $2",
        [userId, audioCutoff],
      );
      for (const r of rows) await ctx.audio.remove(r.path);
      if (rows.length > 0) {
        await ctx.db.query("UPDATE audio_chunks SET path = NULL WHERE id = ANY($1::text[])", [
          rows.map((r) => r.id),
        ]);
      }
    }
    if (privacy.dataRetentionDays !== null) {
      const cutoff = now - privacy.dataRetentionDays * DAY;
      const old = await ctx.db.query<{ id: string }>(
        "SELECT id FROM conversations WHERE user_id = $1 AND end_ms < $2",
        [userId, cutoff],
      );
      if (old.length > 0)
        await deleteConversations(
          ctx,
          userId,
          old.map((o) => o.id),
        );
      await ctx.db.query("DELETE FROM memories WHERE user_id = $1 AND created_at < $2", [
        userId,
        cutoff,
      ]);
      await ctx.db.query(
        "DELETE FROM raw_segments WHERE user_id = $1 AND conversation_id IS NULL AND end_ms < $2",
        [userId, cutoff],
      );
    }
  }
}

export const retentionHandler: JobHandler = {
  async run(ctx) {
    await runRetention(ctx);
  },
};
