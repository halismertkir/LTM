import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./types.js";

/**
 * Finds the migrations directory both when running from source (src/db → ../../migrations)
 * and from the bundle (dist/main.js → ./migrations).
 */
export function findMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.LTM_MIGRATIONS_DIR,
    join(here, "migrations"),
    resolve(here, "../../migrations"),
    resolve(here, "../migrations"),
  ].filter((c): c is string => !!c);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`migrations directory not found (looked in ${candidates.join(", ")})`);
}

export interface Migration {
  name: string;
  sql: string;
}

export function loadMigrations(dir = findMigrationsDir()): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** Applies pending migrations in order, each in its own transaction. Returns the names applied. */
export async function migrate(db: Db, migrations = loadMigrations()): Promise<string[]> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at double precision NOT NULL)",
  );
  const done = new Set(
    (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    try {
      await db.tx(async (q) => {
        // Multi-statement SQL cannot be sent with parameters; run it as a simple query.
        await q.exec(m.sql);
        await q.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [
          m.name,
          Date.now(),
        ]);
      });
    } catch (err) {
      const msg = (err as Error).message;
      const hint = /extension "vector"|vector\.control/i.test(msg)
        ? " — the PostgreSQL server needs the pgvector extension (https://github.com/pgvector/pgvector)"
        : "";
      throw new Error(`migration ${m.name} failed: ${msg}${hint}`, { cause: err });
    }
    applied.push(m.name);
  }
  return applied;
}
