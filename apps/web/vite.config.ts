import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const API_TARGET = process.env.LTM_API_TARGET ?? "http://localhost:8080";
const root = import.meta.dirname;

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

/**
 * Emits `sw.js` from src/sw/sw.js with the exact list of built files it may cache (hashed
 * assets, index.html, public files). The version is a hash of that list and of the public
 * files' contents, so any deploy that changes the shell replaces the old cache.
 */
function serviceWorker(): Plugin {
  return {
    name: "ltm-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const publicDir = resolve(root, "public");
      const publicFiles = listFiles(publicDir);
      const shell = [
        ...new Set([
          ...Object.keys(bundle)
            .filter((f) => !f.endsWith(".map"))
            .map((f) => `/${f}`),
          ...publicFiles.map((f) => `/${relative(publicDir, f).split("\\").join("/")}`),
        ]),
      ].sort();
      const hash = createHash("sha256").update(shell.join("\n"));
      for (const f of publicFiles) hash.update(readFileSync(f));
      for (const [name, chunk] of Object.entries(bundle)) {
        if (name.endsWith(".map")) continue;
        hash.update(chunk.type === "chunk" ? chunk.code : chunk.source);
      }
      const source = readFileSync(resolve(root, "src/sw/sw.js"), "utf8")
        .replace("const SHELL = __SHELL__;", `const SHELL = ${JSON.stringify(shell)};`)
        .replace(
          "const VERSION = __VERSION__;",
          `const VERSION = "${hash.digest("hex").slice(0, 12)}";`,
        );
      if (source.includes("__SHELL__") || source.includes("__VERSION__")) {
        this.error("service worker placeholders were not replaced");
      }
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react(), serviceWorker()],
  define: { __LTM_VERSION__: JSON.stringify(pkg.version) },
  // The capture AudioWorklet is imported with `?worker&url`; modules keep it loadable by
  // `audioWorklet.addModule`.
  worker: { format: "es" },
  server: {
    proxy: {
      // Covers REST, the SSE stream at /api/v1/events and the ingest WebSocket used by
      // "listen with this device". Proxied responses are piped, so SSE is not buffered.
      "/api": { target: API_TARGET, changeOrigin: false, ws: true },
    },
  },
  preview: {
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: false, ws: true },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    // One self-hosted bundle on purpose: the protocol's zod schemas (shared with the server)
    // account for much of it, and validating responses against them is worth the bytes.
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
