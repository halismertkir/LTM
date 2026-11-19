import type { Locale } from "@ltm/protocol";
import { translate } from "../i18n";

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

export function formatTime(ms: number, locale: Locale, seconds = false): string {
  return cached(
    `t:${locale}:${seconds}`,
    () =>
      new Intl.DateTimeFormat(tag(locale), {
        hour: "2-digit",
        minute: "2-digit",
        second: seconds ? "2-digit" : undefined,
      }),
  ).format(ms);
}

export function formatDate(ms: number, locale: Locale, withYear = true): string {
  return cached(
    `d:${locale}:${withYear}`,
    () =>
      new Intl.DateTimeFormat(tag(locale), {
        day: "numeric",
        month: "long",
        year: withYear ? "numeric" : undefined,
      }),
  ).format(ms);
}

export function formatDateTime(ms: number, locale: Locale): string {
  return cached(
    `dt:${locale}`,
    () => new Intl.DateTimeFormat(tag(locale), { dateStyle: "medium", timeStyle: "short" }),
  ).format(ms);
}

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today", "Yesterday", or "Monday, 17 November" (with the year when it is not this year). */
export function formatDayHeading(dayStartMs: number, locale: Locale, now = Date.now()): string {
  const today = startOfDay(now);
  if (dayStartMs === today) return translate(locale, "time.today");
  if (dayStartMs === startOfDay(today - 12 * 3600_000)) return translate(locale, "time.yesterday");
  const sameYear = new Date(dayStartMs).getFullYear() === new Date(now).getFullYear();
  return cached(
    `h:${locale}:${sameYear}`,
    () =>
      new Intl.DateTimeFormat(tag(locale), {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: sameYear ? undefined : "numeric",
      }),
  ).format(dayStartMs);
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

export function formatRelative(ms: number, locale: Locale, now = Date.now()): string {
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
  return formatDate(ms, locale);
}

export function formatNumber(n: number, locale: Locale): string {
  return cached(`n:${locale}`, () => new Intl.NumberFormat(tag(locale))).format(n);
}

/** `YYYY-MM-DD` (date input value) in local time → epoch ms of the start of that day. */
export function dateInputToMs(value: string, endOfDay = false): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (endOfDay) d.setHours(23, 59, 59, 999);
  return d.getTime();
}
