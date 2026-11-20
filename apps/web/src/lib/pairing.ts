import type { DeviceAccess, DeviceKind } from "@ltm/protocol";

/** What the user says they are pairing in the pairing dialog. */
export type PairTarget = "extension" | "iphone" | "watch" | "agent" | "browser";

export const PAIR_TARGETS: readonly PairTarget[] = [
  "extension",
  "iphone",
  "watch",
  "agent",
  "browser",
];

export const TARGET_KIND: Record<PairTarget, DeviceKind> = {
  extension: "browser_extension",
  iphone: "iphone",
  watch: "apple_watch",
  agent: "desktop",
  browser: "web",
};

/**
 * The owner's own phone is meant to be a full reader, so memory access starts on for the
 * iPhone app. Everything else only captures unless the user opts in: a desk microphone or a
 * shared laptop should not be able to read the whole memory.
 */
export function defaultAccess(target: PairTarget): DeviceAccess {
  return target === "iphone" ? "memory" : "capture";
}

/** The watch pairs through the phone, and this browser pairs itself — neither shows a code. */
export function needsCode(target: PairTarget): boolean {
  return target !== "watch" && target !== "browser";
}

/** The `ltm-agent` command line shown for the capture agent. */
export function agentCommand(origin: string, code: string): string {
  return `ltm-agent pair --server ${origin} --code ${code}`;
}
