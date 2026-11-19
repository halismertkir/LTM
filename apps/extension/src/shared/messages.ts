import type { AudioSource, StreamContext, StreamMode, TranscriptSegment } from "@ltm/protocol";

/**
 * Messages between the extension's contexts. `chrome.runtime.sendMessage` is delivered to
 * *every* extension page (worker, popup, options, offscreen) except the sender, so each
 * message names its `target` and every listener ignores the rest.
 */
export type CaptureSource = Extract<AudioSource, "tab" | "mic">;

/** What the worker hands the offscreen document to start one stream. The offscreen
 * document cannot read chrome.storage (it only gets `chrome.runtime`), so it gets all the
 * configuration it needs here. */
export interface CaptureStartSpec {
  source: CaptureSource;
  streamId: string;
  serverUrl: string;
  token: string;
  mode: StreamMode;
  language?: string;
  context?: StreamContext;
  /** From chrome.tabCapture.getMediaStreamId — only for source "tab". */
  tabMediaStreamId?: string;
}

export type ToOffscreen =
  | { target: "offscreen"; kind: "capture:start"; spec: CaptureStartSpec }
  | { target: "offscreen"; kind: "capture:stop"; source: CaptureSource; reason: string }
  | { target: "offscreen"; kind: "capture:list" };

export type OffscreenPhase = "connecting" | "live" | "reconnecting";

export type FromOffscreen =
  | {
      target: "background";
      kind: "stream:phase";
      source: CaptureSource;
      streamId: string;
      phase: OffscreenPhase;
      bufferedMs: number;
    }
  | {
      target: "background";
      kind: "stream:segment";
      source: CaptureSource;
      streamId: string;
      segment: Pick<TranscriptSegment, "text" | "startMs" | "endMs">;
    }
  | {
      target: "background";
      kind: "stream:fatal";
      source: CaptureSource;
      streamId: string;
      code: string;
      message: string;
    }
  | {
      target: "background";
      kind: "capture:failed";
      source: CaptureSource;
      streamId: string;
      /** "mic_denied" | "capture_failed" | "transcriber_unavailable" */
      code: string;
      message: string;
    }
  | {
      target: "background";
      kind: "capture:ended";
      source: CaptureSource;
      streamId: string;
      reason: string;
    };

export interface ActiveCaptureInfo {
  source: CaptureSource;
  streamId: string;
}

/** Popup / options page → worker. Replies are typed per kind in `UiReply`. */
export type FromUi =
  | { target: "background"; kind: "ui:hello" }
  | { target: "background"; kind: "ui:start"; source: CaptureSource; tabId?: number }
  | { target: "background"; kind: "ui:stop"; source: CaptureSource | "all" }
  | { target: "background"; kind: "ui:refresh" }
  | { target: "background"; kind: "ui:paired" }
  | { target: "background"; kind: "ui:unpair" }
  | { target: "background"; kind: "ui:dismissError" };

/** Content script → worker. */
export type FromContent =
  | { target: "background"; kind: "content:meeting"; inCall: boolean; title: string }
  | { target: "background"; kind: "content:start" }
  | { target: "background"; kind: "content:never" };

export type StartResult = { ok: true } | { ok: false; reason: StartFailure; message?: string };

export type StartFailure =
  | "not_paired"
  | "consent_required"
  | "ingest_paused"
  | "already_capturing"
  | "needs_invocation"
  | "restricted_tab"
  | "capture_failed";

export interface MeetingOfferReply {
  offer: boolean;
}

export type ToBackground = FromOffscreen | FromUi | FromContent;

export function isToBackground(msg: unknown): msg is ToBackground {
  return !!msg && typeof msg === "object" && (msg as { target?: unknown }).target === "background";
}

export function isToOffscreen(msg: unknown): msg is ToOffscreen {
  return !!msg && typeof msg === "object" && (msg as { target?: unknown }).target === "offscreen";
}
