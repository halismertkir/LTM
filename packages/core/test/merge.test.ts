import type { AudioSource, SpeakerHint } from "@ltm/protocol";
import { describe, expect, it } from "vitest";
import { type MergedUtterance, mergeSegments, type RawSegment } from "../src/index.js";

const T0 = 1_700_000_000_000;

const STREAMS: Record<string, { deviceId: string; source: AudioSource }> = {
  tab: { deviceId: "laptop", source: "tab" },
  mic: { deviceId: "laptop", source: "mic" },
  phone: { deviceId: "phone", source: "mic" },
  watch: { deviceId: "watch", source: "ambient" },
};

let counter = 0;
function seg(
  stream: keyof typeof STREAMS,
  startSec: number,
  endSec: number,
  text: string,
  extra: Partial<RawSegment> = {},
): RawSegment {
  const s = STREAMS[stream]!;
  counter++;
  return {
    id: extra.id ?? `${stream}-${startSec}-${counter}`,
    streamId: stream,
    deviceId: s.deviceId,
    source: s.source,
    origin: "server_stt",
    startMs: T0 + startSec * 1000,
    endMs: T0 + endSec * 1000,
    text,
    ...extra,
  };
}

function texts(out: MergedUtterance[]): string[] {
  return out.map((u) => u.text);
}

function allIds(out: MergedUtterance[]): string[] {
  return out.flatMap((u) => u.segmentIds).sort();
}

