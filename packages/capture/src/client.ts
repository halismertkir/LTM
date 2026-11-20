import {
  type AudioFormat,
  type AudioSource,
  type ClientHello,
  type ErrorCode,
  encodeAudioFrame,
  PROTOCOL_VERSION,
  type ServerSegment,
  type StreamContext,
  type StreamMode,
  type TranscriptSegment,
  WS_CLOSE,
  zClientHello,
  zServerMessage,
} from "@ltm/protocol";
import { type BackoffOptions, backoffDelay, DEFAULT_BACKOFF } from "./backoff.js";

/** The subset of the WebSocket API the client uses — lets tests and Node supply their own. */
export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string; wasClean?: boolean }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;

/**
 * The runtime's own WebSocket. Every target runtime has one as a global (browsers, workers,
 * Node 22+); its handler typings differ slightly from WebSocketLike, hence the cast.
 */
export const globalWebSocketFactory: WebSocketFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!Ctor) throw new Error("no global WebSocket in this runtime; pass createSocket");
  return new Ctor(url) as WebSocketLike;
};

export type StreamPhase =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "ending"
  | "closed"
  | "failed";

export type StreamErrorCode = ErrorCode | "transport" | "timeout";

export type StreamEvent =
  | { type: "phase"; phase: StreamPhase; bufferedMs: number; attempt: number; retryInMs?: number }
  | { type: "ready"; resumed: boolean; serverTimeMs: number }
  | { type: "segment"; segment: ServerSegment["segment"] }
  | { type: "error"; code: StreamErrorCode; message: string; fatal: boolean }
  | { type: "clock"; offsetMs: number; rttMs: number }
  | { type: "dropped"; frames: number; ms: number }
  | { type: "closed"; reason: "ended" | "fatal" | "aborted"; code?: StreamErrorCode };

/**
 * Server error codes after which retrying with the same credentials cannot succeed. Anything
 * else (rate limiting, an internal error, a `conflict` because the old socket of this stream
 * is still being torn down) is retried with back-off.
 */
export const PERMANENT_ERRORS: ReadonlySet<StreamErrorCode> = new Set<StreamErrorCode>([
  "unauthorized",
  "forbidden",
  "consent_required",
  "ingest_paused",
  "unsupported_protocol",
  "unsupported_codec",
  "bad_request",
  "setup_required",
  "not_found",
  "payload_too_large",
  "provider_not_configured",
]);

export interface StreamClientOptions {
  url: string;
  token: string;
  streamId: string;
  source: AudioSource;
  mode: StreamMode;
  /** Required for mode "audio". */
  audio?: AudioFormat;
  language?: string;
  context?: StreamContext;
  /** Defaults to the global `WebSocket` (browsers, workers, Node 22+). */
  createSocket?: WebSocketFactory;
  onEvent?: (event: StreamEvent) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  pingIntervalMs?: number;
  /** Time allowed between opening the socket and `ready`. */
  readyTimeoutMs?: number;
  /** No message at all for this long (pongs included) → the socket is presumed dead. */
  livenessTimeoutMs?: number;
  /** Total time `end()` may take (flush + `closed`) before the socket is just closed. */
  endTimeoutMs?: number;
  /** Audio kept while disconnected; older frames are dropped. */
  maxBufferedMs?: number;
  /** Transcript segments kept while disconnected (mode "transcript"). */
  maxBufferedSegments?: number;
  /** Stop writing into the socket above this many unsent bytes (backpressure). */
  maxSocketBufferedBytes?: number;
  backoff?: BackoffOptions;
}

interface QueuedFrame {
  kind: "audio";
  seq: number;
  captureTimeMs: number;
  discontinuity: boolean;
  payload: Uint8Array;
  durationMs: number;
}
interface QueuedTranscript {
  kind: "transcript";
  segments: TranscriptSegment[];
}
type Queued = QueuedFrame | QueuedTranscript;

const MAX_SEGMENTS_PER_MESSAGE = 200;

