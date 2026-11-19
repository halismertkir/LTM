import { describe, expect, it } from "vitest";
import {
  type AppEvent,
  type AppState,
  badgeFor,
  type CaptureSession,
  deriveView,
  INITIAL_STATE,
  reduce,
} from "../src/background/machine.js";

const AT = 1_763_000_000_000;

function session(
  source: "tab" | "mic",
  streamId: string,
  extra: Partial<CaptureSession> = {},
): CaptureSession {
  return {
    source,
    streamId,
    phase: "starting",
    startedAt: AT,
    mode: "audio",
    tabId: source === "tab" ? 7 : null,
    app: source === "tab" ? "meet.google.com" : null,
    title: null,
    companionOf: null,
    bufferedMs: 0,
    ...extra,
  };
}

function run(events: AppEvent[], from: AppState = INITIAL_STATE): AppState {
  return events.reduce(reduce, from);
}

const ready: AppEvent[] = [
  { type: "paired" },
  { type: "account", consentSatisfied: true, ingestPaused: false, thirdPartyAi: false },
];

describe("state machine", () => {
  it("starts not paired; pairing + satisfied consent → idle", () => {
    expect(deriveView(INITIAL_STATE).kind).toBe("not_paired");
    expect(deriveView(run([{ type: "paired" }])).kind).toBe("idle");
    expect(deriveView(run(ready)).kind).toBe("idle");
  });

  it("consent required → blocked; accepting clears it", () => {
    const s = run([
      { type: "paired" },
      { type: "account", consentSatisfied: false, ingestPaused: false, thirdPartyAi: true },
    ]);
    expect(deriveView(s).kind).toBe("consent_needed");
    expect(s.thirdPartyAi).toBe(true);
    const ok = reduce(s, {
      type: "account",
      consentSatisfied: true,
      ingestPaused: false,
      thirdPartyAi: true,
    });
    expect(deriveView(ok).kind).toBe("idle");
  });

  it("ignores capture requests while not paired", () => {
    const s = reduce(INITIAL_STATE, { type: "captureRequested", session: session("tab", "a") });
    expect(s.captures.tab).toBeNull();
  });

  it("walks a tab capture through starting → connecting → live → reconnecting → stopping → ended", () => {
    let s = run([...ready, { type: "captureRequested", session: session("tab", "a") }]);
    expect(deriveView(s)).toMatchObject({ kind: "listening", degraded: true, since: AT });
    expect(badgeFor(deriveView(s))).toMatchObject({ text: "REC", recording: true });

    s = reduce(s, {
      type: "streamPhase",
      source: "tab",
      streamId: "a",
      phase: "connecting",
      bufferedMs: 0,
    });
    s = reduce(s, {
      type: "streamPhase",
      source: "tab",
      streamId: "a",
      phase: "live",
      bufferedMs: 0,
    });
    expect(deriveView(s).degraded).toBe(false);
    expect(badgeFor(deriveView(s)).color).toBe("#d93025");

    s = reduce(s, {
      type: "streamPhase",
      source: "tab",
      streamId: "a",
      phase: "reconnecting",
      bufferedMs: 4000,
    });
    expect(s.captures.tab).toMatchObject({ phase: "reconnecting", bufferedMs: 4000 });
    expect(badgeFor(deriveView(s))).toMatchObject({
      text: "REC",
      recording: true,
      color: "#e8710a",
    });

    s = reduce(s, { type: "segment", source: "tab", streamId: "a", text: "hello", at: AT });
    expect(s.caption?.text).toBe("hello");

    s = reduce(s, { type: "stopRequested", source: "tab" });
    expect(s.captures.tab?.phase).toBe("stopping");
    // late phase events must not resurrect a stopping capture
    s = reduce(s, {
      type: "streamPhase",
      source: "tab",
      streamId: "a",
      phase: "live",
      bufferedMs: 0,
    });
    expect(s.captures.tab?.phase).toBe("stopping");
    expect(badgeFor(deriveView(s)).text).toBe("REC"); // indicator stays until really ended

    s = reduce(s, { type: "captureEnded", source: "tab", streamId: "a", reason: "user" });
    expect(s.captures.tab).toBeNull();
    expect(s.caption).toBeNull();
    expect(deriveView(s).kind).toBe("idle");
    expect(badgeFor(deriveView(s)).text).toBe("");
  });

  it("ignores events of stale streams", () => {
    let s = run([...ready, { type: "captureRequested", session: session("tab", "new") }]);
    s = reduce(s, { type: "captureEnded", source: "tab", streamId: "old", reason: "x" });
    s = reduce(s, {
      type: "fatal",
      source: "tab",
      streamId: "old",
      code: "unauthorized",
      message: "",
      at: AT,
    });
    expect(s.captures.tab?.streamId).toBe("new");
    expect(s.paired).toBe(true);
  });

  it("does not start a second capture of the same source", () => {
    const s = run([
      ...ready,
      { type: "captureRequested", session: session("mic", "m1") },
      { type: "captureRequested", session: session("mic", "m2") },
    ]);
    expect(s.captures.mic?.streamId).toBe("m1");
  });

  it("tab + mic → listening to both; ending one keeps the other", () => {
    let s = run([
      ...ready,
      { type: "captureRequested", session: session("tab", "t") },
      {
        type: "captureRequested",
        session: session("mic", "m", { companionOf: "tab", startedAt: AT + 5 }),
      },
    ]);
    const v = deriveView(s);
    expect(v.kind).toBe("listening");
    expect(v.tab && v.mic).toBeTruthy();
    expect(v.since).toBe(AT);
    s = reduce(s, { type: "captureEnded", source: "tab", streamId: "t", reason: "tab_closed" });
    expect(deriveView(s).kind).toBe("listening");
    expect(s.captures.mic).not.toBeNull();
  });

  it("fatal unauthorized → not paired with an explanation", () => {
    const s = run([
      ...ready,
      { type: "captureRequested", session: session("tab", "t") },
      { type: "captureRequested", session: session("mic", "m") },
      {
        type: "fatal",
        source: "tab",
        streamId: "t",
        code: "unauthorized",
        message: "revoked",
        at: AT,
      },
    ]);
    expect(s.paired).toBe(false);
    expect(s.captures).toEqual({ tab: null, mic: null });
    expect(s.error?.kind).toBe("unauthorized");
    expect(deriveView(s).kind).toBe("not_paired");
  });

  it("fatal consent_required → blocked, all captures cleared", () => {
    const s = run([
      ...ready,
      { type: "captureRequested", session: session("tab", "t") },
      { type: "captureRequested", session: session("mic", "m") },
      {
        type: "fatal",
        source: "mic",
        streamId: "m",
        code: "consent_required",
        message: "",
        at: AT,
      },
    ]);
    expect(s.captures).toEqual({ tab: null, mic: null });
    expect(deriveView(s).kind).toBe("consent_needed");
    expect(badgeFor(deriveView(s))).toMatchObject({ text: "!", recording: false });
  });

  it("fatal ingest_paused → paused; resuming on the server clears it", () => {
    let s = run([
      ...ready,
      { type: "captureRequested", session: session("tab", "t") },
      { type: "fatal", source: "tab", streamId: "t", code: "ingest_paused", message: "", at: AT },
    ]);
    expect(deriveView(s).kind).toBe("paused");
    expect(badgeFor(deriveView(s)).text).toBe("II");
    s = reduce(s, {
      type: "account",
      consentSatisfied: true,
      ingestPaused: false,
      thirdPartyAi: false,
    });
    expect(deriveView(s).kind).toBe("idle");
    expect(s.error).toBeNull();
  });

  it("fatal unsupported_protocol → error view", () => {
    const s = run([
      ...ready,
      { type: "captureRequested", session: session("tab", "t") },
      {
        type: "fatal",
        source: "tab",
        streamId: "t",
        code: "unsupported_protocol",
        message: "v2 only",
        at: AT,
      },
    ]);
    expect(deriveView(s).kind).toBe("error");
    expect(s.error).toMatchObject({ kind: "unsupported_protocol", detail: "v2 only" });
  });

  it("an account refresh that says 'paused' stops showing captures", () => {
    const s = run([
      ...ready,
      { type: "captureRequested", session: session("tab", "t") },
      { type: "account", consentSatisfied: true, ingestPaused: true, thirdPartyAi: false },
    ]);
    expect(s.captures.tab).toBeNull();
    expect(deriveView(s).kind).toBe("paused");
  });

  it("a failed mic start shows an error but keeps the tab capture", () => {
    let s = run([
      ...ready,
      { type: "captureRequested", session: session("tab", "t") },
      { type: "captureRequested", session: session("mic", "m") },
      {
        type: "failed",
        source: "mic",
        streamId: "m",
        kind: "mic_denied",
        detail: "NotAllowedError",
        at: AT,
      },
    ]);
    expect(s.captures.mic).toBeNull();
    expect(s.captures.tab).not.toBeNull();
    expect(s.error?.kind).toBe("mic_denied");
    expect(deriveView(s).kind).toBe("listening");
    s = reduce(s, { type: "dismissError" });
    expect(s.error).toBeNull();
  });

  it("user un-pair resets everything without an error; revocation leaves one", () => {
    const base = run([
      ...ready,
      { type: "meetingTab", tabId: 3, info: { app: "meet.google.com", title: "x" } },
    ]);
    const user = reduce(base, { type: "unpaired", reason: "user", at: AT });
    expect(user.paired).toBe(false);
    expect(user.error).toBeNull();
    expect(user.meetingTabs["3"]).toBeDefined();
    expect(reduce(base, { type: "unpaired", reason: "revoked", at: AT }).error?.kind).toBe(
      "unauthorized",
    );
  });

  it("meeting tabs show a hint badge only when idle", () => {
    let s = run([
      ...ready,
      { type: "meetingTab", tabId: 3, info: { app: "meet.google.com", title: "Standup" } },
    ]);
    expect(badgeFor(deriveView(s), Object.keys(s.meetingTabs).length > 0)).toMatchObject({
      text: "•",
      recording: false,
    });
    s = reduce(s, { type: "captureRequested", session: session("tab", "t", { tabId: 3 }) });
    expect(badgeFor(deriveView(s), true).text).toBe("REC");
    s = reduce(s, { type: "tabGone", tabId: 3 });
    expect(s.meetingTabs).toEqual({});
  });

  it("is pure: does not mutate its input", () => {
    const s = run(ready);
    const frozen = JSON.stringify(s);
    reduce(s, { type: "captureRequested", session: session("tab", "t") });
    expect(JSON.stringify(s)).toBe(frozen);
  });
});
