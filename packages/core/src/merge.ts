import { type AudioSource, SOURCE_PRIORITY, type SpeakerHint } from "@ltm/protocol";
import { lcsAlignment, lcsLength, tokenize } from "./text.js";
import type { MergedUtterance, MergeOptions, RawSegment } from "./types.js";

/**
 * A run of at least this many consecutive tokens of a losing segment that the winning
 * stream did not hear is real content, not a recognition difference: it must survive.
 */
const MAX_UNCOVERED_RUN = 3;
/** A linked segment needs at least this many matched tokens to fall inside another one. */
const MIN_TOKENS_PER_LINK = 2;
/** Short segments must overlap in real time by at least this share of the shorter one. */
const SHORT_MIN_OVERLAP_RATIO = 0.5;
/** Durations below this are rounded up when computing overlap ratios of short segments. */
const SHORT_MIN_DURATION_MS = 250;
/** Neutral value for streams whose recogniser reported no confidence. */
const NEUTRAL_CONFIDENCE = 0.5;
/** Each resolution pass consumes at least one segment; this only bounds pathological input. */
const MAX_PASSES = 64;

interface Resolved {
  clockToleranceMs: number;
  similarityThreshold: number;
  minTokensForLooseMatch: number;
  joinGapMs: number;
  maxUtteranceMs: number;
}

function resolveOptions(o: MergeOptions | undefined): Resolved {
  return {
    clockToleranceMs: Math.max(0, o?.clockToleranceMs ?? 2500),
    similarityThreshold: Math.min(1, Math.max(0, o?.similarityThreshold ?? 0.6)),
    minTokensForLooseMatch: Math.max(0, o?.minTokensForLooseMatch ?? 3),
    joinGapMs: Math.max(0, o?.joinGapMs ?? 1200),
    maxUtteranceMs: Math.max(1, o?.maxUtteranceMs ?? 30000),
  };
}

interface Seg {
  raw: RawSegment;
  start: number;
  end: number;
  tokens: string[];
  /** Index into `words` of the word each token came from. */
  tokenWord: number[];
  /** The original text split on whitespace, used to cut out an unheard remainder. */
  words: string[];
  speaker: SpeakerHint;
}

