import type { ReactNode } from "react";
import { useMeData } from "../api/queries";
import { ConsentGate } from "../pages/Consent";

/**
 * Screens about captured data and capture devices sit behind the consent gate. Settings
 * stay reachable so the user can look at providers and privacy options before agreeing.
 */
export function RequireConsent({ children }: { children: ReactNode }) {
  const me = useMeData();
  if (!me.consent.satisfied) return <ConsentGate />;
  return <>{children}</>;
}
