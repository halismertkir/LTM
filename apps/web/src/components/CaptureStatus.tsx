import { Link } from "react-router";
import { usePauseCapture } from "../api/queries";
import { type MessageKey, useI18n } from "../i18n";
import { type CaptureState, useCaptureState } from "../lib/capture";
import { IconLock, IconPause, IconPlay } from "./Icons";

const LABEL: Record<CaptureState, MessageKey> = {
  blocked: "capture.blocked",
  paused: "capture.paused",
  listening: "capture.listening",
  idle: "capture.idle",
};
// The phone top bar has room for one word.
const SHORT: Record<CaptureState, MessageKey> = {
  blocked: "capture.blockedShort",
  paused: "capture.pausedShort",
  listening: "capture.listening",
  idle: "capture.idle",
};

export function CaptureGlyph({ state }: { state: CaptureState }) {
  if (state === "blocked") return <IconLock size={16} />;
  if (state === "paused") return <IconPause size={16} />;
  return (
    <span
      className={state === "listening" ? "rec-dot pulsing" : "rec-dot idle"}
      aria-hidden="true"
    />
  );
}

/** Compact, always-visible capture indicator with a one-tap pause. */
export function CaptureStatus({ compact = false }: { compact?: boolean }) {
  const { t, tn } = useI18n();
  const { state, activeStreams } = useCaptureState();
  const pause = usePauseCapture();

  const detail =
    state === "listening"
      ? tn("capture.streams", activeStreams)
      : state === "blocked"
        ? t("capture.blockedDetail")
        : state === "paused"
          ? t("capture.pausedDetail")
          : t("capture.idleDetail");

  return (
    <section
      className={`capture capture-${state} ${compact ? "capture-compact" : ""}`}
      aria-label={t("capture.region")}
    >
      <div className="capture-main" aria-live="polite">
        <CaptureGlyph state={state} />
        <div className="capture-text">
          <strong>{t(compact ? SHORT[state] : LABEL[state])}</strong>
          {!compact && <span>{detail}</span>}
        </div>
      </div>
      {state === "blocked" ? (
        <Link className="btn btn-sm btn-warn" to="/consent">
          {compact ? t("capture.reviewShort") : t("capture.review")}
        </Link>
      ) : (
        <button
          type="button"
          className="btn btn-sm capture-toggle"
          aria-pressed={state === "paused"}
          disabled={pause.isPending}
          onClick={() => pause.mutate(state !== "paused")}
          title={state === "paused" ? t("capture.resume") : t("capture.pause")}
        >
          {state === "paused" ? <IconPlay size={14} /> : <IconPause size={14} />}
          <span className={compact ? "sr-only" : ""}>
            {state === "paused" ? t("capture.resume") : t("capture.pause")}
          </span>
        </button>
      )}
    </section>
  );
}
