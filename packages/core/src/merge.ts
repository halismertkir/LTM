import { type AudioSource, SOURCE_PRIORITY, type SpeakerHint } from "@ltm/protocol";
import { lcsLength, lcsMatchedMask, tokenize } from "./text.js";
import type { MergedUtterance, MergeOptions, RawSegment } from "./types.js";

/**
 * A loser segment whose words are missing from the winner's text in a run at least this
 * long (or overall below the similarity threshold) is not folded away: the winner did not
 * hear that part, so the segment stays in the transcript on its own. Shorter runs are
 * treated as recognition differences.
 */
const MAX_UNCOVERED_RUN = 3;
/** Short segments must overlap in real time by at least this share of the shorter one. */
const SHORT_MIN_OVERLAP_RATIO = 0.5;
/** Durations below this are rounded up when computing overlap ratios of short segments. */
const SHORT_MIN_DURATION_MS = 250;
/** Neutral value for streams whose recogniser reported no confidence. */
const NEUTRAL_CONFIDENCE = 0.5;

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
  idx: number;
  start: number;
  end: number;
  tokens: string[];
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

function prepare(segments: RawSegment[]): Seg[] {
  const list: Seg[] = [];
  for (const raw of segments) {
    if (raw.text.trim() === "") continue;
    if (!Number.isFinite(raw.startMs) || !Number.isFinite(raw.endMs)) continue;
    const start = Math.min(raw.startMs, raw.endMs);
    const end = Math.max(raw.startMs, raw.endMs);
    list.push({
      raw,
      idx: 0,
      start,
      end,
      tokens: tokenize(raw.text),
      speaker: effectiveSpeaker(raw),
    });
  }
  list.sort(cmpSeg);
  // A re-delivered segment can show up twice; the id is the identity.
  const seen = new Set<string>();
  const out: Seg[] = [];
  for (const s of list) {
    if (seen.has(s.raw.id)) continue;
    seen.add(s.raw.id);
    s.idx = out.length;
    out.push(s);
  }
  return out;
}

/**
 * The tokens of `seg` estimated (linearly by time) to have been spoken inside
 * [from, to]. Recognisers rarely give word timings, and this keeps a short segment from
 * matching common words somewhere far away inside a long one.
 */
function tokensInWindow(seg: Seg, from: number, to: number): string[] {
  const n = seg.tokens.length;
  const dur = seg.end - seg.start;
  if (n === 0) return [];
  if (dur <= 0 || (from <= seg.start && to >= seg.end)) return seg.tokens;
  const a = Math.floor(((from - seg.start) / dur) * n);
  const b = Math.ceil(((to - seg.start) / dur) * n);
  return seg.tokens.slice(Math.max(0, a), Math.min(n, b));
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

function linked(a: Seg, b: Seg, o: Resolved): boolean {
  if (a.raw.streamId === b.raw.streamId) return false;
  if (a.tokens.length === 0 || b.tokens.length === 0) return false;
  const tol = o.clockToleranceMs;
  if (b.start >= a.end + tol || a.start >= b.end + tol) return false;
  const [short, long] = a.tokens.length <= b.tokens.length ? [a, b] : [b, a];

  if (short.tokens.length < o.minTokensForLooseMatch) {
    // "yes", "ok", "evet": nearly everyone says them, so only glue them together when
    // they were heard at the same moment, say the same thing, and no hint says that
    // two different people were speaking.
    if (speakersConflict(a.speaker, b.speaker)) return false;
    const ov = overlapMs(a, b);
    const minDur = Math.max(SHORT_MIN_DURATION_MS, Math.min(a.end - a.start, b.end - b.start));
    if (ov < SHORT_MIN_OVERLAP_RATIO * minDur) return false;
    if (long.tokens.length < o.minTokensForLooseMatch) return sameTokens(short.tokens, long.tokens);
    const window = tokensInWindow(long, short.start - minDur, short.end + minDur);
    return lcsLength(short.tokens, window) === short.tokens.length;
  }

  const window = tokensInWindow(long, short.start - tol, short.end + tol);
  return lcsLength(short.tokens, window) / short.tokens.length >= o.similarityThreshold;
}

class UnionFind {
  private readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r]!;
    while (this.parent[x] !== r) {
      const next = this.parent[x]!;
      this.parent[x] = r;
      x = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    // Smaller index as root keeps component identity independent of edge order.
    if (ra < rb) this.parent[rb] = ra;
    else if (rb < ra) this.parent[ra] = rb;
  }
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

/** Did the winning stream hear (roughly) everything this loser segment contains? */
function coveredBy(loser: Seg, winnerStream: Seg[], o: Resolved): boolean {
  const n = loser.tokens.length;
  if (n === 0) return true;
  const tol = o.clockToleranceMs;
  const from = loser.start - tol;
  const to = loser.end + tol;
  const near: string[] = [];
  for (const w of winnerStream) {
    if (w.end <= from || w.start >= to) continue;
    for (const t of tokensInWindow(w, from, to)) near.push(t);
  }
  if (near.length === 0) return false;
  const mask = lcsMatchedMask(loser.tokens, near);
  let matched = 0;
  let run = 0;
  let longestRun = 0;
  for (const m of mask) {
    if (m) {
      matched++;
      run = 0;
    } else {
      run++;
      longestRun = Math.max(longestRun, run);
    }
  }
  if (n < o.minTokensForLooseMatch) return matched === n;
  return matched / n >= o.similarityThreshold && longestRun < MAX_UNCOVERED_RUN;
}

interface Group {
  winnerStreamId: string;
  winners: Seg[];
  losers: Seg[];
  /** Stream ids ordered by rank, winner first. */
  streamOrder: string[];
}

function connectedComponents(nodes: number[], adj: number[][], alive: Uint8Array): number[][] {
  const seen = new Set<number>();
  const comps: number[][] = [];
  for (const start of nodes) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const x = stack.pop()!;
      comp.push(x);
      for (const y of adj[x]!) {
        if (alive[y] && !seen.has(y)) {
          seen.add(y);
          stack.push(y);
        }
      }
    }
    comp.sort((a, b) => a - b);
    comps.push(comp);
  }
  return comps;
}

