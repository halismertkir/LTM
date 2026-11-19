import { randomUUID } from "node:crypto";
import { normalizeText } from "@ltm/core";
import { zLanguage } from "@ltm/protocol";
import type { EmbeddingProvider, LlmProvider } from "@ltm/providers";
import type { Ctx } from "../context.js";
import { sha256Hex } from "../crypto.js";
import { json, type Queryable, vectorLiteral } from "../db/types.js";
import { isProviderError } from "../errors.js";
import {
  type ActionItemRow,
  type ConversationRow,
  conversationSearchText,
  conversationSummaries,
  getConversationRow,
  type UtteranceRow,
} from "../services/conversations.js";
import { insertMemory, type MemoryRow, memoryDto, scheduleEmbed } from "../services/memories.js";
import { getPipeline, resolveProvidersForUser } from "../services/settings.js";
import { remergeConversation } from "./merge.js";
import {
  type ConversationNotes,
  formatHeader,
  formatTranscriptLines,
  notesSystemPrompt,
  type PartNotes,
  partSystemPrompt,
  reduceSystemPrompt,
  splitIntoParts,
  type TranscriptHeader,
  wrapTranscript,
  zConversationNotes,
  zPartNotes,
} from "./prompts.js";
import type { JobHandler } from "./worker.js";

/** Transcripts up to this size go to the model in one request; longer ones are map-reduced. */
export const SINGLE_PASS_CHARS = 60_000;
const PART_CHARS = 40_000;
const PART_OVERLAP_CHARS = 2_000;
/** Cosine similarity above which two memories are considered the same statement. */
export const MEMORY_DUPLICATE_SIMILARITY = 0.9;

export const NO_LLM_DETAIL =
  "No language model is configured, so only the transcript is available. Configure one in Settings → Providers and reprocess the conversation.";

function clean(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanList(list: string[], maxItems: number, maxLen: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = clean(raw, maxLen);
    const key = normalizeText(v);
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= maxItems) break;
  }
  return out;
}

function validDate(s: string | null): string | null {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim());
  if (!m) return null;
  return Number.isNaN(Date.parse(m[1]!)) ? null : m[1]!;
}

function validInstant(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : s.trim().slice(0, 40);
}

async function generateNotes(
  llm: LlmProvider,
  header: TranscriptHeader,
  lines: string[],
  opts: { language: string | null; extractMemories: boolean },
  signal: AbortSignal,
): Promise<ConversationNotes> {
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= SINGLE_PASS_CHARS) {
    const { value } = await llm.completeJson({
      system: notesSystemPrompt(opts),
      prompt: wrapTranscript(formatHeader(header), lines),
      schema: zConversationNotes,
      schemaName: "conversation_notes",
      maxTokens: 8000,
      signal,
    });
    return value;
  }
  const parts = splitIntoParts(lines, PART_CHARS, PART_OVERLAP_CHARS);
  const partNotes: PartNotes[] = [];
  for (let i = 0; i < parts.length; i++) {
    const { value } = await llm.completeJson({
      system: partSystemPrompt(opts),
      prompt: wrapTranscript(formatHeader(header, { index: i, total: parts.length }), parts[i]!),
      schema: zPartNotes,
      schemaName: "conversation_part_notes",
      maxTokens: 6000,
      signal,
    });
    partNotes.push(value);
  }
  const { value } = await llm.completeJson({
    system: reduceSystemPrompt(opts),
    prompt: `${formatHeader(header)}\n\n<part_notes>\n${JSON.stringify(partNotes, null, 1)}\n</part_notes>`,
    schema: zConversationNotes,
    schemaName: "conversation_notes",
    maxTokens: 8000,
    signal,
  });
  return value;
}

/** Keeps done/edited action items, reuses ids of unchanged ones, replaces the rest. */
async function reconcileActionItems(
  ctx: Ctx,
  q: Queryable,
  conv: ConversationRow,
  items: ConversationNotes["actionItems"],
): Promise<void> {
  const existing = await q.query<ActionItemRow>(
    "SELECT * FROM action_items WHERE conversation_id = $1",
    [conv.id],
  );
  const byText = new Map(existing.map((e) => [normalizeText(e.text), e]));
  const keep = new Set<string>();
  const now = ctx.clock.now();
  let position = 0;
  for (const it of items.slice(0, 50)) {
    const text = clean(it.text, 1000);
    if (!text) continue;
    const match = byText.get(normalizeText(text));
    if (match && !keep.has(match.id)) {
      keep.add(match.id);
      await q.query(
        "UPDATE action_items SET owner = $2, due = $3, position = $4, updated_at = $5 WHERE id = $1",
        [
          match.id,
          it.owner ? clean(it.owner, 120) : match.owner,
          validDate(it.due) ?? match.due,
          position++,
          now,
        ],
      );
      continue;
    }
    const id = randomUUID();
    keep.add(id);
    await q.query(
      `INSERT INTO action_items (id, conversation_id, user_id, text, owner, due, done, position, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $8)`,
      [
        id,
        conv.id,
        conv.user_id,
        text,
        it.owner ? clean(it.owner, 120) : null,
        validDate(it.due),
        position++,
        now,
      ],
    );
  }
  for (const e of existing) {
    if (keep.has(e.id)) continue;
    // What the user touched stays; untouched items the model no longer reports go.
    if (e.done || e.text_edited)
      await q.query("UPDATE action_items SET position = $2 WHERE id = $1", [e.id, position++]);
    else await q.query("DELETE FROM action_items WHERE id = $1", [e.id]);
  }
}

