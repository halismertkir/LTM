import type { Ctx } from "../context.js";
import { isProviderError } from "../errors.js";
import type { JobKind, JobRow } from "./jobs.js";

/** `{ park }` leaves the job parked until something (settings) unparks it. */
export type JobOutcome = undefined | { park: string };

export interface JobHandler {
  run(ctx: Ctx, job: JobRow, signal: AbortSignal): Promise<JobOutcome | undefined>;
  /** Called once when the job is given up on (non-retryable error or attempts exhausted). */
  onFailed?(ctx: Ctx, job: JobRow, err: unknown): Promise<void>;
}

export type JobHandlers = Record<JobKind, JobHandler>;

/** Non-provider errors (bugs, a busy database) get a few tries; provider errors follow `retryable`. */
const GENERIC_MAX_ATTEMPTS = 3;

export function backoffMs(attempts: number): number {
  const base = Math.min(30 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function describe(err: unknown): string {
  if (isProviderError(err)) return `${err.provider}/${err.code}: ${err.message}`.slice(0, 300);
  const e = err as { message?: string; code?: string };
  return `${e.code ? `${e.code} ` : ""}${e.message ?? String(err)}`.slice(0, 300);
}

/**
 * In-process worker: claims due jobs with bounded concurrency. Jobs are rows, so a crash
 * loses nothing — `start()` puts jobs left "running" back to pending first.
 */
export class Worker {
  private running = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  private stopped = true;
  /** Set by stop(); distinct from "never started" (tests drive the worker by hand). */
  private shuttingDown = false;
  private timer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private pumping = false;
  private pumpAgain = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly handlers: JobHandlers,
    private readonly options: { concurrency: number; pollMs: number },
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    const recovered = await this.ctx.jobs.recover(this.ctx.db);
    if (recovered > 0)
      this.ctx.log.info({ recovered }, "re-queued jobs interrupted by a previous shutdown");
    this.unsubscribe = this.ctx.jobs.onEnqueue(() => this.kick());
    // Retention runs at boot and then hourly.
    await this.ctx.jobs.enqueue(this.ctx.db, {
      kind: "retention",
      userId: null,
      dedupeKey: "retention",
    });
    this.retentionTimer = setInterval(() => {
      this.ctx.jobs
        .enqueue(this.ctx.db, { kind: "retention", userId: null, dedupeKey: "retention" })
        .catch((err) => this.ctx.log.error({ err: describe(err) }, "could not schedule retention"));
    }, 3600_000);
    this.retentionTimer.unref();
    this.schedule();
    this.kick();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.kick();
      this.schedule();
    }, this.options.pollMs);
    this.timer.unref();
  }

  private kick(): void {
    if (this.stopped) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    void this.pump().finally(() => {
      this.pumping = false;
      if (this.pumpAgain) {
        this.pumpAgain = false;
        this.kick();
      }
    });
  }

  private async pump(): Promise<void> {
    while (!this.stopped && this.running.size < this.options.concurrency) {
      let job: JobRow | null;
      try {
        job = await this.ctx.jobs.claim(this.ctx.db);
      } catch (err) {
        this.ctx.log.error({ err: describe(err) }, "job claim failed");
        return;
      }
      if (!job) return;
      const abort = new AbortController();
      const j = job;
      const promise = this.execute(j, abort.signal).finally(() => {
        this.running.delete(j.id);
        this.kick();
      });
      this.running.set(j.id, { promise, abort });
    }
  }

  /** Runs one claimed job and records the outcome. Never throws. */
  async execute(job: JobRow, signal: AbortSignal): Promise<void> {
    const handler = this.handlers[job.kind];
    const log = this.ctx.log.child({ job: job.id, kind: job.kind, attempt: job.attempts });
    const started = Date.now();
    try {
      const outcome = await handler.run(this.ctx, job, signal);
      if (outcome && "park" in outcome) {
        await this.ctx.jobs.park(this.ctx.db, job, outcome.park);
        log.info({ reason: outcome.park }, "job parked");
      } else {
        await this.ctx.jobs.complete(this.ctx.db, job);
        log.debug({ ms: Date.now() - started }, "job done");
      }
    } catch (err) {
      await this.handleError(job, err, log).catch((e) =>
        log.error({ err: describe(e) }, "could not record job failure"),
      );
    }
  }

  private async handleError(job: JobRow, err: unknown, log: Ctx["log"]): Promise<void> {
    const retryable = isProviderError(err) ? err.retryable : true;
    const max = isProviderError(err)
      ? job.max_attempts
      : Math.min(job.max_attempts, GENERIC_MAX_ATTEMPTS);
    if (retryable && job.attempts < max && !this.shuttingDown) {
      const delay = backoffMs(job.attempts);
      log.warn({ err: describe(err), retryInMs: delay }, "job failed, will retry");
      await this.ctx.jobs.retry(this.ctx.db, job, describe(err), delay);
      return;
    }
    if (this.shuttingDown && retryable) {
      // Interrupted by shutdown: leave it for the next start.
      await this.ctx.jobs.retry(this.ctx.db, { ...job }, "interrupted by shutdown", 0);
      return;
    }
    log.error({ err: describe(err) }, "job failed permanently");
    await this.ctx.jobs.fail(this.ctx.db, job, describe(err));
    await this.handlers[job.kind].onFailed?.(this.ctx, job, err);
  }

  /** Stops claiming, aborts in-flight jobs after `graceMs`, and waits for them to settle. */
  async stop(graceMs = 10_000): Promise<void> {
    this.stopped = true;
    this.shuttingDown = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.unsubscribe?.();
    const all = [...this.running.values()];
    if (all.length === 0) return;
    const grace = new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref());
    await Promise.race([Promise.all(all.map((r) => r.promise)), grace]);
    for (const r of this.running.values()) r.abort.abort();
    await Promise.all([...this.running.values()].map((r) => r.promise));
  }

  /**
   * Test/maintenance helper: runs due jobs one at a time until none is due. With `advance`,
   * a manual clock is moved forward to the next pending job (up to `maxAdvanceMs` ahead).
   */
  async drain(
    options: {
      advance?: (toMs: number) => void;
      maxAdvanceMs?: number;
      maxJobs?: number;
      kinds?: JobKind[];
    } = {},
  ): Promise<number> {
    let count = 0;
    const limit = options.maxJobs ?? 500;
    const horizon = this.ctx.clock.now() + (options.maxAdvanceMs ?? 24 * 3600_000);
    while (count < limit) {
      const job = await this.ctx.jobs.claim(this.ctx.db, options.kinds);
      if (job) {
        await this.execute(job, new AbortController().signal);
        count++;
        continue;
      }
      if (!options.advance) break;
      const next = await this.ctx.db.query<{ run_at: number }>(
        `SELECT run_at FROM jobs WHERE status = 'pending' ${options.kinds ? "AND kind = ANY($1::text[])" : ""} ORDER BY run_at LIMIT 1`,
        options.kinds ? [options.kinds] : [],
      );
      const at = next[0]?.run_at;
      if (at === undefined || at > horizon) break;
      if (at > this.ctx.clock.now()) options.advance(at);
      else break;
    }
    return count;
  }
}
