import type { Locale } from "@ltm/protocol";
import type { UiLanguagePref } from "../config.js";
import { en, type MessageKey } from "./en.js";
import { tr } from "./tr.js";

export type { MessageKey };

export const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { en, tr };

export function resolveLocale(pref: UiLanguagePref, browserLanguage: string): Locale {
  if (pref === "en" || pref === "tr") return pref;
  return browserLanguage.toLowerCase().startsWith("tr") ? "tr" : "en";
}

export function browserLanguage(): string {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return typeof navigator !== "undefined" ? navigator.language : "en";
  }
}

export type Vars = Record<string, string | number>;

export function format(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  );
}

export type Translate = (key: MessageKey, vars?: Vars) => string;

export function translator(locale: Locale): Translate {
  const dict = DICTIONARIES[locale];
  return (key, vars) => format(dict[key] ?? en[key], vars);
}
