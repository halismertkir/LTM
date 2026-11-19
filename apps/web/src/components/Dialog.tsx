import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { IconX } from "./Icons";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Element id that describes the dialog (for screen readers). */
  describedBy?: string;
}

/**
 * Built on the native <dialog>: showModal() gives a real focus trap, inert background and
 * Escape-to-close without extra code. Focus returns to the opener when it closes.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  describedBy,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useI18n();
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      opener.current = document.activeElement;
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
      // Prefer the first form field over the close button as the initial focus.
      const first = el.querySelector<HTMLElement>(
        "[data-autofocus], input:not([type=hidden]):not([disabled]), textarea, select",
      );
      first?.focus();
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
      if (opener.current instanceof HTMLElement) opener.current.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${size}`}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        // A press on the backdrop targets the <dialog> element itself.
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog-body">
          <header className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label={t("common.close")}
            >
              <IconX />
            </button>
          </header>
          <div className="dialog-content">{children}</div>
          {footer && <footer className="dialog-foot">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  /** When set, the user must type this word before the confirm button enables. */
  typeToConfirm?: string;
  children?: ReactNode;
  confirmDisabled?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  typeToConfirm,
  children,
  confirmDisabled,
}: ConfirmProps) {
  const { t } = useI18n();
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const bodyId = useId();
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const blocked =
    (typeToConfirm !== undefined && typed !== typeToConfirm) || confirmDisabled || busy;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      describedBy={bodyId}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={danger ? "btn btn-danger" : "btn btn-primary"}
            disabled={blocked}
            onClick={onConfirm}
          >
            {busy ? t("common.working") : confirmLabel}
          </button>
        </>
      }
    >
      <div id={bodyId} className="stack-sm">
        {typeof body === "string" ? <p>{body}</p> : body}
      </div>
      {children}
      {typeToConfirm !== undefined && (
        <div className="field">
          <label htmlFor={inputId}>{t("common.typeToConfirm", { word: typeToConfirm })}</label>
          <input
            id={inputId}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
      )}
    </Dialog>
  );
}
