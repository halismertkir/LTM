import { type Device, type PairingCode, SOURCE_PRIORITY } from "@ltm/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api/client";
import { qk, useDevices } from "../api/queries";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import {
  DeviceIcon,
  IconCopy,
  IconDevices,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "../components/Icons";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorNote, Loading, PageHeader } from "../components/ui";
import { useI18n } from "../i18n";
import { formatClock, formatRelative } from "../lib/format";
import { copyText, useNow } from "../lib/hooks";
import { DEVICE_KIND_KEY, SOURCE_KEY } from "../lib/labels";

function DeviceDialog({ device, onClose }: { device: Device | null; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [auto, setAuto] = useState(true);
  const [priority, setPriority] = useState(50);
  const ids = { name: useId(), prio: useId(), explain: useId() };

  useEffect(() => {
    if (!device) return;
    setName(device.name);
    setAuto(device.priority === null);
    setPriority(device.priority ?? 50);
  }, [device]);

  const save = useMutation({
    meta: { inline: true },
    mutationFn: () =>
      api.updateDevice(device!.id, { name: name.trim(), priority: auto ? null : priority }),
    onSuccess: (updated) => {
      qc.setQueryData<Device[]>(qk.devices, (ds) =>
        ds?.map((d) => (d.id === updated.id ? updated : d)),
      );
      onClose();
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) save.mutate();
  };

  return (
    <Dialog
      open={device !== null}
      onClose={onClose}
      title={t("devices.editTitle")}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            form="device-form"
            className="btn btn-primary"
            disabled={!name.trim() || save.isPending}
          >
            {t("common.save")}
          </button>
        </>
      }
    >
      <form id="device-form" className="stack" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor={ids.name}>{t("devices.name")}</label>
          <input
            id={ids.name}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <fieldset className="field" aria-describedby={ids.explain}>
          <legend>{t("devices.priority")}</legend>
          <p id={ids.explain} className="hint">
            {t("devices.priorityExplain")}
          </p>
          <label className="check-row">
            <input type="radio" name="prio" checked={auto} onChange={() => setAuto(true)} />
            <span>
              <strong>{t("devices.priorityAuto")}</strong>
              <span className="hint block">
                {t("devices.priorityAutoHint", {
                  list: (Object.keys(SOURCE_PRIORITY) as (keyof typeof SOURCE_PRIORITY)[])
                    .map((s) => `${t(SOURCE_KEY[s])} ${SOURCE_PRIORITY[s]}`)
                    .join(" · "),
                })}
              </span>
            </span>
          </label>
          <label className="check-row">
            <input type="radio" name="prio" checked={!auto} onChange={() => setAuto(false)} />
            <span>
              <strong>{t("devices.priorityFixed")}</strong>
            </span>
          </label>
          {!auto && (
            <div className="range-row">
              <label htmlFor={ids.prio} className="sr-only">
                {t("devices.priority")}
              </label>
              <input
                id={ids.prio}
                type="range"
                min={0}
                max={100}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
              <output htmlFor={ids.prio} className="range-value">
                {priority}
              </output>
            </div>
          )}
        </fieldset>
        {save.error && <ErrorNote error={save.error} />}
      </form>
    </Dialog>
  );
}

type Client = "extension" | "iphone" | "watch";

function PairDialog({
  open,
  onClose,
  knownIds,
}: {
  open: boolean;
  onClose: () => void;
  knownIds: string[];
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [client, setClient] = useState<Client>("extension");
  const [qr, setQr] = useState<string | null>(null);
  const now = useNow(1000, open);
  const known = useRef<string[]>(knownIds);
  const devices = useDevices();

  const create = useMutation({ meta: { inline: true }, mutationFn: api.createPairingCode });
  const code: PairingCode | undefined = create.data;
  const remaining = code ? Date.parse(code.expiresAt) - now : 0;
  const expired = !!code && remaining <= 0;

  // Keyed on `open` only: one fresh single-use code per opening, not per re-render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (open) {
      known.current = knownIds;
      create.mutate();
    } else {
      create.reset();
      setQr(null);
    }
  }, [open]);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    QRCode.toDataURL(code.pairingUri, { margin: 1, width: 240, errorCorrectionLevel: "M" })
      .then((url) => !cancelled && setQr(url))
      .catch(() => !cancelled && setQr(null));
    return () => {
      cancelled = true;
    };
  }, [code]);

  // While the dialog is open, poll the device list so the user sees the pairing succeed.
  useEffect(() => {
    if (!open || !code || expired) return;
    const id = window.setInterval(() => void qc.invalidateQueries({ queryKey: qk.devices }), 3000);
    return () => window.clearInterval(id);
  }, [open, code, expired, qc]);
  const paired = open ? (devices.data ?? []).find((d) => !known.current.includes(d.id)) : undefined;

  const serverUrl = typeof window !== "undefined" ? window.location.origin : "";
  const copy = async (text: string) => {
    const ok = await copyText(text);
    toast.show(ok ? t("common.copied") : t("common.copyFailed"), ok ? "success" : "error");
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("pair.title")} size="lg">
      {paired ? (
        <div className="pair-done">
          <DeviceIcon kind={paired.kind} size={32} />
          <h3>{t("pair.paired", { name: paired.name })}</h3>
          <p>{t("pair.pairedLead")}</p>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t("common.done")}
          </button>
        </div>
      ) : create.isPending ? (
        <Loading />
      ) : create.error ? (
        <ErrorNote error={create.error} onRetry={() => create.mutate()} />
      ) : code ? (
        <div className="pair">
          <div className="pair-code-box">
            <p className="eyebrow">{t("pair.code")}</p>
            <p className={expired ? "pair-code expired" : "pair-code"}>
              <span aria-hidden="true">{code.code}</span>
              {/* Spelled out so screen readers read characters, not a word. */}
              <span className="sr-only">{code.code.split("").join(" ")}</span>
            </p>
            <div className="row pair-code-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void copy(code.code)}
                disabled={expired}
              >
                <IconCopy size={14} /> {t("common.copy")}
              </button>
              {expired ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => create.mutate()}
                >
                  <IconRefresh size={14} /> {t("pair.newCode")}
                </button>
              ) : (
                <span className="pair-countdown" role="timer" aria-live="off">
                  {t("pair.expiresIn", { time: formatClock(remaining) })}
                </span>
              )}
            </div>
            <div className="countdown-bar" aria-hidden="true">
              <span
                style={{ width: `${Math.max(0, Math.min(100, (remaining / 600_000) * 100))}%` }}
              />
            </div>
            {expired && <p className="hint hint-warn">{t("pair.expired")}</p>}
            <div className={expired ? "qr qr-expired" : "qr"}>
              {qr ? (
                <img src={qr} width={200} height={200} alt={t("pair.qrAlt")} />
              ) : (
                <div className="qr-placeholder" />
              )}
            </div>
          </div>

          <div className="pair-howto">
            <div className="segmented" role="tablist" aria-label={t("pair.which")}>
              {(["extension", "iphone", "watch"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  role="tab"
                  aria-selected={client === c}
                  onClick={() => setClient(c)}
                >
                  <DeviceIcon
                    kind={
                      c === "extension"
                        ? "browser_extension"
                        : c === "iphone"
                          ? "iphone"
                          : "apple_watch"
                    }
                    size={16}
                  />
                  {t(
                    c === "extension"
                      ? "deviceKind.browser_extension"
                      : c === "iphone"
                        ? "deviceKind.iphone"
                        : "deviceKind.apple_watch",
                  )}
                </button>
              ))}
            </div>
            <div role="tabpanel" className="howto">
              {client === "extension" && (
                <ol className="steps">
                  <li>{t("pair.ext1")}</li>
                  <li>
                    {t("pair.ext2")}
                    <span className="copy-line">
                      <code>{serverUrl}</code>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => void copy(serverUrl)}
                        aria-label={t("pair.copyServer")}
                      >
                        <IconCopy size={14} />
                      </button>
                    </span>
                  </li>
                  <li>{t("pair.ext3")}</li>
                </ol>
              )}
              {client === "iphone" && (
                <ol className="steps">
                  <li>{t("pair.ios1")}</li>
                  <li>{t("pair.ios2")}</li>
                  <li>{t("pair.ios3")}</li>
                </ol>
              )}
              {client === "watch" && (
                <ol className="steps">
                  <li>{t("pair.watch1")}</li>
                  <li>{t("pair.watch2")}</li>
                  <li>{t("pair.watch3")}</li>
                </ol>
              )}
            </div>
            <p className="hint">
              {t("pair.singleUse", {
                time: new Date(code.expiresAt).toLocaleTimeString(
                  locale === "tr" ? "tr-TR" : "en-GB",
                  { hour: "2-digit", minute: "2-digit" },
                ),
              })}
            </p>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

