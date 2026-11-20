import type { PairRequest } from "@ltm/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  browserDeviceName,
  browserPlatform,
  type CaptureEventLike,
  ListenController,
  type ListenDeps,
  MIC_CONSTRAINTS,
  type StartCaptureOptions,
  type StoredDevice,
  sourceFor,
} from "../src/lib/listen";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

function fakeStream() {
  const track = { stop: vi.fn() };
  return {
    track,
    stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream,
  };
}

function setup(over: Partial<ListenDeps> = {}, stored: StoredDevice | null = null) {
  let saved = stored;
  let emit: (e: CaptureEventLike) => void = () => {};
  const handle = {
    streamId: "s-1",
    stop: vi.fn(async () => emit({ type: "phase", phase: "ended" })),
  };
  const lock = { release: vi.fn(async () => {}) };
  const { stream, track } = fakeStream();
  const deps: ListenDeps = {
    origin: "https://ltm.example.test",
    workletUrl: "/assets/worklet-abc.js",
    userAgent: IPHONE,
    appVersion: "0.1.0",
    createPairingCode: vi.fn(async () => ({
      code: "K7QF-2MXD",
      access: "capture" as const,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      pairingUri: "ltm://pair",
    })),
    pairDevice: vi.fn(async (body: PairRequest) => ({
      device: {
        id: "dev-web",
        name: body.name,
        kind: body.kind,
        access: "capture" as const,
        platform: null,
        appVersion: null,
        priority: null,
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
        online: false,
      },
      token: "tok-capture-only",
      user: { id: "u", displayName: "Sam", locale: "en" as const },
    })),
    getUserMedia: vi.fn(async () => stream),
    startCapture: vi.fn(async (o: StartCaptureOptions) => {
      emit = o.onEvent;
      queueMicrotask(() => o.onEvent({ type: "phase", phase: "connecting" }));
      return handle;
    }),
    requestWakeLock: vi.fn(async () => lock),
    storage: { get: () => saved, set: (d) => (saved = d), clear: () => (saved = null) },
    now: () => 1_000,
    ...over,
  };
  const c = new ListenController(deps);
  return {
    c,
    deps,
    handle,
    lock,
    track,
    stored: () => saved,
    emit: (e: CaptureEventLike) => emit(e),
  };
}

describe("device naming", () => {
  it("derives a readable name and a sensible source from the user agent", () => {
    expect(browserDeviceName(IPHONE)).toBe("Safari on iPhone");
    expect(browserDeviceName(MAC_CHROME)).toBe("Chrome on Mac");
    expect(
      browserDeviceName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
      ),
    ).toBe("Firefox on Windows");
    expect(
      browserDeviceName(
        "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36 Edg/142.0",
      ),
    ).toBe("Edge on Android");
    expect(browserPlatform(IPHONE)).toBe("Safari 18 · iPhone");
    expect(browserPlatform(MAC_CHROME)).toBe("Chrome 142 · Mac");
    expect(sourceFor(IPHONE)).toBe("ambient");
    expect(sourceFor(MAC_CHROME)).toBe("mic");
  });
});

