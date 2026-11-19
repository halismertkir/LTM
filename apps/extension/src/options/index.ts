import { CONSENT_DOCUMENTS, type ConsentState, type Locale, PROTOCOL_VERSION } from "@ltm/protocol";
import { ON_DEVICE_TRANSCRIPTION_AVAILABLE } from "../offscreen/transcriber.js";
import { ApiClient, ApiError } from "../shared/api.js";
import {
  loadPairing,
  loadPreferences,
  type Pairing,
  type Preferences,
  STORAGE_KEYS,
  savePreferences,
} from "../shared/config.js";
import { h, renderMarkdown, replaceChildren } from "../shared/dom.js";
import {
  browserLanguage,
  resolveLocale,
  type Translate,
  translator,
} from "../shared/i18n/index.js";
import type { FromUi } from "../shared/messages.js";
import {
  isInsecureRemote,
  normalizeServerUrl,
  originPattern,
  parsePairingInput,
} from "../shared/url.js";
import "../ui/common.css";
import "./options.css";

const LANGUAGE_HINTS = [
  "en",
  "tr",
  "de",
  "fr",
  "es",
  "it",
  "pt",
  "nl",
  "pl",
  "ru",
  "uk",
  "ar",
  "hi",
  "ja",
  "ko",
  "zh",
];

interface Model {
  locale: Locale;
  t: Translate;
  prefs: Preferences;
  pairing: Pairing | null;
  consent: ConsentState | null;
  consentError: string | null;
  consentChecked: Set<string>;
  consentFlash: string | null;
  pairStatus: { kind: "ok" | "error" | "warn" | "info"; text: string } | null;
  pairBusy: boolean;
  mic: PermissionState | "unknown";
  shortcut: string | null;
  prefsSaved: boolean;
  draft: { server: string; code: string; name: string };
}

const root = document.getElementById("app")!;
let m: Model;

function send(msg: FromUi): Promise<unknown> {
  return chrome.runtime.sendMessage(msg).catch(() => undefined);
}

function defaultDeviceName(): string {
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform || navigator.platform || "";
  return platform ? `Chrome on ${platform}` : "Chrome";
}

function platformString(): string {
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return (uaData?.platform || navigator.platform || "unknown").slice(0, 80);
}

// ------------------------------------------------------------------ pairing

function onPairSubmit(ev: Event): void {
  ev.preventDefault();
  if (m.pairBusy) return;
  const { t } = m;
  const parsed = parsePairingInput(m.draft.code);
  let serverUrl: string;
  try {
    serverUrl = normalizeServerUrl(parsed.server ?? m.draft.server);
  } catch {
    m.pairStatus = { kind: "error", text: t("pair.notLtm") };
    render();
    return;
  }
  m.draft.server = serverUrl;
  m.draft.code = parsed.code;
  const origin = originPattern(serverUrl);
  // chrome.permissions.request must be called while the click's user activation is still
  // valid — i.e. before the first `await`, or Chrome rejects it.
  const permission = chrome.permissions.request({ origins: [origin] });
  m.pairBusy = true;
  m.pairStatus = { kind: "info", text: t("pair.checking") };
  render();
  void pair(serverUrl, parsed.code, permission);
}

async function pair(serverUrl: string, code: string, permission: Promise<boolean>): Promise<void> {
  const { t } = m;
  const origin = new URL(serverUrl).origin;
  try {
    const granted = await permission.catch(() => false);
    if (!granted) {
      m.pairStatus = { kind: "error", text: t("pair.permissionDenied", { origin }) };
      return;
    }
    const api = new ApiClient({ serverUrl });
    let version: Awaited<ReturnType<ApiClient["version"]>>;
    try {
      version = await api.version();
    } catch {
      m.pairStatus = { kind: "error", text: t("pair.notLtm") };
      return;
    }
    if (version.protocol !== PROTOCOL_VERSION) {
      m.pairStatus = {
        kind: "error",
        text: t("pair.protocolMismatch", { server: version.protocol, client: PROTOCOL_VERSION }),
      };
      return;
    }
    m.pairStatus = { kind: "info", text: t("pair.pairing") };
    render();
    const name = (m.draft.name.trim() || defaultDeviceName()).slice(0, 80);
    const res = await api.pair({
      code: code.trim(),
      name,
      kind: "browser_extension",
      platform: platformString(),
      appVersion: chrome.runtime.getManifest().version,
    });
    const pairing: Pairing = {
      serverUrl,
      token: res.token,
      deviceId: res.device.id,
      deviceName: res.device.name,
      userDisplayName: res.user.displayName,
      userLocale: res.user.locale,
      pairedAt: Date.now(),
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.pairing]: pairing });
    m.pairing = pairing;
    m.draft.code = "";
    m.pairStatus = null;
    await send({ target: "background", kind: "ui:paired" });
    await loadConsent();
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.code === "not_found" ||
        err.code === "unauthorized" ||
        err.code === "bad_request" ||
        err.code === "conflict")
    ) {
      m.pairStatus = { kind: "error", text: t("pair.badCode") };
    } else {
      m.pairStatus = {
        kind: "error",
        text: t("pair.failed", { detail: err instanceof Error ? err.message : String(err) }),
      };
    }
  } finally {
    m.pairBusy = false;
    render();
  }
}

