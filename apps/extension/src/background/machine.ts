import type { StreamMode } from "@ltm/protocol";
import type { CaptureSource, OffscreenPhase } from "../shared/messages.js";

/**
 * The worker's state machine as a pure reducer. The worker keeps no state in memory: the
 * current `AppState` lives in `chrome.storage.session` (survives the worker being killed,
 * cleared when the browser restarts — exactly the lifetime of a capture), every event is
 * reduced into a new state, and the badge, the popup and the offscreen document are driven
 * from the result.
 */
export type CapturePhase = "starting" | OffscreenPhase | "stopping";

export interface CaptureSession {
  source: CaptureSource;
  streamId: string;
  phase: CapturePhase;
  startedAt: number;
  mode: StreamMode;
  /** Tab being captured (source "tab"). */
  tabId: number | null;
  /** Hostname and title sent as stream context. */
  app: string | null;
  title: string | null;
  /** A mic stream started automatically together with a tab stream stops with it. */
  companionOf: CaptureSource | null;
  bufferedMs: number;
}

export type ErrorKind =
  | "unauthorized"
  | "consent_required"
  | "ingest_paused"
  | "unsupported_protocol"
  | "needs_invocation"
  | "restricted_tab"
  | "mic_denied"
  | "capture_failed"
  | "server_unreachable"
  | "stream_error";

export interface AppError {
  kind: ErrorKind;
  detail: string;
  source: CaptureSource | null;
  at: number;
}

export type ConsentStatus = "unknown" | "satisfied" | "required";

export interface AppState {
  paired: boolean;
  consent: ConsentStatus;
  ingestPaused: boolean;
  /** A provider outside the user's infrastructure is configured (adds a notice sentence). */
  thirdPartyAi: boolean;
  captures: Record<CaptureSource, CaptureSession | null>;
  error: AppError | null;
  caption: { text: string; source: CaptureSource; at: number } | null;
  /** Tabs where the content script saw a call in progress (keyed by tab id). */
  meetingTabs: Record<string, { app: string; title: string }>;
}

export const INITIAL_STATE: AppState = {
  paired: false,
  consent: "unknown",
  ingestPaused: false,
  thirdPartyAi: false,
  captures: { tab: null, mic: null },
  error: null,
  caption: null,
  meetingTabs: {},
};

export type AppEvent =
  | { type: "paired" }
  | { type: "unpaired"; reason: "user" | "revoked"; at: number }
  | { type: "account"; consentSatisfied: boolean; ingestPaused: boolean; thirdPartyAi: boolean }
  | { type: "captureRequested"; session: CaptureSession }
  | {
      type: "streamPhase";
      source: CaptureSource;
      streamId: string;
      phase: OffscreenPhase;
      bufferedMs: number;
    }
  | { type: "stopRequested"; source: CaptureSource }
  | { type: "captureEnded"; source: CaptureSource; streamId: string; reason: string }
  | {
      type: "fatal";
      source: CaptureSource;
      streamId: string;
      code: string;
      message: string;
      at: number;
    }
  | {
      type: "failed";
      source: CaptureSource | null;
      streamId?: string;
      kind: ErrorKind;
      detail: string;
      at: number;
    }
  | { type: "segment"; source: CaptureSource; streamId: string; text: string; at: number }
  | { type: "meetingTab"; tabId: number; info: { app: string; title: string } | null }
  | { type: "tabGone"; tabId: number }
  | { type: "dismissError" }
  | { type: "reset" };

const NO_CAPTURES: AppState["captures"] = { tab: null, mic: null };

function errorFromCode(code: string): ErrorKind {
  switch (code) {
    case "unauthorized":
    case "consent_required":
    case "ingest_paused":
    case "unsupported_protocol":
      return code;
    default:
      return "stream_error";
  }
}

function matches(state: AppState, source: CaptureSource, streamId: string): boolean {
  return state.captures[source]?.streamId === streamId;
}