describe("listen state machine", () => {
  it("pairs on first use, streams, shows level and captions, and stops cleanly", async () => {
    const t = setup();
    await t.c.start();
    expect(t.deps.createPairingCode).toHaveBeenCalledOnce();
    expect(t.deps.pairDevice).toHaveBeenCalledWith(
      expect.objectContaining({ code: "K7QF-2MXD", kind: "web", name: "Safari on iPhone" }),
    );
    expect(t.stored()).toEqual({
      deviceId: "dev-web",
      token: "tok-capture-only",
      name: "Safari on iPhone",
    });
    expect(t.deps.getUserMedia).toHaveBeenCalledWith(MIC_CONSTRAINTS);
    expect(t.deps.startCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://ltm.example.test",
        token: "tok-capture-only",
        source: "ambient",
        workletUrl: "/assets/worklet-abc.js",
      }),
    );
    expect(t.c.getState().phase).toBe("connecting");

    t.emit({ type: "phase", phase: "streaming" });
    await Promise.resolve();
    expect(t.c.getState()).toMatchObject({ phase: "streaming", startedAt: 1_000 });
    await vi.waitFor(() => expect(t.c.getState().wakeLock).toBe("held"));

    t.emit({ type: "level", dbfs: -23, speaking: true });
    for (let i = 1; i <= 4; i++)
      t.emit({ type: "segment", segment: { id: `g${i}`, startMs: i, text: `line ${i}` } });
    t.emit({ type: "segment", segment: { id: "g4", startMs: 4, text: "line 4, corrected" } });
    expect(t.c.getState().level).toEqual({ dbfs: -23, speaking: true });
    expect(t.c.getState().captions.map((c) => c.text)).toEqual([
      "line 2",
      "line 3",
      "line 4, corrected",
    ]);

    // A transient drop reconnects without leaving the recording state.
    t.emit({ type: "error", code: "transport", message: "socket closed", fatal: false });
    t.emit({ type: "phase", phase: "reconnecting", bufferedMs: 2400 });
    expect(t.c.getState()).toMatchObject({ phase: "reconnecting", bufferedMs: 2400, error: null });
    t.emit({ type: "phase", phase: "streaming" });
    expect(t.c.getState().startedAt).toBe(1_000);

    await t.c.stop();
    expect(t.handle.stop).toHaveBeenCalledOnce();
    expect(t.lock.release).toHaveBeenCalled();
    expect(t.c.getState()).toMatchObject({ phase: "idle", level: null, wakeLock: "none" });
  });

  it("reuses the stored capture credential instead of pairing again", async () => {
    const t = setup({}, { deviceId: "dev-web", token: "tok-saved", name: "Safari on iPhone" });
    expect(t.c.getState().device).toEqual({ id: "dev-web", name: "Safari on iPhone" });
    await t.c.start();
    expect(t.deps.createPairingCode).not.toHaveBeenCalled();
    expect(t.deps.startCapture).toHaveBeenCalledWith(
      expect.objectContaining({ token: "tok-saved" }),
    );
  });

  it("reports a denied microphone without starting a stream", async () => {
    const t = setup({
      getUserMedia: vi.fn(async () =>
        Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })),
      ),
    });
    await t.c.start();
    expect(t.c.getState()).toMatchObject({ phase: "error", error: { kind: "permission" } });
    expect(t.deps.startCapture).not.toHaveBeenCalled();
  });

  it("explains a browser without getUserMedia", async () => {
    const t = setup({ getUserMedia: null });
    await t.c.start();
    expect(t.c.getState().error?.kind).toBe("unsupported");
  });

  it("forgets a revoked device when the server answers unauthorized", async () => {
    const t = setup({}, { deviceId: "dev-web", token: "tok-revoked", name: "Safari on iPhone" });
    await t.c.start();
    t.emit({ type: "error", code: "unauthorized", message: "revoked", fatal: true });
    t.emit({ type: "phase", phase: "ended" });
    expect(t.c.getState()).toMatchObject({
      phase: "error",
      error: { kind: "unauthorized" },
      device: null,
    });
    expect(t.stored()).toBeNull();
  });

  it("maps consent and pause refusals to their own states", async () => {
    for (const [code, kind] of [
      ["consent_required", "consent"],
      ["ingest_paused", "paused"],
    ] as const) {
      const t = setup({}, { deviceId: "d", token: "tok", name: "n" });
      await t.c.start();
      t.emit({ type: "error", code, message: code, fatal: true });
      t.emit({ type: "phase", phase: "ended" });
      expect(t.c.getState()).toMatchObject({ phase: "error", error: { kind } });
      expect(t.stored()).not.toBeNull();
    }
  });

  it("abandons a start that is stopped while waiting for the microphone", async () => {
    let grant: (s: MediaStream) => void = () => {};
    const { stream, track } = fakeStream();
    const t = setup(
      { getUserMedia: vi.fn(() => new Promise<MediaStream>((r) => (grant = r))) },
      {
        deviceId: "d",
        token: "tok",
        name: "n",
      },
    );
    const starting = t.c.start();
    await vi.waitFor(() => expect(t.c.getState().phase).toBe("microphone"));
    await t.c.stop();
    grant(stream);
    await starting;
    expect(track.stop).toHaveBeenCalled();
    expect(t.deps.startCapture).not.toHaveBeenCalled();
    expect(t.c.getState().phase).toBe("idle");
  });

  it("stops with a paused notice when the account-wide pause flips", async () => {
    const t = setup({}, { deviceId: "d", token: "tok", name: "n" });
    await t.c.start();
    t.emit({ type: "phase", phase: "streaming" });
    await t.c.stop("paused");
    expect(t.handle.stop).toHaveBeenCalled();
    expect(t.c.getState()).toMatchObject({ phase: "error", error: { kind: "paused" } });
  });
});
