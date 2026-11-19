import { BLOCK_SAMPLES, TARGET_SAMPLE_RATE } from "../audio/dsp.js";
import { EnergyGate, type StampedBlock } from "../audio/gate.js";
import { s16ToLeBytes } from "../audio/pcm.js";
import { SpeechWindower } from "../audio/windower.js";
import { ApiClient } from "../shared/api.js";
import type { CaptureStartSpec, FromOffscreen, OffscreenPhase } from "../shared/messages.js";
import { ingestWsUrl } from "../shared/url.js";
import { StreamClient, type StreamEvent, type WebSocketFactory } from "../stream/client.js";
import type { Transcriber } from "./transcriber.js";

type Report = (msg: FromOffscreen) => void;

export interface SessionDeps {
  openStream: (spec: CaptureStartSpec) => Promise<MediaStream>;
  startPipeline: (opts: {
    stream: MediaStream;
    playthrough: boolean;
    onBlock: (b: StampedBlock) => void;
  }) => Promise<{ stop(): void }>;
  createSocket: WebSocketFactory;
  createTranscriber: () => Promise<Transcriber | null>;
  report: Report;
  isPermissionError: (err: unknown) => boolean;
}

const BLOCK_MS = (BLOCK_SAMPLES / TARGET_SAMPLE_RATE) * 1000;

/** One captured source: media → pipeline → gate → (transcriber) → stream client. */
export class CaptureSessionRunner {
  private client: StreamClient;
  private stream: MediaStream | null = null;
  private pipeline: { stop(): void } | null = null;
  private readonly gate = new EnergyGate({ blockMs: BLOCK_MS });
  private windower: SpeechWindower | null = null;
  private transcriber: Transcriber | null = null;
  private transcribing: Promise<void> = Promise.resolve();
  private lastPhase: OffscreenPhase | null = null;
  private stopping: Promise<void> | null = null;
  private ended = false;
  private fatalMessage = "";

  constructor(
    readonly spec: CaptureStartSpec,
    private readonly deps: SessionDeps,
  ) {
    const opts: ConstructorParameters<typeof StreamClient>[0] = {
      url: ingestWsUrl(spec.serverUrl),
      token: spec.token,
      streamId: spec.streamId,
      source: spec.source,
      mode: spec.mode,
      createSocket: deps.createSocket,
      onEvent: (e) => this.onStreamEvent(e),
    };
    if (spec.mode === "audio")
      opts.audio = { codec: "pcm_s16le", sampleRate: TARGET_SAMPLE_RATE, channels: 1 };
    if (spec.language) opts.language = spec.language;
    if (spec.context) opts.context = spec.context;
    this.client = new StreamClient(opts);
  }

  get source() {
    return this.spec.source;
  }