export function DevicesPage() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const devices = useDevices();
  const [params, setParams] = useSearchParams();
  const pairing = params.get("pair") === "1";
  const setPairing = (v: boolean) => setParams(v ? { pair: "1" } : {}, { replace: true });
  const [editing, setEditing] = useState<Device | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);

  const revoke = useMutation({
    mutationFn: (d: Device) => api.revokeDevice(d.id),
    onSuccess: (_r, d) => {
      qc.setQueryData<Device[]>(qk.devices, (ds) => ds?.filter((x) => x.id !== d.id));
      setRevoking(null);
      toast.show(t("devices.revoked", { name: d.name }), "success");
    },
  });

  const list = devices.data ?? [];

  return (
    <div className="page">
      <PageHeader
        title={t("devices.title")}
        lead={t("devices.lead")}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setPairing(true)}>
            <IconPlus size={16} /> {t("devices.pair")}
          </button>
        }
      />

      {devices.isPending ? (
        <Loading />
      ) : devices.error ? (
        <ErrorNote error={devices.error} onRetry={() => void devices.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState title={t("devices.emptyTitle")} icon={<IconDevices size={28} />}>
          <p>{t("devices.emptyLead")}</p>
          <button type="button" className="btn btn-primary" onClick={() => setPairing(true)}>
            {t("devices.pair")}
          </button>
        </EmptyState>
      ) : (
        <ul className="device-grid">
          {list.map((d) => (
            <li key={d.id} className="card device">
              <div className="device-top">
                <span className="device-icon">
                  <DeviceIcon kind={d.kind} size={22} />
                </span>
                <div className="device-name">
                  <h2>{d.name}</h2>
                  <p className="muted">
                    {t(DEVICE_KIND_KEY[d.kind])}
                    {d.platform && ` · ${d.platform}`}
                  </p>
                </div>
                <span className={d.online ? "online on" : "online"}>
                  <span className="online-dot" aria-hidden="true" />
                  {d.online ? t("devices.online") : t("devices.offline")}
                </span>
              </div>
              <dl className="device-facts">
                <div>
                  <dt>{t("devices.lastSeen")}</dt>
                  <dd>
                    {d.online
                      ? t("devices.now")
                      : d.lastSeenAt
                        ? formatRelative(Date.parse(d.lastSeenAt), locale)
                        : t("devices.never")}
                  </dd>
                </div>
                <div>
                  <dt>{t("devices.version")}</dt>
                  <dd>{d.appVersion ?? "—"}</dd>
                </div>
                <div>
                  <dt>{t("devices.priority")}</dt>
                  <dd>{d.priority === null ? t("devices.priorityAuto") : d.priority}</dd>
                </div>
              </dl>
              <div className="row device-actions">
                <button type="button" className="btn btn-sm" onClick={() => setEditing(d)}>
                  <IconEdit size={14} /> {t("devices.edit")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger-quiet"
                  onClick={() => setRevoking(d)}
                >
                  <IconTrash size={14} /> {t("devices.revoke")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <aside className="note note-plain merge-explain">
        <h2>{t("devices.mergeTitle")}</h2>
        <p>{t("devices.priorityExplain")}</p>
      </aside>

      <DeviceDialog device={editing} onClose={() => setEditing(null)} />
      <PairDialog
        open={pairing}
        onClose={() => setPairing(false)}
        knownIds={list.map((d) => d.id)}
      />
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        busy={revoke.isPending}
        danger
        title={t("devices.revokeTitle", { name: revoking?.name ?? "" })}
        body={t("devices.revokeBody")}
        confirmLabel={t("devices.revoke")}
      />
    </div>
  );
}