async function unpair(): Promise<void> {
  if (!confirm(m.t("pair.unpairConfirm"))) return;
  await send({ target: "background", kind: "ui:unpair" });
  // The worker also removes it; do it here too in case the worker is not reachable.
  await chrome.storage.local.remove(STORAGE_KEYS.pairing);
  m.pairing = null;
  m.consent = null;
  m.pairStatus = { kind: "ok", text: `${m.t("pair.unpaired")} ${m.t("pair.revokeHint")}` };
  render();
}

function pairingSection(): HTMLElement {
  const { t } = m;
  if (m.pairing) {
    const p = m.pairing;
    return section(
      t("pair.heading"),
      h(
        "p",
        { class: "ok-line", "data-testid": "paired" },
        "✓ ",
        t("pair.paired", { server: p.serverUrl, device: p.deviceName, user: p.userDisplayName }),
      ),
      isInsecureRemote(p.serverUrl)
        ? h("div", { class: "flash flash-warn" }, t("pair.insecure"))
        : null,
      h(
        "div",
        { class: "row" },
        h(
          "button",
          { class: "btn btn-danger", type: "button", onclick: () => void unpair() },
          t("pair.unpair"),
        ),
      ),
      m.pairStatus ? status(m.pairStatus) : null,
    );
  }
  let insecure = false;
  try {
    insecure = !!m.draft.server.trim() && isInsecureRemote(normalizeServerUrl(m.draft.server));
  } catch {
    insecure = false;
  }
  let originText = "";
  try {
    originText = m.draft.server.trim() ? new URL(normalizeServerUrl(m.draft.server)).origin : "";
  } catch {
    originText = "";
  }
  const form = h(
    "form",
    { class: "form", onsubmit: onPairSubmit },
    field(
      t("pair.serverUrl"),
      h("input", {
        type: "url",
        id: "server",
        required: true,
        inputmode: "url",
        autocomplete: "url",
        spellcheck: "false",
        placeholder: t("pair.serverUrl.placeholder"),
        value: m.draft.server,
        oninput: (e: Event) => {
          m.draft.server = (e.target as HTMLInputElement).value;
          renderSoon();
        },
      }),
    ),
    insecure
      ? h("div", { class: "flash flash-warn", "data-testid": "insecure" }, t("pair.insecure"))
      : null,
    field(
      t("pair.code"),
      h("input", {
        type: "text",
        id: "code",
        required: true,
        autocomplete: "one-time-code",
        spellcheck: "false",
        placeholder: t("pair.code.placeholder"),
        value: m.draft.code,
        oninput: (e: Event) => {
          m.draft.code = (e.target as HTMLInputElement).value;
          const parsed = parsePairingInput(m.draft.code);
          if (parsed.server) {
            // Pasted the full ltm://pair link: fill both fields from it.
            m.draft.server = parsed.server;
            m.draft.code = parsed.code;
            render();
          }
        },
      }),
      t("pair.code.help"),
    ),
    field(
      t("pair.deviceName"),
      h("input", {
        type: "text",
        id: "device-name",
        maxlength: 80,
        value: m.draft.name,
        oninput: (e: Event) => {
          m.draft.name = (e.target as HTMLInputElement).value;
        },
      }),
    ),
    originText
      ? h("p", { class: "help" }, t("pair.permissionExplain", { origin: originText }))
      : null,
    h(
      "div",
      { class: "row" },
      h(
        "button",
        { class: "btn btn-primary", type: "submit", disabled: m.pairBusy },
        t("pair.submit"),
      ),
    ),
    m.pairStatus ? status(m.pairStatus) : null,
  );
  return section(t("pair.heading"), form);
}

