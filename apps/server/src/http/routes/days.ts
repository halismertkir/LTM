import {
  type CapturePauseState,
  type DayDetail,
  ROUTES,
  zCapturePause,
  zDayDate,
  zDayQuery,
} from "@ltm/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Ctx } from "../../context.js";
import { one } from "../../db/types.js";
import { notFound } from "../../errors.js";
import { setIngestPaused } from "../../services/capture.js";
import { dayDetail, listDays, scheduleDigest } from "../../services/days.js";
import { parse, sessionUser, userOf } from "../plumbing.js";

const zDateParam = z.object({ date: zDayDate });

export async function dayRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get(ROUTES.days, async (req) => {
    const user = userOf(req);
    return listDays(ctx, user.id, parse(zDayQuery, req.query));
  });

  app.get(ROUTES.day, async (req): Promise<DayDetail> => {
    const user = userOf(req);
    const { date } = parse(zDateParam, req.params);
    const detail = await dayDetail(ctx, user.id, date);
    if (!detail) throw notFound("Nothing was captured on this day.");
    return detail;
  });

  app.post(ROUTES.dayRegenerate, async (req, reply) => {
    const { user } = sessionUser(req);
    const { date } = parse(zDateParam, req.params);
    const any = await one(
      ctx.db,
      "SELECT 1 FROM conversations WHERE user_id = $1 AND local_date = $2 LIMIT 1",
      [user.id, date],
    );
    if (!any) throw notFound("Nothing was captured on this day.");
    await scheduleDigest(ctx, ctx.db, user.id, date, 0);
    return reply.code(202).send({ queued: true });
  });

  // The kill switch, also reachable from a memory-access device (the phone's one-tap pause).
  app.post(ROUTES.capturePause, async (req): Promise<CapturePauseState> => {
    const user = userOf(req);
    const { paused } = parse(zCapturePause, req.body);
    return { ingestPaused: await setIngestPaused(ctx, user, paused) };
  });
}
