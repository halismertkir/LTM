import {
  type AudioSource,
  ROUTES,
  type ServerSegment,
  type StreamContext,
  type TranscriptSegment,
} from "@ltm/protocol";
import {
  StreamClient,
  type StreamClientOptions,
  type StreamErrorCode,
  type StreamEvent,
  type WebSocketFactory,
} from "./client.js";
import { BLOCK_SAMPLES, TARGET_SAMPLE_RATE } from "./dsp.js";
import { EnergyGate, type GateOptions, type StampedBlock } from "./gate.js";
import { rmsDbfs, s16ToLeBytes } from "./pcm.js";
import type { Transcriber } from "./transcriber.js";
import { apiUrl, ingestWsUrl } from "./url.js";
import { type SpeechWindow, SpeechWindower } from "./windower.js";

export type CapturePhase = "connecting" | "streaming" | "reconnecting" | "ending" | "ended";

export type CaptureEvent =
  | {
      type: "phase";
      phase: CapturePhase;
      /** Milliseconds of audio waiting to be sent (interesting while reconnecting). */
      bufferedMs?: number;
    }
  | { type: "segment"; segment: ServerSegment["segment"] }
  | { type: "level"; dbfs: number; speaking: boolean }
  | { type: "error"; code: StreamErrorCode; message: string; fatal: boolean };

/** How a session finished. `code` is set for `fatal`. */
export interface CaptureEnd {
  reason: "ended" | "fatal" | "aborted";
  code?: StreamErrorCode;
}

export interface CaptureSessionOptions {
  /** Base URL of the LTM server, e.g. "https://ltm.example.com". */
  serverUrl: string;
  /** Device token from pairing. */
  token: string;
  source: AudioSource;
  language?: string;
  context?: StreamContext;
  /** Resume an existing stream; default: a new random UUID. */
  streamId?: string;
  onEvent?: (event: CaptureEvent) => void;
  /** On-device transcription: when given, the stream runs in mode "transcript". */
  transcriber?: Transcriber;
  /** Defaults to the global WebSocket. */
  createSocket?: WebSocketFactory;
  /** Used for the /ingest/transcripts fallback; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Energy-gate tuning; `false` sends every block. */
  gate?: Partial<GateOptions> | false;
  /** Lower-level stream client options (timeouts, back-off, buffer cap, timers). */
  client?: Partial<
    Omit<
      StreamClientOptions,
      "url" | "token" | "streamId" | "source" | "mode" | "audio" | "onEvent"
    >
  >;
  /** Wall clock for event throttling (tests). */
  now?: () => number;
}

const BLOCK_MS = (BLOCK_SAMPLES / TARGET_SAMPLE_RATE) * 1000;
/** Incoming PCM whose timestamp is off by more than this from the expected one is a gap. */
const GAP_TOLERANCE_MS = 20;
/** `level` events: at most one per this many ms of wall time (≈ 5 per second). */
const LEVEL_INTERVAL_MS = 190;
const MAX_TRANSCRIPT_BATCH = 500;

function randomUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // RFC 4122 v4 from Math.random — only for runtimes without WebCrypto.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * The capture wiring without any audio API: 16 kHz mono s16 PCM with capture timestamps in,
 * a gated, resumable ingest stream out. Runs anywhere with a WebSocket (browsers, workers,
 * Node 22+). `startBrowserCapture` feeds it from Web Audio; the capture agent from ffmpeg.
 *
 * `pushPcm` accepts any block size: samples are re-blocked into 200 ms frames, each stamped
 * with the capture time of its first sample (derived from the caller's timestamps, never
 * from the send time). A timestamp that does not continue the previous samples, or an
 * explicit `discontinuity`, closes the current partial block and flags the next frame.
 */
export class CaptureSession {
  readonly streamId: string;
  /** Resolves once the stream is over (ended, fatal or aborted). */
  readonly closed: Promise<CaptureEnd>;

  private readonly client: StreamClient;
  private readonly gate: EnergyGate | null;
  private readonly windower: SpeechWindower | null;
  private readonly now: () => number;
  private resolveClosed!: (end: CaptureEnd) => void;

  private block = new Int16Array(BLOCK_SAMPLES);
  private fill = 0;
  private blockStartMs = 0;
  private blockDiscontinuity = false;
  private pendingDiscontinuity = false;