// ------------------------------------------------------------------ consent

async function loadConsent(): Promise<void> {
  if (!m.pairing) return;
  try {
    const me = await new ApiClient({ serverUrl: m.pairing.serverUrl, token: m.pairing.token }).me();
    m.consent = me.consent;
    m.consentError = null;
  } catch (err) {
    if (err instanceof ApiError && err.code === "unauthorized") {
      await send({ target: "background", kind: "ui:refresh" });
      m.pairing = await loadPairing();
      m.pairStatus = m.pairing ? null : { kind: "error", text: m.t("error.unauthorized") };
    }
    m.consentError = err instanceof Error ? err.message : String(err);
  }
  render();
}

async function acceptConsent(): Promise<void> {
  if (!m.pairing || !m.consent) return;
  const accept = m.consent.required
    .filter((r) => !r.accepted && m.consentChecked.has(r.type))
    .map((r) => ({ type: r.type, version: r.version }));
  if (!accept.length) return;
  try {
    m.consent = await new ApiClient({
      serverUrl: m.pairing.serverUrl,
      token: m.pairing.token,
    }).acceptConsents({ accept });
    m.consentChecked.clear();
    m.consentFlash = m.t("consent.accepted");
    await send({ target: "background", kind: "ui:refresh" });
  } catch (err) {
    m.consentError = err instanceof Error ? err.message : String(err);
  }
  render();
}

function consentSection(): HTMLElement {
  const { t, locale } = m;
  if (!m.pairing)
    return section(t("consent.heading"), h("p", { class: "muted" }, t("consent.unavailable")));
  if (m.consentError && !m.consent) {
    return section(
      t("consent.heading"),
      status({ kind: "error", text: t("consent.loadFailed", { detail: m.consentError }) }),
    );
  }
  if (!m.consent) return section(t("consent.heading"), h("p", { class: "muted" }, "…"));

  const pending = m.consent.required.filter((r) => !r.accepted);
  const accepted = m.consent.required.filter((r) => r.accepted);
  const acceptedDetails = accepted.map((r) => {
    const doc = CONSENT_DOCUMENTS.find((d) => d.type === r.type);
    if (!doc) return null;
    return h(
      "details",
      { class: "doc doc-accepted" },
      h(
        "summary",
        null,
        `✓ ${doc[locale].title}`,
        h("span", { class: "muted" }, ` · ${r.version}`),
      ),
      h("div", { class: "doc-body" }, renderMarkdown(doc[locale].body)),
    );
  });

  if (!pending.length) {
    return section(
      t("consent.heading"),
      h("p", { class: "ok-line", "data-testid": "consent-ok" }, "✓ ", t("consent.satisfied")),
      ...acceptedDetails,
      m.consentFlash ? status({ kind: "ok", text: m.consentFlash }) : null,
    );
  }

  let acceptable = 0;
  const docs = pending.map((r) => {
    const doc = CONSENT_DOCUMENTS.find((d) => d.type === r.type);
    if (!doc || doc.version !== r.version) {
      return h(
        "div",
        { class: "flash flash-warn" },
        t("consent.versionMismatch", {
          title: doc?.[locale].title ?? r.type,
          server: r.version,
          local: doc?.version ?? "—",
        }),
      );
    }
    acceptable++;
    const text = doc[locale];
    const id = `consent-${r.type}`;
    return h(
      "article",
      { class: "doc" },
      h("h3", null, text.title),
      h("div", { class: "doc-body" }, renderMarkdown(text.body)),
      h(
        "label",
        { class: "check", for: id },
        h("input", {
          type: "checkbox",
          id,
          checked: m.consentChecked.has(r.type),
          onchange: (e: Event) => {
            if ((e.target as HTMLInputElement).checked) m.consentChecked.add(r.type);
            else m.consentChecked.delete(r.type);
            render();
          },
        }),
        h("span", null, t("consent.checkbox", { title: text.title })),
      ),
    );
  });
  const allChecked =
    acceptable > 0 &&
    pending.every((r) => {
      const doc = CONSENT_DOCUMENTS.find((d) => d.type === r.type);
      return !doc || doc.version !== r.version || m.consentChecked.has(r.type);
    });
  return section(
    t("consent.heading"),
    h("div", { class: "flash flash-warn" }, t("consent.required")),
    ...docs,
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          disabled: !allChecked,
          onclick: () => void acceptConsent(),
        },
        t("consent.accept"),
      ),
    ),
    m.consentError ? status({ kind: "error", text: m.consentError }) : null,
    ...acceptedDetails,
  );
}

