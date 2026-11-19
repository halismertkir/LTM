import { normalizeText } from "@ltm/core";
import {
  type ActionItem,
  type AskResponse,
  type ConversationDetail,
  type Memory,
  ROUTES,
  type SearchResponse,
  type StreamInfo,
  zActionItemUpdate,
  zAskRequest,
  zConversationQuery,
  zConversationUpdate,
  zMemoryCreate,
  zMemoryQuery,
  zMemoryUpdate,
  zSearchRequest,
} from "@ltm/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Ctx } from "../../context.js";
import { json, one } from "../../db/types.js";
import { notFound } from "../../errors.js";
import { STT_NOT_CONFIGURED } from "../../pipeline/transcribe.js";
import { ask } from "../../services/ask.js";
import {
  type ActionItemRow,
  actionItemDto,
  conversationDetail,
  conversationSearchText,
  conversationSummaries,
  getConversationRow,
  listConversations,
} from "../../services/conversations.js";
import { deleteConversations } from "../../services/erase.js";
import { type StreamRow, streamActive, streamInfoDto } from "../../services/ingest.js";
import {
  getMemory,
  insertMemory,
  listMemories,
  type MemoryRow,
  memoryDto,
  scheduleEmbed,
} from "../../services/memories.js";
import { search } from "../../services/search.js";
import { resolveProviders } from "../../services/settings.js";
import { parse, sessionUser } from "../plumbing.js";

const zIdParam = z.object({ id: z.string().min(1).max(64) });

