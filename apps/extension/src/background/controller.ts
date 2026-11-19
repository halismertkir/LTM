import { ApiClient, ApiError } from "../shared/api.js";
import {
  loadPairing,
  loadPreferences,
  type Pairing,
  STORAGE_KEYS,
  savePreferences,
} from "../shared/config.js";
import { meetingHostFor } from "../shared/meetingHosts.js";
import type {
  CaptureSource,
  CaptureStartSpec,
  FromContent,
  FromOffscreen,
  FromUi,
  MeetingOfferReply,
  StartResult,
} from "../shared/messages.js";
import { originPattern } from "../shared/url.js";
import { applyBadge } from "./badge.js";
import { type AppState, type CaptureSession, isCapturing } from "./machine.js";
import {
  closeOffscreen,
  ensureOffscreen,
  hasOffscreen,
  listOffscreenCaptures,
  sendToOffscreen,
} from "./offscreenHost.js";
import { dispatch, onStateChange, readState } from "./store.js";

/** Pages that no extension may capture; checked up front for a clear error message. */
function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return (
    /^(chrome|chrome-untrusted|devtools|edge|about|view-source|chrome-extension):/i.test(url) ||
    /^https:\/\/chromewebstore\.google\.com\//i.test(url) ||
    /^https:\/\/chrome\.google\.com\/webstore/i.test(url)
  );
}

function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
}

const STOP_TIMEOUT_MS = 10_000;

onStateChange(async (state, prev) => {
  await applyBadge(state);
  if (isCapturing(prev) && !isCapturing(state)) await closeOffscreenIfIdle();
});

/**
 * Close the offscreen document once it has nothing left to do: it keeps the AudioContext
 * and (for the mic) Chrome's own "using your microphone" indicator alive. The state can
 * say "nothing captured" while a stream is still finishing — e.g. after an account-level
 * fatal error the other stream is still sending `end` — so ask the document itself and
 * try again when it reports `capture:ended`.
 */
async function closeOffscreenIfIdle(): Promise<void> {
  if (isCapturing(await readState())) return;
  const live = await listOffscreenCaptures();
  if (live && live.length === 0) await closeOffscreen();
}

// ------------------------------------------------------------------------- account

export async function refreshAccount(): Promise<"ok" | "unpaired" | "unreachable"> {
  const pairing = await loadPairing();
  if (!pairing) {
    const s = await readState();
    if (s.paired) await dispatch({ type: "unpaired", reason: "user", at: Date.now() });
    return "unpaired";
  }
  const state = await readState();
  if (!state.paired) await dispatch({ type: "paired" });
  try {
    const me = await new ApiClient({ serverUrl: pairing.serverUrl, token: pairing.token }).me();
    await dispatch({
      type: "account",
      consentSatisfied: me.consent.satisfied,
      ingestPaused: me.ingestPaused,
      thirdPartyAi: me.consent.required.some((r) => r.type === "third_party_ai"),
    });
    if (!me.consent.satisfied || me.ingestPaused) await stopInOffscreen("all", "account_blocked");
    return "ok";
  } catch (err) {
    if (err instanceof ApiError && err.code === "unauthorized") {
      await forgetPairing("revoked");
      return "unpaired";
    }
    return "unreachable";
  }
}

export async function forgetPairing(reason: "user" | "revoked"): Promise<void> {
  const pairing = await loadPairing();
  await stopInOffscreen("all", reason === "user" ? "unpaired" : "token_revoked");
  await chrome.storage.local.remove(STORAGE_KEYS.pairing);
  await dispatch({ type: "unpaired", reason, at: Date.now() });
  if (pairing) {
    // Give back the host permission for the old server; pairing again asks for it anew.
    await chrome.permissions
      .remove({ origins: [originPattern(pairing.serverUrl)] })
      .catch(() => undefined);
  }
}

// ------------------------------------------------------------------------- capture

async function tabContext(tabId: number): Promise<{ url?: string; title?: string }> {
  try {
    const tab = await chrome.tabs.get(tabId);
    // `url`/`title` are only visible with activeTab (granted by the click/shortcut) or a
    // host permission for the tab — exactly the situations in which we may capture.
    const out: { url?: string; title?: string } = {};
    if (tab.url) out.url = tab.url;
    if (tab.title) out.title = tab.title;
    return out;
  } catch {
    return {};
  }
}

