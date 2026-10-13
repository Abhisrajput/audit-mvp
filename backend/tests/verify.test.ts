import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { listSteps } from '../src/agents/run-repo';
import { startRun } from '../src/agents/runs';
import { AgentWorker } from '../src/agents/worker';
import { readTrail } from '../src/db/trail-repo';
import { insertDocument } from '../src/knowledge/document-repo';
import { recordDocumentEvent } from '../src/knowledge/trail';
import { verifyIntegrity } from '../src/ops/verify';
import { AuditService } from '../src/service';
import { blobKey } from '../src/storage/blob-store';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { ensureDevUsers } from '../src/auth/dev-users';
import { testDbWithUrl } from './db';
import { approver, auditor, engagementWithFailedControl, LENIENT, NEW_ENGAGEMENT, newService, registry, reviewer, unattended } from './helpers';

/** A database with an approved, signed finding and two stored documents, and the local store holding their bytes. */
async function restoredSystem() {
  const { db, url } = await testDbWithUrl();
  const svc = new AuditService(db, registry, null, LENIENT);
  await ensureDevUsers(db.kysely);
  const e = await engagementWithFailedControl(svc);
  const fid = e.findings[0].id;
  await svc.signOff(e.id, fid, 'review', 'ok', reviewer, {}, unattended);
  await svc.signOff(e.id, fid, 'approve', 'ok', approver, {}, unattended);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-blobs-'));
  const blobs = new LocalBlobStore(dir);
  const docs = [];
  for (const text of ['SOP-001 cleaning procedure', 'Batch record template']) {
    const stored = await blobs.put(Buffer.from(text));
    // As POST /api/documents does: the row and its sealed document:register trail entry in one transaction.
    docs.push(await db.kysely.transaction().execute(async (trx) => {
      const doc = await insertDocument(trx, {
        sha256: stored.sha256, filename: `${text}.txt`, mime: 'text/plain', size: stored.size, kind: 'sop',
        classification: 'internal', engagementId: null, uploadedBy: auditor.id,
      });
      await recordDocumentEvent(trx, auditor, doc, 0);
      return doc;
    }));
  }
  return { db, url, dir, blobs, engagementId: e.id, fid, docs };
}

