// The BUILT extension in a real Chromium against the BUILT server (run `pnpm build` first):
// consent through the extension UI, microphone capture with Chromium's fake audio device,
// frames over the ingest WebSocket, server VAD, a fake speech-to-text server, and the live
// caption back in the popup. Needs no API key.
//
//   node scripts/e2e/extension.mjs
//
// Requires Playwright with Chromium available to Node (it is not a project dependency).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 8096,
  STT = 9912,
  BASE = `http://127.0.0.1:${PORT}`,
  API = `${BASE}/api/v1`;
const dist = join(REPO, "apps/extension/dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`);
};
const waitFor = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(300);
  }
  return null;
};

let sttCalls = 0;
const stt = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    sttCalls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        text: "extension to real server works",
        segments: [{ start: 0, end: 1, text: "extension to real server works" }],
      }),
    );
  });
});
await new Promise((r) => stt.listen(STT, "127.0.0.1", r));
const server = spawn("node", ["dist/main.js"], {
  cwd: join(REPO, "apps/server"),
  env: {
    ...process.env,
    LTM_DATA_DIR: mkdtempSync(join(tmpdir(), "ltm-ext-")),
    LTM_PORT: String(PORT),
    LTM_HOST: "127.0.0.1",
    LTM_LOG_LEVEL: "warn",
    LTM_STT_KIND: "openai_compatible",
    LTM_STT_BASE_URL: `http://127.0.0.1:${STT}/v1`,
    LTM_STT_MODEL: "fake",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const call = async (m, p, body, token) => {
  const r = await fetch(API + p, {
    method: m,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
};
await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok);
let ctx;
try {
  const auth = (
    await call("POST", "/auth/setup", {
      email: "owner@example.test",
      password: "correct horse battery",
      displayName: "Owner",
    })
  ).json;
  const code = (await call("POST", "/devices/pairing-codes", undefined, auth.token)).json;
  const paired = (
    await call("POST", "/devices/pair", {
      code: code.code,
      name: "Chrome on Linux",
      kind: "browser_extension",
      platform: "e2e",
    })
  ).json;

  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ltm-pw-")), {
    channel: "chromium",
    viewport: { width: 900, height: 900 },
    args: [
      "--headless=new",
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const ext = (p) => `chrome-extension://${new URL(sw.url()).host}/${p}`;
  await sleep(800);
  for (const p of ctx.pages()) if (p.url() !== "about:blank") await p.close();
  await sw.evaluate(
    async (p) => {
      await chrome.storage.local.set({ prefs: { uiLanguage: "en" }, pairing: p });
    },
    {
      serverUrl: BASE,
      token: paired.token,
      deviceId: paired.device.id,
      deviceName: paired.device.name,
      userDisplayName: "Owner",
      userLocale: "en",
      pairedAt: Date.now(),
    },
  );
  const errors = [];
  const options = await ctx.newPage();
  const popup = await ctx.newPage();
  for (const [n, pg] of [
    ["options", options],
    ["popup", popup],
  ]) {
    pg.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));
    pg.on("console", (m) => m.type() === "error" && errors.push(`${n} console: ${m.text()}`));
  }
  await options.goto(ext("options.html"));
  await options.evaluate(() =>
    chrome.runtime.sendMessage({ target: "background", kind: "ui:paired" }),
  );
  await options.reload();
  const docs = await waitFor(async () => (await options.locator("article.doc").count()) || null);
  check(
    "extension page read /me from the REAL server (CORS + bearer) and shows the required consent documents",
    docs === 2,
    `documents=${docs}`,
  );
  for (const id of await options.$$eval("article.doc input[type=checkbox]", (els) =>
    els.map((e) => e.id),
  ))
    await options.check(`#${id}`);
  await options.locator("button", { hasText: "Accept" }).click();
  const me = await waitFor(async () => {
    const m = (await call("GET", "/me", undefined, auth.token)).json;
    return m.consent.satisfied ? m : null;
  });
  check(
    "consent accepted through the extension UI is recorded by the real server",
    Boolean(me),
    JSON.stringify(me?.consent.records.map((r) => r.via)),
  );
  const grant = options.locator("button", { hasText: "Allow microphone" });
  if (await grant.count()) await grant.click();
  await options.waitForSelector("[data-testid=mic-ok]", { timeout: 5000 }).catch(() => null);

  await popup.setViewportSize({ width: 340, height: 560 });
  await popup.goto(ext("popup.html"));
  await waitFor(async () => (await popup.getAttribute("[data-state]", "data-state")) === "idle");
  await popup.locator("button", { hasText: "Record microphone" }).click();
  const active = await waitFor(async () => {
    const s = (await call("GET", "/streams?active=true", undefined, auth.token)).json;
    return s.length ? s : null;
  });
  check(
    "real server reports an active mic stream from the extension",
    Boolean(active) && active[0].source === "mic" && active[0].deviceId === paired.device.id,
    JSON.stringify(active?.map((s) => [s.source, s.mode, s.deviceName])),
  );
  const badge = await waitFor(() =>
    sw.evaluate(() => chrome.action.getBadgeText({})).then((b) => (b === "REC" ? b : null)),
  );
  check("toolbar badge shows REC while capturing", badge === "REC");
  const caption = await waitFor(
    async () =>
      ((await popup.textContent("body")) ?? "").includes("extension to real server works"),
    30000,
  );
  check(
    "audio went mic → worklet → WebSocket → server VAD → STT → live caption in the popup",
    Boolean(caption),
    `sttCalls=${sttCalls}`,
  );
  await popup.locator("button", { hasText: "Stop microphone" }).click();
  const ended = await waitFor(
    async () =>
      (await call("GET", "/streams?active=true", undefined, auth.token)).json.length === 0,
  );
  check("stop ends the stream on the server", Boolean(ended));
  const convs = await waitFor(async () => {
    const c = (await call("GET", "/conversations", undefined, auth.token)).json;
    return c.items.length ? c : null;
  });
  check(
    "the capture shows up as a conversation",
    Boolean(convs),
    `utterances=${convs?.items[0]?.utteranceCount}`,
  );
  check("no page errors in the extension", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("completed without exception", false, String(e?.stack ?? e));
}
await ctx?.close();
server.kill("SIGTERM");
stt.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
