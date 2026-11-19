#!/usr/bin/env node
// Loads the built extension (dist/) into Playwright's Chromium and checks it for real:
// the service worker registers, the options and popup pages render (EN + TR screenshots),
// the consent flow works against a local fake LTM server, and a microphone capture runs the
// whole offscreen pipeline (getUserMedia → AudioWorklet → gate → WebSocket) end to end with
// Chromium's fake audio device. It also opens a stand-in Google Meet page (served by
// Playwright's router) to exercise meeting detection and the in-page banner.
//
// Playwright is used from the global install (not a dependency of this package).
//
// Usage: pnpm build && node scripts/browser-check.mjs [screenshotDir]
//   default screenshot dir: $TMPDIR/ltm-extension-shots

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "../dist");
const shots = resolve(process.argv[2] ?? join(tmpdir(), "ltm-extension-shots"));
mkdirSync(shots, { recursive: true });

const globalRoot = execSync("npm root -g").toString().trim();
const { chromium } = await import(join(globalRoot, "playwright/index.mjs"));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10_000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(stepMs);
  }
}

// ----------------------------------------------------------------------------- fake server

const CONSENT_VERSION = "2026-11-19";
const server = {
  consent: { recording_responsibility: false, data_processing: false },
  ingestPaused: false,
  revoked: false,
  streams: new Map(),
  failNextHelloWith: null,
  log: [],
};

function consentState() {
  const required = Object.entries(server.consent).map(([type, accepted]) => ({
    type,
    version: CONSENT_VERSION,
    accepted,
  }));
  return {
    satisfied: required.every((r) => r.accepted),
    required,
    records: required
      .filter((r) => r.accepted)
      .map((r) => ({
        type: r.type,
        version: r.version,
        acceptedAt: new Date().toISOString(),
        via: "dev1",
      })),
  };
}

const http = createServer((req, res) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  const send = (status, body) => {
    res
      .writeHead(status, { ...cors, "content-type": "application/json" })
      .end(JSON.stringify(body));
  };
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    server.log.push(`${req.method} ${req.url}`);
    const authed =
      req.headers.authorization === "Bearer tok_browser_check_0123456789" && !server.revoked;
    if (req.url === "/api/v1/version")
      return send(200, { name: "ltm", version: "0.0.0-fake", protocol: 1 });
    if (!authed) return send(401, { error: { code: "unauthorized", message: "bad token" } });
    if (req.url === "/api/v1/me") {
      return send(200, {
        user: {
          id: "u1",
          email: "owner@example.org",
          displayName: "Test Owner",
          role: "owner",
          locale: "en",
          createdAt: "2026-11-19T00:00:00.000Z",
        },
        principal: { type: "device", deviceId: "dev1" },
        consent: consentState(),
        ingestPaused: server.ingestPaused,
      });
    }
    if (req.url === "/api/v1/consents" && req.method === "POST") {
      for (const a of JSON.parse(body).accept)
        if (a.version === CONSENT_VERSION) server.consent[a.type] = true;
      return send(200, consentState());
    }
    send(404, { error: { code: "not_found", message: req.url } });
  });
});