describe('verify', () => {
  it('passes a database whose trail, signatures and stored files are intact [REQ-24]', async () => {
    const s = await restoredSystem();
    const report = await verifyIntegrity(s.db.kysely, s.blobs);
    expect(report.ok).toBe(true);
    expect(report.trail.valid).toBe(true);
    expect(report.signatures).toEqual({ checked: 2, problems: [] });
    expect(report.documents).toEqual({ checked: 2, problems: [], skipped: null });
  });

  it('reports a stored file that is missing or whose bytes changed [REQ-24]', async () => {
    const s = await restoredSystem();
    fs.rmSync(path.join(s.dir, blobKey(s.docs[0].sha256)));
    fs.writeFileSync(path.join(s.dir, blobKey(s.docs[1].sha256)), 'tampered bytes');
    const report = await verifyIntegrity(s.db.kysely, s.blobs);
    expect(report.ok).toBe(false);
    expect(report.documents.problems).toEqual([
      `Document ${s.docs[0].id}: stored file ${s.docs[0].sha256} is missing`,
      expect.stringMatching(new RegExp(`^Document ${s.docs[1].id}: stored bytes hash to [a-f0-9]{64}, not ${s.docs[1].sha256}`)),
    ]);
  });

  it('reports a registered document whose row was deleted or rewritten behind the application [REQ-24]', async () => {
    const s = await restoredSystem();
    const k = s.db.kysely;
    const registered = (await k.selectFrom('trail').select(['id', 'body']).where('module_id', '=', 'document:register').execute())
      .map((r) => ({ bundleId: r.id, documentId: (JSON.parse(r.body) as { inputs: { documentId: string } }).inputs.documentId }));
    const deleted = registered.find((r) => r.documentId === s.docs[0].id)!;
    // The rewritten row points at other bytes that are really in storage, so only the registration check can see it.
    const swapped = await s.blobs.put(Buffer.from('Replacement SOP text'));
    await sql`ALTER TABLE documents DISABLE TRIGGER documents_never_deleted`.execute(k);
    await sql`ALTER TABLE documents DISABLE TRIGGER documents_only_retention_changes`.execute(k);
    await sql`DELETE FROM documents WHERE id = ${s.docs[0].id}`.execute(k);
    await sql`UPDATE documents SET sha256 = ${swapped.sha256}, size = ${swapped.size} WHERE id = ${s.docs[1].id}`.execute(k);

    const report = await verifyIntegrity(k, s.blobs);
    expect(report.ok).toBe(false);
    expect(report.trail.valid).toBe(true);
    expect(report.documents.problems).toEqual([
      `Trail entry ${deleted.bundleId} registers document ${s.docs[0].id}, but the document row is missing`,
      `Document ${s.docs[1].id}: registered as ${s.docs[1].sha256} in the trail, but the row says ${swapped.sha256}`,
    ]);
  });

  it('reports a signature rewritten behind the application, and a trail entry edited after the fact [REQ-24]', async () => {
    const s = await restoredSystem();
    const k = s.db.kysely;
    const sig = await k.selectFrom('signatures').select('id').where('meaning', '=', 'Approved').executeTakeFirstOrThrow();
    await sql`ALTER TABLE signatures DISABLE TRIGGER signatures_append_only`.execute(k);
    await sql`UPDATE signatures SET content_hash = ${'f'.repeat(64)} WHERE id = ${sig.id}`.execute(k);
    await sql`ALTER TABLE trail DISABLE TRIGGER trail_append_only`.execute(k);
    await sql`UPDATE trail SET body = replace(body, 'Plant 1', 'Plant 9') WHERE module_id = 'human:create-engagement'`.execute(k);

    const report = await verifyIntegrity(k, s.blobs);
    expect(report.ok).toBe(false);
    expect(report.trail).toMatchObject({ valid: false, brokenAt: 1 });
    expect(report.signatures.problems).toEqual(expect.arrayContaining([
      `Signature ${sig.id} (finding ${s.fid}): the signed content is not in the finding's history`,
      `Signature ${sig.id} (finding ${s.fid}): does not match its trail entry`,
      expect.stringMatching(new RegExp(`^Finding ${s.fid} in ${s.engagementId}: sign-off ${sig.id} \\(Approved by .+\\) is broken`)),
    ]));
  });

  it('reports signature rows deleted behind the application, even when the engagement has none left [REQ-24]', async () => {
    const s = await restoredSystem();
    const k = s.db.kysely;
    const rows = await k.selectFrom('signatures').select(['id', 'trail_bundle_id']).execute();
    expect(rows).toHaveLength(2);
    await sql`ALTER TABLE signatures DISABLE TRIGGER signatures_append_only`.execute(k);
    await sql`DELETE FROM signatures`.execute(k);

    const report = await verifyIntegrity(k, s.blobs);
    expect(report.ok).toBe(false);
    expect(report.signatures.checked).toBe(0);
    expect(report.signatures.problems).toEqual(expect.arrayContaining([
      ...rows.map((r) => `Trail entry ${r.trail_bundle_id} records signature ${r.id} (finding ${s.fid}), but the signature row is missing`),
      expect.stringMatching(new RegExp(`^Finding ${s.fid} in ${s.engagementId}: `)),
    ]));
  });

  it('prints one JSON report and exits 1 when anything is wrong [REQ-24]', async () => {
    const s = await restoredSystem();
    const run = () => spawnSync('npx', ['tsx', 'src/db/cli.ts', 'verify'], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: s.url, BLOB_DRIVER: 'local', BLOB_LOCAL_DIR: s.dir, LOG_LEVEL: 'silent' },
    });
    const clean = run();
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ ok: true, documents: { checked: 2 } });

    fs.rmSync(path.join(s.dir, blobKey(s.docs[0].sha256)));
    const broken = run();
    expect(broken.status).toBe(1);
    expect(JSON.parse(broken.stdout).documents.problems).toHaveLength(1);
  }, 60_000);

  it('fails rather than passes when it cannot look at the stored files [REQ-24]', async () => {
    const s = await restoredSystem();
    const report = await verifyIntegrity(s.db.kysely, null, 'file storage is not configured: S3_BUCKET is required when BLOB_DRIVER=s3');
    expect(report.ok).toBe(false);
    expect(report.documents).toEqual({ checked: 0, problems: [], skipped: 'file storage is not configured: S3_BUCKET is required when BLOB_DRIVER=s3' });
  });
});

/** An offline agent run that has reached its scope gate: decision, delegate, QA and gate-opening steps, all in the trail. */
async function runAtScopeGate() {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  const { run } = await startRun(svc, defaultAgentConfig(), e.id, auditor);
  await new AgentWorker(svc, defaultAgentConfig(), { id: 'w-verify' }).drain();
  return { k: svc.db.kysely, run, steps: await listSteps(svc.db.kysely, run.id) };
}

