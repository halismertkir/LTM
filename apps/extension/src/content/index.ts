/**
 * Content script, injected only on the meeting hosts in shared/meetingHosts.ts. Built as a
 * classic IIFE (content scripts cannot be ES modules).
 *
 * It never records anything: it notices that a call is in progress and offers a small
 * banner. Starting has to go through the worker, and Chrome only allows tab capture after
 * the user invoked the extension on this tab (toolbar click or shortcut) — a click on a
 * page element, even our own banner, does not count. The banner explains that when needed.
 *
 * Only the tab title is sent to the worker; the worker takes the hostname from the sender
 * and never forwards the URL.
 */
import { loadPreferences } from "../shared/config.js";
import {
  browserLanguage,
  resolveLocale,
  type Translate,
  translator,
} from "../shared/i18n/index.js";
import { meetingHostFor } from "../shared/meetingHosts.js";
import type { FromContent, MeetingOfferReply, StartResult } from "../shared/messages.js";
import { CallStateDebouncer, detectInCall } from "./detect.js";

const POLL_MS = 2000;

const BANNER_CSS = `
:host { all: initial; }
.box {
  position: fixed; top: 16px; right: 16px; z-index: 2147483647;
  max-width: 340px; padding: 12px 14px; border-radius: 12px;
  background: #ffffff; color: #1c1f23; border: 1px solid #d9dde3;
  box-shadow: 0 6px 24px rgba(0,0,0,.18);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .box { background: #212429; color: #e8eaed; border-color: #3a3f46; }
}
.title { display: flex; align-items: center; gap: 8px; font-weight: 600; margin: 0 0 10px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #d93025; flex: none; }
.msg { margin: 0 0 10px; font-size: 13px; }
.row { display: flex; gap: 6px; flex-wrap: wrap; }
button {
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  border-radius: 8px; padding: 6px 12px; border: 1px solid #d9dde3;
  background: transparent; color: inherit;
}
button.primary { background: #1d5fd1; border-color: #1d5fd1; color: #fff; }
button:focus-visible { outline: 2px solid #1d5fd1; outline-offset: 2px; }
`;

class Banner {
  private host: HTMLElement | null = null;
  private box: HTMLElement | null = null;

  constructor(private readonly t: Translate) {}

  show(handlers: { start(): void; notNow(): void; never(): void }): void {
    this.mount();
    const { t } = this;
    this.render(t("banner.question"), null, [
      { label: t("banner.start"), primary: true, onClick: handlers.start },
      { label: t("banner.notNow"), onClick: handlers.notNow },
      { label: t("banner.never"), onClick: handlers.never },
    ]);
  }

  message(title: string, text: string | null, autoHideMs?: number): void {
    this.mount();
    this.render(title, text, [{ label: this.t("banner.close"), onClick: () => this.hide() }]);
    if (autoHideMs) setTimeout(() => this.hide(), autoHideMs);
  }

  hide(): void {
    this.host?.remove();
    this.host = null;
    this.box = null;
  }

  private mount(): void {
    if (this.host) return;
    const host = document.createElement("ltm-banner");
    // Closed shadow root: the page's CSS cannot restyle (or read) the banner and ours
    // cannot leak into the page.
    const shadow = host.attachShadow({ mode: "closed" });
    try {
      // Constructable stylesheets are not subject to the page's CSP style-src (an inline
      // <style> may be on strict sites).
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(BANNER_CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = BANNER_CSS;
      shadow.appendChild(style);
    }
    const box = document.createElement("div");
    box.className = "box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-live", "polite");
    shadow.appendChild(box);
    document.documentElement.appendChild(host);
    this.host = host;
    this.box = box;
  }

  private render(
    title: string,
    text: string | null,
    buttons: { label: string; primary?: boolean; onClick(): void }[],
  ): void {
    const box = this.box!;
    box.replaceChildren();
    const head = document.createElement("p");
    head.className = "title";
    const dot = document.createElement("span");
    dot.className = "dot";
    head.append(dot, document.createTextNode(title));
    box.appendChild(head);
    if (text) {
      const p = document.createElement("p");
      p.className = "msg";
      p.textContent = text;
      box.appendChild(p);
    }
    const row = document.createElement("div");
    row.className = "row";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = b.label;
      if (b.primary) btn.className = "primary";
      btn.addEventListener("click", b.onClick);
      row.appendChild(btn);
    }
    box.appendChild(row);
  }
}

function send<T>(msg: FromContent): Promise<T | null> {
  return (chrome.runtime.sendMessage(msg) as Promise<T>).catch(() => null);
}

async function main(): Promise<void> {
  const host = meetingHostFor(location.hostname);
  if (!host || window.top !== window) return; // top frame only
  const prefs = await loadPreferences();
  const t = translator(resolveLocale(prefs.uiLanguage, browserLanguage()));
  const banner = new Banner(t);
  const debouncer = new CallStateDebouncer();
  let dismissedThisCall = false;

  const onChange = async (inCall: boolean) => {
    if (!inCall) {
      dismissedThisCall = false;
      banner.hide();
    }
    const reply = await send<MeetingOfferReply>({
      target: "background",
      kind: "content:meeting",
      inCall,
      title: document.title.slice(0, 300),
    });
    if (!inCall || !reply?.offer || dismissedThisCall) return;
    banner.show({
      start: () => {
        dismissedThisCall = true;
        void send<StartResult & { shortcut?: string }>({
          target: "background",
          kind: "content:start",
        }).then((res) => {
          if (res?.ok) {
            banner.message(t("banner.started"), null, 6000);
          } else if (res && res.reason === "needs_invocation") {
            banner.message(
              t("banner.question"),
              t("banner.needsClick", { shortcut: res.shortcut || "Alt+Shift+L" }),
            );
          } else {
            banner.message(
              t("state.error"),
              t("error.capture_failed", {
                detail: res && !res.ok ? (res.message ?? res.reason) : "—",
              }),
            );
          }
        });
      },
      notNow: () => {
        dismissedThisCall = true;
        banner.hide();
      },
      never: () => {
        dismissedThisCall = true;
        banner.hide();
        void send({ target: "background", kind: "content:never" });
      },
    });
  };

  const poll = () => {
    const changed = debouncer.update(detectInCall(host, document, location));
    if (changed !== null) void onChange(changed);
  };
  setInterval(poll, POLL_MS);
  poll();
}

void main();
