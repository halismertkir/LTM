/**
 * Fixture data for tests and the Playwright smoke run. Every object is parsed with the
 * protocol's zod schema when this module loads, so a contract change that the fixtures no
 * longer satisfy fails loudly instead of silently testing the wrong shape.
 */
import {
  type AskResponse,
  type ConversationDetail,
  type DayDetail,
  type DayStatus,
  type Device,
  type Memory,
  type ProviderCatalog,
  type SearchResponse,
  type Settings,
  type StreamInfo,
  zAskResponse,
  zConversationDetail,
  zConversationSummary,
  zDayDetail,
  zDevice,
  zMemory,
  zProviderCatalog,
  zSearchResponse,
  zSettings,
  zStreamInfo,
} from "@ltm/protocol";
import { z } from "zod";
import { dayInZone, zonedTime } from "../src/lib/zone";

/**
 * The account's zone in every fixture. Deliberately not the browser's: the smoke run sets
 * the browser to another zone to prove days and times follow the account, not the device.
 */
export const FIXTURE_TZ = "Europe/Istanbul";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface FixtureSet {
  now: number;
  devices: Device[];
  streams: StreamInfo[];
  conversations: ConversationDetail[];
  memories: Memory[];
  settings: Settings;
  catalog: ProviderCatalog;
  search: SearchResponse;
  ask: AskResponse;
  /** Digest text per day; the rest of a DayDetail is derived from the conversations. */
  digests: Record<string, DayDigest>;
}

