/** Canonical IANA name for `tz`, or null when the runtime does not know the zone. */
export function canonicalTimeZone(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

function parts(ms: number, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

/** Calendar date (YYYY-MM-DD) of the instant `ms` in `tz`. Falls back to UTC for unknown zones. */
export function localDate(ms: number, tz: string): string {
  const p = canonicalTimeZone(tz) ? parts(ms, tz) : parts(ms, "UTC");
  return `${p.year}-${p.month}-${p.day}`;
}

/** Wall-clock time (HH:MM) of the instant `ms` in `tz`. */
export function localTime(ms: number, tz: string): string {
  const p = canonicalTimeZone(tz) ? parts(ms, tz) : parts(ms, "UTC");
  return `${p.hour}:${p.minute}`;
}

/**
 * "Friday, 2026-11-20" for a calendar date. Models get the weekday from here because
 * small ones guess it wrong, and "by Friday" can only be resolved against a known weekday.
 */
export function weekdayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(d);
  return `${weekday}, ${date}`;
}

/** "Friday, 2026-11-20 10:05 (Europe/Istanbul)" for the instant `ms`. */
export function localStamp(ms: number, tz: string): string {
  const zone = canonicalTimeZone(tz) ?? "UTC";
  return `${weekdayLabel(localDate(ms, zone))} ${localTime(ms, zone)} (${zone})`;
}
