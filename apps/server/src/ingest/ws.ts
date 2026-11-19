import { randomUUID } from "node:crypto";
import { PcmSegmenter, pcmToWav, type SpeechWindow } from "@ltm/core";
import {
  type AudioFormat,
  type ClientHello,
  decodeAudioFrame,
  type ErrorCode,
  FrameError,
  PROTOCOL_VERSION,
  type ServerMessage,
  type ServerSegment,
  WS_CLOSE,
  zClientHello,
  zClientMessage,
} from "@ltm/protocol";
import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { Ctx, LiveIngest } from "../context.js";
import { ApiError } from "../errors.js";
import { ingestRefusal } from "../services/consent.js";
import {
  appliedOffset,
  endStream,
  getStream,
  openStream,
  type StreamRow,
  storeEdgeSegments,
  touchStream,
} from "../services/ingest.js";
import { resolveProviders } from "../services/settings.js";
import { resolveToken, type UserRow } from "../services/users.js";

/** Queued messages per socket before reading is paused (back-pressure). */
const PAUSE_AT = 64;
const RESUME_AT = 16;
/** Audio may arrive faster than real time (catch-up after a reconnect) but not without bound. */
const MAX_SPEEDUP = 4;
const BURST_MS = 120_000;
/** Consecutive undecodable frames tolerated before the socket is dropped. */
const MAX_BAD_FRAMES = 20;

/**
 * State of one ingest stream. It outlives a dropped socket for the grace period so a
 * reconnect with the same streamId continues the same speech window.
 */
class StreamSession {
  conn: Connection | null = null;
  segmenter: PcmSegmenter | null = null;
  format: AudioFormat | null = null;
  graceTimer: NodeJS.Timeout | null = null;
  offsetMs: number;
  /** Serialises window writes so seq numbers and files stay in order. */
  writes: Promise<void> = Promise.resolve();
  audioMs = 0;
  firstAudioAt = 0;

  constructor(
    public stream: StreamRow,
    public user: UserRow,
  ) {
    this.offsetMs = stream.clock_offset_ms;
  }
}

export class WsRegistry implements LiveIngest {
  readonly sessions = new Map<string, StreamSession>();
  private closing = false;

  constructor(private readonly ctx: Ctx) {}

  sendSegment(streamId: string, message: ServerSegment): void {
    this.sessions.get(streamId)?.conn?.send(message);
  }

  refuseUser(
    userId: string,
    code: "consent_required" | "ingest_paused" | "unauthorized",
    message: string,
  ): void {
    for (const s of [...this.sessions.values()]) {
      if (s.user.id !== userId) continue;
      const close = code === "unauthorized" ? WS_CLOSE.UNAUTHORIZED : WS_CLOSE.FORBIDDEN;
      s.conn?.fail(code, message, close);
      void this.finalize(s);
    }
  }

  dropDevice(deviceId: string): void {
    for (const s of [...this.sessions.values()]) {
      if (s.stream.device_id !== deviceId) continue;
      s.conn?.fail("unauthorized", "This device has been removed.", WS_CLOSE.UNAUTHORIZED);
      void this.finalize(s);
    }
  }

  isStreamConnected(streamId: string): boolean {
    return !!this.sessions.get(streamId)?.conn;
  }

  connectedDeviceIds(userId: string): Set<string> {
    const out = new Set<string>();
    for (const s of this.sessions.values())
      if (s.user.id === userId && s.conn) out.add(s.stream.device_id);
    return out;
  }

  /** Writes a speech window as WAV and queues its transcription. */
  private writeWindow(s: StreamSession, w: SpeechWindow): Promise<void> {
    const ctx = this.ctx;
    s.writes = s.writes.then(async () => {
      try {
        const chunkId = randomUUID();
        const rel = ctx.audio.relPath(s.user.id, s.stream.id, chunkId, "audio/wav");
        const wav = pcmToWav(w.pcm, w.sampleRate, 1);
        await ctx.audio.write(rel, wav);
        try {
          await ctx.db.tx(async (q) => {
            const seqRow = await q.query<{ seq: number }>(
              "UPDATE streams SET next_window_seq = next_window_seq + 1, last_activity_at = $2 WHERE id = $1 RETURNING next_window_seq - 1 AS seq",
              [s.stream.id, ctx.clock.now()],
            );
            const seq = seqRow[0]?.seq;
            if (seq === undefined) throw new Error("stream vanished");
            await q.query(
              `INSERT INTO audio_chunks (id, user_id, stream_id, kind, seq, path, mime_type, size_bytes, start_ms, duration_ms, language, status, created_at)
               VALUES ($1, $2, $3, 'window', $4, $5, 'audio/wav', $6, $7, $8, $9, 'pending', $10)`,
              [
                chunkId,
                s.user.id,
                s.stream.id,
                seq,
                rel,
                wav.byteLength,
                Math.round(w.startMs),
                Math.round(w.endMs - w.startMs),
                s.stream.language,
                ctx.clock.now(),
              ],
            );
            await ctx.jobs.enqueue(q, {
              kind: "transcribe",
              userId: s.user.id,
              payload: { chunkId },
            });
          });
        } catch (err) {
          await ctx.audio.remove(rel);
          throw err;
        }
      } catch (err) {
        ctx.log.error(
          { err: (err as Error).message, streamId: s.stream.id },
          "could not store speech window",
        );
      }
    });
    return s.writes;
  }

