import type { ActionItem, ConversationDetail, DayDetail } from "@ltm/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { qk } from "../api/queries";
import { useI18n } from "../i18n";
import { useFmt } from "../lib/useFmt";

/**
 * One tickable action item. Used on the conversation page and in day digests; ticking
 * writes through `PATCH /conversations/:id/action-items/:itemId` and updates every cached
 * copy of the item.
 */
export function ActionItemRow({
  convId,
  item,
  inputId,
  source,
}: {
  convId: string;
  item: ActionItem;
  inputId: string;
  /** Shown in day views: which conversation the item came from. */
  source?: { title: string };
}) {
  const { t } = useI18n();
  const fmt = useFmt();
  const qc = useQueryClient();
  // Local state flips in the same frame as the click; the query cache notifies on a later tick.
  const [done, setDone] = useState(item.done);
  useEffect(() => setDone(item.done), [item.done]);
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.updateActionItem(convId, item.id, { done: next }),
    onError: () => setDone(item.done),
    onSuccess: (updated) => {
      qc.setQueryData<ConversationDetail>(qk.conversation(convId), (d) =>
        d
          ? { ...d, actionItems: d.actionItems.map((a) => (a.id === updated.id ? updated : a)) }
          : d,
      );
      for (const q of qc.getQueryCache().findAll({ queryKey: qk.dayAll })) {
        qc.setQueryData<DayDetail>(q.queryKey, (d) =>
          d
            ? {
                ...d,
                actionItems: d.actionItems.map((a) =>
                  a.id === updated.id && a.conversationId === convId ? { ...a, ...updated } : a,
                ),
              }
            : d,
        );
      }
      // Open-task counts on cards and day summaries.
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
      void qc.invalidateQueries({ queryKey: qk.daysAll });
    },
  });
  const dueText =
    item.due && /^\d{4}-\d{2}-\d{2}$/.test(item.due)
      ? fmt.day(item.due, { relative: true, weekday: false })
      : item.due;
  return (
    <li className={done ? "done" : ""}>
      <input
        id={inputId}
        type="checkbox"
        checked={done}
        onChange={(e) => {
          setDone(e.target.checked);
          toggle.mutate(e.target.checked);
        }}
        disabled={toggle.isPending}
      />
      <label htmlFor={inputId}>
        <span className="checklist-text">{item.text}</span>
        {(item.owner || dueText || source) && (
          <span className="checklist-meta">
            {item.owner && <span>{item.owner}</span>}
            {dueText && <span>{t("conv.due", { date: dueText })}</span>}
          </span>
        )}
      </label>
      {source && (
        <Link className="checklist-source" to={`/conversations/${encodeURIComponent(convId)}`}>
          {source.title}
        </Link>
      )}
    </li>
  );
}
