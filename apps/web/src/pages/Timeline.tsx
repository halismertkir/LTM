import type { ConversationSummary, Device } from "@ltm/protocol";
import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router";
import { useLive } from "../api/live";
import { useConversations, useDeviceMap, usePauseCapture } from "../api/queries";
import { CaptureGlyph } from "../components/CaptureStatus";
import {
  DeviceIcon,
  IconDevices,
  IconPause,
  IconPlay,
  IconSearch,
  IconTask,
  IconUsers,
  IconX,
  SourceIcon,
} from "../components/Icons";
import { EmptyState, ErrorNote, Loading, PageHeader, StatusChip } from "../components/ui";
import { type MessageKey, useI18n } from "../i18n";
import { useCaptureState } from "../lib/capture";
import {
  dateInputToMs,
  formatClock,
  formatDayHeading,
  formatDuration,
  formatTime,
  startOfDay,
} from "../lib/format";
import { useDebounced, useInfiniteSentinel, useNow } from "../lib/hooks";
import { SOURCE_KEY } from "../lib/labels";

function LiveStrip() {
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
      {offline && <p className="live-offline">{t("live.reconnecting")}</p>}
    </section>
  );
}

function placeholderTitle(
  c: ConversationSummary,
  t: (k: MessageKey, v?: Record<string, string>) => string,
  time: string,
) {
  if (c.title) return c.title;
  if (c.status === "open") return t("conv.placeholderOpen", { time });
  if (c.status === "processing") return t("conv.placeholderProcessing");
  return t("conv.placeholderUntitled", { time });
}

export function ConversationCard({
  c,
  devices,
}: {
  c: ConversationSummary;
  devices: Map<string, Device>;
}) {
  const { t, tn, locale } = useI18n();
  const start = formatTime(c.startMs, locale);
  const end = formatTime(c.endMs, locale);
  const title = placeholderTitle(c, t, start);
  const tentative = !c.title;
  return (
    <article className={`conv-card conv-${c.status}`}>
      <div className="conv-time">
        <time dateTime={new Date(c.startMs).toISOString()}>{start}</time>
        <span className="conv-time-end">{c.status === "open" ? t("conv.now") : end}</span>
      </div>
      <div className="conv-body">
        <div className="conv-top">
          <h3 className={tentative ? "conv-title tentative" : "conv-title"}>
            <Link to={`/conversations/${encodeURIComponent(c.id)}`} className="stretched">
              {title}
            </Link>
          </h3>
          {c.status !== "ready" && <StatusChip status={c.status} />}
        </div>
        <p className="conv-meta">
          {formatDuration(c.endMs - c.startMs, locale)} · {tn("conv.utterances", c.utteranceCount)}
        </p>
        {c.summary && <p className="conv-summary">{c.summary}</p>}
        {c.topics.length > 0 && (
          <ul className="tags" aria-label={t("conv.topics")}>
            {c.topics.map((topic) => (
              <li key={topic} className="tag">
                {topic}
              </li>
            ))}
          </ul>
        )}
        <div className="conv-foot">
          {c.participants.length > 0 && (
            <span className="conv-people" title={t("conv.participants")}>
              <IconUsers size={16} />
              <span className="sr-only">{t("conv.participants")}: </span>
              {c.participants.join(", ")}
            </span>
          )}
          <span className="conv-devices">
            <span className="sr-only">{t("conv.heardBy")}: </span>
            {c.deviceIds.map((id) => {
              const d = devices.get(id);
              return (
                <span key={id} className="device-badge" title={d?.name ?? t("devices.unknown")}>
                  <DeviceIcon kind={d?.kind} size={15} />
                  <span className="sr-only">{d?.name ?? t("devices.unknown")}</span>
                </span>
              );
            })}
          </span>
          {c.openActionItems > 0 && (
            <span className="chip chip-task">
              <IconTask size={14} />
              {tn("conv.openTasks", c.openActionItems)}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

interface DayGroup {
  day: number;
  items: ConversationSummary[];
}

export function groupByDay(items: ConversationSummary[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const c of [...items].sort((a, b) => b.startMs - a.startMs)) {
    const day = startOfDay(c.startMs);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(c);
    else groups.push({ day, items: [c] });
  }
  return groups;
}

function FirstRun() {
  const { t } = useI18n();
  return (
    <EmptyState title={t("timeline.emptyTitle")} icon={<IconDevices size={28} />}>
      <p>{t("timeline.emptyLead")}</p>
      <ol className="steps">
        <li>
          <strong>{t("timeline.step1")}</strong> {t("timeline.step1Body")}
        </li>
        <li>
          <strong>{t("timeline.step2")}</strong> {t("timeline.step2Body")}{" "}
          <Link to="/settings/notices">{t("timeline.step2Link")}</Link>
        </li>
        <li>
          <strong>{t("timeline.step3")}</strong> {t("timeline.step3Body")}
        </li>
      </ol>
      <Link to="/devices?pair=1" className="btn btn-primary">
        {t("devices.pair")}
      </Link>
    </EmptyState>
  );
}

export function TimelinePage() {
  const { t, locale } = useI18n();
  const devices = useDeviceMap();
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const qDebounced = useDebounced(q.trim(), 300);
  const ids = { q: useId(), from: useId(), to: useId() };

  const filters = useMemo(
    () => ({ q: qDebounced, from: dateInputToMs(from), to: dateInputToMs(to, true) }),
    [qDebounced, from, to],
  );
  const filtered = !!(filters.q || filters.from !== undefined || filters.to !== undefined);
  const list = useConversations(filters);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const groups = useMemo(() => groupByDay(items), [items]);
  const sentinel = useInfiniteSentinel(() => {
    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  }, !!list.hasNextPage);

  return (
    <div className="page">
      <PageHeader title={t("timeline.title")} lead={t("timeline.lead")} />
      <LiveStrip />

      <search className="filters" aria-label={t("timeline.filters")}>
        <div className="field field-grow">
          <label htmlFor={ids.q} className="sr-only">
            {t("timeline.filterText")}
          </label>
          <div className="input-icon">
            <IconSearch size={16} />
            <input
              id={ids.q}
              type="search"
              placeholder={t("timeline.filterText")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              maxLength={200}
            />
          </div>
        </div>
        <div className="field field-date">
          <label htmlFor={ids.from}>{t("timeline.from")}</label>
          <input
            id={ids.from}
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="field field-date">
          <label htmlFor={ids.to}>{t("timeline.to")}</label>
          <input
            id={ids.to}
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        {filtered && (
          <button
            type="button"
            className="btn btn-ghost btn-sm filters-clear"
            onClick={() => {
              setQ("");
              setFrom("");
              setTo("");
            }}
          >
            <IconX size={14} /> {t("common.clear")}
          </button>
        )}
      </search>

      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorNote error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState title={t("timeline.noMatch")}>
            <p>{t("timeline.noMatchLead")}</p>
          </EmptyState>
        ) : (
          <FirstRun />
        )
      ) : (
        <div className="days">
          {groups.map((g) => (
            <section key={g.day} className="day" aria-labelledby={`day-${g.day}`}>
              <h2 id={`day-${g.day}`} className="day-head">
                {formatDayHeading(g.day, locale)}
              </h2>
              <div className="day-items">
                {g.items.map((c) => (
                  <ConversationCard key={c.id} c={c} devices={devices} />
                ))}
              </div>
            </section>
          ))}
          <div ref={sentinel} />
          {list.hasNextPage && (
            <button
              type="button"
              className="btn btn-block"
              onClick={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
            >
              {list.isFetchingNextPage ? t("common.loading") : t("common.loadMore")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
