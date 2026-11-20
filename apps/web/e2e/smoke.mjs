// Smoke run of the production build against a mocked API.
//
//   pnpm --filter @ltm/web e2e            (builds, then runs this script)
//   node e2e/smoke.mjs                    (uses the existing dist/)
//
// Serves dist/ with `vite preview`, answers every /api/v1/** request from mock/api.ts (whose
// fixtures and responses are validated against the protocol's zod schemas), fakes the ingest
// WebSocket with mock/ingest.ts (handshake + binary frames decoded with the protocol codec),
// walks the main flows in light + dark at desktop + phone width with Chromium's fake
// microphone, and writes screenshots to a temp directory outside the repository (override
// with LTM_SCREENSHOT_DIR). Any request that leaves the preview origin, any page error and
// any console error or warning fails the run.
//
// The browser runs in America/New_York while the account's zone is Europe/Istanbul, so the
// run also shows that days and times follow the account, not the device.
//
// Playwright is not a dependency of this package: it is resolved from the global install
// through NODE_PATH, which `require` honours and ESM `import` does not.

import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preview, runnerImport } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("dist/ is missing — run `pnpm --filter @ltm/web build` first.");
  process.exit(1);
}

const outDir = process.env.LTM_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "ltm-web-smoke-"));
mkdirSync(outDir, { recursive: true });

const load = async (file) =>
  (await runnerImport(join(root, "mock", file), { root, logLevel: "error" })).module;
const mock = await load("api.ts");
const ingestMod = await load("ingest.ts");
const fixtures = await load("fixtures.ts");
const zone = (await runnerImport(join(root, "src", "lib", "zone.ts"), { root, logLevel: "error" }))
  .module;

const server = await preview({
  root,
  logLevel: "error",
  preview: { port: 4179, strictPort: false, host: "127.0.0.1" },
});
const base = server.resolvedUrls?.local[0]?.replace(/\/$/, "") ?? "http://127.0.0.1:4179";
const origin = new URL(base).origin;

const VARIANTS = [
  { name: "desktop-light", colorScheme: "light", viewport: { width: 1360, height: 900 } },
  { name: "desktop-dark", colorScheme: "dark", viewport: { width: 1360, height: 900 } },
  {
    name: "phone-light",
    colorScheme: "light",
    viewport: { width: 390, height: 844 },
    isMobile: true,
  },
  {
    name: "phone-dark",
    colorScheme: "dark",
    viewport: { width: 390, height: 844 },
    isMobile: true,
  },
];

const failures = [];
const shots = [];
const checks = [];
const check = (variant, name, ok, detail = "") => {
  checks.push({ variant, name, ok: !!ok });
  if (!ok) failures.push(`[${variant}] ${name}${detail ? `: ${detail}` : ""}`);
};

