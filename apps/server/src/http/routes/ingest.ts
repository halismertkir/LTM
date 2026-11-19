import { randomUUID } from "node:crypto";
import {
  CHUNK_MIME_TYPES,
  type ChunkAccepted,
  ROUTES,
  type TranscriptAccepted,
  zChunkMeta,
  zTranscriptBatch,
  zUuid,
} from "@ltm/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Ctx } from "../../context.js";
import { one } from "../../db/types.js";
import { ApiError, badRequest, forbidden, notFound } from "../../errors.js";
import { type WsRegistry, wsHandler } from "../../ingest/ws.js";
import { ingestRefusal } from "../../services/consent.js";
import {
  appliedOffset,
  endStream,
  getStream,
  openStream,
  storeEdgeSegments,
} from "../../services/ingest.js";
import type { UserRow } from "../../services/users.js";
import { deviceOf, parse } from "../plumbing.js";

export async function assertIngestAllowed(ctx: Ctx, user: UserRow): Promise<void> {
  const refusal = await ingestRefusal(ctx, ctx.db, user);
  if (refusal) throw new ApiError(403, refusal.code, refusal.message);
}

function normalizeMime(raw: string | undefined): string | null {
  if (!raw) return null;
  const base = raw.split(";")[0]!.trim().toLowerCase();
  return (CHUNK_MIME_TYPES as readonly string[]).includes(base) ? base : null;
}

export async function ingestRoutes(app: FastifyInstance, ctx: Ctx, ws: WsRegistry): Promise<void> {
  app.get(ROUTES.ingestWs, { websocket: true, config: { access: "public" } }, wsHandler(ctx, ws));

  app.post(
    ROUTES.ingestChunks,
    { config: { access: "device" } },
    async (req, reply): Promise<ChunkAccepted> => {
      const { user, device } = deviceOf(req);
      await assertIngestAllowed(ctx, user);
      if (!req.isMultipart())
        throw new ApiError(
          415,
          "bad_request",
          'Send multipart/form-data with a "meta" field and an "audio" file.',
        );
      let metaRaw: string | null = null;
      let audio: Buffer | null = null;
      let mimeRaw: string | undefined;
      for await (const part of req.parts()) {
        if (part.type === "field" && part.fieldname === "meta") metaRaw = String(part.value);
        else if (part.type === "file" && part.fieldname === "audio" && audio === null) {
          mimeRaw = part.mimetype;
          audio = await part.toBuffer();
        } else if (part.type === "file") {
          await part.toBuffer();
        }
      }
      if (metaRaw === null) throw badRequest('Missing "meta" field.');
      if (!audio || audio.length === 0) throw badRequest('Missing "audio" file.');
      let metaJson: unknown;
      try {
        metaJson = JSON.parse(metaRaw);
      } catch {
        throw badRequest('"meta" is not valid JSON.');
      }
      const meta = parse(zChunkMeta, metaJson);
      const mime = normalizeMime(mimeRaw);
      if (!mime)
        throw new ApiError(
          415,
          "unsupported_codec",
          `Unsupported audio type; use one of ${CHUNK_MIME_TYPES.join(", ")}.`,
        );

      const existingStream = await getStream(ctx.db, meta.streamId);
      if (
        existingStream &&
        (existingStream.user_id !== user.id || existingStream.device_id !== device.id)
      ) {
        throw forbidden("This stream id belongs to another device.");
      }
      if (existingStream) {
        const dup = await one(
          ctx.db,
          "SELECT 1 FROM audio_chunks WHERE stream_id = $1 AND kind = 'chunk' AND seq = $2",
          [meta.streamId, meta.seq],
        );
        if (dup) return { streamId: meta.streamId, seq: meta.seq, created: false };
      }

      // Long-delayed uploads: the device clock drifts slowly, so the upload moment is a fine estimate.
      const offset = appliedOffset(ctx, meta.clientTimeMs);
      const chunkId = randomUUID();
      const rel = ctx.audio.relPath(user.id, meta.streamId, chunkId, mime);
      await ctx.audio.write(rel, audio);
      let created: boolean;
      try {
        created = await ctx.db.tx(async (q) => {
          const { stream } = await openStream(ctx, q, {
            streamId: meta.streamId,
            device,
            source: meta.source,
            mode: "audio",
            language: meta.language,
            context: meta.context,
            offsetMs: offset,
          });
          const rows = await q.query(
            `INSERT INTO audio_chunks (id, user_id, stream_id, kind, seq, path, mime_type, size_bytes, start_ms, duration_ms, language, status, created_at)
         VALUES ($1, $2, $3, 'chunk', $4, $5, $6, $7, $8, $9, $10, 'pending', $11)
         ON CONFLICT (stream_id, kind, seq) DO NOTHING RETURNING id`,
            [
              chunkId,
              user.id,
              stream.id,
              meta.seq,
              rel,
              mime,
              audio!.length,
              meta.startMs + offset,
              meta.durationMs,
              meta.language ?? null,
              ctx.clock.now(),
            ],
          );
          if (rows.length === 0) return false;
          await ctx.jobs.enqueue(q, { kind: "transcribe", userId: user.id, payload: { chunkId } });
          return true;
        });
      } catch (err) {
        await ctx.audio.remove(rel);
        throw err;
      }
      if (!created) await ctx.audio.remove(rel);
      const stream = await getStream(ctx.db, meta.streamId);
      if (meta.final && stream) await endStream(ctx, stream);
      reply.code(created ? 201 : 200);
      return { streamId: meta.streamId, seq: meta.seq, created };
    },
  );

  app.post(
    ROUTES.ingestTranscripts,
    { config: { access: "device" } },
    async (req): Promise<TranscriptAccepted> => {
      const { user, device } = deviceOf(req);
      await assertIngestAllowed(ctx, user);
      const body = parse(zTranscriptBatch, req.body);
      const offset = appliedOffset(ctx, body.clientTimeMs);
      const { stream } = await ctx.db.tx((q) =>
        openStream(ctx, q, {
          streamId: body.streamId,
          device,
          source: body.source,
          mode: "transcript",
          context: body.context,
          offsetMs: offset,
        }),
      );
      const res = await storeEdgeSegments(ctx, stream, body.segments, offset);
      if (body.final) await endStream(ctx, (await getStream(ctx.db, stream.id)) ?? stream);
      return { streamId: body.streamId, ...res };
    },
  );

  app.post(ROUTES.ingestStreamEnd, { config: { access: "device" } }, async (req, reply) => {
    const { user, device } = deviceOf(req);
    const { streamId } = parse(z.object({ streamId: zUuid }), req.params);
    const stream = await getStream(ctx.db, streamId);
    if (!stream || stream.user_id !== user.id || stream.device_id !== device.id)
      throw notFound("Stream not found.");
    // A socket still holding buffered audio for this stream is flushed first.
    await ws.finish(streamId);
    await endStream(ctx, (await getStream(ctx.db, streamId)) ?? stream);
    return reply.code(204).send();
  });
}
