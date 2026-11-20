import { type SearchHit, type SearchHitType, zSearchHitType } from "@ltm/protocol";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { type AskTurn, useAskThread } from "../api/ask";
import { api, isApiError } from "../api/client";
import { IconChat, IconMemory, IconSearch, IconSparkle, IconTimeline } from "../components/Icons";
import { EmptyState, ErrorNote, Loading, Markdown, PageHeader } from "../components/ui";
import { type MessageKey, useI18n } from "../i18n";
import { linkCitations } from "../lib/markdown";
import type { AskScope } from "../lib/scope";
import { useFmt } from "../lib/useFmt";

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

function Hit({
  hit,
  index,
  idPrefix = "cite",
}: {
  hit: SearchHit;
  index?: number;
  idPrefix?: string;
}) {
  const { t } = useI18n();
  const fmt = useFmt();
  const href = hitHref(hit);
  // Memories have no title; their snippet is the statement itself and becomes the link.
  const title = hit.title;
  return (
    <li
      className={`hit hit-${hit.type}`}
      id={index !== undefined ? `${idPrefix}-${index}` : undefined}
    >
      <div className="hit-head">
        {index !== undefined && <span className="cite-num">{index}</span>}
        <span className="chip chip-quiet">
          <HitIcon type={hit.type} />
          {t(HIT_KEY[hit.type])}
        </span>
        {hit.atMs !== null && (
          <time className="muted" dateTime={new Date(hit.atMs).toISOString()}>
            {fmt.dateTime(hit.atMs)}
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

const SCOPE_KEY: Record<AskScope, MessageKey> = {
  today: "ask.scopeToday",
  week: "ask.scopeWeek",
  all: "ask.scopeAll",
};

function AskAnswer({ turn }: { turn: AskTurn }) {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(false);
  const prefix = `cite-${turn.id}`;
  const answer = turn.answer;
  const md = useMemo(
    () => (answer ? linkCitations(answer.answer, answer.citations.length, prefix) : ""),
    [answer, prefix],
  );
  if (turn.status === "pending") return <Loading label={t("ask.thinking")} />;
  if (turn.status === "error") {
    return isApiError(turn.error, "provider_not_configured") ? (
      <div className="note note-warn" role="alert">
        <p>
          <strong>{t("ask.noProvider")}</strong> {t("ask.noProviderBody")}
        </p>
        <Link to="/settings/providers">{t("ask.configure")}</Link>
      </div>
    ) : (
      <ErrorNote error={turn.error} />
    );
  }
  if (!answer) return null;
  return (
    // Clicking a [n] marker opens the sources first, so the jump has somewhere to land.
    // biome-ignore lint/a11y/noStaticElementInteractions: delegates clicks of the links inside
    // biome-ignore lint/a11y/useKeyWithClickEvents: the links themselves are keyboard reachable
    <div
      className="answer-inner"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (a?.getAttribute("href")?.startsWith(`#${prefix}-`)) setOpen(true);
      }}
    >
      <Markdown source={md} className="answer-body" />
      {answer.citations.length > 0 && (
        <details className="sources" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>{tn("ask.sourcesCount", answer.citations.length)}</summary>
          <ol className="hits hits-cited">
            {answer.citations.map((h, i) => (
              // The position is the citation number, so the index is part of the identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <Hit key={`${h.type}-${h.id}-${i}`} hit={h} index={i + 1} idPrefix={prefix} />
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function AskMode() {
  const { t } = useI18n();
  const fmt = useFmt();
  const thread = useAskThread();
  const [params, setParams] = useSearchParams();
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<AskScope>("all");
  const inputId = useId();
  const bottom = useRef<HTMLDivElement>(null);
  const handledQ = useRef<string | null>(null);
  const pending = thread.turns.some((x) => x.status === "pending");

  // A question sent from the header box arrives as ?q=… and runs right away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the query string changes
  useEffect(() => {
    const q = params.get("q")?.trim();
    if (!q || handledQ.current === q) return;
    handledQ.current = q;
    thread.ask(q, scope, fmt.tz);
    setParams({}, { replace: true });
  }, [params]);

  // Keep the newest turn in view, like a chat.
  useEffect(() => {
    if (thread.turns.length) bottom.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [thread.turns]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    thread.ask(q, scope, fmt.tz);
    setQuestion("");
  };

  return (
    <div className="stack ask">
      {thread.turns.length === 0 ? (
        <div className="ask-empty">
          <p className="lead">{t("ask.emptyLead")}</p>
          <ul className="ask-examples">
            {(["ask.example1", "ask.example2", "ask.example3"] as const).map((k) => (
              <li key={k}>
                <button type="button" className="link-btn" onClick={() => setQuestion(t(k))}>
                  {t(k)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ol className="thread" aria-label={t("ask.threadLabel")}>
          {thread.turns.map((turn) => (
            <li key={turn.id} className="turn">
              <div className="turn-q">
                <p>{turn.question}</p>
                <span className="turn-meta">
                  {fmt.time(turn.askedAt)} · {t(SCOPE_KEY[turn.scope])}
                </span>
              </div>
              <div className="turn-a card" aria-live="polite" aria-busy={turn.status === "pending"}>
                <AskAnswer turn={turn} />
              </div>
            </li>
          ))}
        </ol>
      )}

      <form className="ask-compose card" onSubmit={onSubmit}>
        <label htmlFor={inputId} className="sr-only">
          {t("ask.question")}
        </label>
        <textarea
          id={inputId}
          rows={2}
          value={question}
          maxLength={2000}
          enterKeyHint="send"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit(e);
          }}
          placeholder={thread.turns.length ? t("ask.placeholderMore") : t("ask.placeholder")}
        />
        <div className="row row-between ask-compose-foot">
          <fieldset className="segmented segmented-sm">
            <legend className="sr-only">{t("ask.scope")}</legend>
            {(["today", "week", "all"] as const).map((sc) => (
              <label key={sc} className="seg-option">
                <input
                  type="radio"
                  name="ask-scope"
                  checked={scope === sc}
                  onChange={() => setScope(sc)}
                />
                {t(SCOPE_KEY[sc])}
              </label>
            ))}
          </fieldset>
          <div className="row">
            {thread.turns.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={thread.clear}
                disabled={pending}
              >
                {t("ask.clear")}
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={!question.trim()}>
              <IconSparkle size={16} /> {t("ask.submit")}
            </button>
          </div>
        </div>
        <p className="hint">{t("ask.hint")}</p>
      </form>
      <div ref={bottom} />
    </div>
  );
}

export function SearchPage() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // /ask and /search are the same page; ?mode=ask is kept for old links.
  const mode = location.pathname === "/ask" || params.get("mode") === "ask" ? "ask" : "search";
  const setMode = (m: "search" | "ask") =>
    navigate(m === "ask" ? "/ask" : "/search", { replace: true });
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
