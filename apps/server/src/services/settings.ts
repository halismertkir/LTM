import {
  type PipelineSettings,
  type PrivacySettings,
  type ProviderConfig,
  type ProviderKind,
  type ProviderRole,
  THIRD_PARTY_PROVIDER_KINDS,
  zPipelineSettings,
  zPrivacySettings,
} from "@ltm/protocol";
import type {
  EmbeddingProvider,
  LlmProvider,
  ResolvedProviderConfig,
  SttProvider,
} from "@ltm/providers";
import type { Ctx } from "../context.js";
import { json, one, type Queryable } from "../db/types.js";

export const DEFAULT_PRIVACY: PrivacySettings = {
  ingestPaused: false,
  retainAudio: false,
  audioRetentionDays: null,
  dataRetentionDays: null,
};

export const DEFAULT_PIPELINE: PipelineSettings = {
  language: null,
  conversationGapMinutes: 5,
  extractMemories: true,
};

export const ROLES: readonly ProviderRole[] = ["llm", "stt", "embedding"];
export const CLI_KINDS: readonly ProviderKind[] = ["claude_code_cli", "codex_cli"];

interface SettingsRow {
  privacy: unknown;
  pipeline: unknown;
}

async function settingsRow(q: Queryable, userId: string): Promise<SettingsRow | null> {
  return one<SettingsRow>(q, "SELECT privacy, pipeline FROM user_settings WHERE user_id = $1", [
    userId,
  ]);
}

export async function getPrivacy(q: Queryable, userId: string): Promise<PrivacySettings> {
  const row = await settingsRow(q, userId);
  const parsed = zPrivacySettings.safeParse({ ...DEFAULT_PRIVACY, ...(row?.privacy as object) });
  return parsed.success ? parsed.data : { ...DEFAULT_PRIVACY };
}

export async function getPipeline(q: Queryable, userId: string): Promise<PipelineSettings> {
  const row = await settingsRow(q, userId);
  const parsed = zPipelineSettings.safeParse({ ...DEFAULT_PIPELINE, ...(row?.pipeline as object) });
  return parsed.success ? parsed.data : { ...DEFAULT_PIPELINE };
}

export async function putPrivacy(
  ctx: Ctx,
  q: Queryable,
  userId: string,
  value: PrivacySettings,
): Promise<void> {
  await q.query(
    `INSERT INTO user_settings (user_id, privacy, pipeline, updated_at) VALUES ($1, $2::jsonb, $3::jsonb, $4)
     ON CONFLICT (user_id) DO UPDATE SET privacy = EXCLUDED.privacy, updated_at = EXCLUDED.updated_at`,
    [userId, json(value), json(DEFAULT_PIPELINE), ctx.clock.now()],
  );
}

export async function putPipeline(
  ctx: Ctx,
  q: Queryable,
  userId: string,
  value: PipelineSettings,
): Promise<void> {
  await q.query(
    `INSERT INTO user_settings (user_id, privacy, pipeline, updated_at) VALUES ($1, $2::jsonb, $3::jsonb, $4)
     ON CONFLICT (user_id) DO UPDATE SET pipeline = EXCLUDED.pipeline, updated_at = EXCLUDED.updated_at`,
    [userId, json(DEFAULT_PRIVACY), json(value), ctx.clock.now()],
  );
}

// ---------------------------------------------------------------------------- providers

interface ProviderRow {
  role: ProviderRole;
  kind: ProviderKind;
  model: string | null;
  base_url: string | null;
  api_key_enc: string | null;
}

export interface EffectiveProvider {
  role: ProviderRole;
  kind: ProviderKind;
  model: string | null;
  baseUrl: string | null;
  /** Decrypted lazily by `resolvedConfig`. */
  apiKeySealed: string | null;
  instanceApiKey: string | null;
  origin: ProviderConfig["origin"];
  /** False when the config exists but may not be used by this user (CLI kinds for non-owners / disabled). */
  usable: boolean;
}

export function apiKeyAad(userId: string, role: ProviderRole): string {
  return `provider-api-key:${userId}:${role}`;
}

