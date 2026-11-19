import { join } from "node:path";
import type { Config } from "../config.js";
import { migrate } from "./migrate.js";
import type { Db } from "./types.js";

export type { Db, Queryable } from "./types.js";

/** Opens PostgreSQL (DATABASE_URL) or the embedded PGlite under LTM_DATA_DIR/pg, then migrates. */
export async function openDatabase(config: Pick<Config, "databaseUrl" | "dataDir">): Promise<Db> {
  let db: Db;
  if (config.databaseUrl) {
    const { openPg } = await import("./pg.js");
    db = await openPg(config.databaseUrl);
  } else {
    const { openPglite } = await import("./pglite.js");
    db = await openPglite(join(config.dataDir, "pg"));
  }
  try {
    await migrate(db);
  } catch (err) {
    await db.close().catch(() => {});
    throw err;
  }
  return db;
}
