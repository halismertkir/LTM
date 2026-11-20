import {
  type ConsentDocument,
  type ConsentType,
  consentDocument,
  type Me,
  type PrivacySettings,
  type Settings,
} from "@ltm/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { api } from "../../api/client";
import { qk, useMeData, usePauseCapture, useSettings } from "../../api/queries";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { useToast } from "../../components/Toast";
import { ErrorNote, Loading, Switch } from "../../components/ui";
import { useI18n } from "../../i18n";
import { useFmt } from "../../lib/useFmt";
import { ConsentDocBody } from "../Consent";

function RetentionForm({ privacy }: { privacy: PrivacySettings }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [retainAudio, setRetainAudio] = useState(privacy.retainAudio);
  const [audioDays, setAudioDays] = useState(privacy.audioRetentionDays?.toString() ?? "");
  const [autoDelete, setAutoDelete] = useState(privacy.dataRetentionDays !== null);
  const [dataDays, setDataDays] = useState(privacy.dataRetentionDays?.toString() ?? "365");
  const ids = { audio: useId(), data: useId() };

  useEffect(() => {
    setRetainAudio(privacy.retainAudio);
    setAudioDays(privacy.audioRetentionDays?.toString() ?? "");
    setAutoDelete(privacy.dataRetentionDays !== null);
    setDataDays(privacy.dataRetentionDays?.toString() ?? "365");
  }, [privacy]);

  const audioN = audioDays.trim() === "" ? null : Number(audioDays);
  const dataN = autoDelete ? Number(dataDays) : null;
  const audioInvalid =
    audioN !== null && (!Number.isInteger(audioN) || audioN < 1 || audioN > 3650);
  const dataInvalid = dataN !== null && (!Number.isInteger(dataN) || dataN < 1 || dataN > 36500);

  const save = useMutation({
    mutationFn: () =>
      api.putPrivacy({
        ingestPaused:
          qc.getQueryData<Settings>(qk.settings)?.privacy.ingestPaused ?? privacy.ingestPaused,
        retainAudio,
        audioRetentionDays: retainAudio ? audioN : null,
        dataRetentionDays: dataN,
      }),
    onSuccess: (p) => {
      qc.setQueryData<Settings>(qk.settings, (s) => (s ? { ...s, privacy: p } : s));
      toast.show(t("common.saved"), "success");
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!audioInvalid && !dataInvalid) save.mutate();
  };

  return (
    <form className="card stack" onSubmit={onSubmit}>
      <h2>{t("privacy.retention")}</h2>
      <Switch
        checked={retainAudio}
        onChange={setRetainAudio}
        label={t("privacy.retainAudio")}
        description={t("privacy.retainAudioHint")}
      />
      {retainAudio && (
        <div className="field field-inline">
          <label htmlFor={ids.audio}>{t("privacy.audioDays")}</label>
          <input
            id={ids.audio}
            type="number"
            inputMode="numeric"
            min={1}
            max={3650}
            value={audioDays}
            placeholder="∞"
            onChange={(e) => setAudioDays(e.target.value)}
            aria-invalid={audioInvalid || undefined}
          />
          <p className="hint">{t("privacy.audioDaysHint")}</p>
        </div>
      )}
      <Switch
        checked={autoDelete}
        onChange={setAutoDelete}
        label={t("privacy.autoDelete")}
        description={t("privacy.autoDeleteHint")}
      />
      {autoDelete && (
        <div className="field field-inline">
          <label htmlFor={ids.data}>{t("privacy.dataDays")}</label>
          <input
            id={ids.data}
            type="number"
            inputMode="numeric"
            min={1}
            max={36500}
            value={dataDays}
            onChange={(e) => setDataDays(e.target.value)}
            aria-invalid={dataInvalid || undefined}
          />
        </div>
      )}
      <div className="row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={save.isPending || audioInvalid || dataInvalid}
        >
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}

function ConsentRecords() {
  const { t, locale } = useI18n();
  const fmt = useFmt();
  const me = useMeData();
  const qc = useQueryClient();
  const toast = useToast();
  const [reading, setReading] = useState<ConsentDocument | null>(null);
  const [withdrawing, setWithdrawing] = useState<ConsentType | null>(null);

  const withdraw = useMutation({
    mutationFn: (type: ConsentType) => api.withdrawConsents({ types: [type] }),
    onSuccess: (consent) => {
      // The server also pauses ingest on withdrawal.
      qc.setQueryData<Me>(qk.me, (m) => (m ? { ...m, consent, ingestPaused: true } : m));
      void qc.invalidateQueries({ queryKey: qk.me });
      void qc.invalidateQueries({ queryKey: qk.settings });
      setWithdrawing(null);
      toast.show(t("privacy.withdrawn"), "success");
    },
  });

  const docTitle = (type: ConsentType) => {
    try {
      return consentDocument(type)[locale].title;
    } catch {
      return type;
    }
  };
  const latestByType = new Map<ConsentType, string>();
  for (const r of me.consent.records) {
    const prev = latestByType.get(r.type);
    if (!prev || r.acceptedAt > prev) latestByType.set(r.type, r.acceptedAt);
  }

  return (
    <section className="card stack" aria-labelledby="consent-records-h">
      <h2 id="consent-records-h">{t("privacy.consents")}</h2>
      <p className="muted">{t("privacy.consentsLead")}</p>
      <ul className="consent-list">
        {me.consent.required.map((r) => (
          <li key={r.type} className="consent-item">
            <div>
              <strong>{docTitle(r.type)}</strong>
              <p className="muted">
                {t("consent.version", { version: r.version })} ·{" "}
                {r.accepted ? (
                  <span className="ok-text">{t("privacy.accepted")}</span>
                ) : (
                  <span className="warn-text">{t("privacy.notAccepted")}</span>
                )}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setReading(consentDocument(r.type))}
            >
              {t("privacy.read")}
            </button>
          </li>
        ))}
      </ul>

      <h3>{t("privacy.records")}</h3>
      {me.consent.records.length === 0 ? (
        <p className="muted">{t("privacy.noRecords")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t("privacy.document")}</th>
                <th scope="col">{t("privacy.versionCol")}</th>
                <th scope="col">{t("privacy.acceptedAt")}</th>
                <th scope="col">{t("privacy.via")}</th>
                <th scope="col">
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {me.consent.records.map((r) => (
                <tr key={`${r.type}-${r.version}-${r.acceptedAt}`}>
                  <td>{docTitle(r.type)}</td>
                  <td>{r.version}</td>
                  <td>{fmt.dateTime(Date.parse(r.acceptedAt))}</td>
                  <td>{r.via ?? "—"}</td>
                  <td className="td-actions">
                    {latestByType.get(r.type) === r.acceptedAt && (
                      <button
                        type="button"
                        className="btn btn-sm btn-danger-quiet"
                        onClick={() => setWithdrawing(r.type)}
                      >
                        {t("privacy.withdraw")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={reading !== null}
        onClose={() => setReading(null)}
        title={reading ? reading[locale].title : ""}
        size="lg"
      >
        {reading && (
          <>
            <p className="meta">{t("consent.version", { version: reading.version })}</p>
            <ConsentDocBody doc={reading} />
          </>
        )}
      </Dialog>
      <ConfirmDialog
        open={withdrawing !== null}
        onClose={() => setWithdrawing(null)}
        onConfirm={() => withdrawing && withdraw.mutate(withdrawing)}
        busy={withdraw.isPending}
        danger
        title={t("privacy.withdrawTitle", { title: withdrawing ? docTitle(withdrawing) : "" })}
        body={
          <>
            <p>
              <strong>{t("privacy.withdrawWarn")}</strong>
            </p>
            <p>{t("privacy.withdrawBody")}</p>
          </>
        }
        confirmLabel={t("privacy.withdraw")}
      />
    </section>
  );
}

export function PrivacySettingsPage() {
  const { t } = useI18n();
  const settings = useSettings();
  const me = useMeData();
  const pause = usePauseCapture();
  if (settings.isPending) return <Loading />;
  if (settings.error)
    return <ErrorNote error={settings.error} onRetry={() => void settings.refetch()} />;
  return (
    <div className="stack-lg">
      <section className="card stack">
        <h2>{t("privacy.capture")}</h2>
        <Switch
          checked={me.ingestPaused}
          disabled={pause.isPending}
          onChange={(v) => pause.mutate(v)}
          label={t("privacy.pause")}
          description={t("privacy.pauseHint")}
        />
      </section>
      <RetentionForm privacy={settings.data.privacy} />
      <ConsentRecords />
    </div>
  );
}
