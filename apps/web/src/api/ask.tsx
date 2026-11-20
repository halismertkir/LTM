import type { AskResponse } from "@ltm/protocol";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { type AskScope, scopeRange } from "../lib/scope";
import { api } from "./client";

export interface AskTurn {
  id: string;
  question: string;
  scope: AskScope;
  askedAt: number;
  status: "pending" | "done" | "error";
  answer?: AskResponse;
  error?: unknown;
}

interface AskThread {
  turns: AskTurn[];
  ask: (question: string, scope: AskScope, tz: string) => void;
  clear: () => void;
}

const AskContext = createContext<AskThread | null>(null);

/**
 * The Ask page as a conversation. Each question is still a single, independent `POST /ask`
 * on the server; the thread only lives in memory for this page session (never in storage —
 * answers quote private conversations) and is dropped on sign-out with the provider.
 */
export function AskProvider({ children }: { children: ReactNode }) {
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const seq = useRef(0);

  const ask = useCallback((question: string, scope: AskScope, tz: string) => {
    seq.current += 1;
    const id = `t${seq.current}`;
    const askedAt = Date.now();
    setTurns((ts) => [...ts, { id, question, scope, askedAt, status: "pending" }]);
    const patch = (p: Partial<AskTurn>) =>
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
    api
      .ask({ question, ...scopeRange(scope, askedAt, tz) })
      .then((answer) => patch({ status: "done", answer }))
      .catch((error: unknown) => patch({ status: "error", error }));
  }, []);

  const clear = useCallback(() => setTurns([]), []);
  const value = useMemo(() => ({ turns, ask, clear }), [turns, ask, clear]);
  return <AskContext.Provider value={value}>{children}</AskContext.Provider>;
}

export function useAskThread(): AskThread {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAskThread outside AskProvider");
  return ctx;
}
