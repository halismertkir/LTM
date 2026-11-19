import { CONSENT_DOCUMENTS, type ConsentDocument, type ConsentState, type Me } from "@ltm/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { api } from "../api/client";
import { qk, useMeData } from "../api/queries";
import { IconCheck, IconLock } from "../components/Icons";
import { useToast } from "../components/Toast";
import { ErrorNote, Markdown, PageHeader } from "../components/ui";
import { useI18n } from "../i18n";
import { formatDate } from "../lib/format";

export function ConsentDocBody({ doc }: { doc: ConsentDocument }) {
  const { locale, t } = useI18n();
  const text = doc[locale];
  return (
    <section
      className="consent-text"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable so keyboard users can scroll it
      tabIndex={0}
      aria-label={t("consent.documentText", { title: text.title })}
    >
      <Markdown source={text.body} />
    </section>
  );
}

/** Documents still to accept, in canonical order, with the version the server requires. */
function pendingDocuments(
  state: ConsentState,
): { doc: ConsentDocument; requiredVersion: string }[] {
  const pending = state.required.filter((r) => !r.accepted);
  return CONSENT_DOCUMENTS.flatMap((doc) => {
    const req = pending.find((r) => r.type === doc.type);
    return req ? [{ doc, requiredVersion: req.version }] : [];
  });
}

export function ConsentGate({ onDone }: { onDone?: () => void }) {
  const { t, locale } = useI18n();
  const me = useMeData();
  const qc = useQueryClient();
  const toast = useToast();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const baseId = useId();

  const pending = pendingDocuments(me.consent);
  const allChecked = pending.length > 0 && pending.every(({ doc }) => checked[doc.type]);
  // "Again" only when a document still pending was accepted before (older version).
  const askedAgain = pending.some(({ doc }) => me.consent.records.some((r) => r.type === doc.type));

  const accept = useMutation({
    meta: { inline: true },
    // We send the version of the text the user actually read. If that differs from what the
    // server requires (outdated web build) the server keeps `satisfied: false`, and we say so.
    mutationFn: () =>
      api.acceptConsents({
        accept: pending.map(({ doc }) => ({ type: doc.type, version: doc.version })),
      }),
    onSuccess: (consent) => {
      qc.setQueryData<Me>(qk.me, (m) => (m ? { ...m, consent } : m));
      void qc.invalidateQueries({ queryKey: qk.me });
      if (consent.satisfied) {
        toast.show(t("consent.thanks"), "success");
        onDone?.();
      }
    },
  });

  return (
    <div className="consent-gate">
      <PageHeader
        eyebrow={
          <span className="eyebrow-blocked">
            <IconLock size={14} /> {t("consent.eyebrow")}
          </span>
        }
        title={askedAgain ? t("consent.titleAgain") : t("consent.title")}
        lead={t("consent.lead")}
      />

      {pending.length === 0 ? (
        <div className="note note-warn">
          <p>{t("consent.versionMismatch")}</p>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (allChecked) accept.mutate();
          }}
        >
          {pending.map(({ doc, requiredVersion }, i) => {
            const text = doc[locale];
            const boxId = `${baseId}-${doc.type}`;
            return (
              <article
                key={doc.type}
                className="card consent-doc"
                aria-labelledby={`${boxId}-title`}
              >
                <header className="consent-doc-head">
                  <span className="consent-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div>
                    <h2 id={`${boxId}-title`}>{text.title}</h2>
                    <p className="meta">
                      {t("consent.version", { version: doc.version })}
                      {requiredVersion !== doc.version &&
                        ` · ${t("consent.serverVersion", { version: requiredVersion })}`}
                    </p>
                  </div>
                </header>
                <ConsentDocBody doc={doc} />
                {doc.type === "third_party_ai" && (
                  <p className="hint">
                    {t("consent.preferLocal")}{" "}
                    <Link to="/settings/providers">{t("consent.preferLocalLink")}</Link>
                  </p>
                )}
                <label className="check-row consent-check" htmlFor={boxId}>
                  <input
                    id={boxId}
                    type="checkbox"
                    checked={!!checked[doc.type]}
                    onChange={(e) => setChecked((c) => ({ ...c, [doc.type]: e.target.checked }))}
                  />
                  <span>{t("consent.acceptDoc", { title: text.title })}</span>
                </label>
              </article>
            );
          })}

          {accept.error && <ErrorNote error={accept.error} />}
          {accept.data && !accept.data.satisfied && (
            <div className="note note-warn">
              <p>{t("consent.versionMismatch")}</p>
            </div>
          )}

          <div className="consent-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!allChecked || accept.isPending}
            >
              <IconCheck size={16} />
              {accept.isPending ? t("common.working") : t("consent.submit")}
            </button>
            <Link className="btn btn-ghost" to="/settings">
              {t("consent.later")}
            </Link>
          </div>
          <p className="hint">{t("consent.footnote", { date: formatDate(Date.now(), locale) })}</p>
        </form>
      )}
    </div>
  );
}

export function ConsentPage() {
  const me = useMeData();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const back = (location.state as { from?: string } | null)?.from ?? "/";
  if (!me.consent.satisfied)
    return <ConsentGate onDone={() => navigate(back, { replace: true })} />;
  return (
    <div className="narrow">
      <PageHeader title={t("consent.doneTitle")} lead={t("consent.doneLead")} />
      <div className="row">
        <Link className="btn btn-primary" to="/">
          {t("nav.timeline")}
        </Link>
        <Link className="btn" to="/settings/privacy">
          {t("consent.manage")}
        </Link>
      </div>
    </div>
  );
}
