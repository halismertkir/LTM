import { ConfigError, loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { type ProviderFactory, systemClock } from "./deps.js";
import { createLogger } from "./log.js";
import { createServer } from "./server.js";

async function productionProviders(): Promise<ProviderFactory> {
  const p = await import("@ltm/providers");
  return {
    createLlm: p.createLlmProvider,
    createStt: p.createSttProvider,
    createEmbedding: p.createEmbeddingProvider,
    probe: p.probeProvider,
    catalog: (options) => p.buildProviderCatalog(options),
  };
}

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  const log = createLogger(config.logLevel);
  log.info(
    {
      dataDir: config.dataDir,
      database: config.databaseUrl ? "postgres" : "pglite",
      web: config.webDir ?? "none",
    },
    "starting LTM server",
  );
  const db = await openDatabase(config);
  const server = await createServer({
    config,
    db,
    clock: systemClock,
    log,
    providers: await productionProviders(),
  });
  await server.worker.start();
  const url = await server.listen();
  log.info({ url }, "listening");

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    server
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        log.error({ err: (err as Error).message }, "shutdown failed");
        process.exit(1);
      });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
