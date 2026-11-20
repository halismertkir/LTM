import type { ConversationStatus } from "@ltm/protocol";
import { type ReactNode, useCallback, useId, useMemo } from "react";
import { ApiError } from "../api/client";
import { type MessageKey, useI18n } from "../i18n";
import { renderMarkdown } from "../lib/markdown";
import { IconRefresh } from "./Icons";

export function PageHeader({
  title,
  lead,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </header>
  );
}

/** Translate any thrown value into a sentence for the user. */
export function useErrorText(): (e: unknown) => string {
  const { t } = useI18n();
  return useCallback(
    (e: unknown) => {
      if (e instanceof ApiError) {
        const key = `errors.${e.code}` as MessageKey;
        const base = t(key);
        // These codes carry a specific server explanation worth showing as well.
        if (
          (e.code === "bad_request" || e.code === "provider_error" || e.code === "conflict") &&
          e.message
        ) {
          return `${base} (${e.message})`;
        }
        return base;
      }
      return t("errors.internal");
    },
    [t],
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const text = useErrorText()(error);
  return (
    <div className="note note-error" role="alert">
      <p>{text}</p>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          <IconRefresh size={16} /> {t("common.retry")}
        </button>
      )}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label ?? t("common.loading")}</span>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const descId = useId();
  return (
    <div className="switch-row">
      <div className="switch-text">
        <label htmlFor={id}>{label}</label>
        {description && (
          <p id={descId} className="hint">
            {description}
          </p>
        )}
      </div>
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        className="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? descId : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}

const STATUS_KEY: Record<ConversationStatus, MessageKey> = {
  open: "status.open",
  processing: "status.processing",
  ready: "status.ready",
  transcript_only: "status.transcript_only",
};

export function StatusChip({ status, interim }: { status: ConversationStatus; interim?: boolean }) {
  const { t } = useI18n();
  // Interim notes exist but will be rewritten when the conversation ends.
  const live = status === "open" && interim;
  return (
    <span
      className={`chip status-${status}${live ? " status-interim" : ""}`}
      title={live ? t("status.interimHint") : undefined}
    >
      {status === "open" && <span className="rec-dot" aria-hidden="true" />}
      {live ? t("status.interim") : t(STATUS_KEY[status])}
    </span>
  );
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className={`prose ${className ?? ""}`}
      // Sanitised by DOMPurify in renderMarkdown().
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised markdown
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function EmptyState({
  title,
  children,
  icon,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  id,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  id: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function ImportanceDots({ value, label }: { value: number; label: string }) {
  return (
    <span className="importance" role="img" aria-label={label}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= value ? "on" : ""} />
      ))}
    </span>
  );
}
