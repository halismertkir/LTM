import { randomUUID } from "node:crypto";
import type {
  AudioSource,
  SegmentOrigin,
  SpeakerHint,
  StreamContext,
  StreamInfo,
  StreamMode,
  TranscriptSegment,
} from "@ltm/protocol";
import { type Ctx, iso, isoOrNull } from "../context.js";
import { sha256Hex } from "../crypto.js";
import { json, one, type Queryable } from "../db/types.js";
import { conflict, forbidden } from "../errors.js";
import type { DeviceRow } from "./users.js";

export interface StreamRow {
  id: string;
  user_id: string;
  device_id: string;
  source: AudioSource;
  mode: StreamMode;
  language: string | null;
  context: StreamContext | null;
  started_at: number;
  ended_at: number | null;
  last_activity_at: number;
  clock_offset_ms: number;
  next_window_seq: number;
}

export interface RawSegmentRow {
  id: string;
  user_id: string;
  stream_id: string;
  device_id: string;
  source: AudioSource;
  origin: SegmentOrigin;
  start_ms: number;
  end_ms: number;
  text: string;
  confidence: number | null;
  language: string | null;
  speaker: SpeakerHint | null;
  client_key: string | null;
  audio_chunk_id: string | null;
  conversation_id: string | null;
  created_at: number;
}

/**
 * Server-minus-device offset to apply, estimated from a device "now". Small offsets are
 * measurement noise (network latency, jitter) that the merge tolerance absorbs anyway.
 */
export function appliedOffset(
  ctx: Ctx,
  clientTimeMs: number,
  serverNowMs = ctx.clock.now(),
): number {
  const raw = serverNowMs - clientTimeMs;
  return Math.abs(raw) > ctx.config.tuning.clockOffsetThresholdMs ? Math.round(raw) : 0;
}

export async function getStream(q: Queryable, streamId: string): Promise<StreamRow | null> {
  return one<StreamRow>(q, "SELECT * FROM streams WHERE id = $1", [streamId]);
}

/**
 * Creates the stream or re-opens it for the same device. A stream id belonging to another
 * device or user is refused (stream ids are client-chosen, so they must not be trusted).
 */
export async function openStream(
  ctx: Ctx,
  q: Queryable,
  input: {
    streamId: string;
    device: DeviceRow;
    source: AudioSource;
    mode: StreamMode;
    language?: string | undefined;
    context?: StreamContext | undefined;
    offsetMs: number;
  },
): Promise<{ stream: StreamRow; created: boolean }> {
  const now = ctx.clock.now();
  const existing = await one<StreamRow>(q, "SELECT * FROM streams WHERE id = $1 FOR UPDATE", [
    input.streamId,
  ]);
  if (existing) {
    if (existing.user_id !== input.device.user_id || existing.device_id !== input.device.id) {
      throw forbidden("This stream id belongs to another device.");
    }
    if (existing.mode !== input.mode)
      throw conflict(`Stream ${input.streamId} was opened in ${existing.mode} mode.`);
    const rows = await q.query<StreamRow>(
      `UPDATE streams SET ended_at = NULL, last_activity_at = $2, clock_offset_ms = $3,
              language = COALESCE($4, language), context = COALESCE($5::jsonb, context)
       WHERE id = $1 RETURNING *`,
      [
        input.streamId,
        now,
        input.offsetMs,
        input.language ?? null,
        input.context ? json(input.context) : null,
      ],
    );
    return { stream: rows[0]!, created: false };
  }
  const rows = await q.query<StreamRow>(
    `INSERT INTO streams (id, user_id, device_id, source, mode, language, context, started_at, last_activity_at, clock_offset_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8, $9) RETURNING *`,
    [
      input.streamId,
      input.device.user_id,
      input.device.id,
      input.source,
      input.mode,
      input.language ?? null,
      input.context ? json(input.context) : null,
      now,
      input.offsetMs,
    ],
  );
  return { stream: rows[0]!, created: true };
}

export async function touchStream(
  ctx: Ctx,
  q: Queryable,
  streamId: string,
  offsetMs?: number,
): Promise<void> {
  if (offsetMs === undefined) {
    await q.query("UPDATE streams SET last_activity_at = $2 WHERE id = $1", [
      streamId,
      ctx.clock.now(),
    ]);
  } else {
    await q.query("UPDATE streams SET last_activity_at = $2, clock_offset_ms = $3 WHERE id = $1", [
      streamId,
      ctx.clock.now(),
      offsetMs,
    ]);
  }
}