/** Polls `fn` until true (or ~3 s): requests triggered by a click land a moment later. */
async function eventually(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

async function walk(variant) {
  const api = new mock.MockApi({ fresh: true });
  const ingest = new ingestMod.FakeIngest(() => [...api.deviceTokens.keys()]);
  const v = variant.name;
  const context = await browser.newContext({
    colorScheme: variant.colorScheme,
    viewport: variant.viewport,
    deviceScaleFactor: variant.isMobile ? 2 : 1,
    isMobile: !!variant.isMobile,
    hasTouch: !!variant.isMobile,
    locale: "en-GB",
    timezoneId: "America/New_York",
    reducedMotion: "reduce",
    userAgent: variant.isMobile
      ? "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36"
      : undefined,
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write", "microphone"], { origin });

  // Registered first, so it runs last: anything not served by the preview origin is a
  // privacy bug (fonts, CDNs, analytics…) and fails the run.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:"))
      return route.fallback();
    failures.push(`[${v}] external request: ${url}`);
    return route.abort();
  });
  await context.route(`${origin}/api/v1/**`, async (route) => {
    const req = route.request();
    let body;
    try {
      body = req.postDataJSON() ?? undefined;
    } catch {
      body = undefined;
    }
    const res = api.handle(req.method(), req.url(), body);
    await route.fulfill({
      status: res.status,
      contentType: res.contentType ?? "application/json",
      body: res.text ?? (res.json === undefined ? "" : JSON.stringify(res.json)),
    });
  });
  await context.routeWebSocket(/\/api\/v1\/ingest\/ws$/, (ws) => {
    ws.onMessage((message) => {
      const data = typeof message === "string" ? message : new Uint8Array(message);
      for (const out of ingest.receive(data)) ws.send(JSON.stringify(out));
    });
  });

  const page = await context.newPage();
  page.on("pageerror", (e) => failures.push(`[${v}] page error: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    // Chromium logs every non-2xx fetch as a console error; those are expected answers.
    if (/Failed to load resource/.test(msg.text())) return;
    failures.push(`[${v}] console ${msg.type()}: ${msg.text()}`);
  });

  const shot = async (name, opts = {}) => {
    await page.waitForTimeout(150);
    const file = join(outDir, `${v}-${name}.png`);
    if (!variant.isMobile) {
      await page.screenshot({
        path: file,
        fullPage: opts.fullPage ?? true,
        animations: "disabled",
      });
      shots.push(file);
      return;
    }
    // Full-page captures misplace sticky/fixed bars on phones, so take what a user sees:
    // the top of the page and, for long pages, one more screen further down.
    if (!opts.keepScroll) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(100);
    }
    await page.screenshot({ path: file, animations: "disabled" });
    shots.push(file);
    if (opts.fullPage === false || opts.keepScroll) return;
    const tall = await page.evaluate(
      () => document.documentElement.scrollHeight > window.innerHeight * 1.3,
    );
    if (!tall) return;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.85));
    await page.waitForTimeout(150);
    const more = file.replace(/\.png$/, "-scrolled.png");
    await page.screenshot({ path: more, animations: "disabled" });
    shots.push(more);
    await page.evaluate(() => window.scrollTo(0, 0));
  };
  const heading = (name, level = 1) => page.getByRole("heading", { name, level });
  // The sidebar and the phone bottom bar are both labelled "Main"; only one is visible.
  // On phones Devices and Settings live under "More".
  const nav = async (label) => {
    const link = page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: label, exact: true });
    if (await link.count()) return link.click();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "More" })
      .click();
    await page.locator(".menu-list").getByRole("link", { name: label, exact: true }).click();
  };

  // 1. First run: create the owner account (sends the browser's zone).
  await page.goto(`${base}/`);
  await heading("Set up your LTM").waitFor();
  await shot("01-setup");
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  check(
    v,
    "setup sends the browser time zone",
    api.log.find((r) => r.path === "/auth/setup")?.body?.timeZone === "America/New_York",
  );
  // The fixtures model an account that lives in Istanbul; switch it back as a server would.
  api.fx.settings.pipeline.timeZone = fixtures.FIXTURE_TZ;

  // 2. Consent gate.
  await heading("Before LTM listens").waitFor();
  await shot("02-consent-gate");
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: "Accept and allow capture" }).click();

  // 3. Days home: today's digest, live strip, earlier days.
  await heading("Days").waitFor();
  const today = api.fx.digests[zone.dayInZone(Date.now(), fixtures.FIXTURE_TZ)];
  await page.getByRole("heading", { name: today.headline }).waitFor();
  await page.getByText("Right — I think we can ship the new flow").first().waitFor();
  await page.getByText("Onboarding plan for support, and lunch with Aylin").waitFor();
  await page
    .getByLabel(/Ask legal about the refund wording/)
    .first()
    .check();
  check(
    v,
    "day action item ticked through PATCH",
    await eventually(() =>
      api.log.some((r) => r.method === "PATCH" && r.path.endsWith("/action-items/ai-2")),
    ),
  );
  await shot("03-days");

  // 4. Day detail.
  await page.getByRole("link", { name: "Open today" }).click();
  await page.getByRole("heading", { name: "Digest" }).waitFor();
  await shot("04-day-detail");
  await page.getByRole("button", { name: "Rewrite digest" }).click();
  await page.getByText("Being written…").first().waitFor();

  // 5. Interim conversation.
  await page.getByRole("link", { name: "Weekly product sync: roadmap and hiring" }).first().click();
  await page.getByText("Live · notes so far.").waitFor();
  await shot("05-interim-conversation");

  // 6. Timeline and a finished conversation.
  await nav("Timeline");
  await heading("Timeline").waitFor();
  await page.getByRole("heading", { name: "Pricing review with the design team" }).waitFor();
  await shot("06-timeline");
  await page.getByRole("link", { name: "Pricing review with the design team" }).click();
  await heading("Pricing review with the design team").waitFor();
  await shot("07-conversation");

  // 7. Memories.
  await nav("Memories");
  await heading("Memories").waitFor();
  await page.getByText("Aylin prefers trains").waitFor();
  await shot("08-memories");

  // 8. Ask as a thread (two questions, a scope, sources expanded on the first answer).
  if (variant.isMobile) {
    await nav("Ask");
  } else {
    await page
      .getByRole("searchbox", { name: "Ask your memory" })
      .fill("When is the launch and what could delay it?");
    await page.keyboard.press("Enter");
  }
  await heading("Search & Ask").waitFor();
  const box = page.getByLabel("Your question");
  if (variant.isMobile) {
    await box.fill("When is the launch and what could delay it?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
  }
  await page.getByText("3 sources").first().waitFor();
  await page.getByRole("radio", { name: "Last 7 days" }).click();
  await box.fill("Who is reworking the comparison table?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.locator(".turn").nth(1).getByText("3 sources").waitFor();
  check(
    v,
    "ask scope sends from/to",
    typeof api.log.filter((r) => r.path === "/ask").at(-1)?.body?.from === "number",
  );
  await page.locator(".turn").first().getByText("3 sources").click();
  await shot("09-ask-thread");
  // What the user actually sees: the end of the thread with the composer.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await shot("09b-ask-bottom", { fullPage: false, keepScroll: true });

  // 9. Devices: access levels, pairing dialog variants.
  await nav("Devices");
  await heading("Devices").waitFor();
  await page.getByRole("heading", { name: "Apple Watch", level: 2 }).waitFor();
  await shot("10-devices");
  await page.getByRole("button", { name: "Pair a device" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Pair a device" });
  await dialog.getByText("K7QF-2MXD").waitFor();
  await shot("11-pair-extension", { fullPage: false });
  await dialog.getByText("iPhone app").click();
  await dialog.getByText("M3RV-8QPA").waitFor();
  await dialog.getByRole("img", { name: /QR code/ }).waitFor();
  check(
    v,
    "iPhone pairing asks for memory access",
    api.log.filter((r) => r.path === "/devices/pairing-codes").at(-1)?.body?.access === "memory",
  );
  await shot("12-pair-iphone", { fullPage: false });
  await dialog.getByText("Capture agent on a computer").click();
  await dialog.getByText(/ltm-agent pair --server/).waitFor();
  await shot("13-pair-agent", { fullPage: false });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  // 10. Listen with this device (fake microphone → AudioWorklet → real frames over the socket).
  const panel = page.locator(".listen-panel");
  await panel.getByRole("button", { name: "Listen with this device" }).click();
  const intro = page.getByRole("dialog", { name: "Listen with this device" });
  await intro.getByText(/capture-only device/).waitFor();
  await shot("14-listen-intro", { fullPage: false });
  await intro.getByRole("button", { name: "Pair and start listening" }).click();
  await panel.getByText("Listening with this device").waitFor({ timeout: 15_000 });
  await panel
    .getByText(/Caption \d+ from the fake recogniser/)
    .first()
    .waitFor({ timeout: 15_000 });
  await panel.locator(".listen-clock").waitFor();
  // The level meter follows the fake microphone's beeps.
  let loudest = -60;
  for (let i = 0; i < 30 && loudest <= -55; i++) {
    loudest = Math.max(
      loudest,
      Number(await panel.getByRole("meter").getAttribute("aria-valuenow")),
    );
    await page.waitForTimeout(100);
  }
  check(v, "level meter moves", loudest > -55, `loudest ${loudest} dBFS`);
  check(
    v,
    "self-paired as a capture-only web device",
    api.fx.devices.some((d) => d.kind === "web" && d.access === "capture"),
  );
  check(
    v,
    "ingest hello uses the device token",
    ingest.stats.hellos[0]?.token?.startsWith("ltm_dev_mock_"),
  );
  check(v, "real audio frames arrived", ingest.stats.frames >= 10, `${ingest.stats.frames} frames`);
  check(
    v,
    "frames decoded without errors",
    ingest.stats.errors.length === 0,
    ingest.stats.errors.join("; "),
  );
  check(
    v,
    "device token is stored under one key",
    (await page.evaluate(() => localStorage.getItem("ltm.listenDevice")))?.includes(
      "ltm_dev_mock_",
    ),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("15-listening", { fullPage: false });
  await panel.getByRole("button", { name: "Stop" }).click();
  await panel.getByRole("button", { name: "Listen with this device" }).waitFor();
  check(v, "stop sends end", await eventually(() => ingest.stats.ends >= 1));

  // 11. Settings → Pipeline.
  await nav("Settings");
  await heading("Settings").waitFor();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Pipeline" })
    .click();
  await page.getByText("Live notes while a conversation is still going").waitFor();
  await page.getByText("Every 30 min").click();
  await shot("16-pipeline");
  await page.getByRole("button", { name: "Save" }).click();
  await eventually(() => api.log.some((r) => r.path === "/settings/pipeline"));
  const pipe = api.log.filter((r) => r.path === "/settings/pipeline").at(-1)?.body;
  check(
    v,
    "pipeline saves live notes, digest and zone",
    pipe?.liveNotesMinutes === 30 &&
      pipe?.dailyDigest === true &&
      pipe?.timeZone === fixtures.FIXTURE_TZ,
  );

  // 12. Providers; a third-party LLM triggers the extra consent.
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "AI providers" })
    .click();
  await page.getByRole("heading", { name: "Language model", level: 2 }).waitFor();
  await shot("17-providers");
  const llm = page.locator("section", {
    has: page.getByRole("heading", { name: "Language model", level: 2 }),
  });
  await llm.getByRole("radio", { name: /Anthropic API/ }).check();
  await llm.getByLabel(/^API key/).fill("sk-ant-smoke-test-key");
  await llm.getByRole("button", { name: "Save" }).click();
  await page.getByRole("heading", { name: "Sending content to an external AI provider" }).waitFor();
  await shot("18-third-party-consent");
  if ((await page.content()).includes("sk-ant-smoke-test-key"))
    failures.push(`[${v}] API key echoed in DOM`);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Accept and allow capture" }).click();
  await heading("Settings").waitFor();

  // 13. Pause from the live strip, then the paused home in Turkish (saved to the account).
  await nav("Days");
  await page.getByRole("button", { name: "Pause capture" }).first().click();
  await page.getByRole("heading", { name: "Capture is paused" }).waitFor();
  check(
    v,
    "kill switch uses POST /capture/pause",
    await eventually(() => api.log.some((r) => r.path === "/capture/pause")),
  );
  await page.getByRole("button", { name: "Switch language to Türkçe" }).first().click();
  await page.getByRole("heading", { name: "Kayıt duraklatıldı" }).waitFor();
  check(
    v,
    "language saved with PATCH /me",
    await eventually(() => api.log.some((r) => r.method === "PATCH" && r.path === "/me")),
  );
  await shot("19-days-paused-tr", { fullPage: false });

  // 14. PWA: manifest served, worker registered, Cache Storage holds no API responses.
  const manifest = await (await page.request.get(`${base}/manifest.webmanifest`)).json();
  check(
    v,
    "manifest served with icons",
    manifest.display === "standalone" && manifest.icons?.some((i) => i.purpose === "maskable"),
  );
  check(v, "manifest linked", (await page.locator('link[rel="manifest"]').count()) === 1);
  const swUrl = await page.evaluate(
    async () => (await navigator.serviceWorker.ready).active?.scriptURL ?? null,
  );
  check(v, "service worker registered", swUrl === `${origin}/sw.js`, String(swUrl));
  const cached = await page.evaluate(async () => {
    const out = [];
    for (const key of await caches.keys()) {
      const c = await caches.open(key);
      for (const r of await c.keys()) out.push(new URL(r.url).pathname);
    }
    return out;
  });
  check(
    v,
    "shell cached",
    cached.includes("/index.html") && cached.some((p) => p.includes("worklet")),
  );
  check(
    v,
    "no API response in Cache Storage",
    cached.every((p) => !p.startsWith("/api")),
    cached.filter((p) => p.startsWith("/api")).join(","),
  );
  await context.setOffline(true);
  await page.goto(`${base}/days`).catch(() => {});
  await page.getByText("You are offline").waitFor();
  await shot("20-offline", { fullPage: false });
  await context.setOffline(false);

  await context.close();
}

let ok = true;
try {
  for (const v of VARIANTS) {
    try {
      await walk(v);
      console.log(`✓ ${v.name}`);
    } catch (e) {
      ok = false;
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      console.error(`✗ ${v.name}: ${msg}`);
      failures.push(`[${v.name}] ${msg}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const passed = checks.filter((c) => c.ok).length;
console.log(
  `\n${passed}/${checks.length} assertions passed · ${shots.length} screenshots in ${outDir}`,
);
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
process.exit(ok ? 0 : 1);