  pushAudio(
    s: StreamSession,
    payload: Uint8Array,
    captureTimeMs: number,
    discontinuity: boolean,
  ): void {
    if (!s.segmenter) return;
    for (const w of s.segmenter.push(payload, captureTimeMs + s.offsetMs, discontinuity))
      void this.writeWindow(s, w);
  }

  private async flush(s: StreamSession): Promise<void> {
    if (s.segmenter) for (const w of s.segmenter.flush()) void this.writeWindow(s, w);
    await s.writes;
  }

  /** Flushes buffered audio and marks the stream ended. Idempotent. */
  async finalize(s: StreamSession): Promise<void> {
    if (this.sessions.get(s.stream.id) !== s) return;
    this.sessions.delete(s.stream.id);
    if (s.graceTimer) clearTimeout(s.graceTimer);
    await this.flush(s);
    const fresh = await getStream(this.ctx.db, s.stream.id).catch(() => null);
    if (fresh)
      await endStream(this.ctx, fresh).catch((err) =>
        this.ctx.log.error({ err: (err as Error).message }, "could not end stream"),
      );
  }

  /** Called by `POST /ingest/streams/:id/end`. */
  async finish(streamId: string): Promise<void> {
    const s = this.sessions.get(streamId);
    if (!s) return;
    s.conn?.send({ type: "closed", streamId });
    s.conn?.close(WS_CLOSE.NORMAL, "stream ended");
    await this.finalize(s);
  }

  attach(
    conn: Connection,
    stream: StreamRow,
    user: UserRow,
    format: AudioFormat | null,
  ): { session: StreamSession; resumed: boolean } {
    let s = this.sessions.get(stream.id);
    const resumed = !!s;
    if (s) {
      if (s.graceTimer) clearTimeout(s.graceTimer);
      s.graceTimer = null;
      if (s.conn && s.conn !== conn) s.conn.close(WS_CLOSE.NORMAL, "resumed on another connection");
      s.stream = stream;
      s.user = user;
    } else {
      s = new StreamSession(stream, user);
      this.sessions.set(stream.id, s);
    }
    s.conn = conn;
    s.offsetMs = stream.clock_offset_ms;
    if (format) {
      const same =
        s.format &&
        s.format.sampleRate === format.sampleRate &&
        s.format.channels === format.channels;
      if (!same) {
        if (s.segmenter) for (const w of s.segmenter.flush()) void this.writeWindow(s, w);
        s.segmenter = new PcmSegmenter({
          sampleRate: format.sampleRate,
          channels: format.channels,
        });
        s.format = format;
      }
    }
    return { session: s, resumed };
  }

  /** Socket dropped without `end`: keep the session resumable for the grace period. */
  detach(conn: Connection, s: StreamSession): void {
    if (s.conn !== conn || this.sessions.get(s.stream.id) !== s) return;
    s.conn = null;
    if (this.closing) return;
    s.graceTimer = setTimeout(() => void this.finalize(s), this.ctx.config.tuning.wsGraceMs);
    s.graceTimer.unref();
  }

  /** Server shutdown: flush everything, close sockets as "going away"; streams stay resumable. */
  async shutdown(): Promise<void> {
    this.closing = true;
    const all = [...this.sessions.values()];
    for (const s of all) {
      if (s.graceTimer) clearTimeout(s.graceTimer);
      s.conn?.close(1001, "server shutting down");
      await this.flush(s);
    }
    this.sessions.clear();
  }
}

/** One WebSocket connection; at most one stream. */
class Connection {
  private state: "hello" | "ready" | "closed" = "hello";
  private helloTimer: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private paused = false;
  private session: StreamSession | null = null;
  private mode: "audio" | "transcript" = "audio";
  private badFrames = 0;

