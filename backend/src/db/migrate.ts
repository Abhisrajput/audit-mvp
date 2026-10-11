import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'kysely';
import type { Db } from './index';

// Plain, reviewed SQL files applied in name order, each in its own transaction.
// Run by the `migrate` command only; the API never migrates on start-up.

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const NAME = /^\d{3}_[a-z0-9_]+\.sql$/;

export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return fs.readdirSync(dir).filter((f) => NAME.test(f)).sort();
}

async function appliedNames(db: Db): Promise<Set<string>> {
  const { rows } = await sql<{ t: string | null }>`select to_regclass('schema_migrations')::text as t`.execute(db.kysely);
  if (!rows[0]?.t) return new Set();
  const done = await db.kysely.selectFrom('schema_migrations').select('name').execute();
  return new Set(done.map((r) => r.name));
}

export async function pendingMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const done = await appliedNames(db);
  return migrationFiles(dir).filter((f) => !done.has(f));
}

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.execScript('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied: string[] = [];
  for (const file of await pendingMigrations(db, dir)) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    // file matches NAME, so it is safe to inline.
    await db.execScript(`BEGIN;\n${body}\n;\nINSERT INTO schema_migrations (name) VALUES ('${file}');\nCOMMIT;`);
    applied.push(file);
  }
  return applied;
}
