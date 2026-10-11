import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import type { Db } from './index';
import { migrate } from './migrate';
import type { DB } from './schema';

// An in-process Postgres (PGlite) used by the evaluation harness, so eval runs
// never write to the operational database or its audit trail. PGlite is a
// single connection, so connections are handed out one at a time. Inside a
// transaction every query must use the transaction handle: a query through
// db.kysely there would wait for the held connection and deadlock.

const commandOf = (text: string) => text.trimStart().split(/\s/, 1)[0].toUpperCase();

export async function createMemoryDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite();
  await pglite.waitReady;

  let queue: Promise<void> = Promise.resolve();
  const pool = {
    async connect() {
      let release!: () => void;
      const turn = new Promise<void>((resolve) => (release = resolve));
      const previous = queue;
      queue = previous.then(() => turn);
      await previous;
      return {
        async query(text: string, params: unknown[] = []) {
          const r = await pglite.query<Record<string, unknown>>(text, params as never[]);
          return { command: commandOf(text), rowCount: r.affectedRows ?? r.rows.length, rows: r.rows };
        },
        release,
      };
    },
    async end() {
      await pglite.close();
    },
  };

  const db: Db = {
    kysely: new Kysely<DB>({ dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }) }),
    async execScript(script) {
      try {
        await pglite.exec(script);
      } catch (err) {
        await pglite.exec('ROLLBACK').catch(() => undefined);
        throw err;
      }
    },
    close: () => db.kysely.destroy(),
  };
  await migrate(db);
  return db;
}
