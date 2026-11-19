import {
  type Me,
  PROVIDER_KINDS_BY_ROLE,
  type ProviderCatalog,
  type ProviderConfig,
  type ProviderConfigInput,
  type ProviderKind,
  type ProviderRole,
  type Settings,
} from "@ltm/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api/client";
import { qk, useCatalog, useSettings } from "../../api/queries";
import { IconCheck, IconCloud, IconHome, IconX } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { ErrorNote, Loading } from "../../components/ui";
import { type MessageKey, useI18n } from "../../i18n";
import { PROVIDER_KIND_KEY, PROVIDER_ROLE_KEY } from "../../lib/labels";

const ROLES: ProviderRole[] = ["llm", "stt", "embedding"];

const ROLE_DESC: Record<ProviderRole, MessageKey> = {
  llm: "providers.llmDesc",
  stt: "providers.sttDesc",
  embedding: "providers.embeddingDesc",
};

const KIND_DESC: Record<ProviderKind, MessageKey> = {
  none: "providerDesc.none",
  anthropic: "providerDesc.anthropic",
  openai: "providerDesc.openai",
  openai_compatible: "providerDesc.openai_compatible",
  claude_code_cli: "providerDesc.claude_code_cli",
  codex_cli: "providerDesc.codex_cli",
};

const CLI_KINDS: readonly ProviderKind[] = ["claude_code_cli", "codex_cli"];

export function ThirdPartyBadge({ thirdParty }: { thirdParty: boolean }) {
  const { t } = useI18n();
  return thirdParty ? (
    <span className="chip chip-third">
      <IconCloud size={14} /> {t("providers.thirdParty")}
    </span>
  ) : (
    <span className="chip chip-local">
      <IconHome size={14} /> {t("providers.local")}
    </span>
  );
}

function catalogEntry(catalog: ProviderCatalog, kind: ProviderKind, role: ProviderRole) {
  return catalog.entries.find((e) => e.kind === kind && e.roles.includes(role));
}

type KeyAction = "keep" | "replace" | "remove";