function newSession(
  source: CaptureSource,
  extra: Partial<CaptureSession> = {},
  mode: CaptureSession["mode"] = "audio",
): CaptureSession {
  return {
    source,
    streamId: crypto.randomUUID(),
    phase: "starting",
    startedAt: Date.now(),
    mode,
    tabId: null,
    app: null,
    title: null,
    companionOf: null,
    bufferedMs: 0,
    ...extra,
  };
}

function precheck(
  state: AppState,
  pairing: Pairing | null,
  source: CaptureSource,
): StartResult | null {
  if (!pairing || !state.paired) return { ok: false, reason: "not_paired" };
  if (state.consent === "required") return { ok: false, reason: "consent_required" };
  if (state.ingestPaused) return { ok: false, reason: "ingest_paused" };
  if (state.captures[source]) return { ok: false, reason: "already_capturing" };
  return null;
}

/**
 * Start capturing. For "tab" this must run while Chrome still considers the extension
 * invoked on that tab (toolbar click → popup, or the keyboard shortcut): that is what
 * makes `tabCapture.getMediaStreamId` succeed. A click inside our own in-page banner does
 * NOT count, which is why the banner falls back to asking for one click on the icon.
 */
export async function startCapture(source: CaptureSource, tabId?: number): Promise<StartResult> {
  const pairing = await loadPairing();
  let state = await readState();
  if (pairing && state.consent === "unknown") {
    // First capture after the worker (or browser) started: learn consent/pause state so
    // we fail with the precise reason instead of a generic stream error.
    await Promise.race([refreshAccount(), new Promise((r) => setTimeout(r, 3000))]);
    state = await readState();
  }
  const blocked = precheck(state, pairing, source);
  if (blocked) return blocked;
  const prefs = await loadPreferences();
  const mode = prefs.onDeviceTranscription ? "transcript" : "audio";

  let session: CaptureSession;
  let tabMediaStreamId: string | undefined;
  if (source === "tab") {
    if (tabId === undefined) return { ok: false, reason: "capture_failed", message: "no tab" };
    const ctx = await tabContext(tabId);
    if (isRestrictedUrl(ctx.url)) return { ok: false, reason: "restricted_tab" };
    try {
      tabMediaStreamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // "Extension has not been invoked for the current page (see activeTab permission)."
      if (/invoked|activeTab/i.test(message))
        return { ok: false, reason: "needs_invocation", message };
      if (/Chrome pages cannot be captured/i.test(message))
        return { ok: false, reason: "restricted_tab" };
      return { ok: false, reason: "capture_failed", message };
    }
    // Only the hostname and the title travel to the server — never the URL, which for
    // meetings often contains the meeting code or a join token.
    session = newSession(
      "tab",
      { tabId, app: hostnameOf(ctx.url), title: ctx.title ?? null },
      mode,
    );
  } else {
    session = newSession("mic", {}, mode);
  }

  const started = await launch(session, pairing!, prefs.language, tabMediaStreamId);
  if (!started.ok) return started;

  if (source === "tab" && prefs.micWithTab) {
    const now = await readState();
    if (!now.captures.mic) {
      const mic = newSession(
        "mic",
        { companionOf: "tab", app: session.app, title: session.title },
        mode,
      );
      await launch(mic, pairing!, prefs.language, undefined);
    }
  }
  return { ok: true };
}

async function launch(
  session: CaptureSession,
  pairing: Pairing,
  language: string,
  tabMediaStreamId: string | undefined,
): Promise<StartResult> {
  // Record the session (→ REC badge) *before* any audio is touched, so there is never a
  // moment of capture without the indicator.
  const state = await dispatch({ type: "captureRequested", session });
  if (state.captures[session.source]?.streamId !== session.streamId) {
    return { ok: false, reason: "already_capturing" };
  }
  const spec: CaptureStartSpec = {
    source: session.source,
    streamId: session.streamId,
    serverUrl: pairing.serverUrl,
    token: pairing.token,
    mode: session.mode,
  };
  if (language) spec.language = language;
  const context: NonNullable<CaptureStartSpec["context"]> = {};
  if (session.app) context.app = session.app.slice(0, 120);
  if (session.title) context.title = session.title.slice(0, 300);
  if (context.app || context.title) spec.context = context;
  if (tabMediaStreamId) spec.tabMediaStreamId = tabMediaStreamId;
  try {
    await ensureOffscreen();
    await sendToOffscreen({ target: "offscreen", kind: "capture:start", spec });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await dispatch({
      type: "failed",
      source: session.source,
      streamId: session.streamId,
      kind: "capture_failed",
      detail: message,
      at: Date.now(),
    });
    return { ok: false, reason: "capture_failed", message };
  }
}

