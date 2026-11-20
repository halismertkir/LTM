import { type ReactNode, useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useListen } from "../api/listen";
import { useMeData, usePauseCapture } from "../api/queries";
import { type MessageKey, useI18n } from "../i18n";
import { formatClock } from "../lib/format";
import { useNow } from "../lib/hooks";
import { browserDeviceName, type ListenErrorKind, type ListenPhase } from "../lib/listen";
import { Dialog } from "./Dialog";
import { IconMic, IconStop } from "./Icons";

const PHASE_KEY: Partial<Record<ListenPhase, MessageKey>> = {
  pairing: "listen.phasePairing",
  microphone: "listen.phaseMicrophone",
  connecting: "listen.phaseConnecting",
  streaming: "listen.phaseStreaming",
  reconnecting: "listen.phaseReconnecting",
  stopping: "listen.phaseStopping",
};

const ERROR_KEY: Record<ListenErrorKind, MessageKey> = {
  unsupported: "listen.errUnsupported",
  permission: "listen.errPermission",
  "no-microphone": "listen.errNoMic",
  consent: "listen.errConsent",
  paused: "listen.errPaused",
  unauthorized: "listen.errUnauthorized",
  pairing: "listen.errPairing",
  other: "listen.errOther",
};

/** dBFS (−60…0) → 0…100 % for the level meter. */
function levelPercent(dbfs: number): number {
  return Math.round(Math.max(0, Math.min(1, (dbfs + 60) / 60)) * 100);
}

/**
 * "Listen with this device": start/stop, unmistakable recording state with elapsed time,
 * input level and live captions. `strip` sits inside the live strip, `panel` on Devices.
 */
export function ListenControl({
  variant = "strip",
  autoStart = false,
}: {
  variant?: "strip" | "panel";
  autoStart?: boolean;
}) {
  const { t } = useI18n();
  const me = useMeData();
  const navigate = useNavigate();
  const pause = usePauseCapture();
  const { state, controller } = useListen();
  const [intro, setIntro] = useState(false);
  const titleId = useId();
  const active = !["idle", "error"].includes(state.phase);
  const recording = state.phase === "streaming" || state.phase === "reconnecting";
  const now = useNow(1000, recording);
  const paused = me.ingestPaused;
  const blocked = !me.consent.satisfied;
  const name = state.device?.name ?? browserDeviceName(navigator.userAgent);

  // Arriving from "Listen" links (?listen=1): explain first; the microphone needs a tap anyway.
  useEffect(() => {
    if (autoStart && !controller.active) setIntro(true);
  }, [autoStart, controller]);

  const begin = () => {
    setIntro(false);
    void controller.start();
  };
  const onListen = () => {
    if (blocked) navigate("/consent");
    else setIntro(true);
  };

  let body: ReactNode;
  if (active) {
    const dbfs = state.level?.dbfs ?? -60;
    body = (
      <section
        className={`listen-active ${recording ? "is-recording" : ""}`}
        aria-labelledby={titleId}
      >
        <div className="listen-head">
          <span className={recording ? "rec-dot pulsing" : "rec-dot"} aria-hidden="true" />
          <strong id={titleId} aria-live="polite">
            {t(PHASE_KEY[state.phase] ?? "listen.phaseConnecting")}
          </strong>
          {recording && state.startedAt !== null && (
            <span className="listen-clock">
              <span className="sr-only">{t("live.elapsed")} </span>
              {formatClock(now - state.startedAt)}
            </span>
          )}
          <button
            type="button"
            className="btn btn-danger btn-sm listen-stop"
            onClick={() => void controller.stop()}
            disabled={state.phase === "stopping"}
          >
            <IconStop size={14} /> {t("listen.stop")}
          </button>
        </div>
        {recording && (
          <>
            {/* Native meter for assistive tech; the bar next to it is the visual. */}
            <meter
              className="sr-only"
              aria-label={t("listen.level")}
              min={-60}
              max={0}
              value={Math.round(dbfs)}
            />
            <div className={state.level?.speaking ? "meter speaking" : "meter"} aria-hidden="true">
              <span style={{ width: `${levelPercent(dbfs)}%` }} />
            </div>
          </>
        )}
        {state.phase === "reconnecting" && (
          <p className="hint">
            {t("listen.reconnectingHint", { s: Math.round(state.bufferedMs / 1000) })}
          </p>
        )}
        {recording && (
          <div className="captions" aria-live="off">
            {state.captions.length === 0 ? (
              <p className="caption caption-wait">{t("live.waiting")}</p>
            ) : (
              state.captions.map((c, i) => (
                <p
                  key={c.key}
                  className={i === state.captions.length - 1 ? "caption caption-latest" : "caption"}
                >
                  {c.text}
                </p>
              ))
            )}
          </div>
        )}
        <p className="hint listen-foreground">
          {t("listen.foreground")}
          {state.wakeLock === "unavailable" && ` ${t("listen.noWakeLock")}`}
        </p>
      </section>
    );
  } else if (state.phase === "error" && state.error) {
    const kind = state.error.kind;
    body = (
      <div className="note note-warn listen-error" role="alert">
        <p>
          <strong>{t("listen.stopped")}</strong> {t(ERROR_KEY[kind])}
        </p>
        <div className="row">
          {kind === "consent" && (
            <Link to="/consent" className="btn btn-sm btn-warn">
              {t("capture.review")}
            </Link>
          )}
          {kind === "paused" && paused && (
            <button type="button" className="btn btn-sm" onClick={() => pause.mutate(false)}>
              {t("capture.resume")}
            </button>
          )}
          {(kind === "unauthorized" ||
            kind === "other" ||
            kind === "pairing" ||
            (kind === "paused" && !paused)) && (
            <button type="button" className="btn btn-sm btn-primary" onClick={begin}>
              {t("listen.tryAgain")}
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => controller.dismiss()}
          >
            {t("common.dismiss")}
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className={variant === "panel" ? "listen-idle listen-idle-panel" : "listen-idle"}>
        <button type="button" className="btn listen-start" onClick={onListen} disabled={paused}>
          <IconMic size={16} /> {t("listen.action")}
        </button>
        <span className="hint">
          {paused
            ? t("listen.pausedHint")
            : blocked
              ? t("listen.blockedHint")
              : state.device
                ? t("listen.pairedAs", { name: state.device.name })
                : t("listen.idleHint")}
        </span>
        {variant === "panel" && state.device && (
          <button
            type="button"
            className="link-btn listen-forget"
            onClick={() => controller.forget()}
          >
            {t("listen.forget")}
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      {variant === "panel" ? (
        <section className="card listen-panel" aria-label={t("listen.action")}>
          <h2>{t("listen.panelTitle")}</h2>
          <p className="muted">{t("listen.panelLead")}</p>
          {body}
        </section>
      ) : (
        <div className="listen-strip">{body}</div>
      )}
      <Dialog
        open={intro}
        onClose={() => setIntro(false)}
        title={t("listen.introTitle")}
        size="md"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setIntro(false)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn btn-primary" onClick={begin} data-autofocus>
              <IconMic size={16} />{" "}
              {state.device ? t("listen.introStart") : t("listen.introPairStart")}
            </button>
          </>
        }
      >
        <ul className="intro-list">
          {!state.device && <li>{t("listen.intro1", { name })}</li>}
          <li>{t("listen.intro2")}</li>
          <li>{t("listen.intro3")}</li>
          <li>
            {t("listen.intro4")}{" "}
            <Link to="/settings/notices" onClick={() => setIntro(false)}>
              {t("timeline.step2Link")}
            </Link>
          </li>
        </ul>
      </Dialog>
    </>
  );
}