  constructor(
    private readonly ctx: Ctx,
    private readonly registry: WsRegistry,
    private readonly socket: WebSocket,
    private readonly ip: string,
  ) {
    this.helloTimer = setTimeout(
      () =>
        this.fail(
          "bad_request",
          `No hello within ${Math.round(ctx.config.tuning.helloTimeoutMs / 1000)} s.`,
          WS_CLOSE.HELLO_TIMEOUT,
        ),
      ctx.config.tuning.helloTimeoutMs,
    );
    socket.on("message", (data, isBinary) =>
      this.enqueue(data as Buffer | Buffer[] | ArrayBuffer, isBinary),
    );
    socket.on("close", () => this.onClose());
    socket.on("error", (err) => ctx.log.debug({ err: err.message }, "ingest socket error"));
  }

  send(msg: ServerMessage): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  close(code: number, reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.helloTimer);
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  fail(code: ErrorCode, message: string, closeCode: number): void {
    if (this.state === "closed") return;
    this.send({ type: "error", code, message, fatal: true });
    this.close(closeCode, message.slice(0, 120));
  }

  private warn(code: ErrorCode, message: string): void {
    this.send({ type: "error", code, message, fatal: false });
  }

  private enqueue(data: Buffer | Buffer[] | ArrayBuffer, isBinary: boolean): void {
    if (this.state === "closed") return;
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    this.queued++;
    if (this.queued >= PAUSE_AT && !this.paused) {
      this.paused = true;
      this.socket.pause();
    }
    this.queue = this.queue
      .then(() => (this.state === "closed" ? undefined : this.handle(buf, isBinary)))
      .catch((err) => {
        this.ctx.log.error({ err: (err as Error).message }, "ingest message handling failed");
        this.fail("internal", "Internal error.", WS_CLOSE.PROTOCOL_ERROR);
      })
      .finally(() => {
        this.queued--;
        if (this.paused && this.queued <= RESUME_AT) {
          this.paused = false;
          this.socket.resume();
        }
      });
  }

  private async handle(buf: Buffer, isBinary: boolean): Promise<void> {
    if (this.state === "hello") {
      if (isBinary)
        return this.fail(
          "bad_request",
          "The first message must be hello.",
          WS_CLOSE.PROTOCOL_ERROR,
        );
      return this.onHello(buf.toString("utf8"));
    }
    const s = this.session;
    if (!s) return;
    if (isBinary) return this.onFrame(s, buf);
    let json: unknown;
    try {
      json = JSON.parse(buf.toString("utf8"));
    } catch {
      return this.warn("bad_request", "Text messages must be JSON.");
    }
    const parsed = zClientMessage.safeParse(json);
    if (!parsed.success) return this.warn("bad_request", "Unknown or invalid message.");
    const msg = parsed.data;
    switch (msg.type) {
      case "hello":
        return this.warn("bad_request", "Already initialised; one stream per socket.");
      case "ping": {
        const now = this.ctx.clock.now();
        this.send({ type: "pong", clientTimeMs: msg.clientTimeMs, serverTimeMs: now });
        const offset = appliedOffset(this.ctx, msg.clientTimeMs, now);
        // Only follow real clock changes; jitter would make window timestamps jump.
        if (Math.abs(offset - s.offsetMs) > this.ctx.config.tuning.clockOffsetThresholdMs) {
          s.offsetMs = offset;
          s.stream.clock_offset_ms = offset;
          await touchStream(this.ctx, this.ctx.db, s.stream.id, offset);
        }
        return;
      }
      case "transcript": {
        if (this.mode !== "transcript")
          return this.warn("bad_request", "This stream is in audio mode.");
        const refusal = await ingestRefusal(this.ctx, this.ctx.db, s.user);
        if (refusal) return this.fail(refusal.code, refusal.message, WS_CLOSE.FORBIDDEN);
        await storeEdgeSegments(this.ctx, s.stream, msg.segments, s.offsetMs);
        return;
      }
      case "end": {
        const streamId = s.stream.id;
        await this.registry.finalize(s);
        this.send({ type: "closed", streamId });
        this.close(WS_CLOSE.NORMAL, "stream ended");
        return;
      }
    }
  }

