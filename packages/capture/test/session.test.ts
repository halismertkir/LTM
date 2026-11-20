import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { floatToS16 } from "../src/pcm.js";
import { type CaptureEvent, CaptureSession, type CaptureSessionOptions } from "../src/session.js";
import type { Transcriber } from "../src/transcriber.js";
import { FakeSocket } from "./fakes/fakeSocket.js";
import { tone } from "./fakes/signals.js";

const T0 = 1_763_000_000_000;
const STREAM_ID = "0b6f7a5e-4a7c-4f1e-9a33-2a3c4d5e6f70";

function make(extra: Partial<CaptureSessionOptions> = {}) {
  const events: CaptureEvent[] = [];
  let wall = T0;
  const s = new CaptureSession({
    serverUrl: "https://ltm.test/",
    token: "tok_session_0123456789abcdef",
    source: "mic",
    streamId: STREAM_ID,
    createSocket: (url) => new FakeSocket(url),
    onEvent: (e) => events.push(e),
    now: () => wall,
    ...extra,
  });
  return {
    s,
    events,
    advance: (ms: number) => {
      wall += ms;
    },
  };
}

function connect() {
  const sock = FakeSocket.last;
  sock.open();
  sock.receive({ type: "ready", streamId: STREAM_ID, serverTimeMs: Date.now(), resumed: false });
  return sock;
}

