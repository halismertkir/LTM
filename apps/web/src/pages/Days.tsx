import type { DayDetail, DayStatus, DaySummary } from "@ltm/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo } from "react";
import { Link, useParams } from "react-router";
import { api, isApiError } from "../api/client";
import { emptyDay, qk, useDay, useDays, useDeviceMap, useSettings } from "../api/queries";
import { ActionItemRow } from "../components/ActionItemRow";
import { ConversationCard } from "../components/ConversationCard";
import { IconArrowLeft, IconRefresh, IconTimeline } from "../components/Icons";
import { ListenControl } from "../components/ListenControl";
import { LiveStrip } from "../components/LiveStrip";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorNote, Loading, Markdown, PageHeader } from "../components/ui";
import { type MessageKey, useI18n } from "../i18n";
import { useInfiniteSentinel } from "../lib/hooks";
import { type Fmt, useFmt } from "../lib/useFmt";
import { addDays } from "../lib/zone";
import { FirstRun } from "./Timeline";

const DAY_STATUS_KEY: Record<DayStatus, MessageKey> = {
  none: "days.statusNone",
  pending: "days.statusPending",
  ready: "days.statusReady",
  unavailable: "days.statusUnavailable",
};

function DayStatusChip({ status }: { status: DayStatus }) {
  const { t } = useI18n();
  if (status === "ready") return null;
  return <span className={`chip day-status-${status}`}>{t(DAY_STATUS_KEY[status])}</span>;
}

