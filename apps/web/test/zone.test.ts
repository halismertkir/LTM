import { describe, expect, it } from "vitest";
import { dateInputToMs, formatDay, formatTime } from "../src/lib/format";
import { scopeRange } from "../src/lib/scope";
import { addDays, dayInZone, startOfDayInZone, zonedTime } from "../src/lib/zone";

// 2026-11-19 22:30 UTC: already Friday 20 November in Istanbul (+3), still Thursday in New York.
const T = Date.UTC(2026, 10, 19, 22, 30);

describe("calendar days in a fixed zone", () => {
  it("assigns instants to the account's day, not the browser's", () => {
    expect(dayInZone(T, "Europe/Istanbul")).toBe("2026-11-20");
    expect(dayInZone(T, "America/New_York")).toBe("2026-11-19");
    expect(dayInZone(T, "UTC")).toBe("2026-11-19");
  });

  it("finds the start of a day, also across daylight-saving changes", () => {
    expect(new Date(startOfDayInZone(T, "Europe/Istanbul")).toISOString()).toBe(
      "2026-11-19T21:00:00.000Z",
    );
    // New York switches to summer time on 8 March 2026 and back on 1 November 2026.
    expect(new Date(zonedTime("2026-03-08", "America/New_York")).toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(new Date(zonedTime("2026-03-09", "America/New_York")).toISOString()).toBe(
      "2026-03-09T04:00:00.000Z",
    );
    expect(new Date(zonedTime("2026-11-01", "America/New_York")).toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("words days relative to today in the zone", () => {
    expect(formatDay("2026-11-20", "en", "Europe/Istanbul", { now: T })).toBe("Today");
    expect(formatDay("2026-11-19", "en", "Europe/Istanbul", { now: T })).toBe("Yesterday");
    // In New York the same instant is the 19th, so the 20th is not today there.
    expect(formatDay("2026-11-19", "en", "America/New_York", { now: T })).toBe("Today");
    expect(formatDay("2026-11-20", "en", "Europe/Istanbul", { now: T, relative: false })).toBe(
      "Friday 20 November",
    );
    expect(formatDay("2026-11-17", "tr", "Europe/Istanbul", { now: T })).toBe("17 Kasım Salı");
    expect(formatDay("2025-12-31", "en", "Europe/Istanbul", { now: T })).toBe(
      "Wednesday, 31 December 2025",
    );
  });

  it("formats times in the given zone", () => {
    expect(formatTime(T, "en", false, "Europe/Istanbul")).toBe("01:30");
    expect(formatTime(T, "en", false, "America/New_York")).toBe("17:30");
  });

  it("turns date inputs into the zone's day boundaries", () => {
    expect(dateInputToMs("2026-11-20", false, "Europe/Istanbul")).toBe(Date.UTC(2026, 10, 19, 21));
    expect(dateInputToMs("2026-11-20", true, "Europe/Istanbul")).toBe(
      Date.UTC(2026, 10, 20, 21) - 1,
    );
    expect(dateInputToMs("nope")).toBeUndefined();
  });

  it("maps ask scopes to calendar days", () => {
    expect(scopeRange("all", T, "Europe/Istanbul")).toEqual({});
    expect(scopeRange("today", T, "Europe/Istanbul")).toEqual({
      from: Date.UTC(2026, 10, 19, 21),
      to: T,
    });
    expect(scopeRange("week", T, "Europe/Istanbul")).toEqual({
      from: Date.UTC(2026, 10, 13, 21),
      to: T,
    });
  });
});