// ------------------------------------------------------------------ microphone

async function watchMicPermission(): Promise<void> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    m.mic = status.state;
    status.onchange = () => {
      m.mic = status.state;
      render();
    };
  } catch {
    m.mic = "unknown";
  }
}

async function grantMic(): Promise<void> {
  try {
    // Asking here, on a visible extension page, is what makes the microphone usable in the
    // offscreen document later (which cannot show a permission prompt itself).
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const tr of stream.getTracks()) tr.stop();
    m.mic = "granted";
  } catch {
    m.mic = "denied";
  }
  render();
}

function micSection(): HTMLElement {
  const { t } = m;
  const state =
    m.mic === "granted"
      ? h("p", { class: "ok-line", "data-testid": "mic-ok" }, "✓ ", t("mic.granted"))
      : m.mic === "denied"
        ? status({ kind: "error", text: t("mic.denied") })
        : h("p", { class: "muted" }, t("mic.prompt"));
  return section(
    t("mic.heading"),
    h("p", null, t("mic.explain")),
    state,
    m.mic !== "granted"
      ? h(
          "div",
          { class: "row" },
          h(
            "button",
            { class: "btn btn-primary", type: "button", onclick: () => void grantMic() },
            t("mic.grant"),
          ),
        )
      : null,
  );
}

// ------------------------------------------------------------------ preferences

async function setPref(patch: Partial<Preferences>): Promise<void> {
  m.prefs = await savePreferences(patch);
  if (patch.uiLanguage) applyLocale();
  m.prefsSaved = true;
  render();
  setTimeout(() => {
    m.prefsSaved = false;
    render();
  }, 1500);
}

function checkbox(
  id: string,
  label: string,
  help: string | null,
  checked: boolean,
  onChange: (v: boolean) => void,
  disabled = false,
): HTMLElement {
  return h(
    "div",
    { class: "pref" },
    h(
      "label",
      { class: "check", for: id },
      h("input", {
        type: "checkbox",
        id,
        checked,
        disabled,
        onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
      }),
      h("span", null, label),
    ),
    help ? h("p", { class: "help" }, help) : null,
  );
}

function prefsSection(): HTMLElement {
  const { t, prefs, locale } = m;
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: "language" });
  } catch {
    names = null;
  }
  const langSelect = h(
    "select",
    {
      id: "language",
      onchange: (e: Event) => void setPref({ language: (e.target as HTMLSelectElement).value }),
    },
    h("option", { value: "", selected: prefs.language === "" }, t("prefs.language.auto")),
    ...LANGUAGE_HINTS.map((code) =>
      h("option", { value: code, selected: prefs.language === code }, names?.of(code) ?? code),
    ),
  );
  const uiSelect = h(
    "select",
    {
      id: "ui-language",
      onchange: (e: Event) =>
        void setPref({
          uiLanguage: (e.target as HTMLSelectElement).value as Preferences["uiLanguage"],
        }),
    },
    h(
      "option",
      { value: "auto", selected: prefs.uiLanguage === "auto" },
      t("prefs.uiLanguage.auto"),
    ),
    h("option", { value: "en", selected: prefs.uiLanguage === "en" }, "English"),
    h("option", { value: "tr", selected: prefs.uiLanguage === "tr" }, "Türkçe"),
  );
  return section(
    t("prefs.heading"),
    checkbox(
      "auto-offer",
      t("prefs.autoOffer"),
      t("prefs.autoOffer.help"),
      prefs.autoOffer,
      (v) => void setPref({ autoOffer: v }),
    ),
    prefs.neverOfferOn.length
      ? h(
          "p",
          { class: "help indent" },
          t("prefs.neverOfferOn", { sites: prefs.neverOfferOn.join(", ") }),
          " ",
          h(
            "button",
            { class: "link", type: "button", onclick: () => void setPref({ neverOfferOn: [] }) },
            t("prefs.clearNever"),
          ),
        )
      : null,
    checkbox(
      "mic-with-tab",
      t("prefs.micWithTab"),
      t("prefs.micWithTab.help"),
      prefs.micWithTab,
      (v) => void setPref({ micWithTab: v }),
    ),
    h(
      "div",
      { class: "grid2" },
      field(t("prefs.language"), langSelect),
      field(t("prefs.uiLanguage"), uiSelect),
    ),
    m.prefsSaved ? h("p", { class: "saved", role: "status" }, t("prefs.saved")) : null,
  );
}