/** Ask the offscreen document to stop; state is cleared when it reports `capture:ended`. */
async function stopInOffscreen(source: CaptureSource | "all", reason: string): Promise<void> {
  const state = await readState();
  const sources: CaptureSource[] = source === "all" ? ["tab", "mic"] : [source];
  const offscreen = await hasOffscreen();
  for (const s of sources) {
    const cur = state.captures[s];
    if (offscreen) {
      await sendToOffscreen(
        { target: "offscreen", kind: "capture:stop", source: s, reason },
        3,
      ).catch(() => undefined);
    }
    if (!cur) continue;
    if (!offscreen) {
      await dispatch({ type: "captureEnded", source: s, streamId: cur.streamId, reason });
      continue;
    }
    await dispatch({ type: "stopRequested", source: s });
    const streamId = cur.streamId;
    // If the offscreen document never answers (crashed), do not show REC forever.
    setTimeout(() => {
      void (async () => {
        const now = await readState();
        if (now.captures[s]?.streamId === streamId) {
          await dispatch({ type: "captureEnded", source: s, streamId, reason: "stop_timeout" });
        }
      })();
    }, STOP_TIMEOUT_MS);
  }
}

export async function stopCapture(source: CaptureSource | "all", reason = "user"): Promise<void> {
  const state = await readState();
  await stopInOffscreen(source, reason);
  // A microphone stream that was started *for* the tab ends with it.
  if (source === "tab" && state.captures.mic?.companionOf === "tab") {
    await stopInOffscreen("mic", reason);
  }
}

/**
 * Make the stored state and the offscreen document agree. Runs when the worker starts and
 * whenever the popup opens. Captures the state does not know about are stopped — nothing
 * may record without the indicator; sessions the document no longer has are cleared.
 */
export async function reconcile(): Promise<void> {
  const live = await listOffscreenCaptures();
  const state = await readState();
  const liveIds = new Set((live ?? []).map((c) => c.streamId));
  for (const c of live ?? []) {
    if (state.captures[c.source]?.streamId !== c.streamId) {
      await sendToOffscreen(
        { target: "offscreen", kind: "capture:stop", source: c.source, reason: "orphaned" },
        3,
      ).catch(() => undefined);
    }
  }
  for (const s of ["tab", "mic"] as const) {
    const cur = state.captures[s];
    // "starting": the capture:start message may still be in flight; leave it alone.
    if (cur && cur.phase !== "starting" && !liveIds.has(cur.streamId)) {
      await dispatch({ type: "captureEnded", source: s, streamId: cur.streamId, reason: "lost" });
    }
  }
  if (live && live.length === 0) await closeOffscreenIfIdle();
}

// ------------------------------------------------------------------------- messages

export async function handleOffscreen(msg: FromOffscreen): Promise<void> {
  switch (msg.kind) {
    case "stream:phase":
      await dispatch({
        type: "streamPhase",
        source: msg.source,
        streamId: msg.streamId,
        phase: msg.phase,
        bufferedMs: msg.bufferedMs,
      });
      return;
    case "stream:segment":
      await dispatch({
        type: "segment",
        source: msg.source,
        streamId: msg.streamId,
        text: msg.segment.text,
        at: Date.now(),
      });
      return;
    case "stream:fatal": {
      await dispatch({
        type: "fatal",
        source: msg.source,
        streamId: msg.streamId,
        code: msg.code,
        message: msg.message,
        at: Date.now(),
      });
      if (
        ["unauthorized", "consent_required", "ingest_paused", "unsupported_protocol"].includes(
          msg.code,
        )
      ) {
        // Account-level refusal: the other stream will get the same answer — stop it now.
        await stopInOffscreen("all", msg.code);
      }
      if (msg.code === "unauthorized") await forgetPairing("revoked");
      return;
    }
    case "capture:failed":
      await dispatch({
        type: "failed",
        source: msg.source,
        streamId: msg.streamId,
        kind: msg.code === "mic_denied" ? "mic_denied" : "capture_failed",
        detail: msg.message,
        at: Date.now(),
      });
      return;
    case "capture:ended":
      await dispatch({
        type: "captureEnded",
        source: msg.source,
        streamId: msg.streamId,
        reason: msg.reason,
      });
      await closeOffscreenIfIdle();
      return;
  }
}

