import type { BrowserCaptureOptions } from "@ltm/capture/browser";
import { describe, expect, it } from "vitest";
import { CaptureSessionRunner, type SessionDeps } from "../src/offscreen/session.js";
import type { CaptureStartSpec, FromOffscreen } from "../src/shared/messages.js";

const spec: CaptureStartSpec = {
  source: "tab",
  streamId: "0b6f7a5e-4a7c-4f1e-9a33-2a3c4d5e6f70",
  serverUrl: "https://ltm.test",
  token: "tok_adapter_0123456789",
  mode: "audio",
  context: { app: "meet.google.com", title: "Sync" },
  tabMediaStreamId: "media-id",
};

function fakeStream() {
  const listeners: Array<() => void> = [];
  let stopped = 0;
  const track = {
    stop: () => {
      stopped++;
    },
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return {
    stream,
    end: () => {
      for (const l of listeners) l();
    },
    stopped: () => stopped,
  };
}

function setup(overrides: Partial<SessionDeps> = {}, s: CaptureStartSpec = spec) {
  const reports: FromOffscreen[] = [];
  const media = fakeStream();
  let opts: BrowserCaptureOptions | null = null;
  let stops = 0;
  const deps: SessionDeps = {
    openStream: async () => media.stream,
    startCapture: async (o) => {
      opts = o;
      return {
        streamId: o.streamId ?? "",
        stop: async () => {
          stops++;
          o.onEvent?.({ type: "phase", phase: "ending" });
          o.onEvent?.({ type: "phase", phase: "ended" });
        },
      };
    },
    workletUrl: "chrome-extension://id/capture-worklet.js",
    createTranscriber: async () => null,
    report: (m) => reports.push(m),
    isPermissionError: (e) => (e as Error).name === "NotAllowedError",
    ...overrides,
  };
  const runner = new CaptureSessionRunner(s, deps);
  return { runner, reports, media, opts: () => opts!, stops: () => stops };
}

describe("offscreen CaptureSessionRunner (adapter over @ltm/capture)", () => {
  it("passes the spec to startBrowserCapture and maps events to worker messages", async () => {
    const { runner, reports, opts } = setup();
    await runner.start();
    expect(opts()).toMatchObject({
      serverUrl: "https://ltm.test",
      token: spec.token,
      source: "tab",
      streamId: spec.streamId,
      playthrough: true,
      workletUrl: "chrome-extension://id/capture-worklet.js",
      context: spec.context,
    });
    const emit = opts().onEvent!;
    emit({ type: "phase", phase: "connecting" });
    emit({ type: "phase", phase: "streaming" });
    emit({ type: "phase", phase: "reconnecting", bufferedMs: 4200 });
    emit({ type: "segment", segment: { startMs: 1, endMs: 2, text: "hi", origin: "server_stt" } });
    emit({ type: "level", dbfs: -20, speaking: true });
    expect(
      reports.map((r) => [r.kind, "phase" in r ? r.phase : "segment" in r ? r.segment.text : ""]),
    ).toEqual([
      ["stream:phase", "connecting"],
      ["stream:phase", "live"],
      ["stream:phase", "reconnecting"],
      ["stream:segment", "hi"],
    ]);
    expect(reports[2]).toMatchObject({ bufferedMs: 4200 });
    await runner.stop("user");
    expect(reports.at(-1)).toMatchObject({
      kind: "capture:ended",
      reason: "user",
      streamId: spec.streamId,
    });
  });

  it("reports a fatal error then capture:ended with reason fatal", async () => {
    const { runner, reports, opts } = setup();
    await runner.start();
    opts().onEvent!({
      type: "error",
      code: "consent_required",
      message: "accept first",
      fatal: true,
    });
    opts().onEvent!({ type: "phase", phase: "ended" });
    expect(reports.map((r) => r.kind)).toEqual(["stream:fatal", "capture:ended"]);
    expect(reports[0]).toMatchObject({ code: "consent_required", message: "accept first" });
    expect(reports[1]).toMatchObject({ reason: "fatal" });
  });

  it("records track_ended as the reason when the tab/mic goes away", async () => {
    const { runner, reports, media, opts } = setup();
    await runner.start();
    media.end();
    opts().onEvent!({ type: "phase", phase: "ended" }); // startBrowserCapture stops itself
    expect(reports.at(-1)).toMatchObject({ kind: "capture:ended", reason: "track_ended" });
  });

  it("maps a denied microphone to mic_denied", async () => {
    const { runner, reports } = setup(
      {
        openStream: async () => {
          throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        },
      },
      { ...spec, source: "mic" },
    );
    await runner.start();
    expect(reports).toEqual([
      expect.objectContaining({ kind: "capture:failed", code: "mic_denied" }),
    ]);
  });

  it("fails cleanly when the audio graph cannot be built, stopping the tracks", async () => {
    const { runner, reports, media } = setup({
      startCapture: async () => {
        throw new Error("worklet failed to load");
      },
    });
    await runner.start();
    expect(reports).toEqual([
      expect.objectContaining({ kind: "capture:failed", code: "capture_failed" }),
    ]);
    expect(media.stopped()).toBe(1);
  });

  it("stop before the capture started ends without starting audio", async () => {
    let release!: (s: MediaStream) => void;
    const { runner, reports, media, stops } = setup({
      openStream: () => new Promise<MediaStream>((r) => (release = r)),
    });
    const started = runner.start();
    void runner.stop("user");
    release(media.stream);
    await started;
    expect(stops()).toBe(0);
    expect(media.stopped()).toBe(1);
    expect(reports).toEqual([expect.objectContaining({ kind: "capture:ended", reason: "user" })]);
  });

  it("refuses transcript mode while no on-device recogniser exists", async () => {
    const { runner, reports } = setup({}, { ...spec, mode: "transcript" });
    await runner.start();
    expect(reports).toEqual([
      expect.objectContaining({ kind: "capture:failed", code: "transcriber_unavailable" }),
    ]);
  });
});