function onDeviceSection(): HTMLElement {
  const { t } = m;
  return section(
    t("ondevice.heading"),
    checkbox(
      "on-device",
      t("ondevice.toggle"),
      null,
      ON_DEVICE_TRANSCRIPTION_AVAILABLE && m.prefs.onDeviceTranscription,
      (v) => void setPref({ onDeviceTranscription: v }),
      !ON_DEVICE_TRANSCRIPTION_AVAILABLE,
    ),
    ON_DEVICE_TRANSCRIPTION_AVAILABLE
      ? null
      : h("p", { class: "badge-exp" }, t("ondevice.unavailable")),
    h("p", { class: "help" }, t("ondevice.explain")),
  );
}

function shortcutSection(): HTMLElement {
  const { t } = m;
  return section(
    t("shortcut.heading"),
    h("p", null, t("shortcut.current", { shortcut: m.shortcut || t("shortcut.none") })),
    h("p", { class: "help" }, t("shortcut.change")),
  );
}

// ------------------------------------------------------------------ layout helpers

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h("section", { class: "card" }, h("h2", null, title), ...children);
}

function field(label: string, control: HTMLElement, help?: string): HTMLElement {
  const id = control.getAttribute("id") ?? "";
  return h(
    "div",
    { class: "field" },
    h("label", { for: id }, label),
    control,
    help ? h("p", { class: "help" }, help) : null,
  );
}

function status(s: { kind: "ok" | "error" | "warn" | "info"; text: string }): HTMLElement {
  const cls = s.kind === "info" ? "flash" : `flash flash-${s.kind}`;
  return h("div", { class: cls, role: s.kind === "error" ? "alert" : "status" }, s.text);
}

let renderQueued = false;
function renderSoon(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render(): void {
  // The page is re-rendered from the model; keep focus (and the caret while typing) on the
  // control the user is on, so keyboard and screen-reader users are not thrown to the top.
  const active = document.activeElement as HTMLInputElement | null;
  const focusId = active && active !== document.body ? active.id : "";
  let caret: number | null = null;
  try {
    caret = active?.selectionStart ?? null;
  } catch {
    caret = null;
  }
  renderPage();
  if (focusId) {
    const el = document.getElementById(focusId) as HTMLInputElement | null;
    el?.focus();
    if (el && caret !== null) {
      try {
        el.setSelectionRange(caret, caret);
      } catch {
        // checkboxes and type=url inputs have no selection range
      }
    }
  }
}

function renderPage(): void {
  document.documentElement.lang = m.locale;
  document.title = m.t("options.title");
  replaceChildren(
    root,
    h(
      "header",
      { class: "page-head" },
      h("img", { src: "icons/idle-48.png", alt: "", width: 40, height: 40 }),
      h(
        "div",
        null,
        h("h1", null, m.t("options.title")),
        h("p", { class: "muted" }, m.t("options.intro")),
      ),
    ),
    pairingSection(),
    consentSection(),
    micSection(),
    prefsSection(),
    onDeviceSection(),
    shortcutSection(),
  );
}

function applyLocale(): void {
  m.locale = resolveLocale(m.prefs.uiLanguage, browserLanguage());
  m.t = translator(m.locale);
}

async function main(): Promise<void> {
  const [prefs, pairing, commands] = await Promise.all([
    loadPreferences(),
    loadPairing(),
    chrome.commands.getAll().catch(() => [] as chrome.commands.Command[]),
  ]);
  m = {
    locale: "en",
    t: translator("en"),
    prefs,
    pairing,
    consent: null,
    consentError: null,
    consentChecked: new Set(),
    consentFlash: null,
    pairStatus: null,
    pairBusy: false,
    mic: "unknown",
    shortcut: commands.find((c) => c.name === "toggle-tab-capture")?.shortcut || null,
    prefsSaved: false,
    draft: { server: "", code: "", name: defaultDeviceName() },
  };
  applyLocale();
  await watchMicPermission();
  render();
  if (pairing) void loadConsent();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (STORAGE_KEYS.pairing in changes) {
      void loadPairing().then((p) => {
        const wasPaired = !!m.pairing;
        m.pairing = p;
        if (!p) m.consent = null;
        if (p && !wasPaired) void loadConsent();
        render();
      });
    }
    if (STORAGE_KEYS.prefs in changes) {
      void loadPreferences().then((p) => {
        m.prefs = p;
        applyLocale();
        render();
      });
    }
  });
}

void main();