  private phaseValue: CapturePhase | null = null;
  private lastLevelAt = -Infinity;
  private transcribing: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | null = null;
  private finished = false;
  private fatalCode: StreamErrorCode | undefined;

  constructor(private readonly o: CaptureSessionOptions) {
    this.streamId = o.streamId ?? randomUuid();
    this.now = o.now ?? (() => Date.now());
    this.closed = new Promise((r) => {
      this.resolveClosed = r;
    });
    this.gate = o.gate === false ? null : new EnergyGate({ blockMs: BLOCK_MS, ...(o.gate ?? {}) });
    this.windower = o.transcriber ? new SpeechWindower(TARGET_SAMPLE_RATE) : null;
    const opts: StreamClientOptions = {
      ...(o.client ?? {}),
      url: ingestWsUrl(o.serverUrl),
      token: o.token,
      streamId: this.streamId,
      source: o.source,
      mode: o.transcriber ? "transcript" : "audio",
      onEvent: (e) => this.onStreamEvent(e),
    };
    if (!o.transcriber)
      opts.audio = { codec: "pcm_s16le", sampleRate: TARGET_SAMPLE_RATE, channels: 1 };
    if (o.createSocket) opts.createSocket = o.createSocket;
    if (o.language) opts.language = o.language;
    if (o.context) opts.context = o.context;
    this.client = new StreamClient(opts);
  }

  get phase(): CapturePhase | null {
    return this.phaseValue;
  }

  /** Milliseconds of audio queued in the stream client (e.g. while reconnecting). */
  get bufferedMs(): number {
    return this.client.bufferedMs;
  }

  /** Opens the socket. Audio pushed before `ready` is queued (bounded), not lost. */
  async start(): Promise<void> {
    this.client.start();
  }

  /**
   * @param samples 16 kHz mono signed 16-bit PCM (any length)
   * @param captureTimeMs device-clock epoch ms of `samples[0]`
   * @param discontinuity capture was interrupted right before these samples
   */
  pushPcm(samples: Int16Array, captureTimeMs: number, discontinuity = false): void {
    if (this.finished || this.stopping || samples.length === 0) return;
    if (this.fill > 0) {
      const expected = this.blockStartMs + (this.fill / TARGET_SAMPLE_RATE) * 1000;
      const gap = Math.abs(captureTimeMs - expected) > GAP_TOLERANCE_MS;
      if (discontinuity || gap) {
        this.flushPartial();
        this.pendingDiscontinuity = true;
      }
    } else if (discontinuity) {
      this.pendingDiscontinuity = true;
    }
    let off = 0;
    while (off < samples.length) {
      if (this.fill === 0) {
        this.blockStartMs = captureTimeMs + (off / TARGET_SAMPLE_RATE) * 1000;
        this.blockDiscontinuity = this.pendingDiscontinuity;
        this.pendingDiscontinuity = false;
      }
      const take = Math.min(samples.length - off, BLOCK_SAMPLES - this.fill);
      this.block.set(samples.subarray(off, off + take), this.fill);
      this.fill += take;
      off += take;
      if (this.fill === BLOCK_SAMPLES) {
        this.emitBlock(this.block.slice(), this.blockStartMs, this.blockDiscontinuity);
        this.fill = 0;
      }
    }
  }

  /** Flushes pending audio, sends `end`, waits for `closed` (bounded). Idempotent. */
  stop(): Promise<void> {
    if (!this.stopping) this.stopping = this.doStop();
    return this.stopping;
  }

  /** Closes the socket at once without `end` (the server finalises after its grace period). */
  abort(): void {
    this.client.abort();
  }

  // ---------------------------------------------------------------- internals

  private async doStop(): Promise<void> {
    if (!this.finished) {
      this.setPhase("ending", this.client.bufferedMs);
      this.flushPartial();
      if (this.windower) {
        const last = this.windower.flush();
        if (last) this.enqueueWindow(last);
      }
      await this.transcribing;
      await this.client.end();
      await this.uploadLeftoverTranscripts();
    }
    await this.closed;
  }

  private flushPartial(): void {
    if (this.fill === 0) return;
    // A short final frame is fine: servers accept 10 ms – 2 s per frame.
    this.emitBlock(this.block.slice(0, this.fill), this.blockStartMs, this.blockDiscontinuity);
    this.fill = 0;
  }

