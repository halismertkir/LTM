import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SHELL = ["/assets/index-abc.js", "/assets/index-abc.css", "/index.html", "/offline.html"];
const ORIGIN = "https://ltm.example.test";

/** Loads src/sw/sw.js the way the build does and runs it in a fake worker scope. */
function loadWorker() {
  const source = readFileSync(resolve(import.meta.dirname, "../src/sw/sw.js"), "utf8")
    .replace("const SHELL = __SHELL__;", `const SHELL = ${JSON.stringify(SHELL)};`)
    .replace("const VERSION = __VERSION__;", 'const VERSION = "test";');
  const handlers: Record<string, (e: unknown) => void> = {};
  const cache = { addAll: vi.fn(async () => {}), put: vi.fn() };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ["ltm-shell-old", "ltm-shell-test", "other-app"]),
    delete: vi.fn(async () => true),
    match: vi.fn(
      async (req: unknown) =>
        new Response(`cached:${typeof req === "string" ? req : (req as Request).url}`),
    ),
  };
  const fetchMock = vi.fn(async () => new Response("network"));
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      handlers[type] = fn;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  runInNewContext(source, { self, caches, fetch: fetchMock, URL, Response, Promise, console });
  const dispatchFetch = (url: string, init: { method?: string; mode?: string } = {}) => {
    const respondWith = vi.fn();
    handlers.fetch!({
      request: { url, method: init.method ?? "GET", mode: init.mode ?? "cors" },
      respondWith,
    });
    return respondWith;
  };
  return { handlers, cache, caches, fetchMock, dispatchFetch };
}

describe("service worker", () => {
  it("never intercepts anything under /api", () => {
    const w = loadWorker();
    for (const path of [
      "/api",
      "/api/v1/me",
      "/api/v1/events",
      "/api/v1/conversations?q=x",
      "/api/v1/export",
    ]) {
      expect(w.dispatchFetch(`${ORIGIN}${path}`)).not.toHaveBeenCalled();
      expect(w.dispatchFetch(`${ORIGIN}${path}`, { mode: "navigate" })).not.toHaveBeenCalled();
    }
    expect(w.dispatchFetch(`${ORIGIN}/api/v1/consents`, { method: "POST" })).not.toHaveBeenCalled();
    expect(w.caches.match).not.toHaveBeenCalled();
    expect(w.cache.put).not.toHaveBeenCalled();
  });

  it("caches only the built shell at install and drops old shells on activate", async () => {
    const w = loadWorker();
    let installed: Promise<unknown> | undefined;
    w.handlers.install!({ waitUntil: (p: Promise<unknown>) => (installed = p) });
    await installed;
    expect(w.cache.addAll).toHaveBeenCalledWith(SHELL);
    let activated: Promise<unknown> | undefined;
    w.handlers.activate!({ waitUntil: (p: Promise<unknown>) => (activated = p) });
    await activated;
    expect(w.caches.delete).toHaveBeenCalledWith("ltm-shell-old");
    expect(w.caches.delete).not.toHaveBeenCalledWith("other-app");
    expect(w.caches.delete).not.toHaveBeenCalledWith("ltm-shell-test");
  });

  it("serves shell files from cache, leaves everything else to the network", async () => {
    const w = loadWorker();
    const asset = w.dispatchFetch(`${ORIGIN}/assets/index-abc.js`);
    expect(asset).toHaveBeenCalledOnce();
    expect(await (await asset.mock.calls[0]![0]).text()).toContain("cached:");
    expect(w.dispatchFetch(`${ORIGIN}/assets/unknown.js`)).not.toHaveBeenCalled();
    expect(w.dispatchFetch("https://elsewhere.example/x.js")).not.toHaveBeenCalled();
  });

  it("goes to the network first for navigations and falls back to the offline page", async () => {
    const w = loadWorker();
    const online = w.dispatchFetch(`${ORIGIN}/days/2026-11-20`, { mode: "navigate" });
    expect(await (await online.mock.calls[0]![0]).text()).toBe("network");
    w.fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const offline = w.dispatchFetch(`${ORIGIN}/days/2026-11-20`, { mode: "navigate" });
    expect(await (await offline.mock.calls[0]![0]).text()).toBe("cached:/offline.html");
  });
});