export async function memoryRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  // ------------------------------------------------------------ conversations
  app.get(ROUTES.conversations, async (req) => {
    const { user } = sessionUser(req);
    const query = parse(zConversationQuery, req.query);
    return listConversations(ctx.db, user.id, query);
  });

  app.get(ROUTES.conversation, async (req): Promise<ConversationDetail> => {
    const { user } = sessionUser(req);
    const { id } = parse(zIdParam, req.params);
    const detail = await conversationDetail(ctx.db, user.id, id);
    if (!detail) throw notFound("Conversation not found.");
    return detail;
  });

  app.patch(ROUTES.conversation, async (req): Promise<ConversationDetail> => {
    const { user } = sessionUser(req);
    const { id } = parse(zIdParam, req.params);
    const body = parse(zConversationUpdate, req.body ?? {});
    const conv = await getConversationRow(ctx.db, user.id, id);
    if (!conv) throw notFound("Conversation not found.");
    const title = body.title !== undefined ? body.title.trim() : conv.title;
    const notes = body.notes !== undefined ? body.notes : conv.notes;
    // The edited flags make later reprocessing keep what the user wrote.
    await ctx.db.query(
      `UPDATE conversations SET title = $3, notes = $4, title_edited = title_edited OR $5, notes_edited = notes_edited OR $6,
              search_text = $7, updated_at = $8
       WHERE id = $1 AND user_id = $2`,
      [
        id,
        user.id,
        title,
        notes,
        body.title !== undefined,
        body.notes !== undefined,
        conversationSearchText({
          title,
          summary: conv.summary,
          notes,
          topics: conv.topics,
          participants: conv.participants,
        }),
        ctx.clock.now(),
      ],
    );
    const detail = (await conversationDetail(ctx.db, user.id, id))!;
    const [summary] = await conversationSummaries(ctx.db, user.id, [id]);
    if (summary) ctx.bus.publish(user.id, { type: "conversation_updated", conversation: summary });
    return detail;
  });

  app.delete(ROUTES.conversation, async (req, reply) => {
    const { user } = sessionUser(req);
    const { id } = parse(zIdParam, req.params);
    const conv = await getConversationRow(ctx.db, user.id, id);
    if (!conv) throw notFound("Conversation not found.");
    await deleteConversations(ctx, user.id, [id]);
    return reply.code(204).send();
  });

  app.post(ROUTES.conversationReprocess, async (req, reply) => {
    const { user } = sessionUser(req);
    const { id } = parse(zIdParam, req.params);
    const conv = await getConversationRow(ctx.db, user.id, id);
    if (!conv) throw notFound("Conversation not found.");
    await ctx.db.tx(async (q) => {
      // An open conversation is consolidated when it closes; just re-merge it now.
      if (conv.status !== "open") {
        await q.query(
          "UPDATE conversations SET status = 'processing', status_detail = NULL, updated_at = $2 WHERE id = $1",
          [id, ctx.clock.now()],
        );
      }
      await ctx.jobs.enqueue(q, {
        kind: "consolidate",
        userId: user.id,
        payload: { conversationId: id, remerge: true },
        dedupeKey: `consolidate:${id}`,
      });
    });
    const [summary] = await conversationSummaries(ctx.db, user.id, [id]);
    if (summary) ctx.bus.publish(user.id, { type: "conversation_updated", conversation: summary });
    return reply.code(202).send({ queued: true });
  });

  app.patch(ROUTES.actionItem, async (req): Promise<ActionItem> => {
    const { user } = sessionUser(req);
    const { id, itemId } = parse(
      z.object({ id: z.string().min(1).max(64), itemId: z.string().min(1).max(64) }),
      req.params,
    );
    const body = parse(zActionItemUpdate, req.body ?? {});
    const row = await one<ActionItemRow>(
      ctx.db,
      `UPDATE action_items SET done = COALESCE($4, done), text = COALESCE($5, text),
              text_edited = text_edited OR ($5 IS NOT NULL), updated_at = $6
        WHERE id = $1 AND conversation_id = $2 AND user_id = $3 RETURNING *`,
      [itemId, id, user.id, body.done ?? null, body.text?.trim() ?? null, ctx.clock.now()],
    );
    if (!row) throw notFound("Action item not found.");
    return actionItemDto(row);
  });

  // ------------------------------------------------------------ memories
  app.get(ROUTES.memories, async (req) => {
    const { user } = sessionUser(req);
    return listMemories(ctx.db, user.id, parse(zMemoryQuery, req.query));
  });

  app.post(ROUTES.memories, async (req, reply): Promise<Memory> => {
    const { user } = sessionUser(req);
    const body = parse(zMemoryCreate, req.body);
    const row = await ctx.db.tx(async (q) => {
      const r = await insertMemory(ctx, q, user.id, {
        kind: body.kind,
        content: body.content,
        importance: body.importance,
        subjects: body.subjects.map((s) => s.trim()).filter(Boolean),
        occurredAt: null,
        origin: "manual",
        sourceConversationId: null,
      });
      await scheduleEmbed(ctx, q, user.id);
      return r;
    });
    const dto = memoryDto(row);
    ctx.bus.publish(user.id, { type: "memory_created", memory: dto });
    reply.code(201);
    return dto;
  });

  app.patch(ROUTES.memory, async (req): Promise<Memory> => {
    const { user } = sessionUser(req);
    const { id } = parse(zIdParam, req.params);
    const body = parse(zMemoryUpdate, req.body ?? {});
    const existing = await getMemory(ctx.db, user.id, id);
    if (!existing) throw notFound("Memory not found.");
    const content = body.content?.trim() ?? existing.content;
    const row = await ctx.db.tx(async (q) => {
      const r = await one<MemoryRow>(
        q,
        `UPDATE memories SET kind = $3, content = $4, importance = $5, subjects = $6::jsonb, normalized = $7, updated_at = $8
          WHERE id = $1 AND user_id = $2 RETURNING *`,
        [
          id,
          user.id,
          body.kind ?? existing.kind,
          content,
          body.importance ?? existing.importance,
          json(body.subjects ?? existing.subjects),
          normalizeText(content),
          ctx.clock.now(),
        ],
      );
      if (content !== existing.content) await scheduleEmbed(ctx, q, user.id);
      return r!;
    });
    return memoryDto(row);
  });

  app.delete(ROUTES.memory, async (req, reply) => {
    const { user } = sessionUser(req);
    const { id } = parse(zIdParam, req.params);
    const rows = await ctx.db.query(
      "DELETE FROM memories WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, user.id],
    );
    if (rows.length === 0) throw notFound("Memory not found.");
    return reply.code(204).send();
  });

  // ------------------------------------------------------------ search & ask
  app.post(ROUTES.search, async (req): Promise<SearchResponse> => {
    const { user } = sessionUser(req);
    const body = parse(zSearchRequest, req.body);
    const { embedding } = await resolveProviders(ctx, user, ["embedding"]);
    return search(ctx, user.id, embedding, body);
  });

  app.post(ROUTES.ask, async (req): Promise<AskResponse> => {
    const { user } = sessionUser(req);
    return ask(ctx, user, parse(zAskRequest, req.body));
  });

  // ------------------------------------------------------------ streams & live events
  app.get(
    ROUTES.streams,
    async (req): Promise<(StreamInfo & { statusDetail: string | null })[]> => {
      const { user } = sessionUser(req);
      const { active } = parse(
        z.object({ active: z.enum(["true", "false"]).optional() }),
        req.query,
      );
      const rows = await ctx.db.query<StreamRow & { device_name: string | null; parked: number }>(
        `SELECT s.*, d.name AS device_name,
              (SELECT count(*)::int FROM audio_chunks a JOIN jobs j ON j.kind = 'transcribe' AND j.payload->>'chunkId' = a.id
                WHERE a.stream_id = s.id AND a.status = 'pending' AND j.status = 'parked') AS parked
         FROM streams s LEFT JOIN devices d ON d.id = s.device_id
        WHERE s.user_id = $1 ${active === "true" ? "AND s.ended_at IS NULL" : ""}
        ORDER BY s.started_at DESC LIMIT 200`,
        [user.id],
      );
      return rows
        .filter((r) => active !== "true" || streamActive(ctx, r))
        .map((r) => ({
          ...streamInfoDto(ctx, r, r.device_name),
          // Not in the protocol DTO (extra field): why audio of this stream is not being transcribed.
          statusDetail:
            r.parked > 0 ? `${r.parked} audio segment(s) waiting. ${STT_NOT_CONFIGURED}` : null,
        }));
    },
  );

  app.get(ROUTES.events, async (req, reply) => {
    const { user } = sessionUser(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    res.write(": connected\n\n");
    const unsubscribe = ctx.bus.subscribe(user.id, (event) => {
      // No `event:` field: clients read everything through EventSource.onmessage and switch on `type`.
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), ctx.config.tuning.sseHeartbeatMs);
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  });
}
