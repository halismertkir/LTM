import { type Locale, NOTICE_TEMPLATES } from "@ltm/protocol";
import { type AppState, deriveView, INITIAL_STATE, type View } from "../background/machine.js";
import {
  loadPairing,
  loadPreferences,
  type Pairing,
  SESSION_STATE_KEY as STATE_KEY,
  STORAGE_KEYS,
} from "../shared/config.js";
import { h, replaceChildren } from "../shared/dom.js";
import {
  browserLanguage,
  type MessageKey,
  resolveLocale,
  type Translate,
  translator,
} from "../shared/i18n/index.js";
import type { CaptureSource, FromUi, StartResult } from "../shared/messages.js";
import "../ui/common.css";
import "./popup.css";

interface Model {
  state: AppState;
  pairing: Pairing | null;
  locale: Locale;
  t: Translate;
  activeTab: chrome.tabs.Tab | null;
  shortcut: string | null;
  flash: { text: string; kind: "ok" | "error" } | null;
  busy: CaptureSource | null;
}

const root = document.getElementById("app")!;
let model: Model;

function send<T = unknown>(msg: FromUi): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function isRestricted(url: string | undefined): boolean {
  return !!url && !/^https?:/i.test(url);
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`;
}

function headline(view: View, m: Model): { title: string; sub: string; tone: string } {
  const { t } = m;
  switch (view.kind) {
    case "not_paired":
      return { title: t("state.notPaired"), sub: t("state.notPaired.sub"), tone: "muted" };
    case "consent_needed":
      return { title: t("state.consent"), sub: t("state.consent.sub"), tone: "warn" };
    case "paused":
      return { title: t("state.paused"), sub: t("state.paused.sub"), tone: "paused" };
    case "error":
      return { title: t("state.error"), sub: errorText(m), tone: "error" };
    case "idle":
      return { title: t("state.idle"), sub: t("state.idle.sub"), tone: "idle" };
    case "listening": {
      const thisTab = view.tab && view.tab.tabId === m.activeTab?.id;
      const key: MessageKey = view.tab
        ? view.mic
          ? thisTab
            ? "state.listening.tabMic"
            : "state.listening.otherTabMic"
          : thisTab
            ? "state.listening.tab"
            : "state.listening.otherTab"
        : "state.listening.mic";
      const where = view.tab ? [view.tab.app, view.tab.title].filter(Boolean).join(" · ") : "";
      return { title: t(key), sub: where, tone: "rec" };
    }
  }
}

function errorText(m: Model): string {
  const e = m.state.error;
  if (!e) return "";
  const key = `error.${e.kind}` as MessageKey;
  return m.t(key, { detail: e.detail || "—" });
}

function statusLine(view: View, m: Model): string | null {
  const sessions = [view.tab, view.mic].filter((s) => !!s);
  if (sessions.some((s) => s.phase === "stopping")) return m.t("state.stopping");
  const reconnecting = sessions.find((s) => s.phase === "reconnecting");
  if (reconnecting) {
    return m.t("state.reconnecting", { seconds: Math.round(reconnecting.bufferedMs / 1000) });
  }
  if (sessions.some((s) => s.phase === "starting" || s.phase === "connecting"))
    return m.t("state.connecting");
  return null;
}

function noticeText(m: Model): string {
  const base = NOTICE_TEMPLATES.meetingChat[m.locale];
  return m.state.thirdPartyAi ? `${base} ${NOTICE_TEMPLATES.thirdPartyAi[m.locale]}` : base;
}

async function start(source: CaptureSource): Promise<void> {
  model.busy = source;
  model.flash = null;
  render();
  const msg: FromUi = { target: "background", kind: "ui:start", source };
  if (source === "tab" && model.activeTab?.id !== undefined) msg.tabId = model.activeTab.id;
  const res = await send<StartResult>(msg).catch(
    (err) => ({ ok: false, reason: "capture_failed", message: String(err) }) as StartResult,
  );
  model.busy = null;
  if (!res.ok) {
    const key: MessageKey =
      res.reason === "needs_invocation"
        ? "error.needs_invocation"
        : res.reason === "restricted_tab"
          ? "error.restricted_tab"
          : res.reason === "consent_required"
            ? "error.consent_required"
            : res.reason === "ingest_paused"
              ? "error.ingest_paused"
              : res.reason === "not_paired"
                ? "state.notPaired.sub"
                : "error.capture_failed";
    model.flash = { kind: "error", text: model.t(key, { detail: res.message ?? res.reason }) };
  }
  render();
}

async function stop(source: CaptureSource): Promise<void> {
  model.busy = source;
  render();
  await send({ target: "background", kind: "ui:stop", source }).catch(() => undefined);
  model.busy = null;
  render();
}

async function copyNotice(): Promise<void> {
  const text = noticeText(model);
  try {
    await navigator.clipboard.writeText(text);
    model.flash = { kind: "ok", text: model.t("popup.copied") };
  } catch {
    model.flash = { kind: "error", text: model.t("popup.copyFailed") };
  }
  render();
}

function openOptions(): void {
  void chrome.runtime.openOptionsPage();
  window.close();
}

function render(): void {
  const m = model;
  const { t } = m;
  const view = deriveView(m.state);
  const hl = headline(view, m);
  document.documentElement.lang = m.locale;

  const tabSession = view.tab;
  const micSession = view.mic;
  const canCapture =
    view.kind !== "not_paired" && view.kind !== "consent_needed" && view.kind !== "paused";
  const restricted = isRestricted(m.activeTab?.url);
  const status = statusLine(view, m);

  const tabButton = tabSession
    ? h(
        "button",
        {
          class: "btn btn-stop",
          disabled: m.busy === "tab" || tabSession.phase === "stopping",
          onclick: () => void stop("tab"),
        },
        t("popup.stopTab"),
      )
    : h(
        "button",
        {
          class: "btn btn-primary",
          disabled: !canCapture || restricted || m.busy === "tab",
          title: restricted ? t("popup.restrictedTab") : null,
          onclick: () => void start("tab"),
        },
        t("popup.recordTab"),
      );
  const micButton = micSession
    ? h(
        "button",
        {
          class: "btn btn-stop",
          disabled: m.busy === "mic" || micSession.phase === "stopping",
          onclick: () => void stop("mic"),
        },
        t("popup.stopMic"),
      )
    : h(
        "button",
        {
          class: "btn",
          disabled: !canCapture || m.busy === "mic",
          onclick: () => void start("mic"),
        },
        t("popup.recordMic"),
      );

  const caption =
    view.kind === "listening"
      ? h(
          "div",
          { class: "caption", "aria-live": "polite" },
          h("span", { class: "caption-label" }, t("popup.captionLabel")),
          h(
            "p",
            { class: m.state.caption ? "caption-text" : "caption-text caption-empty" },
            m.state.caption?.text ?? t("popup.captionWaiting"),
          ),
        )
      : null;

  const errorBox =
    m.state.error &&
    view.kind !== "error" &&
    // Already said by the headline:
    !(view.kind === "paused" && m.state.error.kind === "ingest_paused") &&
    !(view.kind === "consent_needed" && m.state.error.kind === "consent_required")
      ? h(
          "div",
          { class: "flash flash-error", role: "alert" },
          h("span", null, errorText(m)),
          h(
            "button",
            {
              class: "link",
              onclick: () => void send({ target: "background", kind: "ui:dismissError" }),
            },
            t("popup.dismiss"),
          ),
        )
      : null;

  const setup =
    view.kind === "not_paired"
      ? h("button", { class: "btn btn-primary btn-wide", onclick: openOptions }, t("popup.pair"))
      : view.kind === "consent_needed"
        ? h(
            "button",
            { class: "btn btn-primary btn-wide", onclick: openOptions },
            t("popup.reviewConsent"),
          )
        : null;

  const dashboard = m.pairing
    ? h(
        "a",
        { class: "link", href: m.pairing.serverUrl, target: "_blank", rel: "noopener noreferrer" },
        `${t("popup.dashboard")} ↗`,
      )
    : null;

  replaceChildren(
    root,
    h(
      "header",
      { class: "bar" },
      h("img", { src: "icons/idle-32.png", alt: "", width: 20, height: 20 }),
      h("span", { class: "brand" }, "LTM"),
      h(
        "button",
        {
          class: "icon-btn",
          title: t("popup.settings"),
          "aria-label": t("popup.settings"),
          onclick: openOptions,
        },
        "⚙",
      ),
    ),
    h(
      "section",
      { class: `state state-${hl.tone}`, "data-state": view.kind },
      h(
        "div",
        { class: "state-head" },
        view.kind === "listening" ? h("span", { class: "rec-dot", "aria-hidden": "true" }) : null,
        h("h1", null, hl.title),
      ),
      hl.sub ? h("p", { class: "state-sub" }, hl.sub) : null,
      view.since !== null
        ? h(
            "p",
            { class: "elapsed", "aria-label": t("popup.elapsed") },
            h("span", { id: "elapsed" }, fmtElapsed(Date.now() - view.since)),
          )
        : null,
      status ? h("p", { class: "state-status" }, status) : null,
    ),
    caption,
    setup,
    view.kind !== "not_paired" && view.kind !== "consent_needed"
      ? h("div", { class: "actions" }, tabButton, micButton)
      : null,
    view.kind === "listening" && micSession?.companionOf === "tab"
      ? h("p", { class: "hint" }, t("popup.micWithTab"))
      : null,
    m.flash
      ? h(
          "div",
          {
            class: `flash flash-${m.flash.kind}`,
            role: m.flash.kind === "error" ? "alert" : "status",
          },
          m.flash.text,
        )
      : null,
    errorBox,
    m.pairing
      ? h(
          "button",
          { class: "btn btn-secondary btn-wide", onclick: () => void copyNotice() },
          t("popup.copyNotice"),
        )
      : null,
    h(
      "footer",
      { class: "foot" },
      dashboard,
      m.shortcut
        ? h("span", { class: "muted" }, t("popup.shortcut", { shortcut: m.shortcut }))
        : null,
    ),
  );
}

async function refreshModel(): Promise<void> {
  const [session, pairing, prefs] = await Promise.all([
    chrome.storage.session.get(STATE_KEY),
    loadPairing(),
    loadPreferences(),
  ]);
  const locale = resolveLocale(prefs.uiLanguage, browserLanguage());
  model.state = (session[STATE_KEY] as AppState | undefined) ?? INITIAL_STATE;
  model.pairing = pairing;
  model.locale = locale;
  model.t = translator(locale);
}

async function main(): Promise<void> {
  model = {
    state: INITIAL_STATE,
    pairing: null,
    locale: "en",
    t: translator("en"),
    activeTab: null,
    shortcut: null,
    flash: null,
    busy: null,
  };
  const [tabs, commands] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [] as chrome.tabs.Tab[]),
    chrome.commands.getAll().catch(() => [] as chrome.commands.Command[]),
  ]);
  model.activeTab = tabs[0] ?? null;
  model.shortcut = commands.find((c) => c.name === "toggle-tab-capture")?.shortcut || null;
  await refreshModel();
  render();

  // Reconcile with the offscreen document and refresh consent/pause state from the server.
  void send({ target: "background", kind: "ui:hello" }).catch(() => undefined);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      (area === "session" && STATE_KEY in changes) ||
      (area === "local" && (STORAGE_KEYS.pairing in changes || STORAGE_KEYS.prefs in changes))
    ) {
      void refreshModel().then(render);
    }
  });

  setInterval(() => {
    const view = deriveView(model.state);
    const el = document.getElementById("elapsed");
    if (el && view.since !== null) el.textContent = fmtElapsed(Date.now() - view.since);
  }, 1000);
}

void main();
