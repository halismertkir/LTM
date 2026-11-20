import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeDelayMs } from "../src/pipeline/merge.js";
import { runRetention } from "../src/pipeline/retention.js";
import { acceptAllConsents, pairDevice, setupOwner, startTestServer } from "./helpers.js";

const S = 1000;
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("all-day robustness", () => {
  it("splits a conversation that runs past the 4 h cap", async () => {
    const t = await startTestServer();
    try {
      const o = await setupOwner(t.api);
      await acceptAllConsents(t.api, o.token);
      const d = await pairDevice(t.api, o.token, "Room mic", "other");
      const streamId = randomUUID();
      const start = t.clock.now();
      // Speech every 2 minutes (never a 5-minute silence) for 5 hours, arriving hour by hour.
      for (let h = 0; h < 5; h++) {
        const segments = Array.from({ length: 30 }, (_, i) => {
          const at = start + h * HOUR + i * 2 * MIN;
          return {
            id: `h${h}-${i}`,
            startMs: at,
            endMs: at + 20 * S,
            text: `hour ${h} remark ${i} about the long workshop`,
          };
        });
        t.clock.set(start + (h + 1) * HOUR);
        const r = await t.api.post(
          "/ingest/transcripts",
          { streamId, source: "ambient", clientTimeMs: t.clock.now(), segments },
          { token: d.token },
        );
        expect(r.body.accepted).toBe(30);
        await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 30 * S });
      }
      await t.server.worker.drain({ advance: (to) => t.clock.set(to), maxAdvanceMs: 30 * MIN });
      const items = (await t.api.get("/conversations", { token: o.token })).body.items as {
        startMs: number;
        endMs: number;
        utteranceCount: number;
      }[];
      expect(items.length).toBe(2);
      for (const c of items) expect(c.endMs - c.startMs).toBeLessThanOrEqual(4 * HOUR);
      const segs = await t.db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM raw_segments WHERE conversation_id IS NOT NULL",
      );
      expect(segs[0]!.n).toBe(150);
    } finally {
      await t.close();
    }
  });

  it("merges thousands of segments quickly and debounces re-merges", async () => {
    const t = await startTestServer();
    try {
      const o = await setupOwner(t.api);
      await acceptAllConsents(t.api, o.token);
      const a = await pairDevice(t.api, o.token, "Laptop", "browser_extension");
      const b = await pairDevice(t.api, o.token, "Watch", "apple_watch");
      const start = t.clock.now();
      const total = 1500;
      for (const [dev, source, skew] of [
        [a, "tab", 0],
        [b, "ambient", 700],
      ] as const) {
        const streamId = randomUUID();
        for (let off = 0; off < total; off += 500) {
          const segments = Array.from({ length: 500 }, (_, i) => {
            const k = off + i;
            const at = start + k * 2 * S + skew;
            return {
              id: `${source}-${k}`,
              startMs: at,
              endMs: at + 1600,
              text: `sentence number ${k} of the long meeting today`,
            };
          });
          await t.api.post(
            "/ingest/transcripts",
            { streamId, source, clientTimeMs: t.clock.now(), segments },
            { token: dev.token },
          );
        }
      }
      // Six uploads, one pending merge.
      const pending = await t.db.query(
        "SELECT 1 FROM jobs WHERE kind = 'merge' AND status = 'pending'",
      );
      expect(pending).toHaveLength(1);
      t.clock.set(start + total * 2 * S);
      const t0 = performance.now();
      await t.server.worker.drain({
        advance: (to) => t.clock.set(to),
        maxAdvanceMs: 10 * S,
        kinds: ["merge"],
      });
      const ms = performance.now() - t0;
      const [c] = (await t.api.get("/conversations", { token: o.token })).body.items;
      // Two devices heard the same 1500 sentences: each appears exactly once in the transcript.
      const d = (await t.api.get(`/conversations/${c.id}`, { token: o.token })).body;
      const text = d.utterances.map((u: { text: string }) => u.text).join(" ");
      expect(text.match(/sentence number/g)).toHaveLength(total);
      expect(d.utterances.every((u: { deviceIds: string[] }) => u.deviceIds.length === 2)).toBe(
        true,
      );
      console.info(`merge of ${total * 2} raw segments took ${Math.round(ms)} ms`);
      expect(ms).toBeLessThan(20_000);
      // The next merge of this user waits at least ten times as long as the last one took.
      expect(mergeDelayMs(t.server.ctx, o.userId)).toBeGreaterThanOrEqual(
        Math.min(60_000, t.server.ctx.config.tuning.mergeDebounceMs),
      );
    } finally {
      await t.close();
    }
  });

  it("retention prunes failed jobs and orphaned audio, but keeps what is referenced or fresh", async () => {
    const t = await startTestServer();
    try {
      const o = await setupOwner(t.api);
      const now = t.clock.now();
      await t.db.query(
        "INSERT INTO jobs (id, kind, user_id, status, run_at, created_at, updated_at) VALUES ('old', 'merge', $1, 'failed', $2, $2, $2), ('new', 'merge', $1, 'failed', $3, $3, $3)",
        [o.userId, now - 2 * 24 * HOUR, now],
      );
      const dir = join(t.dataDir, "audio", o.userId, randomUUID());
      mkdirSync(dir, { recursive: true });
      const orphan = join(dir, "orphan.wav");
      const fresh = join(dir, "fresh.wav");
      writeFileSync(orphan, "x");
      writeFileSync(fresh, "x");
      const past = new Date(Date.now() - 2 * HOUR);
      utimesSync(orphan, past, past);
      await runRetention(t.server.ctx);
      expect(
        (await t.db.query<{ id: string }>("SELECT id FROM jobs WHERE status = 'failed'")).map(
          (j) => j.id,
        ),
      ).toEqual(["new"]);
      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("caps live event streams per account", async () => {
    const t = await startTestServer();
    try {
      const o = await setupOwner(t.api);
      for (let i = 0; i < 32; i++) t.server.ctx.bus.subscribe(o.userId, () => {});
      const r = await t.api.get("/events", { token: o.token });
      expect(r.status).toBe(429);
    } finally {
      await t.close();
    }
  });
});
