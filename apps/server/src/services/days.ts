import { normalizeText } from "@ltm/core";
import { type DayDetail, type DaySummary, type Page, zLanguage } from "@ltm/protocol";
import { type Ctx, iso } from "../context.js";
import { json, one, type Queryable } from "../db/types.js";
import { badRequest, isProviderError } from "../errors.js";
import { decideLanguage, dominantLanguage, languageDirective } from "../pipeline/language.js";
import { cleanPeople } from "../pipeline/people.js";
import { digestSystemPrompt, zDayDigestOut } from "../pipeline/prompts.js";
import type { JobHandler } from "../pipeline/worker.js";
import { localDate, localTime, weekdayLabel } from "../time.js";
import {
  type ActionItemRow,
  type ConversationRow,
  conversationSummariesOfDay,
} from "./conversations.js";
import { getPipeline, resolveProvidersForUser } from "./settings.js";

/** Debounce for digest rewrites: one model call per burst of changes to a day. */
export const DIGEST_DEBOUNCE_MS = 60_000;
/** Bounds on what one digest call sees (it never sees transcripts). */
const MAX_CONVERSATIONS = 60;
const MAX_SUMMARY_CHARS = 1500;

export const NO_LLM_DAY_DETAIL =
  "No language model is configured, so there is no digest for this day.";

interface DayRow {
  user_id: string;
  date: string;
  status: DaySummary["status"];
  headline: string | null;
  summary: string | null;
  digest: string | null;
  highlights: string[];
  decisions: string[];
  people: string[];
  language: string | null;
  status_detail: string | null;
  generated_at: number | null;
  updated_at: number;
}

const digestKey = (userId: string, date: string) => `digest:${userId}:${date}`;

/** Marks the day as being rewritten and queues its (debounced) digest job. */
export async function scheduleDigest(
  ctx: Ctx,
  q: Queryable,
  userId: string,
  date: string | null | undefined,
  delayMs = DIGEST_DEBOUNCE_MS,
): Promise<void> {
  if (!date) return;
  const pipeline = await getPipeline(q, userId);
  if (!pipeline.dailyDigest) return;
  const now = ctx.clock.now();
  await q.query(
    `INSERT INTO days (user_id, date, status, updated_at) VALUES ($1, $2, 'pending', $3)
     ON CONFLICT (user_id, date) DO UPDATE SET status = 'pending', updated_at = EXCLUDED.updated_at`,
    [userId, date, now],
  );
  await ctx.jobs.enqueue(q, {
    kind: "digest",
    userId,
    payload: { date },
    dedupeKey: digestKey(userId, date),
    runAt: now + delayMs,
  });
}

export async function scheduleDigests(
  ctx: Ctx,
  q: Queryable,
  userId: string,
  dates: Iterable<string | null | undefined>,
): Promise<void> {
  for (const d of new Set(dates)) await scheduleDigest(ctx, q, userId, d);
}

/** Time zone changed: re-date every conversation and rewrite the digests of the days that moved. */
export async function relocalizeDays(ctx: Ctx, userId: string, timeZone: string): Promise<void> {
  await ctx.db.tx(async (q) => {
    const convs = await q.query<{ id: string; start_ms: number; local_date: string | null }>(
      "SELECT id, start_ms, local_date FROM conversations WHERE user_id = $1",
      [userId],
    );
    const touched = new Set<string>();
    for (const c of convs) {
      const d = localDate(c.start_ms, timeZone);
      if (d === c.local_date) continue;
      await q.query("UPDATE conversations SET local_date = $2 WHERE id = $1", [c.id, d]);
      touched.add(d);
      if (c.local_date) touched.add(c.local_date);
    }
    await scheduleDigests(ctx, q, userId, touched);
  });
}

/** Digests were switched on: queue the days that have conversations but no digest. */
export async function scheduleMissingDigests(ctx: Ctx, userId: string): Promise<void> {
  await ctx.db.tx(async (q) => {
    const rows = await q.query<{ date: string }>(
      `SELECT DISTINCT c.local_date AS date FROM conversations c
         LEFT JOIN days d ON d.user_id = c.user_id AND d.date = c.local_date
        WHERE c.user_id = $1 AND c.local_date IS NOT NULL AND (d.status IS NULL OR d.status <> 'ready')
        ORDER BY 1 DESC LIMIT 90`,
      [userId],
    );
    await scheduleDigests(
      ctx,
      q,
      userId,
      rows.map((r) => r.date),
    );
  });
}