function shuffled<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe("mergeSegments", () => {
  it("returns nothing for nothing and skips blank text", () => {
    expect(mergeSegments([])).toEqual([]);
    expect(mergeSegments([seg("tab", 0, 1, "   ")])).toEqual([]);
  });

  it("passes a single stream through, joining close segments", () => {
    const a = seg("mic", 0, 2, "hello there");
    const b = seg("mic", 2.5, 4, "how are you doing");
    const c = seg("mic", 10, 12, "much later");
    const out = mergeSegments([a, b, c]);
    expect(texts(out)).toEqual(["hello there how are you doing", "much later"]);
    expect(out[0]!.segmentIds).toEqual([a.id, b.id]);
    expect(out[0]!.speaker).toBe("unknown");
    expect(out[0]!.deviceIds).toEqual(["laptop"]);
  });

  it("de-duplicates the same sentence heard by two devices; tab wins over mic", () => {
    const tab = seg("tab", 10, 13, "Can you send me the report by Friday?");
    const mic = seg("phone", 10.3, 13.4, "can you send me the report by friday");
    const out = mergeSegments([mic, tab]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("Can you send me the report by Friday?");
    expect(out[0]!.segmentIds).toEqual([tab.id, mic.id]);
    expect(out[0]!.deviceIds).toEqual(["laptop", "phone"]);
    expect(out[0]!.sources).toEqual(["tab", "mic"]);
    expect(out[0]!.speaker).toBe("other");
    expect(out[0]!.startMs).toBe(tab.startMs);
  });

  it("handles different cut points: one long segment vs three short ones", () => {
    const long = seg("watch", 0, 9, "hello how are you I'm fine thanks and what about you");
    const b1 = seg("phone", 0.2, 2.5, "Hello, how are you?");
    const b2 = seg("phone", 3, 5, "I am fine, thanks.");
    const b3 = seg("phone", 5.5, 9, "And what about you?");
    const out = mergeSegments([long, b1, b2, b3]);
    expect(out).toHaveLength(1);
    // phone (mic) outranks watch (ambient); its three segments become one utterance.
    expect(out[0]!.text).toBe("Hello, how are you? I am fine, thanks. And what about you?");
    expect(out[0]!.segmentIds).toEqual([b1.id, b2.id, b3.id, long.id]);
    expect(out[0]!.deviceIds).toEqual(["phone", "watch"]);

    const flipped = mergeSegments(
      [long, b1, b2, b3].map((s) => (s.streamId === "watch" ? { ...s, devicePriority: 90 } : s)),
    );
    expect(texts(flipped)).toEqual(["hello how are you I'm fine thanks and what about you"]);
    expect(flipped[0]!.segmentIds[0]).toBe(long.id);
  });

  it("absorbs a loser that heard only part of what the winner heard", () => {
    const tab = seg("tab", 0, 5, "okay so the plan is that we ship on friday");
    const mic = seg("phone", 2.6, 5.1, "we ship on friday");
    const out = mergeSegments([tab, mic]);
    expect(texts(out)).toEqual(["okay so the plan is that we ship on friday"]);
    expect(out[0]!.segmentIds).toEqual([tab.id, mic.id]);
  });

  it("keeps a loser that heard more than the winner instead of dropping the extra speech", () => {
    const tab = seg("tab", 0, 2, "okay so the plan");
    const mic = seg("phone", 0.1, 5, "okay so the plan is that we ship on friday");
    const out = mergeSegments([tab, mic]);
    // Only the part the winner did not hear survives, so nothing is duplicated.
    expect(texts(out)).toEqual(["okay so the plan", "is that we ship on friday"]);
    expect(out[1]!.segmentIds).toEqual([mic.id]);
    expect(out[1]!.startMs).toBeGreaterThanOrEqual(out[0]!.startMs);
    expect(allIds(out)).toEqual([mic.id, tab.id].sort());
  });

  it("keeps a sentence that only a losing device heard as its own utterance", () => {
    const t1 = seg("tab", 0, 3, "let's review the budget for next quarter");
    const t2 = seg("tab", 7, 10, "and then we can talk about hiring");
    const m1 = seg("phone", 0.2, 3.1, "let's review the budget for next quarter");
    const m2 = seg("phone", 3.5, 6.5, "sorry my dog is barking give me a second");
    const m3 = seg("phone", 7.1, 10.2, "and then we can talk about hiring");
    const out = mergeSegments([t1, t2, m1, m2, m3]);
    expect(texts(out)).toEqual([
      "let's review the budget for next quarter",
      "sorry my dog is barking give me a second",
      "and then we can talk about hiring",
    ]);
    expect(out[1]!.segmentIds).toEqual([m2.id]);
    expect(out[1]!.deviceIds).toEqual(["phone"]);
    expect(out[1]!.speaker).toBe("unknown");
    expect(out[0]!.segmentIds).toEqual([t1.id, m1.id]);
    expect(out[2]!.segmentIds).toEqual([t2.id, m3.id]);
  });

  it("does not fold a loser segment into the winner when it carries a whole extra sentence", () => {
    const tab = seg("tab", 0, 2.5, "hello how are you");
    const mic = seg("phone", 0, 6, "hello how are you I wanted to ask about the invoice");
    const out = mergeSegments([tab, mic]);
    expect(texts(out)).toEqual(["hello how are you", "I wanted to ask about the invoice"]);
    expect(allIds(out)).toEqual([mic.id, tab.id].sort());
  });

  it("merges three devices into one utterance with the best source first", () => {
    const w = seg("watch", 20, 24, "we should book the flights tonight", { confidence: 0.9 });
    const p = seg("phone", 20.4, 24.2, "we should book the flight tonight", { confidence: 0.8 });
    const t = seg("tab", 19.9, 23.8, "We should book the flights tonight.", { confidence: 0.7 });
    const out = mergeSegments([w, p, t]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("We should book the flights tonight.");
    // Winner first, then the corroborating segments in time order.
    expect(out[0]!.segmentIds).toEqual([t.id, w.id, p.id]);
    expect(out[0]!.deviceIds).toEqual(["laptop", "phone", "watch"]);
    expect(out[0]!.sources).toEqual(["tab", "mic", "ambient"]);
  });

  it("tolerates ±2 s clock skew", () => {
    for (const skew of [-2, 2]) {
      const a = seg("phone", 30, 33, "the meeting moved to three thirty");
      const b = seg("watch", 30 + skew, 33 + skew, "the meeting moved to 3:30", {
        confidence: 0.4,
      });
      const out = mergeSegments([a, b]);
      expect(out, `skew ${skew}`).toHaveLength(1);
      expect(out[0]!.text).toBe("the meeting moved to three thirty");
    }
  });

  it("does not link beyond the clock tolerance", () => {
    const a = seg("phone", 0, 2, "the meeting moved to three thirty");
    const b = seg("watch", 5, 7, "the meeting moved to three thirty");
    expect(mergeSegments([a, b])).toHaveLength(2);
  });

  it("absorbs recognition differences: contractions, punctuation, casing, a wrong word", () => {
    const a = seg("tab", 0, 4, "I'm not sure we can't do it, honestly; maybe next week?");
    const b = seg("phone", 0.2, 4.1, "i am not sure we cannot do it honestly maybe next weak");
    const out = mergeSegments([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe(a.text);
  });

  it("never merges a repeated phrase said minutes apart", () => {
    const segs = [
      seg("tab", 0, 2, "sounds good to me"),
      seg("phone", 0.1, 2.1, "sounds good to me"),
      seg("tab", 180, 182, "sounds good to me"),
      seg("phone", 180.2, 182.1, "sounds good to me"),
    ];
    const out = mergeSegments(segs);
    expect(out).toHaveLength(2);
    expect(out[0]!.endMs).toBeLessThan(out[1]!.startMs);
    expect(out.every((u) => u.segmentIds.length === 2)).toBe(true);
  });

  it("keeps two different people saying 'yes' at the same time apart", () => {
    // The other party (tab) and the user (mic, labelled self) both answer.
    const other = seg("tab", 50, 50.4, "Yes.");
    const self = seg("phone", 50.1, 50.5, "yes", { speaker: "self" });
    const out = mergeSegments([other, self]);
    expect(out).toHaveLength(2);
    expect(out.map((u) => u.speaker).sort()).toEqual(["other", "self"]);
  });

  it("keeps short interjections apart when they are not at the same moment", () => {
    const a = seg("phone", 50, 50.4, "yes");
    const b = seg("watch", 51.2, 51.6, "yes");
    expect(mergeSegments([a, b])).toHaveLength(2);
  });

  it("merges a short interjection heard by two devices at the same moment", () => {
    const a = seg("phone", 50, 50.4, "Okay.");
    const b = seg("watch", 50.05, 50.45, "okay");
    const out = mergeSegments([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.segmentIds).toEqual([a.id, b.id]);
  });

  it("does not glue a short segment onto unrelated words inside a long one", () => {
    const long = seg(
      "tab",
      0,
      10,
      "so the thing is we need more time and the budget is not ready yet",
    );
    const short = seg("phone", 9, 9.5, "the thing");
    const out = mergeSegments([long, short]);
    expect(out).toHaveLength(2);
  });

  it("handles Turkish text, including İ/I and apostrophe differences", () => {
    const a = seg("tab", 0, 4, "İstanbul'a yarın sabah gidiyoruz, değil mi?");
    const b = seg("phone", 0.3, 4.2, "ISTANBULA yarın sabah gidiyoruz değil mi");
    const c = seg("watch", 0.1, 4, "istanbul'a yarin sabah gidiyoruz degil mi");
    const out = mergeSegments([a, b, c]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe(a.text);
    expect(out[0]!.segmentIds).toHaveLength(3);
  });

  it("does not link Turkish 'evet' from different people", () => {
    const a = seg("tab", 5, 5.3, "Evet.");
    const b = seg("phone", 5.05, 5.35, "evet", { speaker: "self" });
    expect(mergeSegments([a, b])).toHaveLength(2);
  });

  it("removes mic echo of call audio because the tab stream wins", () => {
    const tab = seg("tab", 0, 3, "can everyone see my screen");
    const echo = seg("mic", 0.15, 3.2, "can everyone see my screen", { speaker: "self" });
    const own = seg("mic", 4, 5.5, "yes I can see it", { speaker: "self" });
    const out = mergeSegments([tab, echo, own]);
    expect(texts(out)).toEqual(["can everyone see my screen", "yes I can see it"]);
    expect(out[0]!.speaker).toBe("other");
    expect(out[1]!.speaker).toBe("self");
  });

  it("never links segments of the same stream", () => {
    const a = seg("phone", 0, 2, "testing one two three", { id: "a" });
    const b = seg("phone", 1, 3, "testing one two three", { id: "b" });
    const out = mergeSegments([a, b], { joinGapMs: 0 });
    // Overlapping segments of one stream are two things that stream heard: both stay.
    expect(out.map((u) => u.text).join(" ")).toBe("testing one two three testing one two three");
    expect(allIds(out)).toEqual(["a", "b"]);
  });

  it("does not join across speaker changes, joinGap or maxUtteranceMs", () => {
    const a = seg("phone", 0, 2, "first part here", { speaker: "self" });
    const b = seg("phone", 2.2, 4, "second part here", { speaker: "unknown" });
    expect(mergeSegments([a, b])).toHaveLength(2);

    const c = seg("phone", 0, 2, "first part here");
    const d = seg("phone", 4, 6, "second part here");
    expect(mergeSegments([c, d])).toHaveLength(2);
    expect(mergeSegments([c, d], { joinGapMs: 2500 })).toHaveLength(1);

    const many = Array.from({ length: 10 }, (_, i) =>
      seg("phone", i * 5, i * 5 + 4.5, `sentence number ${i} goes here`),
    );
    const out = mergeSegments(many, { maxUtteranceMs: 20000 });
    expect(out.length).toBeGreaterThan(1);
    for (const u of out) expect(u.endMs - u.startMs).toBeLessThanOrEqual(20000);
    expect(allIds(out)).toEqual(many.map((s) => s.id).sort());
  });

  it("does not join utterances when another stream spoke in between", () => {
    const a = seg("tab", 0, 2, "what do you think");
    const b = seg("phone", 2.1, 2.9, "I like it", { speaker: "self" });
    const c = seg("tab", 3, 5, "great let's do that");
    const out = mergeSegments([a, b, c]);
    expect(texts(out)).toEqual(["what do you think", "I like it", "great let's do that"]);
  });

  it("prefers higher confidence, then more tokens, then the lower stream id", () => {
    const a = seg("phone", 0, 3, "we will meet at the station", { confidence: 0.6 });
    const b = {
      ...seg("phone", 0.1, 3.1, "we will meet at the station tomorrow", { confidence: 0.9 }),
      streamId: "phone2",
      deviceId: "phone2",
    };
    expect(mergeSegments([a, b])[0]!.deviceIds[0]).toBe("phone2");

    const c = seg("phone", 0, 3, "we will meet at the station");
    const d = {
      ...seg("phone", 0.1, 3.1, "we will meet at the station"),
      streamId: "aaa",
      deviceId: "dev-aaa",
    };
    expect(mergeSegments([c, d])[0]!.deviceIds[0]).toBe("dev-aaa");
  });

  it("respects devicePriority overrides", () => {
    const tab = seg("tab", 0, 3, "we will meet at the station");
    const watch = seg("watch", 0.1, 3.1, "we will meet at the station", { devicePriority: 99 });
    const out = mergeSegments([tab, watch]);
    expect(out[0]!.deviceIds[0]).toBe("watch");
    expect(out[0]!.speaker).toBe("unknown");
  });

  it("never loses a segment id and is independent of input order", () => {
    const segs = [
      seg("tab", 0, 3, "good morning everyone"),
      seg("phone", 0.2, 3.3, "good morning everyone"),
      seg("watch", -0.5, 2.8, "good morning every one"),
      seg("phone", 3.6, 4, "yes"),
      seg("tab", 5, 9, "let's start with the quarterly numbers please"),
      seg("watch", 5.5, 7, "let's start with the"),
      seg("watch", 7.2, 9.4, "quarterly numbers please"),
      seg("phone", 9.8, 12, "I have a question about slide two"),
      seg("tab", 13, 14, "sure go ahead"),
      seg("watch", 120, 125, "completely unrelated later sentence"),
    ];
    const expected = mergeSegments(segs);
    expect(allIds(expected)).toEqual(segs.map((s) => s.id).sort());
    for (let k = 1; k <= 8; k++) {
      expect(mergeSegments(shuffled(segs, k))).toEqual(expected);
    }
    expect(mergeSegments(segs)).toEqual(expected);
    for (let i = 1; i < expected.length; i++) {
      expect(expected[i]!.startMs).toBeGreaterThanOrEqual(expected[i - 1]!.startMs);
    }
  });

  it("de-duplicates repeated delivery of the same segment id", () => {
    const a = seg("phone", 0, 2, "hello there");
    const out = mergeSegments([a, { ...a }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.segmentIds).toEqual([a.id]);
  });

  it("carries language and origin from the winner", () => {
    const a = seg("tab", 0, 3, "merhaba nasılsın bugün", { language: "tr", origin: "edge_stt" });
    const b = seg("phone", 0, 3, "merhaba nasılsın bugün", { language: "en" });
    const out = mergeSegments([a, b]);
    expect(out[0]!.language).toBe("tr");
    expect(out[0]!.origin).toBe("edge_stt");
  });

  it("derives speakers from the source unless the client gave one", () => {
    const speakers = (s: RawSegment): SpeakerHint => mergeSegments([s])[0]!.speaker;
    expect(speakers(seg("tab", 0, 1, "hi there you"))).toBe("other");
    expect(speakers({ ...seg("tab", 0, 1, "hi there you"), source: "system" })).toBe("other");
    expect(speakers(seg("watch", 0, 1, "hi there you"))).toBe("unknown");
    expect(speakers(seg("mic", 0, 1, "hi there you", { speaker: "self" }))).toBe("self");
  });
});

describe("mergeSegments with staggered cut points", () => {
  // Six sentences of six words, two seconds each, starting at T0 + 100 s.
  const S = [
    "good morning everyone thanks for joining",
    "today we review the quarterly budget",
    "marketing spent less than we planned",
    "engineering needs two more servers soon",
    "the vendor contract renews in march",
    "let us decide on hiring next week",
  ];
  const at = (i: number) => 100 + i * 2;

  /** One segment of `stream` covering the given sentence indices. */
  function cut(
    stream: keyof typeof STREAMS,
    idxs: number[],
    opts: { skew?: number; edit?: (text: string) => string; extra?: Partial<RawSegment> } = {},
  ): RawSegment {
    const text = idxs.map((i) => S[i]!).join(" ");
    const skew = opts.skew ?? 0;
    return seg(
      stream,
      at(idxs[0]!) + skew,
      at(idxs.at(-1)! + 1) + skew,
      opts.edit ? opts.edit(text) : text,
      opts.extra,
    );
  }

  function occurrences(out: MergedUtterance[], phrase: string): number {
    const all = out.map((u) => u.text).join(" | ");
    return all.split(phrase).length - 1;
  }

  function expectEachOnce(out: MergedUtterance[], sentences = S) {
    for (const sentence of sentences) expect(occurrences(out, sentence), sentence).toBe(1);
  }

  it("links a loser segment that straddles two winner segments (the reported case)", () => {
    const w1 = seg("tab", 0, 4, "hello everyone thanks for joining this is the budget review");
    const w2 = seg("tab", 4, 7.5, "so we agreed that the q3 budget is fifty thousand euros");
    const l = seg("watch", 2.6, 5.4, "this is the budget review we agreed the q3");
    const out = mergeSegments([w1, w2, l]);
    expect(texts(out)).toEqual([`${w1.text} ${w2.text}`]);
    expect(out[0]!.segmentIds).toEqual([w1.id, w2.id, l.id]);
    expect(out[0]!.deviceIds).toEqual(["laptop", "watch"]);
  });

  it("links a winner segment that straddles two loser segments (mirror case)", () => {
    const a1 = seg("watch", 0, 4, "hello everyone thanks for joining this is the budget review");
    const a2 = seg("watch", 4, 7.5, "we agreed the q3 budget is fifty thousand euros");
    const t0 = seg("tab", 0, 2, "hello everyone thanks for joining");
    const t1 = seg("tab", 2, 5, "this is the budget review we agreed the q3");
    const t2 = seg("tab", 5, 7.5, "budget is fifty thousand euros");
    const out = mergeSegments([a1, a2, t0, t1, t2]);
    expect(texts(out)).toEqual([`${t0.text} ${t1.text} ${t2.text}`]);
    expect(out[0]!.segmentIds).toEqual([t0.id, t1.id, t2.id, a1.id, a2.id]);
  });

  it("chains staggered cuts on both sides into one copy of every sentence", () => {
    const a = [cut("tab", [0, 1]), cut("tab", [2, 3]), cut("tab", [4, 5])];
    const b = [cut("phone", [0]), cut("phone", [1, 2]), cut("phone", [3, 4]), cut("phone", [5])];
    const out = mergeSegments([...a, ...b]);
    expectEachOnce(out);
    expect(out).toHaveLength(1);
    expect(out[0]!.segmentIds.slice(0, 3)).toEqual(a.map((x) => x.id));
    expect(allIds(out)).toEqual([...a, ...b].map((x) => x.id).sort());

    // The same with the other stream winning.
    const flipped = mergeSegments([...a, ...b.map((x) => ({ ...x, devicePriority: 99 }))]);
    expectEachOnce(flipped);
    expect(flipped[0]!.deviceIds[0]).toBe("phone");
  });

  it("handles staggered cuts with ±2 s clock skew and recognition differences", () => {
    const edit = (t: string) =>
      t
        .replace("quarterly", "quarterlies")
        .replace("servers", "server")
        .replace("march", "marsh")
        .replace("let us", "lets");
    for (const skew of [-2, 2]) {
      const a = [cut("tab", [0, 1]), cut("tab", [2, 3]), cut("tab", [4, 5])];
      const b = [
        cut("phone", [0], { skew, edit }),
        cut("phone", [1, 2], { skew, edit }),
        cut("phone", [3, 4], { skew, edit }),
        cut("phone", [5], { skew, edit }),
      ];
      const out = mergeSegments([...b, ...a]);
      expectEachOnce(out);
      expect(occurrences(out, "marsh"), `skew ${skew}`).toBe(0);
      expect(occurrences(out, "quarterlies")).toBe(0);
      expect(allIds(out)).toEqual([...a, ...b].map((x) => x.id).sort());
    }
  });

  it("merges three devices with staggered cuts", () => {
    const segs = [
      cut("tab", [0, 1, 2]),
      cut("tab", [3, 4, 5]),
      cut("phone", [0]),
      cut("phone", [1, 2]),
      cut("phone", [3, 4]),
      cut("phone", [5]),
      cut("watch", [0, 1], { skew: -1.5 }),
      cut("watch", [2, 3, 4], { skew: -1.5 }),
      cut("watch", [5], { skew: -1.5 }),
    ];
    const out = mergeSegments(segs);
    expectEachOnce(out);
    expect(out).toHaveLength(1);
    expect(out[0]!.deviceIds).toEqual(["laptop", "phone", "watch"]);
    expect(allIds(out)).toEqual(segs.map((x) => x.id).sort());
    for (let k = 1; k <= 5; k++) expect(mergeSegments(shuffled(segs, k))).toEqual(out);
  });

  it("keeps an extra sentence the losers heard in the middle exactly once", () => {
    const extra = "sorry my dog is barking again";
    // The tab stream did not hear the room: sentence 2 is missing there.
    const tab = [
      seg("tab", at(0), at(2), `${S[0]} ${S[1]}`),
      seg("tab", at(3), at(5), `${S[3]} ${S[4]}`),
    ];
    const phone = [
      cut("phone", [0]),
      seg("phone", at(1), at(4), `${S[1]} ${extra} ${S[3]}`),
      cut("phone", [4]),
    ];
    const out = mergeSegments([...tab, ...phone]);
    expectEachOnce(out, [S[0]!, S[1]!, S[3]!, S[4]!, extra]);
    expect(texts(out)).toEqual([`${S[0]} ${S[1]}`, extra, `${S[3]} ${S[4]}`]);
    expect(out[1]!.deviceIds).toEqual(["phone"]);
    expect(out[1]!.startMs).toBeGreaterThanOrEqual(T0 + at(2) * 1000 - 100);
    expect(out[1]!.endMs).toBeLessThanOrEqual(T0 + at(3) * 1000 + 100);
    expect(allIds(out)).toEqual([...tab, ...phone].map((x) => x.id).sort());

    // A second losing device that also heard it, cut differently: still once.
    const watch = [
      cut("watch", [0]),
      seg("watch", at(1), at(3), `${S[1]} ${extra}`),
      cut("watch", [3, 4]),
    ];
    const three = mergeSegments([...tab, ...phone, ...watch]);
    expectEachOnce(three, [S[0]!, S[1]!, S[3]!, S[4]!, extra]);
    const extraUtterance = three.find((u) => u.text === extra)!;
    expect(extraUtterance.deviceIds).toEqual(["phone", "watch"]);
    expect(allIds(three)).toEqual([...tab, ...phone, ...watch].map((x) => x.id).sort());
  });

  it("still keeps repeated staggered speech minutes apart separate", () => {
    const first = [cut("tab", [0, 1]), cut("phone", [0]), cut("phone", [1])];
    const later = [first[0]!, first[1]!, first[2]!].map((x, i) => ({
      ...x,
      id: `later-${i}`,
      startMs: x.startMs + 300_000,
      endMs: x.endMs + 300_000,
    }));
    const out = mergeSegments([...first, ...later]);
    expect(out).toHaveLength(2);
    for (const sentence of [S[0]!, S[1]!]) expect(occurrences(out, sentence)).toBe(2);
  });
});

describe("mergeSegments corroboration across a pause", () => {
  it("lists a device on every utterance it heard, while each raw segment is owned once", () => {
    const t0 = 1_000_000;
    const seg = (
      id: string,
      streamId: string,
      deviceId: string,
      source: "tab" | "ambient",
      startS: number,
      endS: number,
      text: string,
    ) => ({
      id,
      streamId,
      deviceId,
      source,
      origin: "server_stt" as const,
      startMs: t0 + startS * 1000,
      endMs: t0 + endS * 1000,
      text,
    });
    const out = mergeSegments([
      seg(
        "w1",
        "tab",
        "laptop",
        "tab",
        1,
        4,
        "hello everyone thanks for joining the budget review",
      ),
      seg("w2", "tab", "laptop", "tab", 6.5, 9.5, "we agreed the q3 budget is 120 thousand euros"),
      // One segment of the watch spans the pause between the two tab segments.
      seg(
        "a1",
        "amb",
        "watch",
        "ambient",
        2.8,
        11.1,
        "hello everyone thanks for joining the budget review we agreed the q3 budget is 120 thousand euros",
      ),
    ]);
    expect(out.map((u) => u.text)).toEqual([
      "hello everyone thanks for joining the budget review",
      "we agreed the q3 budget is 120 thousand euros",
    ]);
    for (const u of out) {
      expect(u.deviceIds).toEqual(["laptop", "watch"]);
      expect(u.sources).toEqual(["tab", "ambient"]);
    }
    const ids = out.flatMap((u) => u.segmentIds);
    expect([...ids].sort()).toEqual(["a1", "w1", "w2"]);
  });
});

describe("mergeSegments with a sentence tail cut into its own short segment", () => {
  const t0 = 1_000_000;
  const seg = (
    id: string,
    streamId: string,
    deviceId: string,
    source: "mic" | "ambient",
    startS: number,
    endS: number,
    text: string,
  ) => ({
    id,
    streamId,
    deviceId,
    source,
    origin: "server_stt" as const,
    startMs: t0 + startS * 1000,
    endMs: t0 + endS * 1000,
    text,
  });
  const desk = seg(
    "m1",
    "mic",
    "desk",
    "mic",
    0,
    6,
    "Yarın sabah ilk iş olarak sözleşme taslağını avukata göndereceğim.",
  );

  it("folds a two-word tail heard slightly later by another device into the sentence", () => {
    const out = mergeSegments([
      desk,
      seg(
        "w1",
        "watch",
        "watch",
        "ambient",
        1.4,
        5.6,
        "yarın sabah ilk iş olarak sözleşme taslağını",
      ),
      // The watch's recogniser split the tail off; its clock runs 1.6 s ahead.
      seg("w2", "watch", "watch", "ambient", 6.3, 7.6, "avukata göndereceğim."),
    ]);
    expect(out.map((u) => u.text)).toEqual([desk.text]);
    expect(out[0]!.deviceIds).toEqual(["desk", "watch"]);
    expect([...out[0]!.segmentIds].sort()).toEqual(["m1", "w1", "w2"]);
  });

  it("keeps the same two words when they are said well outside the clock tolerance", () => {
    const out = mergeSegments([
      desk,
      seg("w2", "watch", "watch", "ambient", 20, 21.2, "avukata göndereceğim."),
    ]);
    expect(out.map((u) => u.text)).toEqual([desk.text, "avukata göndereceğim."]);
  });

  it("still refuses to glue a single word by the looser rule", () => {
    const out = mergeSegments([
      desk,
      seg("w3", "watch", "watch", "ambient", 7.5, 8, "göndereceğim"),
    ]);
    expect(out).toHaveLength(2);
  });
});
