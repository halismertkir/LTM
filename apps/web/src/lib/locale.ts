import type { Locale, Me } from "@ltm/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "../api/client";
import { qk } from "../api/queries";
import { useI18n } from "../i18n";

/**
 * Switch the UI language: localStorage answers instantly (and before sign-in), `PATCH /me`
 * makes the choice follow the account to other browsers and to notes. A failed save is
 * harmless — the local choice still applies — so it is not reported.
 */
export function useSwitchLocale(): (l: Locale) => void {
  const { setLocale } = useI18n();
  const qc = useQueryClient();
  return useCallback(
    (l: Locale) => {
      setLocale(l);
      if (!qc.getQueryData<Me>(qk.me)) return;
      api
        .updateMe({ locale: l })
        .then((me) => qc.setQueryData(qk.me, me))
        .catch(() => {});
    },
    [setLocale, qc],
  );
}