/**
 * One ingest stream over one WebSocket (see packages/protocol/src/ws.ts):
 * `hello` (with the token — never in the URL) → wait for `ready` → frames / transcripts,
 * `ping` every ~15 s, `end` → wait for `closed`.
 *
 * Disconnects are retried with exponential back-off and jitter, resuming the same
 * `streamId`. Meanwhile frames are kept in a bounded in-memory queue; when it overflows the
 * oldest audio is dropped and the next frame sent carries the DISCONTINUITY flag. Frames
 * are numbered when they are produced, so `seq` gaps also tell the server what was lost.
 *
 * Frames already handed to a socket that then died are not re-sent: the protocol does not
 * say the server de-duplicates by `seq`, so a re-send could double audio. Instead the next
 * frame is marked as a discontinuity whenever the dead socket still had unsent bytes.
 */
export class StreamClient {
  private readonly o: Required<
    Omit<StreamClientOptions, "audio" | "language" | "context" | "onEvent" | "createSocket">
  > & { createSocket: WebSocketFactory } & Pick<
      StreamClientOptions,
      "audio" | "language" | "context" | "onEvent"
    >;

  private ws: WebSocketLike | null = null;
  private phaseValue: StreamPhase = "idle";
  private attempt = 0;
  private seq = 0;
  private queue: Queued[] = [];
  private queuedMs = 0;
  private queuedSegments = 0;
  private markNextDiscontinuity = false;
  private ending = false;
  private endSent = false;
  private endResolvers: Array<() => void> = [];
  private lastMessageAt = 0;
  private fatalCode: StreamErrorCode | null = null;

  private readyTimer: unknown = null;
  private pingTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private flushTimer: unknown = null;
  private endTimer: unknown = null;

  constructor(options: StreamClientOptions) {
    this.o = {
      now: () => Date.now(),
      random: Math.random,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      pingIntervalMs: 15_000,
      readyTimeoutMs: 10_000,
      livenessTimeoutMs: 45_000,
      endTimeoutMs: 15_000,
      maxBufferedMs: 60_000,
      maxBufferedSegments: 2_000,
      maxSocketBufferedBytes: 512 * 1024,
      backoff: DEFAULT_BACKOFF,
      ...options,
      createSocket: options.createSocket ?? globalWebSocketFactory,
    };
    if (this.o.mode === "audio" && !this.o.audio) throw new Error("audio format required");
  }

  get phase(): StreamPhase {
    return this.phaseValue;
  }

  get streamId(): string {
    return this.o.streamId;
  }

  /** Milliseconds of audio waiting to be sent. */
  get bufferedMs(): number {
    return this.queuedMs;
  }

  start(): void {
    if (this.phaseValue !== "idle") return;
    this.setPhase("connecting");
    this.connect();
  }

  /**
   * Queue one block of PCM. `payload` must already be in the codec announced in `hello`
   * (pcm_s16le). Safe to call in any phase; frames wait until the server said `ready`.
   */
  sendAudio(payload: Uint8Array, captureTimeMs: number, discontinuity = false): void {
    if (this.isFinished() || this.ending) return;
    if (this.o.mode !== "audio" || !this.o.audio) throw new Error("not an audio stream");
    const bytesPerSecond = this.o.audio.sampleRate * this.o.audio.channels * 2;
    const frame: QueuedFrame = {
      kind: "audio",
      seq: this.seq,
      captureTimeMs,
      discontinuity,
      // Copy: the caller may reuse or transfer its buffer.
      payload: payload.slice(),
      durationMs: (payload.byteLength / bytesPerSecond) * 1000,
    };
    this.seq = (this.seq + 1) >>> 0;
    this.enqueue(frame);
  }

  /** Queue on-device transcript segments (mode "transcript"). */
  sendTranscript(segments: TranscriptSegment[]): void {
    if (this.isFinished() || this.ending || segments.length === 0) return;
    if (this.o.mode !== "transcript") throw new Error("not a transcript stream");
    for (let i = 0; i < segments.length; i += MAX_SEGMENTS_PER_MESSAGE) {
      this.enqueue({
        kind: "transcript",
        segments: segments.slice(i, i + MAX_SEGMENTS_PER_MESSAGE),
      });
    }
  }