/** "3 conversations · 1 hr 20 min of speech · 2 open tasks" */
function DayCounts({ day }: { day: DaySummary }) {
  const { t, tn } = useI18n();
  const fmt = useFmt();
  return (
    <p className="day-counts">
      {[
        tn("days.conversations", day.conversationCount),
        day.speechMinutes > 0
          ? t("days.speech", { time: fmt.duration(day.speechMinutes * 60_000) })
          : null,
        day.openActionItems > 0 ? tn("conv.openTasks", day.openActionItems) : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
}

/** What to say when the digest is not (yet) there. */
function DigestState({ day }: { day: DayDetail }) {
  const { t } = useI18n();
  const settings = useSettings();
  if (day.status === "pending") {
    return (
      <div className="note">
        <p>{day.headline ? t("days.pendingRewrite") : t("days.pending")}</p>
      </div>
    );
  }
  if (day.status === "unavailable") {
    return (
      <div className="note note-warn">
        <p>
          <strong>{t("days.unavailable")}</strong>{" "}
          {day.statusDetail ?? t("days.unavailableDefault")}
        </p>
        <Link to="/settings/providers">{t("conv.checkProviders")}</Link>
      </div>
    );
  }
  if (day.status === "none") {
    if (settings.data && !settings.data.pipeline.dailyDigest) {
      return (
        <div className="note">
          <p>{t("days.digestOff")}</p>
          <Link to="/settings/pipeline">{t("days.digestOffLink")}</Link>
        </div>
      );
    }
    return day.conversationCount === 0 ? null : (
      <div className="note">
        <p>{t("days.noDigest")}</p>
      </div>
    );
  }
  return null;
}

function ListBlock({
  title,
  items,
  className,
}: {
  title: string;
  items: string[];
  className?: string;
}) {
  const id = useId();
  if (items.length === 0) return null;
  return (
    <section className={`day-block ${className ?? ""}`} aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <ul>
        {items.map((x, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: plain strings without ids
          <li key={i}>{x}</li>
        ))}
      </ul>
    </section>
  );
}

function DayActionItems({ day }: { day: DayDetail }) {
  const { t } = useI18n();
  const baseId = useId();
  if (day.actionItems.length === 0) return null;
  return (
    <section className="section" aria-labelledby={`${baseId}-h`}>
      <h2 id={`${baseId}-h`}>{t("days.openTasks")}</h2>
      <ul className="checklist">
        {day.actionItems.map((a) => (
          <ActionItemRow
            key={`${a.conversationId}-${a.id}`}
            convId={a.conversationId}
            item={a}
            inputId={`${baseId}-${a.conversationId}-${a.id}`}
            source={{ title: a.conversationTitle ?? t("conv.placeholderUntitledShort") }}
          />
        ))}
      </ul>
    </section>
  );
}

/** The conversations of a day as compact rows: time, title, status. */
function DayConversationList({ day, fmt }: { day: DayDetail; fmt: Fmt }) {
  const { t } = useI18n();
  const id = useId();
  if (day.conversations.length === 0) return null;
  return (
    <section className="section" aria-labelledby={id}>
      <h2 id={id}>{t("days.conversationsTitle")}</h2>
      <ol className="day-convs">
        {day.conversations.map((c) => (
          <li key={c.id}>
            <time dateTime={new Date(c.startMs).toISOString()}>{fmt.time(c.startMs)}</time>
            <span className="day-conv-main">
              <Link
                to={`/conversations/${encodeURIComponent(c.id)}`}
                className={c.title ? "" : "tentative"}
              >
                {c.title ??
                  (c.status === "open"
                    ? t("conv.placeholderOpen", { time: fmt.time(c.startMs) })
                    : c.status === "processing"
                      ? t("conv.placeholderProcessing")
                      : t("conv.placeholderUntitled", { time: fmt.time(c.startMs) }))}
              </Link>
              {c.status === "open" && (
                <span className="chip status-open">
                  <span className="rec-dot" aria-hidden="true" />
                  {c.interim ? t("status.interim") : t("status.open")}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Today at the top of the home screen. */
function TodayDigest({ date, known }: { date: string; known: boolean }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const day = useDay(date, fmt.tz, known);
  if (known && day.isPending) return <Loading />;
  if (day.error) return <ErrorNote error={day.error} onRetry={() => void day.refetch()} />;
  const d = day.data ?? emptyDay(date, fmt.tz);
  return (
    <article className="today card" aria-labelledby="today-h">
      <header className="today-head">
        <p className="eyebrow">
          {t("time.today")} · {fmt.day(date, { relative: false })}
        </p>
        <h2 id="today-h" className={d.headline ? "today-headline" : "today-headline tentative"}>
          {d.headline ?? (d.conversationCount ? t("days.todayUntitled") : t("days.todayQuiet"))}
        </h2>
        <DayCounts day={d} />
      </header>
      <DigestState day={d} />
      {d.summary && <p className="summary">{d.summary}</p>}
      <div className="day-blocks">
        <ListBlock title={t("days.highlights")} items={d.highlights} />
        <ListBlock title={t("conv.decisions")} items={d.decisions} />
        {d.people.length > 0 && (
          <section className="day-block" aria-label={t("days.people")}>
            <h3>{t("days.people")}</h3>
            <ul className="tags tags-people">
              {d.people.map((p) => (
                <li key={p} className="tag tag-plain">
                  {p}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <DayActionItems day={d} />
      <DayConversationList day={d} fmt={fmt} />
      {d.conversationCount > 0 && (
        <Link to={`/days/${date}`} className="btn btn-sm today-open">
          {t("days.openToday")}
        </Link>
      )}
    </article>
  );
}

function DayCard({ day }: { day: DaySummary }) {
  const { t } = useI18n();
  const fmt = useFmt();
  return (
    <li className="day-card card">
      <div className="day-card-top">
        <h3>
          <Link to={`/days/${day.date}`} className="stretched">
            {fmt.day(day.date)}
          </Link>
        </h3>
        <DayStatusChip status={day.status} />
      </div>
      <p className={day.headline ? "day-card-headline" : "day-card-headline tentative"}>
        {day.headline ??
          (day.status === "pending"
            ? t("days.statusPending")
            : day.status === "unavailable"
              ? t("days.unavailableShort")
              : t("days.noHeadline"))}
      </p>
      {day.summary && <p className="day-card-summary">{day.summary}</p>}
      <DayCounts day={day} />
    </li>
  );
}

export function DaysPage() {
  const { t } = useI18n();
  const fmt = useFmt();
  const today = fmt.today();
  const days = useDays();
  const items = useMemo(() => days.data?.pages.flatMap((p) => p.items) ?? [], [days.data]);
  const earlier = items.filter((d) => d.date !== today);
  const sentinel = useInfiniteSentinel(() => {
    if (days.hasNextPage && !days.isFetchingNextPage) void days.fetchNextPage();
  }, !!days.hasNextPage);
  const nothingYet = days.isSuccess && items.every((d) => d.conversationCount === 0);

  return (
    <div className="page">
      <PageHeader
        title={t("days.title")}
        lead={t("days.lead")}
        actions={
          <Link to="/timeline" className="btn">
            <IconTimeline size={16} /> {t("days.toTimeline")}
          </Link>
        }
      />
      <LiveStrip>
        <ListenControl />
      </LiveStrip>
      {days.isPending ? (
        <Loading />
      ) : nothingYet ? (
        <FirstRun />
      ) : (
        // Only ask for today's detail once the list says there is something to show.
        <TodayDigest date={today} known={items.some((d) => d.date === today)} />
      )}

      <section className="stack" aria-labelledby="earlier-h">
        <h2 id="earlier-h" className="section-title">
          {t("days.earlier")}
        </h2>
        {days.isPending ? (
          <Loading />
        ) : days.error ? (
          <ErrorNote error={days.error} onRetry={() => void days.refetch()} />
        ) : earlier.length === 0 ? (
          <p className="muted">{t("days.noEarlier")}</p>
        ) : (
          <>
            <ul className="day-list">
              {earlier.map((d) => (
                <DayCard key={d.date} day={d} />
              ))}
            </ul>
            <div ref={sentinel} />
            {days.hasNextPage && (
              <button
                type="button"
                className="btn btn-block"
                onClick={() => void days.fetchNextPage()}
                disabled={days.isFetchingNextPage}
              >
                {days.isFetchingNextPage ? t("common.loading") : t("common.loadMore")}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}

export function DayPage() {
  const { date = "" } = useParams();
  const { t } = useI18n();
  const fmt = useFmt();
  const qc = useQueryClient();
  const toast = useToast();
  const devices = useDeviceMap();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const day = useDay(valid ? date : "invalid", fmt.tz, valid);
  const today = fmt.today();

  const regenerate = useMutation({
    mutationFn: () => api.regenerateDay(date),
    onSuccess: () => {
      qc.setQueryData<DayDetail>(qk.day(date), (d) => (d ? { ...d, status: "pending" } : d));
      toast.show(t("days.regenerateQueued"), "success");
    },
  });

  const nav = (
    <nav className="day-nav" aria-label={t("days.navLabel")}>
      <Link to={`/days/${addDays(date, -1)}`} className="btn btn-sm btn-ghost">
        ← {t("days.prev")}
      </Link>
      {date < today && (
        <Link to={`/days/${addDays(date, 1)}`} className="btn btn-sm btn-ghost">
          {t("days.next")} →
        </Link>
      )}
    </nav>
  );

  if (!valid || isApiError(day.error, "bad_request")) {
    return (
      <EmptyState title={t("days.notFound")}>
        <Link to="/">{t("days.backToDays")}</Link>
      </EmptyState>
    );
  }
  if (day.isPending) return <Loading />;
  if (day.error) return <ErrorNote error={day.error} onRetry={() => void day.refetch()} />;
  const d = day.data;
  // Format in the zone the server used to cut this day.
  const dayLabel = fmt.day(date, { relative: false });

  return (
    <div className="page day-page">
      <div className="row row-between">
        <Link to="/" className="back-link">
          <IconArrowLeft size={16} /> {t("nav.days")}
        </Link>
        {nav}
      </div>
      <header className="conv-header">
        <div className="conv-header-main">
          <p className="eyebrow">
            {date === today
              ? `${t("time.today")} · `
              : date === addDays(today, -1)
                ? `${t("time.yesterday")} · `
                : ""}
            {dayLabel}
            {d.timeZone !== fmt.tz && ` · ${d.timeZone}`}
          </p>
          <h1 className={d.headline ? "" : "tentative"}>{d.headline ?? dayLabel}</h1>
          <div className="conv-header-meta">
            <DayStatusChip status={d.status} />
            <DayCounts day={d} />
          </div>
        </div>
        {d.conversationCount > 0 && (
          <div className="row conv-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => regenerate.mutate()}
              disabled={regenerate.isPending || d.status === "pending"}
            >
              <IconRefresh size={16} /> {t("days.regenerate")}
            </button>
          </div>
        )}
      </header>

      <DigestState day={d} />

      <div className="detail-grid">
        <div className="detail-notes">
          {d.summary && <p className="summary">{d.summary}</p>}
          {d.digest && (
            <section className="section" aria-labelledby="digest-h">
              <h2 id="digest-h">{t("days.digest")}</h2>
              <Markdown source={d.digest} className="notes" />
            </section>
          )}
          <div className="day-blocks">
            <ListBlock title={t("days.highlights")} items={d.highlights} />
            <ListBlock title={t("conv.decisions")} items={d.decisions} />
            {d.people.length > 0 && (
              <section className="day-block" aria-label={t("days.people")}>
                <h3>{t("days.people")}</h3>
                <ul className="tags tags-people">
                  {d.people.map((p) => (
                    <li key={p} className="tag tag-plain">
                      {p}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <DayActionItems day={d} />
        </div>
        <section className="section" aria-labelledby="day-convs-h">
          <h2 id="day-convs-h">{t("days.conversationsTitle")}</h2>
          {d.conversations.length === 0 ? (
            <p className="muted">{t("days.noConversations")}</p>
          ) : (
            <div className="day-items">
              {d.conversations.map((c) => (
                <ConversationCard key={c.id} c={c} devices={devices} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
