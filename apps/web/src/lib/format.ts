import type { Locale } from "@ltm/protocol";
import { translate } from "../i18n";
import { addDays, dayInZone, noonOf, zonedTime } from "./zone";

// Intl formatters are comparatively expensive to construct; timeline cards format many dates.
const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>();
function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>(
  key: string,
  make: () => T,
): T {
  let f = cache.get(key) as T | undefined;
  if (!f) {
    f = make();
    cache.set(key, f);
  }
  return f;
}

const tag = (l: Locale) => (l === "tr" ? "tr-TR" : "en-GB");
// en-GB rather than en-US gives 24h clocks and day-month order, which reads better next to
// Turkish and matches the notebook tone; month names are still English.

// Every date/time function takes the IANA zone to format in. Callers pass the account's
// zone (see useFmt) so a day and the times inside it always agree, wherever the browser is.

export function formatTime(ms: number, locale: Locale, seconds = false, tz?: string): string {
  return cached(
    `t:${locale}:${seconds}:${tz}`,
    () =>
      new Intl.DateTimeFormat(tag(locale), {
        hour: "2-digit",
        minute: "2-digit",
        second: seconds ? "2-digit" : undefined,
        timeZone: tz,
      }),
  ).format(ms);
}

export function formatDate(ms: number, locale: Locale, withYear = true, tz?: string): string {
  return cached(
    `d:${locale}:${withYear}:${tz}`,
    () =>
      new Intl.DateTimeFormat(tag(locale), {
        day: "numeric",
        month: "long",
        year: withYear ? "numeric" : undefined,
        timeZone: tz,
      }),
  ).format(ms);
}

export function formatDateTime(ms: number, locale: Locale, tz?: string): string {
  return cached(
    `dt:${locale}:${tz}`,
    () =>
      new Intl.DateTimeFormat(tag(locale), {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: tz,
      }),
  ).format(ms);
}

/**
 * A calendar day (`YYYY-MM-DD`, already in the account's zone) as words: "Today",
 * "Yesterday", or "Monday 17 November" (with the year when it is not this year).
 * `relative: false` always gives the weekday form.
 */
export function formatDay(
  date: string,
  locale: Locale,
  tz: string,
  opts: { now?: number; relative?: boolean; weekday?: boolean } = {},
): string {
  const now = opts.now ?? Date.now();
  const today = dayInZone(now, tz);
  if (opts.relative !== false) {
    if (date === today) return translate(locale, "time.today");
    if (date === addDays(today, -1)) return translate(locale, "time.yesterday");
  }
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  const weekday = opts.weekday !== false;
  return cached(
    `day:${locale}:${sameYear}:${weekday}:${tz}`,
    () =>
      new Intl.DateTimeFormat(tag(locale), {
        weekday: weekday ? "long" : undefined,
        day: "numeric",
        month: "long",
        year: sameYear ? undefined : "numeric",
        timeZone: tz,
      }),
  ).format(noonOf(date, tz));
}

function unit(locale: Locale, u: "hour" | "minute" | "second", n: number): string {
  return cached(
    `u:${locale}:${u}`,
    () => new Intl.NumberFormat(tag(locale), { style: "unit", unit: u, unitDisplay: "short" }),
  ).format(n);
}

/** Human duration: "45 sec", "12 min", "1 hr 5 min". */
export function formatDuration(ms: number, locale: Locale): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return unit(locale, "second", totalSec);
  const totalMin = Math.round(totalSec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return unit(locale, "minute", m);
  return m === 0
    ? unit(locale, "hour", h)
    : `${unit(locale, "hour", h)} ${unit(locale, "minute", m)}`;
}

/** Stopwatch style for live streams: "4:07", "1:02:33". */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export function formatRelative(ms: number, locale: Locale, now = Date.now(), tz?: string): string {
  const rtf = cached(
    `r:${locale}`,
    () => new Intl.RelativeTimeFormat(tag(locale), { numeric: "auto", style: "long" }),
  );
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return translate(locale, "time.justNow");
  if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86400_000) return rtf.format(Math.round(diff / 3600_000), "hour");
  if (abs < 30 * 86400_000) return rtf.format(Math.round(diff / 86400_000), "day");
  return formatDate(ms, locale, true, tz);
}

export function formatNumber(n: number, locale: Locale): string {
  return cached(`n:${locale}`, () => new Intl.NumberFormat(tag(locale))).format(n);
}

/** `YYYY-MM-DD` (date input value) in `tz` → epoch ms of the start (or end) of that day. */
export function dateInputToMs(value: string, endOfDay = false, tz?: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  if (tz) return endOfDay ? zonedTime(addDays(value, 1), tz) - 1 : zonedTime(value, tz);
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const t = new Date(y, m - 1, d);
  if (endOfDay) t.setHours(23, 59, 59, 999);
  return t.getTime();
}
