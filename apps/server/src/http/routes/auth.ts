import {
  type AuthResponse,
  type AuthStatus,
  type Me,
  PROTOCOL_VERSION,
  ROUTES,
  SESSION_COOKIE,
  type VersionInfo,
  zLoginRequest,
  zMeUpdate,
  zRegisterRequest,
  zSetupRequest,
} from "@ltm/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pkg from "../../../package.json" with { type: "json" };
import { type Ctx, iso } from "../../context.js";
import { dummyPasswordHash, verifyPassword } from "../../crypto.js";
import { one } from "../../db/types.js";
import { ApiError, badRequest, forbidden, unauthorized } from "../../errors.js";
import { consentState } from "../../services/consent.js";
import { getPrivacy } from "../../services/settings.js";
import {
  countUsers,
  createSession,
  createUser,
  deleteSession,
  findUserByEmail,
  type UserRow,
  userDto,
} from "../../services/users.js";
import { canonicalTimeZone } from "../../time.js";
import { parse, RateLimiter, sessionUser, userOf } from "../plumbing.js";

/** The sign-up time zone, canonicalised; an unknown zone is a client bug worth reporting. */
function signupTimeZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  const canonical = canonicalTimeZone(tz);
  if (!canonical) throw badRequest(`Unknown time zone "${tz}".`);
  return canonical;
}

function secureCookie(ctx: Ctx, req: FastifyRequest): boolean {
  return req.protocol === "https" || (ctx.config.publicUrl?.startsWith("https:") ?? false);
}

async function issueSession(
  ctx: Ctx,
  req: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
): Promise<AuthResponse> {
  const { token, expiresAt } = await createSession(ctx, user.id);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookie(ctx, req),
    path: "/",
    expires: new Date(expiresAt),
  });
  return { user: userDto(user), token, expiresAt: iso(expiresAt) };
}

export async function authRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  // Budgets per client IP; login is additionally limited per e-mail address.
  const loginLimiter = new RateLimiter(ctx.clock, 10, 15 * 60_000);
  const loginByEmail = new RateLimiter(ctx.clock, 20, 15 * 60_000);
  const setupLimiter = new RateLimiter(ctx.clock, 10, 15 * 60_000);

  app.get(ROUTES.version, { config: { access: "public" } }, async (): Promise<VersionInfo> => {
    return { name: "ltm", version: pkg.version, protocol: PROTOCOL_VERSION };
  });

  app.get(ROUTES.authStatus, { config: { access: "public" } }, async (): Promise<AuthStatus> => {
    const n = await countUsers(ctx.db);
    return { setupRequired: n === 0, registrationOpen: n > 0 && ctx.config.allowRegistration };
  });

  app.post(
    ROUTES.authSetup,
    { config: { access: "public", setsCookie: true } },
    async (req, reply) => {
      setupLimiter.check(`setup:${req.ip}`);
      const body = parse(zSetupRequest, req.body);
      if ((await countUsers(ctx.db)) > 0)
        throw new ApiError(409, "conflict", "Setup has already been completed.");
      const user = await createUser(ctx, {
        ...body,
        timeZone: signupTimeZone(body.timeZone),
        role: "owner",
      });
      req.log.info({ userId: user.id }, "owner account created");
      return reply.code(201).send(await issueSession(ctx, req, reply, user));
    },
  );

  app.post(
    ROUTES.authRegister,
    { config: { access: "public", setsCookie: true } },
    async (req, reply) => {
      setupLimiter.check(`register:${req.ip}`);
      const body = parse(zRegisterRequest, req.body);
      const n = await countUsers(ctx.db);
      if (n === 0) throw new ApiError(409, "setup_required", "Complete the first-run setup first.");
      if (!ctx.config.allowRegistration) throw forbidden("Registration is closed on this server.");
      const user = await createUser(ctx, {
        ...body,
        timeZone: signupTimeZone(body.timeZone),
        role: "member",
      });
      return reply.code(201).send(await issueSession(ctx, req, reply, user));
    },
  );

  app.post(
    ROUTES.authLogin,
    { config: { access: "public", setsCookie: true } },
    async (req, reply) => {
      loginLimiter.check(`ip:${req.ip}`);
      const body = parse(zLoginRequest, req.body);
      loginByEmail.check(`email:${body.email.trim().toLowerCase()}`);
      if ((await countUsers(ctx.db)) === 0)
        throw new ApiError(409, "setup_required", "Complete the first-run setup first.");
      const user = await findUserByEmail(ctx.db, body.email);
      // Always run scrypt so response time does not reveal whether the account exists.
      const ok = await verifyPassword(
        body.password,
        user?.password_hash ?? (await dummyPasswordHash()),
      );
      if (!user || !ok) throw unauthorized("Wrong e-mail address or password.");
      return issueSession(ctx, req, reply, user);
    },
  );

  app.post(ROUTES.authLogout, { config: { access: "any" } }, async (req, reply) => {
    const p = req.principal;
    if (p?.type === "user") await deleteSession(ctx, p.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get(
    ROUTES.me,
    { config: { access: "any" } },
    async (req): Promise<Me> => meFor(req, userOf(req)),
  );

  app.patch(ROUTES.me, { config: { access: "user" } }, async (req): Promise<Me> => {
    const { user } = sessionUser(req);
    const body = parse(zMeUpdate, req.body ?? {});
    const updated = await one<UserRow>(
      ctx.db,
      "UPDATE users SET display_name = COALESCE($2, display_name), locale = COALESCE($3, locale) WHERE id = $1 RETURNING *",
      [user.id, body.displayName?.trim() || null, body.locale ?? null],
    );
    return meFor(req, updated ?? user);
  });

  async function meFor(req: FastifyRequest, user: UserRow): Promise<Me> {
    const p = req.principal!;
    return {
      user: userDto(user),
      principal: p.type === "device" ? { type: "device", deviceId: p.device.id } : { type: "user" },
      consent: await consentState(ctx, ctx.db, user),
      ingestPaused: (await getPrivacy(ctx.db, user.id)).ingestPaused,
    };
  }
}
