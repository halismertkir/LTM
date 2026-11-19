import { describe, expect, it } from "vitest";
import {
  containment,
  LCS_MAX_CELLS,
  lcsLength,
  lcsMatchedMask,
  normalizeText,
  textSimilarity,
  tokenize,
} from "../src/index.js";

describe("normalizeText / tokenize", () => {
  it("lower-cases, strips punctuation and collapses whitespace", () => {
    expect(normalizeText("  Hello,   World!!  How's it — going?\n")).toBe(
      "hello world hows it going",
    );
  });

  it("keeps digits and removes separators inside numbers", () => {
    expect(tokenize("Room 101, at 3.30 — costs 1,000 €")).toEqual([
      "room",
      "101",
      "at",
      "330",
      "costs",
      "1000",
    ]);
  });

  it("folds Turkish dotted and dotless i", () => {
    const forms = ["İstanbul", "istanbul", "ISTANBUL", "Istanbul", "ıstanbul"];
    for (const f of forms) expect(normalizeText(f)).toBe("istanbul");
    expect(normalizeText("İ")).not.toContain("̇");
    expect(normalizeText("i̇stanbul")).toBe("istanbul");
  });

  it("keeps other diacritics", () => {
    expect(tokenize("Şişli'de çay içtik, güzeldi.")).toEqual([
      "şişlide",
      "çay",
      "içtik",
      "güzeldi",
    ]);
  });

  it("removes apostrophes inside words (Turkish suffixes) and expands English contractions", () => {
    expect(tokenize("Ankara'dan geldim")).toEqual(tokenize("Ankaradan geldim"));
    expect(tokenize("I'm sure they're coming, I can't wait")).toEqual(
      tokenize("I am sure they are coming I can not wait"),
    );
    expect(tokenize("don’t")).toEqual(["do", "not"]);
  });

  it("applies NFKC", () => {
    expect(normalizeText("ﬁne ｆｕｌｌｗｉｄｔｈ")).toBe("fine fullwidth");
  });

  it("handles non-Latin scripts", () => {
    expect(tokenize("Привет, мир! 你好")).toEqual(["привет", "мир", "你好"]);
  });

  it("returns no tokens for empty or punctuation-only text", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(" ... !!! ")).toEqual([]);
  });
});

describe("LCS helpers", () => {
  it("computes LCS length", () => {
    expect(lcsLength(["a", "b", "c", "d"], ["a", "c", "d"])).toBe(3);
    expect(lcsLength(["a", "b"], ["c"])).toBe(0);
    expect(lcsLength([], ["a"])).toBe(0);
    expect(lcsLength(["x", "a", "y", "b"], ["a", "b", "x", "y"])).toBe(2);
  });

  it("marks the matched tokens", () => {
    expect(lcsMatchedMask(["hello", "big", "world"], ["hello", "world"])).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("containment uses the shorter sequence", () => {
    expect(
      containment(tokenize("hello how are you"), tokenize("hello how are you I am fine")),
    ).toBe(1);
    expect(containment([], ["a"])).toBe(0);
  });

  it("textSimilarity is 2·lcs/(|a|+|b|)", () => {
    expect(textSimilarity("a b c d", "a b c d")).toBe(1);
    expect(textSimilarity("a b c d", "a b")).toBeCloseTo((2 * 2) / 6);
    expect(textSimilarity("", "a")).toBe(0);
  });

  it("falls back to a bounded greedy match for pathological sizes", () => {
    const n = Math.ceil(Math.sqrt(LCS_MAX_CELLS)) + 10;
    const a = Array.from({ length: n }, (_, i) => `w${i % 50}`);
    const t = performance.now();
    const len = lcsLength(a, a);
    expect(len).toBe(n);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
