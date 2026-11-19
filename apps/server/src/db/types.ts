/** Anything that can run one parameterised statement: the pool/database or an open transaction. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs several statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly dialect: "pglite" | "pg";
  /**
   * Runs `fn` inside a transaction. Inside `fn` use ONLY the handle passed in: on PGlite
   * the database is single-connection and a query on the outer handle would wait forever.
   */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** First row or null. */
export async function one<T>(
  q: Queryable,
  sql: string,
  params?: readonly unknown[],
): Promise<T | null> {
  const rows = await q.query<T>(sql, params);
  return rows[0] ?? null;
}

/** Serialises a value for a `$n::jsonb` parameter. */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Serialises a vector for a `$n::vector` parameter. */
export function vectorLiteral(values: readonly number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v : 0)).join(",")}]`;
}
