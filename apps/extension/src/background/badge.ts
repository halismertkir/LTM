import { loadPreferences } from "../shared/config.js";
import {
  browserLanguage,
  type MessageKey,
  resolveLocale,
  translator,
} from "../shared/i18n/index.js";
import { type AppState, badgeFor, deriveView } from "./machine.js";

const ICON_SIZES = [16, 32, 48, 128] as const;

function iconPaths(recording: boolean): Record<string, string> {
  const variant = recording ? "rec" : "idle";
  return Object.fromEntries(ICON_SIZES.map((s) => [String(s), `icons/${variant}-${s}.png`]));
}

let lastApplied = "";

/**
 * Mirrors the state on the toolbar button.
 *
 * Only *global* badge values are used. Chrome lets per-tab values override the global ones
 * and keeps them until the tab navigates, so a per-tab "meeting detected" hint would hide
 * the global REC badge on exactly the tab being recorded (and a stale per-tab colour would
 * survive clearing the text). One global value can never disagree with the capture state.
 */
export async function applyBadge(state: AppState): Promise<void> {
  const view = deriveView(state);
  const badge = badgeFor(view, Object.keys(state.meetingTabs).length > 0);
  const prefs = await loadPreferences();
  const t = translator(resolveLocale(prefs.uiLanguage, browserLanguage()));
  const titleKey: MessageKey =
    view.kind === "listening"
      ? view.degraded
        ? "action.title.recordingDegraded"
        : "action.title.recording"
      : view.kind === "consent_needed"
        ? "action.title.consent"
        : view.kind === "paused"
          ? "action.title.paused"
          : view.kind === "error"
            ? "action.title.error"
            : view.kind === "not_paired"
              ? "action.title.notPaired"
              : badge.text
                ? "action.title.meeting"
                : "action.title.idle";
  const title = t(titleKey);
  const signature = JSON.stringify([badge, title]);
  if (signature === lastApplied) return;
  lastApplied = signature;

  await Promise.all([
    chrome.action.setBadgeText({ text: badge.text }),
    chrome.action.setBadgeBackgroundColor({ color: badge.color }),
    // White text on every badge colour (Chrome would pick black on the amber one).
    chrome.action.setBadgeTextColor({ color: "#ffffff" }),
    chrome.action.setTitle({ title }),
    chrome.action.setIcon({ path: iconPaths(badge.recording) }),
  ]).catch((err) => console.warn("badge update failed", err));
}

/** Forces the next applyBadge to write everything (e.g. after the worker restarted). */
export function invalidateBadge(): void {
  lastApplied = "";
}
