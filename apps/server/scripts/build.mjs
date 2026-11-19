// Bundles src/main.ts → dist/main.js. Workspace packages (@ltm/*, consumed as TS source)
// are bundled in; npm dependencies stay external and are resolved from node_modules at
// run time (PGlite in particular must load its .wasm/.data files from its own package).
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const external = Object.entries(pkg.dependencies)
  .filter(([, version]) => !String(version).startsWith("workspace:"))
  .map(([name]) => name);
// pg optionally requires pg-native; keep it external so the bundle never tries to inline it.
external.push("pg-native");

await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(join(root, "dist"), { recursive: true });
await build({
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(root, "dist/main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: external.flatMap((name) => [name, `${name}/*`]),
  banner: {
    js: "import { createRequire as __ltmCreateRequire } from 'node:module'; const require = __ltmCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
await cp(join(root, "migrations"), join(root, "dist/migrations"), { recursive: true });
console.log("build: dist/main.js + dist/migrations");
