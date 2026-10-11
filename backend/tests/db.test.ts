import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../src/db/pglite';
import { migrate, migrationFiles, pendingMigrations } from '../src/db/migrate';
import { emptyDb, testDb } from './db';
import { connectPg } from '../src/db';
import { inject } from 'vitest';
import { withDatabase } from './db-url';

const trailRow = (seq: number) => ({
  seq, id: `B-${seq}`, engagement_id: 'ENG-1', module_id: 'scope', actor: 'auditor',
  prev_hash: '0'.repeat(64), hash: String(seq).padStart(64, 'a'), body: '{}',
});

describe('migrations', () => {
  it('applies every migration once and reports none pending afterwards', async () => {
    const db = await emptyDb();
    expect(await pendingMigrations(db)).toEqual(migrationFiles());
    expect(await migrate(db)).toEqual(migrationFiles());
    expect(await migrate(db)).toEqual([]);
    expect(await pendingMigrations(db)).toEqual([]);
  });

  it('runs the same migrations on the in-process database used by eval', async () => {
    const mem = await createMemoryDb();
    try {
      expect(await pendingMigrations(mem)).toEqual([]);
      await mem.kysely.insertInto('trail').values(trailRow(1)).execute();
      await expect(mem.kysely.deleteFrom('trail').execute()).rejects.toThrow(/append-only/);
    } finally {
      await mem.close();
    }
  });
});

describe('database-enforced integrity', () => {
  it('rejects UPDATE, DELETE and TRUNCATE on the audit trail [REQ-20]', async () => {
    const db = (await testDb()).kysely;
    await db.insertInto('trail').values(trailRow(1)).execute();
    await expect(db.updateTable('trail').set({ actor: 'mallory' }).where('seq', '=', 1).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.deleteFrom('trail').where('seq', '=', 1).execute()).rejects.toThrow(/append-only: DELETE/);
    await expect(sql`TRUNCATE trail`.execute(db)).rejects.toThrow(/append-only: TRUNCATE/);
    expect((await db.selectFrom('trail').select('actor').executeTakeFirstOrThrow()).actor).toBe('auditor');
  });

  it('rejects any change to an approved finding at the database level [REQ-09, REQ-20]', async () => {
    const db = (await testDb()).kysely;
    await db.insertInto('engagements').values({
      id: 'ENG-1', name: 'n', entity: 'e', site: 's', period_from: 'a', period_to: 'b', audit_type: 't',
      scope_statement: 's', pack_ids: '["common"]', created_by: 'auditor', created_at: new Date().toISOString(), stage: 'findings',
    }).execute();
    const base = { engagement_id: 'ENG-1', row_id: 'R', control_id: 'C', rating: 'High' as const, data: '{}' };
    await db.insertInto('findings').values([{ ...base, id: 'F-1', status: 'reviewed' }, { ...base, id: 'F-2', status: 'approved' }]).execute();
    await db.updateTable('findings').set({ status: 'approved' }).where('id', '=', 'F-1').execute();
    await expect(db.updateTable('findings').set({ rating: 'Low' }).where('id', '=', 'F-2').execute()).rejects.toThrow(/locked/);
    await expect(db.deleteFrom('findings').where('id', '=', 'F-2').execute()).rejects.toThrow(/locked/);
  });
});

describe('pool resilience', () => {
  it('survives the server killing idle connections without crashing', async () => {
    const adminUrl = inject('pgAdminUrl');
    const name = `r_${process.pid}_${Date.now()}`;
    const admin = connectPg(adminUrl, { max: 1 });
    await admin.execScript(`CREATE DATABASE ${name}`);
    const db = connectPg(withDatabase(adminUrl, name), { max: 2 });
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      await sql`SELECT 1`.execute(db.kysely);
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid()`.execute(admin.kysely);
      await new Promise((r) => setTimeout(r, 300));
      const r = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(db.kysely);
      expect(r.rows[0].ok).toBe(1);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      await db.close();
      await admin.execScript(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.close();
    }
  });
});
