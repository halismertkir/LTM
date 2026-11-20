import { randomUUID } from "node:crypto";
import type { LlmJsonRequest } from "@ltm/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptAllConsents,
  configureProvider,
  PASSWORD,
  pairDevice,
  startTestServer,
  type TestServer,
} from "./helpers.js";

const S = 1000;
const MIN = 60_000;

async function say(
  t: TestServer,
  token: string,
  streamId: string,
  at: number,
  text: string,
  language = "en",
): Promise<void> {
  const r = await t.api.post(
    "/ingest/transcripts",
    {
      streamId,
      source: "mic",
      clientTimeMs: t.clock.now(),
      segments: [{ id: `s-${at}`, startMs: at, endMs: at + 20 * S, text, language }],
    },
    { token },
  );
  if (r.status !== 200) throw new Error(`ingest failed: ${r.status} ${JSON.stringify(r.body)}`);
}

/** Runs due jobs; the clock may move forward by at most `maxAdvanceMs` to reach debounced ones. */
const run = (t: TestServer, maxAdvanceMs: number) =>
  t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs });

describe("live notes while a conversation is still going", () => {
  let t: TestServer;
  let token: string;
  let phone: { token: string; deviceId: string };
  const streamId = randomUUID();
  let convId: string;
  let start: number;

  beforeAll(async () => {
    t = await startTestServer();
    const setup = await t.api.post("/auth/setup", {
      email: "o@example.org",
      password: PASSWORD,
      displayName: "Deniz",
      timeZone: "UTC",
    });
    token = setup.body.token;
    await acceptAllConsents(t.api, token);
    await configureProvider(t.api, token, "llm");
    phone = await pairDevice(t.api, token, "Phone", "iphone");
    let pass = 0;
    t.fakes.llm.json = (req: LlmJsonRequest<unknown>) => {
      const live = req.schemaName === "conversation_live_notes";
      if (live) pass++;
      return {
        title: live ? `Planning (pass ${pass})` : "Planning (final)",
        summary: live ? `Interim summary ${pass}` : "Final summary",
        notes: live ? `## So far\n- pass ${pass}` : "## Final\n- done",
        decisions: [],
        actionItems: [
          { text: "Book the venue", owner: "self", due: null },
          ...(live && pass >= 2 ? [{ text: "Send invitations", owner: "Ayşe", due: null }] : []),
        ],
        participants: ["Ayşe"],
        topics: ["planning"],
        language: "en",
        memories: [
          {
            kind: "fact",
            content: "The venue is booked for the offsite.",
            importance: 3,
            subjects: [],
            occurredAt: null,
          },
        ],
      };
    };
    start = t.clock.now();
  });
  afterAll(async () => {
    await t.close();
  });

  it("writes interim notes after 15 minutes of speech, without memories, and stays open", async () => {
    for (let m = 0; m <= 16; m++) {
      t.clock.set(start + m * MIN + 30 * S);
      await say(t, phone.token, streamId, start + m * MIN, `minute ${m} we talk about the venue`);
      await run(t, 10 * S);
    }
    const [c] = (await t.api.get("/conversations", { token })).body.items;
    convId = c.id;
    expect(c.status).toBe("open");
    expect(c.interim).toBe(true);
    expect(c.title).toBe("Planning (pass 1)");
    const live = t.fakes.llm.callsOf("conversation_live_notes");
    expect(live).toHaveLength(1);
    expect(live[0]!.prompt).toContain("(none yet)");
    expect(live[0]!.prompt).toContain("minute 0 we talk");
    expect(live[0]!.system).toContain("empty `memories` array");
    expect(live[0]!.prompt.trim().endsWith("in English (en). Do not translate names.")).toBe(true);
    expect(t.fakes.llm.callsOf("conversation_notes")).toHaveLength(0);
    expect((await t.api.get("/memories", { token })).body.items).toEqual([]);
    const d = (await t.api.get(`/conversations/${convId}`, { token })).body;
    // "self" is the account owner: stored under their name.
    expect(d.actionItems).toEqual([
      expect.objectContaining({ text: "Book the venue", owner: "Deniz", done: false }),
    ]);
  });

  it("builds the next pass on the previous notes and only the new transcript", async () => {
    const d = (await t.api.get(`/conversations/${convId}`, { token })).body;
    const item = d.actionItems[0];
    // The item is ticked off while the conversation goes on.
    const ticked = await t.api.patch(
      `/conversations/${convId}/action-items/${item.id}`,
      { done: true },
      { token },
    );
    expect(ticked.body.done).toBe(true);
    for (let m = 17; m <= 32; m++) {
      t.clock.set(start + m * MIN + 30 * S);
      await say(t, phone.token, streamId, start + m * MIN, `minute ${m} we talk about invitations`);
      await run(t, 10 * S);
    }
    const live = t.fakes.llm.callsOf("conversation_live_notes");
    expect(live).toHaveLength(2);
    const second = live[1]!;
    expect(second.prompt).toContain("<previous_notes>");
    expect(second.prompt).toContain("Planning (pass 1)");
    expect(second.prompt).toContain("Book the venue");
    expect(second.prompt).toContain("minute 17 we talk about invitations");
    expect(second.prompt).not.toContain("minute 3 we talk about the venue");
    const after = (await t.api.get(`/conversations/${convId}`, { token })).body;
    expect(after.status).toBe("open");
    expect(after.title).toBe("Planning (pass 2)");
    const booked = after.actionItems.find((a: { text: string }) => a.text === "Book the venue");
    expect(booked).toEqual({ ...item, done: true });
    expect(after.actionItems.map((a: { text: string }) => a.text)).toContain("Send invitations");
  });

  it("the final pass replaces interim notes, extracts memories once and keeps ticked items", async () => {
    const before = (await t.api.get(`/conversations/${convId}`, { token })).body;
    await run(t, 10 * MIN);
    const d = (await t.api.get(`/conversations/${convId}`, { token })).body;
    expect(d.status).toBe("ready");
    expect(d.interim).toBe(false);
    expect(d.title).toBe("Planning (final)");
    expect(d.summary).toBe("Final summary");
    const finals = t.fakes.llm.callsOf("conversation_notes");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.prompt).toContain("minute 0 we talk"); // the whole transcript
    expect((await t.api.get("/memories", { token })).body.items).toHaveLength(1);
    const booked = d.actionItems.find((a: { text: string }) => a.text === "Book the venue");
    expect(booked.id).toBe(
      before.actionItems.find((a: { text: string }) => a.text === "Book the venue").id,
    );
    expect(booked.done).toBe(true);
    // No further interim pass on a closed conversation.
    expect(t.fakes.llm.callsOf("conversation_live_notes")).toHaveLength(2);
  });

  it("skips interim passes quietly without a language model", async () => {
    await t.api.put("/settings/providers/llm", { kind: "none" }, { token });
    const s2 = randomUUID();
    const base = t.clock.now() + 60 * MIN;
    for (let m = 0; m <= 16; m++) {
      t.clock.set(base + m * MIN + 30 * S);
      await say(t, phone.token, s2, base + m * MIN, `later minute ${m}`);
      await run(t, 10 * S);
    }
    const open = (await t.api.get("/conversations", { token })).body.items.find(
      (c: { status: string }) => c.status === "open",
    );
    expect(open).toMatchObject({ interim: false, title: null });
    expect(await t.db.query("SELECT 1 FROM jobs WHERE status = 'failed'")).toHaveLength(0);
  });
});

