import { describe, expect, it } from "vitest";
import { splitConversations } from "../src/index.js";

const MIN = 60_000;
const item = (startMin: number, endMin: number, id = `${startMin}`) => ({
  startMs: startMin * MIN,
  endMs: endMin * MIN,
  id,
});

describe("splitConversations", () => {
  it("returns nothing for nothing", () => {
    expect(splitConversations([])).toEqual([]);
  });

  it("splits on silences longer than the gap", () => {
    const items = [item(0, 1), item(2, 3), item(10, 11), item(12, 13)];
    const out = splitConversations(items, { gapMs: 5 * MIN });
    expect(out.map((s) => s.items.map((i) => i.id))).toEqual([
      ["0", "2"],
      ["10", "12"],
    ]);
    expect(out[0]).toMatchObject({ startMs: 0, endMs: 3 * MIN });
  });

  it("a gap of exactly gapMs does not split", () => {
    expect(splitConversations([item(0, 1), item(6, 7)], { gapMs: 5 * MIN })).toHaveLength(1);
  });

  it("sorts input and measures gaps from the latest end of overlapping items", () => {
    const out = splitConversations([item(8, 9), item(0, 7), item(1, 2)], { gapMs: 5 * MIN });
    expect(out).toHaveLength(1);
    expect(out[0]!.items.map((i) => i.id)).toEqual(["0", "1", "8"]);
    expect(out[0]!.endMs).toBe(9 * MIN);
  });

  it("caps duration, cutting at the longest pause near the cap", () => {
    // Talk every 2 minutes for 5 hours (1-minute pauses), one 3-minute pause at 3h29.
    const items = [];
    for (let m = 0; m < 300; m += 2) {
      if (m === 210) continue;
      items.push(item(m, m + 1));
    }
    const out = splitConversations(items, { gapMs: 5 * MIN, maxDurationMs: 4 * 60 * MIN });
    expect(out).toHaveLength(2);
    expect(out[0]!.endMs).toBe(209 * MIN);
    expect(out[1]!.items[0]!.id).toBe("212");
    for (const s of out) expect(s.endMs - s.startMs).toBeLessThanOrEqual(4 * 60 * MIN);
    expect(out.flatMap((s) => s.items)).toHaveLength(items.length);
  });

  it("keeps every slice under the cap even without pauses", () => {
    const items = Array.from({ length: 100 }, (_, i) => item(i, i + 1));
    const out = splitConversations(items, { maxDurationMs: 30 * MIN });
    for (const s of out) expect(s.endMs - s.startMs).toBeLessThanOrEqual(30 * MIN);
    expect(out.flatMap((s) => s.items)).toHaveLength(100);
  });

  it("lets a single over-long item stand alone", () => {
    const out = splitConversations([item(0, 100), item(101, 102)], { maxDurationMs: 30 * MIN });
    expect(out.map((s) => s.items.length)).toEqual([1, 1]);
  });
});
