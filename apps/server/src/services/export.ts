import { CONSENT_DOCUMENTS } from "@ltm/protocol";
import { type Ctx, iso, isoOrNull } from "../context.js";
import { consentState } from "./consent.js";
import { conversationDetail } from "./conversations.js";
import { type MemoryRow, memoryDto } from "./memories.js";
import { effectiveProviders, getPipeline, getPrivacy, providerConfigDto } from "./settings.js";
import { type DeviceRow, deviceDto, type UserRow, userDto } from "./users.js";

const PAGE = 50;

/**
 * Everything held for a user as one JSON document, produced piecewise so a large archive
 * never has to sit in memory. Secrets (password hash, token hashes, API keys) are left out.
 */
export async function* exportUserData(ctx: Ctx, user: UserRow): AsyncGenerator<string> {
  const q = ctx.db;
  const devices = await q.query<DeviceRow>(
    "SELECT id, user_id, name, kind, platform, app_version, priority, created_at, last_seen_at FROM devices WHERE user_id = $1 ORDER BY created_at",
    [user.id],
  );
  const providers = await effectiveProviders(ctx, q, user);
  const head = {
    format: "ltm-export",
    formatVersion: 1,
    exportedAt: iso(ctx.clock.now()),
    user: userDto(user),
    devices: devices.map((d) => deviceDto(d, false)),
    consent: await consentState(ctx, q, user),
    consentDocuments: CONSENT_DOCUMENTS.map((d) => ({ type: d.type, version: d.version })),
    settings: {
      providers: {
        llm: providerConfigDto(providers.llm),
        stt: providerConfigDto(providers.stt),
        embedding: providerConfigDto(providers.embedding),
      },
      privacy: await getPrivacy(q, user.id),
      pipeline: await getPipeline(q, user.id),
    },
  };
  const headJson = JSON.stringify(head, null, 2);
  yield `${headJson.slice(0, -2)},\n`;

  const streams = await q.query<Record<string, unknown>>(
    "SELECT id, device_id, source, mode, language, context, started_at, ended_at FROM streams WHERE user_id = $1 ORDER BY started_at",
    [user.id],
  );
  yield `  "streams": ${JSON.stringify(
    streams.map((s) => ({
      id: s.id,
      deviceId: s.device_id,
      source: s.source,
      mode: s.mode,
      language: s.language,
      context: s.context,
      startedAt: iso(s.started_at as number),
      endedAt: isoOrNull(s.ended_at as number | null),
    })),
  )},\n`;

  yield `  "conversations": [`;
  let first = true;
  let cursor: [number, string] | null = null;
  for (;;) {
    const ids: { id: string; start_ms: number }[] = await q.query<{ id: string; start_ms: number }>(
      cursor
        ? "SELECT id, start_ms FROM conversations WHERE user_id = $1 AND (start_ms, id) > ($2, $3) ORDER BY start_ms, id LIMIT $4"
        : "SELECT id, start_ms FROM conversations WHERE user_id = $1 ORDER BY start_ms, id LIMIT $2",
      cursor ? [user.id, cursor[0], cursor[1], PAGE] : [user.id, PAGE],
    );
    for (const { id } of ids) {
      const detail = await conversationDetail(q, user.id, id);
      if (!detail) continue;
      yield `${first ? "\n" : ",\n"}    ${JSON.stringify(detail)}`;
      first = false;
    }
    if (ids.length < PAGE) break;
    const last = ids[ids.length - 1]!;
    cursor = [last.start_ms, last.id];
  }
  yield `\n  ],\n  "rawSegments": [`;
  first = true;
  let offset = 0;
  for (;;) {
    const rows = await q.query<Record<string, unknown>>(
      `SELECT id, stream_id, device_id, source, origin, start_ms, end_ms, text, confidence, language, speaker, conversation_id
         FROM raw_segments WHERE user_id = $1 ORDER BY start_ms, id LIMIT $2 OFFSET $3`,
      [user.id, 500, offset],
    );
    for (const r of rows) {
      yield `${first ? "\n" : ",\n"}    ${JSON.stringify(r)}`;
      first = false;
    }
    if (rows.length < 500) break;
    offset += rows.length;
  }
  const memories = await q.query<MemoryRow>(
    "SELECT * FROM memories WHERE user_id = $1 ORDER BY created_at, id",
    [user.id],
  );
  yield `\n  ],\n  "memories": ${JSON.stringify(memories.map(memoryDto))},\n`;
  const audio = await q.query<Record<string, unknown>>(
    "SELECT id, stream_id, kind, seq, mime_type, size_bytes, start_ms, duration_ms, status, path IS NOT NULL AS stored FROM audio_chunks WHERE user_id = $1 ORDER BY start_ms",
    [user.id],
  );
  // Audio itself is not embedded in the JSON; this lists what is still stored on the server.
  yield `  "audioChunks": ${JSON.stringify(audio)}\n}\n`;
}
