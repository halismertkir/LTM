import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";
import { IconX } from "./Icons";

type Tone = "info" | "success" | "error";
interface ToastItem {
  id: number;
  tone: Tone;
  text: string;
}

interface ToastApi {
  show: (text: string, tone?: Tone) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const { t } = useI18n();

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (text: string, tone: Tone = "info") => {
      const id = next.current++;
      setItems((xs) => [...xs.filter((x) => x.text !== text).slice(-3), { id, tone, text }]);
      window.setTimeout(() => dismiss(id), tone === "error" ? 8000 : 4000);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Errors are announced assertively, everything else politely. */}
      <div className="toasts" aria-live="polite" role="status">
        {items
          .filter((i) => i.tone !== "error")
          .map((i) => (
            <Toast key={i.id} item={i} onDismiss={dismiss} closeLabel={t("common.dismiss")} />
          ))}
      </div>
      <div className="toasts toasts-errors" role="alert">
        {items
          .filter((i) => i.tone === "error")
          .map((i) => (
            <Toast key={i.id} item={i} onDismiss={dismiss} closeLabel={t("common.dismiss")} />
          ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({
  item,
  onDismiss,
  closeLabel,
}: {
  item: ToastItem;
  onDismiss: (id: number) => void;
  closeLabel: string;
}) {
  return (
    <div className={`toast toast-${item.tone}`}>
      <span>{item.text}</span>
      <button
        type="button"
        className="icon-btn"
        aria-label={closeLabel}
        onClick={() => onDismiss(item.id)}
      >
        <IconX size={16} />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
