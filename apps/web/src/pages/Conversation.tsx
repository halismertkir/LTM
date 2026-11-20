import type { ConversationDetail, Device, Utterance } from "@ltm/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api, isApiError } from "../api/client";
import { qk, removeConversation, useConversation, useDeviceMap } from "../api/queries";
import { ActionItemRow } from "../components/ActionItemRow";
import { ConfirmDialog } from "../components/Dialog";
import {
  DeviceIcon,
  IconArrowLeft,
  IconEdit,
  IconRefresh,
  IconTrash,
  SourceIcon,
} from "../components/Icons";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorNote, Loading, Markdown, StatusChip } from "../components/ui";
import { type MessageKey, useI18n } from "../i18n";
import { MEMORY_KIND_KEY, SOURCE_KEY } from "../lib/labels";
import { useFmt } from "../lib/useFmt";

const SPEAKER_KEY: Record<Utterance["speaker"], MessageKey> = {
  self: "speaker.self",
  other: "speaker.other",
  unknown: "speaker.unknown",
};

function useDetailPatch(id: string) {
  const qc = useQueryClient();
  return (patch: Partial<ConversationDetail>) =>
    qc.setQueryData<ConversationDetail>(qk.conversation(id), (d) => (d ? { ...d, ...patch } : d));
}

function TitleEditor({ conv }: { conv: ConversationDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const patch = useDetailPatch(conv.id);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(conv.title ?? "");
  const inputId = useId();
  const save = useMutation({
    mutationFn: (title: string) => api.updateConversation(conv.id, { title }),
    onSuccess: (_r, title) => {
      patch({ title });
      setEditing(false);
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
  });

  if (!editing) {
    return (
      <div className="title-row">
        <h1 className={conv.title ? "" : "tentative"}>
          {conv.title ?? t("conv.placeholderUntitledShort")}
        </h1>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            setValue(conv.title ?? "");
            setEditing(true);
          }}
          aria-label={t("conv.renameAction")}
          title={t("conv.renameAction")}
        >
          <IconEdit />
        </button>
      </div>
    );
  }
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (v) save.mutate(v);
  };
  return (
    <form className="title-form" onSubmit={onSubmit}>
      <label htmlFor={inputId} className="sr-only">
        {t("conv.titleLabel")}
      </label>
      <input
        id={inputId}
        className="title-input"
        value={value}
        maxLength={200}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
        // biome-ignore lint/a11y/noAutofocus: the user just pressed "rename"
        autoFocus
      />
      <div className="row">
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={!value.trim() || save.isPending}
        >
          {t("common.save")}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

function NotesSection({ conv }: { conv: ConversationDetail }) {
  const { t } = useI18n();
  const patch = useDetailPatch(conv.id);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [draft, setDraft] = useState("");
  const areaId = useId();
  const save = useMutation({
    mutationFn: (notes: string) => api.updateConversation(conv.id, { notes }),
    onSuccess: (_r, notes) => {
      patch({ notes });
      setEditing(false);
    },
  });

  return (
    <section className="section" aria-labelledby={`${areaId}-h`}>
      <div className="section-head">
        <h2 id={`${areaId}-h`}>{t("conv.notes")}</h2>
        {!editing && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setDraft(conv.notes ?? "");
              setTab("write");
              setEditing(true);
            }}
          >
            <IconEdit size={16} /> {conv.notes ? t("common.edit") : t("conv.writeNotes")}
          </button>
        )}
      </div>
      {editing ? (
        <div className="stack-sm">
          <div className="segmented" role="tablist" aria-label={t("conv.notesEditor")}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "write"}
              onClick={() => setTab("write")}
            >
              {t("conv.write")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "preview"}
              onClick={() => setTab("preview")}
            >
              {t("conv.preview")}
            </button>
          </div>
          {tab === "write" ? (
            <>
              <label htmlFor={areaId} className="sr-only">
                {t("conv.notes")}
              </label>
              <textarea
                id={areaId}
                className="notes-area"
                value={draft}
                maxLength={100_000}
                onChange={(e) => setDraft(e.target.value)}
                rows={14}
              />
              <p className="hint">{t("conv.markdownHint")}</p>
            </>
          ) : (
            <div className="notes-preview">
              {draft.trim() ? (
                <Markdown source={draft} />
              ) : (
                <p className="muted">{t("conv.nothingToPreview")}</p>
              )}
            </div>
          )}
          <div className="row">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={save.isPending}
              onClick={() => save.mutate(draft)}
            >
              {save.isPending ? t("common.working") : t("common.save")}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : conv.notes ? (
        <Markdown source={conv.notes} className="notes" />
      ) : (
        <p className="muted">
          {conv.status === "ready" ? t("conv.noNotes") : t("conv.notesPending")}
        </p>
      )}
    </section>
  );
}

