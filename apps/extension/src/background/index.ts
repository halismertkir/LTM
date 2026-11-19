/**
 * MV3 service worker: orchestration only, no audio.
 *
 * Every listener is registered synchronously at the top level. Chrome starts a killed
 * worker *for* an event and only delivers it to listeners that exist after the first
 * synchronous run of this script; registering inside an `await` loses events.
 */
import { isToBackground } from "../shared/messages.js";
import { applyBadge, invalidateBadge } from "./badge.js";
import {
  handleContent,
  handleOffscreen,
  handleUi,
  onCommand,
  onTabRemoved,
  onTabUpdated,
  reconcile,
  refreshAccount,
} from "./controller.js";
import { readState } from "./store.js";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isToBackground(msg)) return false;
  let work: Promise<unknown>;
  if (msg.kind.startsWith("ui:")) {
    work = handleUi(msg as Parameters<typeof handleUi>[0]);
  } else if (msg.kind.startsWith("content:")) {
    work = handleContent(msg as Parameters<typeof handleContent>[0], sender);
  } else {
    // Only our offscreen document may report stream state.
    if (sender.url !== chrome.runtime.getURL("offscreen.html")) return false;
    work = handleOffscreen(msg as Parameters<typeof handleOffscreen>[0]);
  }
  work.then(
    (result) => sendResponse(result ?? null),
    (err: unknown) => {
      console.error("message handler failed", msg.kind, err);
      sendResponse({ ok: false, reason: "capture_failed", message: String(err) });
    },
  );
  // Keep the channel open for the async answer.
  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  void onCommand(command, tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void onTabRemoved(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  void onTabUpdated(tabId, changeInfo);
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    // First run: the options page doubles as onboarding (pair, consent, microphone).
    void chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  void refreshAccount();
});

// Every (re)start of the worker: re-apply the badge (the action's state is not persisted
// across browser restarts) and check that the offscreen document agrees with the state.
invalidateBadge();
void readState().then(applyBadge);
void reconcile();
