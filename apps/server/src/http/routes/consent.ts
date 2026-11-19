import { type ConsentState, ROUTES, zConsentAccept, zConsentWithdraw } from "@ltm/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Ctx } from "../../context.js";
import { badRequest } from "../../errors.js";
import {
  acceptConsents,
  consentState,
  currentConsentVersion,
  enforceIngestGate,
  withdrawConsents,
} from "../../services/consent.js";
import { parse, userOf } from "../plumbing.js";

function via(req: FastifyRequest): string {
  const p = req.principal!;
  return p.type === "device" ? `device:${p.device.id}` : "web";
}

export async function consentRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get(ROUTES.consents, { config: { access: "any" } }, async (req): Promise<ConsentState> => {
    return consentState(ctx, ctx.db, userOf(req));
  });

  app.post(ROUTES.consents, { config: { access: "any" } }, async (req): Promise<ConsentState> => {
    const user = userOf(req);
    const body = parse(zConsentAccept, req.body);
    for (const a of body.accept) {
      const current = currentConsentVersion(a.type);
      if (current !== a.version) {
        throw badRequest(`"${a.type}" is at version ${current}; accept the current version.`, {
          type: a.type,
          currentVersion: current,
        });
      }
    }
    await acceptConsents(ctx, ctx.db, user.id, body.accept, via(req));
    return consentState(ctx, ctx.db, user);
  });

  app.post(
    ROUTES.consentWithdraw,
    { config: { access: "any" } },
    async (req): Promise<ConsentState> => {
      const user = userOf(req);
      const body = parse(zConsentWithdraw, req.body);
      await ctx.db.tx((q) => withdrawConsents(ctx, q, user.id, body.types));
      await enforceIngestGate(ctx, user);
      return consentState(ctx, ctx.db, user);
    },
  );
}