  /** Segments that never reached a socket (for the REST fallback after a failed `end`). */
  undeliveredSegments(): TranscriptSegment[] {
    return this.queue.flatMap((q) => (q.kind === "transcript" ? q.segments : []));
  }

  /** Flush, send `end`, wait for `closed` (bounded by `endTimeoutMs`). */
  end(): Promise<void> {
    if (this.isFinished()) return Promise.resolve();
    const done = new Promise<void>((resolve) => this.endResolvers.push(resolve));
    if (this.ending) return done;
    this.ending = true;
    this.endTimer = this.o.setTimer(() => {
      this.endTimer = null;
      this.emit({
        type: "error",
        code: "timeout",
        message: "stream end not confirmed",
        fatal: false,
      });
      this.finish("ended");
    }, this.o.endTimeoutMs);
    if (this.phaseValue === "idle") {
      this.finish("ended");
      return done;
    }
    if (this.phaseValue === "ready") {
      this.setPhase("ending");
      this.flush();
    }
    // Otherwise (connecting / reconnecting) the next `ready` flushes and sends `end`.
    return done;
  }

  /** Close immediately without `end` (the server finalises after its grace period). */
  abort(): void {
    if (this.isFinished()) return;
    this.finish("aborted");
  }

  // ------------------------------------------------------------------ internals

  private isFinished(): boolean {
    return this.phaseValue === "closed" || this.phaseValue === "failed";
  }

  private emit(event: StreamEvent): void {
    try {
      this.o.onEvent?.(event);
    } catch {
      // A listener bug must not break the transport.
    }
  }

  private setPhase(phase: StreamPhase, retryInMs?: number): void {
    this.phaseValue = phase;
    const ev: StreamEvent = {
      type: "phase",
      phase,
      bufferedMs: this.queuedMs,
      attempt: this.attempt,
    };
    if (retryInMs !== undefined) ev.retryInMs = retryInMs;
    this.emit(ev);
  }