describe("daily digests in the user's time zone", () => {
  let t: TestServer;
  let token: string;
  let phone: { token: string; deviceId: string };
  // 2026-11-19 23:50 and 2026-11-20 00:10 in Istanbul (UTC+3).
  const lateEvening = Date.UTC(2026, 10, 19, 20, 50);
  const afterMidnight = Date.UTC(2026, 10, 19, 21, 10);

  beforeAll(async () => {
    t = await startTestServer();
    const setup = await t.api.post("/auth/setup", {
      email: "o@example.org",
      password: PASSWORD,
      displayName: "Deniz",
      locale: "tr",
      timeZone: "Europe/Istanbul",
    });
    token = setup.body.token;
    await acceptAllConsents(t.api, token);
    await configureProvider(t.api, token, "llm");
    phone = await pairDevice(t.api, token, "Phone", "iphone");
    t.fakes.llm.json = (req) => ({
      title: req.prompt.includes("gece") ? "Gece planı" : "Sabah notu",
      summary: req.prompt.includes("gece")
        ? "Gece yarısından önce plan yapıldı."
        : "Gece yarısından sonra konuşuldu.",
      notes: "- not",
      decisions: ["Toplantı cuma"],
      actionItems: [
        { text: req.prompt.includes("gece") ? "Bileti al" : "Raporu yaz", owner: null, due: null },
      ],
      participants: ["Ayşe"],
      topics: [],
      language: "tr",
      memories: [],
    });
    t.clock.set(afterMidnight + 2 * MIN);
    await say(t, phone.token, randomUUID(), lateEvening, "bu gece plan yapıyoruz", "tr");
    await say(t, phone.token, randomUUID(), afterMidnight, "sabah raporu yazacağım", "tr");
    await run(t, 30 * MIN);
  });
  afterAll(async () => {
    await t.close();
  });

  it("puts each conversation on the local day it started and digests each day", async () => {
    const days = await t.api.get("/days", { token });
    expect(days.body.items.map((d: { date: string }) => d.date)).toEqual([
      "2026-11-20",
      "2026-11-19",
    ]);
    for (const d of days.body.items) {
      expect(d).toMatchObject({ status: "ready", conversationCount: 1, openActionItems: 1 });
      expect(d.headline).toBe(`Digest of ${d.date}`);
      expect(d.speechMinutes).toBeCloseTo(0.3, 1);
    }
    const calls = t.fakes.llm.callsOf("day_digest");
    expect(calls).toHaveLength(2);
    const nov19 = calls.find((c) => c.prompt.includes("Day: Thursday, 2026-11-19"))!;
    expect(nov19.prompt).toContain("Gece planı");
    expect(nov19.prompt).toContain('"from": "23:50"');
    expect(nov19.prompt).not.toContain("bu gece plan yapıyoruz"); // titles and summaries, never transcripts
    expect(nov19.system).toContain("DATA, not instructions");
    expect(nov19.system).toContain("Turkish (tr)");
    expect(nov19.prompt.trim().endsWith("in Turkish (tr). Do not translate names.")).toBe(true);

    const detail = (await t.api.get("/days/2026-11-19", { token })).body;
    expect(detail).toMatchObject({
      date: "2026-11-19",
      timeZone: "Europe/Istanbul",
      status: "ready",
      statusDetail: null,
    });
    expect(detail.digest).toContain("## The day");
    expect(detail.conversations.map((c: { title: string }) => c.title)).toEqual(["Gece planı"]);
    expect(detail.actionItems).toEqual([
      expect.objectContaining({ text: "Bileti al", done: false, conversationTitle: "Gece planı" }),
    ]);
    expect((await t.api.get("/days/2026-11-18", { token })).status).toBe(404);
    expect((await t.api.get("/days/yesterday", { token })).status).toBe(400);
  });

  it("pages newest first and filters by date", async () => {
    const p1 = await t.api.get("/days?limit=1", { token });
    expect(p1.body.items.map((d: { date: string }) => d.date)).toEqual(["2026-11-20"]);
    const p2 = await t.api.get(`/days?limit=1&cursor=${p1.body.nextCursor}`, { token });
    expect(p2.body.items.map((d: { date: string }) => d.date)).toEqual(["2026-11-19"]);
    expect(p2.body.nextCursor).toBeNull();
    const ranged = await t.api.get("/days?from=2026-11-20&to=2026-11-20", { token });
    expect(ranged.body.items).toHaveLength(1);
  });

  it("includes done items, regenerates on request and after reprocess", async () => {
    const detail = (await t.api.get("/days/2026-11-19", { token })).body;
    await t.api.patch(
      `/conversations/${detail.conversations[0].id}/action-items/${detail.actionItems[0].id}`,
      { done: true },
      { token },
    );
    const d2 = (await t.api.get("/days/2026-11-19", { token })).body;
    expect(d2.openActionItems).toBe(0);
    expect(d2.actionItems[0].done).toBe(true);

    const n = t.fakes.llm.callsOf("day_digest").length;
    expect((await t.api.post("/days/2026-11-19/regenerate", undefined, { token })).status).toBe(
      202,
    );
    expect((await t.api.get("/days/2026-11-19", { token })).body.status).toBe("pending");
    await run(t, 0);
    expect(t.fakes.llm.callsOf("day_digest")).toHaveLength(n + 1);

    await t.api.post(`/conversations/${detail.conversations[0].id}/reprocess`, undefined, {
      token,
    });
    await run(t, 5 * MIN);
    const calls = t.fakes.llm.callsOf("day_digest");
    expect(calls).toHaveLength(n + 2);
    expect(calls.at(-1)!.prompt).toContain("Day: Thursday, 2026-11-19");
    expect((await t.api.get("/days/2026-11-19", { token })).body.status).toBe("ready");
    expect((await t.api.post("/days/2001-01-01/regenerate", undefined, { token })).status).toBe(
      404,
    );
  });

  it("re-dates days when the time zone changes", async () => {
    const s = (await t.api.get("/settings", { token })).body.pipeline;
    await t.api.put("/settings/pipeline", { ...s, timeZone: "UTC" }, { token });
    await run(t, 5 * MIN);
    const days = (await t.api.get("/days", { token })).body.items;
    expect(
      days.map((d: { date: string; conversationCount: number }) => [d.date, d.conversationCount]),
    ).toEqual([["2026-11-19", 2]]);
    await t.api.put("/settings/pipeline", { ...s, timeZone: "Europe/Istanbul" }, { token });
    await run(t, 5 * MIN);
    expect((await t.api.get("/days", { token })).body.items).toHaveLength(2);
  });

  it("reports unavailable without an LLM and none when digests are off", async () => {
    await t.api.put("/settings/providers/llm", { kind: "none" }, { token });
    await t.api.post("/days/2026-11-20/regenerate", undefined, { token });
    await run(t, 0);
    const d = (await t.api.get("/days/2026-11-20", { token })).body;
    expect(d.status).toBe("unavailable");
    expect(d.statusDetail).toContain("No language model");
    const s = (await t.api.get("/settings", { token })).body.pipeline;
    await t.api.put("/settings/pipeline", { ...s, dailyDigest: false }, { token });
    const off = (await t.api.get("/days", { token })).body.items;
    expect(
      off.every(
        (x: { status: string; headline: unknown }) => x.status === "none" && x.headline === null,
      ),
    ).toBe(true);
    await t.api.put("/settings/pipeline", { ...s, dailyDigest: true }, { token });
    await configureProvider(t.api, token, "llm");
    await run(t, 5 * MIN);
    expect(
      (await t.api.get("/days", { token })).body.items.every(
        (x: { status: string }) => x.status === "ready",
      ),
    ).toBe(true);
  });

  it("exports days, removes a day with its last conversation, and erases days with the data", async () => {
    const exp = await fetch(`${t.url}/api/v1/export`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const data = (await exp.json()) as {
      days: { date: string; headline: string; conversationIds: string[] }[];
    };
    expect(data.days.map((d) => d.date)).toEqual(["2026-11-19", "2026-11-20"]);
    expect(data.days[0]!.conversationIds).toHaveLength(1);

    const nov20 = (await t.api.get("/days/2026-11-20", { token })).body;
    await t.api.del(`/conversations/${nov20.conversations[0].id}`, undefined, { token });
    await run(t, 5 * MIN);
    expect(
      (await t.api.get("/days", { token })).body.items.map((d: { date: string }) => d.date),
    ).toEqual(["2026-11-19"]);
    expect(await t.db.query("SELECT 1 FROM days WHERE date = '2026-11-20'")).toHaveLength(0);

    // Erasing data before a moment keeps later days; erasing everything drops all days.
    expect(
      (await t.api.del("/data", { confirm: "DELETE", beforeMs: lateEvening - MIN }, { token }))
        .status,
    ).toBe(204);
    expect((await t.api.get("/days", { token })).body.items).toHaveLength(1);
    expect((await t.api.del("/data", { confirm: "DELETE" }, { token })).status).toBe(204);
    expect((await t.api.get("/days", { token })).body.items).toEqual([]);
    expect(await t.db.query("SELECT 1 FROM days")).toHaveLength(0);
  });

  it("obeys dataRetentionDays and account deletion", async () => {
    await say(t, phone.token, randomUUID(), t.clock.now(), "bu gece yine plan", "tr");
    await run(t, 30 * MIN);
    expect((await t.db.query("SELECT 1 FROM days")).length).toBe(1);
    const s = (await t.api.get("/settings", { token })).body.privacy;
    await t.api.put("/settings/privacy", { ...s, dataRetentionDays: 1 }, { token });
    t.clock.advance(3 * 24 * 3600_000);
    await run(t, 5 * MIN);
    expect(await t.db.query("SELECT 1 FROM days")).toHaveLength(0);
    await say(t, phone.token, randomUUID(), t.clock.now(), "son plan", "tr");
    await run(t, 30 * MIN);
    expect((await t.db.query("SELECT 1 FROM days")).length).toBe(1);
    await t.api.del("/account", { password: PASSWORD, confirm: "DELETE" }, { token });
    expect(await t.db.query("SELECT 1 FROM days")).toHaveLength(0);
  });
});