export async function effectiveProviders(
  ctx: Ctx,
  q: Queryable,
  user: { id: string; role: "owner" | "member" },
): Promise<Record<ProviderRole, EffectiveProvider>> {
  const rows = await q.query<ProviderRow>(
    "SELECT role, kind, model, base_url, api_key_enc FROM provider_settings WHERE user_id = $1",
    [user.id],
  );
  const out = {} as Record<ProviderRole, EffectiveProvider>;
  for (const role of ROLES) {
    const row = rows.find((r) => r.role === role);
    const def = ctx.config.providerDefaults[role];
    let eff: EffectiveProvider;
    if (row) {
      eff = {
        role,
        kind: row.kind,
        model: row.model,
        baseUrl: row.base_url,
        apiKeySealed: row.api_key_enc,
        instanceApiKey: null,
        origin: "user",
        usable: true,
      };
    } else if (def) {
      eff = {
        role,
        kind: def.kind,
        model: def.model,
        baseUrl: def.baseUrl,
        apiKeySealed: null,
        instanceApiKey: def.apiKey,
        origin: "instance_default",
        usable: true,
      };
    } else {
      eff = {
        role,
        kind: "none",
        model: null,
        baseUrl: null,
        apiKeySealed: null,
        instanceApiKey: null,
        origin: "unset",
        usable: false,
      };
    }
    if (eff.kind === "none") eff.usable = false;
    // The CLI kinds run under the owner's personal subscription on the server host.
    if (CLI_KINDS.includes(eff.kind) && (!ctx.config.allowCliProviders || user.role !== "owner"))
      eff.usable = false;
    out[role] = eff;
  }
  return out;
}

export function providerConfigDto(e: EffectiveProvider): ProviderConfig {
  return {
    role: e.role,
    kind: e.kind,
    model: e.model,
    baseUrl: e.baseUrl,
    hasApiKey: e.origin === "user" ? e.apiKeySealed !== null : e.instanceApiKey !== null,
    origin: e.origin,
    thirdParty: THIRD_PARTY_PROVIDER_KINDS.includes(e.kind),
  };
}

export function resolvedConfig(
  ctx: Ctx,
  userId: string,
  e: EffectiveProvider,
): ResolvedProviderConfig {
  let apiKey: string | null = e.instanceApiKey;
  if (e.origin === "user" && e.apiKeySealed)
    apiKey = ctx.secrets.open(e.apiKeySealed, apiKeyAad(userId, e.role));
  return { role: e.role, kind: e.kind, model: e.model, baseUrl: e.baseUrl, apiKey };
}

export interface UserProviders {
  llm: LlmProvider | null;
  stt: SttProvider | null;
  embedding: EmbeddingProvider | null;
}

/** Instantiates the user's usable providers for the given roles (null when not configured). */
export async function resolveProviders(
  ctx: Ctx,
  user: { id: string; role: "owner" | "member" },
  roles: readonly ProviderRole[] = ROLES,
): Promise<UserProviders> {
  const eff = await effectiveProviders(ctx, ctx.db, user);
  const out: UserProviders = { llm: null, stt: null, embedding: null };
  for (const role of roles) {
    const e = eff[role];
    if (!e.usable) continue;
    const cfg = resolvedConfig(ctx, user.id, e);
    try {
      if (role === "llm") out.llm = ctx.providers.createLlm(cfg);
      else if (role === "stt") out.stt = ctx.providers.createStt(cfg);
      else out.embedding = ctx.providers.createEmbedding(cfg);
    } catch (err) {
      // A config the factory rejects outright (e.g. missing key) counts as "not configured".
      ctx.log.warn(
        { role, kind: e.kind, err: (err as Error).message },
        "provider could not be created",
      );
    }
  }
  return out;
}

/** Looks a user up by id and resolves providers (for jobs, which only know the id). */
export async function resolveProvidersForUser(
  ctx: Ctx,
  userId: string,
  roles: readonly ProviderRole[],
): Promise<UserProviders> {
  const user = await one<{ id: string; role: "owner" | "member" }>(
    ctx.db,
    "SELECT id, role FROM users WHERE id = $1",
    [userId],
  );
  if (!user) return { llm: null, stt: null, embedding: null };
  return resolveProviders(ctx, user, roles);
}
