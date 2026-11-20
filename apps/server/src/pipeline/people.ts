/** Words models use for "the account owner" instead of a name (English and Turkish). */
const SELF_OWNERS = new Set([
  "self",
  "me",
  "i",
  "myself",
  "user",
  "the user",
  "speaker",
  "owner",
  "ben",
  "kendim",
  "bana",
]);

/** What small models write instead of leaving the owner empty. */
const NO_OWNERS = new Set([
  "unknown",
  "none",
  "null",
  "n/a",
  "na",
  "-",
  "?",
  "unassigned",
  "nobody",
  "bilinmiyor",
  "belirsiz",
  "yok",
]);

/** The account owner's own tasks carry their display name, never a speaker label. */
export function normalizeOwner(raw: string | null, displayName: string): string | null {
  if (!raw) return null;
  const v = raw.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!v) return null;
  const key = v.toLowerCase();
  if (NO_OWNERS.has(key)) return null;
  return SELF_OWNERS.has(key) ? displayName : v;
}

/** People lists without placeholders ("unknown"), with "me" resolved to the account owner. */
export function cleanPeople(names: string[], displayName: string, max = 30): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeOwner(raw, displayName);
    if (name && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length >= max) break;
  }
  return out;
}
