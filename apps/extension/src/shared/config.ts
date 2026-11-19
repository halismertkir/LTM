import type { Locale } from "@ltm/protocol";

/**
 * Everything persisted in `chrome.storage.local`. The MV3 service worker can be killed at
 * any moment (≈30 s idle), so nothing that matters may live only in its memory.
 */
export interface Pairing {
  serverUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
  userDisplayName: string;
  userLocale: Locale;
  pairedAt: number;
}

export type UiLanguagePref = "auto" | Locale;

export interface Preferences {
  /** Show the "Record this meeting?" banner on meeting sites. */
  autoOffer: boolean;
  /**
   * Start a microphone stream together with tab audio. On by default: with headphones the
   * tab stream never contains the user's own voice.
   */
  micWithTab: boolean;
  /** Spoken-language hint for the server's STT. Empty = auto-detect. */
  language: string;
  uiLanguage: UiLanguagePref;
  /** Experimental on-device transcription (mode "transcript"). */
  onDeviceTranscription: boolean;
  /** Hostnames where the banner must never appear again. */
  neverOfferOn: string[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  autoOffer: true,
  micWithTab: true,
  language: "",
  uiLanguage: "auto",
  onDeviceTranscription: false,
  neverOfferOn: [],
};

/** Key of the worker's AppState in `chrome.storage.session`. */
export const SESSION_STATE_KEY = "appState";

export const STORAGE_KEYS = {
  pairing: "pairing",
  prefs: "prefs",
} as const;

export function mergePreferences(stored: unknown): Preferences {
  const out: Preferences = { ...DEFAULT_PREFERENCES, neverOfferOn: [] };
  if (!stored || typeof stored !== "object") return out;
  const s = stored as Partial<Record<keyof Preferences, unknown>>;
  if (typeof s.autoOffer === "boolean") out.autoOffer = s.autoOffer;
  if (typeof s.micWithTab === "boolean") out.micWithTab = s.micWithTab;
  if (typeof s.language === "string") out.language = s.language;
  if (s.uiLanguage === "auto" || s.uiLanguage === "en" || s.uiLanguage === "tr") {
    out.uiLanguage = s.uiLanguage;
  }
  if (typeof s.onDeviceTranscription === "boolean") {
    out.onDeviceTranscription = s.onDeviceTranscription;
  }
  if (Array.isArray(s.neverOfferOn)) {
    out.neverOfferOn = s.neverOfferOn.filter((h): h is string => typeof h === "string");
  }
  return out;
}

export function isPairing(value: unknown): value is Pairing {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.serverUrl === "string" &&
    typeof p.token === "string" &&
    p.token.length > 0 &&
    typeof p.deviceId === "string"
  );
}

export async function loadPairing(): Promise<Pairing | null> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.pairing);
  const p = got[STORAGE_KEYS.pairing];
  return isPairing(p) ? p : null;
}

export async function loadPreferences(): Promise<Preferences> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.prefs);
  return mergePreferences(got[STORAGE_KEYS.prefs]);
}

export async function savePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const next = { ...(await loadPreferences()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.prefs]: next });
  return next;
}
