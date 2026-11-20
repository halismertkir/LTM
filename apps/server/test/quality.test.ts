import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeOwner } from "../src/pipeline/consolidate.js";
import {
  decideLanguage,
  dominantLanguage,
  languageDirective,
  languageLabel,
} from "../src/pipeline/language.js";
import { cleanCitations } from "../src/services/ask.js";
import {
  acceptAllConsents,
  configureProvider,
  PASSWORD,
  pairDevice,
  startTestServer,
  type TestServer,
} from "./helpers.js";

const MIN = 60_000;

function notes() {
  return {
    title: "Başlık",
    summary: "Özet.",
    notes: "- not",
    decisions: [],
    actionItems: [{ text: "Dişçiyi ara", owner: "ben", due: null }],
    participants: [],
    topics: [],
    language: "en",
    memories: [],
  };
}

async function owner(t: TestServer, locale: "en" | "tr") {
  const r = await t.api.post("/auth/setup", {
    email: "o@example.org",
    password: PASSWORD,
    displayName: "Deniz",
    locale,
  });
  await acceptAllConsents(t.api, r.body.token);
  return r.body.token as string;
}

describe("output language is decided in code", () => {
  it("helpers", () => {
    expect(languageLabel("tr")).toBe("Turkish (tr)");
    expect(languageLabel("xx")).toBe('the language with code "xx"');
    expect(
      dominantLanguage([
        { language: "tr", weight: 10 },
        { language: "en", weight: 3 },
        { language: "turkish", weight: 1 },
      ]),
    ).toBe("tr");
    expect(decideLanguage({ fixed: null, spoken: null, locale: "tr" })).toBe("tr");
    expect(decideLanguage({ fixed: "de", spoken: "tr", locale: "en" })).toBe("de");
    expect(languageDirective("tr")).toBe(
      "Write every field (title, summary, notes, decisions, action items, memories) in Turkish (tr). Do not translate names.",
    );
    expect(normalizeOwner("Self", "Deniz")).toBe("Deniz");
    expect(normalizeOwner("ben", "Deniz")).toBe("Deniz");
    expect(normalizeOwner("Ayşe", "Deniz")).toBe("Ayşe");
    expect(normalizeOwner("unknown", "Deniz")).toBeNull();
    expect(normalizeOwner("Bilinmiyor", "Deniz")).toBeNull();
    expect(normalizeOwner("  ", "Deniz")).toBeNull();
  });

  it("uses the spoken language over the model's habit and the account locale", async () => {
    const t = await startTestServer();
    try {
      const token = await owner(t, "en");
      await configureProvider(t.api, token, "llm");
      t.fakes.llm.json = notes;
      const phone = await pairDevice(t.api, token, "Phone", "iphone");
      const now = t.clock.now();
      await t.api.post(
        "/ingest/transcripts",
        {
          streamId: randomUUID(),
          source: "mic",
          clientTimeMs: now,
          segments: [
            {
              id: "1",
              startMs: now,
              endMs: now + 3000,
              text: "yarın dişçiye gitmem lazım",
              language: "tr",
            },
            { id: "2", startMs: now + 4000, endMs: now + 5000, text: "ok", language: "en" },
          ],
        },
        { token: phone.token },
      );
      await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 10 * MIN });
      const call = t.fakes.llm.callsOf("conversation_notes").at(-1)!;
      expect(call.system).toContain("in Turkish (tr), whatever language the input is in");
      expect(call.prompt.trim().split("\n").at(-1)).toBe(languageDirective("tr"));
      const [c] = (await t.api.get("/conversations", { token })).body.items;
      expect(c.language).toBe("tr");
      const d = (await t.api.get(`/conversations/${c.id}`, { token })).body;
      expect(d.actionItems[0].owner).toBe("Deniz");
    } finally {
      await t.close();
    }
  });

  it("falls back to the account locale when nothing says what was spoken", async () => {
    const t = await startTestServer();
    try {
      const token = await owner(t, "tr");
      await configureProvider(t.api, token, "llm");
      t.fakes.llm.json = notes;
      const phone = await pairDevice(t.api, token, "Phone", "iphone");
      const now = t.clock.now();
      await t.api.post(
        "/ingest/transcripts",
        {
          streamId: randomUUID(),
          source: "mic",
          clientTimeMs: now,
          segments: [{ id: "1", startMs: now, endMs: now + 3000, text: "toplantı yarın" }],
        },
        { token: phone.token },
      );
      await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 10 * MIN });
      expect(
        t.fakes.llm
          .callsOf("conversation_notes")
          .at(-1)!
          .prompt.trim()
          .endsWith(languageDirective("tr")),
      ).toBe(true);

      // /ask: the locale is offered as a hint in the final line, and citations are tidied.
      t.fakes.llm.text = () => "Toplantı yarın [1]. [1] Ayrıca [7] ve [1][1].";
      const a = await t.api.post("/ask", { question: "toplantı ne zaman?" }, { token });
      expect(a.status).toBe(200);
      expect(a.body.citations.length).toBeGreaterThan(0);
      expect(a.body.answer).toBe("Toplantı yarın [1]. Ayrıca ve [1].");
      const prompt = t.fakes.llm.textCalls.at(-1)!.prompt;
      expect(prompt.trim().split("\n").at(-1)).toBe(
        "The question is most likely in Turkish; answer in the language the question is written in.",
      );
    } finally {
      await t.close();
    }
  });

  it("cleanCitations", () => {
    expect(cleanCitations("It grew by 15% [3]. [3]", 3)).toBe("It grew by 15% [3].");
    expect(cleanCitations("A [1][1] B [2] [2] C [1, 9, 1]", 2)).toBe("A [1] B [2] C [1]");
    expect(cleanCitations("Two days [2, 3]. [3] And new terms.", 3)).toBe(
      "Two days [2][3]. And new terms.",
    );
    expect(cleanCitations("First [1]. Later, again [1].", 2)).toBe("First [1]. Later, again [1].");
    expect(cleanCitations("Nothing [4].", 3)).toBe("Nothing.");
  });
});

