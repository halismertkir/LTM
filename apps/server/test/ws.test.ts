import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptAllConsents,
  configureProvider,
  eventually,
  frameList,
  hello,
  pairDevice,
  pcm,
  setupOwner,
  startTestServer,
  T0,
  type TestServer,
  WsClient,
} from "./helpers.js";

function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("ingest WebSocket", () => {
  let t: TestServer;
  let owner: { token: string; userId: string };
  let device: { token: string; deviceId: string };

  beforeAll(async () => {
    t = await startTestServer();
    owner = await setupOwner(t.api);
    await acceptAllConsents(t.api, owner.token);
    device = await pairDevice(t.api, owner.token, "Chrome", "browser_extension");
    await configureProvider(t.api, owner.token, "stt");
  });
  afterAll(async () => {
    await t.close();
  });

  it("closes with 4408 when no hello arrives", async () => {
    const ws = new WsClient(t.url);
    await ws.opened;
    expect(await ws.closed).toBe(4408);
    expect(ws.messages[0]).toMatchObject({ type: "error", fatal: true });
  });

  it("closes with 4401 on a bad token", async () => {
    const ws = new WsClient(t.url);
    await ws.opened;
    ws.send(hello("ltm_d_definitely-not-valid-token", randomUUID()));
    expect(await ws.waitFor((m) => m.type === "error")).toMatchObject({
      code: "unauthorized",
      fatal: true,
    });
    expect(await ws.closed).toBe(4401);
  });

  it("closes with 4400 on a wrong protocol version", async () => {
    const ws = new WsClient(t.url);
    await ws.opened;
    ws.send(hello(device.token, randomUUID(), { protocol: 99 }));
    expect(await ws.waitFor((m) => m.type === "error")).toMatchObject({
      code: "unsupported_protocol",
      fatal: true,
    });
    expect(await ws.closed).toBe(4400);
  });

  it("refuses a user session token and a non-hello first message", async () => {
    const a = new WsClient(t.url);
    await a.opened;
    a.send(hello(owner.token, randomUUID()));
    expect(await a.closed).toBe(4403);
    const b = new WsClient(t.url);
    await b.opened;
    b.send({ type: "ping", clientTimeMs: T0 });
    expect(await b.closed).toBe(4400);
  });

  it("cuts speech windows, transcribes them and echoes segments with absolute timestamps", async () => {
    t.fakes.stt.calls = [];
    t.fakes.stt.script = (_req, call) => ({
      text: `window ${call}`,
      segments: [{ startSec: 0.3, endSec: 1.2, text: `window ${call} words`, confidence: 0.9 }],
    });
    const streamId = randomUUID();
    const ws = new WsClient(t.url);
    await ws.opened;
    // Device clock 1 s behind: below the threshold, so no offset is applied.
    ws.send(
      hello(device.token, streamId, {
        clientTimeMs: t.clock.now() - 1000,
        context: { title: "Weekly sync", app: "meet.google.com" },
      }),
    );
    const ready = await ws.waitFor((m) => m.type === "ready");
    expect(ready).toMatchObject({ streamId, resumed: false, serverTimeMs: t.clock.now() });

    const start = t.clock.now();
    const audio = concat([
      pcm(1000, false),
      pcm(1500, true, 3),
      pcm(1500, false),
      pcm(1500, true, 7),
      pcm(1500, false),
    ]);
    for (const f of frameList(audio, start)) ws.sendBinary(f);
    ws.send({ type: "ping", clientTimeMs: start });
    await ws.waitFor((m) => m.type === "pong");

    const chunks = await eventually(async () => {
      const rows = await t.db.query<{ start_ms: number; duration_ms: number }>(
        "SELECT start_ms, duration_ms FROM audio_chunks WHERE stream_id = $1 ORDER BY seq",
        [streamId],
      );
      return rows.length >= 2 ? rows : null;
    });
    expect(chunks.length).toBe(2);
    // Windows start shortly (pre-roll) before each burst: bursts at +1.0 s and +4.0 s.
    expect(chunks[0]!.start_ms).toBeGreaterThan(start + 600);
    expect(chunks[0]!.start_ms).toBeLessThan(start + 1100);
    expect(chunks[1]!.start_ms).toBeGreaterThan(start + 3600);
    expect(chunks[1]!.start_ms).toBeLessThan(start + 4100);

    await t.drain();
    expect(t.fakes.stt.calls.length).toBe(2);
    expect(t.fakes.stt.calls[0]!.mimeType).toBe("audio/wav");
    const segs = await t.db.query<{
      start_ms: number;
      end_ms: number;
      text: string;
      device_id: string;
      origin: string;
    }>(
      "SELECT start_ms, end_ms, text, device_id, origin FROM raw_segments WHERE stream_id = $1 ORDER BY start_ms",
      [streamId],
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]!.start_ms).toBe(Math.round(chunks[0]!.start_ms + 300));
    expect(segs[0]!.end_ms).toBe(Math.round(chunks[0]!.start_ms + 1200));
    expect(segs[0]).toMatchObject({ device_id: device.deviceId, origin: "server_stt" });

    const live = await ws.waitFor((m) => m.type === "segment");
    expect(live.segment).toMatchObject({ origin: "server_stt", confidence: 0.9 });
    expect(live.segment.startMs).toBe(segs[0]!.start_ms);

    // Audio is transient by default: files are gone after transcription.
    const remaining = await t.db.query(
      "SELECT 1 FROM audio_chunks WHERE stream_id = $1 AND path IS NOT NULL",
      [streamId],
    );
    expect(remaining).toHaveLength(0);

    const streams = await t.api.get(`/streams?active=true`, { token: owner.token });
    expect(streams.body.find((s: { id: string }) => s.id === streamId)).toMatchObject({
      deviceId: device.deviceId,
      deviceName: "Chrome",
      source: "tab",
      mode: "audio",
      active: true,
      context: { title: "Weekly sync", app: "meet.google.com" },
    });
    const devices = await t.api.get("/devices", { token: owner.token });
    expect(devices.body.find((d: { id: string }) => d.id === device.deviceId).online).toBe(true);

    ws.send({ type: "end" });
    expect(await ws.waitFor((m) => m.type === "closed")).toEqual({ type: "closed", streamId });
    expect(await ws.closed).toBe(1000);
    const row = await t.db.query<{ ended_at: number | null }>(
      "SELECT ended_at FROM streams WHERE id = $1",
      [streamId],
    );
    expect(row[0]!.ended_at).not.toBeNull();
  });

  it("resumes a stream by id after a dropped connection; other devices cannot take it", async () => {
    const streamId = randomUUID();
    const first = new WsClient(t.url);
    await first.opened;
    first.send(hello(device.token, streamId));
    await first.waitFor((m) => m.type === "ready");
    // Speech that is still buffered when the socket drops…
    for (const f of frameList(pcm(800, true, 11), t.clock.now())) first.sendBinary(f);
    await new Promise((r) => setTimeout(r, 50));
    first.ws.terminate();
    await first.closed;

    const second = new WsClient(t.url);
    await second.opened;
    second.send(hello(device.token, streamId));
    expect(await second.waitFor((m) => m.type === "ready")).toMatchObject({
      streamId,
      resumed: true,
    });
    // …continues in the same window after the resume.
    for (const f of frameList(pcm(1500, false), t.clock.now() + 800)) second.sendBinary(f);
    const chunk = await eventually(
      async () =>
        (await t.db.query("SELECT seq FROM audio_chunks WHERE stream_id = $1", [streamId]))[0],
    );
    expect(chunk).toBeTruthy();

    const other = await pairDevice(t.api, owner.token, "Phone", "iphone");
    const thief = new WsClient(t.url);
    await thief.opened;
    thief.send(hello(other.token, streamId));
    expect(await thief.waitFor((m) => m.type === "error")).toMatchObject({ code: "forbidden" });
    expect(await thief.closed).toBe(4403);
    second.send({ type: "end" });
    await second.waitFor((m) => m.type === "closed");
  });

  it("finalises an abandoned stream after the grace period", async () => {
    const streamId = randomUUID();
    const ws = new WsClient(t.url);
    await ws.opened;
    ws.send(hello(device.token, streamId));
    await ws.waitFor((m) => m.type === "ready");
    for (const f of frameList(pcm(800, true, 5), t.clock.now())) ws.sendBinary(f);
    await new Promise((r) => setTimeout(r, 50));
    ws.ws.terminate();
    const ended = await eventually(async () => {
      const r = await t.db.query<{ ended_at: number | null }>(
        "SELECT ended_at FROM streams WHERE id = $1",
        [streamId],
      );
      return r[0]?.ended_at ? r : null;
    });
    expect(ended).toHaveLength(1);
    // The buffered speech was flushed into a window rather than lost.
    expect(
      await t.db.query("SELECT 1 FROM audio_chunks WHERE stream_id = $1", [streamId]),
    ).toHaveLength(1);
  });

  it("accepts edge transcripts idempotently in transcript mode and echoes them", async () => {
    const streamId = randomUUID();
    const ws = new WsClient(t.url);
    await ws.opened;
    ws.send(hello(device.token, streamId, { mode: "transcript", audio: undefined, source: "mic" }));
    await ws.waitFor((m) => m.type === "ready");
    const seg = {
      id: "a1",
      startMs: t.clock.now(),
      endMs: t.clock.now() + 1500,
      text: "merhaba dünya",
      language: "tr",
      speaker: "self",
    };
    ws.send({ type: "transcript", segments: [seg] });
    ws.send({ type: "transcript", segments: [seg] });
    const echoed = await ws.waitFor((m) => m.type === "segment");
    expect(echoed.segment).toMatchObject({
      text: "merhaba dünya",
      origin: "edge_stt",
      speaker: "self",
    });
    ws.sendBinary(new Uint8Array(32));
    expect(await ws.waitFor((m) => m.type === "error")).toMatchObject({
      code: "bad_request",
      fatal: false,
    });
    ws.send({ type: "end" });
    await ws.waitFor((m) => m.type === "closed");
    const rows = await t.db.query("SELECT 1 FROM raw_segments WHERE stream_id = $1", [streamId]);
    expect(rows).toHaveLength(1);
    expect(ws.messages.filter((m) => m.type === "segment")).toHaveLength(1);
  });

  it("warns (non-fatal) when no speech-to-text provider is configured and parks the audio", async () => {
    await t.api.put("/settings/providers/stt", { kind: "none" }, { token: owner.token });
    t.fakes.stt.calls = [];
    const streamId = randomUUID();
    const ws = new WsClient(t.url);
    await ws.opened;
    ws.send(hello(device.token, streamId));
    await ws.waitFor((m) => m.type === "ready");
    expect(await ws.waitFor((m) => m.type === "error")).toMatchObject({
      code: "provider_not_configured",
      fatal: false,
    });
    for (const f of frameList(concat([pcm(1200, true, 2), pcm(1200, false)]), t.clock.now()))
      ws.sendBinary(f);
    ws.send({ type: "end" });
    await ws.waitFor((m) => m.type === "closed");
    await t.drain();
    expect(t.fakes.stt.calls).toHaveLength(0);
    const jobs = await t.db.query<{ status: string }>(
      "SELECT j.status FROM jobs j JOIN audio_chunks a ON a.id = j.payload->>'chunkId' WHERE a.stream_id = $1",
      [streamId],
    );
    expect(jobs.map((j) => j.status)).toEqual(["parked"]);
    const streams = await t.api.get("/streams", { token: owner.token });
    expect(streams.body.find((s: { id: string }) => s.id === streamId).statusDetail).toContain(
      "speech-to-text",
    );
    expect(
      await t.db.query("SELECT 1 FROM audio_chunks WHERE stream_id = $1 AND path IS NOT NULL", [
        streamId,
      ]),
    ).toHaveLength(1);

    // Configuring STT releases the parked work.
    t.fakes.stt.script = () => ({
      text: "late",
      segments: [{ startSec: 0, endSec: 1, text: "late words" }],
    });
    await configureProvider(t.api, owner.token, "stt");
    await t.drain();
    expect(t.fakes.stt.calls.length).toBeGreaterThanOrEqual(1);
    expect(await t.db.query("SELECT 1 FROM jobs WHERE status = 'parked'")).toHaveLength(0);
    expect(
      await t.db.query("SELECT 1 FROM raw_segments WHERE stream_id = $1", [streamId]),
    ).toHaveLength(1);
  });
});