export function effectiveSpeaker(segment: Pick<RawSegment, "speaker" | "source">): SpeakerHint {
  if (segment.speaker) return segment.speaker;
  return segment.source === "tab" || segment.source === "system" ? "other" : "unknown";
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpSeg(a: Seg, b: Seg): number {
  return (
    a.start - b.start ||
    a.end - b.end ||
    cmpStr(a.raw.streamId, b.raw.streamId) ||
    cmpStr(a.raw.id, b.raw.id) ||
    cmpStr(a.raw.text, b.raw.text)
  );
}

/**
 * Tokenises word by word so every token knows the word it came from. Normalisation never
 * joins separate words, so this yields the same tokens as tokenising the whole text.
 */
function makeSeg(raw: RawSegment, start: number, end: number): Seg {
  const words = raw.text.trim().split(/\s+/u).filter(Boolean);
  const tokens: string[] = [];
  const tokenWord: number[] = [];
  words.forEach((w, wi) => {
    for (const t of tokenize(w)) {
      tokens.push(t);
      tokenWord.push(wi);
    }
  });
  return { raw, start, end, tokens, tokenWord, words, speaker: effectiveSpeaker(raw) };
}

function prepare(segments: RawSegment[]): Seg[] {
  const list: Seg[] = [];
  for (const raw of segments) {
    if (raw.text.trim() === "") continue;
    if (!Number.isFinite(raw.startMs) || !Number.isFinite(raw.endMs)) continue;
    list.push(makeSeg(raw, Math.min(raw.startMs, raw.endMs), Math.max(raw.startMs, raw.endMs)));
  }
  list.sort(cmpSeg);
  // A re-delivered segment can show up twice; the id is the identity.
  const seen = new Set<string>();
  return list.filter((s) => {
    if (seen.has(s.raw.id)) return false;
    seen.add(s.raw.id);
    return true;
  });
}

/**
 * Index range of the tokens of `seg` estimated (linearly by time) to have been spoken
 * inside [from, to]. Recognisers rarely give word timings; the crop keeps a segment from
 * matching common words far away inside a long one.
 */
function tokenRange(seg: Seg, from: number, to: number): [number, number] {
  const n = seg.tokens.length;
  const dur = seg.end - seg.start;
  if (n === 0 || dur <= 0 || (from <= seg.start && to >= seg.end)) return [0, n];
  const a = Math.floor(((from - seg.start) / dur) * n);
  const b = Math.ceil(((to - seg.start) / dur) * n);
  return [Math.max(0, Math.min(n, a)), Math.max(0, Math.min(n, b))];
}

function tokensInWindow(seg: Seg, from: number, to: number): string[] {
  const [a, b] = tokenRange(seg, from, to);
  return seg.tokens.slice(a, b);
}

interface LocalText {
  tokens: string[];
  /** Which segment each token belongs to. */
  owner: Seg[];
}

/**
 * What another stream heard around `seg`: its segments overlapping seg's time range
 * widened by the clock tolerance, concatenated in time order and cropped to that range.
 * Comparing against this instead of one segment at a time is what makes different cut
 * points line up (a segment straddling two of the other stream's segments).
 */
function localText(seg: Seg, others: Seg[], tol: number): LocalText {
  const from = seg.start - tol;
  const to = seg.end + tol;
  const tokens: string[] = [];
  const owner: Seg[] = [];
  for (const o of others) {
    if (o.end <= from || o.start >= to) continue;
    for (const t of tokensInWindow(o, from, to)) {
      tokens.push(t);
      owner.push(o);
    }
  }
  return { tokens, owner };
}

function overlapMs(a: Seg, b: Seg): number {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

function speakersConflict(a: SpeakerHint, b: SpeakerHint): boolean {
  return a !== "unknown" && b !== "unknown" && a !== b;
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

function isShort(s: Seg, o: Resolved): boolean {
  return s.tokens.length < o.minTokensForLooseMatch;
}

/**
 * "yes", "ok", "evet": nearly everyone says them, so a short segment is only glued to
 * another stream's segment when both were heard at the same moment, say the same thing,
 * and no hint says that two different people were speaking.
 */
function shortLinked(short: Seg, other: Seg, o: Resolved): boolean {
  if (short.tokens.length === 0 || other.tokens.length === 0) return false;
  if (speakersConflict(short.speaker, other.speaker)) return false;
  const minDur = Math.max(
    SHORT_MIN_DURATION_MS,
    Math.min(short.end - short.start, other.end - other.start),
  );
  if (overlapMs(short, other) < SHORT_MIN_OVERLAP_RATIO * minDur) return false;
  if (isShort(other, o)) return sameTokens(short.tokens, other.tokens);
  const window = tokensInWindow(other, short.start - minDur, short.end + minDur);
  return lcsLength(short.tokens, window) === short.tokens.length;
}

interface StreamIndex {
  /** Segments of each stream, in time order. */
  byStream: Map<string, Seg[]>;
  /** Longest segment duration per stream, to bound the search for overlaps. */
  maxDur: Map<string, number>;
  streamIds: string[];
}

function indexStreams(segs: Seg[]): StreamIndex {
  const byStream = new Map<string, Seg[]>();
  const maxDur = new Map<string, number>();
  for (const s of segs) {
    const id = s.raw.streamId;
    const list = byStream.get(id);
    if (list) list.push(s);
    else byStream.set(id, [s]);
    maxDur.set(id, Math.max(maxDur.get(id) ?? 0, s.end - s.start));
  }
  for (const list of byStream.values()) list.sort(cmpSeg);
  return { byStream, maxDur, streamIds: [...byStream.keys()].sort(cmpStr) };
}

/** Segments of one stream overlapping the open interval (from, to), in time order. */
function overlapping(index: StreamIndex, streamId: string, from: number, to: number): Seg[] {
  const list = index.byStream.get(streamId) ?? [];
  const earliest = from - (index.maxDur.get(streamId) ?? 0);
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.start < earliest) lo = mid + 1;
    else hi = mid;
  }
  const out: Seg[] = [];
  for (let i = lo; i < list.length && list[i]!.start < to; i++) {
    if (list[i]!.end > from) out.push(list[i]!);
  }
  return out;
}

/** Same-speech links between segments of different streams within `pool`. */
function computeLinks(pool: Seg[], o: Resolved): Map<Seg, Set<Seg>> {
  const tol = o.clockToleranceMs;
  const links = new Map<Seg, Set<Seg>>(pool.map((s) => [s, new Set<Seg>()]));
  const link = (a: Seg, b: Seg) => {
    links.get(a)!.add(b);
    links.get(b)!.add(a);
  };
  const index = indexStreams(pool);
  for (const s of pool) {
    if (s.tokens.length === 0) continue;
    for (const streamId of index.streamIds) {
      if (streamId === s.raw.streamId) continue;
      const near = overlapping(index, streamId, s.start - tol, s.end + tol).filter(
        (t) => t.tokens.length > 0,
      );
      if (near.length === 0) continue;
      if (isShort(s, o)) {
        for (const t of near) if (shortLinked(s, t, o)) link(s, t);
        continue;
      }
      // Short segments of the other stream link only through their own strict rule.
      const local = localText(
        s,
        near.filter((t) => !isShort(t, o)),
        tol,
      );
      const pairs = lcsAlignment(s.tokens, local.tokens);
      if (pairs.length / s.tokens.length < o.similarityThreshold) continue;
      const hits = new Map<Seg, number>();
      for (const [, j] of pairs) {
        const t = local.owner[j]!;
        hits.set(t, (hits.get(t) ?? 0) + 1);
      }
      for (const [t, count] of hits) if (count >= MIN_TOKENS_PER_LINK) link(s, t);
    }
  }
  return links;
}

function components(pool: Seg[], links: Map<Seg, Set<Seg>>): Seg[][] {
  const seen = new Set<Seg>();
  const out: Seg[][] = [];
  for (const start of pool) {
    if (seen.has(start)) continue;
    const comp: Seg[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const x = stack.pop()!;
      comp.push(x);
      for (const y of links.get(x)!) {
        if (!seen.has(y)) {
          seen.add(y);
          stack.push(y);
        }
      }
    }
    comp.sort(cmpSeg);
    out.push(comp);
  }
  return out;
}

interface StreamRank {
  streamId: string;
  priority: number;
  confidence: number;
  tokens: number;
}

function rankStreams(members: Seg[]): StreamRank[] {
  const by = new Map<
    string,
    { priority: number; confSum: number; confN: number; tokens: number }
  >();
  for (const s of members) {
    const p =
      typeof s.raw.devicePriority === "number" && Number.isFinite(s.raw.devicePriority)
        ? s.raw.devicePriority
        : SOURCE_PRIORITY[s.raw.source];
    const e = by.get(s.raw.streamId) ?? { priority: -Infinity, confSum: 0, confN: 0, tokens: 0 };
    e.priority = Math.max(e.priority, p);
    if (typeof s.raw.confidence === "number" && Number.isFinite(s.raw.confidence)) {
      e.confSum += s.raw.confidence;
      e.confN++;
    }
    e.tokens += s.tokens.length;
    by.set(s.raw.streamId, e);
  }
  const ranks = [...by].map(([streamId, e]) => ({
    streamId,
    priority: e.priority,
    confidence: e.confN > 0 ? e.confSum / e.confN : NEUTRAL_CONFIDENCE,
    tokens: e.tokens,
  }));
  ranks.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.confidence - a.confidence ||
      b.tokens - a.tokens ||
      cmpStr(a.streamId, b.streamId),
  );
  return ranks;
}

