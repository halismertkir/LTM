import { randomUUID } from "node:crypto";
import type { LlmJsonRequest } from "@ltm/providers";
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
  type TestServer,
  WsClient,
} from "./helpers.js";

const S = 1000;
const MIN = 60_000;

function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const TAB_LINES = [
  "hello everyone thanks for joining the budget review",
  "we agreed the q3 budget is 120 thousand euros",
  "ayse will send the report by friday",
];

const MEMORIES = [
  {
    kind: "decision",
    content: "The Q3 budget was set at 120 thousand euros.",
    importance: 4,
    subjects: ["Q3 budget"],
    occurredAt: null,
  },
  {
    kind: "commitment",
    content: "Ayşe will send the budget report by Friday.",
    importance: 3,
    subjects: ["Ayşe"],
    occurredAt: "2026-11-20",
  },
];

function notesFor(req: LlmJsonRequest<unknown>) {
  return {
    title: "Q3 budget review",
    summary: "The team reviewed the Q3 budget and agreed on 120 thousand euros.",
    notes: "## Key points\n- Q3 budget: 120 thousand euros\n- Ayşe sends the report by Friday",
    decisions: ["The Q3 budget is 120 thousand euros."],
    actionItems: [{ text: "Send the budget report", owner: "Ayşe", due: "2026-11-20" }],
    participants: ["Ayşe"],
    topics: ["budget", "Q3"],
    language: "en",
    memories: req.prompt.includes("offsite")
      ? [...MEMORIES, { ...MEMORIES[0]!, content: "the q3 budget was set at 120 thousand euros" }]
      : MEMORIES,
  };
}

interface Utt {
  id: string;
  text: string;
  deviceIds: string[];
  sources: string[];
  startMs: number;
}