// ------------------------------------------------------------------------------- read

interface StatsRow {
  date: string;
  n: number;
  span: number | null;
  open_items: number;
}

const STATS_SELECT = `SELECT c.local_date AS date, count(*)::int AS n, sum(c.end_ms - c.start_ms) AS span,
    (SELECT count(*)::int FROM action_items a JOIN conversations c2 ON c2.id = a.conversation_id
      WHERE c2.user_id = c.user_id AND c2.local_date = c.local_date AND NOT a.done) AS open_items
  FROM conversations c`;

function summaryOf(
  date: string,
  stats: StatsRow | undefined,
  row: DayRow | null,
  digestOn: boolean,
): DaySummary {
  const n = stats?.n ?? 0;
  const status: DaySummary["status"] = !digestOn || n === 0 ? "none" : (row?.status ?? "pending");
  const show = digestOn && n > 0;
  return {
    date,
    status,
    headline: show ? (row?.headline ?? null) : null,
    summary: show ? (row?.summary ?? null) : null,
    conversationCount: n,
    speechMinutes: Math.round(((stats?.span ?? 0) / 60_000) * 10) / 10,
    openActionItems: stats?.open_items ?? 0,
    updatedAt: row ? iso(row.updated_at) : null,
  };
}

function encodeDayCursor(date: string): string {
  return Buffer.from(date).toString("base64url");
}

function decodeDayCursor(cursor: string): string {
  const d = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw badRequest("Invalid cursor.");
  return d;
}

