import type { Transcriber } from "@ltm/capture";
import type {
  BrowserCaptureHandle,
  BrowserCaptureOptions,
  CaptureEvent,
} from "@ltm/capture/browser";
import type { CaptureStartSpec, FromOffscreen } from "../shared/messages.js";

type Report = (msg: FromOffscreen) => void;

export interface SessionDeps {
  openStream: (spec: CaptureStartSpec) => Promise<MediaStream>;
  startCapture: (opts: BrowserCaptureOptions) => Promise<BrowserCaptureHandle>;
  /** URL of the built `@ltm/capture/worklet` module inside the extension. */
  workletUrl: string;
  createTranscriber: () => Promise<Transcriber | null>;
  report: Report;
  isPermissionError: (err: unknown) => boolean;
}

/**
 * Adapter between the worker's messages and `@ltm/capture`: opens the tab or microphone
 * stream (permissions and tabCapture are extension concerns), hands it to
 * `startBrowserCapture`, and translates capture events back into worker messages.
 */
export class CaptureSessionRunner {
  private handle: BrowserCaptureHandle | null = null;
  private stream: MediaStream | null = null;
  private stopReason: string | null = null;
  private stopping: Promise<void> | null = null;
  private finished = false;
  private fatal = false;

  constructor(
    readonly spec: CaptureStartSpec,
    private readonly deps: SessionDeps,
  ) {}

  get source() {
    return this.spec.source;
  }

  async start(): Promise<void> {
    let transcriber: Transcriber | null = null;
    if (this.spec.mode === "transcript") {
      transcriber = await this.deps.createTranscriber();
      if (!transcriber) {
        this.fail("transcriber_unavailable", "on-device transcription is not available");
        return;
      }
    }
    try {
      this.stream = await this.deps.openStream(this.spec);
    } catch (err) {
      const code =
        this.spec.source === "mic" && this.deps.isPermissionError(err)
          ? "mic_denied"
          : "capture_failed";
      this.fail(code, describe(err));
      return;
    }
    if (this.stopReason) {
      // Stopped while the stream was opening: nothing was captured.
      for (const t of this.stream.getTracks()) t.stop();
      this.finish();
      return;
    }
    for (const track of this.stream.getAudioTracks()) {
      // The tab was closed, the user stopped sharing via Chrome's UI, or the mic went away.
      // (The capture then stops itself; this only records why.)
      track.addEventListener("ended", () => {
        this.stopReason ??= "track_ended";
      });
    }
    const opts: BrowserCaptureOptions = {
      serverUrl: this.spec.serverUrl,
      token: this.spec.token,
      source: this.spec.source,
      stream: this.stream,
      workletUrl: this.deps.workletUrl,
      playthrough: this.spec.source === "tab",
      streamId: this.spec.streamId,
      onEvent: (e) => this.onEvent(e),
    };
    if (this.spec.language) opts.language = this.spec.language;
    if (this.spec.context) opts.context = this.spec.context;
    if (transcriber) opts.transcriber = transcriber;
    try {
      this.handle = await this.deps.startCapture(opts);
    } catch (err) {
      for (const t of this.stream.getTracks()) t.stop();
      this.fail("capture_failed", describe(err));
      return;
    }
    if (this.stopReason) await this.handle.stop();
  }

  stop(reason: string): Promise<void> {
    this.stopReason ??= reason;
    if (!this.stopping) {
      this.stopping = (async () => {
        if (this.handle) await this.handle.stop();
        // Before `start` got a handle, `start` itself notices `stopReason` and finishes.
      })();
    }
    return this.stopping;
  }

  private onEvent(e: CaptureEvent): void {
    const base = {
      target: "background" as const,
      source: this.spec.source,
      streamId: this.spec.streamId,
    };
    switch (e.type) {
      case "phase":
        if (e.phase === "connecting" || e.phase === "streaming" || e.phase === "reconnecting") {
          this.deps.report({
            ...base,
            kind: "stream:phase",
            phase: e.phase === "streaming" ? "live" : e.phase,
            bufferedMs: e.bufferedMs ?? 0,
          });
        } else if (e.phase === "ended") {
          this.finish();
        }
        return;
      case "segment":
        this.deps.report({
          ...base,
          kind: "stream:segment",
          segment: { text: e.segment.text, startMs: e.segment.startMs, endMs: e.segment.endMs },
        });
        return;
      case "error":
        if (e.fatal) {
          this.fatal = true;
          this.deps.report({ ...base, kind: "stream:fatal", code: e.code, message: e.message });
        } else {
          console.warn(`stream ${this.spec.source}: ${e.code}: ${e.message}`);
        }
        return;
      case "level":
        return;
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.deps.report({
      target: "background",
      kind: "capture:ended",
      source: this.spec.source,
      streamId: this.spec.streamId,
      reason: this.fatal ? "fatal" : (this.stopReason ?? "ended"),
    });
  }

  private fail(code: string, message: string): void {
    if (this.finished) return;
    this.finished = true;
    this.deps.report({
      target: "background",
      kind: "capture:failed",
      source: this.spec.source,
      streamId: this.spec.streamId,
      code,
      message,
    });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
