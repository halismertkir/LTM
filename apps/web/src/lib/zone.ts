/**
 * Calendar arithmetic in an IANA time zone without a date library. The server decides
 * where a user's day begins (`PipelineSettings.timeZone`); the browser may be elsewhere,
 * so nothing here uses the browser's local time.
 */

const partsCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(tz, f);
  }
  return f;
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wall(ms: number, tz: string): Wall {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(ms)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (Istanbul → +3 h). */
export function zoneOffsetMs(ms: number, tz: string): number {
  const w = wall(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - (ms - (ms % 1000));
}

/** `YYYY-MM-DD` of instant `ms` in `tz`. */
export function dayInZone(ms: number, tz: string): string {
  const w = wall(ms, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** Instant at which wall-clock `date` + `hh:mm` happens in `tz`. */
export function zonedTime(date: string, tz: string, hh = 0, mm = 0): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle DST transitions: the offset at the guess may differ from the result's.
  let ms = guess - zoneOffsetMs(guess, tz);
  ms = guess - zoneOffsetMs(ms, tz);
  return ms;
}

/** Start of the day that contains `ms`, as seen in `tz`. */
export function startOfDayInZone(ms: number, tz: string): number {
  return zonedTime(dayInZone(ms, tz), tz);
}

/** `date` shifted by whole days (calendar arithmetic, DST-safe). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Noon of `date` in `tz` — a safe instant for formatting a calendar day. */
export function noonOf(date: string, tz: string): number {
  return zonedTime(date, tz, 12, 0);
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