  private connect(): void {
    let ws: WebSocketLike;
    try {
      ws = this.o.createSocket(this.o.url);
    } catch (err) {
      this.emit({ type: "error", code: "transport", message: String(err), fatal: false });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => this.onOpen(ws);
    ws.onmessage = (ev) => this.onMessage(ws, ev.data);
    ws.onerror = () => {
      // Always followed by `close`; the close handler decides what to do.
    };
    ws.onclose = (ev) => this.onSocketClosed(ws, ev.code, ev.reason);
    this.readyTimer = this.o.setTimer(() => {
      this.readyTimer = null;
      if (this.ws === ws && this.phaseValue !== "ready" && this.phaseValue !== "ending") {
        this.emit({
          type: "error",
          code: "timeout",
          message: "no ready from server",
          fatal: false,
        });
        this.dropSocket(ws);
      }
    }, this.o.readyTimeoutMs);
  }

  private onOpen(ws: WebSocketLike): void {
    if (ws !== this.ws) return;
    const hello: ClientHello = {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      token: this.o.token,
      streamId: this.o.streamId,
      source: this.o.source,
      mode: this.o.mode,
      clientTimeMs: this.o.now(),
    };
    if (this.o.mode === "audio" && this.o.audio) hello.audio = this.o.audio;
    if (this.o.language) hello.language = this.o.language;
    if (this.o.context) hello.context = this.o.context;
    const checked = zClientHello.safeParse(hello);
    if (!checked.success) {
      this.fail("bad_request", `invalid hello: ${checked.error.issues[0]?.message ?? "?"}`);
      return;
    }
    this.lastMessageAt = this.o.now();
    ws.send(JSON.stringify(checked.data));
  }

  private onMessage(ws: WebSocketLike, data: unknown): void {
    if (ws !== this.ws) return;
    this.lastMessageAt = this.o.now();
    if (typeof data !== "string") return; // the server sends no binary messages in v1
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = zServerMessage.safeParse(json);
    if (!parsed.success) return; // tolerate unknown/extended messages from newer servers
    const msg = parsed.data;
    switch (msg.type) {
      case "ready": {
        if (msg.streamId !== this.o.streamId) {
          this.fail("bad_request", "server acknowledged a different stream");
          return;
        }
        if (this.readyTimer !== null) {
          this.o.clearTimer(this.readyTimer);
          this.readyTimer = null;
        }
        this.attempt = 0;
        this.setPhase(this.ending ? "ending" : "ready");
        this.emit({ type: "ready", resumed: msg.resumed, serverTimeMs: msg.serverTimeMs });
        this.startPing();
        this.flush();
        return;
      }
      case "segment":
        this.emit({ type: "segment", segment: msg.segment });
        return;
      case "pong": {
        const now = this.o.now();
        const rtt = Math.max(0, now - msg.clientTimeMs);
        this.emit({
          type: "clock",
          rttMs: rtt,
          offsetMs: msg.serverTimeMs - (msg.clientTimeMs + rtt / 2),
        });
        return;
      }
      case "error": {
        if (msg.fatal && PERMANENT_ERRORS.has(msg.code)) {
          this.fail(msg.code, msg.message); // emits the (single) fatal error event
          return;
        }
        // Non-fatal, or fatal but transient: report it; for the latter the server closes the
        // socket and we reconnect with back-off.
        this.emit({ type: "error", code: msg.code, message: msg.message, fatal: false });
        return;
      }
      case "closed":
        // The answer to our `end` — or the server finished the stream on its own; either
        // way there is nothing to resume.
        this.finish("ended");
        return;
    }
  }

  private onSocketClosed(ws: WebSocketLike, code: number, reason: string): void {
    if (ws !== this.ws) return;
    const lostBytes = ws.bufferedAmount > 0;
    this.detach(ws);
    if (this.isFinished()) return;
    // Close codes the server uses for permanent refusals (see WS_CLOSE in the protocol).
    const permanent: Partial<Record<number, StreamErrorCode>> = {
      [WS_CLOSE.UNAUTHORIZED]: "unauthorized",
      [WS_CLOSE.FORBIDDEN]: "forbidden",
      [WS_CLOSE.PROTOCOL_ERROR]: "bad_request",
    };
    const fatal = permanent[code];
    if (fatal) {
      this.fail(fatal, reason || fatal);
      return;
    }
    if (lostBytes) this.markNextDiscontinuity = true;
    this.scheduleReconnect();
  }

  /** Forget a socket without waiting for its close handshake (it may never complete). */
  private dropSocket(ws: WebSocketLike): void {
    const lostBytes = ws.bufferedAmount > 0;
    this.detach(ws);
    try {
      ws.close(4000, "client reconnect");
    } catch {
      // already closing
    }
    if (lostBytes) this.markNextDiscontinuity = true;
    if (!this.isFinished()) this.scheduleReconnect();
  }

  private detach(ws: WebSocketLike): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    if (this.ws === ws) this.ws = null;
    this.clearConnectionTimers();
  }

  private clearConnectionTimers(): void {
    for (const key of ["readyTimer", "pingTimer", "flushTimer"] as const) {
      if (this[key] !== null) {
        this.o.clearTimer(this[key]);
        this[key] = null;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.isFinished()) return;
    if (this.reconnectTimer !== null) return;
    const delay = backoffDelay(this.attempt, this.o.backoff, this.o.random);
    this.attempt++;
    this.setPhase("reconnecting", delay);
    this.reconnectTimer = this.o.setTimer(() => {
      this.reconnectTimer = null;
      if (this.isFinished()) return;
      this.setPhase("connecting");
      this.connect();
    }, delay);
  }

  private startPing(): void {
    const tick = () => {
      this.pingTimer = null;
      const ws = this.ws;
      if (!ws || this.isFinished()) return;
      if (this.o.now() - this.lastMessageAt > this.o.livenessTimeoutMs) {
        this.emit({
          type: "error",
          code: "timeout",
          message: "server stopped answering",
          fatal: false,
        });
        this.dropSocket(ws);
        return;
      }
      if (ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify({ type: "ping", clientTimeMs: this.o.now() }));
      }
      this.pingTimer = this.o.setTimer(tick, this.o.pingIntervalMs);
    };
    if (this.pingTimer !== null) this.o.clearTimer(this.pingTimer);
    this.pingTimer = this.o.setTimer(tick, this.o.pingIntervalMs);
  }

