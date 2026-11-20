import type { PrivacySettings } from "@ltm/protocol";
import type { Ctx } from "../context.js";
import { enforceIngestGate } from "./consent.js";
import { getPrivacy, putPrivacy } from "./settings.js";

type User = { id: string; role: "owner" | "member" };

/**
 * Stores privacy settings and applies the side effects of the kill switch: pausing closes
 * every live ingest socket of the account, and any change is announced as `capture_paused`
 * so every client's capture indicator follows, whichever client flipped it.
 */
export async function savePrivacy(
  ctx: Ctx,
  user: User,
  next: PrivacySettings,
): Promise<PrivacySettings> {
  const before = await getPrivacy(ctx.db, user.id);
  await putPrivacy(ctx, ctx.db, user.id, next);
  await afterPrivacyChange(ctx, user, before.ingestPaused, next.ingestPaused);
  return getPrivacy(ctx.db, user.id);
}

export async function setIngestPaused(ctx: Ctx, user: User, paused: boolean): Promise<boolean> {
  const before = await getPrivacy(ctx.db, user.id);
  const saved = await savePrivacy(ctx, user, { ...before, ingestPaused: paused });
  return saved.ingestPaused;
}

/** Call after anything that may have flipped ingestPaused (e.g. a consent withdrawal). */
export async function afterPrivacyChange(
  ctx: Ctx,
  user: User,
  wasPaused: boolean,
  isPaused: boolean,
): Promise<void> {
  await enforceIngestGate(ctx, user);
  if (wasPaused !== isPaused)
    ctx.bus.publish(user.id, { type: "capture_paused", ingestPaused: isPaused });
}
