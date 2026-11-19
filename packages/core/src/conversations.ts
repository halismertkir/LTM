import type { ConversationSlice, SplitOptions } from "./types.js";

/** A session longer than the cap is cut at the longest pause within this last share of it. */
const CUT_SEARCH_SHARE = 0.25;

interface Span {
  startMs: number;
  endMs: number;
}

function slice<T extends Span>(items: T[]): ConversationSlice<T> {
  let start = Infinity;
  let end = -Infinity;
  for (const it of items) {
    start = Math.min(start, it.startMs);
    end = Math.max(end, it.startMs, it.endMs);
  }
  return { startMs: start, endMs: end, items };
}

/** Cuts one gap-free run that is longer than `maxMs` into pieces of at most `maxMs`. */
function capDuration<T extends Span>(items: T[], maxMs: number, out: ConversationSlice<T>[]): void {
  let rest = items;
  while (rest.length > 0) {
    const start = rest[0]!.startMs;
    let end = -Infinity;
    for (const it of rest) end = Math.max(end, it.endMs);
    if (end - start <= maxMs || rest.length === 1) {
      out.push(slice(rest));
      return;
    }
    // Candidate cut after index k: the piece [0..k] must fit under the cap; prefer the
    // longest pause among cuts in the last quarter, otherwise the latest cut that fits.
    let best = -1;
    let bestGap = -Infinity;
    let latestFitting = -1;
    let runEnd = -Infinity;
    for (let k = 0; k < rest.length - 1; k++) {
      runEnd = Math.max(runEnd, rest[k]!.endMs);
      if (runEnd - start > maxMs) break;
      latestFitting = k;
      if (runEnd - start >= maxMs * (1 - CUT_SEARCH_SHARE)) {
        const gap = rest[k + 1]!.startMs - runEnd;
        if (gap >= bestGap) {
          bestGap = gap;
          best = k;
        }
      }
    }
    const cut = best >= 0 ? best : Math.max(0, latestFitting);
    out.push(slice(rest.slice(0, cut + 1)));
    rest = rest.slice(cut + 1);
  }
}

/**
 * Groups time-stamped items into conversations: a silence longer than `gapMs` ends one,
 * and a conversation never exceeds `maxDurationMs` unless a single item does.
 * Items may overlap; the result is ordered by time and each slice's items by start.
 */
export function splitConversations<T extends { startMs: number; endMs: number }>(
  items: T[],
  options?: SplitOptions,
): ConversationSlice<T>[] {
  const gapMs = Math.max(0, options?.gapMs ?? 5 * 60_000);
  const maxMs = Math.max(1, options?.maxDurationMs ?? 4 * 3_600_000);
  const sorted = items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => a.item.startMs - b.item.startMs || a.item.endMs - b.item.endMs || a.i - b.i)
    .map((x) => x.item);

  const out: ConversationSlice<T>[] = [];
  let run: T[] = [];
  let runEnd = -Infinity;
  for (const it of sorted) {
    if (run.length > 0 && it.startMs - runEnd > gapMs) {
      capDuration(run, maxMs, out);
      run = [];
      runEnd = -Infinity;
    }
    run.push(it);
    runEnd = Math.max(runEnd, it.endMs);
  }
  if (run.length > 0) capDuration(run, maxMs, out);
  return out;
}
