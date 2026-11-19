import { randomUUID } from "node:crypto";
import type { Ctx } from "../context.js";
import { one } from "../db/types.js";
import { isProviderError } from "../errors.js";
import {
  announceSegments,
  type RawSegmentRow,
  type StreamRow,
  scheduleMerge,
} from "../services/ingest.js";
import { getPipeline, getPrivacy, resolveProvidersForUser } from "../services/settings.js";
import type { JobRow } from "./jobs.js";
import type { JobHandler, JobOutcome } from "./worker.js";

export interface AudioChunkRow {
  id: string;
  user_id: string;
  stream_id: string;
  kind: "window" | "chunk";
  seq: number;
  path: string | null;
  mime_type: string;
  size_bytes: number;
  start_ms: number;
  duration_ms: number;
  language: string | null;
  status: "pending" | "transcribed" | "failed";
  status_detail: string | null;
  created_at: number;
  transcribed_at: number | null;
}

export const STT_NOT_CONFIGURED =
  "Waiting for a speech-to-text provider: configure one in Settings → Providers and the audio kept so far will be transcribed.";

/** Provider failures that only the user can fix (bad key, nothing configured): park until settings change. */
const PARK_CODES = new Set(["auth", "not_configured"]);

async function finishChunk(
  ctx: Ctx,
  chunk: AudioChunkRow,
  status: "transcribed" | "failed",
  detail: string | null,
): Promise<void> {
  const privacy = await getPrivacy(ctx.db, chunk.user_id);
  const deleteAudio = !privacy.retainAudio && chunk.path !== null;
  await ctx.db.query(
    "UPDATE audio_chunks SET status = $2, status_detail = $3, transcribed_at = $4, path = CASE WHEN $5 THEN NULL ELSE path END WHERE id = $1",
    [chunk.id, status, detail, ctx.clock.now(), deleteAudio],
  );
  if (deleteAudio && chunk.path) await ctx.audio.remove(chunk.path);
}

export const transcribeHandler: JobHandler = {
  async run(ctx: Ctx, job: JobRow, signal: AbortSignal): Promise<JobOutcome> {
    const chunkId = String(job.payload.chunkId ?? "");
    const chunk = await one<AudioChunkRow>(ctx.db, "SELECT * FROM audio_chunks WHERE id = $1", [
      chunkId,
    ]);
    if (chunk?.status !== "pending") return;
    const stream = await one<StreamRow>(ctx.db, "SELECT * FROM streams WHERE id = $1", [
      chunk.stream_id,
    ]);
    if (!stream) return;
    if (!chunk.path) {
      await finishChunk(ctx, chunk, "failed", "The audio file is gone.");
      return;
    }

    const { stt } = await resolveProvidersForUser(ctx, chunk.user_id, ["stt"]);
    if (!stt) {
      await ctx.db.query("UPDATE audio_chunks SET status_detail = $2 WHERE id = $1", [
        chunk.id,
        STT_NOT_CONFIGURED,
      ]);
      return { park: "stt_not_configured" };
    }

    let audio: Buffer;
    try {
      audio = await ctx.audio.read(chunk.path);
    } catch {
      await finishChunk(ctx, chunk, "failed", "The audio file is gone.");
      return;
    }
    const pipeline = await getPipeline(ctx.db, chunk.user_id);
    const language = chunk.language ?? stream.language ?? pipeline.language ?? undefined;

    let result: Awaited<ReturnType<typeof stt.transcribe>>;
    try {
      result = await stt.transcribe({
        audio: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength),
        mimeType: chunk.mime_type,
        ...(language ? { language } : {}),
        signal,
      });
    } catch (err) {
      if (isProviderError(err) && PARK_CODES.has(err.code)) {
        await ctx.db.query("UPDATE audio_chunks SET status_detail = $2 WHERE id = $1", [
          chunk.id,
          `Speech-to-text failed (${err.code}); fix the provider settings and the audio will be retried.`,
        ]);
        return { park: `stt_${err.code}` };
      }
      throw err;
    }

    const now = ctx.clock.now();
    const chunkEnd = chunk.start_ms + chunk.duration_ms;
    const parts =
      result.segments.length > 0
        ? result.segments
        : result.text.trim()
          ? [{ startSec: 0, endSec: chunk.duration_ms / 1000, text: result.text }]
          : [];
    const inserted = await ctx.db.tx(async (q) => {
      const rows: RawSegmentRow[] = [];
      for (const s of parts) {
        const text = s.text.trim();
        if (!text) continue;
        // Segment offsets are relative to the submitted audio; anchor them on the window start.
        const start = Math.min(chunk.start_ms + Math.max(0, s.startSec) * 1000, chunkEnd);
        const end = Math.min(
          Math.max(start, chunk.start_ms + Math.max(0, s.endSec) * 1000),
          chunkEnd + 1000,
        );
        const r = await q.query<RawSegmentRow>(
          `INSERT INTO raw_segments (id, user_id, stream_id, device_id, source, origin, start_ms, end_ms, text, confidence, language, audio_chunk_id, created_at)
           VALUES ($1, $2, $3, $4, $5, 'server_stt', $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
          [
            randomUUID(),
            chunk.user_id,
            stream.id,
            stream.device_id,
            stream.source,
            Math.round(start),
            Math.round(end),
            text,
            s.confidence ?? null,
            result.language ?? language ?? null,
            chunk.id,
            now,
          ],
        );
        rows.push(r[0]!);
      }
      await scheduleMerge(ctx, q, chunk.user_id);
      return rows;
    });
    await finishChunk(ctx, chunk, "transcribed", null);
    announceSegments(ctx, stream, inserted);
  },

  async onFailed(ctx: Ctx, job: JobRow, err: unknown): Promise<void> {
    const chunk = await one<AudioChunkRow>(ctx.db, "SELECT * FROM audio_chunks WHERE id = $1", [
      String(job.payload.chunkId ?? ""),
    ]);
    if (!chunk) return;
    const code = isProviderError(err) ? err.code : "error";
    await finishChunk(ctx, chunk, "failed", `Speech-to-text failed (${code}).`);
    // Let conversations waiting on this window close.
    await scheduleMerge(ctx, ctx.db, chunk.user_id);
  },
};
