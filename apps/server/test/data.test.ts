import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pcmToWav } from "@ltm/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptAllConsents,
  configureProvider,
  PASSWORD,
  pairDevice,
  pcm,
  setupOwner,
  startTestServer,
  T0,
  type TestServer,
} from "./helpers.js";

const MIN = 60_000;
const SECRET = "provider-key-ABC123-do-not-leak";

async function seedConversation(
  t: TestServer,
  deviceToken: string,
  words: string,
  atMs: number,
): Promise<void> {
  await t.api.post(
    "/ingest/transcripts",
    {
      streamId: randomUUID(),
      source: "mic",
      clientTimeMs: t.clock.now(),
      segments: [
        { id: "1", startMs: atMs, endMs: atMs + 2000, text: `${words} one` },
        { id: "2", startMs: atMs + 3000, endMs: atMs + 5000, text: `${words} two` },
      ],
    },
    { token: deviceToken },
  );
  await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 10 * MIN });
}

async function tableCounts(t: TestServer, userId: string): Promise<Record<string, number>> {
  const tables = [
    "devices",
    "sessions",
    "consent_records",
    "provider_settings",
    "user_settings",
    "streams",
    "audio_chunks",
    "raw_segments",
    "conversations",
    "utterances",
    "action_items",
    "memories",
    "embeddings",
    "jobs",
  ];
  const out: Record<string, number> = {};
  for (const tbl of tables) {
    out[tbl] = (
      await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tbl} WHERE user_id = $1`, [
        userId,
      ])
    )[0]!.n;
  }
  return out;
}

describe("data rights, isolation and provider secrets", () => {
  let t: TestServer;
  let owner: { token: string; userId: string };
  let device: { token: string; deviceId: string };
  let member: { token: string; userId: string };
  let memberDevice: { token: string; deviceId: string };

  beforeAll(async () => {
    t = await startTestServer({ env: { LTM_ALLOW_REGISTRATION: "true" } });
    owner = await setupOwner(t.api);
    await acceptAllConsents(t.api, owner.token);
    device = await pairDevice(t.api, owner.token, "Phone", "iphone");
    for (const role of ["llm", "embedding", "stt"] as const)
      await configureProvider(t.api, owner.token, role);
    t.fakes.llm.json = (req) => ({
      title: req.prompt.includes("secret plan") ? "Secret plan" : "Other",
      summary: "A summary.",
      notes: "Notes.",
      decisions: [],
      actionItems: [{ text: "Do the thing", owner: null, due: null }],
      participants: [],
      topics: [],
      language: "en",
      memories: [
        {
          kind: "fact",
          content: `Memory from ${req.prompt.includes("secret plan") ? "plan" : "other"}.`,
          importance: 3,
          subjects: [],
          occurredAt: null,
        },
      ],
    });
    await seedConversation(t, device.token, "the secret plan", t.clock.now());

    const reg = await t.api.post("/auth/register", {
      email: "member@example.org",
      password: PASSWORD,
      displayName: "Member",
    });
    member = { token: reg.body.token, userId: reg.body.user.id };
    await acceptAllConsents(t.api, member.token);
    memberDevice = await pairDevice(t.api, member.token, "Member phone", "iphone");
  });
  afterAll(async () => {
    await t.close();
  });

  it("never returns API keys and stores them encrypted", async () => {
    const put = await t.api.put(
      "/settings/providers/llm",
      { kind: "openai", apiKey: SECRET, model: "gpt-x" },
      { token: owner.token },
    );
    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      role: "llm",
      kind: "openai",
      model: "gpt-x",
      baseUrl: null,
      hasApiKey: true,
      origin: "user",
      thirdParty: true,
    });
    const settings = await t.api.get("/settings", { token: owner.token });
    expect(JSON.stringify(settings.body)).not.toContain(SECRET);
    const row = (
      await t.db.query<{ api_key_enc: string }>(
        "SELECT api_key_enc FROM provider_settings WHERE user_id = $1 AND role = 'llm'",
        [owner.userId],
      )
    )[0]!;
    expect(row.api_key_enc).toBeTruthy();
    expect(row.api_key_enc).not.toContain(SECRET);
    expect(Buffer.from(row.api_key_enc, "base64").toString("utf8")).not.toContain(SECRET);

    // The factory receives the decrypted key.
    t.fakes.created.length = 0;
    const probe = await t.api.post("/settings/providers/llm/test", undefined, {
      token: owner.token,
    });
    expect(probe.body).toEqual({ ok: true, message: "probed openai", latencyMs: 1 });
    await t.api.post("/ask", { question: "what plan?" }, { token: owner.token });
    expect(t.fakes.created.find((c) => c.role === "llm")?.apiKey).toBe(SECRET);

    // Omitting the key keeps it; null deletes it; a vendor switch drops it.
    const keep = await t.api.put(
      "/settings/providers/llm",
      { kind: "openai", model: "gpt-y" },
      { token: owner.token },
    );
    expect(keep.body.hasApiKey).toBe(true);
    const sttKeyed = await t.api.put(
      "/settings/providers/stt",
      { kind: "openai_compatible", baseUrl: "http://127.0.0.1:9/v1", apiKey: "local-key" },
      { token: owner.token },
    );
    expect(sttKeyed.body.hasApiKey).toBe(true);
    const sttDeleted = await t.api.put(
      "/settings/providers/stt",
      { kind: "openai_compatible", baseUrl: "http://127.0.0.1:9/v1", apiKey: null },
      { token: owner.token },
    );
    expect(sttDeleted.body.hasApiKey).toBe(false);
    expect(
      (
        await t.db.query<{ api_key_enc: string | null }>(
          "SELECT api_key_enc FROM provider_settings WHERE user_id = $1 AND role = 'stt'",
          [owner.userId],
        )
      )[0]!.api_key_enc,
    ).toBeNull();
    const switched = await t.api.put(
      "/settings/providers/llm",
      { kind: "openai_compatible", baseUrl: "http://127.0.0.1:11434/v1" },
      { token: owner.token },
    );
    expect(switched.body).toMatchObject({ hasApiKey: false, thirdParty: false });
    expect(
      (await t.api.put("/settings/providers/llm", { kind: "anthropic" }, { token: owner.token }))
        .status,
    ).toBe(400);
    expect(
      (
        await t.api.put(
          "/settings/providers/stt",
          { kind: "anthropic", apiKey: "x" },
          { token: owner.token },
        )
      ).status,
    ).toBe(400);
    await configureProvider(t.api, owner.token, "llm");
  });

  it("offers and accepts CLI providers only for the owner", async () => {
    const cliOwner = await t.api.put(
      "/settings/providers/llm",
      { kind: "claude_code_cli" },
      { token: owner.token },
    );
    expect(cliOwner.status).toBe(200);
    expect(cliOwner.body).toMatchObject({ kind: "claude_code_cli", thirdParty: true });
    await configureProvider(t.api, owner.token, "llm");

    const cliMember = await t.api.put(
      "/settings/providers/llm",
      { kind: "codex_cli" },
      { token: member.token },
    );
    expect(cliMember.status).toBe(403);
    const catOwner = await t.api.get("/providers/catalog", { token: owner.token });
    expect(
      catOwner.body.entries.find((e: { kind: string }) => e.kind === "codex_cli").available,
    ).toBe(true);
    const catMember = await t.api.get("/providers/catalog", { token: member.token });
    expect(
      catMember.body.entries.find((e: { kind: string }) => e.kind === "codex_cli"),
    ).toMatchObject({ available: false });
  });

  it("rejects CLI providers when the instance disables them", async () => {
    const t2 = await startTestServer({ env: { LTM_ALLOW_CLI_PROVIDERS: "false" } });
    try {
      const o = await setupOwner(t2.api);
      const r = await t2.api.put(
        "/settings/providers/llm",
        { kind: "claude_code_cli" },
        { token: o.token },
      );
      expect(r.status).toBe(403);
      const cat = await t2.api.get("/providers/catalog", { token: o.token });
      expect(
        cat.body.entries.filter(
          (e: { kind: string; available: boolean }) => e.kind.endsWith("_cli") && e.available,
        ),
      ).toEqual([]);
    } finally {
      await t2.close();
    }
  });

  it("does not let a second user read or change the first user's objects", async () => {
    const [conv] = (await t.api.get("/conversations", { token: owner.token })).body.items;
    expect(conv).toBeTruthy();
    const detail = (await t.api.get(`/conversations/${conv.id}`, { token: owner.token })).body;
    const memId = detail.memoryIds[0];
    const itemId = detail.actionItems[0].id;

    expect((await t.api.get("/conversations", { token: member.token })).body.items).toEqual([]);
    expect((await t.api.get(`/conversations/${conv.id}`, { token: member.token })).status).toBe(
      404,
    );
    expect(
      (await t.api.patch(`/conversations/${conv.id}`, { title: "pwned" }, { token: member.token }))
        .status,
    ).toBe(404);
    expect(
      (await t.api.del(`/conversations/${conv.id}`, undefined, { token: member.token })).status,
    ).toBe(404);
    expect(
      (await t.api.post(`/conversations/${conv.id}/reprocess`, undefined, { token: member.token }))
        .status,
    ).toBe(404);
    expect(
      (
        await t.api.patch(
          `/conversations/${conv.id}/action-items/${itemId}`,
          { done: true },
          { token: member.token },
        )
      ).status,
    ).toBe(404);
    expect(
      (await t.api.patch(`/memories/${memId}`, { content: "pwned" }, { token: member.token }))
        .status,
    ).toBe(404);
    expect((await t.api.del(`/memories/${memId}`, undefined, { token: member.token })).status).toBe(
      404,
    );
    expect((await t.api.get("/memories", { token: member.token })).body.items).toEqual([]);
    expect(
      (await t.api.post("/search", { query: "secret plan" }, { token: member.token })).body.hits,
    ).toEqual([]);
    expect((await t.api.get("/streams", { token: member.token })).body).toEqual([]);
    expect(
      (await t.api.patch(`/devices/${device.deviceId}`, { name: "pwned" }, { token: member.token }))
        .status,
    ).toBe(404);
    expect(
      (await t.api.del(`/devices/${device.deviceId}`, undefined, { token: member.token })).status,
    ).toBe(404);
    // Stream ids are global: another user's device cannot write into this user's stream.
    const ownerStream = (await t.api.get("/streams", { token: owner.token })).body[0].id;
    const hijack = await t.api.post(
      "/ingest/transcripts",
      {
        streamId: ownerStream,
        source: "mic",
        clientTimeMs: T0,
        segments: [{ startMs: T0, endMs: T0 + 1, text: "x" }],
      },
      { token: memberDevice.token },
    );
    expect(hijack.status).toBe(403);
    expect((await t.api.get(`/conversations/${conv.id}`, { token: owner.token })).body.title).toBe(
      "Secret plan",
    );
  });

  it("manual memories are created, embedded, updated and deleted", async () => {
    const created = await t.api.post(
      "/memories",
      { content: "My bike lock code is not something to store here.", kind: "fact" },
      { token: owner.token },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      origin: "manual",
      importance: 3,
      sourceConversationId: null,
      subjects: [],
    });
    await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: MIN });
    const emb = await t.db.query("SELECT 1 FROM embeddings WHERE memory_id = $1", [
      created.body.id,
    ]);
    expect(emb).toHaveLength(1);
    const upd = await t.api.patch(
      `/memories/${created.body.id}`,
      { content: "I ride a blue bike.", importance: 2 },
      { token: owner.token },
    );
    expect(upd.body).toMatchObject({ content: "I ride a blue bike.", importance: 2 });
    const byKind = await t.api.get("/memories?kind=fact&q=bike", { token: owner.token });
    expect(byKind.body.items.map((m: { id: string }) => m.id)).toEqual([created.body.id]);
    expect(
      (await t.api.del(`/memories/${created.body.id}`, undefined, { token: owner.token })).status,
    ).toBe(204);
    expect(
      await t.db.query("SELECT 1 FROM embeddings WHERE memory_id = $1", [created.body.id]),
    ).toHaveLength(0);
  });

  it("exports everything without secrets", async () => {
    const res = await fetch(`${t.url}/api/v1/export`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="ltm-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const text = await res.text();
    const data = JSON.parse(text);
    expect(data.user.email).toBe("owner@example.org");
    expect(data.conversations).toHaveLength(1);
    expect(data.conversations[0].utterances.length).toBeGreaterThan(0);
    expect(data.conversations[0].title).toBe("Secret plan");
    expect(data.rawSegments.length).toBeGreaterThan(0);
    expect(data.memories.length).toBeGreaterThan(0);
    expect(data.devices[0].name).toBe("Phone");
    expect(data.settings.privacy).toBeTruthy();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("scrypt$");
    expect(text).not.toContain("token_hash");
    expect(text).not.toContain("api_key");
    expect(text).not.toContain(owner.token);
  });

  it("DELETE /data erases captured data (rows and audio files) but keeps the account", async () => {
    // Keep audio after transcription so there are files to erase.
    const s = (await t.api.get("/settings", { token: owner.token })).body;
    await t.api.put(
      "/settings/privacy",
      { ...s.privacy, retainAudio: true },
      { token: owner.token },
    );
    t.fakes.stt.script = () => ({
      text: "kept audio",
      segments: [{ startSec: 0, endSec: 1, text: "kept audio" }],
    });
    const form = new FormData();
    const streamId = randomUUID();
    form.set(
      "meta",
      JSON.stringify({
        streamId,
        seq: 0,
        source: "ambient",
        startMs: t.clock.now(),
        durationMs: 1000,
        clientTimeMs: t.clock.now(),
      }),
    );
    form.set("audio", new Blob([pcmToWav(pcm(1000, true), 16000)], { type: "audio/wav" }), "a.wav");
    expect(
      (
        await fetch(`${t.url}/api/v1/ingest/chunks`, {
          method: "POST",
          headers: { authorization: `Bearer ${device.token}` },
          body: form,
        })
      ).status,
    ).toBe(201);
    await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 10 * MIN });
    const audioDir = join(t.dataDir, "audio", owner.userId);
    expect(readdirSync(join(audioDir, streamId))).toHaveLength(1);

    expect((await t.api.del("/data", { confirm: "nope" }, { token: owner.token })).status).toBe(
      400,
    );
    expect((await t.api.del("/data", { confirm: "DELETE" }, { token: owner.token })).status).toBe(
      204,
    );
    const counts = await tableCounts(t, owner.userId);
    for (const tbl of [
      "streams",
      "audio_chunks",
      "raw_segments",
      "conversations",
      "utterances",
      "action_items",
      "memories",
      "embeddings",
    ]) {
      expect(counts[tbl], tbl).toBe(0);
    }
    expect(counts.devices).toBe(1);
    expect(counts.consent_records).toBeGreaterThan(0);
    expect(existsSync(audioDir)).toBe(false);
    expect((await t.api.get("/me", { token: owner.token })).status).toBe(200);
    // The other user is untouched.
    expect((await t.api.get("/me", { token: member.token })).status).toBe(200);
  });

  it("DELETE /account checks the password and erases every row and file", async () => {
    await seedConversation(t, memberDevice.token, "member talk", t.clock.now() + 60 * MIN);
    expect((await tableCounts(t, member.userId)).conversations).toBe(1);
    const wrong = await t.api.del(
      "/account",
      { password: "not the password", confirm: "DELETE" },
      { token: member.token },
    );
    expect(wrong.status).toBe(403);
    const ok = await t.api.del(
      "/account",
      { password: PASSWORD, confirm: "DELETE" },
      { token: member.token },
    );
    expect(ok.status).toBe(204);
    const counts = await tableCounts(t, member.userId);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    expect(await t.db.query("SELECT 1 FROM users WHERE id = $1", [member.userId])).toHaveLength(0);
    expect(existsSync(join(t.dataDir, "audio", member.userId))).toBe(false);
    expect((await t.api.get("/me", { token: member.token })).status).toBe(401);
    expect((await t.api.get("/me", { token: memberDevice.token })).status).toBe(401);
  });

  it("retention deletes old data and transcribed audio", async () => {
    await seedConversation(t, device.token, "old talk", t.clock.now());
    const s = (await t.api.get("/settings", { token: owner.token })).body;
    await t.api.put(
      "/settings/privacy",
      { ...s.privacy, dataRetentionDays: 1 },
      { token: owner.token },
    );
    t.clock.advance(2 * 24 * 3600_000);
    await t.server.worker.drain();
    expect((await t.api.get("/conversations", { token: owner.token })).body.items).toEqual([]);
  });
});