  private enqueue(item: Queued): void {
    this.queue.push(item);
    if (item.kind === "audio") this.queuedMs += item.durationMs;
    else this.queuedSegments += item.segments.length;
    this.enforceCap();
    if (this.phaseValue === "ready" || this.phaseValue === "ending") this.flush();
  }

  private enforceCap(): void {
    let frames = 0;
    let ms = 0;
    while (this.queuedMs > this.o.maxBufferedMs) {
      const idx = this.queue.findIndex((q) => q.kind === "audio");
      if (idx < 0) break;
      const [dropped] = this.queue.splice(idx, 1) as [QueuedFrame];
      this.queuedMs -= dropped.durationMs;
      frames++;
      ms += dropped.durationMs;
    }
    while (this.queuedSegments > this.o.maxBufferedSegments) {
      const idx = this.queue.findIndex((q) => q.kind === "transcript");
      if (idx < 0) break;
      const [dropped] = this.queue.splice(idx, 1) as [QueuedTranscript];
      this.queuedSegments -= dropped.segments.length;
    }
    if (frames > 0) {
      // The oldest surviving frame no longer follows what the server saw last.
      this.markNextDiscontinuity = true;
      this.emit({ type: "dropped", frames, ms });
    }
  }

  private flush(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    if (this.phaseValue !== "ready" && this.phaseValue !== "ending") return;
    while (this.queue.length > 0) {
      if (ws.bufferedAmount > this.o.maxSocketBufferedBytes) {
        // WebSocket has no "drain" event; poll until the socket has caught up.
        if (this.flushTimer === null) {
          this.flushTimer = this.o.setTimer(() => {
            this.flushTimer = null;
            this.flush();
          }, 100);
        }
        return;
      }
      const item = this.queue.shift()!;
      if (item.kind === "audio") {
        this.queuedMs -= item.durationMs;
        const discontinuity = item.discontinuity || this.markNextDiscontinuity;
        this.markNextDiscontinuity = false;
        ws.send(
          encodeAudioFrame({
            seq: item.seq,
            captureTimeMs: item.captureTimeMs,
            discontinuity,
            payload: item.payload,
          }),
        );
      } else {
        this.queuedSegments -= item.segments.length;
        ws.send(JSON.stringify({ type: "transcript", segments: item.segments }));
      }
    }
    if (this.queuedMs < 1e-6) this.queuedMs = 0;
    if (this.ending && !this.endSent) {
      this.endSent = true;
      ws.send(JSON.stringify({ type: "end" }));
    }
  }

  private fail(code: StreamErrorCode, message: string): void {
    if (this.isFinished()) return;
    this.fatalCode = code;
    this.emit({ type: "error", code, message, fatal: true });
    this.finish("fatal");
  }

  private finish(reason: "ended" | "fatal" | "aborted"): void {
    if (this.isFinished()) return;
    if (this.reconnectTimer !== null) {
      this.o.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.endTimer !== null) {
      this.o.clearTimer(this.endTimer);
      this.endTimer = null;
    }
    const ws = this.ws;
    if (ws) {
      this.detach(ws);
      try {
        ws.close(1000, reason);
      } catch {
        // ignore
      }
    }
    this.clearConnectionTimers();
    this.setPhase(reason === "fatal" ? "failed" : "closed");
    const ev: StreamEvent = { type: "closed", reason };
    if (this.fatalCode) ev.code = this.fatalCode;
    this.emit(ev);
    const resolvers = this.endResolvers;
    this.endResolvers = [];
    for (const r of resolvers) r();
  }
}
