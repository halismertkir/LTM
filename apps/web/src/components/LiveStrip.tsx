import { type ReactNode, useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { useLive } from "../api/live";
import { useDeviceMap, usePauseCapture } from "../api/queries";
import { useI18n } from "../i18n";
import { useCaptureState } from "../lib/capture";
import { formatClock } from "../lib/format";
import { useNow } from "../lib/hooks";
import { SOURCE_KEY } from "../lib/labels";
import { CaptureGlyph } from "./CaptureStatus";
import { DeviceIcon, IconPause, IconPlay, SourceIcon } from "./Icons";

/**
 * What is being captured right now: the account-wide state with its kill switch, and every
 * open stream with its latest live captions. `children` adds controls (listen with this
 * device) below the streams.
 */
export function LiveStrip({ children }: { children?: ReactNode }) {
  const { t, tn } = useI18n();
  const live = useLive();
  const devices = useDeviceMap();
  const { state, activeStreams } = useCaptureState();
  const pause = usePauseCapture();
  const now = useNow(1000, activeStreams > 0);
  const headingId = useId();
  // Brief drops are normal (proxies, sleep); only mention the connection when it stays down.
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (live.connected) {
      setOffline(false);
      return;
    }
    const id = window.setTimeout(() => setOffline(true), 8000);
    return () => window.clearTimeout(id);
  }, [live.connected]);

  const headline: Record<typeof state, string> = {
    listening: tn("live.listeningOn", activeStreams),
    paused: t("live.paused"),
    blocked: t("live.blocked"),
    idle: t("live.idle"),
  };
  const sub: Record<typeof state, string> = {
    listening: t("live.listeningSub"),
    paused: t("live.pausedSub"),
    blocked: t("live.blockedSub"),
    idle: t("live.idleSub"),
  };

  return (
    <section className={`live live-${state}`} aria-labelledby={headingId}>
      <div className="live-head">
        <div className="live-state">
          <span className="live-glyph">
            <CaptureGlyph state={state} />
          </span>
          <div>
            <h2 id={headingId}>{headline[state]}</h2>
            <p>{sub[state]}</p>
          </div>
        </div>
        {state === "blocked" ? (
          <Link to="/consent" className="btn btn-warn">
            {t("capture.review")}
          </Link>
        ) : (
          <button
            type="button"
            className={state === "paused" ? "btn btn-primary btn-lg" : "btn btn-pause btn-lg"}
            aria-pressed={state === "paused"}
            disabled={pause.isPending}
            onClick={() => pause.mutate(state !== "paused")}
          >
            {state === "paused" ? <IconPlay size={16} /> : <IconPause size={16} />}
            {state === "paused" ? t("capture.resume") : t("capture.pause")}
          </button>
        )}
      </div>

      {/* While paused or blocked the server refuses audio, so open streams are not "listening". */}
      {state === "listening" && live.streams.length > 0 && (
        <ul className="streams">
          {live.streams.map((s) => {
            const captions = live.captions[s.id] ?? [];
            const elapsed = now - Date.parse(s.startedAt);
            const context = s.context?.title ?? s.context?.app;
            return (
              <li key={s.id} className="stream">
                <div className="stream-head">
                  <DeviceIcon kind={devices.get(s.deviceId)?.kind} />
                  <strong>{s.deviceName}</strong>
                  <span className="stream-clock">
                    <span className="sr-only">{t("live.elapsed")} </span>
                    {formatClock(elapsed)}
                  </span>
                </div>
                <div className="stream-meta">
                  <span className="chip chip-quiet">
                    <SourceIcon source={s.source} size={14} />
                    {t(SOURCE_KEY[s.source])}
                  </span>
                  {s.mode === "transcript" && (
                    <span className="chip chip-quiet">{t("live.onDevice")}</span>
                  )}
                  {context && <span className="stream-context">{context}</span>}
                </div>
                {/* Captions update constantly; announcing each would drown a screen reader. */}
                <div className="captions" aria-live="off">
                  {captions.length === 0 ? (
                    <p className="caption caption-wait">{t("live.waiting")}</p>
                  ) : (
                    captions.map((c, i) => (
                      <p
                        key={c.key}
                        className={i === captions.length - 1 ? "caption caption-latest" : "caption"}
                      >
                        {c.text}
                      </p>
                    ))
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {children}
      {offline && <p className="live-offline">{t("live.reconnecting")}</p>}
    </section>
  );
}
