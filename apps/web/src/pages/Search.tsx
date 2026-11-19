import { type SearchHit, type SearchHitType, zSearchHitType } from "@ltm/protocol";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useId, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, isApiError } from "../api/client";
import { IconChat, IconMemory, IconSearch, IconSparkle, IconTimeline } from "../components/Icons";
import { EmptyState, ErrorNote, Loading, Markdown, PageHeader } from "../components/ui";
import { type MessageKey, useI18n } from "../i18n";
import { formatDateTime } from "../lib/format";
import { linkCitations } from "../lib/markdown";

const HIT_KEY: Record<SearchHitType, MessageKey> = {
  memory: "search.typeMemory",
  conversation: "search.typeConversation",
  utterance: "search.typeUtterance",
};

/** Where a hit lives in the app. Utterances deep-link to their line in the transcript. */
export function hitHref(hit: SearchHit): string | null {
  if (hit.type === "conversation") return `/conversations/${encodeURIComponent(hit.id)}`;
  if (hit.type === "utterance" && hit.conversationId) {
    return `/conversations/${encodeURIComponent(hit.conversationId)}#u-${encodeURIComponent(hit.id)}`;
  }
  if (hit.type === "memory") return `/memories?focus=${encodeURIComponent(hit.id)}`;
  return null;
}

function HitIcon({ type }: { type: SearchHitType }) {
  if (type === "memory") return <IconMemory size={16} />;
  if (type === "conversation") return <IconTimeline size={16} />;
  return <IconChat size={16} />;
}

function Hit({ hit, index }: { hit: SearchHit; index?: number }) {
  const { t, locale } = useI18n();
  const href = hitHref(hit);
  // Memories have no title; their snippet is the statement itself and becomes the link.
  const title = hit.title;
  return (
    <li className={`hit hit-${hit.type}`} id={index !== undefined ? `cite-${index}` : undefined}>
      <div className="hit-head">
        {index !== undefined && <span className="cite-num">{index}</span>}
        <span className="chip chip-quiet">
          <HitIcon type={hit.type} />
          {t(HIT_KEY[hit.type])}
        </span>
        {hit.atMs !== null && (
          <time className="muted" dateTime={new Date(hit.atMs).toISOString()}>
            {formatDateTime(hit.atMs, locale)}
          </time>
        )}
        <span className="score" title={t("search.score")}>
          <span
            className="score-bar"
            style={{ width: `${Math.round(Math.max(0, Math.min(1, hit.score)) * 100)}%` }}
          />
          <span className="sr-only">
            {t("search.score")}: {Math.round(hit.score * 100)}%
          </span>
        </span>
      </div>
      {title ? (
        <>
          <h3 className="hit-title">{href ? <Link to={href}>{title}</Link> : title}</h3>
          <p className="hit-snippet">{hit.snippet}</p>
        </>
      ) : (
        <h3 className="hit-title hit-title-snippet">
          {href ? <Link to={href}>{hit.snippet}</Link> : hit.snippet}
        </h3>
      )}
      {hit.type === "memory" && hit.conversationId && (
        <Link
          className="hit-source"
          to={`/conversations/${encodeURIComponent(hit.conversationId)}`}
        >
          {t("search.fromConversation")}
        </Link>
      )}
    </li>
  );
}

