import { meetingMatchPatterns } from "./shared/meetingHosts.js";

/**
 * manifest.json, generated at build time (vite.config.ts) so the content-script matches
 * come from the single meeting-host list.
 *
 * Permissions are the minimum the features need — see the table in README.md:
 * - no `tabs`: activeTab (granted by the toolbar click/shortcut) exposes the captured
 *   tab's title and URL, which is all we read;
 * - no `<all_urls>`: the only host access is the meeting sites (content script) and the
 *   user's own server, requested at pairing time from `optional_host_permissions`;
 * - no `notifications`: the prompt on meeting sites is the in-page banner.
 */
export const MIN_CHROME_VERSION = "116"; // offscreen USER_MEDIA + tabCapture.getMediaStreamId from the worker, runtime.getContexts

export const TOGGLE_TAB_COMMAND = "toggle-tab-capture";

export function buildManifest(version: string): chrome.runtime.ManifestV3 {
  const icons = (variant: "idle" | "rec") =>
    Object.fromEntries([16, 32, 48, 128].map((s) => [String(s), `icons/${variant}-${s}.png`]));
  return {
    manifest_version: 3,
    name: "__MSG_extName__",
    short_name: "LTM",
    description: "__MSG_extDescription__",
    version,
    default_locale: "en",
    minimum_chrome_version: MIN_CHROME_VERSION,
    icons: icons("idle"),
    action: {
      default_popup: "popup.html",
      default_title: "__MSG_actionTitle__",
      default_icon: icons("idle"),
    },
    background: { service_worker: "background.js", type: "module" },
    options_ui: { page: "options.html", open_in_tab: true },
    permissions: ["tabCapture", "offscreen", "storage", "activeTab"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    content_scripts: [
      {
        matches: meetingMatchPatterns(),
        js: ["content.js"],
        run_at: "document_idle",
        all_frames: false,
      },
    ],
    commands: {
      [TOGGLE_TAB_COMMAND]: {
        suggested_key: { default: "Alt+Shift+L", mac: "Alt+Shift+L" },
        description: "__MSG_commandToggleTab__",
      },
    },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    },
  };
}
