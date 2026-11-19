import type { ProviderKind } from "@ltm/protocol";
import { ProviderError } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_TOKENS = 16_000;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi, "$1[redacted]"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
  [/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[redacted]"],
  [/(api[_-]?key["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
];

/**
 * Removes credentials from text that may be shown to a user or written to a log.
 * Upstream error bodies sometimes echo request headers or a partial key.
 */
export function redact(text: string, secrets: Array<string | null | undefined> = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** A signal that fires on the caller's abort or after `timeoutMs`, and tells which one it was. */
export function deadline(
  timeoutMs: number,
  outer?: AbortSignal,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}

export function abortedError(
  provider: ProviderKind,
  timedOut: boolean,
  timeoutMs: number,
  cause?: unknown,
): ProviderError {
  return timedOut
    ? new ProviderError(provider, "timeout", `request timed out after ${timeoutMs} ms`, { cause })
    : new ProviderError(provider, "unknown", "request was aborted", { retryable: false, cause });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function requireValue<T>(
  provider: ProviderKind,
  value: T | null | undefined,
  what: string,
): T {
  if (value === null || value === undefined || value === "") {
    throw new ProviderError(provider, "not_configured", `${what} is required for ${provider}`);
  }
  return value;
}

/** Strips a leading `<think>…</think>` block that some local reasoning models put in the answer. */
export function stripReasoning(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "");
}

export function addUsage(
  a: { inputTokens?: number; outputTokens?: number } | undefined,
  b: { inputTokens?: number; outputTokens?: number } | undefined,
): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: { inputTokens?: number; outputTokens?: number } = {};
  if (a.inputTokens !== undefined || b.inputTokens !== undefined)
    out.inputTokens = (a.inputTokens ?? 0) + (b.inputTokens ?? 0);
  if (a.outputTokens !== undefined || b.outputTokens !== undefined)
    out.outputTokens = (a.outputTokens ?? 0) + (b.outputTokens ?? 0);
  return out;
}

/** Duration of a canonical PCM WAV file, or undefined when the bytes are not one. */
export function wavDurationSec(audio: Uint8Array): number | undefined {
  if (audio.byteLength < 44) return undefined;
  const v = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const tag = (o: number) =>
    String.fromCharCode(audio[o]!, audio[o + 1]!, audio[o + 2]!, audio[o + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined;
  let o = 12;
  let byteRate = 0;
  while (o + 8 <= audio.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === "fmt " && o + 16 <= audio.byteLength) byteRate = v.getUint32(o + 16, true);
    if (id === "data") {
      if (!byteRate) return undefined;
      const bytes = Math.min(size, audio.byteLength - o - 8);
      return bytes / byteRate;
    }
    o += 8 + size + (size % 2);
  }
  return undefined;
}
