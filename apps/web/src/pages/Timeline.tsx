import { useId, useMemo, useState } from "react";
import { Link } from "react-router";
import { useConversations, useDeviceMap } from "../api/queries";
import { ConversationCard, groupByDay } from "../components/ConversationCard";
import { IconDevices, IconSearch, IconX } from "../components/Icons";
import { LiveStrip } from "../components/LiveStrip";
import { EmptyState, ErrorNote, Loading, PageHeader } from "../components/ui";
import { useI18n } from "../i18n";
import { dateInputToMs } from "../lib/format";
import { useDebounced, useInfiniteSentinel } from "../lib/hooks";
import { useFmt } from "../lib/useFmt";

export { ConversationCard, groupByDay };

export function FirstRun() {
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
  const { t } = useI18n();
  const fmt = useFmt();
  const devices = useDeviceMap();
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const qDebounced = useDebounced(q.trim(), 300);
  const ids = { q: useId(), from: useId(), to: useId() };

  const filters = useMemo(
    () => ({
      q: qDebounced,
      from: dateInputToMs(from, false, fmt.tz),
      to: dateInputToMs(to, true, fmt.tz),
    }),
    [qDebounced, from, to, fmt.tz],
  );
  const filtered = !!(filters.q || filters.from !== undefined || filters.to !== undefined);
  const list = useConversations(filters);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const groups = useMemo(() => groupByDay(items, fmt.tz), [items, fmt.tz]);
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
                <Link to={`/days/${g.day}`} className="day-head-link">
                  {fmt.day(g.day)}
                </Link>
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
