import pg from "pg";
import type { Db, Queryable } from "./types.js";

/** External PostgreSQL through a node-postgres pool. */
export async function openPg(connectionString: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client losing its connection (server restart, admin kill) emits "error" on the
  // pool; unhandled, that would crash the process. The pool replaces the client on next use.
  pool.on("error", () => {});
  // Fail fast with a clear message instead of on the first request.
  const client = await pool.connect();
  client.release();
  const run = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query<T>(sql: string, params?: readonly unknown[]) {
      const res = await c.query(sql, params ? [...params] : undefined);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await c.query(sql);
    },
  });
  const base = run(pool);
  return {
    dialect: "pg",
    query: base.query,
    exec: base.exec,
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const out = await fn(run(c));
        await c.query("COMMIT");
        return out;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
