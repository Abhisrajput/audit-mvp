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

export interface ConnectOptions {
  max?: number;
  connectionTimeoutMillis?: number;
  idle_in_transaction_session_timeout?: number;
  statement_timeout?: number;
}

export function connectPg(connectionString: string, opts: ConnectOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5000,
    idle_in_transaction_session_timeout: opts.idle_in_transaction_session_timeout ?? 60000,
    statement_timeout: opts.statement_timeout ?? 120000,
  });
  // A server restart or admin kill of an idle client emits 'error' on the pool; unhandled, it crashes the process.
  pool.on('error', (err) => console.error('Postgres pool error (idle client):', err.message));
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
