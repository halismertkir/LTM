import { PROTOCOL_VERSION, WS_CLOSE, zClientHello } from "@ltm/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, DEFAULT_BACKOFF } from "../src/backoff.js";
import { StreamClient, type StreamClientOptions, type StreamEvent } from "../src/client.js";
import { FakeSocket } from "./fakes/fakeSocket.js";

const STREAM_ID = "0b6f7a5e-4a7c-4f1e-9a33-2a3c4d5e6f70";
const TOKEN = "ltm_dev_0123456789abcdef0123456789";
const FRAME_BYTES = 6400; // 200 ms of 16 kHz mono s16

function makeClient(overrides: Partial<StreamClientOptions> = {}) {
  const events: StreamEvent[] = [];
  const client = new StreamClient({
    url: "wss://ltm.test/api/v1/ingest/ws",
    token: TOKEN,
    streamId: STREAM_ID,
    source: "tab",
    mode: "audio",
    audio: { codec: "pcm_s16le", sampleRate: 16_000, channels: 1 },
    context: { app: "meet.google.com", title: "Weekly sync" },
    createSocket: (url) => new FakeSocket(url),
    onEvent: (e) => events.push(e),
    random: () => 0.5,
    ...overrides,
  });
  return { client, events };
}

function pcm(fill = 1): Uint8Array {
  return new Uint8Array(FRAME_BYTES).fill(fill);
}