/**
 * Resolves one cluster into groups. The winning stream absorbs the segments it covers;
 * segments it does not cover (it missed that speech) are re-clustered among themselves,
 * so a sentence only the losers heard still comes out once rather than being dropped.
 */
function resolveCluster(
  cluster: number[],
  segs: Seg[],
  adj: number[][],
  alive: Uint8Array,
  o: Resolved,
): Group[] {
  const groups: Group[] = [];
  let pending = cluster;
  while (pending.length > 0) {
    const residual: number[] = [];
    for (const comp of connectedComponents(pending, adj, alive)) {
      const members = comp.map((i) => segs[i]!);
      const ranks = rankStreams(members);
      const winnerStreamId = ranks[0]!.streamId;
      const winners = members.filter((s) => s.raw.streamId === winnerStreamId);
      const losers: Seg[] = [];
      for (const s of members) {
        if (s.raw.streamId === winnerStreamId) continue;
        if (coveredBy(s, winners, o)) losers.push(s);
        else residual.push(s.idx);
      }
      for (const s of winners) alive[s.idx] = 0;
      for (const s of losers) alive[s.idx] = 0;
      const present = new Set([winnerStreamId, ...losers.map((s) => s.raw.streamId)]);
      groups.push({
        winnerStreamId,
        winners,
        losers,
        streamOrder: ranks.map((r) => r.streamId).filter((id) => present.has(id)),
      });
    }
    residual.sort((a, b) => a - b);
    pending = residual;
  }
  return groups;
}

interface Draft {
  winnerStreamId: string;
  speaker: SpeakerHint;
  start: number;
  end: number;
  winners: Seg[];
  losers: Seg[];
  streamOrder: string[];
}

/** One group can span a long time or a speaker change; cut it into utterance drafts. */
function splitGroup(g: Group, o: Resolved): Draft[] {
  const drafts: Draft[] = [];
  for (const w of g.winners) {
    const last = drafts[drafts.length - 1];
    if (
      last &&
      last.speaker === w.speaker &&
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
  }
  return drafts;
}

function cmpDraft(a: Draft, b: Draft): number {
  return (
    a.start - b.start ||
    a.end - b.end ||
    cmpStr(a.winnerStreamId, b.winnerStreamId) ||
    a.winners[0]!.idx - b.winners[0]!.idx
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
  const byRank = [...winners, ...losers].sort(
    (a, b) =>
      (streamRank.get(a.raw.streamId) ?? 1e9) - (streamRank.get(b.raw.streamId) ?? 1e9) ||
      cmpSeg(a, b),
  );
  const language = winners.find((s) => s.raw.language)?.raw.language;
  const out: MergedUtterance = {
    startMs: d.start,
    endMs: d.end,
    text: winners.map((s) => s.raw.text.trim()).join(" "),
    speaker: d.speaker,
    origin: first.raw.origin,
    segmentIds: [...winners, ...losers].map((s) => s.raw.id),
    deviceIds: uniq(byRank.map((s) => s.raw.deviceId)),
    sources: uniq(byRank.map((s) => s.raw.source as AudioSource)),
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
  const n = segs.length;
  if (n === 0) return [];

  const uf = new UnionFind(n);
  const adj: number[][] = segs.map(() => []);
  for (let i = 0; i < n; i++) {
    const a = segs[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = segs[j]!;
      // Sorted by start: once b starts after a's widened end, so does everything after it.
      if (b.start >= a.end + o.clockToleranceMs) break;
      if (linked(a, b, o)) {
        uf.union(i, j);
        adj[i]!.push(j);
        adj[j]!.push(i);
      }
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    const list = clusters.get(r);
    if (list) list.push(i);
    else clusters.set(r, [i]);
  }

  const alive = new Uint8Array(n).fill(1);
  const drafts: Draft[] = [];
  for (const cluster of clusters.values()) {
    for (const g of resolveCluster(cluster, segs, adj, alive, o)) drafts.push(...splitGroup(g, o));
  }
  drafts.sort(cmpDraft);

  const joined: Draft[] = [];
  for (const d of drafts) {
    const last = joined[joined.length - 1];
    if (last && canJoin(last, d, o)) {
      last.winners.push(...d.winners);
      last.losers.push(...d.losers);
      last.end = Math.max(last.end, d.end);
      last.streamOrder = uniq([...last.streamOrder, ...d.streamOrder]);
    } else {
      joined.push({ ...d, winners: [...d.winners], losers: [...d.losers] });
    }
  }
  return joined.map(toUtterance);
}
