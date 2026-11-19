/**
 * Language-agnostic text comparison used by the multi-device merge.
 *
 * The normalised form is for *comparison only* — it is never shown to anyone — so it
 * deliberately folds distinctions that speech recognisers disagree on:
 *
 * - NFKC, then case folding without locale tables (`toLowerCase()`, not
 *   `toLocaleLowerCase()`), so the result does not depend on the host's locale.
 * - Turkish dotted/dotless i: `İ`, `I`, `ı` and `i` all become `i`. Default lower-casing
 *   turns `İ` into `i` + U+0307 (combining dot) and leaves `ı` alone, so "İstanbul",
 *   "ISTANBUL" and "istanbul" would otherwise not compare equal. Folding all four loses
 *   the ı/i contrast (e.g. "kır"/"kir"), which costs at most one token of similarity in
 *   the rare case it matters, while recognisers that emit upper case or drop the dot are
 *   common.
 * - Apostrophes inside a word are removed ("İstanbul'da" → "istanbulda", "don't" → see
 *   below), because recognisers disagree on whether to write Turkish suffix apostrophes.
 * - A few unambiguous English contractions are expanded ("I'm" → "i am", "can't" →
 *   "can not") so that "I'm fine" and "I am fine" tokenise identically. Ambiguous ones
 *   ("'s", "'d") are left alone.
 * - Thousands/decimal separators between digits are removed ("1,000" → "1000",
 *   "3.5" → "35"); every other non-letter/non-digit becomes a space.
 */

const APOSTROPHES = "'’ʼ‘`´";
const APOS_CLASS = `[${APOSTROPHES}]`;

// `\b` is ASCII-only even with the `u` flag, hence explicit Unicode look-arounds.
const START = "(?<![\\p{L}\\p{N}])";
const END = "(?![\\p{L}\\p{N}])";
const CONTRACTIONS: Array<[RegExp, string]> = [
  [new RegExp(`${START}can${APOS_CLASS}t${END}`, "gu"), "can not"],
  [new RegExp(`${START}won${APOS_CLASS}t${END}`, "gu"), "will not"],
  [new RegExp(`${START}shan${APOS_CLASS}t${END}`, "gu"), "shall not"],
  [new RegExp(`(\\p{L})n${APOS_CLASS}t${END}`, "gu"), "$1 not"],
  [new RegExp(`${START}i${APOS_CLASS}m${END}`, "gu"), "i am"],
  [new RegExp(`(\\p{L})${APOS_CLASS}re${END}`, "gu"), "$1 are"],
  [new RegExp(`(\\p{L})${APOS_CLASS}ll${END}`, "gu"), "$1 will"],
  [new RegExp(`(\\p{L})${APOS_CLASS}ve${END}`, "gu"), "$1 have"],
];

const INNER_APOSTROPHE = new RegExp(`(?<=[\\p{L}\\p{N}])${APOS_CLASS}+(?=[\\p{L}\\p{N}])`, "gu");
const DIGIT_SEPARATOR = /(?<=\p{N})[.,](?=\p{N})/gu;
const NON_WORD = /[^\p{L}\p{N}\p{M}]+/gu;
const DOTTED_I = /[İIı]/gu;
const COMBINING_DOT_ABOVE = /̇/gu;

export function normalizeText(text: string): string {
  let s = text.normalize("NFKC").replace(DOTTED_I, "i").toLowerCase();
  // Any remaining U+0307 is a decomposed "İ" or a stray dot; neither carries meaning here.
  s = s.replace(COMBINING_DOT_ABOVE, "");
  for (const [re, replacement] of CONTRACTIONS) s = s.replace(re, replacement);
  s = s.replace(INNER_APOSTROPHE, "").replace(DIGIT_SEPARATOR, "").replace(NON_WORD, " ");
  return s.trim().replace(/\s+/gu, " ");
}

export function tokenize(text: string): string[] {
  const n = normalizeText(text);
  return n === "" ? [] : n.split(" ");
}

/**
 * Above this many DP cells (n·m) the exact LCS is replaced by a greedy in-order match,
 * which is a lower bound. Merge inputs are a few hundred tokens at most; this only
 * guards against pathological inputs (e.g. a whole hour transcribed as one segment).
 */
export const LCS_MAX_CELLS = 4_000_000;

function intern(a: readonly string[], b: readonly string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const map = (xs: readonly string[]) => {
    const out = new Int32Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      const t = xs[i]!;
      let id = ids.get(t);
      if (id === undefined) {
        id = ids.size;
        ids.set(t, id);
      }
      out[i] = id;
    }
    return out;
  };
  return [map(a), map(b)];
}

/** Greedy in-order matching of `a` against `b`; returns the matched indices of `a`. */
function greedyMatch(a: Int32Array, b: Int32Array): boolean[] {
  const positions = new Map<number, number[]>();
  for (let j = 0; j < b.length; j++) {
    const list = positions.get(b[j]!);
    if (list) list.push(j);
    else positions.set(b[j]!, [j]);
  }
  const matched = new Array<boolean>(a.length).fill(false);
  let last = -1;
  for (let i = 0; i < a.length; i++) {
    const list = positions.get(a[i]!);
    if (!list) continue;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]! <= last) lo = mid + 1;
      else hi = mid;
    }
    if (lo < list.length) {
      last = list[lo]!;
      matched[i] = true;
    }
  }
  return matched;
}

export function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const [x, y] = intern(a, b);
  if (x.length * y.length > LCS_MAX_CELLS) {
    return greedyMatch(x, y).filter(Boolean).length;
  }
  let prev = new Int32Array(y.length + 1);
  let cur = new Int32Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    const xi = x[i - 1]!;
    for (let j = 1; j <= y.length; j++) {
      cur[j] = xi === y[j - 1]! ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[y.length]!;
}

/**
 * Which tokens of `a` take part in one longest common subsequence with `b`.
 * Used to find runs of content that one device heard and another did not.
 */
export function lcsMatchedMask(a: readonly string[], b: readonly string[]): boolean[] {
  const matched = new Array<boolean>(a.length).fill(false);
  if (a.length === 0 || b.length === 0) return matched;
  const [x, y] = intern(a, b);
  if (x.length * y.length > LCS_MAX_CELLS) return greedyMatch(x, y);
  const w = y.length + 1;
  const dp = new Int32Array((x.length + 1) * w);
  for (let i = 1; i <= x.length; i++) {
    const xi = x[i - 1]!;
    for (let j = 1; j <= y.length; j++) {
      dp[i * w + j] =
        xi === y[j - 1]!
          ? dp[(i - 1) * w + j - 1]! + 1
          : Math.max(dp[(i - 1) * w + j]!, dp[i * w + j - 1]!);
    }
  }
  let i = x.length;
  let j = y.length;
  while (i > 0 && j > 0) {
    if (x[i - 1] === y[j - 1]) {
      matched[i - 1] = true;
      i--;
      j--;
    } else if (dp[(i - 1) * w + j]! >= dp[i * w + j - 1]!) {
      i--;
    } else {
      j--;
    }
  }
  return matched;
}

/** Share of the shorter sequence found, in order, in the longer one. */
export function containment(a: readonly string[], b: readonly string[]): number {
  const min = Math.min(a.length, b.length);
  if (min === 0) return 0;
  return lcsLength(a, b) / min;
}

/** Dice-style similarity on tokens: 2·LCS / (|a| + |b|). */
export function textSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  return (2 * lcsLength(ta, tb)) / (ta.length + tb.length);
}
