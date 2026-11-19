import type { Locale } from "@ltm/protocol";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { en, type MessageKey } from "./en";
import { tr } from "./tr";

export type { MessageKey };
export type Vars = Record<string, string | number>;

export const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { en, tr };
export const LOCALES: readonly Locale[] = ["en", "tr"];

const STORAGE_KEY = "ltm.locale";

export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  );
}

export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  return interpolate(DICTIONARIES[locale][key] ?? en[key], vars);
}

/** Keys that come in `_one` / `_other` pairs; pass the stem. */
type PluralStem = {
  [K in MessageKey]: K extends `${infer S}_one`
    ? `${S}_other` extends MessageKey
      ? S
      : never
    : never;
}[MessageKey];

function storedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "en" || v === "tr" ? v : null;
  } catch {
    return null;
  }
}

function browserLocale(): Locale {
  const langs =
    typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : [];
  return langs.some((l) => l?.toLowerCase().startsWith("tr")) ? "tr" : "en";
}

export interface I18n {
  locale: Locale;
  /** True when the user picked the language explicitly (then the account default is ignored). */
  explicit: boolean;
  setLocale: (l: Locale) => void;
  /** Adopt the account's locale unless the user already chose one in this browser. */
  adoptAccountLocale: (l: Locale) => void;
  t: (key: MessageKey, vars?: Vars) => string;
  tn: (stem: PluralStem, count: number, vars?: Vars) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Locale }) {
  const [state, setState] = useState<{ locale: Locale; explicit: boolean }>(() => {
    const stored = storedLocale();
    if (initial) return { locale: initial, explicit: true };
    return stored
      ? { locale: stored, explicit: true }
      : { locale: browserLocale(), explicit: false };
  });

  const setLocale = useCallback((l: Locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Private mode / storage disabled: the choice simply lasts for this tab.
    }
    setState({ locale: l, explicit: true });
  }, []);

  const adoptAccountLocale = useCallback((l: Locale) => {
    setState((s) => (s.explicit || s.locale === l ? s : { locale: l, explicit: false }));
  }, []);

  const value = useMemo<I18n>(() => {
    const plural = new Intl.PluralRules(state.locale);
    return {
      ...state,
      setLocale,
      adoptAccountLocale,
      t: (key, vars) => translate(state.locale, key, vars),
      tn: (stem, count, vars) => {
        const form = plural.select(count) === "one" ? "one" : "other";
        return translate(state.locale, `${stem}_${form}` as MessageKey, { count, ...vars });
      },
    };
  }, [state, setLocale, adoptAccountLocale]);

  useEffect(() => {
    document.documentElement.lang = state.locale;
  }, [state.locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n outside I18nProvider");
  return ctx;
}
