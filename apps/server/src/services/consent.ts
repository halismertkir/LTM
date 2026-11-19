import {
  CONSENT_DOCUMENTS,
  type ConsentState,
  type ConsentType,
  requiredConsentDocuments,
} from "@ltm/protocol";
import { type Ctx, iso } from "../context.js";
import type { Queryable } from "../db/types.js";
import { effectiveProviders, getPrivacy, putPrivacy } from "./settings.js";

interface ConsentRow {
  type: ConsentType;
  version: string;
  accepted_at: number;
  via: string | null;
}

export async function consentState(
  ctx: Ctx,
  q: Queryable,
  user: { id: string; role: "owner" | "member" },
): Promise<ConsentState> {
  const eff = await effectiveProviders(ctx, q, user);
  // Configured kinds count even when not usable: the safe side is to ask for consent.
  const kinds = [eff.llm.kind, eff.stt.kind, eff.embedding.kind];
  const required = requiredConsentDocuments(kinds);
  const rows = await q.query<ConsentRow>(
    "SELECT type, version, accepted_at, via FROM consent_records WHERE user_id = $1 ORDER BY accepted_at",
    [user.id],
  );
  const reqs = required.map((d) => ({
    type: d.type,
    version: d.version,
    accepted: rows.some((r) => r.type === d.type && r.version === d.version),
  }));
  return {
    satisfied: reqs.every((r) => r.accepted),
    required: reqs,
    records: rows.map((r) => ({
      type: r.type,
      version: r.version,
      acceptedAt: iso(r.accepted_at),
      via: r.via,
    })),
  };
}

export function currentConsentVersion(type: ConsentType): string | null {
  return CONSENT_DOCUMENTS.find((d) => d.type === type)?.version ?? null;
}

export async function acceptConsents(
  ctx: Ctx,
  q: Queryable,
  userId: string,
  accept: { type: ConsentType; version: string }[],
  via: string,
): Promise<void> {
  const now = ctx.clock.now();
  for (const a of accept) {
    await q.query(
      `INSERT INTO consent_records (user_id, type, version, accepted_at, via) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, type, version) DO NOTHING`,
      [userId, a.type, a.version, now, via],
    );
  }
}

/** Withdrawal deletes the acceptance records and switches the kill switch on. */
export async function withdrawConsents(
  ctx: Ctx,
  q: Queryable,
  userId: string,
  types: ConsentType[],
): Promise<void> {
  await q.query("DELETE FROM consent_records WHERE user_id = $1 AND type = ANY($2::text[])", [
    userId,
    types,
  ]);
  const privacy = await getPrivacy(q, userId);
  if (!privacy.ingestPaused) await putPrivacy(ctx, q, userId, { ...privacy, ingestPaused: true });
}

export interface IngestRefusal {
  code: "consent_required" | "ingest_paused";
  message: string;
}

/** Why ingest is refused for this user right now, or null when it is allowed. */
export async function ingestRefusal(
  ctx: Ctx,
  q: Queryable,
  user: { id: string; role: "owner" | "member" },
): Promise<IngestRefusal | null> {
  const state = await consentState(ctx, q, user);
  if (!state.satisfied) {
    const missing = state.required.filter((r) => !r.accepted).map((r) => r.type);
    return {
      code: "consent_required",
      message: `Accept the current consent documents first: ${missing.join(", ")}.`,
    };
  }
  const privacy = await getPrivacy(q, user.id);
  if (privacy.ingestPaused)
    return { code: "ingest_paused", message: "Capture is paused for this account." };
  return null;
}

/** Re-evaluates the gate after a settings/consent change and closes live sockets if needed. */
export async function enforceIngestGate(
  ctx: Ctx,
  user: { id: string; role: "owner" | "member" },
): Promise<void> {
  const refusal = await ingestRefusal(ctx, ctx.db, user);
  if (refusal) ctx.live.refuseUser(user.id, refusal.code, refusal.message);
}
