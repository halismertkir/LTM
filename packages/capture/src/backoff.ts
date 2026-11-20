export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** 0..1 — share of the delay that is randomised ("equal jitter" when 0.5). */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.5,
};

/**
 * Delay before reconnect attempt `attempt` (0-based). Jitter keeps a fleet of clients that
 * lost the server at the same moment (server restart) from reconnecting in lockstep.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions, random: () => number): number {
  const base = Math.min(opts.maxMs, opts.initialMs * opts.factor ** Math.max(0, attempt));
  const fixed = base * (1 - opts.jitter);
  return Math.round(fixed + base * opts.jitter * random());
}
