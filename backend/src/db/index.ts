import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './schema';

// int8 (counts, bigserial) as numbers; values in this application stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export interface Db {
  kysely: Kysely<DB>;
  /** Runs a multi-statement SQL script on one connection; rolls back on failure. */
  execScript(script: string): Promise<void>;
  close(): Promise<void>;
}

export function connectPg(connectionString: string, opts: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  const kysely = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    kysely,
    async execScript(script) {
      const client = await pool.connect();
      try {
        await client.query(script);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await kysely.destroy();
      // kysely only ends the pool once it has run a query itself; execScript uses the pool directly.
      if (!pool.ended) await pool.end();
    },
  };
}