function ready(sock: FakeSocket, resumed = false): void {
  sock.receive({ type: "ready", streamId: STREAM_ID, serverTimeMs: Date.now(), resumed });
}

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
  vi.setSystemTime(1_763_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("StreamClient handshake", () => {
  it("sends hello first (token in the message, not the URL) and no frames before ready", () => {
    const { client } = makeClient();
    client.start();
    const sock = FakeSocket.last;
    expect(sock.url).not.toContain(TOKEN);
    client.sendAudio(pcm(1), 1000);
    sock.open();
    client.sendAudio(pcm(2), 1200);
    expect(sock.sent.length).toBe(1);
    const hello = sock.texts[0]!;
    expect(zClientHello.parse(hello)).toMatchObject({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      token: TOKEN,
      streamId: STREAM_ID,
      source: "tab",
      mode: "audio",
      audio: { codec: "pcm_s16le", sampleRate: 16_000, channels: 1 },
      context: { app: "meet.google.com", title: "Weekly sync" },
    });
    expect(hello.clientTimeMs).toBe(Date.now());

    ready(sock);
    expect(client.phase).toBe("ready");
    const frames = sock.frames;
    expect(frames.map((f) => f.seq)).toEqual([0, 1]);
    expect(frames.map((f) => f.captureTimeMs)).toEqual([1000, 1200]);
    expect(frames[0]!.payload.every((b) => b === 1)).toBe(true);
    expect(sock.firstBinaryIndex).toBe(1); // right after hello
  });

  it("sends frames immediately once ready and pings every 15 s", () => {
    const { client, events } = makeClient();
    client.start();
    const sock = FakeSocket.last;
    sock.open();
    ready(sock);
    client.sendAudio(pcm(), 5000, true);
    expect(sock.frames[0]).toMatchObject({ seq: 0, captureTimeMs: 5000, discontinuity: true });
    vi.advanceTimersByTime(15_000);
    const ping = sock.texts.find((m) => m.type === "ping");
    expect(ping).toEqual({ type: "ping", clientTimeMs: Date.now() });
    sock.receive({ type: "pong", clientTimeMs: Date.now() - 40, serverTimeMs: Date.now() + 1000 });
    expect(events.find((e) => e.type === "clock")).toEqual({
      type: "clock",
      rttMs: 40,
      offsetMs: 1020,
    });
  });

  it("surfaces server segments", () => {
    const { client, events } = makeClient();
    client.start();
    FakeSocket.last.open();
    ready(FakeSocket.last);
    FakeSocket.last.receive({
      type: "segment",
      segment: { startMs: 1, endMs: 2, text: "hello there", origin: "server_stt" },
    });
    expect(events.find((e) => e.type === "segment")).toMatchObject({
      segment: { text: "hello there" },
    });
  });

  it("ignores a ready for another stream id as a fatal protocol error", () => {
    const { client } = makeClient();
    client.start();
    FakeSocket.last.open();
    FakeSocket.last.receive({
      type: "ready",
      streamId: "11111111-1111-4111-8111-111111111111",
      serverTimeMs: 1,
      resumed: false,
    });
    expect(client.phase).toBe("failed");
  });
});

describe("StreamClient reconnect", () => {
  it("reconnects with back-off and resumes the same streamId, keeping buffered frames in order", () => {
    const { client, events } = makeClient();
    client.start();
    const first = FakeSocket.last;
    first.open();
    ready(first);
    client.sendAudio(pcm(), 0);
    first.serverClose(1006);
    expect(client.phase).toBe("reconnecting");
    // frames produced while disconnected are buffered
    client.sendAudio(pcm(), 200);
    client.sendAudio(pcm(), 400);
    expect(client.bufferedMs).toBeCloseTo(400, 6);

    const delay = backoffDelay(0, DEFAULT_BACKOFF, () => 0.5);
    vi.advanceTimersByTime(delay - 1);
    expect(FakeSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(2);
    const second = FakeSocket.last;
    second.open();
    expect(second.texts[0]).toMatchObject({ type: "hello", streamId: STREAM_ID });
    expect(second.frames.length).toBe(0);
    ready(second, true);
    expect(second.frames.map((f) => [f.seq, f.captureTimeMs])).toEqual([
      [1, 200],
      [2, 400],
    ]);
    expect(second.frames[0]!.discontinuity).toBe(false); // nothing was lost
    expect(
      events.filter((e) => e.type === "ready").map((e) => (e as { resumed: boolean }).resumed),
    ).toEqual([false, true]);
  });

  it("grows the back-off exponentially with jitter, capped", () => {
    const opts = DEFAULT_BACKOFF;
    expect(backoffDelay(0, opts, () => 0)).toBe(250);
    expect(backoffDelay(0, opts, () => 1)).toBe(500);
    expect(backoffDelay(3, opts, () => 0.5)).toBe(3000);
    expect(backoffDelay(20, opts, () => 1)).toBe(30_000);
    expect(backoffDelay(20, opts, () => 0)).toBe(15_000);

    const { client } = makeClient();
    client.start();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = FakeSocket.instances.length;
      FakeSocket.last.serverClose(1006);
      let waited = 0;
      while (FakeSocket.instances.length === before) {
        vi.advanceTimersByTime(50);
        waited += 50;
      }
      delays.push(waited);
    }
    for (let i = 1; i < delays.length; i++)
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    expect(FakeSocket.instances.every((s) => s.url === FakeSocket.instances[0]!.url)).toBe(true);
  });

  it("bounds the buffer: drops the oldest audio and marks the next frame as a discontinuity", () => {
    const { client, events } = makeClient({ maxBufferedMs: 1000 });
    client.start();
    // never opens: everything is buffered
    for (let i = 0; i < 8; i++) client.sendAudio(pcm(i), i * 200);
    expect(client.bufferedMs).toBeCloseTo(1000, 6);
    const dropped = events.filter((e) => e.type === "dropped");
    expect(dropped.reduce((n, e) => n + (e as { frames: number }).frames, 0)).toBe(3);
    FakeSocket.last.open();
    ready(FakeSocket.last);
    const frames = FakeSocket.last.frames;
    expect(frames.map((f) => f.seq)).toEqual([3, 4, 5, 6, 7]); // seq gap tells the server too
    expect(frames[0]!.discontinuity).toBe(true);
    expect(frames.slice(1).every((f) => !f.discontinuity)).toBe(true);
  });

  it("marks a discontinuity after a socket died with unsent bytes", () => {
    const { client } = makeClient();
    client.start();
    FakeSocket.last.open();
    ready(FakeSocket.last);
    client.sendAudio(pcm(), 0);
    FakeSocket.last.bufferedAmount = 6400;
    FakeSocket.last.serverClose(1006);
    client.sendAudio(pcm(), 200);
    vi.advanceTimersByTime(1000);
    FakeSocket.last.open();
    ready(FakeSocket.last, true);
    expect(FakeSocket.last.frames[0]).toMatchObject({ seq: 1, discontinuity: true });
  });

  it("applies backpressure when the socket is not draining", () => {
    const { client } = makeClient();
    client.start();
    const sock = FakeSocket.last;
    sock.open();
    ready(sock);
    sock.bufferedAmount = 10_000_000;
    client.sendAudio(pcm(), 0);
    expect(sock.frames.length).toBe(0);
    expect(client.bufferedMs).toBeCloseTo(200, 6);
    sock.bufferedAmount = 0;
    vi.advanceTimersByTime(100);
    expect(sock.frames.length).toBe(1);
  });

  it("drops a silent socket after the liveness timeout and reconnects", () => {
    const { client } = makeClient();
    client.start();
    FakeSocket.last.open();
    ready(FakeSocket.last);
    vi.advanceTimersByTime(61_000); // pings go out, no pong comes back
    expect(FakeSocket.instances[0]!.closedByClient).not.toBeNull();
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    expect(client.phase === "connecting" || client.phase === "reconnecting").toBe(true);
  });

  it("retries when ready does not arrive in time", () => {
    const { client } = makeClient();
    client.start();
    FakeSocket.last.open();
    vi.advanceTimersByTime(10_000);
    expect(client.phase).toBe("reconnecting");
  });

  it("retries transient fatal errors (rate_limited) but not permanent ones", () => {
    const { client } = makeClient();
    client.start();
    FakeSocket.last.open();
    FakeSocket.last.receive({
      type: "error",
      code: "rate_limited",
      message: "slow down",
      fatal: true,
    });
    FakeSocket.last.serverClose(1013);
    expect(client.phase).toBe("reconnecting");
  });
});

describe("StreamClient fatal errors", () => {
  for (const code of [
    "consent_required",
    "ingest_paused",
    "unauthorized",
    "unsupported_protocol",
  ] as const) {
    it(`stops for good on ${code}`, () => {
      const { client, events } = makeClient();
      client.start();
      const sock = FakeSocket.last;
      sock.open();
      sock.receive({ type: "error", code, message: `nope: ${code}`, fatal: true });
      expect(client.phase).toBe("failed");
      expect(events.at(-1)).toEqual({ type: "closed", reason: "fatal", code });
      expect(events.find((e) => e.type === "error")).toEqual({
        type: "error",
        code,
        message: `nope: ${code}`,
        fatal: true,
      });
      sock.serverClose(4403);
      vi.advanceTimersByTime(120_000);
      expect(FakeSocket.instances.length).toBe(1);
      client.sendAudio(pcm(), 0); // ignored, no throw
    });
  }

  it("treats close code 4401 as unauthorized", () => {
    const { client, events } = makeClient();
    client.start();
    FakeSocket.last.open();
    FakeSocket.last.serverClose(WS_CLOSE.UNAUTHORIZED, "revoked");
    expect(client.phase).toBe("failed");
    expect(events.at(-1)).toMatchObject({ type: "closed", reason: "fatal", code: "unauthorized" });
  });

  it("reports non-fatal errors without closing", () => {
    const { client, events } = makeClient();
    client.start();
    FakeSocket.last.open();
    ready(FakeSocket.last);
    FakeSocket.last.receive({
      type: "error",
      code: "provider_error",
      message: "stt hiccup",
      fatal: false,
    });
    expect(client.phase).toBe("ready");
    expect(events.some((e) => e.type === "error" && !e.fatal)).toBe(true);
  });

  it("rejects an invalid hello locally", () => {
    const { client } = makeClient({ token: "short" });
    client.start();
    FakeSocket.last.open();
    expect(client.phase).toBe("failed");
    expect(FakeSocket.last.sent.length).toBe(0);
  });
});

describe("StreamClient end", () => {
  it("flushes, sends end, waits for closed", async () => {
    const { client, events } = makeClient();
    client.start();
    const sock = FakeSocket.last;
    sock.open();
    ready(sock);
    sock.bufferedAmount = 10_000_000; // force queueing
    client.sendAudio(pcm(), 0);
    client.sendAudio(pcm(), 200);
    let done = false;
    const p = client.end().then(() => {
      done = true;
    });
    client.sendAudio(pcm(), 400); // after end: ignored
    expect(sock.texts.some((m) => m.type === "end")).toBe(false);
    sock.bufferedAmount = 0;
    vi.advanceTimersByTime(100);
    const kinds = sock.sent.map((d) => (typeof d === "string" ? JSON.parse(d).type : "frame"));
    expect(kinds).toEqual(["hello", "frame", "frame", "end"]);
    await Promise.resolve();
    expect(done).toBe(false);
    sock.receive({ type: "closed", streamId: STREAM_ID });
    await p;
    expect(client.phase).toBe("closed");
    expect(sock.closedByClient?.code).toBe(1000);
    expect(events.at(-1)).toEqual({ type: "closed", reason: "ended" });
  });

  it("ends after a reconnect when stopped while disconnected", async () => {
    const { client } = makeClient();
    client.start();
    FakeSocket.last.open();
    ready(FakeSocket.last);
    FakeSocket.last.serverClose(1006);
    client.sendAudio(pcm(), 0); // still accepted before end()
    const p = client.end();
    vi.advanceTimersByTime(1000);
    const sock = FakeSocket.last;
    sock.open();
    ready(sock, true);
    expect(sock.sent.map((d) => (typeof d === "string" ? JSON.parse(d).type : "frame"))).toEqual([
      "hello",
      "frame",
      "end",
    ]);
    sock.receive({ type: "closed", streamId: STREAM_ID });
    await p;
    expect(client.phase).toBe("closed");
  });

  it("gives up waiting for closed after the end timeout", async () => {
    const { client, events } = makeClient({ endTimeoutMs: 5000 });
    client.start();
    FakeSocket.last.open();
    ready(FakeSocket.last);
    const p = client.end();
    vi.advanceTimersByTime(5000);
    await p;
    expect(client.phase).toBe("closed");
    expect(events.some((e) => e.type === "error" && e.code === "timeout")).toBe(true);
  });
});

describe("StreamClient transcript mode", () => {
  it("sends transcript messages in chunks of ≤ 200 after ready and keeps undelivered ones", () => {
    const { client } = makeClient({ mode: "transcript" });
    const seg = (i: number) => ({
      id: `s${i}`,
      startMs: 1000 + i,
      endMs: 1500 + i,
      text: `word ${i}`,
    });
    client.start();
    client.sendTranscript(Array.from({ length: 250 }, (_, i) => seg(i)));
    expect(client.undeliveredSegments().length).toBe(250);
    FakeSocket.last.open();
    expect(FakeSocket.last.texts[0]).toMatchObject({ type: "hello", mode: "transcript" });
    expect(FakeSocket.last.texts[0]!.audio).toBeUndefined();
    ready(FakeSocket.last);
    const msgs = FakeSocket.last.texts.filter((m) => m.type === "transcript") as Array<{
      segments: unknown[];
    }>;
    expect(msgs.map((m) => m.segments.length)).toEqual([200, 50]);
    expect(client.undeliveredSegments().length).toBe(0);
    expect(() => client.sendAudio(pcm(), 0)).toThrow();
  });
});
