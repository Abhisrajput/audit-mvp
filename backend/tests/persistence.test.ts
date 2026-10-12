import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { importJson } from '../src/db/import-json';
import { migrate, pendingMigrations } from '../src/db/migrate';
import { readTrail } from '../src/db/trail-repo';
import { verifyChain } from '../src/engine/trail';
import { AuditService } from '../src/service';
import { emptyDb, testDb } from './db';
import { auditor, engagementWithFailedControl, newService, registry, reviewer } from './helpers';

/** Builds an MVP-format db.json (engagements + trail + evalRuns) from a real run. */
async function mvpExport() {
  const svc = await newService();
  const e = await engagementWithFailedControl(svc);
  await svc.signOff(e.id, e.findings[0].id, 'review', 'ok', reviewer);
  const engagement = await svc.engagement(e.id);
  delete engagement.version; // MVP files have no version field
  const data = { engagements: [engagement], trail: await readTrail(svc.db.kysely), evalRuns: [] };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-')), 'db.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { file, data };
}

describe('import-json', () => {
  it('imports an MVP data file with the original chain intact', async () => {
    const { file, data } = await mvpExport();
    const target = await testDb();
    const counts = await importJson(target, file);
    expect(counts).toEqual({ engagements: 1, trail: data.trail.length, evalRuns: 0 });
    const imported = await readTrail(target.kysely);
    expect(imported.map((b) => b.hash)).toEqual(data.trail.map((b) => b.hash));
    expect(verifyChain(imported).valid).toBe(true);

    // The imported engagement is live: work continues on top of the imported chain.
    const svc = new AuditService(target, registry, null);
    await svc.setScope(data.engagements[0].id, [{ controlId: 'FD-HACCP-03', included: true }], auditor);
    expect((await svc.verifyTrail()).valid).toBe(true);
  });

  it('refuses a tampered file and writes nothing', async () => {
    const { file, data } = await mvpExport();
    (data.trail[1].output as any) = { tampered: true };
    fs.writeFileSync(file, JSON.stringify(data));
    const target = await testDb();
    await expect(importJson(target, file)).rejects.toThrow(/broken at bundle 2/);
    expect(await target.kysely.selectFrom('engagements').select('id').execute()).toEqual([]);
    expect(await readTrail(target.kysely)).toEqual([]);
  });

  it('refuses to import into a database that already has data', async () => {
    const { file } = await mvpExport();
    const target = await testDb();
    await importJson(target, file);
    await expect(importJson(target, file)).rejects.toThrow(/already has/);
  });
});

describe('start-up safety', () => {
  it('refuses to start without a valid DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/postgres:\/\//);
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', PORT: '4000' })).toEqual({ port: 4000, databaseUrl: 'postgres://u:p@h:5432/d', packsDir: undefined });
  });

  it('reports unapplied migrations instead of applying them', async () => {
    const db = await emptyDb();
    expect((await pendingMigrations(db)).length).toBeGreaterThan(0);
    const tables = await db.kysely.introspection.getTables();
    expect(tables).toEqual([]);
    await migrate(db);
    expect(await pendingMigrations(db)).toEqual([]);
  });
});
