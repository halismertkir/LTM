import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, defineConfig, type Plugin } from "vite";
import { buildManifest } from "./src/manifest.ts";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, "dist");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };

/**
 * Two files cannot be part of the main multi-entry build:
 * - the content script must be a classic script (MV3 content scripts are not modules),
 *   so it is bundled on its own as an IIFE with everything inlined;
 * - the AudioWorklet module is loaded by URL with `audioWorklet.addModule()` and runs in a
 *   scope without `chrome`/DOM, so it gets its own self-contained bundle too.
 */
const satellites = [
  { entry: "src/content/index.ts", file: "content.js", format: "iife" as const },
  { entry: "src/audio/worklet.ts", file: "capture-worklet.js", format: "es" as const },
];

async function buildSatellites(watch: boolean, mode: string): Promise<void> {
  for (const s of satellites) {
    await build({
      configFile: false,
      root,
      mode,
      publicDir: false,
      logLevel: "warn",
      build: {
        outDir,
        emptyOutDir: false,
        target: "chrome116",
        minify: mode !== "development",
        sourcemap: mode === "development" ? "inline" : false,
        watch: watch ? {} : null,
        lib: {
          entry: resolve(root, s.entry),
          formats: [s.format],
          name: "ltm",
          fileName: () => s.file,
        },
      },
    });
  }
}

function extension(): Plugin {
  let watch = false;
  let mode = "production";
  let satellitesStarted = false;
  return {
    name: "ltm-extension",
    apply: "build",
    configResolved(config) {
      watch = !!config.build.watch;
      mode = config.mode;
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: `${JSON.stringify(buildManifest(pkg.version), null, 2)}\n`,
      });
    },
    async closeBundle() {
      // In watch mode the satellite builds run their own watchers; start them once.
      if (satellitesStarted && watch) return;
      satellitesStarted = true;
      await buildSatellites(watch, mode);
    },
  };
}

export default defineConfig(({ mode }) => ({
  root,
  base: "./",
  publicDir: "public",
  plugins: [extension()],
  build: {
    outDir,
    emptyOutDir: true,
    target: "chrome116",
    // The service worker cannot use dynamic import() and extension pages need no
    // preload polyfill; this also keeps Vite's preload helper (which touches `document`)
    // out of chunks shared with the worker.
    modulePreload: false,
    // No data: URLs — every asset is a file inside the package.
    assetsInlineLimit: 0,
    minify: mode !== "development",
    sourcemap: mode === "development" ? "inline" : false,
    rolldownOptions: {
      input: {
        popup: resolve(root, "popup.html"),
        options: resolve(root, "options.html"),
        offscreen: resolve(root, "offscreen.html"),
        background: resolve(root, "src/background/index.ts"),
      },
      output: {
        // Fixed name: manifest.json points at it.
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
}));
