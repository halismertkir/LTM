import { type Memory, type MemoryKind, zMemoryKind } from "@ltm/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client";
import { qk, useMemories } from "../api/queries";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { IconEdit, IconMemory, IconPlus, IconSearch, IconTrash } from "../components/Icons";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorNote, ImportanceDots, Loading, PageHeader } from "../components/ui";
import { useI18n } from "../i18n";
import { formatDate } from "../lib/format";
import { useDebounced, useInfiniteSentinel } from "../lib/hooks";
import { MEMORY_KIND_KEY } from "../lib/labels";

const KINDS = zMemoryKind.options;

interface Draft {
  kind: MemoryKind;
  content: string;
  importance: number;
  subjects: string;
}

function MemoryDialog({
  open,
  onClose,
  memory,
}: {
  open: boolean;
  onClose: () => void;
  memory: Memory | null;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState<Draft>({ kind: "fact", content: "", importance: 3, subjects: "" });
  const ids = { kind: useId(), content: useId(), importance: useId(), subjects: useId() };

  useEffect(() => {
    if (!open) return;
    setD(
      memory
        ? {
            kind: memory.kind,
            content: memory.content,
            importance: memory.importance,
            subjects: memory.subjects.join(", "),
          }
        : { kind: "fact", content: "", importance: 3, subjects: "" },
    );
  }, [open, memory]);

  const save = useMutation({
    meta: { inline: true },
    mutationFn: () => {
      const body = {
        kind: d.kind,
        content: d.content.trim(),
        importance: d.importance,
        subjects: d.subjects
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 20),
      };
      return memory ? api.updateMemory(memory.id, body) : api.createMemory(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.memoriesAll });
      toast.show(memory ? t("memories.saved") : t("memories.created"), "success");
      onClose();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (d.content.trim()) save.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={memory ? t("memories.editTitle") : t("memories.addTitle")}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            form="memory-form"
            className="btn btn-primary"
            disabled={!d.content.trim() || save.isPending}
          >
            {save.isPending ? t("common.working") : t("common.save")}
          </button>
        </>
      }
    >
      <form id="memory-form" className="stack" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor={ids.content}>{t("memories.content")}</label>
          <textarea
            id={ids.content}
            rows={3}
            maxLength={2000}
            value={d.content}
            onChange={(e) => setD({ ...d, content: e.target.value })}
            placeholder={t("memories.contentPlaceholder")}
            required
          />
          <p className="hint">{t("memories.contentHint")}</p>
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor={ids.kind}>{t("memories.kind")}</label>
            <select
              id={ids.kind}
              value={d.kind}
              onChange={(e) => setD({ ...d, kind: e.target.value as MemoryKind })}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(MEMORY_KIND_KEY[k])}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.importance}>
              {t("memories.importance")}: <strong>{d.importance}</strong>
            </label>
            <input
              id={ids.importance}
              type="range"
              min={1}
              max={5}
              step={1}
              value={d.importance}
              onChange={(e) => setD({ ...d, importance: Number(e.target.value) })}
              aria-valuetext={t("memories.importanceOf", { n: d.importance })}
            />
            <p className="hint">{t("memories.importanceHint")}</p>
          </div>
        </div>
        <div className="field">
          <label htmlFor={ids.subjects}>{t("memories.subjects")}</label>
          <input
            id={ids.subjects}
            value={d.subjects}
            onChange={(e) => setD({ ...d, subjects: e.target.value })}
            placeholder={t("memories.subjectsPlaceholder")}
          />
          <p className="hint">{t("memories.subjectsHint")}</p>
        </div>
        {save.error && <ErrorNote error={save.error} />}
      </form>
    </Dialog>
  );
}

