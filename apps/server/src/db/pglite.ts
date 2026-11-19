import { mkdirSync } from "node:fs";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Db, Queryable } from "./types.js";

function wrap(q: PGlite | Transaction): Queryable {
  return {
    async query<T>(sql: string, params?: readonly unknown[]) {
      const res = await q.query<T>(sql, params ? [...params] : undefined);
      return res.rows;
    },
    async exec(sql: string) {
      await q.exec(sql);
    },
  };
}

/** Embedded Postgres (WASM). `dataDir` null → in-memory (tests). */
export async function openPglite(dataDir: string | null): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const pg = await PGlite.create(dataDir ?? undefined, { extensions: { vector } });
  return fromPglite(pg);
}

export function fromPglite(pg: PGlite): Db {
  const base = wrap(pg);
  return {
    dialect: "pglite",
    query: base.query,
    exec: base.exec,
    tx(fn) {
      return pg.transaction((t) => fn(wrap(t)));
    },
    async close() {
      if (!pg.closed) await pg.close();
    },
  };
}