export interface DayDigest {
  status: DayStatus;
  headline: string | null;
  summary: string | null;
  digest: string | null;
  highlights: string[];
  decisions: string[];
  people: string[];
  statusDetail: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** `hh:mm` on the day `daysAgo` days back, in the account's zone. */
function at(now: number, daysAgo: number, hh: number, mm: number): number {
  return zonedTime(dayInZone(now - daysAgo * DAY, FIXTURE_TZ), FIXTURE_TZ, hh, mm);
}

function utterances(
  startMs: number,
  lines: [
    speaker: "self" | "other" | "unknown",
    text: string,
    devices: string[],
    sources: ("tab" | "mic" | "system" | "ambient")[],
    gapSec?: number,
  ][],
  prefix: string,
) {
  let t = startMs + 4000;
  return lines.map(([speaker, text, deviceIds, sources, gap = 9], i) => {
    const start = t;
    const end = start + Math.max(2500, text.length * 55);
    t = end + gap * 1000;
    return {
      id: `${prefix}-u${i + 1}`,
      startMs: start,
      endMs: end,
      text,
      speaker,
      language: "en",
      deviceIds,
      sources,
      origin:
        deviceIds[0] === "dev-iphone" && sources[0] === "ambient"
          ? ("edge_stt" as const)
          : ("server_stt" as const),
    };
  });
}

export function createFixtures(now = Date.now()): FixtureSet {
  // Keep "today" fixtures in the past even shortly after midnight.
  const todayMorning = Math.min(at(now, 0, 9, 30), now - 3 * HOUR);
  const devices = z.array(zDevice).parse([
    {
      id: "dev-laptop",
      name: "Work laptop · Chrome",
      kind: "browser_extension",
      access: "capture",
      platform: "Chrome 142 · macOS",
      appVersion: "0.1.0",
      priority: null,
      createdAt: iso(now - 40 * DAY),
      lastSeenAt: iso(now - 20_000),
      online: true,
    },
    {
      id: "dev-iphone",
      name: "iPhone",
      kind: "iphone",
      access: "memory",
      platform: "iOS 26.1",
      appVersion: "0.1.0 (12)",
      priority: null,
      createdAt: iso(now - 38 * DAY),
      lastSeenAt: iso(now - 30_000),
      online: true,
    },
    {
      id: "dev-watch",
      name: "Apple Watch",
      kind: "apple_watch",
      access: "capture",
      platform: "watchOS 26.1",
      appVersion: "0.1.0 (12)",
      priority: 15,
      createdAt: iso(now - 38 * DAY),
      lastSeenAt: iso(now - 2 * HOUR - 7 * MIN),
      online: false,
    },
  ]);

  const liveStart = now - 12 * MIN - 40_000;
  const streams = z.array(zStreamInfo).parse([
    {
      id: "8f8e2a4e-7f39-4c1b-9d55-3a9c4b1e0a11",
      deviceId: "dev-laptop",
      deviceName: "Work laptop · Chrome",
      source: "tab",
      mode: "audio",
      startedAt: iso(liveStart),
      endedAt: null,
      active: true,
      context: { title: "Weekly product sync", app: "meet.google.com" },
    },
    {
      id: "2b5f3c9d-1e4a-4f6b-8c7d-9e0f1a2b3c4d",
      deviceId: "dev-iphone",
      deviceName: "iPhone",
      source: "ambient",
      mode: "transcript",
      startedAt: iso(now - 4 * MIN - 5_000),
      endedAt: null,
      active: true,
      context: null,
    },
  ]);

  const c1Start = todayMorning;
  const c1 = {
    id: "conv-pricing",
    status: "ready",
    startMs: c1Start,
    endMs: c1Start + 47 * MIN,
    title: "Pricing review with the design team",
    summary:
      "We compared the two pricing page drafts and agreed to lead with the yearly plan. Mira will rework the comparison table; the launch stays on the 4th unless legal review slips.",
    topics: ["pricing", "launch", "design"],
    participants: ["You", "Mira", "Deniz"],
    language: "en",
    deviceIds: ["dev-laptop", "dev-iphone"],
    utteranceCount: 6,
    openActionItems: 2,
    interim: false,
    updatedAt: iso(c1Start + 52 * MIN),
    notes: [
      "## Context",
      "Second pass over the **pricing page** before the launch on the 4th.",
      "",
      "## Discussion",
      "- Draft B reads better on mobile; the comparison table is too dense.",
      "- Yearly plan first, monthly as the secondary option.",
      "- Legal still has to sign off on the refund wording.",
      "",
      "## Open questions",
      "1. Do we show prices with or without VAT for EU visitors?",
      "2. Who owns the FAQ copy?",
      "",
      "<script>alert('notes are sanitised')</script>",
    ].join("\n"),
    decisions: [
      "Lead with the yearly plan on the pricing page.",
      "Keep the launch date on the 4th.",
    ],
    actionItems: [
      {
        id: "ai-1",
        text: "Rework the comparison table for mobile",
        owner: "Mira",
        due: iso(now + 3 * DAY).slice(0, 10),
        done: false,
      },
      {
        id: "ai-2",
        text: "Ask legal about the refund wording",
        owner: "You",
        due: null,
        done: false,
      },
      { id: "ai-3", text: "Send draft B to the team", owner: "Deniz", due: null, done: true },
    ],
    utterances: utterances(
      c1Start,
      [
        [
          "other",
          "Okay, I've put both drafts side by side. Draft B is the one with the toggle at the top.",
          ["dev-laptop", "dev-iphone"],
          ["tab", "ambient"],
        ],
        [
          "self",
          "B reads much better on the phone. The table is the problem — it's too dense.",
          ["dev-laptop", "dev-iphone"],
          ["mic", "ambient"],
        ],
        [
          "other",
          "Agreed. I can split it into two columns and drop the footnotes.",
          ["dev-laptop"],
          ["tab"],
        ],
        [
          "self",
          "Let's lead with the yearly plan and keep monthly as the second option.",
          ["dev-iphone", "dev-laptop"],
          ["ambient", "mic"],
        ],
        [
          "other",
          "Fine by me. Are we still on track for the 4th?",
          ["dev-laptop", "dev-iphone"],
          ["tab", "ambient"],
        ],
        [
          "self",
          "Yes, unless legal needs more time on the refund wording. I'll ask them today.",
          ["dev-laptop"],
          ["mic"],
        ],
      ],
      "c1",
    ),
    memoryIds: ["mem-1", "mem-2"],
    statusDetail: null,
  };

  const c0 = {
    id: "conv-live",
    status: "open",
    startMs: liveStart,
    endMs: now - 15_000,
    title: "Weekly product sync: roadmap and hiring",
    summary:
      "So far: the onboarding checklist comes first on the roadmap, and the new flow could ship before the end of the month if design signs off.",
    topics: ["roadmap", "hiring"],
    participants: ["You", "Mira"],
    language: "en",
    deviceIds: ["dev-laptop", "dev-iphone"],
    utteranceCount: 41,
    openActionItems: 0,
    interim: true,
    updatedAt: iso(now - 15_000),
    notes:
      "## So far\n- Roadmap first, then the hiring update.\n- Onboarding checklist is the first roadmap item.\n- New flow could ship before month end — depends on design sign-off.",
    decisions: [],
    actionItems: [],
    utterances: utterances(
      liveStart,
      [
        ["other", "Let's start with the roadmap, then the hiring update.", ["dev-laptop"], ["tab"]],
        [
          "self",
          "Sounds good. I have two things on the roadmap.",
          ["dev-laptop", "dev-iphone"],
          ["mic", "ambient"],
        ],
      ],
      "c0",
    ),
    memoryIds: [],
    statusDetail: null,
  };

  const c2Start = Math.min(at(now, 0, 8, 10), todayMorning - 70 * MIN);
  const c2 = {
    id: "conv-standup",
    status: "processing",
    startMs: c2Start,
    endMs: c2Start + 14 * MIN,
    title: null,
    summary: null,
    topics: [],
    participants: [],
    language: "en",
    deviceIds: ["dev-watch"],
    utteranceCount: 18,
    openActionItems: 0,
    interim: false,
    updatedAt: iso(c2Start + 15 * MIN),
    notes: null,
    decisions: [],
    actionItems: [],
    utterances: utterances(
      c2Start,
      [["unknown", "Morning everyone, quick round please.", ["dev-watch"], ["ambient"]]],
      "c2",
    ),
    memoryIds: [],
    statusDetail: null,
  };

  const c3Start = at(now, 1, 16, 5);
  const c3 = {
    id: "conv-onboarding",
    status: "ready",
    startMs: c3Start,
    endMs: c3Start + 32 * MIN,
    title: "Onboarding plan for the new support hire",
    summary:
      "Outlined the first two weeks for the new support engineer: shadowing, a sandbox account, and a written runbook review. Deniz becomes the buddy.",
    topics: ["hiring", "support", "onboarding"],
    participants: ["You", "Deniz"],
    language: "en",
    deviceIds: ["dev-laptop"],
    utteranceCount: 64,
    openActionItems: 1,
    interim: false,
    updatedAt: iso(c3Start + 40 * MIN),
    notes:
      "## Week one\n- Shadow two senior engineers\n- Sandbox account with demo data\n\n## Week two\n- Own the low-priority queue\n- Review the runbooks and file gaps",
    decisions: ["Deniz is the onboarding buddy."],
    actionItems: [
      { id: "ai-4", text: "Create the sandbox account", owner: "Deniz", due: null, done: false },
    ],
    utterances: utterances(
      c3Start,
      [
        [
          "self",
          "Let's write the first two weeks down so nobody improvises.",
          ["dev-laptop"],
          ["mic"],
        ],
      ],
      "c3",
    ),
    memoryIds: ["mem-3"],
    statusDetail: null,
  };

  const c4Start = at(now, 1, 12, 40);
  const c4 = {
    id: "conv-lunch",
    status: "ready",
    startMs: c4Start,
    endMs: c4Start + 26 * MIN,
    title: "Lunch with Aylin — Lisbon trip and the reading list",
    summary:
      "Aylin is going to Lisbon in March and recommended two books. She prefers trains over flights for anything under six hours.",
    topics: ["travel", "books"],
    participants: ["You", "Aylin"],
    language: "en",
    deviceIds: ["dev-watch", "dev-iphone"],
    utteranceCount: 22,
    openActionItems: 0,
    interim: false,
    updatedAt: iso(c4Start + 30 * MIN),
    notes: "- Aylin: Lisbon in **March**\n- Books: *The Overstory*, *Piranesi*",
    decisions: [],
    actionItems: [],
    utterances: utterances(
      c4Start,
      [
        [
          "unknown",
          "You have to read Piranesi, it's short and strange.",
          ["dev-iphone", "dev-watch"],
          ["ambient", "ambient"],
        ],
      ],
      "c4",
    ),
    memoryIds: ["mem-4", "mem-5"],
    statusDetail: null,
  };

  const c5Start = at(now, 3, 18, 20);
  const c5 = {
    id: "conv-call",
    status: "transcript_only",
    startMs: c5Start,
    endMs: c5Start + 9 * MIN,
    title: null,
    summary: null,
    topics: [],
    participants: [],
    language: "tr",
    deviceIds: ["dev-iphone"],
    utteranceCount: 11,
    openActionItems: 0,
    interim: false,
    updatedAt: iso(c5Start + 10 * MIN),
    notes: null,
    decisions: [],
    actionItems: [],
    utterances: utterances(
      c5Start,
      [["self", "Tamam, yarın sabah tekrar konuşalım.", ["dev-iphone"], ["mic"]]],
      "c5",
    ).map((u) => ({ ...u, language: "tr" })),
    memoryIds: [],
    statusDetail: "The language model at http://localhost:11434/v1 did not answer within 60 s.",
  };

  const conversations = z.array(zConversationDetail).parse([c0, c1, c2, c3, c4, c5]);

  const memories = z
    .array(zMemory)
    .parse([
      mem(
        "mem-1",
        "decision",
        "The pricing page leads with the yearly plan; monthly is the secondary option.",
        4,
        ["pricing page"],
        "conv-pricing",
        c1Start,
      ),
      mem(
        "mem-2",
        "commitment",
        "I promised to ask legal about the refund wording before the launch on the 4th.",
        5,
        ["legal", "launch"],
        "conv-pricing",
        c1Start,
      ),
      mem(
        "mem-3",
        "person",
        "Deniz is the onboarding buddy for the new support engineer.",
        3,
        ["Deniz", "support"],
        "conv-onboarding",
        c3Start,
      ),
      mem(
        "mem-4",
        "preference",
        "Aylin prefers trains over flights for trips under six hours.",
        3,
        ["Aylin"],
        "conv-lunch",
        c4Start,
      ),
      mem(
        "mem-5",
        "event",
        "Aylin is travelling to Lisbon in March.",
        2,
        ["Aylin", "Lisbon"],
        "conv-lunch",
        c4Start,
      ),
      mem(
        "mem-6",
        "fact",
        "The office Wi-Fi network for guests is called “Atelier-Guest”.",
        1,
        ["office"],
        null,
        now - 9 * DAY,
        "manual",
      ),
      mem(
        "mem-7",
        "idea",
        "Offer a read-only share link for a single conversation's notes.",
        3,
        ["product"],
        null,
        now - 12 * DAY,
      ),
    ]);

  const settings = zSettings.parse({
    providers: {
      llm: {
        role: "llm",
        kind: "openai_compatible",
        model: "llama3.1:8b",
        baseUrl: "http://localhost:11434/v1",
        hasApiKey: false,
        origin: "instance_default",
        thirdParty: false,
      },
      stt: {
        role: "stt",
        kind: "openai_compatible",
        model: "Systran/faster-whisper-small",
        baseUrl: "http://localhost:8000/v1",
        hasApiKey: false,
        origin: "user",
        thirdParty: false,
      },
      embedding: {
        role: "embedding",
        kind: "none",
        model: null,
        baseUrl: null,
        hasApiKey: false,
        origin: "unset",
        thirdParty: false,
      },
    },
    privacy: {
      ingestPaused: false,
      retainAudio: false,
      audioRetentionDays: null,
      dataRetentionDays: null,
    },
    pipeline: {
      language: null,
      conversationGapMinutes: 5,
      extractMemories: true,
      liveNotesMinutes: 15,
      dailyDigest: true,
      timeZone: FIXTURE_TZ,
    },
  });

  const catalog = zProviderCatalog.parse({
    entries: [
      {
        kind: "anthropic",
        roles: ["llm"],
        available: true,
        unavailableReason: null,
        thirdParty: true,
        needsApiKey: true,
        needsBaseUrl: false,
        defaultModels: { llm: "claude-sonnet-4-5" },
      },
      {
        kind: "openai",
        roles: ["llm", "stt", "embedding"],
        available: true,
        unavailableReason: null,
        thirdParty: true,
        needsApiKey: true,
        needsBaseUrl: false,
        defaultModels: {
          llm: "gpt-5-mini",
          stt: "gpt-4o-mini-transcribe",
          embedding: "text-embedding-3-small",
        },
      },
      {
        kind: "openai_compatible",
        roles: ["llm", "stt", "embedding"],
        available: true,
        unavailableReason: null,
        thirdParty: false,
        needsApiKey: false,
        needsBaseUrl: true,
      },
      {
        kind: "claude_code_cli",
        roles: ["llm"],
        available: true,
        unavailableReason: null,
        thirdParty: true,
        needsApiKey: false,
        needsBaseUrl: false,
      },
      {
        kind: "codex_cli",
        roles: ["llm"],
        available: false,
        unavailableReason: "The codex command was not found on the server.",
        thirdParty: true,
        needsApiKey: false,
        needsBaseUrl: false,
      },
    ],
    presets: [
      {
        id: "ollama-llm",
        label: "Ollama",
        role: "llm",
        baseUrl: "http://localhost:11434/v1",
        model: "llama3.1:8b",
      },
      {
        id: "lmstudio-llm",
        label: "LM Studio",
        role: "llm",
        baseUrl: "http://localhost:1234/v1",
        model: "qwen2.5-7b-instruct",
      },
      {
        id: "speaches-stt",
        label: "Speaches (faster-whisper)",
        role: "stt",
        baseUrl: "http://localhost:8000/v1",
        model: "Systran/faster-whisper-small",
      },
      {
        id: "whispercpp-stt",
        label: "whisper.cpp",
        role: "stt",
        baseUrl: "http://localhost:8080/v1",
        model: "whisper-1",
      },
      {
        id: "ollama-embed",
        label: "Ollama",
        role: "embedding",
        baseUrl: "http://localhost:11434/v1",
        model: "nomic-embed-text",
      },
    ],
  });

  const search = zSearchResponse.parse({
    mode: "keyword",
    hits: [
      {
        type: "memory",
        id: "mem-2",
        conversationId: "conv-pricing",
        title: null,
        snippet: "I promised to ask legal about the refund wording before the launch on the 4th.",
        score: 0.92,
        atMs: c1Start,
      },
      {
        type: "conversation",
        id: "conv-pricing",
        conversationId: "conv-pricing",
        title: "Pricing review with the design team",
        snippet:
          "…agreed to lead with the yearly plan. The launch stays on the 4th unless legal review slips.",
        score: 0.81,
        atMs: c1Start,
      },
      {
        type: "utterance",
        id: "c1-u6",
        conversationId: "conv-pricing",
        title: "Pricing review with the design team",
        snippet: "Yes, unless legal needs more time on the refund wording. I'll ask them today.",
        score: 0.64,
        atMs: c1Start + 5 * MIN,
      },
    ],
  });

  const ask = zAskResponse.parse({
    answer:
      "The launch is planned for **the 4th** [2]. The only risk mentioned is the legal review of the refund wording, which you promised to raise with legal [1][3].",
    citations: search.hits
      .map((h) => ({ ...h }))
      .sort((a, b) => (a.type === "memory" ? -1 : b.type === "memory" ? 1 : 0)),
  });

  const today = dayInZone(now, FIXTURE_TZ);
  const day = (ms: number) => dayInZone(ms, FIXTURE_TZ);
  const digests: Record<string, DayDigest> = {
    [today]: {
      status: "ready",
      headline: "Pricing settled; the product sync is still going",
      summary:
        "The pricing page will lead with the yearly plan and the launch stays on the 4th. The weekly product sync is still running and has covered the roadmap so far.",
      digest: [
        "### Morning",
        "- **Stand-up** — notes are still being written.",
        "- **Pricing review** with Mira and Deniz: yearly plan first, comparison table to be reworked for mobile.",
        "",
        "### Afternoon",
        "- **Weekly product sync** (still going): onboarding checklist first on the roadmap.",
        "",
        "<img src=https://tracker.example/pixel.gif> Remote images are stripped.",
      ].join("\n"),
      highlights: [
        "Pricing page leads with the yearly plan",
        "Launch date stays on the 4th",
        "New onboarding flow could ship before month end",
      ],
      decisions: [
        "Lead with the yearly plan on the pricing page.",
        "Keep the launch date on the 4th.",
      ],
      people: ["Mira", "Deniz"],
      statusDetail: null,
    },
    [day(c3Start)]: {
      status: "ready",
      headline: "Onboarding plan for support, and lunch with Aylin",
      summary:
        "Planned the first two weeks for the new support engineer with Deniz as buddy. Lunch with Aylin: Lisbon in March and two book recommendations.",
      digest:
        "- **Onboarding plan**: shadowing, sandbox account, runbook review.\n- **Lunch with Aylin**: *Piranesi* and *The Overstory*; she prefers trains for short trips.",
      highlights: ["Deniz is the onboarding buddy", "Aylin recommended Piranesi"],
      decisions: ["Deniz is the onboarding buddy."],
      people: ["Deniz", "Aylin"],
      statusDetail: null,
    },
    [day(c5Start)]: {
      status: "unavailable",
      headline: null,
      summary: null,
      digest: null,
      highlights: [],
      decisions: [],
      people: [],
      statusDetail: "The language model at http://localhost:11434/v1 did not answer within 60 s.",
    },
  };

  return {
    now,
    devices,
    streams,
    conversations,
    memories,
    settings,
    catalog,
    search,
    ask,
    digests,
  };
}

function mem(
  id: string,
  kind: Memory["kind"],
  content: string,
  importance: number,
  subjects: string[],
  sourceConversationId: string | null,
  at: number,
  origin: Memory["origin"] = "extracted",
): Memory {
  return {
    id,
    kind,
    content,
    importance,
    subjects,
    sourceConversationId,
    origin,
    occurredAt: sourceConversationId ? iso(at) : null,
    createdAt: iso(at + 50 * MIN),
    updatedAt: iso(at + 50 * MIN),
  };
}

/**
 * A day as the server would report it: digest text from `fx.digests`, everything else
 * derived from the conversations that started on that day in the account's zone.
 */
export function buildDay(fx: FixtureSet, date: string): DayDetail {
  const tz = fx.settings.pipeline.timeZone;
  const convs = fx.conversations
    .filter((c) => dayInZone(c.startMs, tz) === date)
    .sort((a, b) => a.startMs - b.startMs);
  const d = fx.digests[date];
  const status: DayStatus = !fx.settings.pipeline.dailyDigest
    ? "none"
    : (d?.status ?? (convs.length ? "pending" : "none"));
  const lastUpdate =
    convs
      .map((c) => c.updatedAt)
      .sort()
      .at(-1) ?? null;
  return zDayDetail.parse({
    date,
    status,
    headline: d?.headline ?? null,
    summary: d?.summary ?? null,
    conversationCount: convs.length,
    speechMinutes: Math.round(convs.reduce((n, c) => n + (c.endMs - c.startMs), 0) / 60_000),
    openActionItems: convs.reduce((n, c) => n + c.actionItems.filter((a) => !a.done).length, 0),
    updatedAt: lastUpdate,
    timeZone: tz,
    digest: d?.digest ?? null,
    highlights: d?.highlights ?? [],
    decisions: d?.decisions ?? [],
    people: d?.people ?? [],
    conversations: convs.map((c) => zConversationSummary.parse(c)),
    actionItems: convs.flatMap((c) =>
      c.actionItems
        .filter((a) => !a.done)
        .map((a) => ({ ...a, conversationId: c.id, conversationTitle: c.title })),
    ),
    statusDetail: d?.statusDetail ?? null,
  });
}

/** Every day with at least one conversation, newest first (as the server lists them). */
export function listDays(fx: FixtureSet): string[] {
  const tz = fx.settings.pipeline.timeZone;
  return [...new Set(fx.conversations.map((c) => dayInZone(c.startMs, tz)))].sort().reverse();
}
