import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadMigrations, migrate } from "../src/db/migrate.js";
import { openPglite } from "../src/db/pglite.js";
import {
  acceptAllConsents,
  configureProvider,
  eventually,
  hello,
  PASSWORD,
  pairDevice,
  setupOwner,
  startTestServer,
  T0,
  type TestServer,
  WsClient,
} from "./helpers.js";

/** Opens the SSE stream with a bearer token and collects parsed events. */
function sse(
  url: string,
  token: string,
): { events: any[]; ready: Promise<Response>; close: () => void } {
  const events: any[] = [];
  const ctl = new AbortController();
  const ready = fetch(`${url}/api/v1/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: ctl.signal,
  }).then((res) => {
    if (res.body) {
      void (async () => {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i = buf.indexOf("\n\n");
            while (i >= 0) {
              const data = buf
                .slice(0, i)
                .split("\n")
                .find((l) => l.startsWith("data: "));
              if (data) events.push(JSON.parse(data.slice(6)));
              buf = buf.slice(i + 2);
              i = buf.indexOf("\n\n");
            }
          }
        } catch {
          // aborted
        }
      })();
    }
    return res;
  });
  return { events, ready, close: () => ctl.abort() };
}

describe("device access levels", () => {
  let t: TestServer;
  let owner: { token: string; userId: string };
  let capture: { token: string; deviceId: string };
  let phone: { token: string; deviceId: string };
  let conversationId: string;
  let itemId: string;

  beforeAll(async () => {
    t = await startTestServer();
    owner = await setupOwner(t.api);
    await acceptAllConsents(t.api, owner.token);
    await configureProvider(t.api, owner.token, "llm");
    t.fakes.llm.json = () => ({
      title: "Plan",
      summary: "We planned.",
      notes: "- plan",
      decisions: [],
      actionItems: [{ text: "Call the plumber", owner: null, due: null }],
      participants: [],
      topics: [],
      language: "en",
      memories: [],
    });
    capture = await pairDevice(t.api, owner.token, "Watch", "apple_watch");
    const code = await t.api.post(
      "/devices/pairing-codes",
      { access: "memory" },
      { token: owner.token },
    );
    expect(code.status).toBe(201);
    expect(code.body.access).toBe("memory");
    const paired = await t.api.post("/devices/pair", {
      code: code.body.code,
      name: "Phone",
      kind: "iphone",
    });
    expect(paired.body.device.access).toBe("memory");
    phone = { token: paired.body.token, deviceId: paired.body.device.id };

    // One conversation with an action item to read and tick.
    const now = t.clock.now();
    await t.api.post(
      "/ingest/transcripts",
      {
        streamId: randomUUID(),
        source: "mic",
        clientTimeMs: now,
        segments: [{ id: "1", startMs: now, endMs: now + 2000, text: "we need a plumber" }],
      },
      { token: capture.token },
    );
    await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 10 * 60_000 });
    const list = await t.api.get("/conversations", { token: owner.token });
    conversationId = list.body.items[0].id;
    itemId = (await t.api.get(`/conversations/${conversationId}`, { token: owner.token })).body
      .actionItems[0].id;
  });
  afterAll(async () => {
    await t.close();
  });

  it("defaults pairing codes to capture access and reports access everywhere", async () => {
    const plain = await t.api.post("/devices/pairing-codes", undefined, { token: owner.token });
    expect(plain.body.access).toBe("capture");
    const bad = await t.api.post(
      "/devices/pairing-codes",
      { access: "admin" },
      { token: owner.token },
    );
    expect(bad.status).toBe(400);
    const devices = await t.api.get("/devices", { token: owner.token });
    expect(Array.isArray(devices.body)).toBe(true);
    expect(devices.body.find((d: { id: string }) => d.id === phone.deviceId).access).toBe("memory");
    expect(devices.body.find((d: { id: string }) => d.id === capture.deviceId).access).toBe(
      "capture",
    );
    expect((await t.api.get("/devices/self", { token: phone.token })).body.access).toBe("memory");
  });

  it("lets a memory device do exactly what DEVICE_ROUTES lists", async () => {
    const tok = { token: phone.token };
    expect((await t.api.get("/conversations", tok)).status).toBe(200);
    expect((await t.api.get(`/conversations/${conversationId}`, tok)).status).toBe(200);
    const tick = await t.api.patch(
      `/conversations/${conversationId}/action-items/${itemId}`,
      { done: true },
      tok,
    );
    expect(tick.status).toBe(200);
    expect(tick.body.done).toBe(true);
    expect((await t.api.get("/memories", tok)).status).toBe(200);
    expect((await t.api.post("/memories", { content: "Phone memory" }, tok)).status).toBe(201);
    expect((await t.api.post("/search", { query: "plumber" }, tok)).status).toBe(200);
    expect((await t.api.post("/ask", { question: "plumber?" }, tok)).status).toBe(200);
    expect((await t.api.get("/streams", tok)).status).toBe(200);
    expect((await t.api.get("/days", tok)).status).toBe(200);
    const days = (await t.api.get("/days", tok)).body.items;
    expect((await t.api.get(`/days/${days[0].date}`, tok)).status).toBe(200);
    const stream = sse(t.url, phone.token);
    const res = await stream.ready;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    stream.close();
    // Capture routes too.
    expect((await t.api.get("/me", tok)).status).toBe(200);
    expect((await t.api.get("/consents", tok)).status).toBe(200);

    // …and nothing else.
    for (const [method, path, body] of [
      ["PATCH", `/conversations/${conversationId}`, { title: "x" }],
      ["DELETE", `/conversations/${conversationId}`, undefined],
      ["POST", `/conversations/${conversationId}/reprocess`, undefined],
      ["PATCH", "/memories/whatever", { content: "x" }],
      ["DELETE", "/memories/whatever", undefined],
      ["GET", "/settings", undefined],
      [
        "PUT",
        "/settings/privacy",
        {
          ingestPaused: false,
          retainAudio: false,
          audioRetentionDays: null,
          dataRetentionDays: null,
        },
      ],
      ["GET", "/providers/catalog", undefined],
      ["GET", "/export", undefined],
      ["DELETE", "/data", { confirm: "DELETE" }],
      ["DELETE", "/account", { password: PASSWORD, confirm: "DELETE" }],
      ["GET", "/devices", undefined],
      ["POST", "/devices/pairing-codes", undefined],
      ["PATCH", `/devices/${phone.deviceId}`, { access: "memory" }],
      ["DELETE", `/devices/${capture.deviceId}`, undefined],
      ["PATCH", "/me", { displayName: "x" }],
      ["POST", `/days/${days[0].date}/regenerate`, undefined],
    ] as const) {
      const r = await t.api.req(method, path, { ...tok, ...(body !== undefined ? { body } : {}) });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
    }
  });

  it("keeps a capture device to capture routes", async () => {
    const tok = { token: capture.token };
    for (const [method, path] of [
      ["GET", "/conversations"],
      ["GET", `/conversations/${conversationId}`],
      ["GET", "/memories"],
      ["POST", "/search"],
      ["POST", "/ask"],
      ["GET", "/streams"],
      ["GET", "/events"],
      ["GET", "/days"],
      ["POST", "/capture/pause"],
    ] as const) {
      const r = await t.api.req(method, path, {
        ...tok,
        body: method === "POST" ? { query: "x", question: "x", paused: true } : undefined,
      });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect((await t.api.get("/me", tok)).status).toBe(200);
    expect((await t.api.get("/devices/self", tok)).status).toBe(200);
  });

  it("only a user session can change a device's access", async () => {
    const up = await t.api.patch(
      `/devices/${capture.deviceId}`,
      { access: "memory" },
      { token: owner.token },
    );
    expect(up.body.access).toBe("memory");
    expect((await t.api.get("/conversations", { token: capture.token })).status).toBe(200);
    const down = await t.api.patch(
      `/devices/${capture.deviceId}`,
      { access: "capture" },
      { token: owner.token },
    );
    expect(down.body.access).toBe("capture");
    expect((await t.api.get("/conversations", { token: capture.token })).status).toBe(403);
  });

  it("the kill switch from the phone pauses everywhere and is announced", async () => {
    const watcher = sse(t.url, owner.token);
    await watcher.ready;
    const ws = new WsClient(t.url);
    await ws.opened;
    ws.send(hello(capture.token, randomUUID(), { mode: "transcript", audio: undefined }));
    await ws.waitFor((m) => m.type === "ready");

    const paused = await t.api.post("/capture/pause", { paused: true }, { token: phone.token });
    expect(paused.body).toEqual({ ingestPaused: true });
    expect(await ws.closed).toBe(4403);
    await eventually(async () =>
      watcher.events.find((e) => e.type === "capture_paused" && e.ingestPaused === true),
    );
    expect((await t.api.get("/me", { token: owner.token })).body.ingestPaused).toBe(true);
    const refused = await t.api.post(
      "/ingest/transcripts",
      {
        streamId: randomUUID(),
        source: "mic",
        clientTimeMs: T0,
        segments: [{ startMs: T0, endMs: T0 + 1, text: "x" }],
      },
      { token: capture.token },
    );
    expect(refused.body.error.code).toBe("ingest_paused");
    expect(
      (await t.api.post("/capture/pause", { paused: "yes" }, { token: phone.token })).status,
    ).toBe(400);

    // Unpausing through privacy settings behaves the same and is announced too.
    const s = (await t.api.get("/settings", { token: owner.token })).body;
    expect(s.privacy.ingestPaused).toBe(true);
    await t.api.put(
      "/settings/privacy",
      { ...s.privacy, ingestPaused: false },
      { token: owner.token },
    );
    await eventually(async () =>
      watcher.events.find((e) => e.type === "capture_paused" && e.ingestPaused === false),
    );
    expect(
      (await t.api.post("/capture/pause", { paused: true }, { token: phone.token })).body
        .ingestPaused,
    ).toBe(true);
    expect(
      (await t.api.post("/capture/pause", { paused: false }, { token: phone.token })).body
        .ingestPaused,
    ).toBe(false);
    watcher.close();
    await eventually(async () => t.server.ctx.bus.subscriberCount(owner.userId) === 0);
  });
});

describe("pipeline settings", () => {
  it("validates the time zone, takes it from setup, and fills defaults", async () => {
    const t = await startTestServer();
    try {
      const bad = await t.api.post("/auth/setup", {
        email: "a@example.org",
        password: PASSWORD,
        displayName: "A",
        timeZone: "Mars/Olympus",
      });
      expect(bad.status).toBe(400);
      const r = await t.api.post("/auth/setup", {
        email: "a@example.org",
        password: PASSWORD,
        displayName: "A",
        timeZone: "Europe/Istanbul",
      });
      expect(r.status).toBe(201);
      const s = await t.api.get("/settings", { token: r.body.token });
      expect(s.body.pipeline).toEqual({
        language: null,
        conversationGapMinutes: 5,
        extractMemories: true,
        liveNotesMinutes: 15,
        dailyDigest: true,
        timeZone: "Europe/Istanbul",
      });
      const put = await t.api.put(
        "/settings/pipeline",
        { ...s.body.pipeline, timeZone: "Nowhere/Land" },
        { token: r.body.token },
      );
      expect(put.status).toBe(400);
      const ok = await t.api.put(
        "/settings/pipeline",
        { ...s.body.pipeline, timeZone: "America/New_York", liveNotesMinutes: 0 },
        { token: r.body.token },
      );
      expect(ok.body).toMatchObject({ timeZone: "America/New_York", liveNotesMinutes: 0 });
    } finally {
      await t.close();
    }
  });

  it("passes per-role timeouts to every provider", async () => {
    expect(() =>
      loadConfig({
        LTM_LLM_TIMEOUT_MS: "soon",
        LTM_SECRET_KEY: Buffer.alloc(32).toString("base64"),
      }),
    ).toThrow(/LTM_LLM_TIMEOUT_MS/);
    const t = await startTestServer({ env: { LTM_LLM_TIMEOUT_MS: "900000" } });
    try {
      const o = await setupOwner(t.api);
      for (const role of ["llm", "stt", "embedding"] as const)
        await configureProvider(t.api, o.token, role);
      t.fakes.created.length = 0;
      await t.api.post("/ask", { question: "anything?" }, { token: o.token });
      expect(t.fakes.created.find((c) => c.role === "llm")?.timeoutMs).toBe(900_000);
      expect(t.fakes.created.find((c) => c.role === "embedding")?.timeoutMs).toBe(120_000);
      expect(t.server.ctx.config.providerTimeoutsMs.stt).toBe(300_000);
    } finally {
      await t.close();
    }
  });

  it("migration 0002 gives existing rows the new defaults", async () => {
    const db = await openPglite(null);
    try {
      const all = loadMigrations();
      await migrate(db, all.slice(0, 1));
      await db.query(
        "INSERT INTO users (id, email, display_name, role, locale, password_hash, created_at) VALUES ('u1', 'x@example.org', 'X', 'owner', 'en', 'h', 0)",
      );
      await db.query(
        `INSERT INTO user_settings (user_id, privacy, pipeline, updated_at) VALUES ('u1', '{}'::jsonb, '{"language":"tr","conversationGapMinutes":9,"extractMemories":false}'::jsonb, 0)`,
      );
      await db.query(
        "INSERT INTO devices (id, user_id, name, kind, token_hash, created_at) VALUES ('d1', 'u1', 'D', 'iphone', 'h', 0)",
      );
      await db.query(
        "INSERT INTO conversations (id, user_id, status, start_ms, end_ms, created_at, updated_at) VALUES ('c1', 'u1', 'ready', $1, $1, 0, 0)",
        [Date.UTC(2026, 0, 2, 23, 30)],
      );
      expect(await migrate(db)).toEqual(["0002_all_day.sql"]);
      const s = (
        await db.query<{ pipeline: Record<string, unknown> }>("SELECT pipeline FROM user_settings")
      )[0]!.pipeline;
      expect(s).toEqual({
        language: "tr",
        conversationGapMinutes: 9,
        extractMemories: false,
        liveNotesMinutes: 15,
        dailyDigest: true,
        timeZone: "UTC",
      });
      expect((await db.query<{ access: string }>("SELECT access FROM devices"))[0]!.access).toBe(
        "capture",
      );
      expect(
        (await db.query<{ local_date: string }>("SELECT local_date FROM conversations"))[0]!
          .local_date,
      ).toBe("2026-01-02");
      expect(await migrate(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
