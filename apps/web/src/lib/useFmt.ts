import { useMemo } from "react";
import { useSettings } from "../api/queries";
import { useI18n } from "../i18n";
import {
  formatDate,
  formatDateTime,
  formatDay,
  formatDuration,
  formatRelative,
  formatTime,
} from "./format";
import { browserTimeZone, dayInZone } from "./zone";

/** The account's zone (where its days begin); the browser's until settings have loaded. */
export function useTimeZone(): string {
  const settings = useSettings();
  return settings.data?.pipeline.timeZone ?? browserTimeZone();
}

/** Formatters bound to the UI language and the account's time zone. */
export function useFmt() {
  const { locale } = useI18n();
  const tz = useTimeZone();
  return useMemo(
    () => ({
      locale,
      tz,
      time: (ms: number, seconds = false) => formatTime(ms, locale, seconds, tz),
      date: (ms: number, withYear = true) => formatDate(ms, locale, withYear, tz),
      dateTime: (ms: number) => formatDateTime(ms, locale, tz),
      day: (date: string, opts?: { relative?: boolean; weekday?: boolean }) =>
        formatDay(date, locale, tz, opts),
      relative: (ms: number) => formatRelative(ms, locale, Date.now(), tz),
      duration: (ms: number) => formatDuration(ms, locale),
      dayOf: (ms: number) => dayInZone(ms, tz),
      today: () => dayInZone(Date.now(), tz),
    }),
    [locale, tz],
  );
}

export type Fmt = ReturnType<typeof useFmt>;