  private async onHello(text: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return this.fail("bad_request", "hello must be JSON.", WS_CLOSE.PROTOCOL_ERROR);
    }
    const t = (json as { type?: unknown })?.type;
    if (t !== "hello")
      return this.fail("bad_request", "The first message must be hello.", WS_CLOSE.PROTOCOL_ERROR);
    const proto = (json as { protocol?: unknown }).protocol;
    if (proto !== PROTOCOL_VERSION) {
      return this.fail(
        "unsupported_protocol",
        `This server speaks protocol ${PROTOCOL_VERSION}.`,
        WS_CLOSE.PROTOCOL_ERROR,
      );
    }
    const parsed = zClientHello.safeParse(json);
    if (!parsed.success) {
      return this.fail(
        "bad_request",
        `Invalid hello: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
        WS_CLOSE.PROTOCOL_ERROR,
      );
    }
    const hello: ClientHello = parsed.data;
    const principal = await resolveToken(this.ctx, hello.token);
    if (!principal)
      return this.fail("unauthorized", "Invalid or revoked device token.", WS_CLOSE.UNAUTHORIZED);
    if (principal.type !== "device")
      return this.fail("forbidden", "A device token is required.", WS_CLOSE.FORBIDDEN);
    if (hello.mode === "audio") {
      if (!hello.audio)
        return this.fail(
          "bad_request",
          "Audio streams must declare their audio format.",
          WS_CLOSE.PROTOCOL_ERROR,
        );
      if (hello.audio.codec !== "pcm_s16le")
        return this.fail(
          "unsupported_codec",
          "Only pcm_s16le is supported.",
          WS_CLOSE.PROTOCOL_ERROR,
        );
    }
    const refusal = await ingestRefusal(this.ctx, this.ctx.db, principal.user);
    if (refusal) return this.fail(refusal.code, refusal.message, WS_CLOSE.FORBIDDEN);
    if (this.state !== "hello") return;

    const now = this.ctx.clock.now();
    let stream: StreamRow;
    let created: boolean;
    try {
      ({ stream, created } = await this.ctx.db.tx((q) =>
        openStream(this.ctx, q, {
          streamId: hello.streamId,
          device: principal.device,
          source: hello.source,
          mode: hello.mode,
          language: hello.language,
          context: hello.context,
          offsetMs: appliedOffset(this.ctx, hello.clientTimeMs, now),
        }),
      ));
    } catch (err) {
      if (err instanceof ApiError) return this.fail(err.code, err.message, WS_CLOSE.FORBIDDEN);
      throw err;
    }
    clearTimeout(this.helloTimer);
    this.mode = hello.mode;
    const { session, resumed } = this.registry.attach(
      this,
      stream,
      principal.user,
      hello.mode === "audio" ? hello.audio! : null,
    );
    this.session = session;
    this.state = "ready";
    this.send({
      type: "ready",
      streamId: stream.id,
      serverTimeMs: now,
      resumed: resumed || !created,
    });
    this.ctx.log.info(
      {
        streamId: stream.id,
        deviceId: stream.device_id,
        source: stream.source,
        mode: stream.mode,
        resumed,
        ip: this.ip,
      },
      "ingest stream ready",
    );
    if (created || !resumed) {
      const deviceName = principal.device.name;
      this.ctx.bus.publish(principal.user.id, {
        type: "stream_started",
        stream: {
          id: stream.id,
          deviceId: stream.device_id,
          deviceName,
          source: stream.source,
          mode: stream.mode,
          startedAt: new Date(stream.started_at).toISOString(),
          endedAt: null,
          active: true,
          context: stream.context ?? null,
        },
      });
    }
    if (hello.mode === "audio") {
      const { stt } = await resolveProviders(this.ctx, principal.user, ["stt"]);
      if (!stt) {
        this.warn(
          "provider_not_configured",
          "No speech-to-text provider is configured; audio is kept on the server and transcribed once one is set up.",
        );
      }
    }
  }

  private onFrame(s: StreamSession, buf: Buffer): void {
    if (this.mode !== "audio") {
      this.warn("bad_request", "Binary frames are only accepted in audio mode.");
      return;
    }
    let frame: ReturnType<typeof decodeAudioFrame>;
    try {
      frame = decodeAudioFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    } catch (err) {
      if (!(err instanceof FrameError)) throw err;
      this.badFrames++;
      if (this.badFrames > MAX_BAD_FRAMES) {
        this.fail("bad_request", "Too many invalid frames.", WS_CLOSE.PROTOCOL_ERROR);
      } else {
        this.warn("bad_request", `Invalid frame: ${err.message}`);
      }
      return;
    }
    this.badFrames = 0;
    const fmt = s.format!;
    const bytesPerMs = (fmt.sampleRate * fmt.channels * 2) / 1000;
    const now = Date.now();
    if (s.firstAudioAt === 0) s.firstAudioAt = now;
    s.audioMs += frame.payload.byteLength / bytesPerMs;
    if (s.audioMs > (now - s.firstAudioAt) * MAX_SPEEDUP + BURST_MS) {
      this.fail(
        "rate_limited",
        "Audio is arriving much faster than real time.",
        WS_CLOSE.PROTOCOL_ERROR,
      );
      return;
    }
    this.registry.pushAudio(s, frame.payload, frame.captureTimeMs, frame.discontinuity);
  }

  private onClose(): void {
    this.state = "closed";
    clearTimeout(this.helloTimer);
    if (this.session) this.registry.detach(this, this.session);
  }
}

export function wsHandler(ctx: Ctx, registry: WsRegistry) {
  return (socket: WebSocket, req: FastifyRequest) => {
    new Connection(ctx, registry, socket, req.ip);
  };
}