const wss = new WebSocketServer({ server: http, path: "/api/v1/ingest/ws" });
wss.on("connection", (ws, req) => {
  if (/tok_/.test(req.url ?? "")) server.log.push("ERROR token in URL");
  let stream = null;
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!stream) {
        server.log.push("ERROR frame before ready");
        return;
      }
      const b = Buffer.from(data);
      // Header layout from packages/protocol/src/frames.ts
      const ok = b.length >= 16 && b[0] === 0x4c && b[1] === 0x54 && b[2] === 1;
      stream.frames.push({
        ok,
        flags: b[3],
        seq: b.readUInt32LE(4),
        t: b.readDoubleLE(8),
        bytes: b.length - 16,
      });
      if (stream.frames.length === 5) {
        ws.send(
          JSON.stringify({
            type: "segment",
            segment: {
              startMs: Date.now() - 1000,
              endMs: Date.now(),
              text: "Hello from the fake LTM server.",
              origin: "server_stt",
            },
          }),
        );
      }
      return;
    }
    const msg = JSON.parse(String(data));
    if (msg.type === "hello") {
      if (msg.token !== "tok_browser_check_0123456789") {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "unauthorized",
            message: "bad token",
            fatal: true,
          }),
        );
        ws.close(4401);
        return;
      }
      if (server.failNextHelloWith) {
        const code = server.failNextHelloWith;
        server.failNextHelloWith = null;
        ws.send(JSON.stringify({ type: "error", code, message: `refused: ${code}`, fatal: true }));
        ws.close(4403);
        return;
      }
      stream = server.streams.get(msg.streamId) ?? { hello: msg, frames: [], ended: false };
      server.streams.set(msg.streamId, stream);
      ws.send(
        JSON.stringify({
          type: "ready",
          streamId: msg.streamId,
          serverTimeMs: Date.now(),
          resumed: false,
        }),
      );
    } else if (msg.type === "ping") {
      ws.send(
        JSON.stringify({ type: "pong", clientTimeMs: msg.clientTimeMs, serverTimeMs: Date.now() }),
      );
    } else if (msg.type === "end") {
      stream.ended = true;
      ws.send(JSON.stringify({ type: "closed", streamId: stream.hello.streamId }));
    }
  });
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const serverUrl = `http://127.0.0.1:${http.address().port}`;
console.log("fake LTM server at", serverUrl);

// ----------------------------------------------------------------------------- browser