export function ProviderForm({
  role,
  config,
  catalog,
}: {
  role: ProviderRole;
  config: ProviderConfig;
  catalog: ProviderCatalog;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [kind, setKind] = useState<ProviderKind>(config.kind);
  const [model, setModel] = useState(config.model ?? "");
  const [baseUrl, setBaseUrl] = useState(config.baseUrl ?? "");
  const [keyAction, setKeyAction] = useState<KeyAction>(config.hasApiKey ? "keep" : "replace");
  // The key only ever lives in this input's state until it is sent; it is never read back.
  const [newKey, setNewKey] = useState("");
  const base = useId();
  const ids = {
    model: `${base}-model`,
    url: `${base}-url`,
    key: `${base}-key`,
    keyHint: `${base}-keyhint`,
  };

  const reset = (c: ProviderConfig) => {
    setKind(c.kind);
    setModel(c.model ?? "");
    setBaseUrl(c.baseUrl ?? "");
    setKeyAction(c.hasApiKey ? "keep" : "replace");
    setNewKey("");
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reset` only calls state setters
  useEffect(() => reset(config), [config]);

  const entry = kind === "none" ? undefined : catalogEntry(catalog, kind, role);
  const needsKey = entry?.needsApiKey ?? false;
  const showKey = kind !== "none" && (needsKey || kind === "openai_compatible");
  const showUrl = kind !== "none" && (entry?.needsBaseUrl || kind === "openai_compatible");
  const kindChanged = kind !== config.kind;
  // A key saved for one vendor must never be sent to another one after a kind switch.
  const effectiveKeyAction: KeyAction =
    kindChanged && config.hasApiKey ? (newKey ? "replace" : "remove") : keyAction;
  const keySaved = config.hasApiKey && !kindChanged && keyAction === "keep";
  const thirdParty = kind === "none" ? false : (entry?.thirdParty ?? false);
  const urlInvalid = showUrl && baseUrl.trim() !== "" && !URL.canParse(baseUrl.trim());
  // A new kind that needs a key must get one; deliberately removing a stored key is allowed.
  const keyMissing = needsKey && !newKey && (kindChanged || !config.hasApiKey);

  const dirty =
    kindChanged ||
    (model.trim() || null) !== config.model ||
    (showUrl ? baseUrl.trim() || null : config.baseUrl) !== config.baseUrl ||
    (keyAction === "replace" && newKey !== "") ||
    keyAction === "remove";

  const save = useMutation({
    meta: { inline: true },
    mutationFn: () => {
      const body: ProviderConfigInput = {
        kind,
        model: kind === "none" ? null : model.trim() || null,
        baseUrl: showUrl ? baseUrl.trim() || null : null,
      };
      if (effectiveKeyAction === "replace" && newKey) body.apiKey = newKey;
      else if (effectiveKeyAction === "remove") body.apiKey = null;
      return api.putProvider(role, body);
    },
    onSuccess: async (saved) => {
      qc.setQueryData<Settings>(qk.settings, (s) =>
        s ? { ...s, providers: { ...s.providers, [role]: saved } } : s,
      );
      // Explicit reset: when only the key changed, structural sharing keeps the cached config
      // object identical, so the effect on `config` would not fire.
      reset(saved);
      toast.show(t("providers.saved", { role: t(PROVIDER_ROLE_KEY[role]) }), "success");
      // Configuring (or dropping) a third-party provider changes which consents are required.
      const me = await qc.fetchQuery<Me>({ queryKey: qk.me, queryFn: api.me, staleTime: 0 });
      if (saved.thirdParty && !me.consent.satisfied) {
        navigate("/consent", { state: { from: "/settings/providers" } });
      }
    },
  });
  const test = useMutation({ meta: { inline: true }, mutationFn: () => api.testProvider(role) });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!urlInvalid) save.mutate();
  };

  const presets = catalog.presets.filter((p) => p.role === role);
  const kinds = PROVIDER_KINDS_BY_ROLE[role];

  return (
    <form className="stack" onSubmit={onSubmit}>
      <fieldset className="kind-grid">
        <legend className="sr-only">{t("providers.kind")}</legend>
        {kinds.map((k) => {
          const e = k === "none" ? undefined : catalogEntry(catalog, k, role);
          const available = k === "none" || (e?.available ?? false);
          const reason = k === "none" ? null : e ? e.unavailableReason : t("providers.notOffered");
          return (
            <label
              key={k}
              className={`kind-option ${kind === k ? "on" : ""} ${available ? "" : "disabled"}`}
            >
              <input
                type="radio"
                name={`${base}-kind`}
                value={k}
                checked={kind === k}
                disabled={!available && config.kind !== k}
                onChange={() => {
                  setKind(k);
                  test.reset();
                  if (k !== config.kind) setModel("");
                  else setModel(config.model ?? "");
                }}
              />
              <span className="kind-name">
                {t(PROVIDER_KIND_KEY[k])}
                {e && <ThirdPartyBadge thirdParty={e.thirdParty} />}
              </span>
              <span className="kind-desc">{t(KIND_DESC[k])}</span>
              {!available && reason && <span className="kind-reason">{reason}</span>}
            </label>
          );
        })}
      </fieldset>

      {presets.length > 0 && (
        <div className="presets">
          <span className="presets-label">{t("providers.presets")}</span>
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setKind("openai_compatible");
                setBaseUrl(p.baseUrl);
                setModel(p.model);
                test.reset();
              }}
              title={`${p.baseUrl} · ${p.model}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {CLI_KINDS.includes(kind) && (
        <div className="note note-plain">
          <p>{kind === "claude_code_cli" ? t("providers.cliClaude") : t("providers.cliCodex")}</p>
          <p className="hint">{t("providers.cliOwnerOnly")}</p>
        </div>
      )}

      {kind !== "none" && (
        <div className="note note-plain privacy-line">
          <ThirdPartyBadge thirdParty={thirdParty} />
          <span>{thirdParty ? t("providers.thirdPartyExplain") : t("providers.localExplain")}</span>
        </div>
      )}

      {kind !== "none" && (
        <div className="grid-2">
          <div className="field">
            <label htmlFor={ids.model}>{t("providers.model")}</label>
            <input
              id={ids.model}
              value={model}
              maxLength={200}
              onChange={(e) => setModel(e.target.value)}
              placeholder={entry?.defaultModels?.[role] ?? ""}
              spellCheck={false}
              autoComplete="off"
            />
            <p className="hint">
              {entry?.defaultModels?.[role]
                ? t("providers.modelDefault", { model: entry.defaultModels[role] })
                : t("providers.modelHint")}
            </p>
          </div>
          {showUrl && (
            <div className="field">
              <label htmlFor={ids.url}>{t("providers.baseUrl")}</label>
              <input
                id={ids.url}
                type="url"
                value={baseUrl}
                maxLength={500}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={urlInvalid || undefined}
              />
              <p className={urlInvalid ? "hint hint-warn" : "hint"}>
                {urlInvalid ? t("providers.baseUrlInvalid") : t("providers.baseUrlHint")}
              </p>
            </div>
          )}
        </div>
      )}

      {showKey && (
        <div className="field key-field">
          <label htmlFor={ids.key}>
            {t("providers.apiKey")}{" "}
            {!needsKey && <span className="muted">({t("common.optional")})</span>}
          </label>
          {keySaved ? (
            <div className="key-saved">
              <span className="chip chip-ok">
                <IconCheck size={14} /> {t("providers.keySaved")}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setKeyAction("replace")}>
                {t("providers.keyReplace")}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger-quiet"
                onClick={() => setKeyAction("remove")}
              >
                {t("providers.keyRemove")}
              </button>
            </div>
          ) : keyAction === "remove" && !kindChanged ? (
            <div className="key-saved">
              <span className="chip chip-warn">
                <IconX size={14} /> {t("providers.keyWillRemove")}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setKeyAction("keep")}>
                {t("common.undo")}
              </button>
            </div>
          ) : (
            <>
              <input
                id={ids.key}
                type="password"
                value={newKey}
                maxLength={1000}
                onChange={(e) => setNewKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={ids.keyHint}
                placeholder={
                  config.hasApiKey && !kindChanged ? t("providers.keyNewPlaceholder") : ""
                }
              />
              <div className="row">
                <p id={ids.keyHint} className="hint">
                  {kindChanged && config.hasApiKey
                    ? t("providers.keySwitchHint")
                    : t("providers.keyHint")}
                </p>
                {config.hasApiKey && !kindChanged && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setNewKey("");
                      setKeyAction("keep");
                    }}
                  >
                    {t("providers.keyKeep")}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {save.error && <ErrorNote error={save.error} />}
      {test.data && (
        <div className={test.data.ok ? "note note-ok" : "note note-error"} role="status">
          <p>
            <strong>{test.data.ok ? t("providers.testOk") : t("providers.testFailed")}</strong>{" "}
            {test.data.message}
            {test.data.latencyMs !== null &&
              ` · ${t("providers.latency", { ms: Math.round(test.data.latencyMs) })}`}
          </p>
        </div>
      )}
      {test.error && <ErrorNote error={test.error} />}

      <div className="row form-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!dirty || save.isPending || urlInvalid || keyMissing}
        >
          {save.isPending ? t("common.working") : t("common.save")}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => test.mutate()}
          disabled={dirty || config.kind === "none" || test.isPending}
          title={dirty ? t("providers.testSaveFirst") : undefined}
        >
          {test.isPending ? t("providers.testing") : t("providers.test")}
        </button>
        {dirty && (
          <button type="button" className="btn btn-ghost" onClick={() => reset(config)}>
            {t("common.discard")}
          </button>
        )}
        {dirty && <span className="hint">{t("providers.testSaveFirst")}</span>}
      </div>
    </form>
  );
}

const ORIGIN_KEY: Record<ProviderConfig["origin"], MessageKey> = {
  user: "providers.originUser",
  instance_default: "providers.originDefault",
  unset: "providers.originUnset",
};

export function ProvidersSettings() {
  const { t } = useI18n();
  const settings = useSettings();
  const catalog = useCatalog();
  if (settings.isPending || catalog.isPending) return <Loading />;
  if (settings.error)
    return <ErrorNote error={settings.error} onRetry={() => void settings.refetch()} />;
  if (catalog.error)
    return <ErrorNote error={catalog.error} onRetry={() => void catalog.refetch()} />;
  return (
    <div className="stack-lg">
      <p className="lead">{t("providers.lead")}</p>
      {ROLES.map((role) => {
        const config = settings.data.providers[role];
        const titleId = `provider-${role}-title`;
        return (
          <section key={role} className="card provider-card" aria-labelledby={titleId}>
            <header className="provider-head">
              <div>
                <h2 id={titleId}>{t(PROVIDER_ROLE_KEY[role])}</h2>
                <p className="muted">{t(ROLE_DESC[role])}</p>
              </div>
              <div className="provider-current">
                <span className="muted">{t(ORIGIN_KEY[config.origin])}</span>
                <strong>{t(PROVIDER_KIND_KEY[config.kind])}</strong>
                {config.kind !== "none" && <ThirdPartyBadge thirdParty={config.thirdParty} />}
              </div>
            </header>
            <ProviderForm role={role} config={config} catalog={catalog.data} />
          </section>
        );
      })}
    </div>
  );
}
