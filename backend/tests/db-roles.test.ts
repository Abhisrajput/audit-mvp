import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { connectPg, type Db } from '../src/db';
import { createApiLogin } from '../src/db/api-login';
import { AuditService } from '../src/service';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { testDbWithUrl } from './db';
import { LENIENT, registry } from './helpers';
import { devAuthConfig, devSign, draftFinding, signIn } from './http';

/** What the API's role may do with each table. A table missing here fails the inventory test until it is classified. */
const PRIVILEGES: Record<string, 'read' | 'append' | 'write'> = {
  engagements: 'write', engagement_work: 'write', findings: 'write', users: 'write', sessions: 'write', sign_intents: 'write',
  trail: 'append', signatures: 'append', finding_revisions: 'append', documents: 'append', document_text: 'append', chunks: 'append',
  blob_uploads: 'append', eval_runs: 'append',
  kg_nodes: 'read', kg_node_versions: 'read', kg_edges: 'read', schema_migrations: 'read',
};

const opened: Db[] = [];
afterAll(async () => Promise.all(opened.splice(0).map((d) => d.close())));

/** A fresh database, plus a connection to it as a new login that is a member of audit_api. */
async function asApiRole() {
  const { db: owner, url } = await testDbWithUrl();
  const name = `api_${crypto.randomBytes(4).toString('hex')}`;
  const password = crypto.randomBytes(16).toString('hex');
  expect(await createApiLogin(owner, name, password)).toBe('created');
  const u = new URL(url);
  u.username = name;
  u.password = password;
  const api = connectPg(u.toString());
  opened.push(api);
  return { owner, api, name, password };
}

describe('the API database role', () => {
  it('classifies every table, and grants nothing beyond that [REQ-20]', async () => {
    const { owner } = await asApiRole();
    const tables = (await sql<{ t: string }>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`.execute(owner.kysely)).rows.map((r) => r.t).sort();
    expect(tables).toEqual(Object.keys(PRIVILEGES).sort());
    for (const [table, kind] of Object.entries(PRIVILEGES)) {
      const can = async (p: string) => (await sql<{ ok: boolean }>`SELECT has_table_privilege('audit_api', ${`public.${table}`}, ${p}) AS ok`.execute(owner.kysely)).rows[0].ok;
      expect({ table, select: await can('SELECT'), insert: await can('INSERT'), update: await can('UPDATE') }).toEqual({
        table, select: true, insert: kind !== 'read', update: kind === 'write',
      });
      for (const p of ['DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) expect({ table, p, ok: await can(p) }).toEqual({ table, p, ok: false });
    }
    // Inserting a finding draws its seq from a sequence (001: findings.seq bigserial).
    expect((await sql<{ ok: boolean }>`SELECT has_sequence_privilege('audit_api', 'public.findings_seq_seq', 'USAGE') AS ok`.execute(owner.kysely)).rows[0].ok).toBe(true);
  });

  it('cannot change, delete or unprotect the trail and signatures, even bypassing the application [REQ-20]', async () => {
    const { api } = await asApiRole();
    for (const statement of [
      'UPDATE trail SET actor = actor', 'DELETE FROM trail', 'TRUNCATE trail', 'UPDATE signatures SET comment = comment', 'DELETE FROM signatures',
      'UPDATE finding_revisions SET revision = revision', 'UPDATE kg_nodes SET title = title', 'DELETE FROM sessions',
      'ALTER TABLE trail DISABLE TRIGGER trail_append_only', 'DROP TRIGGER signatures_append_only ON signatures', 'CREATE TABLE scratch (a int)',
    ]) {
      await expect(api.execScript(statement), statement).rejects.toThrow(/permission denied|must be (the )?owner/);
    }
  });

  it('runs the whole application as that role: sign-in, the chain, signatures, documents, search and eval [REQ-20]', async () => {
    const { api } = await asApiRole();
    const svc = new AuditService(api, registry, null, LENIENT);
    await ensureDevUsers(api.kysely);
    const blobs = new LocalBlobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'api-role-')));
    const app = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs, maxUploadBytes: 1024 * 1024, presignDownloads: false });

    const { id, fid, auditor } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    expect((await devSign(reviewer, 'reviewer', id, fid, 'review')).status!.status).toBe('signed');
    const approver = await signIn(app, 'approver');
    expect((await devSign(approver, 'approver', id, fid, 'approve')).status!.status).toBe('signed');

    const up = await auditor.agent.put('/api/blobs').set('x-csrf-token', auditor.csrf).set('Content-Type', 'text/plain').send(Buffer.from('Cleaning SOP: wipe down every shift.')).expect(201);
    await auditor.post('/api/documents', { sha256: up.body.sha256, filename: 'sop.txt', mime: 'text/plain', kind: 'sop', classification: 'internal', text: { content: 'Cleaning SOP: wipe down every shift.' } }).expect(201);
    expect((await auditor.get('/api/knowledge/search?q=cleaning').expect(200)).body.length).toBeGreaterThan(0);
    await auditor.get(`/api/engagements/${id}/report.md`).expect(404);
    await auditor.post(`/api/engagements/${id}/modules/report/run`).expect(200);
    await auditor.post('/api/eval/run').expect(200);
    expect((await auditor.get('/api/trail/verify').expect(200)).body.valid).toBe(true);
  }, 120_000);

  it('creates the login once and only changes its password afterwards; never touches other roles [REQ-20]', async () => {
    const { owner, name } = await asApiRole();
    expect(await createApiLogin(owner, name, crypto.randomBytes(16).toString('hex'))).toBe('updated');
    await expect(createApiLogin(owner, 'Bad Name;', 'x'.repeat(20))).rejects.toThrow(/name/);
    await expect(createApiLogin(owner, `api_${crypto.randomBytes(4).toString('hex')}`, 'short')).rejects.toThrow(/at least 16/);
    const ownerName = (await sql<{ u: string }>`SELECT current_user AS u`.execute(owner.kysely)).rows[0].u;
    await expect(createApiLogin(owner, ownerName, 'x'.repeat(20))).rejects.toThrow(/choose a new name/);
  });

  it('refuses to re-password any existing role that is not a login this tool made [REQ-20]', async () => {
    const { owner } = await asApiRole();
    const ownerName = (await sql<{ u: string }>`SELECT current_user AS u`.execute(owner.kysely)).rows[0].u;
    const x = (p: string) => `${p}_${crypto.randomBytes(4).toString('hex')}`;
    const inOwner = x('member_of_owner');
    const plain = x('plain');
    const repl = x('repl');
    await owner.execScript(`CREATE ROLE ${inOwner} NOLOGIN; GRANT "${ownerName}" TO ${inOwner}; CREATE ROLE ${plain} NOLOGIN; CREATE ROLE ${repl} NOLOGIN REPLICATION;`);
    for (const name of [inOwner, plain, repl]) await expect(createApiLogin(owner, name, 'x'.repeat(20)), name).rejects.toThrow(/choose a new name/);
  });
});