/** Days that have conversations, newest first. */
export async function listDays(
  ctx: Ctx,
  userId: string,
  query: {
    limit: number;
    cursor?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
  },
): Promise<Page<DaySummary>> {
  const where = ["c.user_id = $1", "c.local_date IS NOT NULL"];
  const params: unknown[] = [userId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (query.from) add("c.local_date >= ?", query.from);
  if (query.to) add("c.local_date <= ?", query.to);
  if (query.cursor) add("c.local_date < ?", decodeDayCursor(query.cursor));
  params.push(query.limit + 1);
  const stats = await ctx.db.query<StatsRow>(
    `${STATS_SELECT} WHERE ${where.join(" AND ")} GROUP BY c.user_id, c.local_date ORDER BY c.local_date DESC LIMIT $${params.length}`,
    params,
  );
  const page = stats.slice(0, query.limit);
  const rows = page.length
    ? await ctx.db.query<DayRow>(
        "SELECT * FROM days WHERE user_id = $1 AND date = ANY($2::text[])",
        [userId, page.map((s) => s.date)],
      )
    : [];
  const pipeline = await getPipeline(ctx.db, userId);
  const last = page[page.length - 1];
  return {
    items: page.map((s) =>
      summaryOf(s.date, s, rows.find((r) => r.date === s.date) ?? null, pipeline.dailyDigest),
    ),
    nextCursor: stats.length > query.limit && last ? encodeDayCursor(last.date) : null,
  };
}

async function dayStats(q: Queryable, userId: string, date: string): Promise<StatsRow | undefined> {
  return (
    await q.query<StatsRow>(
      `${STATS_SELECT} WHERE c.user_id = $1 AND c.local_date = $2 GROUP BY c.user_id, c.local_date`,
      [userId, date],
    )
  )[0];
}

export async function daySummary(ctx: Ctx, userId: string, date: string): Promise<DaySummary> {
  const [stats, row, pipeline] = await Promise.all([
    dayStats(ctx.db, userId, date),
    one<DayRow>(ctx.db, "SELECT * FROM days WHERE user_id = $1 AND date = $2", [userId, date]),
    getPipeline(ctx.db, userId),
  ]);
  return summaryOf(date, stats, row, pipeline.dailyDigest);
}

export async function dayDetail(ctx: Ctx, userId: string, date: string): Promise<DayDetail | null> {
  const [stats, row, pipeline] = await Promise.all([
    dayStats(ctx.db, userId, date),
    one<DayRow>(ctx.db, "SELECT * FROM days WHERE user_id = $1 AND date = $2", [userId, date]),
    getPipeline(ctx.db, userId),
  ]);
  if (!stats) return null;
  const summary = summaryOf(date, stats, row, pipeline.dailyDigest);
  const show = summary.status !== "none";
  const conversations = await conversationSummariesOfDay(ctx.db, userId, date);
  const items = await ctx.db.query<ActionItemRow & { title: string | null }>(
    `SELECT a.*, c.title FROM action_items a JOIN conversations c ON c.id = a.conversation_id
      WHERE c.user_id = $1 AND c.local_date = $2 ORDER BY c.start_ms, a.position, a.created_at`,
    [userId, date],
  );
  return {
    ...summary,
    timeZone: pipeline.timeZone,
    digest: show ? (row?.digest ?? null) : null,
    highlights: show ? (row?.highlights ?? []) : [],
    decisions: show ? (row?.decisions ?? []) : [],
    people: show ? (row?.people ?? []) : [],
    conversations,
    actionItems: items.map((a) => ({
      id: a.id,
      text: a.text,
      owner: a.owner,
      due: a.due,
      done: a.done,
      conversationId: a.conversation_id,
      conversationTitle: a.title,
    })),
    statusDetail: show ? (row?.status_detail ?? null) : null,
  };
}

/** After conversations were deleted: drop days left empty, rewrite the others. */
export async function refreshDaysAfterDelete(
  ctx: Ctx,
  userId: string,
  dates: Iterable<string | null>,
): Promise<void> {
  for (const date of new Set(dates)) {
    if (!date) continue;
    const left = await one(
      ctx.db,
      "SELECT 1 FROM conversations WHERE user_id = $1 AND local_date = $2 LIMIT 1",
      [userId, date],
    );
    if (left) {
      await scheduleDigest(ctx, ctx.db, userId, date);
    } else {
      await ctx.db.query("DELETE FROM days WHERE user_id = $1 AND date = $2", [userId, date]);
      ctx.bus.publish(userId, { type: "day_updated", day: await daySummary(ctx, userId, date) });
    }
  }
}

// ----------------------------------------------------------------------------- digest

async function upsertDay(
  ctx: Ctx,
  userId: string,
  date: string,
  fields: Partial<DayRow>,
): Promise<void> {
  const now = ctx.clock.now();
  // A newer change to the day is already queued: keep "pending" visible, but store the content.
  const queued = await one(
    ctx.db,
    "SELECT 1 FROM jobs WHERE dedupe_key = $1 AND status = 'pending'",
    [digestKey(userId, date)],
  );
  const status = queued && fields.status === "ready" ? "pending" : fields.status;
  await ctx.db.query(
    `INSERT INTO days (user_id, date, status, headline, summary, digest, highlights, decisions, people, language, status_detail, generated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13)
     ON CONFLICT (user_id, date) DO UPDATE SET status = EXCLUDED.status,
       headline = COALESCE(EXCLUDED.headline, days.headline), summary = COALESCE(EXCLUDED.summary, days.summary),
       digest = COALESCE(EXCLUDED.digest, days.digest),
       highlights = CASE WHEN $14 THEN EXCLUDED.highlights ELSE days.highlights END,
       decisions = CASE WHEN $14 THEN EXCLUDED.decisions ELSE days.decisions END,
       people = CASE WHEN $14 THEN EXCLUDED.people ELSE days.people END,
       language = COALESCE(EXCLUDED.language, days.language), status_detail = EXCLUDED.status_detail,
       generated_at = COALESCE(EXCLUDED.generated_at, days.generated_at), updated_at = EXCLUDED.updated_at`,
    [
      userId,
      date,
      status,
      fields.headline ?? null,
      fields.summary ?? null,
      fields.digest ?? null,
      json(fields.highlights ?? []),
      json(fields.decisions ?? []),
      json(fields.people ?? []),
      fields.language ?? null,
      fields.status_detail ?? null,
      fields.generated_at ?? null,
      now,
      fields.highlights !== undefined,
    ],
  );
}

async function publishDay(ctx: Ctx, userId: string, date: string): Promise<void> {
  ctx.bus.publish(userId, { type: "day_updated", day: await daySummary(ctx, userId, date) });
}

function clean(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanList(list: string[], maxItems: number, maxLen: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = clean(raw, maxLen);
    const k = normalizeText(v);
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= maxItems) break;
  }
  return out;
}