export function reduce(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "paired":
      return { ...INITIAL_STATE, paired: true, meetingTabs: state.meetingTabs };

    case "unpaired":
      return {
        ...INITIAL_STATE,
        meetingTabs: state.meetingTabs,
        error:
          event.reason === "revoked"
            ? { kind: "unauthorized", detail: "", source: null, at: event.at }
            : null,
      };

    case "account": {
      const consent: ConsentStatus = event.consentSatisfied ? "satisfied" : "required";
      const blocked = consent === "required" || event.ingestPaused;
      let error = state.error;
      // Clear an account-level error once the server says it no longer applies.
      if (error?.kind === "consent_required" && consent === "satisfied") error = null;
      if (error?.kind === "ingest_paused" && !event.ingestPaused) error = null;
      return {
        ...state,
        consent,
        ingestPaused: event.ingestPaused,
        thirdPartyAi: event.thirdPartyAi,
        error,
        // Never keep showing "recording" for streams the server will refuse anyway; the
        // controller stops them in the offscreen document at the same time.
        captures: blocked ? NO_CAPTURES : state.captures,
      };
    }

    case "captureRequested": {
      const s = event.session;
      if (!state.paired || state.captures[s.source]) return state;
      const error =
        state.error?.source === s.source || state.error?.source === null ? null : state.error;
      return { ...state, error, captures: { ...state.captures, [s.source]: s } };
    }

    case "streamPhase": {
      if (!matches(state, event.source, event.streamId)) return state; // stale event
      const cur = state.captures[event.source]!;
      if (cur.phase === "stopping") return state;
      return {
        ...state,
        captures: {
          ...state.captures,
          [event.source]: { ...cur, phase: event.phase, bufferedMs: event.bufferedMs },
        },
      };
    }

    case "stopRequested": {
      const cur = state.captures[event.source];
      if (!cur) return state;
      return {
        ...state,
        captures: { ...state.captures, [event.source]: { ...cur, phase: "stopping" } },
      };
    }

    case "captureEnded": {
      if (!matches(state, event.source, event.streamId)) return state;
      const captures = { ...state.captures, [event.source]: null };
      const anyLeft = captures.tab || captures.mic;
      return { ...state, captures, caption: anyLeft ? state.caption : null };
    }

    case "fatal": {
      if (!matches(state, event.source, event.streamId)) return state;
      const kind = errorFromCode(event.code);
      const error: AppError = { kind, detail: event.message, source: event.source, at: event.at };
      switch (kind) {
        case "unauthorized":
          // The device token was revoked: back to "not paired"; the controller forgets it.
          return { ...INITIAL_STATE, meetingTabs: state.meetingTabs, error };
        case "consent_required":
          return { ...state, consent: "required", captures: NO_CAPTURES, error, caption: null };
        case "ingest_paused":
          return { ...state, ingestPaused: true, captures: NO_CAPTURES, error, caption: null };
        case "unsupported_protocol":
          return { ...state, captures: NO_CAPTURES, error, caption: null };
        default:
          return { ...state, captures: { ...state.captures, [event.source]: null }, error };
      }
    }

    case "failed": {
      let captures = state.captures;
      if (event.source && event.streamId && matches(state, event.source, event.streamId)) {
        captures = { ...captures, [event.source]: null };
      }
      return {
        ...state,
        captures,
        error: { kind: event.kind, detail: event.detail, source: event.source, at: event.at },
      };
    }

    case "segment":
      if (!matches(state, event.source, event.streamId)) return state;
      return { ...state, caption: { text: event.text, source: event.source, at: event.at } };

    case "meetingTab": {
      const key = String(event.tabId);
      const meetingTabs = { ...state.meetingTabs };
      if (event.info) meetingTabs[key] = event.info;
      else delete meetingTabs[key];
      return { ...state, meetingTabs };
    }

    case "tabGone": {
      const key = String(event.tabId);
      if (!(key in state.meetingTabs)) return state;
      const meetingTabs = { ...state.meetingTabs };
      delete meetingTabs[key];
      return { ...state, meetingTabs };
    }

    case "dismissError":
      return { ...state, error: null };

    case "reset":
      return { ...INITIAL_STATE, paired: state.paired };
  }
}

// ---------------------------------------------------------------------------------------
// Views derived from the state (popup headline, toolbar badge)
// ---------------------------------------------------------------------------------------

export type ViewKind = "not_paired" | "consent_needed" | "paused" | "listening" | "error" | "idle";

export interface View {
  kind: ViewKind;
  tab: CaptureSession | null;
  mic: CaptureSession | null;
  /** Any stream is connecting/reconnecting (audio is being buffered). */
  degraded: boolean;
  /** Earliest start of the running captures, for the elapsed-time display. */
  since: number | null;
}

export function isCapturing(state: AppState): boolean {
  return !!(state.captures.tab || state.captures.mic);
}

export function deriveView(state: AppState): View {
  const { tab, mic } = state.captures;
  const running = [tab, mic].filter((c): c is CaptureSession => !!c);
  const base = {
    tab,
    mic,
    degraded: running.some((c) => c.phase !== "live" && c.phase !== "stopping"),
    since: running.length ? Math.min(...running.map((c) => c.startedAt)) : null,
  };
  // While anything is being captured that has to be the headline, whatever else is true.
  if (running.length) return { kind: "listening", ...base };
  if (!state.paired) return { kind: "not_paired", ...base };
  if (state.consent === "required") return { kind: "consent_needed", ...base };
  if (state.ingestPaused) return { kind: "paused", ...base };
  if (state.error) return { kind: "error", ...base };
  return { kind: "idle", ...base };
}

export interface BadgeSpec {
  text: string;
  color: string;
  recording: boolean;
}

export const BADGE_COLORS = {
  rec: "#d93025",
  recDegraded: "#e8710a",
  warn: "#f9ab00",
  paused: "#5f6368",
  error: "#d93025",
  hint: "#1a73e8",
} as const;

export function badgeFor(view: View, meetingDetected = false): BadgeSpec {
  switch (view.kind) {
    case "listening":
      return {
        text: "REC",
        color: view.degraded ? BADGE_COLORS.recDegraded : BADGE_COLORS.rec,
        recording: true,
      };
    case "consent_needed":
      return { text: "!", color: BADGE_COLORS.warn, recording: false };
    case "paused":
      return { text: "II", color: BADGE_COLORS.paused, recording: false };
    case "error":
      return { text: "!", color: BADGE_COLORS.error, recording: false };
    case "idle":
      // A call is running in some tab: a quiet hint that one click starts recording.
      return { text: meetingDetected ? "•" : "", color: BADGE_COLORS.hint, recording: false };
    case "not_paired":
      return { text: "", color: BADGE_COLORS.hint, recording: false };
  }
}
