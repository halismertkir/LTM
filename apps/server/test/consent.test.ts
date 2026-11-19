import { randomUUID } from "node:crypto";
import { CONSENT_DOCUMENTS } from "@ltm/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptAllConsents,
  hello,
  pairDevice,
  setupOwner,
  startTestServer,
  T0,
  type TestServer,
  WsClient,
} from "./helpers.js";

function batch(streamId: string, text = "hello there") {
  return {
    streamId,
    source: "mic",
    clientTimeMs: T0,
    segments: [{ id: "s1", startMs: T0 - 5000, endMs: T0 - 3000, text }],
  };
}

describe("consent gate", () => {
  let t: TestServer;
  let owner: { token: string; userId: string };
  let device: { token: string; deviceId: string };

  beforeAll(async () => {
    t = await startTestServer();
    owner = await setupOwner(t.api);
    device = await pairDevice(t.api, owner.token, "Phone", "iphone");
  });
  afterAll(async () => {
    await t.close();
  });

  it("refuses every ingest path before consent", async () => {
    const state = await t.api.get("/consents", { token: device.token });
    expect(state.body.satisfied).toBe(false);
    expect(state.body.required.map((r: { type: string }) => r.type).sort()).toEqual([
      "data_processing",
      "recording_responsibility",
    ]);

    const tr = await t.api.post("/ingest/transcripts", batch(randomUUID()), {
      token: device.token,
    });
    expect(tr.status).toBe(403);
    expect(tr.body.error.code).toBe("consent_required");

    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        streamId: randomUUID(),
        seq: 0,
        source: "ambient",
        startMs: T0,
        durationMs: 1000,
        clientTimeMs: T0,
      }),
    );
    form.set("audio", new Blob([new Uint8Array(100)], { type: "audio/wav" }), "a.wav");
    const chunk = await fetch(`${t.url}/api/v1/ingest/chunks`, {
      method: "POST",
      headers: { authorization: `Bearer ${device.token}` },
      body: form,
    });
    expect(chunk.status).toBe(403);
    expect(((await chunk.json()) as { error: { code: string } }).error.code).toBe(
      "consent_required",
    );

    const ws = new WsClient(t.url);
    await ws.opened;
    ws.send(hello(device.token, randomUUID()));
    const err = await ws.waitFor((m) => m.type === "error");
    expect(err).toMatchObject({ code: "consent_required", fatal: true });
    expect(await ws.closed).toBe(4403);
  });

  it("rejects outdated consent versions", async () => {
    const r = await t.api.post(
      "/consents",
      { accept: [{ type: "data_processing", version: "2000-01-01" }] },
      { token: owner.token },
    );
    expect(r.status).toBe(400);
  });

  it("accepts consent from a device and then allows ingest", async () => {
    await acceptAllConsents(t.api, device.token, ["recording_responsibility", "data_processing"]);
    const state = await t.api.get("/consents", { token: owner.token });
    expect(state.body.satisfied).toBe(true);
    expect(
      state.body.records.every((r: { via: string }) => r.via === `device:${device.deviceId}`),
    ).toBe(true);
    const tr = await t.api.post("/ingest/transcripts", batch(randomUUID()), {
      token: device.token,
    });
    expect(tr.status).toBe(200);
  });

  it("requires third_party_ai once a third-party provider is configured", async () => {
    const put = await t.api.put(
      "/settings/providers/llm",
      { kind: "anthropic", apiKey: "test-key-not-real", model: "some-model" },
      { token: owner.token },
    );
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      kind: "anthropic",
      origin: "user",
      thirdParty: true,
      hasApiKey: true,
    });
    const state = await t.api.get("/consents", { token: owner.token });
    expect(state.body.satisfied).toBe(false);
    expect(
      state.body.required.find((r: { type: string }) => r.type === "third_party_ai"),
    ).toMatchObject({ accepted: false });
    const tr = await t.api.post("/ingest/transcripts", batch(randomUUID()), {
      token: device.token,
    });
    expect(tr.body.error.code).toBe("consent_required");

    const doc = CONSENT_DOCUMENTS.find((d) => d.type === "third_party_ai")!;
    const accepted = await t.api.post(
      "/consents",
      { accept: [{ type: doc.type, version: doc.version }] },
      { token: owner.token },
    );
    expect(accepted.body.satisfied).toBe(true);
    expect(
      (await t.api.post("/ingest/transcripts", batch(randomUUID()), { token: device.token }))
        .status,
    ).toBe(200);
  });

  it("withdrawing a required consent pauses ingest and closes live sockets", async () => {
    const streamId = randomUUID();
    const ws = new WsClient(t.url);
    await ws.opened;
    ws.send(hello(device.token, streamId, { mode: "transcript", audio: undefined }));
    await ws.waitFor((m) => m.type === "ready");

    const w = await t.api.post(
      "/consents/withdraw",
      { types: ["data_processing"] },
      { token: owner.token },
    );
    expect(w.status).toBe(200);
    expect(w.body.satisfied).toBe(false);
    const closeCode = await ws.closed;
    expect(closeCode).toBe(4403);
    const me = await t.api.get("/me", { token: owner.token });
    expect(me.body.ingestPaused).toBe(true);

    // Re-accepting alone is not enough: the kill switch stays on until the user lifts it.
    await acceptAllConsents(t.api, owner.token);
    const paused = await t.api.post("/ingest/transcripts", batch(randomUUID()), {
      token: device.token,
    });
    expect(paused.status).toBe(403);
    expect(paused.body.error.code).toBe("ingest_paused");

    const settings = await t.api.get("/settings", { token: owner.token });
    const resumed = await t.api.put(
      "/settings/privacy",
      { ...settings.body.privacy, ingestPaused: false },
      { token: owner.token },
    );
    expect(resumed.body.ingestPaused).toBe(false);
    expect(
      (await t.api.post("/ingest/transcripts", batch(randomUUID()), { token: device.token }))
        .status,
    ).toBe(200);
  });

  it("the kill switch refuses WebSocket hello with ingest_paused", async () => {
    const settings = await t.api.get("/settings", { token: owner.token });
    await t.api.put(
      "/settings/privacy",
      { ...settings.body.privacy, ingestPaused: true },
      { token: owner.token },
    );
    const ws = new WsClient(t.url);
    await ws.opened;
    ws.send(hello(device.token, randomUUID()));
    expect(await ws.waitFor((m) => m.type === "error")).toMatchObject({
      code: "ingest_paused",
      fatal: true,
    });
    expect(await ws.closed).toBe(4403);
    await t.api.put(
      "/settings/privacy",
      { ...settings.body.privacy, ingestPaused: false },
      { token: owner.token },
    );
  });
});