  async start(): Promise<void> {
    // Connect while the media opens: frames queue in the client until `ready`.
    this.client.start();
    try {
      if (this.spec.mode === "transcript") {
        this.transcriber = await this.deps.createTranscriber();
        if (!this.transcriber) {
          this.fail("transcriber_unavailable", "on-device transcription is not available");
          return;
        }
        this.windower = new SpeechWindower(TARGET_SAMPLE_RATE);
      }
      this.stream = await this.deps.openStream(this.spec);
      if (this.ended) {
        this.releaseMedia();
        return;
      }
      for (const track of this.stream.getAudioTracks()) {
        // Fires when the captured tab is closed, the user stops sharing through Chrome's
        // own UI, or the microphone is unplugged.
        track.addEventListener("ended", () => void this.stop("track_ended"));
      }
      this.pipeline = await this.deps.startPipeline({
        stream: this.stream,
        playthrough: this.spec.source === "tab",
        onBlock: (b) => this.onBlock(b),
      });
      if (this.ended) this.releaseMedia();
    } catch (err) {
      const code =
        this.spec.source === "mic" && this.deps.isPermissionError(err)
          ? "mic_denied"
          : "capture_failed";
      this.fail(code, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    }
  }

  stop(reason: string): Promise<void> {
    if (!this.stopping) this.stopping = this.doStop(reason);
    return this.stopping;
  }

  private async doStop(reason: string): Promise<void> {
    this.ended = true;
    this.releaseMedia();
    if (this.windower && this.transcriber) {
      const last = this.windower.flush();
      if (last) this.enqueueWindow(last);
      await this.transcribing;
    }
    await this.client.end();
    await this.uploadLeftoverTranscripts();
    this.transcriber?.dispose();
    this.deps.report({
      target: "background",
      kind: "capture:ended",
      source: this.spec.source,
      streamId: this.spec.streamId,
      reason,
    });
  }

  private releaseMedia(): void {
    this.pipeline?.stop();
    this.pipeline = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
  }

  private onBlock(block: StampedBlock): void {
    if (this.ended) return;
    for (const out of this.gate.push(block)) {
      if (this.windower) {
        for (const w of this.windower.push(out)) this.enqueueWindow(w);
      } else {
        this.client.sendAudio(s16ToLeBytes(out.pcm), out.captureTimeMs, out.discontinuity);
      }
    }
  }

  private enqueueWindow(window: ReturnType<SpeechWindower["flush"]> & object): void {
    const transcriber = this.transcriber;
    if (!transcriber) return;
    // Recognition is slower than real time on weak machines; windows are processed one at
    // a time so segments reach the server in order.
    this.transcribing = this.transcribing.then(async () => {
      try {
        const segments = await transcriber.transcribe(window, this.spec.language);
        if (segments.length) this.client.sendTranscript(segments);
      } catch (err) {
        console.warn("on-device transcription failed", err);
      }
    });
  }

  /** Transcript mode only: what the socket could not deliver goes over REST. */
  private async uploadLeftoverTranscripts(): Promise<void> {
    if (this.spec.mode !== "transcript") return;
    const segments = this.client.undeliveredSegments();
    if (!segments.length) return;
    const api = new ApiClient({ serverUrl: this.spec.serverUrl, token: this.spec.token });
    for (let i = 0; i < segments.length; i += 500) {
      const batch: Parameters<ApiClient["uploadTranscripts"]>[0] = {
        streamId: this.spec.streamId,
        source: this.spec.source,
        clientTimeMs: Date.now(),
        segments: segments.slice(i, i + 500),
        final: i + 500 >= segments.length,
      };
      if (this.spec.context) batch.context = this.spec.context;
      await api
        .uploadTranscripts(batch)
        .catch((err) => console.warn("transcript upload failed", err));
    }
  }

  private onStreamEvent(e: StreamEvent): void {
    const base = {
      target: "background" as const,
      source: this.spec.source,
      streamId: this.spec.streamId,
    };
    switch (e.type) {
      case "phase": {
        const phase: OffscreenPhase | null =
          e.phase === "connecting"
            ? "connecting"
            : e.phase === "ready"
              ? "live"
              : e.phase === "reconnecting"
                ? "reconnecting"
                : null;
        if (phase && (phase !== this.lastPhase || phase === "reconnecting")) {
          this.lastPhase = phase;
          this.deps.report({
            ...base,
            kind: "stream:phase",
            phase,
            bufferedMs: Math.round(e.bufferedMs),
          });
        }
        return;
      }
      case "segment":
        this.deps.report({
          ...base,
          kind: "stream:segment",
          segment: { text: e.segment.text, startMs: e.segment.startMs, endMs: e.segment.endMs },
        });
        return;
      case "error":
        if (e.fatal) this.fatalMessage = e.message;
        else console.warn(`stream ${this.spec.source}: ${e.code}: ${e.message}`);
        return;
      case "closed":
        if (e.reason === "fatal") {
          this.deps.report({
            ...base,
            kind: "stream:fatal",
            code: e.code ?? "internal",
            message: this.fatalMessage,
          });
          void this.stop("fatal");
        }
        return;
      default:
        return;
    }
  }

  private fail(code: string, message: string): void {
    this.deps.report({
      target: "background",
      kind: "capture:failed",
      source: this.spec.source,
      streamId: this.spec.streamId,
      code,
      message,
    });
    this.ended = true;
    this.releaseMedia();
    this.client.abort();
  }
}
