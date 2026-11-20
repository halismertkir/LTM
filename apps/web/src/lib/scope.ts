import { addDays, dayInZone, zonedTime } from "./zone";

/** How far back an Ask question looks. */
export type AskScope = "today" | "week" | "all";

/**
 * `from`/`to` for `POST /ask`. "Today" and "last 7 days" are calendar days in the account's
 * zone (the same days the Days view shows), not rolling 24-hour windows.
 */
export function scopeRange(
  scope: AskScope,
  now: number,
  tz: string,
): { from?: number; to?: number } {
  if (scope === "all") return {};
  const today = dayInZone(now, tz);
  const first = scope === "today" ? today : addDays(today, -6);
  return { from: zonedTime(first, tz), to: now };
}
