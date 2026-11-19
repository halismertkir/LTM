import { useLive } from "../api/live";
import { useMeData } from "../api/queries";

/**
 * What the account is doing right now, in order of precedence. Because LTM records other
 * people, this is shown on every screen.
 * - blocked:   consent missing — the server refuses every ingest path.
 * - paused:    the user switched capture off account-wide.
 * - listening: at least one device stream is open.
 * - idle:      allowed to capture, but no device is streaming.
 */
export type CaptureState = "blocked" | "paused" | "listening" | "idle";

export function useCaptureState(): { state: CaptureState; activeStreams: number } {
  const me = useMeData();
  const live = useLive();
  const activeStreams = live.streams.length;
  let state: CaptureState = "idle";
  if (!me.consent.satisfied) state = "blocked";
  else if (me.ingestPaused) state = "paused";
  else if (activeStreams > 0) state = "listening";
  return { state, activeStreams };
}