function MemoryCard({
  m,
  focused,
  onEdit,
  onDelete,
}: {
  m: Memory;
  focused: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <li id={`m-${m.id}`} className={`memory card ${focused ? "highlight" : ""}`}>
      <div className="memory-top">
        <span className={`chip kind-${m.kind}`}>{t(MEMORY_KIND_KEY[m.kind])}</span>
        <ImportanceDots
          value={m.importance}
          label={t("memories.importanceOf", { n: m.importance })}
        />
        <span className="memory-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={onEdit}
            aria-label={t("common.edit")}
            title={t("common.edit")}
          >
            <IconEdit size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onDelete}
            aria-label={t("common.delete")}
            title={t("common.delete")}
          >
            <IconTrash size={16} />
          </button>
        </span>
      </div>
      <p className="memory-content">{m.content}</p>
      {m.subjects.length > 0 && (
        <ul className="tags" aria-label={t("memories.subjects")}>
          {m.subjects.map((s) => (
            <li key={s} className="tag">
              {s}
            </li>
          ))}
        </ul>
      )}
      <p className="memory-meta">
        {m.origin === "manual" ? t("memories.manual") : t("memories.extracted")}
        {" · "}
        {formatDate(Date.parse(m.occurredAt ?? m.createdAt), locale)}
        {m.sourceConversationId && (
          <>
            {" · "}
            <Link to={`/conversations/${encodeURIComponent(m.sourceConversationId)}`}>
              {t("memories.source")}
            </Link>
          </>
        )}
      </p>
    </li>
  );
}

export function MemoriesPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [params] = useSearchParams();
  const focus = params.get("focus");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<MemoryKind | undefined>(undefined);
  const qd = useDebounced(q.trim(), 300);
  const filters = useMemo(() => ({ q: qd, kind }), [qd, kind]);
  const list = useMemories(filters);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const searchId = useId();
  const sentinel = useInfiniteSentinel(() => {
    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  }, !!list.hasNextPage);

  useEffect(() => {
    if (focus && items.length)
      document.getElementById(`m-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, items.length]);

  const del = useMutation({
    mutationFn: (m: Memory) => api.deleteMemory(m.id),
    onSuccess: () => {
      setDeleting(null);
      toast.show(t("memories.deleted"), "success");
      void qc.invalidateQueries({ queryKey: qk.memoriesAll });
    },
  });

  return (
    <div className="page">
      <PageHeader
        title={t("memories.title")}
        lead={t("memories.lead")}
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <IconPlus size={16} /> {t("memories.add")}
          </button>
        }
      />

      <search className="filters filters-stack" aria-label={t("memories.filters")}>
        <div className="field field-grow">
          <label htmlFor={searchId} className="sr-only">
            {t("memories.search")}
          </label>
          <div className="input-icon">
            <IconSearch size={16} />
            <input
              id={searchId}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("memories.search")}
            />
          </div>
        </div>
        <fieldset className="chip-group">
          <legend className="sr-only">{t("memories.kind")}</legend>
          <label className={kind === undefined ? "chip-toggle on" : "chip-toggle"}>
            <input
              type="radio"
              name="kind"
              checked={kind === undefined}
              onChange={() => setKind(undefined)}
            />
            {t("memories.allKinds")}
          </label>
          {KINDS.map((k) => (
            <label key={k} className={kind === k ? "chip-toggle on" : "chip-toggle"}>
              <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />
              {t(MEMORY_KIND_KEY[k])}
            </label>
          ))}
        </fieldset>
      </search>

      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorNote error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={qd || kind ? t("memories.noMatch") : t("memories.emptyTitle")}
          icon={<IconMemory size={28} />}
        >
          <p>{qd || kind ? t("memories.noMatchLead") : t("memories.emptyLead")}</p>
        </EmptyState>
      ) : (
        <>
          <ul className="memory-list">
            {items.map((m) => (
              <MemoryCard
                key={m.id}
                m={m}
                focused={m.id === focus}
                onEdit={() => {
                  setEditing(m);
                  setDialogOpen(true);
                }}
                onDelete={() => setDeleting(m)}
              />
            ))}
          </ul>
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
        </>
      )}

      <MemoryDialog open={dialogOpen} onClose={() => setDialogOpen(false)} memory={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting)}
        busy={del.isPending}
        danger
        title={t("memories.deleteTitle")}
        body={deleting ? <blockquote className="quote">{deleting.content}</blockquote> : ""}
        confirmLabel={t("common.delete")}
      />
    </div>
  );
}
