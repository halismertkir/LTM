import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api, urls } from "../../api/client";
import { qk } from "../../api/queries";
import { useSession } from "../../api/session";
import { ConfirmDialog } from "../../components/Dialog";
import { IconDownload, IconTrash } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { ErrorNote } from "../../components/ui";
import { useI18n } from "../../i18n";
import { dateInputToMs } from "../../lib/format";
import { useFmt } from "../../lib/useFmt";

export function DataSettings() {
  const { t } = useI18n();
  const fmt = useFmt();
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const [before, setBefore] = useState("");
  const [confirmData, setConfirmData] = useState(false);
  const [confirmAccount, setConfirmAccount] = useState(false);
  const [password, setPassword] = useState("");
  const ids = { before: useId(), password: useId() };
  const beforeMs = dateInputToMs(before, false, fmt.tz);

  const deleteData = useMutation({
    mutationFn: () => api.deleteData({ confirm: "DELETE", beforeMs }),
    onSuccess: () => {
      setConfirmData(false);
      setBefore("");
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
      void qc.invalidateQueries({ queryKey: qk.memoriesAll });
      toast.show(t("data.deletedData"), "success");
    },
  });
  const deleteAccount = useMutation({
    meta: { inline: true },
    mutationFn: () => api.deleteAccount({ password, confirm: "DELETE" }),
    onSuccess: async () => {
      setConfirmAccount(false);
      await qc.invalidateQueries({ queryKey: qk.authStatus });
      await session.logout().catch(() => {});
    },
  });

  return (
    <div className="stack-lg">
      <section className="card stack">
        <h2>{t("data.export")}</h2>
        <p className="muted">{t("data.exportLead")}</p>
        <div className="row">
          {/* A plain link lets the browser stream the attachment with the session cookie. */}
          <a className="btn btn-primary" href={urls.exportData()} download>
            <IconDownload size={16} /> {t("data.exportButton")}
          </a>
        </div>
      </section>

      <section className="card stack danger-zone">
        <h2>{t("data.deleteData")}</h2>
        <p className="muted">{t("data.deleteDataLead")}</p>
        <div className="field field-inline">
          <label htmlFor={ids.before}>{t("data.before")}</label>
          <input
            id={ids.before}
            type="date"
            value={before}
            onChange={(e) => setBefore(e.target.value)}
          />
          <p className="hint">{t("data.beforeHint")}</p>
        </div>
        <div className="row">
          <button type="button" className="btn btn-danger" onClick={() => setConfirmData(true)}>
            <IconTrash size={16} />{" "}
            {beforeMs ? t("data.deleteBefore", { date: fmt.date(beforeMs) }) : t("data.deleteAll")}
          </button>
        </div>
      </section>

      <section className="card stack danger-zone">
        <h2>{t("data.deleteAccount")}</h2>
        <p className="muted">{t("data.deleteAccountLead")}</p>
        <div className="row">
          <button type="button" className="btn btn-danger" onClick={() => setConfirmAccount(true)}>
            <IconTrash size={16} /> {t("data.deleteAccountButton")}
          </button>
        </div>
      </section>

      <ConfirmDialog
        open={confirmData}
        onClose={() => setConfirmData(false)}
        onConfirm={() => deleteData.mutate()}
        busy={deleteData.isPending}
        danger
        title={t("data.deleteData")}
        body={
          beforeMs ? t("data.confirmBefore", { date: fmt.date(beforeMs) }) : t("data.confirmAll")
        }
        confirmLabel={t("common.delete")}
        typeToConfirm="DELETE"
      />
      <ConfirmDialog
        open={confirmAccount}
        onClose={() => {
          setConfirmAccount(false);
          setPassword("");
          deleteAccount.reset();
        }}
        onConfirm={() => deleteAccount.mutate()}
        busy={deleteAccount.isPending}
        danger
        title={t("data.deleteAccount")}
        body={t("data.confirmAccount")}
        confirmLabel={t("data.deleteAccountButton")}
        typeToConfirm="DELETE"
        confirmDisabled={!password}
      >
        <div className="field">
          <label htmlFor={ids.password}>{t("auth.password")}</label>
          <input
            id={ids.password}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {deleteAccount.error && <ErrorNote error={deleteAccount.error} />}
      </ConfirmDialog>
    </div>
  );
}
