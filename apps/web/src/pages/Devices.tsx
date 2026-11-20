import { type Device, type DeviceAccess, type PairingCode, SOURCE_PRIORITY } from "@ltm/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api/client";
import { qk, useDevices } from "../api/queries";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import {
  DeviceIcon,
  IconAgent,
  IconCopy,
  IconDevices,
  IconEdit,
  IconMic,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "../components/Icons";
import { ListenControl } from "../components/ListenControl";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorNote, Loading, PageHeader } from "../components/ui";
import { type MessageKey, useI18n } from "../i18n";
import { formatClock } from "../lib/format";
import { copyText, useNow } from "../lib/hooks";
import { DEVICE_KIND_KEY, SOURCE_KEY } from "../lib/labels";
import {
  agentCommand,
  defaultAccess,
  needsCode,
  PAIR_TARGETS,
  type PairTarget,
  TARGET_KIND,
} from "../lib/pairing";
import { useFmt } from "../lib/useFmt";

function DeviceDialog({ device, onClose }: { device: Device | null; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [auto, setAuto] = useState(true);
  const [priority, setPriority] = useState(50);
  const [access, setAccess] = useState<DeviceAccess>("capture");
  const ids = { name: useId(), prio: useId(), explain: useId(), access: useId() };

  useEffect(() => {
    if (!device) return;
    setName(device.name);
    setAuto(device.priority === null);
    setPriority(device.priority ?? 50);
    setAccess(device.access);
  }, [device]);

  const save = useMutation({
    meta: { inline: true },
    mutationFn: () =>
      api.updateDevice(device!.id, {
        name: name.trim(),
        priority: auto ? null : priority,
        access,
      }),
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
        <fieldset className="field">
          <legend>{t("devices.access")}</legend>
          <label className="check-row">
            <input
              type="radio"
              name="access"
              checked={access === "capture"}
              onChange={() => setAccess("capture")}
            />
            <span>
              <strong>{t("devices.accessCapture")}</strong>
              <span className="hint block">{t("pair.memoryOff")}</span>
            </span>
          </label>
          <label className="check-row">
            <input
              type="radio"
              name="access"
              checked={access === "memory"}
              onChange={() => setAccess("memory")}
            />
            <span>
              <strong>{t("devices.accessMemory")}</strong>
              <span className="hint block">{t("pair.memoryOn")}</span>
            </span>
          </label>
        </fieldset>
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

const TARGET_LABEL: Record<PairTarget, MessageKey> = {
  extension: "pair.targetExtension",
  iphone: "pair.targetIphone",
  watch: "pair.targetWatch",
  agent: "pair.targetAgent",
  browser: "pair.targetBrowser",
};

function TargetIcon({ target, size }: { target: PairTarget; size?: number }) {
  return target === "agent" ? (
    <IconAgent size={size} />
  ) : (
    <DeviceIcon kind={TARGET_KIND[target]} size={size} />
  );
}

function PairDialog({
  open,
  onClose,
  onListen,
}: {
  open: boolean;
  onClose: () => void;
  onListen: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFmt();
  const toast = useToast();
  const qc = useQueryClient();
  const [target, setTarget] = useState<PairTarget>("extension");
  const [access, setAccess] = useState<DeviceAccess>(defaultAccess("extension"));
  const [qr, setQr] = useState<string | null>(null);
  const now = useNow(1000, open);
  const devices = useDevices();
  // Devices that existed when the dialog opened; anything new afterwards was just paired.
  // Taken once the list has loaded — the dialog can open from a link before it has.
  const [baseline, setBaseline] = useState<string[] | null>(null);
  useEffect(() => {
    if (open && baseline === null && devices.data) setBaseline(devices.data.map((d) => d.id));
  }, [open, baseline, devices.data]);
  const accessId = useId();
  const accessHintId = useId();

  const create = useMutation({
    meta: { inline: true },
    mutationFn: (a: DeviceAccess) => api.createPairingCode({ access: a }),
  });
  const code: PairingCode | undefined = create.data;
  const remaining = code ? Date.parse(code.expiresAt) - now : 0;
  const expired = !!code && remaining <= 0;
  const withCode = needsCode(target);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset once per opening
  useEffect(() => {
    if (!open) {
      setBaseline(null);
      create.reset();
      setQr(null);
      setTarget("extension");
      setAccess(defaultAccess("extension"));
    }
  }, [open]);

  // A code carries its access level, so a different choice needs a fresh code.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `create` is stable enough; keyed on the inputs
  useEffect(() => {
    if (!open || !withCode || create.isPending) return;
    if (!code || code.access !== access) create.mutate(access);
  }, [open, withCode, access, code]);

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
  const paired =
    open && baseline ? (devices.data ?? []).find((d) => !baseline.includes(d.id)) : undefined;

  const serverUrl = typeof window !== "undefined" ? window.location.origin : "";
  const copy = async (text: string) => {
    const ok = await copyText(text);
    toast.show(ok ? t("common.copied") : t("common.copyFailed"), ok ? "success" : "error");
  };
  const copyLine = (text: string, label: string) => (
    <span className="copy-line">
      <code>{text}</code>
      <button type="button" className="icon-btn" onClick={() => void copy(text)} aria-label={label}>
        <IconCopy size={14} />
      </button>
    </span>
  );

  const codePanel = create.isPending ? (
    <Loading />
  ) : create.error ? (
    <ErrorNote error={create.error} onRetry={() => create.mutate(access)} />
  ) : code ? (
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
            onClick={() => create.mutate(access)}
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
        <span style={{ width: `${Math.max(0, Math.min(100, (remaining / 600_000) * 100))}%` }} />
      </div>
      {expired && <p className="hint hint-warn">{t("pair.expired")}</p>}
      {target === "iphone" && (
        <div className={expired ? "qr qr-expired" : "qr"}>
          {qr ? (
            <img src={qr} width={200} height={200} alt={t("pair.qrAlt")} />
          ) : (
            <div className="qr-placeholder" />
          )}
        </div>
      )}
      <p className="hint">{t("pair.singleUse", { time: fmt.time(Date.parse(code.expiresAt)) })}</p>
    </div>
  ) : null;

  return (
    <Dialog open={open} onClose={onClose} title={t("pair.title")} size="lg">
      {paired ? (
        <div className="pair-done">
          <DeviceIcon kind={paired.kind} size={32} />
          <h3>{t("pair.paired", { name: paired.name })}</h3>
          <p>{paired.access === "memory" ? t("pair.pairedLeadMemory") : t("pair.pairedLead")}</p>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t("common.done")}
          </button>
        </div>
      ) : (
        <div className="stack">
          <fieldset className="target-grid">
            <legend>{t("pair.which")}</legend>
            {PAIR_TARGETS.map((x) => (
              <label key={x} className={`target-option ${target === x ? "on" : ""}`}>
                <input
                  type="radio"
                  name="pair-target"
                  checked={target === x}
                  onChange={() => {
                    setTarget(x);
                    setAccess(defaultAccess(x));
                  }}
                />
                <TargetIcon target={x} size={20} />
                <span>{t(TARGET_LABEL[x])}</span>
              </label>
            ))}
          </fieldset>

          {withCode && (
            <div className="access-choice">
              <label className="check-row" htmlFor={accessId}>
                <input
                  id={accessId}
                  type="checkbox"
                  checked={access === "memory"}
                  onChange={(e) => setAccess(e.target.checked ? "memory" : "capture")}
                  aria-describedby={accessHintId}
                />
                <span>
                  <strong>{t("pair.memoryOption")}</strong>
                  <span id={accessHintId} className="hint block">
                    {access === "memory" ? t("pair.memoryOn") : t("pair.memoryOff")}
                  </span>
                </span>
              </label>
            </div>
          )}

          <div className={withCode ? "pair" : "pair pair-nocode"}>
            {withCode && codePanel}
            <div className="pair-howto howto" aria-live="polite">
              {target === "extension" && (
                <ol className="steps">
                  <li>{t("pair.ext1")}</li>
                  <li>
                    {t("pair.ext2")}
                    {copyLine(serverUrl, t("pair.copyServer"))}
                  </li>
                  <li>{t("pair.ext3")}</li>
                </ol>
              )}
              {target === "iphone" && (
                <ol className="steps">
                  <li>{t("pair.ios1")}</li>
                  <li>{t("pair.ios2")}</li>
                  <li>{t("pair.ios3")}</li>
                </ol>
              )}
              {target === "watch" && (
                <ol className="steps">
                  <li>{t("pair.watch1")}</li>
                  <li>{t("pair.watch2")}</li>
                  <li>{t("pair.watch3")}</li>
                </ol>
              )}
              {target === "agent" && (
                <ol className="steps">
                  <li>{t("pair.agent1")}</li>
                  <li>
                    {t("pair.agent2")}
                    {code && !expired
                      ? copyLine(agentCommand(serverUrl, code.code), t("pair.copyCommand"))
                      : null}
                  </li>
                  <li>{t("pair.agent3")}</li>
                </ol>
              )}
              {target === "browser" && (
                <div className="stack-sm">
                  <p>{t("pair.browser1")}</p>
                  <p className="hint">{t("pair.browser2")}</p>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        onClose();
                        onListen();
                      }}
                    >
                      <IconMic size={16} /> {t("listen.action")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function DevicesPage() {
  const { t } = useI18n();
  const fmt = useFmt();
  const qc = useQueryClient();
  const toast = useToast();
  const devices = useDevices();
  const [params, setParams] = useSearchParams();
  const pairing = params.get("pair") === "1";
  const setPairing = (v: boolean) => setParams(v ? { pair: "1" } : {}, { replace: true });
  const listenRequested = params.get("listen") === "1";
  const startListen = () => setParams({ listen: "1" }, { replace: true });
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

      <ListenControl variant="panel" autoStart={listenRequested} />

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
                        ? fmt.relative(Date.parse(d.lastSeenAt))
                        : t("devices.never")}
                  </dd>
                </div>
                <div>
                  <dt>{t("devices.version")}</dt>
                  <dd>{d.appVersion ?? "—"}</dd>
                </div>
                <div>
                  <dt>{t("devices.access")}</dt>
                  <dd>
                    <span className={d.access === "memory" ? "chip chip-task" : "chip chip-quiet"}>
                      {d.access === "memory"
                        ? t("devices.accessMemoryShort")
                        : t("devices.accessCaptureShort")}
                    </span>
                  </dd>
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
      <PairDialog open={pairing} onClose={() => setPairing(false)} onListen={startListen} />
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
