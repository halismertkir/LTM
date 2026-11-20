import {
  type PipelineSettings,
  PROVIDER_KINDS_BY_ROLE,
  type PrivacySettings,
  type ProviderCatalog,
  type ProviderConfig,
  type ProviderKind,
  type ProviderTestResult,
  ROUTES,
  type Settings,
  zPipelineSettings,
  zPrivacySettings,
  zProviderConfigInput,
  zProviderRole,
} from "@ltm/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Ctx } from "../../context.js";
import { one } from "../../db/types.js";
import { badRequest, forbidden } from "../../errors.js";
import { savePrivacy } from "../../services/capture.js";
import { enforceIngestGate } from "../../services/consent.js";
import { relocalizeDays, scheduleMissingDigests } from "../../services/days.js";
import { scheduleEmbed } from "../../services/memories.js";
import {
  apiKeyAad,
  CLI_KINDS,
  effectiveProviders,
  getPipeline,
  getPrivacy,
  providerConfigDto,
  putPipeline,
  resolvedConfig,
} from "../../services/settings.js";
import { canonicalTimeZone } from "../../time.js";
import { parse, sessionUser } from "../plumbing.js";

/** Kinds that cannot work without a key of their own. */
const NEEDS_KEY: readonly ProviderKind[] = ["anthropic", "openai"];

export async function settingsRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get(ROUTES.settings, async (req): Promise<Settings> => {
    const { user } = sessionUser(req);
    const eff = await effectiveProviders(ctx, ctx.db, user);
    return {
      providers: {
        llm: providerConfigDto(eff.llm),
        stt: providerConfigDto(eff.stt),
        embedding: providerConfigDto(eff.embedding),
      },
      privacy: await getPrivacy(ctx.db, user.id),
      pipeline: await getPipeline(ctx.db, user.id),
    };
  });

  app.put(ROUTES.settingsProvider, async (req): Promise<ProviderConfig> => {
    const { user } = sessionUser(req);
    const { role } = parse(z.object({ role: zProviderRole }), req.params);
    const body = parse(zProviderConfigInput, req.body);
    if (!PROVIDER_KINDS_BY_ROLE[role].includes(body.kind)) {
      throw badRequest(`"${body.kind}" cannot serve the ${role} role.`, {
        allowed: PROVIDER_KINDS_BY_ROLE[role],
      });
    }
    if (CLI_KINDS.includes(body.kind)) {
      if (!ctx.config.allowCliProviders)
        throw forbidden("CLI providers are disabled on this server.");
      if (user.role !== "owner")
        throw forbidden("CLI providers are only available to the owner of this server.");
    }
    if (body.kind === "openai_compatible" && !body.baseUrl)
      throw badRequest("openai_compatible needs a baseUrl.");

    const existing = await one<{ kind: ProviderKind; api_key_enc: string | null }>(
      ctx.db,
      "SELECT kind, api_key_enc FROM provider_settings WHERE user_id = $1 AND role = $2",
      [user.id, role],
    );
    let sealed: string | null;
    if (body.apiKey === null || body.kind === "none") sealed = null;
    else if (typeof body.apiKey === "string")
      sealed = ctx.secrets.seal(body.apiKey, apiKeyAad(user.id, role));
    // Omitted: keep the stored key, but never carry a key over to a different vendor.
    else sealed = existing && existing.kind === body.kind ? existing.api_key_enc : null;
    if (NEEDS_KEY.includes(body.kind) && !sealed) throw badRequest(`${body.kind} needs an apiKey.`);

    await ctx.db.query(
      `INSERT INTO provider_settings (user_id, role, kind, model, base_url, api_key_enc, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, role) DO UPDATE SET kind = EXCLUDED.kind, model = EXCLUDED.model, base_url = EXCLUDED.base_url,
         api_key_enc = EXCLUDED.api_key_enc, updated_at = EXCLUDED.updated_at`,
      [
        user.id,
        role,
        body.kind,
        body.model?.trim() || null,
        body.kind === "none" ? null : (body.baseUrl ?? null),
        sealed,
        ctx.clock.now(),
      ],
    );
    req.log.info({ userId: user.id, role, kind: body.kind }, "provider settings saved");

    // A third-party kind may now require the third_party_ai consent.
    await enforceIngestGate(ctx, user);
    const eff = await effectiveProviders(ctx, ctx.db, user);
    if (role === "stt" && eff.stt.usable) await ctx.jobs.unpark(ctx.db, user.id, "transcribe");
    if (role === "embedding" && eff.embedding.usable) await scheduleEmbed(ctx, ctx.db, user.id);
    return providerConfigDto(eff[role]);
  });

  app.post(ROUTES.settingsProviderTest, async (req): Promise<ProviderTestResult> => {
    const { user } = sessionUser(req);
    const { role } = parse(z.object({ role: zProviderRole }), req.params);
    const eff = (await effectiveProviders(ctx, ctx.db, user))[role];
    if (eff.kind === "none")
      return { ok: false, message: "No provider is configured for this role.", latencyMs: null };
    if (!eff.usable)
      return {
        ok: false,
        message: "This provider is not available to your account.",
        latencyMs: null,
      };
    let cfg: ReturnType<typeof resolvedConfig>;
    try {
      cfg = resolvedConfig(ctx, user.id, eff);
    } catch {
      return {
        ok: false,
        message:
          "The stored API key cannot be decrypted (was the server secret changed?). Save the key again.",
        latencyMs: null,
      };
    }
    return ctx.providers.probe(cfg);
  });

  app.put(ROUTES.settingsPrivacy, async (req): Promise<PrivacySettings> => {
    const { user } = sessionUser(req);
    const body = parse(zPrivacySettings, req.body);
    const saved = await savePrivacy(ctx, user, body);
    // Turning retention off (or shortening it) takes effect now, not at the next hourly run.
    await ctx.jobs.enqueue(ctx.db, { kind: "retention", userId: null, dedupeKey: "retention" });
    return saved;
  });

  app.put(ROUTES.settingsPipeline, async (req): Promise<PipelineSettings> => {
    const { user } = sessionUser(req);
    const body = parse(zPipelineSettings, req.body);
    const timeZone = canonicalTimeZone(body.timeZone);
    if (!timeZone) throw badRequest(`Unknown time zone "${body.timeZone}".`, { path: "timeZone" });
    const before = await getPipeline(ctx.db, user.id);
    await putPipeline(ctx, ctx.db, user.id, { ...body, timeZone });
    if (before.timeZone !== timeZone) await relocalizeDays(ctx, user.id, timeZone);
    else if (!before.dailyDigest && body.dailyDigest) await scheduleMissingDigests(ctx, user.id);
    return getPipeline(ctx.db, user.id);
  });

  app.get(ROUTES.providerCatalog, async (req): Promise<ProviderCatalog> => {
    const { user } = sessionUser(req);
    const allowCli = ctx.config.allowCliProviders && user.role === "owner";
    const catalog = await ctx.providers.catalog({ allowCli });
    if (allowCli) return catalog;
    return {
      ...catalog,
      entries: catalog.entries.map((e) =>
        CLI_KINDS.includes(e.kind)
          ? {
              ...e,
              available: false,
              unavailableReason: ctx.config.allowCliProviders
                ? "Only the owner of this server can use CLI subscriptions."
                : "CLI providers are disabled on this server.",
            }
          : e,
      ),
    };
  });
}