export async function scheduleMerge(
  ctx: Ctx,
  q: Queryable,
  userId: string,
  delayMs = ctx.config.tuning.mergeDebounceMs,
): Promise<void> {
  await ctx.jobs.enqueue(q, {
    kind: "merge",
    userId,
    dedupeKey: `merge:${userId}`,
    runAt: ctx.clock.now() + delayMs,
  });
}

export async function endStream(ctx: Ctx, stream: StreamRow): Promise<void> {
  if (stream.ended_at === null) {
    await ctx.db.query("UPDATE streams SET ended_at = $2, last_activity_at = $2 WHERE id = $1", [
      stream.id,
      ctx.clock.now(),
    ]);
    ctx.bus.publish(stream.user_id, { type: "stream_ended", streamId: stream.id });
  }
  await scheduleMerge(ctx, ctx.db, stream.user_id);
}

export function streamActive(
  ctx: Ctx,
  s: Pick<StreamRow, "id" | "ended_at" | "last_activity_at">,
): boolean {
  if (s.ended_at !== null) return false;
  return (
    ctx.live.isStreamConnected(s.id) ||
    ctx.clock.now() - s.last_activity_at < ctx.config.tuning.streamIdleMs
  );
}

export function streamInfoDto(ctx: Ctx, s: StreamRow, deviceName: string | null): StreamInfo {
  return {
    id: s.id,
    deviceId: s.device_id,
    deviceName: deviceName ?? "Removed device",
    source: s.source,
    mode: s.mode,
    startedAt: iso(s.started_at),
    endedAt: isoOrNull(s.ended_at),
    active: streamActive(ctx, s),
    context: s.context ?? null,
  };
}

export type LiveSegment = TranscriptSegment & { origin: SegmentOrigin };

function segmentEvent(row: RawSegmentRow, offsetMs: number): LiveSegment {
  const seg: LiveSegment = {
    id: row.id,
    startMs: Math.max(0, row.start_ms - offsetMs),
    endMs: Math.max(0, row.end_ms - offsetMs),
    text: row.text,
    origin: row.origin,
  };
  if (row.confidence !== null) seg.confidence = row.confidence;
  if (row.language) seg.language = row.language;
  if (row.speaker) seg.speaker = row.speaker;
  return seg;
}

/** Publishes new segments to the web app (server clock) and echoes them to the capturing socket (device clock). */
export function announceSegments(ctx: Ctx, stream: StreamRow, rows: RawSegmentRow[]): void {
  for (const row of rows) {
    ctx.bus.publish(stream.user_id, {
      type: "segment",
      streamId: stream.id,
      deviceId: stream.device_id,
      segment: segmentEvent(row, 0),
    });
    ctx.live.sendSegment(stream.id, {
      type: "segment",
      segment: segmentEvent(row, stream.clock_offset_ms),
    });
  }
}

/** Idempotency key for an edge segment: the client id, else a hash of its content. */
function edgeKey(s: TranscriptSegment): string {
  if (s.id) return `c:${s.id}`;
  return `h:${sha256Hex(`${s.startMs}|${s.endMs}|${s.text}`).slice(0, 32)}`;
}

/** Stores on-device transcript segments idempotently. */
export async function storeEdgeSegments(
  ctx: Ctx,
  stream: StreamRow,
  segments: TranscriptSegment[],
  offsetMs: number,
): Promise<{ accepted: number; duplicates: number }> {
  const now = ctx.clock.now();
  const inserted = await ctx.db.tx(async (q) => {
    const out: RawSegmentRow[] = [];
    for (const s of segments) {
      const start = s.startMs + offsetMs;
      const end = Math.max(start, s.endMs + offsetMs);
      const rows = await q.query<RawSegmentRow>(
        `INSERT INTO raw_segments (id, user_id, stream_id, device_id, source, origin, start_ms, end_ms, text, confidence, language, speaker, client_key, created_at)
         VALUES ($1, $2, $3, $4, $5, 'edge_stt', $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (stream_id, client_key) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          stream.user_id,
          stream.id,
          stream.device_id,
          stream.source,
          start,
          end,
          s.text.trim(),
          s.confidence ?? null,
          s.language ?? stream.language ?? null,
          s.speaker ?? null,
          edgeKey(s),
          now,
        ],
      );
      if (rows[0]) out.push(rows[0]);
    }
    await touchStream(ctx, q, stream.id, offsetMs);
    if (out.length > 0) await scheduleMerge(ctx, q, stream.user_id);
    return out;
  });
  announceSegments(ctx, { ...stream, clock_offset_ms: offsetMs }, inserted);
  return { accepted: inserted.length, duplicates: segments.length - inserted.length };
}
