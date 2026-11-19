import { Readable } from "node:stream";
import { ROUTES, SESSION_COOKIE, zDeleteAccountRequest, zDeleteDataRequest } from "@ltm/protocol";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../../context.js";
import { verifyPassword } from "../../crypto.js";
import { forbidden } from "../../errors.js";
import { deleteAccount, eraseCapturedData } from "../../services/erase.js";
import { exportUserData } from "../../services/export.js";
import { parse, RateLimiter, sessionUser } from "../plumbing.js";

export async function dataRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const passwordLimiter = new RateLimiter(ctx.clock, 10, 15 * 60_000);

  app.get(ROUTES.exportData, async (req, reply) => {
    const { user } = sessionUser(req);
    const date = new Date(ctx.clock.now()).toISOString().slice(0, 10);
    reply
      .type("application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="ltm-export-${date}.json"`);
    return reply.send(Readable.from(exportUserData(ctx, user)));
  });

  app.delete(ROUTES.deleteData, async (req, reply) => {
    const { user } = sessionUser(req);
    const body = parse(zDeleteDataRequest, req.body);
    await eraseCapturedData(ctx, user.id, body.beforeMs);
    req.log.info({ userId: user.id, partial: body.beforeMs !== undefined }, "captured data erased");
    return reply.code(204).send();
  });

  app.delete(ROUTES.deleteAccount, async (req, reply) => {
    const { user } = sessionUser(req);
    passwordLimiter.check(`account:${user.id}`);
    const body = parse(zDeleteAccountRequest, req.body);
    if (!(await verifyPassword(body.password, user.password_hash)))
      throw forbidden("Wrong password.");
    await deleteAccount(ctx, user.id);
    req.log.info({ userId: user.id }, "account deleted");
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });
}
