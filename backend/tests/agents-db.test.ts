import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import type { Db } from '../src/db';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

// The database's own rules for the agent tables (migration 010), exercised with plain SQL.

async function setup() {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  return { db: svc.db, e };
}

const insertRun = (db: Db, engagementId: string, id: string, status = 'runnable') =>
  db.execScript(`INSERT INTO agent_runs (id, engagement_id, status, policy, policy_version, budget, started_by)
    VALUES ('${id}', '${engagementId}', '${status}', 'rules', 'rules-1', '{"maxSteps":5,"maxTokens":10,"maxCostUsd":1}', 'auditor')`);

const insertGate = (db: Db, engagementId: string, runId: string, id: string, key = 'scope') =>
  db.execScript(`INSERT INTO gates (id, engagement_id, run_id, kind, subject_key, subject_id, subject_hash, basis_hash, qa_report, attempt)
    VALUES ('${id}', '${engagementId}', '${runId}', 'scope', '${key}', 'scope', 'h1', 'b1',
      jsonb_build_object('subjectKey', '${key}', 'subjectHash', 'h1'), 1)`);

const insertSignature = (db: Db, engagementId: string, id: string, columns: string, values: string) =>
  db.execScript(`INSERT INTO signatures (id, engagement_id, user_id, user_name, role, meaning, content_hash, reauth_method, trail_bundle_id, signed_at${columns})
    VALUES ('${id}', '${engagementId}', 'reviewer', 'Ravi Reviewer', 'audit_manager', 'Approved', 'h1', 'none', 'HUM-x', now()${values})`);

describe('agent tables (migration 010)', () => {
  it('allows one active run per engagement [REQ-26]', async () => {
    const { db, e } = await setup();
    await insertRun(db, e.id, 'AR-a');
    await expect(insertRun(db, e.id, 'AR-b')).rejects.toThrow(/agent_runs_one_active/);
    await db.execScript(`UPDATE agent_runs SET status = 'completed', ended_at = now() WHERE id = 'AR-a'`);
    await insertRun(db, e.id, 'AR-b');
  });

  it('locks a run once it has ended, and never deletes one [REQ-28]', async () => {
    const { db, e } = await setup();
    await insertRun(db, e.id, 'AR-a', 'completed');
    await expect(db.execScript(`UPDATE agent_runs SET status_reason = 'x' WHERE id = 'AR-a'`)).rejects.toThrow(/is locked: /);
    await insertRun(db, e.id, 'AR-b');
    await expect(db.execScript(`DELETE FROM agent_runs WHERE id = 'AR-b'`)).rejects.toThrow(/is locked: /);
  });

  it('keeps agent steps append-only [REQ-28]', async () => {
    const { db, e } = await setup();
    await insertRun(db, e.id, 'AR-a');
    await db.execScript(`INSERT INTO agent_steps (run_id, seq, kind, agent, decision) VALUES ('AR-a', 1, 'decision', 'supervisor', '{}')`);
    await expect(db.execScript(`UPDATE agent_steps SET agent = 'x'`)).rejects.toThrow(/is append-only: /);
    await expect(db.execScript(`DELETE FROM agent_steps`)).rejects.toThrow(/is append-only: /);
  });

  it('closes a gate only with a signature, and never reopens or rewrites it [REQ-27]', async () => {
    const { db, e } = await setup();
    await insertRun(db, e.id, 'AR-a');
    await insertGate(db, e.id, 'AR-a', 'GATE-1');
    await expect(insertGate(db, e.id, 'AR-a', 'GATE-2')).rejects.toThrow(/gates_one_open/);
    await expect(db.execScript(`UPDATE gates SET state = 'approved' WHERE id = 'GATE-1'`)).rejects.toThrow(/needs a signature/);
    await expect(db.execScript(`UPDATE gates SET subject_hash = 'h2' WHERE id = 'GATE-1'`)).rejects.toThrow(/is locked: /);
    await db.execScript(`UPDATE gates SET state = 'approved', signature_id = 'SIG-1', closed_at = now() WHERE id = 'GATE-1'`);
    await expect(db.execScript(`UPDATE gates SET state = 'open' WHERE id = 'GATE-1'`)).rejects.toThrow(/is locked: /);
    await expect(db.execScript(`DELETE FROM gates WHERE id = 'GATE-1'`)).rejects.toThrow(/is locked: /);
    // An open gate whose subject changed is superseded; that needs no signature.
    await insertGate(db, e.id, 'AR-a', 'GATE-2');
    await db.execScript(`UPDATE gates SET state = 'superseded', closed_at = now() WHERE id = 'GATE-2'`);
  });

  it('keeps workpaper revisions append-only [REQ-19]', async () => {
    const { db, e } = await setup();
    await db.execScript(`INSERT INTO workpaper_revisions (engagement_id, kind, revision, content_hash) VALUES ('${e.id}', 'scope', 1, 'h1')`);
    await expect(db.execScript(`UPDATE workpaper_revisions SET content_hash = 'h2'`)).rejects.toThrow(/is append-only: /);
  });

  it('keeps existing signatures finding signatures, and binds a workpaper signature to its gate [REQ-19]', async () => {
    const { db, e } = await setup();
    await insertSignature(db, e.id, 'SIG-f', ', finding_id', `, 'F-1'`);
    const row = await db.kysely.selectFrom('signatures').select(['subject_kind', 'workpaper', 'gate_id']).where('id', '=', 'SIG-f').executeTakeFirstOrThrow();
    expect(row).toEqual({ subject_kind: 'finding', workpaper: null, gate_id: null });
    await expect(insertSignature(db, e.id, 'SIG-a', ', subject_kind, workpaper', `, 'workpaper', 'scope'`)).rejects.toThrow(/signatures_subject/);
    await expect(insertSignature(db, e.id, 'SIG-b', ', subject_kind, workpaper, gate_id, finding_id', `, 'workpaper', 'scope', 'GATE-1', 'F-1'`)).rejects.toThrow(/signatures_subject/);
    await insertSignature(db, e.id, 'SIG-c', ', subject_kind, workpaper, gate_id', `, 'workpaper', 'scope', 'GATE-1'`);
    await expect(db.execScript(`INSERT INTO signatures (id, engagement_id, user_id, user_name, role, meaning, content_hash, reauth_method, trail_bundle_id, signed_at, subject_kind, workpaper, gate_id)
      VALUES ('SIG-d', '${e.id}', 'reviewer', 'R', 'audit_manager', 'Reviewed', 'h1', 'none', 'HUM-x', now(), 'workpaper', 'rcm', 'GATE-2')`)).rejects.toThrow(/signatures_subject/);
  });
});