interface Candidate {
  kind: ConversationNotes["memories"][number]["kind"];
  content: string;
  importance: number;
  subjects: string[];
  occurredAt: string | null;
  normalized: string;
  vector: number[] | null;
}

async function embedCandidates(
  ctx: Ctx,
  embedding: EmbeddingProvider | null,
  cands: Candidate[],
  signal: AbortSignal,
): Promise<void> {
  if (!embedding || cands.length === 0) return;
  try {
    const vectors = await embedding.embed(
      cands.map((c) => c.content),
      { signal },
    );
    cands.forEach((c, i) => {
      c.vector = vectors[i] ?? null;
    });
  } catch (err) {
    // Dedupe then falls back to text equality; the embed job fills vectors in later.
    ctx.log.warn(
      { err: isProviderError(err) ? err.code : (err as Error).message },
      "embedding memory candidates failed",
    );
  }
}

/** Stores memory candidates, folding duplicates of existing memories into them instead. */
async function storeMemories(
  ctx: Ctx,
  q: Queryable,
  conv: ConversationRow,
  cands: Candidate[],
  embeddingModel: string | null,
): Promise<MemoryRow[]> {
  const created: MemoryRow[] = [];
  const now = ctx.clock.now();
  for (const c of cands) {
    let dup = (
      await q.query<MemoryRow>(
        "SELECT * FROM memories WHERE user_id = $1 AND normalized = $2 LIMIT 1",
        [conv.user_id, c.normalized],
      )
    )[0];
    if (!dup && c.vector && embeddingModel) {
      const hit = await q.query<MemoryRow & { sim: number }>(
        `SELECT m.*, 1 - (e.embedding <=> $3::vector) AS sim
           FROM embeddings e JOIN memories m ON m.id = e.memory_id
          WHERE e.user_id = $1 AND e.owner_type = 'memory' AND e.model = $2 AND e.dims = $4
          ORDER BY e.embedding <=> $3::vector LIMIT 1`,
        [conv.user_id, embeddingModel, vectorLiteral(c.vector), c.vector.length],
      );
      if (hit[0] && hit[0].sim >= MEMORY_DUPLICATE_SIMILARITY) dup = hit[0];
    }
    if (dup) {
      // Same statement again: strengthen what is stored rather than duplicating it.
      const subjects = [...new Set([...(dup.subjects ?? []), ...c.subjects])].slice(0, 20);
      await q.query(
        "UPDATE memories SET importance = GREATEST(importance, $2), subjects = $3::jsonb, occurred_at = COALESCE(occurred_at, $4), updated_at = $5 WHERE id = $1",
        [dup.id, c.importance, json(subjects), c.occurredAt, now],
      );
      continue;
    }
    const row = await insertMemory(ctx, q, conv.user_id, {
      kind: c.kind,
      content: c.content,
      importance: c.importance,
      subjects: c.subjects,
      occurredAt: c.occurredAt,
      origin: "extracted",
      sourceConversationId: conv.id,
    });
    if (c.vector && embeddingModel) {
      await q.query(
        `INSERT INTO embeddings (id, user_id, owner_type, owner_id, memory_id, conversation_id, model, dims, text_hash, snippet, at_ms, embedding, created_at)
         VALUES ($1, $2, 'memory', $3, $3, NULL, $4, $5, $6, $7, NULL, $8::vector, $9)`,
        [
          randomUUID(),
          conv.user_id,
          row.id,
          embeddingModel,
          c.vector.length,
          sha256Hex(row.content),
          row.content.slice(0, 300),
          vectorLiteral(c.vector),
          now,
        ],
      );
    }
    created.push(row);
  }
  return created;
}

async function finishWithoutNotes(ctx: Ctx, conv: ConversationRow, detail: string): Promise<void> {
  await ctx.db.query(
    "UPDATE conversations SET status = 'transcript_only', status_detail = $2, consolidated_revision = revision, updated_at = $3 WHERE id = $1 AND status = 'processing'",
    [conv.id, detail, ctx.clock.now()],
  );
  await scheduleEmbed(ctx, ctx.db, conv.user_id);
  await publishConversation(ctx, conv.user_id, conv.id);
}

async function publishConversation(ctx: Ctx, userId: string, id: string): Promise<void> {
  for (const s of await conversationSummaries(ctx.db, userId, [id])) {
    ctx.bus.publish(userId, { type: "conversation_updated", conversation: s });
  }
}