describe('verify on agent work', () => {
  it("passes when every agent step's trail entry is in the chain [REQ-24, REQ-28]", async () => {
    const { k, steps } = await runAtScopeGate();
    expect(steps.map((s) => s.kind)).toEqual(expect.arrayContaining(['decision', 'delegate', 'qa', 'tool_call']));
    expect((await verifyIntegrity(k, null)).agents).toEqual({ checked: steps.length, problems: [] });
  });

  it("reports a step whose trail entry is missing, absent, not the run's own, or after a break in the chain [REQ-24, REQ-28]", async () => {
    const { k, run, steps } = await runAtScopeGate();
    const decision = steps.find((s) => s.kind === 'decision')!;
    const delegate = steps.find((s) => s.kind === 'delegate')!;
    const qa = steps.find((s) => s.kind === 'qa')!;
    const humanEntry = (await readTrail(k)).find((b) => b.moduleId === 'human:agent-run-start')!;
    await sql`ALTER TABLE agent_steps DISABLE TRIGGER agent_steps_append_only`.execute(k);
    await sql`UPDATE agent_steps SET trail_bundle_id = 'AGT-gone' WHERE run_id = ${run.id} AND seq = ${decision.seq}`.execute(k);
    await sql`UPDATE agent_steps SET trail_bundle_id = NULL WHERE run_id = ${run.id} AND seq = ${delegate.seq}`.execute(k);
    await sql`UPDATE agent_steps SET trail_bundle_id = ${humanEntry.id} WHERE run_id = ${run.id} AND seq = ${qa.seq}`.execute(k);
    const report = await verifyIntegrity(k, null);
    expect(report.ok).toBe(false);
    expect(report.agents.problems).toEqual(expect.arrayContaining([
      `Step ${run.id}#${decision.seq} (decision): its trail entry AGT-gone is missing`,
      `Step ${run.id}#${delegate.seq} (delegate): has no trail entry`,
      `Step ${run.id}#${qa.seq} (qa): its trail entry ${humanEntry.id} is not an agent's entry for this run`,
    ]));

    // An edit to the first bundle breaks the chain from seq 1: no agent entry after it is vouched for any more.
    await sql`ALTER TABLE trail DISABLE TRIGGER trail_append_only`.execute(k);
    await sql`UPDATE trail SET body = replace(body, 'Plant 1', 'Plant 9') WHERE module_id = 'human:create-engagement'`.execute(k);
    expect((await verifyIntegrity(k, null)).agents.problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Step AR-\w+#\d+ \(tool_call\): its trail entry AGT-\w+ is at or after the break in the chain \(seq 1\)$/),
    ]));
  });

  it('reports any agent step with no trail entry, including takeover notes and rails refusals [REQ-24, REQ-28]', async () => {
    const { k, run, steps } = await runAtScopeGate();
    const lookup = steps.find((s) => s.kind === 'tool_call')!;
    const decision = steps.find((s) => s.kind === 'decision')!;
    // A takeover note and a rails refusal with no entry: no step is exempt.
    await sql`ALTER TABLE agent_steps DISABLE TRIGGER agent_steps_append_only`.execute(k);
    await sql`INSERT INTO agent_steps (run_id, seq, kind, agent, decision) VALUES (${run.id}, 9001, 'tool_call', 'worker', '{"recovered":"x"}'::jsonb), (${run.id}, 9002, 'tool_call', 'rails', '{"refused":"x"}'::jsonb)`.execute(k);
    expect((await verifyIntegrity(k, null)).agents.problems).toEqual([
      `Step ${run.id}#9001 (tool_call): has no trail entry`,
      `Step ${run.id}#9002 (tool_call): has no trail entry`,
    ]);
    await sql`DELETE FROM agent_steps WHERE run_id = ${run.id} AND seq IN (9001, 9002)`.execute(k);

    await sql`UPDATE agent_steps SET trail_bundle_id = NULL WHERE run_id = ${run.id} AND seq = ${lookup.seq}`.execute(k);
    await sql`UPDATE agent_steps SET kind = 'tool_call', trail_bundle_id = NULL WHERE run_id = ${run.id} AND seq = ${decision.seq}`.execute(k);
    const report = await verifyIntegrity(k, null);
    expect(report.ok).toBe(false);
    expect(report.agents.problems).toEqual(expect.arrayContaining([
      `Step ${run.id}#${lookup.seq} (tool_call): has no trail entry`,
      `Step ${run.id}#${decision.seq} (tool_call): has no trail entry`,
    ]));
    expect(report.agents.problems).toHaveLength(2);
  });
});