describe("search ranking", () => {
  it("ranks the semantically right memory first even with no shared words", async () => {
    const t = await startTestServer();
    try {
      const token = await owner(t, "tr");
      await configureProvider(t.api, token, "embedding");
      const e = t.fakes.embedding;
      e.model = "hand-3d";
      e.vectors = (text) => {
        if (text === "dişçi ne zaman") return [1, 0, 0];
        if (text.startsWith("A dentist appointment")) return [0.96, 0.04, 0];
        if (text.startsWith("The Q3 sales strategy")) return [0, 1, 0];
        return [0, 0, 1];
      };
      const dentist = await t.api.post(
        "/memories",
        { content: "A dentist appointment is scheduled at 19:00." },
        { token },
      );
      await t.api.post(
        "/memories",
        { content: "The Q3 sales strategy presentation includes plans for new pricing." },
        { token },
      );
      await t.api.post("/memories", { content: "Groceries: milk and bread." }, { token });
      await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: MIN });
      expect(await t.db.query("SELECT 1 FROM embeddings WHERE model = 'hand-3d'")).toHaveLength(3);

      const r = await t.api.post("/search", { query: "dişçi ne zaman" }, { token });
      expect(r.body.mode).toBe("hybrid");
      expect(r.body.hits[0].id).toBe(dentist.body.id);

      // The keyword side alone finds nothing here: "ne" is a short word and must not match "new".
      await t.api.put("/settings/providers/embedding", { kind: "none" }, { token });
      const kw = await t.api.post("/search", { query: "dişçi ne zaman" }, { token });
      expect(kw.body).toEqual({ mode: "keyword", hits: [] });
      // Word-prefix matching still finds inflected words.
      const pref = await t.api.post("/search", { query: "dentist" }, { token });
      expect(pref.body.hits.map((h: { id: string }) => h.id)).toEqual([dentist.body.id]);
    } finally {
      await t.close();
    }
  });
});