type Coverage = { kind: "covered" } | { kind: "uncovered" } | { kind: "remainder"; seg: Seg };

/** The part of `seg` made of tokens [from, to), as a segment of its own. */
function cutOut(seg: Seg, from: number, to: number): Seg {
  const n = seg.tokens.length;
  const dur = seg.end - seg.start;
  const text = seg.words.slice(seg.tokenWord[from]!, seg.tokenWord[to - 1]! + 1).join(" ");
  const start = seg.start + (dur * from) / n;
  const end = seg.start + (dur * to) / n;
  return makeSeg({ ...seg.raw, text }, start, end);
}

/**
 * Did the winning stream hear what this losing segment contains? Checked against
 * everything the winner heard around it (its whole stream, not only the segments in the
 * same cluster), so a loser that straddles two of the winner's utterances is covered.
 * - covered: fold it into the winner's utterance;
 * - remainder: the winner heard all of it except one run of real content, which is cut
 *   out and survives on its own (the segment's id travels with it);
 * - uncovered: keep the whole segment.
 */
function coverage(loser: Seg, winnerStream: Seg[], o: Resolved): Coverage {
  const n = loser.tokens.length;
  if (n === 0) return { kind: "covered" };
  const local = localText(loser, winnerStream, o.clockToleranceMs);
  if (local.tokens.length === 0) return { kind: "uncovered" };
  const matched = new Array<boolean>(n).fill(false);
  for (const [i] of lcsAlignment(loser.tokens, local.tokens)) matched[i] = true;
  const hits = matched.filter(Boolean).length;
  if (isShort(loser, o)) return hits === n ? { kind: "covered" } : { kind: "uncovered" };

  const runs: Array<[number, number]> = [];
  for (let i = 0; i < n; ) {
    if (matched[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !matched[j]) j++;
    if (j - i >= MAX_UNCOVERED_RUN) runs.push([i, j]);
    i = j;
  }
  if (runs.length === 0)
    return hits / n >= o.similarityThreshold ? { kind: "covered" } : { kind: "uncovered" };
  if (runs.length === 1) {
    const [from, to] = runs[0]!;
    const rest = n - (to - from);
    // Only split when the rest is clearly the same speech; otherwise keep it whole.
    if (rest >= o.minTokensForLooseMatch && hits / rest >= o.similarityThreshold) {
      return { kind: "remainder", seg: cutOut(loser, from, to) };
    }
  }
  return { kind: "uncovered" };
}

interface Group {
  winnerStreamId: string;
  winners: Seg[];
  losers: Seg[];
  /** Stream ids ordered by rank, winner first. */
  streamOrder: string[];
}

/**
 * Resolves the pool in passes. Each pass links what is left, lets the best stream of
 * every linked component win, and folds in what that stream covers. Segments (or
 * remainders) it did not cover go to the next pass, where they are linked among
 * themselves — so speech only the losing devices heard still comes out exactly once.
 */
function resolve(all: Seg[], o: Resolved): Group[] {
  const full = indexStreams(all);
  const tol = o.clockToleranceMs;
  const groups: Group[] = [];
  let pool = all;
  for (let pass = 0; pool.length > 0; pass++) {
    if (pass >= MAX_PASSES) {
      for (const s of pool) {
        groups.push({
          winnerStreamId: s.raw.streamId,
          winners: [s],
          losers: [],
          streamOrder: [s.raw.streamId],
        });
      }
      break;
    }
    const next: Seg[] = [];
    for (const comp of components(pool, computeLinks(pool, o))) {
      const ranks = rankStreams(comp);
      const winnerStreamId = ranks[0]!.streamId;
      const winners = comp.filter((s) => s.raw.streamId === winnerStreamId);
      const losers: Seg[] = [];
      for (const s of comp) {
        if (s.raw.streamId === winnerStreamId) continue;
        const c = coverage(s, overlapping(full, winnerStreamId, s.start - tol, s.end + tol), o);
        if (c.kind === "covered") losers.push(s);
        else next.push(c.kind === "remainder" ? c.seg : s);
      }
      const present = new Set([winnerStreamId, ...losers.map((s) => s.raw.streamId)]);
      groups.push({
        winnerStreamId,
        winners,
        losers,
        streamOrder: ranks.map((r) => r.streamId).filter((id) => present.has(id)),
      });
    }
    next.sort(cmpSeg);
    pool = next;
  }
  return groups;
}

interface Draft {
  winnerStreamId: string;
  speaker: SpeakerHint;
  start: number;
  end: number;
  winners: Seg[];
  /** Covered segments of other streams; each raw segment is attributed to exactly one draft. */
  losers: Seg[];
  /**
   * Covered segments attributed to a sibling draft that also heard this draft's words —
   * a segment cut differently can corroborate several utterances but owns only one.
   */
  witnesses: Seg[];
  streamOrder: string[];
}

/** Share of a draft's tokens another device must have heard to count as corroborating it. */
const WITNESS_MIN_SHARE = 0.5;

function heardDraft(l: Seg, d: Draft, o: Resolved): boolean {
  if (l.end + o.clockToleranceMs <= d.start || d.end + o.clockToleranceMs <= l.start) return false;
  const tokens = d.winners.flatMap((w) => w.tokens);
  if (tokens.length === 0) return false;
  return lcsLength(l.tokens, tokens) >= Math.ceil(tokens.length * WITNESS_MIN_SHARE);
}

/**
 * One group can span a long time, a pause or a speaker change; cut it into utterance
 * drafts with the same rules as joining, so that speech the winner missed (kept as its
 * own utterance) can sit between them in time order.
 */
function splitGroup(g: Group, o: Resolved): Draft[] {
  const drafts: Draft[] = [];
  for (const w of g.winners) {
    const last = drafts[drafts.length - 1];
    if (
      last &&
      last.speaker === w.speaker &&
      w.start - last.end < o.joinGapMs &&
      Math.max(last.end, w.end) - last.start <= o.maxUtteranceMs
    ) {
      last.winners.push(w);
      last.end = Math.max(last.end, w.end);
    } else {
      drafts.push({
        winnerStreamId: g.winnerStreamId,
        speaker: w.speaker,
        start: w.start,
        end: w.end,
        winners: [w],
        losers: [],
        witnesses: [],
        streamOrder: g.streamOrder,
      });
    }
  }
  for (const l of g.losers) {
    let best = drafts[0]!;
    let bestScore = -Infinity;
    for (const d of drafts) {
      const ov = Math.min(d.end, l.end) - Math.max(d.start, l.start);
      const score = ov > 0 ? ov : -Math.abs((d.start + d.end) / 2 - (l.start + l.end) / 2) - 1e-9;
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    best.losers.push(l);
    for (const d of drafts) if (d !== best && heardDraft(l, d, o)) d.witnesses.push(l);
  }
  return drafts;
}

function cmpDraft(a: Draft, b: Draft): number {
  return (
    a.start - b.start ||
    a.end - b.end ||
    cmpStr(a.winnerStreamId, b.winnerStreamId) ||
    cmpSeg(a.winners[0]!, b.winners[0]!)
  );
}

function canJoin(a: Draft, b: Draft, o: Resolved): boolean {
  return (
    a.winnerStreamId === b.winnerStreamId &&
    a.speaker === b.speaker &&
    b.start - a.end < o.joinGapMs &&
    Math.max(a.end, b.end) - a.start <= o.maxUtteranceMs
  );
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function toUtterance(d: Draft): MergedUtterance {
  const winners = [...d.winners].sort(cmpSeg);
  const losers = [...d.losers].sort(cmpSeg);
  const first = winners[0]!;
  const streamRank = new Map(d.streamOrder.map((id, i) => [id, i]));
  const byRank = [...winners, ...losers, ...d.witnesses].sort(
    (a, b) =>
      (streamRank.get(a.raw.streamId) ?? 1e9) - (streamRank.get(b.raw.streamId) ?? 1e9) ||
      cmpSeg(a, b),
  );
  const language = winners.find((s) => s.raw.language)?.raw.language;
  // One entry per device, in rank order, with the source that device heard it through.
  const heardBy = new Map<string, AudioSource>();
  for (const s of byRank) {
    if (!heardBy.has(s.raw.deviceId)) heardBy.set(s.raw.deviceId, s.raw.source as AudioSource);
  }
  const out: MergedUtterance = {
    startMs: Math.round(d.start),
    endMs: Math.round(d.end),
    text: winners.map((s) => s.raw.text.trim()).join(" "),
    speaker: d.speaker,
    origin: first.raw.origin,
    segmentIds: [...winners, ...losers].map((s) => s.raw.id),
    deviceIds: [...heardBy.keys()],
    sources: [...heardBy.values()],
  };
  if (language) out.language = language;
  return out;
}

/**
 * Turns the raw segments of every device into one de-duplicated transcript.
 * Pure and deterministic: the output depends only on the set of input segments, not on
 * their order. See docs/ARCHITECTURE.md ("Multi-device merge").
 */
export function mergeSegments(segments: RawSegment[], options?: MergeOptions): MergedUtterance[] {
  const o = resolveOptions(options);
  const segs = prepare(segments);
  if (segs.length === 0) return [];

  const drafts: Draft[] = [];
  for (const g of resolve(segs, o)) drafts.push(...splitGroup(g, o));
  drafts.sort(cmpDraft);

  const joined: Draft[] = [];
  for (const d of drafts) {
    const last = joined[joined.length - 1];
    if (last && canJoin(last, d, o)) {
      last.winners.push(...d.winners);
      last.losers.push(...d.losers);
      last.witnesses.push(...d.witnesses);
      last.end = Math.max(last.end, d.end);
      last.streamOrder = uniq([...last.streamOrder, ...d.streamOrder]);
    } else {
      joined.push({
        ...d,
        winners: [...d.winners],
        losers: [...d.losers],
        witnesses: [...d.witnesses],
      });
    }
  }
  return joined.map(toUtterance);
}