export async function runDigest(
  ctx: Ctx,
  userId: string,
  date: string,
  signal: AbortSignal,
): Promise<void> {
  const pipeline = await getPipeline(ctx.db, userId);
  const convs = await ctx.db.query<ConversationRow>(
    "SELECT * FROM conversations WHERE user_id = $1 AND local_date = $2 ORDER BY start_ms, id",
    [userId, date],
  );
  if (convs.length === 0 || !pipeline.dailyDigest) {
    await ctx.db.query("DELETE FROM days WHERE user_id = $1 AND date = $2", [userId, date]);
    await publishDay(ctx, userId, date);
    return;
  }
  const { llm } = await resolveProvidersForUser(ctx, userId, ["llm"]);
  if (!llm) {
    await upsertDay(ctx, userId, date, { status: "unavailable", status_detail: NO_LLM_DAY_DETAIL });
    await publishDay(ctx, userId, date);
    return;
  }
  const withNotes = convs.filter((c) => c.title || c.summary);
  if (withNotes.length === 0) {
    const stillGoing = convs.some((c) => c.status === "open" || c.status === "processing");
    await upsertDay(ctx, userId, date, {
      status: stillGoing ? "pending" : "unavailable",
      status_detail: stillGoing ? null : "None of this day's conversations has notes.",
    });
    await publishDay(ctx, userId, date);
    return;
  }
  const items = await ctx.db.query<ActionItemRow>(
    `SELECT a.* FROM action_items a JOIN conversations c ON c.id = a.conversation_id
      WHERE c.user_id = $1 AND c.local_date = $2 AND NOT a.done ORDER BY a.position`,
    [userId, date],
  );
  const tz = pipeline.timeZone;
  const input = withNotes.slice(0, MAX_CONVERSATIONS).map((c) => ({
    from: localTime(c.start_ms, tz),
    to: localTime(c.end_ms, tz),
    minutes: Math.max(1, Math.round((c.end_ms - c.start_ms) / 60_000)),
    stillGoingOn: c.status === "open",
    title: c.title,
    summary: c.summary ? c.summary.slice(0, MAX_SUMMARY_CHARS) : null,
    decisions: (c.decisions ?? []).slice(0, 20),
    openActionItems: items
      .filter((a) => a.conversation_id === c.id)
      .slice(0, 20)
      .map((a) => ({ text: a.text, owner: a.owner, due: a.due })),
    participants: (c.participants ?? []).slice(0, 20),
    topics: c.topics ?? [],
    language: c.language,
  }));
  const omitted = convs.length - input.length;
  const prompt = `Day: ${weekdayLabel(date)} (time zone ${tz}). ${convs.length} conversation(s)${omitted > 0 ? `, ${omitted} without notes not shown` : ""}.\n\n<conversations>\n${JSON.stringify(input, null, 1)}\n</conversations>`;
  const owner = await one<{ locale: string; display_name: string }>(
    ctx.db,
    "SELECT locale, display_name FROM users WHERE id = $1",
    [userId],
  );
  const outLang = decideLanguage({
    fixed: pipeline.language,
    spoken: dominantLanguage(
      convs.map((c) => ({ language: c.language, weight: c.end_ms - c.start_ms })),
    ),
    locale: owner?.locale ?? "en",
  });
  const { value } = await llm.completeJson({
    system: digestSystemPrompt({ language: outLang }),
    prompt: `${prompt}\n\n${languageDirective(outLang, "headline, summary, digest, highlights, decisions")}`,
    schema: zDayDigestOut,
    schemaName: "day_digest",
    maxTokens: 4000,
    signal,
  });
  const language =
    value.language && zLanguage.safeParse(value.language).success ? value.language : outLang;
  await upsertDay(ctx, userId, date, {
    status: "ready",
    headline: clean(value.headline, 200) || null,
    summary: clean(value.summary, 2000) || null,
    digest: value.digest.trim().slice(0, 50_000) || null,
    highlights: cleanList(value.highlights, 10, 400),
    decisions: cleanList(value.decisions, 30, 600),
    people: cleanPeople(cleanList(value.people, 40, 120), owner?.display_name ?? "", 40),
    language,
    status_detail: null,
    generated_at: ctx.clock.now(),
  });
  await publishDay(ctx, userId, date);
}

export const digestHandler: JobHandler = {
  async run(ctx, job, signal) {
    if (!job.user_id) return;
    await runDigest(ctx, job.user_id, String(job.payload.date ?? ""), signal);
  },
  async onFailed(ctx, job, err) {
    if (!job.user_id) return;
    const date = String(job.payload.date ?? "");
    const detail = isProviderError(err)
      ? `The language model failed (${err.provider}: ${err.code}); regenerate to try again.`
      : "Writing the digest failed; regenerate to try again.";
    await upsertDay(ctx, job.user_id, date, { status: "unavailable", status_detail: detail });
    await publishDay(ctx, job.user_id, date);
  },
};
