import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** Files reachable from "@ltm/capture" (the runtime-neutral entry), followed transitively. */
function reachable(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const text = readFileSync(resolve(src, entry), "utf8");
  for (const m of text.matchAll(/from "\.\/([\w-]+)\.js"/g)) reachable(`${m[1]}.ts`, seen);
  return seen;
}

describe("@ltm/capture entry points", () => {
  it("the neutral entry touches no browser, DOM or extension API", () => {
    const files = [...reachable("index.ts")];
    expect(files).not.toContain("browser.ts");
    expect(files).not.toContain("worklet.ts");
    for (const f of files) {
      const code = readFileSync(resolve(src, f), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
      expect(code, f).not.toMatch(
        /\bchrome\.|\bdocument\.|\bwindow\.|\bnavigator\.|AudioContext|MediaStream\b/,
      );
    }
  });

  it("exports the README API", () => {
    for (const name of [
      "StreamClient",
      "backoffDelay",
      "EnergyGate",
      "CaptureClock",
      "StreamingResampler",
      "CaptureDsp",
      "SpeechWindower",
      "CaptureSession",
      "floatToS16",
      "rmsDbfs",
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });

  it("the browser entry exports startBrowserCapture without needing Web Audio at import time", async () => {
    const browser = await import("../src/browser.js");
    expect(typeof browser.startBrowserCapture).toBe("function");
  });
});
