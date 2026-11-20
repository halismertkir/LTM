import { randomUUID } from "node:crypto";
import type { Device, Locale, User } from "@ltm/protocol";
import { type Ctx, iso, isoOrNull } from "../context.js";
import { hashPassword, newToken, sha256Hex, tokenKind } from "../crypto.js";
import { one, type Queryable } from "../db/types.js";
import { conflict } from "../errors.js";
import { DEFAULT_PIPELINE, DEFAULT_PRIVACY } from "./settings.js";

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: "owner" | "member";
  locale: Locale;
  password_hash: string;
  created_at: number;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  kind: Device["kind"];
  access: Device["access"];
  platform: string | null;
  app_version: string | null;
  priority: number | null;
  created_at: number;
  last_seen_at: number | null;
}

export type Principal =
  | { type: "user"; user: UserRow; sessionId: string }
  | { type: "device"; user: UserRow; device: DeviceRow };

export function userDto(u: UserRow): User {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    locale: u.locale,
    createdAt: iso(u.created_at),
  };
}

export function deviceDto(d: DeviceRow, online: boolean): Device {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    access: d.access,
    platform: d.platform,
    appVersion: d.app_version,
    priority: d.priority,
    createdAt: iso(d.created_at),
    lastSeenAt: isoOrNull(d.last_seen_at),
    online,
  };
}

export async function countUsers(q: Queryable): Promise<number> {
  const r = await one<{ n: number }>(q, "SELECT count(*)::int AS n FROM users");
  return r?.n ?? 0;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(q: Queryable, email: string): Promise<UserRow | null> {
  return one<UserRow>(q, "SELECT * FROM users WHERE email = $1", [normalizeEmail(email)]);
}

export async function getUser(q: Queryable, id: string): Promise<UserRow | null> {
  return one<UserRow>(q, "SELECT * FROM users WHERE id = $1", [id]);
}

export async function createUser(
  ctx: Ctx,
  input: {
    email: string;
    password: string;
    displayName: string;
    locale: Locale;
    role: "owner" | "member";
    /** Already validated; decides where this user's days begin. */
    timeZone?: string;
  },
): Promise<UserRow> {
  const hash = await hashPassword(input.password);
  const id = randomUUID();
  const now = ctx.clock.now();
  try {
    return await ctx.db.tx(async (q) => {
      if (input.role === "owner" && (await countUsers(q)) > 0)
        throw conflict("Setup has already been completed.");
      const user = (
        await q.query<UserRow>(
          `INSERT INTO users (id, email, display_name, role, locale, password_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [
            id,
            normalizeEmail(input.email),
            input.displayName.trim(),
            input.role,
            input.locale,
            hash,
            now,
          ],
        )
      )[0]!;
      await q.query(
        "INSERT INTO user_settings (user_id, privacy, pipeline, updated_at) VALUES ($1, $2::jsonb, $3::jsonb, $4)",
        [
          id,
          JSON.stringify(DEFAULT_PRIVACY),
          JSON.stringify({
            ...DEFAULT_PIPELINE,
            timeZone: input.timeZone ?? DEFAULT_PIPELINE.timeZone,
          }),
          now,
        ],
      );
      return user;
    });
  } catch (err) {
    // Unique violation: e-mail taken, or a concurrent setup created the owner first.
    if ((err as { code?: string }).code === "23505") {
      throw input.role === "owner"
        ? conflict("Setup has already been completed.")
        : conflict("This e-mail address is already registered.");
    }
    throw err;
  }
}

export async function createSession(
  ctx: Ctx,
  userId: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = newToken("session");
  const now = ctx.clock.now();
  const expiresAt = now + ctx.config.tuning.sessionTtlMs;
  await ctx.db.query(
    "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at) VALUES ($1, $2, $3, $4, $5, $4)",
    [randomUUID(), userId, sha256Hex(token), now, expiresAt],
  );
  return { token, expiresAt };
}

export async function deleteSession(ctx: Ctx, sessionId: string): Promise<void> {
  await ctx.db.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

/** Resolves a bearer/cookie token to its principal, or null (unknown, expired, revoked). */
export async function resolveToken(ctx: Ctx, token: string): Promise<Principal | null> {
  const kind = tokenKind(token);
  if (!kind || token.length > 512) return null;
  const hash = sha256Hex(token);
  const now = ctx.clock.now();
  if (kind === "session") {
    const row = await one<
      UserRow & { session_id: string; expires_at: number; last_used_at: number }
    >(
      ctx.db,
      `SELECT u.*, s.id AS session_id, s.expires_at, s.last_used_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
      [hash],
    );
    if (!row || row.expires_at <= now) return null;
    if (now - row.last_used_at > 60_000) {
      await ctx.db.query("UPDATE sessions SET last_used_at = $2 WHERE id = $1", [
        row.session_id,
        now,
      ]);
    }
    const { session_id, expires_at: _e, last_used_at: _l, ...user } = row;
    return { type: "user", user, sessionId: session_id };
  }
  const row = await one<DeviceRow & { token_hash: string }>(
    ctx.db,
    "SELECT * FROM devices WHERE token_hash = $1",
    [hash],
  );
  if (!row) return null;
  const user = await getUser(ctx.db, row.user_id);
  if (!user) return null;
  if (row.last_seen_at === null || now - row.last_seen_at > 30_000) {
    await ctx.db.query("UPDATE devices SET last_seen_at = $2 WHERE id = $1", [row.id, now]);
    row.last_seen_at = now;
  }
  const { token_hash: _t, ...device } = row;
  return { type: "device", user, device };
}
