/*
 * LTM service worker. Hand-written and deliberately small:
 *
 * - Caches ONLY the built static shell (hashed assets, index.html, icons, the offline page),
 *   listed at build time — never anything fetched at runtime.
 * - NEVER intercepts or caches anything under /api: conversations, memories and tokens must
 *   not land in Cache Storage, where they would outlive a sign-out.
 * - Navigations go to the network first; when it is unreachable the offline page is shown.
 *
 * The SHELL and VERSION placeholders below are filled in by the build (see vite.config.ts).
 */
const SHELL = __SHELL__;
const VERSION = __VERSION__;
const CACHE = `ltm-shell-${VERSION}`;
const OFFLINE = "/offline.html";

/** True for every request this worker must leave alone. */
function isPrivate(url) {
  return url.pathname === "/api" || url.pathname.startsWith("/api/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("ltm-shell-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isPrivate(url)) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(OFFLINE, { cacheName: CACHE }).then((r) => r || Response.error()),
      ),
    );
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then((r) => r || fetch(req)),
    );
  }
});
