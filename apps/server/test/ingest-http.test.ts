import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pcmToWav } from "@ltm/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptAllConsents,
  configureProvider,
  pairDevice,
  pcm,
  setupOwner,
  startTestServer,
  T0,
  type TestServer,
} from "./helpers.js";

async function upload(
  t: TestServer,
  token: string,
  meta: Record<string, unknown>,
  audio: Uint8Array,
  type = "audio/wav",
) {
  const form = new FormData();
  form.set("meta", JSON.stringify(meta));
  form.set("audio", new Blob([audio], { type }), "chunk.bin");
  const res = await fetch(`${t.url}/api/v1/ingest/chunks`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("HTTP ingest", () => {
  let t: TestServer;
  let owner: { token: string; userId: string };
  let watch: { token: string; deviceId: string };

  beforeAll(async () => {
    t = await startTestServer();
    owner = await setupOwner(t.api);
    await acceptAllConsents(t.api, owner.token);
    watch = await pairDevice(t.api, owner.token, "Watch", "apple_watch");
    await configureProvider(t.api, owner.token, "stt");
  });
  afterAll(async () => {
    await t.close();
  });

  it("stores chunks idempotently on (streamId, seq) and applies a large clock offset", async () => {
    const streamId = randomUUID();
    const wav = pcmToWav(pcm(2000, true), 16000);
    // The watch clock is 60 s behind the server.
    const skew = 60_000;
    const meta = {
      streamId,
      seq: 0,
      source: "ambient",
      startMs: T0 - skew - 30_000,
      durationMs: 2000,
      clientTimeMs: t.clock.now() - skew,
      language: "en",
    };
    const first = await upload(t, watch.token, meta, wav);
    expect(first).toEqual({ status: 201, body: { streamId, seq: 0, created: true } });
    const again = await upload(t, watch.token, meta, wav);
    expect(again).toEqual({ status: 200, body: { streamId, seq: 0, created: false } });

    const rows = await t.db.query<{ start_ms: number; path: string }>(
      "SELECT start_ms, path FROM audio_chunks WHERE stream_id = $1",
      [streamId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.start_ms).toBe(T0 - 30_000);
    const file = join(t.dataDir, "audio", rows[0]!.path);
    expect(existsSync(file)).toBe(true);
    expect(rows[0]!.path.startsWith(`${owner.userId}/${streamId}/`)).toBe(true);

    t.fakes.stt.calls = [];
    t.fakes.stt.script = () => ({
      text: "watch words",
      language: "en",
      segments: [{ startSec: 0.5, endSec: 1.5, text: "watch words" }],
    });
    await t.drain();
    expect(t.fakes.stt.calls).toHaveLength(1);
    expect(t.fakes.stt.calls[0]!.language).toBe("en");
    const segs = await t.db.query<{ start_ms: number }>(
      "SELECT start_ms FROM raw_segments WHERE stream_id = $1",
      [streamId],
    );
    expect(segs.map((s) => s.start_ms)).toEqual([T0 - 30_000 + 500]);
    // Transcribed audio is deleted (retainAudio defaults to false).
    expect(existsSync(file)).toBe(false);

    const final = await upload(
      t,
      watch.token,
      { ...meta, seq: 1, startMs: meta.startMs + 2000, final: true },
      wav,
    );
    expect(final.body.created).toBe(true);
    const stream = await t.db.query<{ ended_at: number | null }>(
      "SELECT ended_at FROM streams WHERE id = $1",
      [streamId],
    );
    expect(stream[0]!.ended_at).not.toBeNull();
  });

  it("validates chunk uploads", async () => {
    const streamId = randomUUID();
    const meta = {
      streamId,
      seq: 0,
      source: "ambient",
      startMs: T0,
      durationMs: 1000,
      clientTimeMs: T0,
    };
    expect(
      (await upload(t, watch.token, meta, new Uint8Array(10), "video/mp4")).body.error.code,
    ).toBe("unsupported_codec");
    expect((await upload(t, watch.token, { ...meta, seq: -1 }, new Uint8Array(10))).status).toBe(
      400,
    );
    expect((await upload(t, owner.token, meta, new Uint8Array(10))).status).toBe(403);
    const other = await pairDevice(t.api, owner.token, "Phone", "iphone");
    await upload(t, watch.token, meta, new Uint8Array(10));
    expect((await upload(t, other.token, { ...meta, seq: 1 }, new Uint8Array(10))).status).toBe(
      403,
    );
  });

  it("accepts transcript batches idempotently (client ids and content hashes)", async () => {
    const streamId = randomUUID();
    const batch = {
      streamId,
      source: "mic",
      clientTimeMs: t.clock.now(),
      segments: [
        { id: "x1", startMs: T0 + 1000, endMs: T0 + 2000, text: "first" },
        { id: "x2", startMs: T0 + 2000, endMs: T0 + 3000, text: "second" },
        { startMs: T0 + 3000, endMs: T0 + 4000, text: "no id" },
      ],
    };
    const a = await t.api.post("/ingest/transcripts", batch, { token: watch.token });
    expect(a.body).toEqual({ streamId, accepted: 3, duplicates: 0 });
    const b = await t.api.post(
      "/ingest/transcripts",
      {
        ...batch,
        segments: [
          ...batch.segments,
          { id: "x3", startMs: T0 + 4000, endMs: T0 + 5000, text: "third" },
        ],
      },
      { token: watch.token },
    );
    expect(b.body).toEqual({ streamId, accepted: 1, duplicates: 3 });
    const rows = await t.db.query("SELECT 1 FROM raw_segments WHERE stream_id = $1", [streamId]);
    expect(rows).toHaveLength(4);

    expect(
      (await t.api.post(`/ingest/streams/${streamId}/end`, undefined, { token: watch.token }))
        .status,
    ).toBe(204);
    expect(
      (await t.api.post(`/ingest/streams/${randomUUID()}/end`, undefined, { token: watch.token }))
        .status,
    ).toBe(404);
    expect(
      (await t.api.post("/ingest/transcripts", { ...batch, segments: [] }, { token: watch.token }))
        .status,
    ).toBe(400);
  });
});
