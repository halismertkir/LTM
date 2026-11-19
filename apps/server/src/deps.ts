import type { LiveEvent, ProviderCatalog } from "@ltm/protocol";
import type {
  EmbeddingProvider,
  LlmProvider,
  ProviderProbe,
  ResolvedProviderConfig,
  SttProvider,
} from "@ltm/providers";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { Db } from "./db/types.js";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * Everything the server needs from @ltm/providers. Production wiring passes the real
 * factories; tests pass scripted fakes. Only types are imported here so the server core
 * never depends on the provider runtime.
 */
export interface ProviderFactory {
  createLlm(config: ResolvedProviderConfig): LlmProvider;
  createStt(config: ResolvedProviderConfig): SttProvider;
  createEmbedding(config: ResolvedProviderConfig): EmbeddingProvider;
  probe(config: ResolvedProviderConfig): Promise<ProviderProbe>;
  catalog(options: { allowCli: boolean }): Promise<ProviderCatalog>;
}

/** The injectable base of the application. */
export interface Deps {
  config: Config;
  db: Db;
  clock: Clock;
  log: Logger;
  providers: ProviderFactory;
}

type Listener = (event: LiveEvent) => void;

/** In-process fan-out of live events per user (SSE subscribers). */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(userId: string, listener: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(userId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(userId);
    };
  }

  publish(userId: string, event: LiveEvent): void {
    const set = this.listeners.get(userId);
    if (!set) return;
    for (const l of [...set]) {
      try {
        l(event);
      } catch {
        // A broken subscriber must not affect the others.
      }
    }
  }

  subscriberCount(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }
}
