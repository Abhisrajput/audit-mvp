import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { stripTlsParams, type DatabaseSsl } from '../config';
import { logger } from '../observability/log';
import type { DB } from './schema';

// int8 (counts, bigserial) as numbers; values in this application stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// date as the 'YYYY-MM-DD' string it is: parsing it into a Date at local midnight shifts it a day east of UTC.
pg.types.setTypeParser(1082, (v) => v);

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
  /** TLS for the connection (DATABASE_SSL); false = plain TCP (development and tests only). */
  ssl?: DatabaseSsl;
}

/**
 * The pool settings for a connection URL. node-postgres lets the URL's own TLS parameters (ssl=, sslmode=, sslcert=, ...)
 * replace `ssl`, so they are stripped here as well as refused by the configuration: TLS comes from DATABASE_SSL only.
 */
export function poolConfig(connectionString: string, opts: ConnectOptions = {}): pg.PoolConfig {
  return {
    connectionString: stripTlsParams(connectionString),
    max: opts.max ?? 10,
    ssl: opts.ssl ?? false,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5000,
    idle_in_transaction_session_timeout: opts.idle_in_transaction_session_timeout ?? 60000,
    statement_timeout: opts.statement_timeout ?? 120000,
  };
}

export function connectPg(connectionString: string, opts: ConnectOptions = {}): Db {
  const pool = new pg.Pool(poolConfig(connectionString, opts));
  // A server restart or admin kill of an idle client emits 'error' on the pool; unhandled, it crashes the process.
  pool.on('error', (err) => logger.error({ err: err.message }, 'Postgres pool error (idle client)'));
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