export async function runConsolidate(
  ctx: Ctx,
  userId: string,
  conversationId: string,
  remerge: boolean,
  signal: AbortSignal,
): Promise<void> {
  if (remerge) {
    await ctx.db.tx((q) => remergeConversation(ctx, q, conversationId, userId));
  }
  const conv = await getConversationRow(ctx.db, userId, conversationId);
  if (conv?.status !== "processing") return;

  const utterances = await ctx.db.query<UtteranceRow>(
    "SELECT * FROM utterances WHERE conversation_id = $1 ORDER BY start_ms, id",
    [conv.id],
  );
  if (utterances.length === 0) {
    await finishWithoutNotes(ctx, conv, "Nothing was transcribed in this conversation.");
    return;
  }
  const { llm, embedding } = await resolveProvidersForUser(ctx, userId, ["llm", "embedding"]);
  if (!llm) {
    await finishWithoutNotes(ctx, conv, NO_LLM_DETAIL);
    return;
  }
  const pipeline = await getPipeline(ctx.db, userId);
  const known = await ctx.db.query<{ content: string }>(
    "SELECT content FROM memories WHERE user_id = $1 AND source_conversation_id = $2 ORDER BY created_at LIMIT 30",
    [userId, conv.id],
  );
  const header: TranscriptHeader = {
    startMs: conv.start_ms,
    endMs: conv.end_ms,
    sources: [...new Set(utterances.flatMap((u) => u.sources))],
    contexts: conv.contexts ?? [],
    knownMemories: known.map((k) => k.content),
  };
  const lines = formatTranscriptLines(
    utterances.map((u) => ({ startMs: u.start_ms, speaker: u.speaker, text: u.text })),
    conv.start_ms,
  );
  const opts = { language: pipeline.language, extractMemories: pipeline.extractMemories };
  const notes = await generateNotes(llm, header, lines, opts, signal);

  const cands: Candidate[] = [];
  if (pipeline.extractMemories) {
    const seen = new Set<string>();
    for (const m of notes.memories.slice(0, 30)) {
      const content = clean(m.content, 2000);
      const normalized = normalizeText(content);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      cands.push({
        kind: m.kind,
        content,
        importance: Math.min(5, Math.max(1, Math.round(m.importance))),
        subjects: cleanList(m.subjects, 20, 120),
        occurredAt: validInstant(m.occurredAt),
        normalized,
        vector: null,
      });
    }
  }
  await embedCandidates(ctx, embedding, cands, signal);

  const language =
    notes.language && zLanguage.safeParse(notes.language).success
      ? notes.language
      : (pipeline.language ?? null);
  const result = await ctx.db.tx(async (q) => {
    // Row lock: a concurrent merge (external PostgreSQL) must not slip in between check and write.
    const fresh = (
      await q.query<ConversationRow>(
        "SELECT * FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [conv.id, userId],
      )
    )[0];
    // The transcript changed while the model was thinking: a newer run will follow.
    if (fresh?.status !== "processing" || fresh.revision !== conv.revision) return null;
    const title = fresh.title_edited ? fresh.title : clean(notes.title, 200) || null;
    const notesMd = fresh.notes_edited ? fresh.notes : notes.notes.trim().slice(0, 100_000) || null;
    const summary = clean(notes.summary, 4000) || null;
    const topics = cleanList(notes.topics, 10, 80);
    const participants = cleanList(notes.participants, 30, 120);
    await q.query(
      `UPDATE conversations SET status = 'ready', status_detail = NULL, title = $2, summary = $3, notes = $4,
              decisions = $5::jsonb, participants = $6::jsonb, topics = $7::jsonb, language = $8,
              consolidated_revision = revision, search_text = $9, updated_at = $10
       WHERE id = $1`,
      [
        conv.id,
        title,
        summary,
        notesMd,
        json(cleanList(notes.decisions, 50, 1000)),
        json(participants),
        json(topics),
        language,
        conversationSearchText({ title, summary, notes: notesMd, topics, participants }),
        ctx.clock.now(),
      ],
    );
    await reconcileActionItems(ctx, q, fresh, notes.actionItems);
    const created = await storeMemories(ctx, q, fresh, cands, embedding?.model ?? null);
    await scheduleEmbed(ctx, q, userId);
    return created;
  });
  if (!result) return;
  await publishConversation(ctx, userId, conv.id);
  for (const m of result) ctx.bus.publish(userId, { type: "memory_created", memory: memoryDto(m) });
}

export const consolidateHandler: JobHandler = {
  async run(ctx, job, signal) {
    if (!job.user_id) return;
    await runConsolidate(
      ctx,
      job.user_id,
      String(job.payload.conversationId ?? ""),
      job.payload.remerge === true,
      signal,
    );
  },
  async onFailed(ctx, job, err) {
    if (!job.user_id) return;
    const conv = await getConversationRow(
      ctx.db,
      job.user_id,
      String(job.payload.conversationId ?? ""),
    );
    if (!conv) return;
    const detail = isProviderError(err)
      ? `The language model failed (${err.provider}: ${err.code}). The transcript is available; reprocess to try again.`
      : "Writing notes failed. The transcript is available; reprocess to try again.";
    await finishWithoutNotes(ctx, conv, detail);
  },
};
