import type { FastifyInstance } from "fastify";
import type { Ctx } from "./context.js";
import { SecretBox } from "./crypto.js";
import { type Deps, EventBus } from "./deps.js";
import { buildApp } from "./http/app.js";
import { WsRegistry } from "./ingest/ws.js";
import { consolidateHandler } from "./pipeline/consolidate.js";
import { embedHandler } from "./pipeline/embed.js";
import { JobQueue } from "./pipeline/jobs.js";
import { mergeHandler } from "./pipeline/merge.js";
import { retentionHandler } from "./pipeline/retention.js";
import { transcribeHandler } from "./pipeline/transcribe.js";
import { type JobHandlers, Worker } from "./pipeline/worker.js";
import { AudioStore } from "./services/audio-store.js";

export const JOB_HANDLERS: JobHandlers = {
  transcribe: transcribeHandler,
  merge: mergeHandler,
  consolidate: consolidateHandler,
  embed: embedHandler,
  retention: retentionHandler,
};

export interface Server {
  ctx: Ctx;
  app: FastifyInstance;
  worker: Worker;
  ws: WsRegistry;
  /** Listens on config host/port (port 0 → ephemeral) and returns the base URL. */
  listen(): Promise<string>;
  /** Graceful shutdown: stop accepting, flush sockets, let jobs finish, close the database. */
  close(): Promise<void>;
}

/**
 * Wires the application from injected dependencies. The worker is created but not
 * started: production calls `worker.start()`, tests drive it with `worker.drain()`.
 */
export async function createServer(deps: Deps): Promise<Server> {
  const ctx = {
    ...deps,
    bus: new EventBus(),
    secrets: new SecretBox(deps.config.secretKey, "provider-api-keys"),
    audio: new AudioStore(deps.config.dataDir),
    jobs: new JobQueue(deps.clock),
  } as Ctx;
  const ws = new WsRegistry(ctx);
  ctx.live = ws;
  const app = await buildApp(ctx, { ws });
  const worker = new Worker(ctx, JOB_HANDLERS, {
    concurrency: deps.config.tuning.workerConcurrency,
    pollMs: deps.config.tuning.workerPollMs,
  });
  let closed = false;
  return {
    ctx,
    app,
    worker,
    ws,
    async listen() {
      return app.listen({ host: deps.config.host, port: deps.config.port });
    },
    async close() {
      if (closed) return;
      closed = true;
      await ws.shutdown();
      await app.close();
      await worker.stop();
      await deps.db.close();
    },
  };
}
