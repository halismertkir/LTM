import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CallStateDebouncer } from "../src/content/detect.js";
import { buildManifest, MIN_CHROME_VERSION, TOGGLE_TAB_COMMAND } from "../src/manifest.js";
import { en } from "../src/shared/i18n/en.js";
import { DICTIONARIES, format, resolveLocale, translator } from "../src/shared/i18n/index.js";
import { tr } from "../src/shared/i18n/tr.js";
import { MEETING_HOSTS, meetingHostFor, meetingMatchPatterns } from "../src/shared/meetingHosts.js";
import {
  ingestWsUrl,
  isInsecureRemote,
  normalizeServerUrl,
  originPattern,
  parsePairingInput,
} from "../src/shared/url.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n", () => {
  it("EN and TR UI dictionaries have exactly the same keys", () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
  });

  it("every translation uses the same placeholders and is not empty", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(tr[key]), key).toEqual(placeholders(en[key]));
      expect(tr[key].trim(), key).not.toBe("");
    }
  });

  it("manifest locale files have the same keys and every __MSG_ used exists", () => {
    const load = (l: string) =>
      JSON.parse(
        readFileSync(resolve(root, `public/_locales/${l}/messages.json`), "utf8"),
      ) as Record<string, { message: string }>;
    const enMsgs = load("en");
    const trMsgs = load("tr");
    expect(Object.keys(trMsgs).sort()).toEqual(Object.keys(enMsgs).sort());
    const used = [...JSON.stringify(buildManifest("1.0.0")).matchAll(/__MSG_(\w+)__/g)].map(
      (m) => m[1]!,
    );
    expect(used.length).toBeGreaterThan(0);
    for (const k of used) expect(enMsgs[k], k).toBeDefined();
    expect(enMsgs.extDescription!.message.length).toBeLessThanOrEqual(132);
    expect(trMsgs.extDescription!.message.length).toBeLessThanOrEqual(132);
  });

  it("formats placeholders and resolves the locale", () => {
    expect(format("a {x} b {y}", { x: 1 })).toBe("a 1 b {y}");
    expect(resolveLocale("auto", "tr-TR")).toBe("tr");
    expect(resolveLocale("auto", "de")).toBe("en");
    expect(resolveLocale("tr", "en-US")).toBe("tr");
    expect(translator("tr")("state.idle")).toBe("Beklemede");
    expect(Object.keys(DICTIONARIES)).toEqual(["en", "tr"]);
  });
});

describe("manifest", () => {
  const m = buildManifest("0.1.0");
  const json = JSON.stringify(m);

  it("has the required MV3 keys", () => {
    expect(m.manifest_version).toBe(3);
    expect(m.version).toBe("0.1.0");
    expect(m.default_locale).toBe("en");
    expect(m.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(m.action?.default_popup).toBe("popup.html");
    expect(m.options_ui?.page).toBe("options.html");
    expect(m.minimum_chrome_version).toBe(MIN_CHROME_VERSION);
    expect(m.commands?.[TOGGLE_TAB_COMMAND]).toBeDefined();
  });

  it("asks for the minimum permissions and never <all_urls>", () => {
    expect(json).not.toContain("<all_urls>");
    expect(json).not.toMatch(/"\*:\/\/\*\/\*"/);
    expect([...(m.permissions ?? [])].sort()).toEqual([
      "activeTab",
      "offscreen",
      "storage",
      "tabCapture",
    ]);
    expect(m.host_permissions).toBeUndefined();
    expect(m.optional_host_permissions).toEqual(["https://*/*", "http://*/*"]);
  });

  it("runs the content script only on the meeting hosts", () => {
    expect(m.content_scripts).toHaveLength(1);
    expect(m.content_scripts?.[0]?.matches).toEqual(meetingMatchPatterns());
    for (const p of m.content_scripts![0]!.matches!)
      expect(p).toMatch(/^https:\/\/(\*\.)?[a-z.]+\/\*$/);
    expect(m.content_scripts?.[0]?.all_frames).toBe(false);
  });

  it("has a strict CSP without remote or eval'd code", () => {
    const csp = m.content_security_policy?.extension_pages ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|https?:/);
  });

  it("references icon files that exist, in both variants", () => {
    for (const variant of ["idle", "rec"]) {
      for (const s of [16, 32, 48, 128]) {
        expect(
          existsSync(resolve(root, `public/icons/${variant}-${s}.png`)),
          `${variant}-${s}`,
        ).toBe(true);
      }
    }
    for (const p of Object.values(m.icons ?? {}))
      expect(existsSync(resolve(root, "public", p))).toBe(true);
  });
});

