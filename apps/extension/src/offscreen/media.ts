/** Opens the tab stream whose id the worker got from `chrome.tabCapture.getMediaStreamId`. */
export async function openTabStream(mediaStreamId: string): Promise<MediaStream> {
  // The legacy `mandatory` constraint syntax is the only one Chrome accepts for
  // chromeMediaSource; it is not in the standard typings.
  const constraints = {
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: mediaStreamId } },
    video: false,
  } as unknown as MediaStreamConstraints;
  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * Microphone. Offscreen documents cannot show a permission prompt, so this only works
 * after the user granted the extension microphone access on the options page.
 */
export async function openMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      // Echo cancellation removes most of the call audio coming out of the speakers, so
      // the mic stream carries the user's own voice; the server de-duplicates the rest.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });
}

export function isPermissionError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError";
}
