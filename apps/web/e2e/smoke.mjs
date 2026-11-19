// Smoke run of the production build against a mocked API.
//
//   pnpm --filter @ltm/web e2e            (builds, then runs this script)
//   node e2e/smoke.mjs                    (uses the existing dist/)
//
// Serves dist/ with `vite preview`, answers every /api/v1/** request from mock/api.ts (whose
// fixtures and responses are validated against the protocol's zod schemas), walks the main
// flows in light + dark at desktop + phone width, and writes screenshots to a temp directory
// outside the repository (override with LTM_SCREENSHOT_DIR). Any request that leaves the
// preview origin, any page error and any console error fails the run.
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

const { module: mock } = await runnerImport(join(root, "mock", "api.ts"), {
  root,
  logLevel: "error",
});
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
const browser = await chromium.launch();

async function walk(variant) {
  const api = new mock.MockApi({ fresh: true });
  const context = await browser.newContext({
    colorScheme: variant.colorScheme,
    viewport: variant.viewport,
    deviceScaleFactor: variant.isMobile ? 2 : 1,
    isMobile: !!variant.isMobile,
    hasTouch: !!variant.isMobile,
    locale: "en-GB",
    reducedMotion: "reduce",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });

  // Registered first, so it runs last: anything not served by the preview origin is a
  // privacy bug (fonts, CDNs, analytics…) and fails the run.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:"))
      return route.fallback();
    failures.push(`[${variant.name}] external request: ${url}`);
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

  const page = await context.newPage();
  page.on("pageerror", (e) => failures.push(`[${variant.name}] page error: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // Chromium logs every non-2xx fetch as a console error; those are expected answers.
    if (/Failed to load resource/.test(msg.text())) return;
    failures.push(`[${variant.name}] console error: ${msg.text()}`);
  });

  const shot = async (name, opts = {}) => {
    await page.waitForTimeout(150);
    const file = join(outDir, `${variant.name}-${name}.png`);
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
    await page.screenshot({ path: file, animations: "disabled" });
    shots.push(file);
    if (opts.fullPage === false) return;
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
  // Both the sidebar and the phone bottom bar are labelled "Main"; only one is visible.
  const nav = (label) =>
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label }).click();

  // 1. First run: create the owner account.
  await page.goto(`${base}/`);
  await heading("Set up your LTM").waitFor();
  await shot("01-setup");
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();

  // 2. Consent gate.
  await heading("Before LTM listens").waitFor();
  await shot("02-consent-gate");
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: "Accept and allow capture" }).click();

  // 3. Timeline with the live strip fed by SSE.
  await heading("Timeline").waitFor();
  await page.getByText("Right — I think we can ship the new flow").waitFor();
  await page.getByRole("heading", { name: "Pricing review with the design team" }).waitFor();
  await shot("03-timeline");

  // 4. Conversation detail; tick an action item.
  await page.getByRole("link", { name: "Pricing review with the design team" }).click();
  await heading("Pricing review with the design team").waitFor();
  await page.getByLabel(/Ask legal about the refund wording/).check();
  await shot("04-conversation");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await shot("04b-notes-edit", { fullPage: false });
  await page.getByRole("button", { name: "Cancel" }).click();

  // 5. Memories.
  await nav("Memories");
  await heading("Memories").waitFor();
  await page.getByText("Aylin prefers trains").waitFor();
  await shot("05-memories");

  // 6. Search, then Ask.
  await nav("Search & Ask");
  await heading("Search & Ask").waitFor();
  await page.getByRole("searchbox", { name: "Search query" }).fill("legal");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByText("Keywords only").waitFor();
  await shot("06-search");
  await page.getByRole("tab", { name: "Ask" }).click();
  await page.getByLabel("Your question").fill("When is the launch and what could delay it?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByRole("heading", { name: "Sources" }).waitFor();
  await shot("07-ask");

  // 7. Devices and the pairing dialog.
  await nav("Devices");
  await heading("Devices").waitFor();
  await page.getByRole("heading", { name: "Apple Watch", level: 2 }).waitFor();
  await shot("08-devices");
  await page.getByRole("button", { name: "Pair a device" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Pair a device" });
  await dialog.getByText("K7QF-2MXD").waitFor();
  await dialog.getByRole("img", { name: /QR code/ }).waitFor();
  await shot("09-pairing", { fullPage: false });
  await dialog.getByRole("tab", { name: "iPhone" }).click();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  // 8. Provider settings; switching to a third-party LLM triggers the extra consent.
  await nav("Settings");
  await heading("Settings").waitFor();
  await page.getByRole("heading", { name: "Language model", level: 2 }).waitFor();
  await shot("10-providers");
  const llm = page.locator("section", {
    has: page.getByRole("heading", { name: "Language model", level: 2 }),
  });
  await llm.getByRole("radio", { name: /Claude Code CLI/ }).check();
  await llm.getByText(/official Claude Code command-line tool/).waitFor();
  await shot("10b-providers-cli", { fullPage: false });
  await llm.getByRole("radio", { name: /Anthropic API/ }).check();
  await llm.getByLabel(/^API key/).fill("sk-ant-smoke-test-key");
  await llm.getByRole("button", { name: "Save" }).click();
  await heading("Before LTM listens").waitFor();
  await page.getByRole("heading", { name: "Sending content to an external AI provider" }).waitFor();
  await shot("11-third-party-consent");
  if ((await page.content()).includes("sk-ant-smoke-test-key"))
    failures.push(`[${variant.name}] API key echoed in DOM`);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Accept and allow capture" }).click();
  await heading("Settings").waitFor();

  // 9. Privacy and notices.
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Privacy" })
    .click();
  await page.getByRole("heading", { name: "Records" }).waitFor();
  await shot("12-privacy");
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Informing others" })
    .click();
  await page.getByRole("heading", { name: "For a meeting chat" }).waitFor();
  await shot("13-notices");

  // 10. Pause capture from the indicator, then look at the paused timeline in Turkish.
  await nav("Timeline");
  await page.getByRole("button", { name: "Pause capture" }).first().click();
  await page.getByRole("heading", { name: "Capture is paused" }).waitFor();
  await page.getByRole("button", { name: "Switch language to Türkçe" }).first().click();
  await page.getByRole("heading", { name: "Kayıt duraklatıldı" }).waitFor();
  await shot("14-timeline-paused-tr", { fullPage: false });

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
      console.error(`✗ ${v.name}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      failures.push(`[${v.name}] ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${shots.length} screenshots in ${outDir}`);
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
process.exit(ok ? 0 : 1);