const userDataDir = mkdtempSync(join(tmpdir(), "ltm-pw-profile-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  viewport: { width: 900, height: 900 },
  args: [
    "--headless=new",
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    // Chromium's fake capture device (a periodic beep) and auto-accepted permission prompts.
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const errors = [];
context.on("weberror", (e) => errors.push(`weberror: ${e.error().message}`));
const watch = (page, name) => {
  page.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${name} console: ${m.text()}`);
  });
  return page;
};

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
sw.on?.("console", (m) => {
  if (m.type() === "error") errors.push(`sw console: ${m.text()}`);
});
const extId = new URL(sw.url()).host;
const ext = (p) => `chrome-extension://${extId}/${p}`;
check("service worker registered", sw.url().endsWith("/background.js"), sw.url());
const swInfo = await sw.evaluate(() => ({
  version: chrome.runtime.getManifest().version,
  permissions: chrome.runtime.getManifest().permissions,
}));
check(
  "service worker runs (manifest readable)",
  swInfo.version === "0.1.0",
  JSON.stringify(swInfo),
);

// The worker opens the options page on install; give it a moment, then close extra tabs.
await sleep(800);
const onboarding = context.pages().find((p) => p.url().startsWith(ext("options.html")));
check("options page opened on first install", !!onboarding);
for (const p of context.pages()) if (p.url() !== "about:blank") await p.close();

const setLang = (lang) =>
  sw.evaluate(async (l) => {
    const cur = (await chrome.storage.local.get("prefs")).prefs ?? {};
    await chrome.storage.local.set({ prefs: { ...cur, uiLanguage: l } });
  }, lang);
const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
const offscreenOpen = () =>
  sw.evaluate(
    async () =>
      (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0,
  );

const options = watch(await context.newPage(), "options");
const popup = watch(await context.newPage(), "popup");
await popup.setViewportSize({ width: 340, height: 560 });

async function shoot(page, name) {
  await sleep(250);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

// --- A: not paired ------------------------------------------------------------------
for (const lang of ["en", "tr"]) {
  await setLang(lang);
  await options.goto(ext("options.html"));
  await options.waitForSelector("form");
  await shoot(options, `options-unpaired-${lang}`);
  await popup.goto(ext("popup.html"));
  await popup.waitForSelector("[data-state]");
  await shoot(popup, `popup-not-paired-${lang}`);
}
check(
  "popup shows 'not paired'",
  (await popup.getAttribute("[data-state]", "data-state")) === "not_paired",
);

await setLang("en");
await options.reload();
await options.fill("#server", "http://192.168.1.20:8080");
await options.waitForSelector("[data-testid=insecure]", { timeout: 3000 }).catch(() => null);
check(
  "plain-http LAN address shows the insecure warning",
  await options.isVisible("[data-testid=insecure]"),
);
await options.fill("#server", "http://localhost:8080");
await options
  .waitForSelector("[data-testid=insecure]", { state: "detached", timeout: 3000 })
  .catch(() => null);
check("localhost does not warn", !(await options.isVisible("[data-testid=insecure]")));
await options.fill("#code", "ltm://pair?server=https%3A%2F%2Fltm.example.org&code=K7QF-2MXD");
await sleep(100);
check(
  "pasting the pairing link fills server and code",
  (await options.inputValue("#server")) === "https://ltm.example.org" &&
    (await options.inputValue("#code")) === "K7QF-2MXD",
);
await shoot(options, "options-pair-form-en");

// --- B: paired, consent required ----------------------------------------------------
// chrome.permissions.request needs a real click on Chrome's prompt, which cannot be
// automated; pair by writing the stored pairing directly (the fake server sends CORS
// headers so the pages can still reach it).
await sw.evaluate(async (url) => {
  await chrome.storage.local.set({
    pairing: {
      serverUrl: url,
      token: "tok_browser_check_0123456789",
      deviceId: "dev1",
      deviceName: "Chrome on Linux",
      userDisplayName: "Test Owner",
      userLocale: "en",
      pairedAt: Date.now(),
    },
  });
}, serverUrl);
await options.evaluate(() =>
  chrome.runtime.sendMessage({ target: "background", kind: "ui:paired" }),
);
for (const lang of ["en", "tr"]) {
  await setLang(lang);
  await options.reload();
  await options.waitForSelector("article.doc");
  await shoot(options, `options-consent-required-${lang}`);
  await popup.reload();
  await waitFor(
    async () => (await popup.getAttribute("[data-state]", "data-state")) === "consent_needed",
  );
  await shoot(popup, `popup-consent-needed-${lang}`);
}
check(
  "popup shows 'consent needed'",
  (await popup.getAttribute("[data-state]", "data-state")) === "consent_needed",
);
check("badge shows '!' while consent is missing", (await badge()) === "!");
const docsShown = await options.$$eval("article.doc h3", (els) => els.map((e) => e.textContent));
check(
  "required consent documents rendered from @ltm/protocol",
  docsShown.length === 2,
  docsShown.join(" | "),
);

// --- C: accept consent through the UI ------------------------------------------------
await setLang("en");
await options.reload();
await options.waitForSelector("article.doc");
const acceptBtn = options.locator("button", { hasText: "Accept" });
check("Accept disabled until every box is ticked", await acceptBtn.isDisabled());
const boxIds = await options.$$eval("article.doc input[type=checkbox]", (els) =>
  els.map((e) => e.id),
);
const states = await Promise.all(boxIds.map((id) => options.isChecked(`#${id}`)));
check("consent checkboxes start unchecked", states.length === 2 && states.every((c) => !c));
for (const id of boxIds) {
  await options.check(`#${id}`);
  check(
    `focus stays on #${id} after re-render`,
    await options.evaluate((i) => document.activeElement?.id === i, id),
  );
}
await acceptBtn.click();
await options.waitForSelector("[data-testid=consent-ok]", { timeout: 5000 }).catch(() => null);
check(
  "consent accepted via POST /consents",
  server.consent.data_processing && server.consent.recording_responsibility,
);

// --- D: microphone permission ---------------------------------------------------------
const grant = options.locator("button", { hasText: "Allow microphone" });
if (await grant.count()) await grant.click();
await options.waitForSelector("[data-testid=mic-ok]", { timeout: 5000 }).catch(() => null);
check(
  "microphone permission granted on the options page",
  await options.isVisible("[data-testid=mic-ok]"),
);
await shoot(options, "options-ready-en");
await setLang("tr");
await options.reload();
await options.waitForSelector("[data-testid=consent-ok]");
await shoot(options, "options-ready-tr");
await setLang("en");

// --- E: microphone capture end to end -----------------------------------------------
await popup.reload();
await waitFor(async () => (await popup.getAttribute("[data-state]", "data-state")) === "idle");
await shoot(popup, "popup-idle-en");
const t0 = Date.now();
await popup.locator("button", { hasText: "Record microphone" }).click();
const gotFrames = await waitFor(
  () => [...server.streams.values()].some((s) => s.frames.length >= 8),
  15_000,
);
check("mic capture: frames reach the server", !!gotFrames);
check("badge shows REC while capturing", (await badge()) === "REC");
check("offscreen document exists while capturing", await offscreenOpen());
await waitFor(
  async () => (await popup.textContent(".caption-text"))?.includes("fake LTM server"),
  5000,
);
check(
  "live caption from server 'segment' shown in the popup",
  (await popup.textContent(".caption-text"))?.includes("fake LTM server"),
);
await shoot(popup, "popup-listening-mic-en");
await setLang("tr");
await sleep(300);
await shoot(popup, "popup-listening-mic-tr");
await setLang("en");
await sleep(300);

const ctxNotice = await popup.evaluate(async () => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("notice"),
  );
  btn?.click();
  await new Promise((r) => setTimeout(r, 300));
  return document.querySelector(".flash")?.textContent ?? "";
});
check("copy-notice button gives feedback", /Copied|Could not copy/.test(ctxNotice), ctxNotice);

await popup.locator("button", { hasText: "Stop microphone" }).click();
const micStream = [...server.streams.values()].find((s) => s.hello.source === "mic");
await waitFor(() => micStream?.ended, 8000);
check("stop sends end and the server answers closed", !!micStream?.ended);
await waitFor(async () => (await badge()) === "", 5000);
check("badge cleared after stop", (await badge()) === "");
await waitFor(async () => !(await offscreenOpen()), 5000);
check("offscreen document closed when idle", !(await offscreenOpen()));

if (micStream) {
  const f = micStream.frames;
  check(
    "hello carried token in the message and audio format",
    micStream.hello.token === "tok_browser_check_0123456789" &&
      micStream.hello.audio?.sampleRate === 16000 &&
      micStream.hello.mode === "audio",
  );
  check(
    "all frames have valid headers and 200 ms payloads",
    f.every((x) => x.ok && x.bytes === 6400),
    `${f.length} frames`,
  );
  const mono = f.every((x, i) => i === 0 || x.t > f[i - 1].t);
  check("capture timestamps strictly increasing", mono);
  const plausible = f.every((x) => x.t >= t0 - 2000 && x.t <= Date.now() + 1000);
  check(
    "capture timestamps plausible (within the test window)",
    plausible,
    `first ${f[0]?.t - t0} ms after click, last ${f.at(-1)?.t - t0} ms`,
  );
  const seqOk = f.every((x, i) => x.seq === i);
  check("seq contiguous from 0", seqOk);
  const gaps = f.slice(1).map((x, i) => Math.round(x.t - f[i].t));
  check(
    "contiguous frames 200 ms apart (gated gaps larger, flagged)",
    f
      .slice(1)
      .every((x, i) => (x.flags & 1 ? x.t - f[i].t > 200 : Math.abs(x.t - f[i].t - 200) < 2)),
    `gaps ${[...new Set(gaps)].slice(0, 8).join(",")}`,
  );
}
check(
  "no token in any WebSocket URL / no frame before ready",
  !server.log.some((l) => l.startsWith("ERROR")),
  server.log.filter((l) => l.startsWith("ERROR")).join("; "),
);

// --- F: fatal server error surfaces precisely -----------------------------------------
server.failNextHelloWith = "ingest_paused";
server.ingestPaused = true;
await popup.locator("button", { hasText: "Record microphone" }).click();
await waitFor(
  async () => (await popup.getAttribute("[data-state]", "data-state")) === "paused",
  8000,
);
check(
  "fatal ingest_paused → popup shows Paused",
  (await popup.getAttribute("[data-state]", "data-state")) === "paused",
);
check("badge shows II for paused", (await badge()) === "II");
await waitFor(async () => !(await offscreenOpen()), 5000);
check("offscreen document closed after the fatal error", !(await offscreenOpen()));
await shoot(popup, "popup-paused-en");
server.ingestPaused = false;
await popup.reload();
await waitFor(
  async () => (await popup.getAttribute("[data-state]", "data-state")) === "idle",
  5000,
);
check(
  "resuming on the server returns to idle",
  (await popup.getAttribute("[data-state]", "data-state")) === "idle",
);

// --- G: meeting detection on a stand-in Meet page --------------------------------------
await context.route("https://meet.google.com/**", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Meet – abc-defg-hij</title></head>
      <body style="background:#202124;color:#fff;font-family:sans-serif">
      <div data-participant-id="p1" style="width:400px;height:240px;background:#3c4043;margin:80px auto;border-radius:8px"></div>
      <div style="text-align:center"><button aria-label="Leave call" style="background:#ea4335;color:#fff;border:0;border-radius:20px;padding:10px 24px">Leave</button></div>
      <script>
        // a tone, so a working tab capture would have something to hear
        try { const c = new AudioContext(); const o = c.createOscillator(); o.frequency.value = 330;
              const g = c.createGain(); g.gain.value = 0.2; o.connect(g).connect(c.destination); o.start(); } catch {}
      </script></body></html>`,
  }),
);
const meet = watch(await context.newPage(), "meet");
await meet.goto("https://meet.google.com/abc-defg-hij");
const bannerUp = await meet
  .waitForSelector("ltm-banner", { state: "attached", timeout: 10_000 })
  .catch(() => null);
check("content script detects the call and shows the banner", !!bannerUp);
await shoot(meet, "meet-banner-en");
const meetBadge = await badge();
check("meeting hint on the toolbar badge", meetBadge === "•", JSON.stringify(meetBadge));

// The banner lives in a closed shadow root: find its box via hit-testing and click "Start".
const box = await meet.evaluate(() => {
  const host = document.querySelector("ltm-banner");
  const w = innerWidth;
  let left = w - 17;
  while (left > 0 && document.elementFromPoint(left - 1, 40) === host) left--;
  let bottom = 40;
  while (bottom < innerHeight && document.elementFromPoint(left + 30, bottom + 1) === host)
    bottom++;
  return { left, bottom };
});
await meet.mouse.click(box.left + 34, box.bottom - 26);
await sleep(1500);
await shoot(meet, "meet-banner-after-start-en");
const tabStream = [...server.streams.values()].find((s) => s.hello.source === "tab");
check(
  "banner Start without toolbar invocation is refused by Chrome and explained (no silent capture)",
  !tabStream,
  tabStream ? "unexpectedly started" : "needs_invocation path",
);

// Keyboard shortcut = extension invocation (activeTab). Headless Chromium may not route
// browser accelerators from synthetic key events; record what happens either way.
await meet.bringToFront();
await meet.keyboard.press("Alt+Shift+L");
const viaShortcut = await waitFor(
  () => [...server.streams.values()].find((s) => s.hello.source === "tab" && s.frames.length >= 3),
  6000,
);
results.push({
  name: "tab capture via keyboard shortcut (informational)",
  ok: true,
  detail: viaShortcut
    ? `started: ${viaShortcut.frames.length} frames, context ${JSON.stringify(viaShortcut.hello.context)}`
    : "shortcut not delivered in headless mode — real tabCapture not exercised",
});
console.log("INFO  tab capture via shortcut:", results.at(-1).detail);
if (viaShortcut) {
  check(
    "tab stream context is hostname + title only",
    viaShortcut.hello.context?.app === "meet.google.com" &&
      !JSON.stringify(viaShortcut.hello.context).includes("abc-defg-hij/"),
  );
  await sw.evaluate(() => chrome.runtime.sendMessage !== undefined);
  await popup.reload();
  await shoot(popup, "popup-listening-tab-en");
  await popup.evaluate(() =>
    chrome.runtime.sendMessage({ target: "background", kind: "ui:stop", source: "all" }),
  );
  await waitFor(async () => (await badge()) !== "REC", 8000);
}

// --- H: revoked token → un-paired ------------------------------------------------------
server.revoked = true;
await popup.reload();
await waitFor(
  async () => (await popup.getAttribute("[data-state]", "data-state")) === "not_paired",
  6000,
);
check(
  "revoked token (401) → popup back to 'not paired'",
  (await popup.getAttribute("[data-state]", "data-state")) === "not_paired",
);
const stillStored = await sw.evaluate(
  async () => !!(await chrome.storage.local.get("pairing")).pairing,
);
check("revoked token is forgotten", !stillStored);
await shoot(popup, "popup-revoked-en");

// --- wrap up ---------------------------------------------------------------------------
const relevantErrors = errors.filter(
  (e) => !/Failed to load resource|ERR_|net::|favicon|401 \(Unauthorized\)/i.test(e),
);
check(
  "no uncaught errors in extension pages / worker",
  relevantErrors.length === 0,
  relevantErrors.slice(0, 5).join(" | "),
);

await context.close();
http.close();
wss.close();
rmSync(userDataDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${shots}`,
);
process.exit(failed.length ? 1 : 0);
