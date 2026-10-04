import pg from 'pg';
import type { Db, Queryable, QueryResult } from './types.js';

// timestamptz (1184) -> ISO strings are handled by JSON; keep Date objects, but make int8 numbers.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    // Guard against runaway queries (e.g. an expensive user supplied search).
    statement_timeout: 15_000,
  });

  const wrap = (client: pg.Pool | pg.PoolClient): Queryable => ({
    async query<R>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
      const res = await client.query(sql, params);
      return { rows: res.rows as R[], rowCount: res.rowCount ?? 0 };
    },
  });

  return {
    ...wrap(pool),
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
