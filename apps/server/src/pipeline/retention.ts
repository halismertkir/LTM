import { readdir, rmdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Ctx } from "../context.js";
import { deleteConversations } from "../services/erase.js";
import { getPrivacy } from "../services/settings.js";
import type { JobHandler } from "./worker.js";

const DAY = 24 * 3600_000;

/** Files younger than this may belong to a window whose row is still being written. */
const ORPHAN_GRACE_MS = 3600_000;

/**
 * Deletes audio files that no `audio_chunks` row points to (a crash between writing the
 * file and committing its row, or a row erased while the file was busy), and prunes empty
 * directories, so transient audio cannot pile up over months of all-day capture.
 */
export async function sweepOrphanAudio(ctx: Ctx): Promise<number> {
  const root = ctx.audio.root;
  const known = new Set(
    (
      await ctx.db.query<{ path: string }>("SELECT path FROM audio_chunks WHERE path IS NOT NULL")
    ).map((r) => r.path),
  );
  let removed = 0;
  const walk = async (dir: string): Promise<boolean> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const dirOld =
          Date.now() - (await stat(p).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs >
          ORPHAN_GRACE_MS;
        // Only old empty directories go: a fresh one may be about to receive a window.
        if ((await walk(p)) && dirOld) await rmdir(p).catch(() => {});
        else empty = false;
        continue;
      }
      const rel = relative(root, p);
      const old =
        Date.now() - (await stat(p).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs >
        ORPHAN_GRACE_MS;
      if (!known.has(rel) && old) {
        await ctx.audio.remove(rel).catch(() => {});
        removed++;
      } else {
        empty = false;
      }
    }
    return empty;
  };
  await walk(root);
  return removed;
}

/** Enforces per-user audio/data retention and cleans up expired auth artefacts. */
export async function runRetention(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.query("DELETE FROM sessions WHERE expires_at < $1", [now]);
  await ctx.db.query("DELETE FROM pairing_codes WHERE expires_at < $1", [now]);
  // Successful jobs are deleted when they finish; failed ones are kept a day for diagnosis.
  await ctx.db.query("DELETE FROM jobs WHERE status = 'failed' AND updated_at < $1", [now - DAY]);
  await sweepOrphanAudio(ctx);

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
