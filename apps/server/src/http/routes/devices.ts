import { randomUUID } from "node:crypto";
import {
  type Device,
  type DeviceAccess,
  type PairingCode,
  type PairResponse,
  ROUTES,
  zDeviceUpdate,
  zPairingCodeRequest,
  zPairRequest,
} from "@ltm/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Ctx, iso } from "../../context.js";
import { newPairingCode, newToken, normalizePairingCode, sha256Hex } from "../../crypto.js";
import { one } from "../../db/types.js";
import { ApiError, notFound } from "../../errors.js";
import { streamActive } from "../../services/ingest.js";
import { type DeviceRow, deviceDto, type UserRow } from "../../services/users.js";
import { deviceOf, parse, RateLimiter, requestOrigin, sessionUser } from "../plumbing.js";

const zIdParam = z.object({ id: z.string().min(1).max(64) });

async function onlineDevices(ctx: Ctx, userId: string): Promise<Set<string>> {
  const online = new Set(ctx.live.connectedDeviceIds(userId));
  const streams = await ctx.db.query<{
    id: string;
    device_id: string;
    ended_at: number | null;
    last_activity_at: number;
  }>(
    "SELECT id, device_id, ended_at, last_activity_at FROM streams WHERE user_id = $1 AND ended_at IS NULL",
    [userId],
  );
  for (const s of streams) if (streamActive(ctx, s)) online.add(s.device_id);
  return online;
}

export async function deviceDtoFor(ctx: Ctx, d: DeviceRow): Promise<Device> {
  return deviceDto(d, (await onlineDevices(ctx, d.user_id)).has(d.id));
}

const DEVICE_COLUMNS =
  "id, user_id, name, kind, access, platform, app_version, priority, created_at, last_seen_at";

export async function deviceRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  // Per client IP, plus a global budget of failed attempts so a distributed guesser is slowed too.
  const pairLimiter = new RateLimiter(ctx.clock, 10, 10 * 60_000);
  const pairFailures = new RateLimiter(ctx.clock, 200, 10 * 60_000);

  app.get(ROUTES.devices, async (req): Promise<Device[]> => {
    const { user } = sessionUser(req);
    const rows = await ctx.db.query<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE user_id = $1 ORDER BY created_at`,
      [user.id],
    );
    const online = await onlineDevices(ctx, user.id);
    return rows.map((d) => deviceDto(d, online.has(d.id)));
  });

  app.post(ROUTES.devicePairingCodes, async (req, reply): Promise<PairingCode> => {
    const { user } = sessionUser(req);
    const { access } = parse(zPairingCodeRequest, req.body ?? {});
    const code = newPairingCode();
    const now = ctx.clock.now();
    const expiresAt = now + ctx.config.tuning.pairingCodeTtlMs;
    await ctx.db.query(
      "INSERT INTO pairing_codes (code_hash, user_id, access, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [sha256Hex(normalizePairingCode(code)), user.id, access, now, expiresAt],
    );
    const origin = ctx.config.publicUrl ?? requestOrigin(req);
    reply.code(201);
    return {
      code,
      expiresAt: iso(expiresAt),
      access,
      pairingUri: `ltm://pair?server=${encodeURIComponent(origin)}&code=${encodeURIComponent(code)}`,
    };
  });

  app.post(
    ROUTES.devicePair,
    { config: { access: "public" } },
    async (req, reply): Promise<PairResponse> => {
      pairLimiter.check(`pair:${req.ip}`);
      const body = parse(zPairRequest, req.body);
      const hash = sha256Hex(normalizePairingCode(body.code));
      const now = ctx.clock.now();
      const token = newToken("device");
      const result = await ctx.db.tx(async (q) => {
        // Deleting first makes the code single-use even under concurrent attempts.
        const code = await one<{ user_id: string; expires_at: number; access: DeviceAccess }>(
          q,
          "DELETE FROM pairing_codes WHERE code_hash = $1 RETURNING user_id, expires_at, access",
          [hash],
        );
        if (!code || code.expires_at <= now) return null;
        const user = await one<UserRow>(q, "SELECT * FROM users WHERE id = $1", [code.user_id]);
        if (!user) return null;
        const device = (
          await q.query<DeviceRow>(
            `INSERT INTO devices (id, user_id, name, kind, platform, app_version, priority, token_hash, created_at, last_seen_at, access)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $8, $9) RETURNING ${DEVICE_COLUMNS}`,
            [
              randomUUID(),
              user.id,
              body.name.trim(),
              body.kind,
              body.platform ?? null,
              body.appVersion ?? null,
              sha256Hex(token),
              now,
              code.access,
            ],
          )
        )[0]!;
        return { user, device };
      });
      if (!result) {
        pairFailures.check("pair:failures");
        throw new ApiError(400, "bad_request", "This pairing code is invalid or has expired.");
      }
      req.log.info(
        { userId: result.user.id, deviceId: result.device.id, kind: result.device.kind },
        "device paired",
      );
      reply.code(201);
      return {
        device: deviceDto(result.device, false),
        token,
        user: {
          id: result.user.id,
          displayName: result.user.display_name,
          locale: result.user.locale,
        },
      };
    },
  );

  app.get(ROUTES.deviceSelf, { config: { access: "device" } }, async (req): Promise<Device> => {
    const { device } = deviceOf(req);
    return deviceDtoFor(ctx, device);
  });

  app.patch(ROUTES.device, async (req): Promise<Device> => {
    const { user } = sessionUser(req);
    const { id } = parse(zIdParam, req.params);
    const body = parse(zDeviceUpdate, req.body ?? {});
    const sets: string[] = [];
    const params: unknown[] = [id, user.id];
    if (body.name !== undefined) {
      params.push(body.name.trim());
      sets.push(`name = $${params.length}`);
    }
    if (body.priority !== undefined) {
      params.push(body.priority);
      sets.push(`priority = $${params.length}`);
    }
    if (body.access !== undefined) {
      params.push(body.access);
      sets.push(`access = $${params.length}`);
    }
    const row = sets.length
      ? await one<DeviceRow>(
          ctx.db,
          `UPDATE devices SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING ${DEVICE_COLUMNS}`,
          params,
        )
      : await one<DeviceRow>(
          ctx.db,
          `SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = $1 AND user_id = $2`,
          params,
        );
    if (!row) throw notFound("Device not found.");
    // A new priority applies to every later merge (new data or reprocess); existing transcripts stay as they are.
    return deviceDtoFor(ctx, row);
  });

  app.delete(ROUTES.device, async (req, reply) => {
    const { user } = sessionUser(req);
    const { id } = parse(zIdParam, req.params);
    const rows = await ctx.db.query(
      "DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, user.id],
    );
    if (rows.length === 0) throw notFound("Device not found.");
    ctx.live.dropDevice(id);
    return reply.code(204).send();
  });
}
