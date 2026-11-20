import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { localDeviceStorage } from "../lib/listen";
import { api, setUnauthorizedHandler } from "./client";
import { qk } from "./queries";

interface Session {
  /** True after a 401 or an explicit logout until the next successful sign-in. */
  signedOut: boolean;
  signedIn: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [signedOut, setSignedOut] = useState(false);

  const dropSession = useCallback(() => {
    setSignedOut(true);
    // This browser's capture credential belongs to the account that is signing out.
    localDeviceStorage().clear();
    // Nothing from the previous session may linger in memory for the next person at this screen.
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.authStatus[0] });
  }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(dropSession);
    return () => setUnauthorizedHandler(null);
  }, [dropSession]);

  const signedIn = useCallback(async () => {
    qc.removeQueries({
      predicate: (q) => q.queryKey[0] !== qk.authStatus[0] && q.queryKey[0] !== qk.me[0],
    });
    // Reset rather than remove `/me`: the auth gate keeps observing it, and a reset query
    // with no data is refetched as soon as it is enabled again.
    await qc.resetQueries({ queryKey: qk.me });
    await qc.invalidateQueries({ queryKey: qk.authStatus });
    setSignedOut(false);
  }, [qc]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      dropSession();
    }
  }, [dropSession]);

  const value = useMemo(() => ({ signedOut, signedIn, logout }), [signedOut, signedIn, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