function SearchMode() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<SearchHitType[]>([...zSearchHitType.options]);
  const inputId = useId();
  const search = useMutation({
    meta: { inline: true },
    mutationFn: () =>
      api.search({
        query: query.trim(),
        limit: 30,
        types: types.length === zSearchHitType.options.length ? undefined : types,
      }),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim() && types.length) search.mutate();
  };
  return (
    <div className="stack">
      <search>
        <form className="ask-form" onSubmit={onSubmit}>
          <label htmlFor={inputId} className="sr-only">
            {t("search.query")}
          </label>
          <div className="input-icon input-lg">
            <IconSearch size={18} />
            <input
              id={inputId}
              type="search"
              value={query}
              maxLength={500}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("search.placeholder")}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary btn-lg"
            disabled={!query.trim() || !types.length || search.isPending}
          >
            {t("search.submit")}
          </button>
        </form>
      </search>
      <fieldset className="chip-group">
        <legend className="chip-legend">{t("search.lookIn")}</legend>
        {zSearchHitType.options.map((type) => (
          <label key={type} className={types.includes(type) ? "chip-toggle on" : "chip-toggle"}>
            <input
              type="checkbox"
              checked={types.includes(type)}
              onChange={(e) =>
                setTypes((ts) => (e.target.checked ? [...ts, type] : ts.filter((x) => x !== type)))
              }
            />
            {t(HIT_KEY[type])}
          </label>
        ))}
      </fieldset>

      {search.isPending && <Loading label={t("search.searching")} />}
      {search.error && <ErrorNote error={search.error} />}
      {search.data && (
        <section aria-live="polite" className="stack-sm">
          <p className="mode-line">
            <span className={`chip ${search.data.mode === "hybrid" ? "chip-ok" : "chip-quiet"}`}>
              {search.data.mode === "hybrid" ? t("search.modeHybrid") : t("search.modeKeyword")}
            </span>
            <span className="muted">
              {search.data.mode === "hybrid"
                ? t("search.modeHybridHint")
                : t("search.modeKeywordHint")}{" "}
              {search.data.mode === "keyword" && (
                <Link to="/settings/providers">{t("search.configureEmbeddings")}</Link>
              )}
            </span>
          </p>
          {search.data.hits.length === 0 ? (
            <EmptyState title={t("search.noHits")}>
              <p>{t("search.noHitsLead")}</p>
            </EmptyState>
          ) : (
            <ol className="hits">
              {search.data.hits.map((h) => (
                <Hit key={`${h.type}-${h.id}`} hit={h} />
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

function AskMode() {
  const { t } = useI18n();
  const [question, setQuestion] = useState("");
  const inputId = useId();
  const ask = useMutation({
    meta: { inline: true },
    mutationFn: () => api.ask({ question: question.trim() }),
  });
  const answer = useMemo(
    () => (ask.data ? linkCitations(ask.data.answer, ask.data.citations.length) : ""),
    [ask.data],
  );
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (question.trim()) ask.mutate();
  };
  return (
    <div className="stack">
      <form className="ask-form ask-form-col" onSubmit={onSubmit}>
        <label htmlFor={inputId} className="sr-only">
          {t("ask.question")}
        </label>
        <textarea
          id={inputId}
          rows={3}
          value={question}
          maxLength={2000}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit(e);
          }}
          placeholder={t("ask.placeholder")}
        />
        <div className="row row-between">
          <span className="hint">{t("ask.hint")}</span>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!question.trim() || ask.isPending}
          >
            <IconSparkle size={16} /> {t("ask.submit")}
          </button>
        </div>
      </form>

      {ask.isPending && <Loading label={t("ask.thinking")} />}
      {ask.error &&
        (isApiError(ask.error, "provider_not_configured") ? (
          <div className="note note-warn" role="alert">
            <p>
              <strong>{t("ask.noProvider")}</strong> {t("ask.noProviderBody")}
            </p>
            <Link to="/settings/providers">{t("ask.configure")}</Link>
          </div>
        ) : (
          <ErrorNote error={ask.error} />
        ))}
      {ask.data && (
        <section className="answer card" aria-live="polite" aria-labelledby="answer-h">
          <h2 id="answer-h" className="eyebrow">
            {t("ask.answer")}
          </h2>
          <Markdown source={answer} className="answer-body" />
          {ask.data.citations.length > 0 && (
            <>
              <h3 className="sources-head">{t("ask.sources")}</h3>
              <ol className="hits hits-cited">
                {ask.data.citations.map((h, i) => (
                  // The position is the citation number, so the index is part of the identity.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  <Hit key={`${h.type}-${h.id}-${i}`} hit={h} index={i + 1} />
                ))}
              </ol>
            </>
          )}
        </section>
      )}
    </div>
  );
}

export function SearchPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const mode = params.get("mode") === "ask" ? "ask" : "search";
  const setMode = (m: "search" | "ask") =>
    setParams(m === "ask" ? { mode: "ask" } : {}, { replace: true });
  return (
    <div className="page">
      <PageHeader title={t("search.title")} lead={t("search.lead")} />
      <div className="segmented segmented-lg" role="tablist" aria-label={t("search.modes")}>
        <button
          type="button"
          role="tab"
          id="tab-search"
          aria-controls="panel-search"
          aria-selected={mode === "search"}
          onClick={() => setMode("search")}
        >
          <IconSearch size={16} /> {t("search.tabSearch")}
        </button>
        <button
          type="button"
          role="tab"
          id="tab-ask"
          aria-controls="panel-ask"
          aria-selected={mode === "ask"}
          onClick={() => setMode("ask")}
        >
          <IconSparkle size={16} /> {t("search.tabAsk")}
        </button>
      </div>
      <div role="tabpanel" id={`panel-${mode}`} aria-labelledby={`tab-${mode}`}>
        {mode === "search" ? <SearchMode /> : <AskMode />}
      </div>
    </div>
  );
}
