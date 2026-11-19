import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "../db/types.js";
import { json } from "../db/types.js";
import type { Clock } from "../deps.js";

export type JobKind = "transcribe" | "merge" | "consolidate" | "embed" | "retention";

export interface EnqueueOptions {
  kind: JobKind;
  userId: string | null;
  payload?: Record<string, unknown>;
  /** Default: now. */
  runAt?: number;
  /**
   * At most one pending job per key. Enqueuing again keeps the EARLIER run time and merges
   * payloads, so a burst of triggers collapses into one run that happens at most `delay` late.
   */
  dedupeKey?: string;
  /** Jobs with the same lock key never run at the same time. Defaults to the dedupe key. */
  lockKey?: string;
  maxAttempts?: number;
}

export interface JobRow {
  id: string;
  kind: JobKind;
  user_id: string | null;
  payload: Record<string, unknown>;
  status: "pending" | "running" | "failed" | "parked";
  run_at: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  dedupe_key: string | null;
  lock_key: string | null;
}

/** DB-backed job queue. The worker (worker.ts) claims and runs what this enqueues. */
export class JobQueue {
  private wakers = new Set<() => void>();

  constructor(private readonly clock: Clock) {}

  /** Lets the worker react to new jobs immediately instead of waiting for its next poll. */
  onEnqueue(fn: () => void): () => void {
    this.wakers.add(fn);
    return () => this.wakers.delete(fn);
  }

  async enqueue(q: Queryable, o: EnqueueOptions): Promise<void> {
    const now = this.clock.now();
    await q.query(
      `INSERT INTO jobs (id, kind, user_id, payload, status, run_at, max_attempts, dedupe_key, lock_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, 'pending', $5, $6, $7, $8, $9, $9)
       ON CONFLICT (dedupe_key) WHERE status = 'pending'
       DO UPDATE SET run_at = LEAST(jobs.run_at, EXCLUDED.run_at),
                     payload = jobs.payload || EXCLUDED.payload,
                     updated_at = EXCLUDED.updated_at`,
      [
        randomUUID(),
        o.kind,
        o.userId,
        json(o.payload ?? {}),
        o.runAt ?? now,
        o.maxAttempts ?? 5,
        o.dedupeKey ?? null,
        o.lockKey ?? o.dedupeKey ?? null,
        now,
      ],
    );
    for (const w of this.wakers) w();
  }

  /** Claims the next due job whose lock is free, or null. */
  async claim(db: Db, kinds?: readonly JobKind[]): Promise<JobRow | null> {
    const now = this.clock.now();
    const rows = await db.query<JobRow>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = $1, updated_at = $1
       WHERE id = (
         SELECT j.id FROM jobs j
         WHERE j.status = 'pending' AND j.run_at <= $1
           AND ($2::text[] IS NULL OR j.kind = ANY($2::text[]))
           AND (j.lock_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM jobs r WHERE r.status = 'running' AND r.lock_key = j.lock_key))
         ORDER BY j.run_at, j.created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
       RETURNING id, kind, user_id, payload, status, run_at, attempts, max_attempts, last_error, dedupe_key, lock_key`,
      [now, kinds ? [...kinds] : null],
    );
    return rows[0] ?? null;
  }

  async complete(db: Queryable, job: JobRow): Promise<void> {
    await db.query("DELETE FROM jobs WHERE id = $1", [job.id]);
  }

  /** Puts a running job back to pending after `delayMs`; folds into an already pending twin. */
  async retry(db: Db, job: JobRow, error: string, delayMs: number): Promise<void> {
    const now = this.clock.now();
    await db.tx(async (q) => {
      if (job.dedupe_key) {
        const twin = await q.query<{ id: string }>(
          "UPDATE jobs SET run_at = LEAST(run_at, $2) WHERE dedupe_key = $1 AND status = 'pending' RETURNING id",
          [job.dedupe_key, now + delayMs],
        );
        if (twin.length > 0) {
          await q.query("DELETE FROM jobs WHERE id = $1", [job.id]);
          return;
        }
      }
      await q.query(
        "UPDATE jobs SET status = 'pending', run_at = $2, last_error = $3, updated_at = $4 WHERE id = $1",
        [job.id, now + delayMs, error.slice(0, 1000), now],
      );
    });
  }

  async fail(db: Queryable, job: JobRow, error: string): Promise<void> {
    await db.query(
      "UPDATE jobs SET status = 'failed', last_error = $2, updated_at = $3 WHERE id = $1",
      [job.id, error.slice(0, 1000), this.clock.now()],
    );
  }

  /** Parks a job that cannot make progress until the user changes something (e.g. configures STT). */
  async park(db: Queryable, job: JobRow, reason: string): Promise<void> {
    await db.query(
      "UPDATE jobs SET status = 'parked', attempts = 0, last_error = $2, updated_at = $3 WHERE id = $1",
      [job.id, reason, this.clock.now()],
    );
  }

  async unpark(q: Queryable, userId: string, kind: JobKind): Promise<number> {
    const now = this.clock.now();
    const rows = await q.query(
      "UPDATE jobs SET status = 'pending', run_at = $3, updated_at = $3 WHERE user_id = $1 AND kind = $2 AND status = 'parked' RETURNING id",
      [userId, kind, now],
    );
    if (rows.length > 0) for (const w of this.wakers) w();
    return rows.length;
  }

  /** Jobs left "running" by a crash go back to pending (single server instance assumed). */
  async recover(db: Db): Promise<number> {
    return db.tx(async (q) => {
      await q.query(
        `DELETE FROM jobs r WHERE r.status = 'running' AND r.dedupe_key IS NOT NULL
           AND EXISTS (SELECT 1 FROM jobs p WHERE p.status = 'pending' AND p.dedupe_key = r.dedupe_key)`,
      );
      const rows = await q.query(
        "UPDATE jobs SET status = 'pending', updated_at = $1 WHERE status = 'running' RETURNING id",
        [this.clock.now()],
      );
      return rows.length;
    });
  }
}
