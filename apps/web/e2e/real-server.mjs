// Walks the built web app against the REAL server once (no mocks):
// setup → consent → days → devices → pairing dialog → listen with this device (Chromium's
// fake microphone) → stop. Fails on console errors/warnings, page errors and any failed
// API call except the expected 401 on /me before signing in.
//
//   pnpm --filter @ltm/web build && pnpm --filter @ltm/server build
//   node e2e/real-server.mjs            (screenshots: $TMPDIR/ltm-web-real, or LTM_SCREENSHOT_DIR)
//
// The server runs on a throw-away LTM_DATA_DIR and a free port, serving apps/web/dist.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const web = fileURLToPath(new URL("..", import.meta.url));
const serverMain = resolve(web, "../server/dist/main.js");
if (!existsSync(serverMain) || !existsSync(join(web, "dist", "index.html"))) {
  console.error("Needs apps/server/dist/main.js and apps/web/dist — build both first.");
  process.exit(1);
}

const freePort = () =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "ltm-real-data-"));
const outDir = process.env.LTM_SCREENSHOT_DIR ?? join(tmpdir(), "ltm-web-real");
mkdirSync(outDir, { recursive: true });

const serverLog = [];
const proc = spawn(process.execPath, [serverMain], {
  env: {
    ...process.env,
    LTM_DATA_DIR: dataDir,
    LTM_PORT: String(port),
    LTM_HOST: "127.0.0.1",
    LTM_PUBLIC_URL: base,
    LTM_WEB_DIR: join(web, "dist"),
    LTM_LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stdout.on("data", (d) => serverLog.push(String(d)));
proc.stderr.on("data", (d) => serverLog.push(String(d)));

const problems = [];
const notes = [];
const apiCalls = [];
let browser;

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${base}/api/v1/version`);
      if (r.ok) return r.json();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start:\n${serverLog.join("")}`);
}

try {
  const version = await waitForServer();
  notes.push(`server ${version.version}, protocol ${version.protocol}, port ${port}`);

  browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    locale: "en-GB",
  });
  await context.grantPermissions(["microphone", "clipboard-read", "clipboard-write"], {
    origin: base,
  });
  const page = await context.newPage();
  let signedIn = false;
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    if (/Failed to load resource/.test(m.text())) return; // reported via the response hook
    problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on("response", (r) => {
    const url = new URL(r.url());
    if (!url.pathname.startsWith("/api/")) return;
    const entry = `${r.request().method()} ${url.pathname}${url.search} → ${r.status()}`;
    apiCalls.push(entry);
    if (r.status() < 400) return;
    if (!signedIn && url.pathname === "/api/v1/me" && r.status() === 401) return;
    problems.push(`failed API call: ${entry}`);
  });
  const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`), fullPage: true });

  await page.goto(`${base}/`);
  await page.getByRole("heading", { name: "Set up your LTM" }).waitFor();
  await page.getByLabel("Your name").fill("Owner");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("correct horse battery staple");
  signedIn = true;
  await page.getByRole("button", { name: "Create account" }).click();

  await page.getByRole("heading", { name: "Before LTM listens" }).waitFor();
  await shot("01-consent");
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: "Accept and allow capture" }).click();

  await page.getByRole("heading", { name: "Days", level: 1 }).waitFor();
  await page.waitForTimeout(1500);
  await shot("02-days");

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Devices" })
    .click();
  await page.getByRole("heading", { name: "Devices", level: 1 }).waitFor();
  await page.getByRole("button", { name: "Pair a device" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Pair a device" });
  await dialog.locator(".pair-code").waitFor({ timeout: 10_000 });
  notes.push(
    `pairing code shown: ${(await dialog.locator(".pair-code span").first().textContent())?.trim()}`,
  );
  await dialog.getByText("iPhone app").click();
  await dialog.getByRole("img", { name: /QR code/ }).waitFor({ timeout: 10_000 });
  await shot("03-pairing-iphone");
  await page.keyboard.press("Escape");

  const panel = page.locator(".listen-panel");
  await panel.getByRole("button", { name: "Listen with this device" }).click();
  await page
    .getByRole("dialog", { name: "Listen with this device" })
    .getByRole("button", { name: "Pair and start listening" })
    .click();
  const outcome = await Promise.race([
    panel
      .getByText("Listening with this device")
      .waitFor({ timeout: 20_000 })
      .then(() => "streaming"),
    panel
      .locator(".listen-error")
      .waitFor({ timeout: 20_000 })
      .then(async () => `error: ${(await panel.locator(".listen-error").textContent())?.trim()}`),
  ]).catch((e) => `timeout: ${e.message.split("\n")[0]}`);
  notes.push(`listen with this device: ${outcome}`);
  if (outcome === "streaming") {
    await page.waitForTimeout(4000);
    const level = await panel.locator("meter").getAttribute("value");
    notes.push(
      `input level after 4 s: ${level} dBFS; elapsed ${await panel.locator(".listen-clock").textContent()}`,
    );
    await shot("04-listening");
    await panel.getByRole("button", { name: "Stop" }).click();
    await panel
      .getByRole("button", { name: "Listen with this device" })
      .waitFor({ timeout: 10_000 });
    notes.push("stopped cleanly");
  } else {
    problems.push(`listen did not stream (${outcome})`);
    await shot("04-listen-problem");
  }
  await page
    .getByRole("heading", { name: /Chrome on Linux|Chrome on/ })
    .first()
    .waitFor({ timeout: 5000 })
    .then(
      () => notes.push("self-paired browser appears in the device list"),
      () => problems.push("self-paired browser not in the device list"),
    );
  const swUrl = await page.evaluate(
    async () => (await navigator.serviceWorker.ready).active?.scriptURL ?? null,
  );
  notes.push(`service worker: ${swUrl}`);
} catch (e) {
  problems.push(`walk aborted: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
} finally {
  await browser?.close();
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(notes.map((n) => `· ${n}`).join("\n"));
console.log(
  `\nAPI calls (${apiCalls.length}):\n${[...new Set(apiCalls)].map((c) => `  ${c}`).join("\n")}`,
);
const serverWarnings = serverLog.join("").trim();
if (serverWarnings) console.log(`\nserver log (warn+):\n${serverWarnings.slice(0, 4000)}`);
console.log(`\nscreenshots: ${outDir}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("\nno problems");
