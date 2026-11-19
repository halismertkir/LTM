import type { ActiveCaptureInfo, ToOffscreen } from "../shared/messages.js";

const OFFSCREEN_PATH = "offscreen.html";

/**
 * Only one offscreen document may exist per extension and `createDocument` throws if one
 * already does — including while a previous `createDocument` is still in flight, which is
 * easy to hit when "tab" and "mic" start together. Hence the shared promise.
 */
let creating: Promise<void> | null = null;

export async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

export async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        // USER_MEDIA keeps the document alive for as long as it holds a capture stream.
        // (AUDIO_PLAYBACK would get it closed after 30 s without audible output.)
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Capture tab and microphone audio and stream it to your LTM server.",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

export async function closeOffscreen(): Promise<void> {
  if (creating) await creating.catch(() => undefined);
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
}

/**
 * `createDocument` resolves once the document has loaded, but a message can still race
 * the module script registering its listener ("Receiving end does not exist"), so retry
 * briefly instead of failing the capture.
 */
export async function sendToOffscreen<T = unknown>(msg: ToOffscreen, attempts = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return (await chrome.runtime.sendMessage(msg)) as T;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw lastErr;
}

export async function listOffscreenCaptures(): Promise<ActiveCaptureInfo[] | null> {
  if (!(await hasOffscreen())) return null;
  try {
    const reply = await sendToOffscreen<ActiveCaptureInfo[]>(
      { target: "offscreen", kind: "capture:list" },
      3,
    );
    return Array.isArray(reply) ? reply : [];
  } catch {
    return [];
  }
}
