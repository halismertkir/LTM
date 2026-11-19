/**
 * Offscreen document (reason USER_MEDIA): owns all audio and the ingest sockets.
 *
 * Offscreen documents only get the `chrome.runtime` API — no storage, tabs or action —
 * so everything a session needs arrives in the `capture:start` message, and everything
 * the rest of the extension needs to know goes back as messages to the worker.
 */
import {
  type ActiveCaptureInfo,
  type CaptureSource,
  type FromOffscreen,
  isToOffscreen,
} from "../shared/messages.js";
import type { WebSocketLike } from "../stream/client.js";
import { isPermissionError, openMicStream, openTabStream } from "./media.js";
import { CapturePipeline } from "./pipeline.js";
import { CaptureSessionRunner } from "./session.js";
import { createTranscriber } from "./transcriber.js";

const sessions = new Map<CaptureSource, CaptureSessionRunner>();

function report(msg: FromOffscreen): void {
  if (msg.kind === "capture:ended" || msg.kind === "capture:failed") {
    const cur = sessions.get(msg.source);
    if (cur?.spec.streamId === msg.streamId) sessions.delete(msg.source);
  }
  // The worker may be asleep; sending wakes it. Errors only mean nobody listens right now.
  chrome.runtime.sendMessage(msg).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isToOffscreen(msg)) return false;
  switch (msg.kind) {
    case "capture:start": {
      const { spec } = msg;
      const existing = sessions.get(spec.source);
      if (existing) void existing.stop("replaced");
      const runner = new CaptureSessionRunner(spec, {
        openStream: (s) => {
          if (s.source === "tab") {
            if (!s.tabMediaStreamId) throw new Error("missing tab stream id");
            return openTabStream(s.tabMediaStreamId);
          }
          return openMicStream();
        },
        startPipeline: (opts) => CapturePipeline.start(opts),
        // The DOM WebSocket satisfies WebSocketLike structurally except for the handlers'
        // `this`/event parameter types, which the client never relies on.
        createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
        createTranscriber,
        report,
        isPermissionError,
      });
      sessions.set(spec.source, runner);
      void runner.start();
      sendResponse({ ok: true });
      return false;
    }
    case "capture:stop": {
      const runner = sessions.get(msg.source);
      if (runner) {
        void runner.stop(msg.reason);
      }
      sendResponse({ ok: true });
      return false;
    }
    case "capture:list": {
      const list: ActiveCaptureInfo[] = [...sessions.values()].map((s) => ({
        source: s.source,
        streamId: s.spec.streamId,
      }));
      sendResponse(list);
      return false;
    }
  }
  return false;
});
