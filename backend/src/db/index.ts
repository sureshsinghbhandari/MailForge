import { createPgDb } from './pg.js';
import type { Db, Queryable, QueryResult } from './types.js';

export type { Db, Queryable, QueryResult } from './types.js';

/**
 * `postgresql://…` -> PostgreSQL via `pg` (production and Docker).
 * `pglite://<dir>` or `pglite://memory` -> embedded PostgreSQL (WASM) for tests and Docker-free local dev.
 */
export async function createDb(url: string): Promise<Db> {
  if (url.startsWith('pglite://')) return createPgliteDb(url.slice('pglite://'.length));
  return createPgDb(url);
}

async function createPgliteDb(location: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite(location === 'memory' || location === '' ? undefined : location);
  await pg.waitReady;

  type Executor = Pick<typeof pg, 'query' | 'exec'>;
  const wrap = (exec: Executor): Queryable => ({
    async query<R>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
      if (!params || params.length === 0) {
        // exec() supports multi-statement scripts (migrations); results come back per statement.
        const results = await exec.exec(sql);
        const last = results[results.length - 1];
        const rows = (last?.rows ?? []) as R[];
        return { rows, rowCount: Math.max(rows.length, last?.affectedRows ?? 0) };
      }
      const res = await exec.query<R>(sql, params);
      return { rows: res.rows, rowCount: Math.max(res.rows.length, res.affectedRows ?? 0) };
    },
  });

  return {
    ...wrap(pg),
    tx: (fn) => pg.transaction((tx) => fn(wrap(tx as unknown as Executor))),
    close: () => pg.close(),
  };
}
