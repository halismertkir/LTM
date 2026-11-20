/**
 * Output language decided in code. Small local models ignore "write in the language of the
 * conversation" and fall back to English, so the server picks the language and states it
 * explicitly (by name and code) in the system prompt and again at the end of the prompt.
 */

/** English names for the codes speech recognisers commonly report. */
const NAMES: Record<string, string> = {
  ar: "Arabic",
  az: "Azerbaijani",
  bg: "Bulgarian",
  ca: "Catalan",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  fa: "Persian",
  fi: "Finnish",
  fr: "French",
  he: "Hebrew",
  hi: "Hindi",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sk: "Slovak",
  sv: "Swedish",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
  zh: "Chinese",
};

/** Whisper-style engines sometimes report the English name instead of the code. */
const BY_NAME = new Map(Object.entries(NAMES).map(([code, name]) => [name.toLowerCase(), code]));

/** Primary subtag in lower case ("en-US" → "en"; "turkish" → "tr"), or null. */
export function baseLanguage(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.trim().toLowerCase();
  if (!c) return null;
  const byName = BY_NAME.get(c);
  if (byName) return byName;
  const base = c.split(/[-_]/)[0]!;
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}

export function languageName(code: string): string {
  const base = baseLanguage(code) ?? code;
  return NAMES[base] ?? `the language with code "${code}"`;
}

/** "Turkish (tr)" */
export function languageLabel(code: string): string {
  const name = languageName(code);
  return name.startsWith("the language") ? name : `${name} (${code})`;
}

/** The language with the most weight (e.g. characters or minutes of speech), or null. */
export function dominantLanguage(
  items: { language: string | null | undefined; weight: number }[],
): string | null {
  const totals = new Map<string, number>();
  for (const it of items) {
    const base = baseLanguage(it.language);
    if (!base) continue;
    totals.set(base, (totals.get(base) ?? 0) + Math.max(0, it.weight));
  }
  let best: string | null = null;
  let bestWeight = 0;
  for (const [code, w] of totals) if (w > bestWeight) [best, bestWeight] = [code, w];
  return best;
}

/** Fixed setting, else what was spoken, else the account's interface language. */
export function decideLanguage(opts: {
  fixed: string | null;
  spoken: string | null;
  locale: string;
}): string {
  return baseLanguage(opts.fixed) ?? opts.spoken ?? baseLanguage(opts.locale) ?? "en";
}

/** The directive repeated at the very end of user prompts (where small models look last). */
export function languageDirective(
  code: string,
  fields = "title, summary, notes, decisions, action items, memories",
): string {
  return `Write every field (${fields}) in ${languageLabel(code)}. Do not translate names.`;
}
