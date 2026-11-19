import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Clock } from "../deps.js";
import { ApiError, badRequest, forbidden, unauthorized } from "../errors.js";
import type { DeviceRow, Principal, UserRow } from "../services/users.js";

/**
 * Who may call a route:
 * - public: anyone
 * - user:   a user session (cookie or bearer)
 * - any:    a user session or a device token
 * - device: a device token only
 */
export type Access = "public" | "user" | "any" | "device";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
    authVia: "cookie" | "bearer" | null;
  }
  interface FastifyContextConfig {
    access?: Access;
    /** Public routes that set the session cookie also get the same-origin check. */
    setsCookie?: boolean;
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      "Invalid request.",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

export function userOf(req: FastifyRequest): UserRow {
  if (!req.principal) throw unauthorized();
  return req.principal.user;
}

export function sessionUser(req: FastifyRequest): { user: UserRow; sessionId: string } {
  const p = req.principal;
  if (!p) throw unauthorized();
  if (p.type !== "user") throw forbidden("This endpoint needs a user session.");
  return { user: p.user, sessionId: p.sessionId };
}

export function deviceOf(req: FastifyRequest): { user: UserRow; device: DeviceRow } {
  const p = req.principal;
  if (!p) throw unauthorized();
  if (p.type !== "device")
    throw forbidden("This endpoint needs a device token (pair the device first).");
  return { user: p.user, device: p.device };
}

export function sendError(reply: FastifyReply, err: ApiError): FastifyReply {
  const body: { error: { code: string; message: string; details?: unknown } } = {
    error: { code: err.code, message: err.message },
  };
  if (err.details !== undefined) body.error.details = err.details;
  return reply.code(err.status).type("application/json; charset=utf-8").send(body);
}

/** Fixed-window in-memory limiter (single process; good enough for login/pairing abuse). */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Throws `rate_limited` once `key` exceeded its budget in the current window. */
  check(key: string): void {
    const now = this.clock.now();
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    if (this.hits.size > 10_000) this.sweep(now);
    if (e.count > this.max) {
      const retry = Math.ceil((e.resetAt - now) / 1000);
      throw new ApiError(429, "rate_limited", `Too many attempts. Try again in ${retry} s.`, {
        retryAfterSeconds: retry,
      });
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

/** The origin the request was addressed to, as a browser would write it in `Origin`. */
export function requestOrigin(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}`;
}
