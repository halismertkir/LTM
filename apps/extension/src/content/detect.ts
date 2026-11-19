import type { MeetingHost } from "../shared/meetingHosts.js";

/**
 * "Is a call in progress on this page?" — heuristics only, deliberately conservative: a
 * false positive merely shows a dismissible banner, a false negative merely means the user
 * clicks the toolbar icon. Nothing is ever recorded because of this function alone.
 *
 * The strongest language-independent signal on every platform is a visible "leave / hang
 * up" control; the labels are matched in the two UI languages we ship plus the vendors'
 * stable attributes where they exist.
 */
const LEAVE_LABEL =
  /\b(leave( the)?( call| meeting)?|hang ?up|end( the)? call|end meeting)\b|ayrıl|görüşmeden çık|aramadan çık|aramayı sonlandır|toplantıdan çık|görüşmeyi sonlandır/i;

const MEET_CODE_PATH = /^\/[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}(\/|$)/i;

function hasLeaveControl(root: ParentNode): boolean {
  const candidates = root.querySelectorAll<HTMLElement>(
    "button[aria-label], [role='button'][aria-label], button[title]",
  );
  for (const el of candidates) {
    const label = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    if (label && LEAVE_LABEL.test(label) && isVisible(el)) return true;
  }
  return false;
}

function isVisible(el: HTMLElement): boolean {
  // offsetParent is null for display:none ancestors (and for fixed elements, hence the rect check).
  if (el.offsetParent !== null) return true;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function detectInCall(host: MeetingHost, doc: Document, location: Location): boolean {
  switch (host.id) {
    case "meet":
      if (!MEET_CODE_PATH.test(location.pathname)) return false;
      // Participant tiles only exist inside the call, not in the green room.
      return !!doc.querySelector("[data-participant-id]") || hasLeaveControl(doc);
    case "zoom":
      // The web client lives under /wc/ (join/start); everything else is marketing/portal.
      if (!/^\/wc\//.test(location.pathname)) return false;
      return (
        !!doc.querySelector(".footer__leave-btn, [class*='leave-meeting']") || hasLeaveControl(doc)
      );
    case "teams":
      return (
        !!doc.querySelector(
          "#hangup-button, [data-tid='hangup-main-btn'], [data-tid='call-hangup']",
        ) || hasLeaveControl(doc)
      );
  }
}

/**
 * Debounces the raw signal: a call must be seen on `onPolls` consecutive polls before it
 * counts, and must be gone for `offPolls` before we say it ended (calls re-render their UI
 * a lot; Meet briefly removes the controls when switching layouts).
 */
export class CallStateDebouncer {
  private state = false;
  private streak = 0;

  constructor(
    private readonly onPolls = 2,
    private readonly offPolls = 5,
  ) {}

  /** Returns the new state when it changed, otherwise null. */
  update(raw: boolean): boolean | null {
    if (raw === this.state) {
      this.streak = 0;
      return null;
    }
    this.streak++;
    if (this.streak >= (raw ? this.onPolls : this.offPolls)) {
      this.state = raw;
      this.streak = 0;
      return raw;
    }
    return null;
  }

  get inCall(): boolean {
    return this.state;
  }
}