  private emitBlock(pcm: Int16Array, captureTimeMs: number, discontinuity: boolean): void {
    const block: StampedBlock = { pcm, captureTimeMs, discontinuity };
    const out = this.gate ? this.gate.push(block) : [block];
    const now = this.now();
    if (now - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
      this.lastLevelAt = now;
      this.emit({
        type: "level",
        dbfs: rmsDbfs(pcm),
        speaking: this.gate ? this.gate.isOpen : true,
      });
    }
    for (const b of out) {
      if (this.windower) {
        for (const w of this.windower.push(b)) this.enqueueWindow(w);
      } else {
        this.client.sendAudio(s16ToLeBytes(b.pcm), b.captureTimeMs, b.discontinuity);
      }
    }
  }

  private enqueueWindow(window: SpeechWindow): void {
    const transcriber = this.o.transcriber;
    if (!transcriber) return;
    // One window at a time so segments reach the server in order even when recognition is
    // slower than real time.
    this.transcribing = this.transcribing.then(async () => {
      try {
        const segments = await transcriber.transcribe(window, this.o.language);
        if (segments.length) this.client.sendTranscript(segments);
      } catch (err) {
        this.emit({
          type: "error",
          code: "internal",
          message: `transcriber: ${String(err)}`,
          fatal: false,
        });
      }
    });
  }

  /** Transcript mode: what the socket could not deliver goes to POST /ingest/transcripts. */
  private async uploadLeftoverTranscripts(): Promise<void> {
    if (!this.o.transcriber) return;
    const segments: TranscriptSegment[] = this.client.undeliveredSegments();
    if (!segments.length) return;
    const doFetch = this.o.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!doFetch) return;
    for (let i = 0; i < segments.length; i += MAX_TRANSCRIPT_BATCH) {
      const body: Record<string, unknown> = {
        streamId: this.streamId,
        source: this.o.source,
        clientTimeMs: Date.now(),
        segments: segments.slice(i, i + MAX_TRANSCRIPT_BATCH),
        final: i + MAX_TRANSCRIPT_BATCH >= segments.length,
      };
      if (this.o.context) body.context = this.o.context;
      try {
        await doFetch(apiUrl(this.o.serverUrl, ROUTES.ingestTranscripts), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.o.token}` },
          body: JSON.stringify(body),
          credentials: "omit",
        });
      } catch (err) {
        this.emit({
          type: "error",
          code: "transport",
          message: `transcript upload: ${String(err)}`,
          fatal: false,
        });
      }
    }
  }

  private setPhase(phase: CapturePhase, bufferedMs?: number): void {
    if (phase === this.phaseValue && phase !== "reconnecting") return;
    this.phaseValue = phase;
    const ev: CaptureEvent = { type: "phase", phase };
    if (bufferedMs !== undefined) ev.bufferedMs = Math.round(bufferedMs);
    this.emit(ev);
  }

  private onStreamEvent(e: StreamEvent): void {
    switch (e.type) {
      case "phase":
        switch (e.phase) {
          case "connecting":
            this.setPhase("connecting", e.bufferedMs);
            return;
          case "ready":
            this.setPhase("streaming", e.bufferedMs);
            return;
          case "reconnecting":
            this.setPhase("reconnecting", e.bufferedMs);
            return;
          case "ending":
            this.setPhase("ending", e.bufferedMs);
            return;
          default:
            return; // idle / closed / failed: "ended" follows from the `closed` event
        }
      case "segment":
        this.emit({ type: "segment", segment: e.segment });
        return;
      case "error":
        if (e.fatal) this.fatalCode = e.code;
        this.emit({ type: "error", code: e.code, message: e.message, fatal: e.fatal });
        return;
      case "closed": {
        this.finished = true;
        this.setPhase("ended");
        const end: CaptureEnd = { reason: e.reason };
        const code = e.code ?? this.fatalCode;
        if (code && e.reason === "fatal") end.code = code;
        this.resolveClosed(end);
        return;
      }
      default:
        return;
    }
  }

  private emit(event: CaptureEvent): void {
    try {
      this.o.onEvent?.(event);
    } catch {
      // a listener bug must not break capture
    }
  }
}