function ActionItems({ conv }: { conv: ConversationDetail }) {
  const { t } = useI18n();
  const baseId = useId();
  if (conv.actionItems.length === 0) return null;
  return (
    <section className="section" aria-labelledby={`${baseId}-h`}>
      <h2 id={`${baseId}-h`}>{t("conv.actionItems")}</h2>
      <ul className="checklist">
        {conv.actionItems.map((a) => (
          <ActionItemRow key={a.id} convId={conv.id} item={a} inputId={`${baseId}-${a.id}`} />
        ))}
      </ul>
    </section>
  );
}

function LinkedMemories({ conv }: { conv: ConversationDetail }) {
  const { t } = useI18n();
  const baseId = useId();
  const memories = useQuery({
    queryKey: [...qk.memoriesAll, "conversation", conv.id],
    queryFn: () => api.memories({ limit: 200, conversationId: conv.id }),
    enabled: conv.memoryIds.length > 0,
    select: (page) =>
      page.items.filter((m) => conv.memoryIds.includes(m.id) || m.sourceConversationId === conv.id),
  });
  if (conv.memoryIds.length === 0) return null;
  return (
    <section className="section" aria-labelledby={`${baseId}-h`}>
      <h2 id={`${baseId}-h`}>{t("conv.memories")}</h2>
      {memories.isPending ? (
        <Loading />
      ) : memories.error ? (
        <ErrorNote error={memories.error} onRetry={() => void memories.refetch()} />
      ) : (
        <ul className="mini-memories">
          {memories.data.map((m) => (
            <li key={m.id}>
              <span className={`chip kind-${m.kind}`}>{t(MEMORY_KIND_KEY[m.kind])}</span>
              <Link to={`/memories?focus=${encodeURIComponent(m.id)}`}>{m.content}</Link>
            </li>
          ))}
          {memories.data.length < conv.memoryIds.length && (
            <li className="muted">
              <Link to="/memories">{t("conv.moreMemories")}</Link>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function UtteranceRow({
  u,
  devices,
  highlighted,
}: {
  u: Utterance;
  devices: Map<string, Device>;
  highlighted: boolean;
}) {
  const { t } = useI18n();
  const fmt = useFmt();
  return (
    <li id={`u-${u.id}`} className={`utt speaker-${u.speaker} ${highlighted ? "highlight" : ""}`}>
      <div className="utt-side">
        <time dateTime={new Date(u.startMs).toISOString()}>{fmt.time(u.startMs, true)}</time>
        <span className="utt-speaker">{t(SPEAKER_KEY[u.speaker])}</span>
      </div>
      <div className="utt-main">
        <p lang={u.language ?? undefined}>{u.text}</p>
        <ul className="heard" aria-label={t("conv.heardBy")}>
          {u.deviceIds.map((id, i) => {
            const d = devices.get(id);
            // `sources` is index-aligned with `deviceIds` when the server sends both in full.
            const source =
              u.sources.length === u.deviceIds.length
                ? u.sources[i]
                : i === 0
                  ? u.sources[0]
                  : undefined;
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: order matters (first = text source)
                key={`${id}-${i}`}
                className={i === 0 ? "heard-badge primary" : "heard-badge"}
                title={i === 0 ? t("conv.textSource") : t("conv.alsoHeard")}
              >
                <DeviceIcon kind={d?.kind} size={13} />
                <span>{d?.name ?? t("devices.unknown")}</span>
                {source && (
                  <>
                    <SourceIcon source={source} size={12} />
                    <span className="sr-only">{t(SOURCE_KEY[source])}</span>
                  </>
                )}
                {i === 0 && <span className="sr-only"> ({t("conv.textSource")})</span>}
              </li>
            );
          })}
          {u.origin === "edge_stt" && <li className="heard-badge quiet">{t("conv.onDevice")}</li>}
        </ul>
      </div>
    </li>
  );
}

export function ConversationPage() {
  const { id = "" } = useParams();
  const { t, tn } = useI18n();
  const fmt = useFmt();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const conv = useConversation(id);
  const devices = useDeviceMap();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReprocess, setConfirmReprocess] = useState(false);
  const highlight = location.hash.startsWith("#u-") ? location.hash.slice(3) : null;

  const del = useMutation({
    mutationFn: () => api.deleteConversation(id),
    onSuccess: () => {
      removeConversation(qc, id);
      toast.show(t("conv.deleted"), "success");
      navigate("/", { replace: true });
    },
  });
  const reprocess = useMutation({
    mutationFn: () => api.reprocessConversation(id),
    onSuccess: () => {
      setConfirmReprocess(false);
      qc.setQueryData<ConversationDetail>(qk.conversation(id), (d) =>
        d ? { ...d, status: "processing" } : d,
      );
      toast.show(t("conv.reprocessQueued"), "success");
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
  });

  useEffect(() => {
    if (!highlight || !conv.data) return;
    document.getElementById(`u-${highlight}`)?.scrollIntoView({ block: "center" });
  }, [highlight, conv.data]);

  const deviceNames = useMemo(
    () => (conv.data?.deviceIds ?? []).map((d) => devices.get(d)?.name ?? t("devices.unknown")),
    [conv.data, devices, t],
  );

  if (conv.isPending) return <Loading />;
  if (conv.error) {
    if (isApiError(conv.error, "not_found")) {
      return (
        <EmptyState title={t("conv.notFound")}>
          <Link to="/">{t("conv.backToTimeline")}</Link>
        </EmptyState>
      );
    }
    return <ErrorNote error={conv.error} onRetry={() => void conv.refetch()} />;
  }
  const c = conv.data;

  return (
    <div className="page conversation">
      <Link to={`/days/${fmt.dayOf(c.startMs)}`} className="back-link">
        <IconArrowLeft size={16} /> {fmt.day(fmt.dayOf(c.startMs))}
      </Link>

      <header className="conv-header">
        <div className="conv-header-main">
          <p className="eyebrow">
            {fmt.date(c.startMs)} · {fmt.time(c.startMs)}–{fmt.time(c.endMs)} ·{" "}
            {fmt.duration(c.endMs - c.startMs)}
          </p>
          <TitleEditor key={c.title ?? ""} conv={c} />
          <div className="conv-header-meta">
            <StatusChip status={c.status} interim={c.interim} />
            {deviceNames.length > 0 && (
              <span className="muted">
                {t("conv.heardByList", { devices: deviceNames.join(", ") })}
              </span>
            )}
            {c.participants.length > 0 && (
              <span className="muted">{c.participants.join(", ")}</span>
            )}
          </div>
        </div>
        <div className="row conv-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setConfirmReprocess(true)}
            disabled={c.status === "open" || reprocess.isPending}
          >
            <IconRefresh size={16} /> {t("conv.reprocess")}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger-quiet"
            onClick={() => setConfirmDelete(true)}
          >
            <IconTrash size={16} /> {t("common.delete")}
          </button>
        </div>
      </header>

      {c.status === "transcript_only" && (
        <div className="note note-warn">
          <p>
            <strong>{t("conv.transcriptOnly")}</strong>{" "}
            {c.statusDetail ?? t("conv.transcriptOnlyDefault")}
          </p>
          <Link to="/settings/providers">{t("conv.checkProviders")}</Link>
        </div>
      )}
      {c.status === "processing" && <div className="note">{t("conv.processingNote")}</div>}
      {c.status === "open" &&
        (c.interim ? (
          <div className="note note-live">
            <p>
              <strong>{t("conv.interimTitle")}</strong> {t("conv.interimNote")}
            </p>
          </div>
        ) : (
          <div className="note note-live">{t("conv.openNote")}</div>
        ))}

      <div className="detail-grid">
        <div className="detail-notes">
          {c.summary && (
            <section className="section">
              <h2 className="sr-only">{t("conv.summary")}</h2>
              <p className="summary">{c.summary}</p>
            </section>
          )}
          {c.topics.length > 0 && (
            <ul className="tags" aria-label={t("conv.topics")}>
              {c.topics.map((topic) => (
                <li key={topic} className="tag">
                  {topic}
                </li>
              ))}
            </ul>
          )}
          <NotesSection conv={c} />
          {c.decisions.length > 0 && (
            <section className="section">
              <h2>{t("conv.decisions")}</h2>
              <ul className="decisions">
                {c.decisions.map((d, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: decisions are plain strings without ids
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </section>
          )}
          <ActionItems conv={c} />
          <LinkedMemories conv={c} />
        </div>

        <section className="section transcript" aria-labelledby="transcript-h">
          <div className="section-head">
            <h2 id="transcript-h">{t("conv.transcript")}</h2>
            <span className="muted">{tn("conv.utterances", c.utterances.length)}</span>
          </div>
          {c.utterances.length === 0 ? (
            <p className="muted">{t("conv.noTranscript")}</p>
          ) : (
            <ol className="utterances">
              {c.utterances.map((u) => (
                <UtteranceRow key={u.id} u={u} devices={devices} highlighted={u.id === highlight} />
              ))}
            </ol>
          )}
          <p className="hint">{t("conv.mergeHint")}</p>
        </section>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => del.mutate()}
        busy={del.isPending}
        danger
        title={t("conv.deleteTitle")}
        body={t("conv.deleteBody")}
        confirmLabel={t("common.delete")}
      />
      <ConfirmDialog
        open={confirmReprocess}
        onClose={() => setConfirmReprocess(false)}
        onConfirm={() => reprocess.mutate()}
        busy={reprocess.isPending}
        title={t("conv.reprocessTitle")}
        body={t("conv.reprocessBody")}
        confirmLabel={t("conv.reprocess")}
      />
    </div>
  );
}