export async function handleUi(msg: FromUi): Promise<unknown> {
  switch (msg.kind) {
    case "ui:hello":
      void reconcile();
      void refreshAccount();
      return readState();
    case "ui:start":
      return startCapture(msg.source, msg.tabId);
    case "ui:stop":
      await stopCapture(msg.source, "user");
      return { ok: true };
    case "ui:refresh":
      return refreshAccount();
    case "ui:paired":
      await dispatch({ type: "paired" });
      return refreshAccount();
    case "ui:unpair":
      await forgetPairing("user");
      return { ok: true };
    case "ui:dismissError":
      await dispatch({ type: "dismissError" });
      return { ok: true };
  }
}

export async function handleContent(
  msg: FromContent,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const tabId = sender.tab?.id;
  const host = hostnameOf(sender.url ?? sender.tab?.url);
  // Only our own content script on a known meeting host may talk to us this way.
  if (tabId === undefined || !host || !meetingHostFor(host)) return { offer: false };
  switch (msg.kind) {
    case "content:meeting": {
      const prefs = await loadPreferences();
      const wanted = prefs.autoOffer && !prefs.neverOfferOn.includes(host);
      // The "meeting detected" hint (badge dot) follows the same opt-out as the banner.
      const state = await dispatch({
        type: "meetingTab",
        tabId,
        info: msg.inCall && wanted ? { app: host, title: msg.title.slice(0, 300) } : null,
      });
      if (!msg.inCall) {
        // The call in the recorded tab is over: stop rather than record an empty lobby.
        if (state.captures.tab?.tabId === tabId) await stopCapture("tab", "call_ended");
        return { offer: false } satisfies MeetingOfferReply;
      }
      const offer =
        wanted &&
        state.paired &&
        state.consent !== "required" &&
        !state.ingestPaused &&
        state.captures.tab?.tabId !== tabId;
      return { offer } satisfies MeetingOfferReply;
    }
    case "content:start": {
      const result = await startCapture("tab", tabId);
      if (!result.ok && result.reason === "needs_invocation") {
        // Point at the toolbar button. openPopup needs a focused window and is not
        // available everywhere; the banner text explains the click either way.
        await chrome.action.openPopup?.().catch(() => undefined);
        const commands = await chrome.commands.getAll().catch(() => []);
        const shortcut = commands.find((c) => c.name === "toggle-tab-capture")?.shortcut ?? "";
        return { ...result, shortcut };
      }
      return result;
    }
    case "content:never": {
      const prefs = await loadPreferences();
      if (!prefs.neverOfferOn.includes(host)) {
        await savePreferences({ neverOfferOn: [...prefs.neverOfferOn, host] });
      }
      return { ok: true };
    }
  }
}

// ------------------------------------------------------------------------- tabs

export async function onTabRemoved(tabId: number): Promise<void> {
  const state = await readState();
  if (state.captures.tab?.tabId === tabId) await stopCapture("tab", "tab_closed");
  await dispatch({ type: "tabGone", tabId });
}

/**
 * Tab capture follows the tab across navigations, so "navigated away" has to be detected
 * here. Without the `tabs` permission `changeInfo.url` is withheld, but activeTab keeps
 * the URL readable for same-origin navigations: an unreadable URL or another hostname
 * means the user left the site that was being recorded.
 */
export async function onTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
): Promise<void> {
  if (changeInfo.status !== "loading") return;
  const state = await readState();
  const cur = state.captures.tab;
  if (!cur || cur.tabId !== tabId) return;
  const ctx = await tabContext(tabId);
  const host = hostnameOf(ctx.url);
  if (!host || host !== cur.app) await stopCapture("tab", "navigated_away");
}

export async function onCommand(command: string, tab?: chrome.tabs.Tab): Promise<void> {
  if (command !== "toggle-tab-capture") return;
  const state = await readState();
  if (state.captures.tab) {
    await stopCapture("tab", "user");
    return;
  }
  const tabId = tab?.id;
  if (tabId === undefined) return;
  const result = await startCapture("tab", tabId);
  if (!result.ok) {
    await dispatch({
      type: "failed",
      source: "tab",
      kind:
        result.reason === "restricted_tab" || result.reason === "needs_invocation"
          ? result.reason
          : result.reason === "consent_required" || result.reason === "ingest_paused"
            ? result.reason
            : "capture_failed",
      detail: result.ok ? "" : (result.message ?? result.reason),
      at: Date.now(),
    });
    // The popup is where the details are; open it if Chrome lets us.
    await chrome.action.openPopup?.().catch(() => undefined);
  }
}