describe("multi-device pipeline end to end", () => {
  let t: TestServer;
  let owner: { token: string; userId: string };
  let chrome: { token: string; deviceId: string };
  let watch: { token: string; deviceId: string };
  let phone: { token: string; deviceId: string };
  let conversationId: string;
  let t0: number;
  const events: any[] = [];
  let sse: AbortController;

  beforeAll(async () => {
    t = await startTestServer();
    owner = await setupOwner(t.api);
    await acceptAllConsents(t.api, owner.token);
    chrome = await pairDevice(t.api, owner.token, "Chrome", "browser_extension");
    watch = await pairDevice(t.api, owner.token, "Watch", "apple_watch");
    phone = await pairDevice(t.api, owner.token, "iPhone", "iphone");
    for (const role of ["stt", "llm", "embedding"] as const)
      await configureProvider(t.api, owner.token, role);
    t.fakes.llm.json = notesFor;

    sse = new AbortController();
    const res = await fetch(`${t.url}/api/v1/events`, {
      headers: { authorization: `Bearer ${owner.token}` },
      signal: sse.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
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
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split("\n").find((l) => l.startsWith("data: "));
            if (data) events.push(JSON.parse(data.slice(6)));
            i = buf.indexOf("\n\n");
          }
        }
      } catch {
        // aborted
      }
    })();
  });
  afterAll(async () => {
    sse.abort();
    await t.close();
  });

  it("merges a tab stream and a skewed ambient stream into one de-duplicated transcript", async () => {
    t0 = t.clock.now();
    // ---- tab: live audio over the WebSocket, three bursts of "speech", transcribed by the fake STT.
    t.fakes.stt.script = (_req, call) => {
      const text = TAB_LINES[call] ?? `extra ${call}`;
      return { text, segments: [{ startSec: 0.25, endSec: 3.25, text, confidence: 0.95 }] };
    };
    const ws = new WsClient(t.url);
    await ws.opened;
    ws.send(
      hello(chrome.token, randomUUID(), {
        source: "tab",
        context: { title: "Budget review", app: "meet.google.com" },
      }),
    );
    await ws.waitFor((m) => m.type === "ready");
    const audio = concat([
      pcm(1000, false),
      pcm(3000, true, 1),
      pcm(2500, false),
      pcm(3000, true, 2),
      pcm(2500, false),
      pcm(3000, true, 3),
      pcm(1500, false),
    ]);
    for (const f of frameList(audio, t0)) ws.sendBinary(f);
    ws.send({ type: "end" });
    await ws.waitFor((m) => m.type === "closed");

    // ---- ambient: the watch transcribed on-device; its clock runs 1.5 s ahead (below the offset threshold).
    const skew = 1.5 * S;
    const amb = await t.api.post(
      "/ingest/transcripts",
      {
        streamId: randomUUID(),
        source: "ambient",
        clientTimeMs: t.clock.now() + skew,
        segments: [
          // Cut differently: one long segment where the tab produced two.
          {
            id: "a1",
            startMs: t0 + 1.3 * S + skew,
            endMs: t0 + 9.6 * S + skew,
            text: "hello everyone thanks for joining the budget review we agreed the q3 budget is 120 thousand euros",
          },
          {
            id: "a3",
            startMs: t0 + 12.3 * S + skew,
            endMs: t0 + 15.2 * S + skew,
            text: "ayşe will send report by friday",
          },
          // Only the watch heard this (the user talking in the room after the call).
          {
            id: "a4",
            startMs: t0 + 40 * S + skew,
            endMs: t0 + 42 * S + skew,
            text: "i will book the meeting room for march",
          },
        ],
        final: true,
      },
      { token: watch.token },
    );
    expect(amb.body).toMatchObject({ accepted: 3, duplicates: 0 });

    // Transcribe + debounced merge (manual clock moves to the merge job).
    await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 10 * S });
    const list = await t.api.get("/conversations", { token: owner.token });
    expect(list.body.items).toHaveLength(1);
    const summary = list.body.items[0];
    expect(summary.status).toBe("open");
    conversationId = summary.id;
    expect(summary.deviceIds.sort()).toEqual([chrome.deviceId, watch.deviceId].sort());

    const detail = await t.api.get(`/conversations/${conversationId}`, { token: owner.token });
    const utts: Utt[] = detail.body.utterances;
    const all = utts.map((u) => u.text).join(" | ");
    // Every phrase exactly once; the tab (higher priority) supplied the text of shared speech.
    expect(all.match(/hello everyone/g)).toHaveLength(1);
    expect(all.match(/120 thousand euros/g)).toHaveLength(1);
    expect(all.match(/the budget review/g)).toHaveLength(1);
    expect(all.match(/report by friday/g)).toHaveLength(1);
    expect(all).toContain("ayse will send the report by friday");
    expect(all).toContain("i will book the meeting room for march");
    for (const line of TAB_LINES) {
      const u = utts.find((x) => x.text.includes(line))!;
      expect(u, line).toBeTruthy();
      expect(u.deviceIds[0]).toBe(chrome.deviceId);
      expect(u.deviceIds).toContain(watch.deviceId);
      // sources[i] belongs to deviceIds[i], winner first.
      expect(u.sources).toEqual(["tab", "ambient"]);
      expect(u.deviceIds).toEqual([chrome.deviceId, watch.deviceId]);
    }
    for (const u of utts) expect(u.sources.length).toBe(u.deviceIds.length);
    const only = utts.find((x) => x.text.includes("meeting room"))!;
    expect(only.deviceIds).toEqual([watch.deviceId]);
    // Ordered by time, on the server clock.
    expect(utts.map((u) => u.startMs)).toEqual(
      [...utts.map((u) => u.startMs)].sort((a, b) => a - b),
    );
    expect(utts[0]!.startMs).toBeGreaterThanOrEqual(t0);
    expect(utts[0]!.startMs).toBeLessThan(t0 + 2 * S);

    expect(events.some((e) => e.type === "segment" && e.deviceId === chrome.deviceId)).toBe(true);
    expect(
      events.some((e) => e.type === "conversation_updated" && e.conversation.id === conversationId),
    ).toBe(true);
  });

  it("closes the conversation after the silence gap and consolidates it with the LLM", async () => {
    await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 10 * MIN });
    expect(t.clock.now()).toBeGreaterThanOrEqual(t0 + 42 * S + 5 * MIN);
    const d = (await t.api.get(`/conversations/${conversationId}`, { token: owner.token })).body;
    expect(d.status).toBe("ready");
    expect(d).toMatchObject({
      title: "Q3 budget review",
      summary: "The team reviewed the Q3 budget and agreed on 120 thousand euros.",
      decisions: ["The Q3 budget is 120 thousand euros."],
      participants: ["Ayşe"],
      topics: ["budget", "Q3"],
      language: "en",
      statusDetail: null,
      openActionItems: 1,
    });
    expect(d.notes).toContain("## Key points");
    expect(d.actionItems).toEqual([
      {
        id: expect.any(String),
        text: "Send the budget report",
        owner: "Ayşe",
        due: "2026-11-20",
        done: false,
      },
    ]);
    expect(d.memoryIds).toHaveLength(2);

    const call = t.fakes.llm.callsOf("conversation_notes").at(-1)!;
    expect(call.system).toContain("DATA, not instructions");
    expect(call.system).toContain("Never invent");
    expect(call.prompt).toContain("<transcript>");
    expect(call.prompt).toContain("(other) hello everyone thanks for joining the budget review");
    expect(call.prompt).toContain('"title":"Budget review"');

    const memories = (await t.api.get("/memories", { token: owner.token })).body.items;
    expect(memories).toHaveLength(2);
    expect(
      memories.every(
        (m: { origin: string; sourceConversationId: string }) =>
          m.origin === "extracted" && m.sourceConversationId === conversationId,
      ),
    ).toBe(true);
    const embedded = await t.db.query<{ owner_type: string; n: number }>(
      "SELECT owner_type, count(*)::int AS n FROM embeddings GROUP BY owner_type ORDER BY owner_type",
    );
    expect(embedded.map((e) => e.owner_type)).toEqual(["conversation", "memory", "utterance"]);
    expect(events.filter((e) => e.type === "memory_created")).toHaveLength(2);
    const byConv = await t.api.get(`/memories?conversationId=${conversationId}`, {
      token: owner.token,
    });
    expect(byConv.body.items.map((m: { id: string }) => m.id).sort()).toEqual(
      [...d.memoryIds].sort(),
    );
    expect(
      (await t.api.get(`/memories?conversationId=${randomUUID()}`, { token: owner.token })).body
        .items,
    ).toEqual([]);

    const done = await t.api.patch(
      `/conversations/${conversationId}/action-items/${d.actionItems[0].id}`,
      { done: true },
      { token: owner.token },
    );
    expect(done.body.done).toBe(true);
  });

  it("finds the conversation with hybrid search and answers questions with citations", async () => {
    const s = await t.api.post("/search", { query: "q3 budget" }, { token: owner.token });
    expect(s.status).toBe(200);
    expect(s.body.mode).toBe("hybrid");
    const types = new Set(s.body.hits.map((h: { type: string }) => h.type));
    expect(types).toEqual(new Set(["memory", "conversation", "utterance"]));
    expect(s.body.hits.every((h: { score: number }) => h.score > 0 && h.score <= 1)).toBe(true);
    expect(
      s.body.hits.some((h: { conversationId: string }) => h.conversationId === conversationId),
    ).toBe(true);

    const onlyMem = await t.api.post(
      "/search",
      { query: "budget", types: ["memory"] },
      { token: owner.token },
    );
    expect(onlyMem.body.hits.every((h: { type: string }) => h.type === "memory")).toBe(true);

    const filtered = await t.api.get(`/conversations?q=${encodeURIComponent("Thousand EUROS")}`, {
      token: owner.token,
    });
    expect(filtered.body.items.map((c: { id: string }) => c.id)).toEqual([conversationId]);
    const none = await t.api.get(`/conversations?q=zebra`, { token: owner.token });
    expect(none.body.items).toHaveLength(0);

    t.fakes.llm.text = (req) =>
      req.prompt.includes("120 thousand euros")
        ? "The Q3 budget is 120 thousand euros [1]."
        : "Not found.";
    const a = await t.api.post(
      "/ask",
      { question: "What is the Q3 budget?" },
      { token: owner.token },
    );
    expect(a.status).toBe(200);
    expect(a.body.answer).toBe("The Q3 budget is 120 thousand euros [1].");
    expect(a.body.citations.length).toBeGreaterThan(0);
    expect(a.body.citations[0]).toMatchObject({ type: expect.any(String), id: expect.any(String) });
    const prompt = t.fakes.llm.textCalls.at(-1)!;
    expect(prompt.prompt).toContain("[1]");
    expect(prompt.system).toContain("Cite");
  });

  it("re-opens and re-merges on late data from a third device without duplicating memories", async () => {
    const memoriesBefore = (await t.api.get("/memories", { token: owner.token })).body.items.length;
    const late = await t.api.post(
      "/ingest/transcripts",
      {
        streamId: randomUUID(),
        source: "mic",
        clientTimeMs: t.clock.now(),
        segments: [
          {
            id: "p1",
            startMs: t0 + 6.9 * S,
            endMs: t0 + 9.6 * S,
            text: "we agreed the q3 budget is 120 thousand",
          },
          {
            id: "p2",
            startMs: t0 + 70 * S,
            endMs: t0 + 72 * S,
            text: "and the offsite is in march",
          },
        ],
      },
      { token: phone.token },
    );
    expect(late.body.accepted).toBe(2);
    await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 10 * MIN });

    const list = (await t.api.get("/conversations", { token: owner.token })).body.items;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(conversationId);
    const d = (await t.api.get(`/conversations/${conversationId}`, { token: owner.token })).body;
    expect(d.status).toBe("ready");
    const utts: Utt[] = d.utterances;
    const all = utts.map((u) => u.text).join(" | ");
    expect(all.match(/120 thousand/g)).toHaveLength(1);
    expect(all).toContain("and the offsite is in march");
    const shared = utts.find((u) => u.text.includes("120 thousand euros"))!;
    expect(shared.deviceIds).toEqual(
      expect.arrayContaining([chrome.deviceId, watch.deviceId, phone.deviceId]),
    );
    expect(d.deviceIds).toHaveLength(3);
    // The completed action item survived reconsolidation.
    expect(d.actionItems).toHaveLength(1);
    expect(d.actionItems[0].done).toBe(true);
    // The LLM re-reported both memories (one re-worded only in case/punctuation): no duplicates.
    const memories = (await t.api.get("/memories", { token: owner.token })).body.items;
    expect(memories).toHaveLength(memoriesBefore);
    const lastPrompt = t.fakes.llm.callsOf("conversation_notes").at(-1)!.prompt;
    expect(lastPrompt).toContain("Memories already stored from this conversation");
  });

  it("joins two conversations that late data bridges", async () => {
    const base = t.clock.now() + 30 * MIN;
    const send = (
      token: string,
      segments: { id: string; at: number; text: string }[],
      source = "mic",
    ) =>
      t.api.post(
        "/ingest/transcripts",
        {
          streamId: randomUUID(),
          source,
          clientTimeMs: t.clock.now(),
          segments: segments.map((s) => ({
            id: s.id,
            startMs: s.at,
            endMs: s.at + 2 * S,
            text: s.text,
          })),
        },
        { token },
      );
    t.clock.set(base + 20 * MIN);
    await send(phone.token, [{ id: "b1", at: base, text: "morning standup starts now" }]);
    await send(phone.token, [
      { id: "b2", at: base + 12 * MIN, text: "afternoon planning starts now" },
    ]);
    await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 10 * MIN });
    const before = (await t.api.get(`/conversations?from=${base - S}`, { token: owner.token })).body
      .items;
    expect(before).toHaveLength(2);

    await send(
      watch.token,
      [
        { id: "w1", at: base + 4 * MIN, text: "we keep talking in the hallway" },
        { id: "w2", at: base + 8 * MIN, text: "still talking about the plan" },
      ],
      "ambient",
    );
    await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 10 * MIN });
    const after = (await t.api.get(`/conversations?from=${base - S}`, { token: owner.token })).body
      .items;
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[1].id); // the earlier conversation is kept
    expect(after[0].utteranceCount).toBe(4);
    expect(
      events.some((e) => e.type === "conversation_deleted" && e.conversationId === before[0].id),
    ).toBe(true);
  });

  it("paginates conversations newest first", async () => {
    const page1 = await t.api.get("/conversations?limit=1", { token: owner.token });
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await t.api.get(`/conversations?limit=1&cursor=${page1.body.nextCursor}`, {
      token: owner.token,
    });
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].startMs).toBeLessThan(page1.body.items[0].startMs);
    expect(page2.body.nextCursor).toBeNull();
    expect((await t.api.get("/conversations?cursor=garbage", { token: owner.token })).status).toBe(
      400,
    );
  });
});