const speech = (samples: number, amp = 0.3) => floatToS16(tone(300, 16_000, samples, amp));
const silence = (samples: number) => new Int16Array(samples);
const phases = (events: CaptureEvent[]) =>
  events.flatMap((e) => (e.type === "phase" ? [e.phase] : []));

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("CaptureSession", () => {
  it("connects to the ingest URL with an audio hello and maps phases", async () => {
    const { s, events } = make({ language: "tr", context: { title: "Desk" } });
    await s.start();
    expect(FakeSocket.last.url).toBe("wss://ltm.test/api/v1/ingest/ws");
    const sock = connect();
    expect(sock.texts[0]).toMatchObject({
      type: "hello",
      streamId: STREAM_ID,
      source: "mic",
      mode: "audio",
      language: "tr",
      context: { title: "Desk" },
      audio: { codec: "pcm_s16le", sampleRate: 16_000, channels: 1 },
    });
    const stopped = s.stop();
    sock.receive({ type: "closed", streamId: STREAM_ID });
    await stopped;
    expect(phases(events)).toEqual(["connecting", "streaming", "ending", "ended"]);
    expect(await s.closed).toEqual({ reason: "ended" });
  });

  it("re-blocks any chunk size into 200 ms frames stamped from the caller's timestamps", async () => {
    const { s } = make({ gate: false });
    await s.start();
    const sock = connect();
    const pcm = speech(8000);
    s.pushPcm(pcm.subarray(0, 1000), T0);
    s.pushPcm(pcm.subarray(1000, 5000), T0 + 62.5);
    s.pushPcm(pcm.subarray(5000, 8000), T0 + 312.5);
    expect(sock.frames.map((f) => [f.captureTimeMs, f.payload.byteLength])).toEqual([
      [T0, 6400],
      [T0 + 200, 6400],
    ]);
    // the 1600-sample remainder is sent as a short frame on stop
    void s.stop();
    expect(sock.frames.at(-1)).toMatchObject({ captureTimeMs: T0 + 400, discontinuity: false });
    expect(sock.frames.at(-1)!.payload.byteLength).toBe(3200);
  });

  it("closes the partial block and flags a discontinuity when timestamps jump", async () => {
    const { s } = make({ gate: false });
    await s.start();
    const sock = connect();
    s.pushPcm(speech(1600), T0); // half a block
    s.pushPcm(speech(3200), T0 + 5000); // 5 s later: a stall
    expect(
      sock.frames.map((f) => [f.captureTimeMs, f.payload.byteLength / 2, f.discontinuity]),
    ).toEqual([
      [T0, 1600, false],
      [T0 + 5000, 3200, true],
    ]);
    // an explicit discontinuity flag behaves the same
    s.pushPcm(speech(1600), T0 + 5200);
    s.pushPcm(speech(3200), T0 + 5300, true);
    expect(sock.frames.slice(2).map((f) => [f.captureTimeMs, f.discontinuity])).toEqual([
      [T0 + 5200, false],
      [T0 + 5300, true],
    ]);
  });

  it("gates silence by default and emits throttled level events", async () => {
    const { s, events, advance } = make();
    await s.start();
    const sock = connect();
    // 4 s of silence pushed in 100 ms chunks, wall time advancing 100 ms per chunk
    for (let i = 0; i < 40; i++) {
      s.pushPcm(silence(1600), T0 + i * 100);
      advance(100);
    }
    expect(sock.frames.length).toBe(0);
    for (let i = 40; i < 50; i++) {
      s.pushPcm(speech(1600), T0 + i * 100);
      advance(100);
    }
    expect(sock.frames.length).toBeGreaterThan(4);
    expect(sock.frames[0]!.discontinuity).toBe(true); // silence before it was dropped
    const levels = events.filter(
      (e): e is Extract<CaptureEvent, { type: "level" }> => e.type === "level",
    );
    // one per 200 ms block at real-time pacing = 5 per second, never more
    expect(levels.length).toBe(25);
    expect(levels.slice(0, 20).every((l) => l.dbfs === -120 && !l.speaking)).toBe(true);
    expect(levels.at(-1)!.speaking).toBe(true);
    expect(levels.at(-1)!.dbfs).toBeGreaterThan(-15);
  });

  it("throttles level events when blocks arrive in a burst", async () => {
    const { s, events } = make({ gate: false });
    await s.start();
    connect();
    for (let i = 0; i < 50; i++) s.pushPcm(speech(3200), T0 + i * 200); // wall clock frozen
    expect(events.filter((e) => e.type === "level").length).toBe(1);
  });

  it("ends on a fatal error after reporting it, and ignores further audio", async () => {
    const { s, events } = make();
    await s.start();
    const sock = FakeSocket.last;
    sock.open();
    sock.receive({ type: "error", code: "ingest_paused", message: "paused", fatal: true });
    expect(await s.closed).toEqual({ reason: "fatal", code: "ingest_paused" });
    const errIdx = events.findIndex((e) => e.type === "error");
    const endIdx = events.findIndex((e) => e.type === "phase" && e.phase === "ended");
    expect(events[errIdx]).toEqual({
      type: "error",
      code: "ingest_paused",
      message: "paused",
      fatal: true,
    });
    expect(errIdx).toBeLessThan(endIdx);
    s.pushPcm(speech(3200), T0);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances.length).toBe(1);
    await s.stop();
  });

  it("reports reconnecting with the buffered amount and resumes the same stream", async () => {
    const { s, events } = make({ gate: false });
    await s.start();
    connect().serverClose(1006);
    s.pushPcm(speech(3200), T0);
    s.pushPcm(speech(3200), T0 + 200);
    vi.advanceTimersByTime(1000);
    const sock = connect();
    expect(sock.texts[0]).toMatchObject({ streamId: STREAM_ID });
    expect(sock.frames.length).toBe(2);
    expect(events.some((e) => e.type === "phase" && e.phase === "reconnecting")).toBe(true);
    expect(s.streamId).toBe(STREAM_ID);
  });

  it("generates a UUID v4 stream id when none is given", () => {
    const s = new CaptureSession({
      serverUrl: "https://x",
      token: "t".repeat(20),
      source: "mic",
      createSocket: (u) => new FakeSocket(u),
    });
    expect(s.streamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("transcript mode: windows go to the transcriber, segments to the socket, leftovers to REST", async () => {
    const seen: number[] = [];
    const transcriber: Transcriber = {
      engine: "fake",
      async transcribe(w) {
        seen.push(w.pcm.length);
        return [{ startMs: w.startMs, endMs: w.endMs, text: `heard ${w.pcm.length}` }];
      },
      dispose() {},
    };
    const posts: Array<{ url: string; body: { segments: unknown[]; final: boolean } }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const { s } = make({
      transcriber,
      fetch: fakeFetch,
      gate: false,
      client: { endTimeoutMs: 1000 },
    });
    await s.start();
    const sock = FakeSocket.last;
    sock.open();
    expect(sock.texts[0]).toMatchObject({ mode: "transcript" });
    expect(sock.texts[0]!.audio).toBeUndefined();
    // never `ready`: everything stays undelivered and goes to REST at the end
    s.pushPcm(speech(16_000), T0);
    const stopping = s.stop();
    await vi.advanceTimersByTimeAsync(1500);
    await stopping;
    expect(seen).toEqual([16_000]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://ltm.test/api/v1/ingest/transcripts");
    expect(posts[0]!.body).toMatchObject({ final: true, segments: [{ text: "heard 16000" }] });
  });
});
