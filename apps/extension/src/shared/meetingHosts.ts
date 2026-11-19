/**
 * The one place that knows which sites are "meeting sites". The manifest's
 * `content_scripts.matches` is generated from this list, and the content script and the
 * worker use it to recognise them, so adding a host here is all it takes.
 *
 * Keep it minimal: every entry adds an install-time host warning
 * ("Read and change your data on …") because a content script runs there.
 */
export interface MeetingHost {
  /** Short id used for host-specific heuristics. */
  id: "meet" | "zoom" | "teams";
  /** Exact hostname, or a parent domain when `subdomains` is true. */
  hostname: string;
  subdomains: boolean;
}

export const MEETING_HOSTS: readonly MeetingHost[] = [
  { id: "meet", hostname: "meet.google.com", subdomains: false },
  { id: "zoom", hostname: "zoom.us", subdomains: true },
  { id: "teams", hostname: "teams.microsoft.com", subdomains: false },
  { id: "teams", hostname: "teams.live.com", subdomains: false },
];

/** Chrome match patterns for the manifest (https only — none of these serve meetings over http). */
export function meetingMatchPatterns(): string[] {
  return MEETING_HOSTS.map((h) =>
    h.subdomains ? `https://*.${h.hostname}/*` : `https://${h.hostname}/*`,
  );
}

export function meetingHostFor(hostname: string): MeetingHost | null {
  const host = hostname.toLowerCase();
  for (const h of MEETING_HOSTS) {
    if (host === h.hostname) return h;
    if (h.subdomains && host.endsWith(`.${h.hostname}`)) return h;
  }
  return null;
}
