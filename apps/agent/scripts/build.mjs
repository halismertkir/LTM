// Bundles the agent into one self-contained ES module: dist/ltm-agent.mjs (bin `ltm-agent`).
// Everything is inlined (workspace packages and zod); there are no native dependencies,
// so the file runs anywhere Node 22+ and ffmpeg are installed.
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = process.argv[2] ?? join(root, "dist/ltm-agent.mjs");

if (!process.argv[2]) await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [join(root, "src/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: process.argv[2] ? "warning" : "info",
});
await chmod(outfile, 0o755);
if (!process.argv[2]) console.log(`build: ${outfile}`);