describe("without a language model", () => {
  let t: TestServer;
  let owner: { token: string; userId: string };
  let phone: { token: string; deviceId: string };

  beforeAll(async () => {
    t = await startTestServer();
    owner = await setupOwner(t.api);
    await acceptAllConsents(t.api, owner.token);
    phone = await pairDevice(t.api, owner.token, "iPhone", "iphone");
  });
  afterAll(async () => {
    await t.close();
  });

  it("keeps a transcript_only conversation, then reprocessing keeps user edits", async () => {
    const now = t.clock.now();
    await t.api.post(
      "/ingest/transcripts",
      {
        streamId: randomUUID(),
        source: "mic",
        clientTimeMs: now,
        segments: [
          { id: "1", startMs: now, endMs: now + 2000, text: "let us plan the garden" },
          {
            id: "2",
            startMs: now + 3000,
            endMs: now + 5000,
            text: "tomatoes go in the sunny corner",
          },
        ],
      },
      { token: phone.token },
    );
    await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 10 * MIN });
    const [c] = (await t.api.get("/conversations", { token: owner.token })).body.items;
    const d = (await t.api.get(`/conversations/${c.id}`, { token: owner.token })).body;
    expect(d.status).toBe("transcript_only");
    expect(d.statusDetail).toContain("No language model is configured");
    expect(d.utterances.length).toBeGreaterThan(0);
    expect(d.title).toBeNull();

    const ask = await t.api.post(
      "/ask",
      { question: "where do tomatoes go?" },
      { token: owner.token },
    );
    expect(ask.status).toBe(409);
    expect(ask.body.error.code).toBe("provider_not_configured");
    const s = await t.api.post("/search", { query: "tomatoes" }, { token: owner.token });
    expect(s.body.mode).toBe("keyword");
    expect(s.body.hits[0]).toMatchObject({ type: "utterance", conversationId: c.id });

    // The user names the conversation and writes notes, then configures an LLM and reprocesses.
    const edited = await t.api.patch(
      `/conversations/${c.id}`,
      { title: "Garden plan", notes: "My own notes" },
      { token: owner.token },
    );
    // PATCH returns the full ConversationDetail.
    expect(edited.body).toMatchObject({
      id: c.id,
      title: "Garden plan",
      notes: "My own notes",
      status: "transcript_only",
    });
    expect(edited.body.utterances.length).toBeGreaterThan(0);
    expect(edited.body.actionItems).toEqual([]);
    await configureProvider(t.api, owner.token, "llm");
    await t.api.put(
      "/settings/pipeline",
      {
        language: "tr",
        conversationGapMinutes: 5,
        extractMemories: false,
        liveNotesMinutes: 15,
        dailyDigest: true,
        timeZone: "UTC",
      },
      { token: owner.token },
    );
    t.fakes.llm.json = () => ({
      title: "Bahçe planı",
      summary: "Bahçe planlandı.",
      notes: "## Notlar\n- Domatesler güneşli köşeye",
      decisions: [],
      actionItems: [],
      participants: [],
      topics: ["bahçe"],
      language: "tr",
      memories: [
        {
          kind: "fact",
          content: "Tomatoes go in the sunny corner.",
          importance: 2,
          subjects: [],
          occurredAt: null,
        },
      ],
    });
    const re = await t.api.post(`/conversations/${c.id}/reprocess`, undefined, {
      token: owner.token,
    });
    expect(re.status).toBe(202);
    await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: MIN });
    const after = (await t.api.get(`/conversations/${c.id}`, { token: owner.token })).body;
    expect(after.status).toBe("ready");
    expect(after.title).toBe("Garden plan");
    expect(after.notes).toBe("My own notes");
    expect(after.summary).toBe("Bahçe planlandı.");
    expect(after.language).toBe("tr");
    // Memory extraction was switched off.
    expect(after.memoryIds).toEqual([]);
    const last = t.fakes.llm.callsOf("conversation_notes").at(-1)!;
    // The output language is decided in code and stated in the system prompt and at the very end.
    expect(last.system).toContain("in Turkish (tr)");
    expect(last.prompt.trim().endsWith("in Turkish (tr). Do not translate names.")).toBe(true);
    expect(last.system).toContain("Memory extraction is disabled");
  });

  it("marks the conversation transcript_only when the LLM fails permanently", async () => {
    t.fakes.llm.json = () => {
      throw Object.assign(new Error("bad key"), {
        name: "ProviderError",
        code: "auth",
        retryable: false,
        provider: "openai_compatible",
      });
    };
    const [c] = (await t.api.get("/conversations", { token: owner.token })).body.items;
    await t.api.post(`/conversations/${c.id}/reprocess`, undefined, { token: owner.token });
    await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: MIN });
    const d = (await t.api.get(`/conversations/${c.id}`, { token: owner.token })).body;
    expect(d.status).toBe("transcript_only");
    expect(d.statusDetail).toContain("auth");
    const failed = await t.db.query<{ status: string }>(
      "SELECT status FROM jobs WHERE kind = 'consolidate'",
    );
    expect(failed.map((f) => f.status)).toEqual(["failed"]);
  });

  it("retries retryable provider errors with back-off", async () => {
    let calls = 0;
    t.fakes.llm.json = (req) => {
      calls++;
      if (calls === 1)
        throw Object.assign(new Error("busy"), {
          name: "ProviderError",
          code: "rate_limited",
          retryable: true,
          provider: "openai_compatible",
        });
      return notesFor(req);
    };
    const [c] = (await t.api.get("/conversations", { token: owner.token })).body.items;
    await t.api.post(`/conversations/${c.id}/reprocess`, undefined, { token: owner.token });
    await t.server.worker.drain();
    expect(calls).toBe(1);
    const pending = await t.db.query<{ status: string; attempts: number; run_at: number }>(
      "SELECT status, attempts, run_at FROM jobs WHERE kind = 'consolidate' AND status = 'pending'",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]!.run_at).toBeGreaterThan(t.clock.now());
    await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: MIN });
    expect(calls).toBe(2);
    await eventually(
      async () =>
        (await t.api.get(`/conversations/${c.id}`, { token: owner.token })).body.status === "ready",
    );
  });
});
