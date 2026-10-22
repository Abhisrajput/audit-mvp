import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { listGates } from '../src/agents/gate-repo';
import { RULES_VERSION } from '../src/agents/policy/rules';
import { createRun, getRun, listSteps } from '../src/agents/run-repo';
import { AgentWorker } from '../src/agents/worker';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { connectPg, type Db } from '../src/db';
import { createApiLogin } from '../src/db/api-login';
import { listSignatures } from '../src/db/signature-repo';
import { AuditService } from '../src/service';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { testDbWithUrl } from './db';
import { auditor, LENIENT, NEW_ENGAGEMENT, registry, reviewer, unattended } from './helpers';
import { devAuthConfig, devSign, draftFinding, signIn } from './http';

/** What the API's role may do with each table. A table missing here fails the inventory test until it is classified. */
const PRIVILEGES: Record<string, 'read' | 'append' | 'write'> = {
  engagements: 'write', engagement_work: 'write', findings: 'write', users: 'write', sessions: 'write', sign_intents: 'write', agent_runs: 'write', gates: 'write',
  agent_steps: 'append', workpaper_revisions: 'append', test_tolerances: 'append', finding_responses: 'append',
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
    expect((await sql<{ ok: boolean }>`SELECT has_sequence_privilege('audit_api', 'public.gates_seq_seq', 'USAGE') AS ok`.execute(owner.kysely)).rows[0].ok).toBe(true);
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

  it('runs agent work as that role: runs, steps, gates and gate signatures [REQ-20, REQ-26]', async () => {
    const { api } = await asApiRole();
    const svc = new AuditService(api, registry, null, LENIENT);
    await ensureDevUsers(api.kysely);
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const run = await createRun(api.kysely, { engagementId: e.id, startedBy: 'auditor', policy: 'rules', policyVersion: RULES_VERSION, budget: defaultAgentConfig().budget });
    const worker = new AgentWorker(svc, defaultAgentConfig(), { id: 'w-api-role' });
    await worker.drain();
    const [gate] = await listGates(api.kysely, e.id);
    await svc.signGate(gate.id, 'approve', 'In scope as proposed', reviewer, unattended);
    await worker.drain();
    expect(await getRun(api.kysely, run.id)).toMatchObject({ status: 'waiting', statusReason: 'awaiting rcm gate signature' });
    // The rows were really written under the API role: steps, the gate (now closed by the signature), and the signature itself.
    expect((await listSteps(api.kysely, run.id)).length).toBeGreaterThan(0);
    expect((await listGates(api.kysely, e.id)).find((g) => g.id === gate.id)).toMatchObject({ state: 'approved' });
    expect((await listSignatures(api.kysely, e.id)).map((s) => s.userId)).toContain('reviewer');
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

  it('refuses, before any role DDL, when the login running it cannot create or grant the API login [REQ-20]', async () => {
    const { db: owner, url } = await testDbWithUrl();
    const x = (p: string) => `${p}_${crypto.randomBytes(4).toString('hex')}`;
    const pw = crypto.randomBytes(16).toString('hex');
    const plain = x('no_createrole');
    const noAdmin = x('createrole_only');
    const admin = x('createrole_admin');
    await owner.execScript(`CREATE ROLE ${plain} LOGIN PASSWORD '${pw}'; CREATE ROLE ${noAdmin} LOGIN CREATEROLE PASSWORD '${pw}';
      CREATE ROLE ${admin} LOGIN CREATEROLE PASSWORD '${pw}'; GRANT audit_api TO ${admin} WITH ADMIN OPTION;`);
    const as = (name: string) => {
      const u = new URL(url);
      u.username = name;
      u.password = pw;
      const db = connectPg(u.toString());
      opened.push(db);
      return db;
    };
    const exists = async (name: string) => (await sql`SELECT 1 FROM pg_roles WHERE rolname = ${name}`.execute(owner.kysely)).rows.length > 0;
    const password = crypto.randomBytes(16).toString('hex');

    const target1 = x('api');
    const refused1 = await createApiLogin(as(plain), target1, password).catch((err: Error) => err);
    expect(refused1).toBeInstanceOf(Error);
    expect((refused1 as Error).message).toMatch(new RegExp(`${plain}.*CREATEROLE`));
    expect((refused1 as Error).message).not.toContain(password);
    expect(await exists(target1)).toBe(false);

    const target2 = x('api');
    const refused2 = await createApiLogin(as(noAdmin), target2, password).catch((err: Error) => err);
    expect((refused2 as Error).message).toMatch(new RegExp(`${noAdmin}.*ADMIN OPTION on audit_api`));
    expect(await exists(target2)).toBe(false);

    const target3 = x('api');
    expect(await createApiLogin(as(admin), target3, password)).toBe('created');
    expect(await createApiLogin(as(admin), target3, crypto.randomBytes(16).toString('hex'))).toBe('updated');
    // A CREATEROLE login without ADMIN OPTION on that login (it did not create it) may not re-password it either.
    const refused3 = await createApiLogin(as(noAdmin), target3, password).catch((err: Error) => err);
    expect((refused3 as Error).message).toMatch(new RegExp(`${noAdmin}.*ADMIN OPTION on ${target3}`));
  });
});
