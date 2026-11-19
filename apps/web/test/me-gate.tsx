import type { ReactElement } from "react";
import { useMe } from "../src/api/queries";

/** Renders children once `/me` has loaded, like the real auth gate does. */
export function MeGate({ children }: { children: ReactElement }) {
  const me = useMe();
  return me.data ? children : null;
}
