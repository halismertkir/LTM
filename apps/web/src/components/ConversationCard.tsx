import type { ConversationSummary, Device } from "@ltm/protocol";
import { Link } from "react-router";
import { type MessageKey, useI18n } from "../i18n";
import { useFmt } from "../lib/useFmt";
import { dayInZone } from "../lib/zone";
import { DeviceIcon, IconTask, IconUsers } from "./Icons";
import { StatusChip } from "./ui";

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
  const { t, tn } = useI18n();
  const fmt = useFmt();
  const start = fmt.time(c.startMs);
  const end = fmt.time(c.endMs);
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
          {c.status !== "ready" && <StatusChip status={c.status} interim={c.interim} />}
        </div>
        <p className="conv-meta">
          {fmt.duration(c.endMs - c.startMs)} · {tn("conv.utterances", c.utteranceCount)}
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
  /** `YYYY-MM-DD` in the account's zone. */
  day: string;
  items: ConversationSummary[];
}

export function groupByDay(items: ConversationSummary[], tz: string): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const c of [...items].sort((a, b) => b.startMs - a.startMs)) {
    const day = dayInZone(c.startMs, tz);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(c);
    else groups.push({ day, items: [c] });
  }
  return groups;
}