describe("meeting hosts", () => {
  it("recognises exactly the configured hosts", () => {
    expect(meetingHostFor("meet.google.com")?.id).toBe("meet");
    expect(meetingHostFor("us02web.zoom.us")?.id).toBe("zoom");
    expect(meetingHostFor("zoom.us")?.id).toBe("zoom");
    expect(meetingHostFor("teams.microsoft.com")?.id).toBe("teams");
    expect(meetingHostFor("teams.live.com")?.id).toBe("teams");
    expect(meetingHostFor("evilzoom.us")).toBeNull();
    expect(meetingHostFor("zoom.us.evil.com")).toBeNull();
    expect(meetingHostFor("google.com")).toBeNull();
    expect(MEETING_HOSTS.length).toBe(4);
  });

  it("debounces the in-call signal", () => {
    const d = new CallStateDebouncer(2, 3);
    expect(d.update(true)).toBeNull();
    expect(d.update(true)).toBe(true);
    expect(d.update(false)).toBeNull();
    expect(d.update(true)).toBeNull(); // flicker resets
    expect(d.update(false)).toBeNull();
    expect(d.update(false)).toBeNull();
    expect(d.update(false)).toBe(false);
  });
});

describe("server URLs", () => {
  it("normalises what the user typed", () => {
    expect(normalizeServerUrl("ltm.example.org")).toBe("https://ltm.example.org");
    expect(normalizeServerUrl(" https://ltm.example.org/ ")).toBe("https://ltm.example.org");
    expect(normalizeServerUrl("http://localhost:8080/ltm/?x=1#y")).toBe(
      "http://localhost:8080/ltm",
    );
    expect(() => normalizeServerUrl("ftp://x")).toThrow();
    expect(() => normalizeServerUrl("https://user:pw@x")).toThrow();
    expect(() => normalizeServerUrl("")).toThrow();
  });

  it("warns about plain http only for non-local hosts", () => {
    expect(isInsecureRemote("http://192.168.1.10:8080")).toBe(true);
    expect(isInsecureRemote("http://ltm.lan")).toBe(true);
    expect(isInsecureRemote("http://localhost:8080")).toBe(false);
    expect(isInsecureRemote("http://127.0.0.1:8080")).toBe(false);
    expect(isInsecureRemote("http://[::1]:8080")).toBe(false);
    expect(isInsecureRemote("https://ltm.example.org")).toBe(false);
  });

  it("builds the ingest URL without credentials and the permission pattern", () => {
    expect(ingestWsUrl("https://ltm.example.org")).toBe("wss://ltm.example.org/api/v1/ingest/ws");
    expect(ingestWsUrl("http://localhost:8080/ltm")).toBe(
      "ws://localhost:8080/ltm/api/v1/ingest/ws",
    );
    expect(originPattern("http://localhost:8080/ltm")).toBe("http://localhost/*");
  });

  it("accepts a pasted pairing link", () => {
    expect(
      parsePairingInput("ltm://pair?server=https%3A%2F%2Fltm.example.org&code=K7QF-2MXD"),
    ).toEqual({
      code: "K7QF-2MXD",
      server: "https://ltm.example.org",
    });
    expect(parsePairingInput(" K7QF-2MXD ")).toEqual({ code: "K7QF-2MXD", server: null });
  });
});
