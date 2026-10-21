import crypto from 'node:crypto';
import type { Selectable } from 'kysely';
import type { GatesTable } from '../db/schema';
import type { Executor } from '../db/trail-repo';
import { AppError } from '../errors';
import type { GateKind, GateRecord, QaReport } from './types';

// Human gates (spec §4.3, §4.4). A gate is bound to the content and basis it opened on; only a signature closes it,
// and a change to its subject before anyone signs supersedes it. The database refuses anything else (migration 010).

export interface Gate extends GateRecord {
  engagementId: string;
  runId: string;
  qaReport: QaReport | null;
  openedAt: string;
  closedAt: string | null;
}

export interface NewGate {
  engagementId: string;
  runId: string;
  kind: GateKind;
  subjectKey: string;
  subjectId: string;
  subjectHash: string;
  basisHash: string;
  /** The QA review of exactly this content (REQ-30; migration 011 refuses a gate without it). */
  qaReport: QaReport;
}

const iso = (d: Date | string) => new Date(d).toISOString();

const toGate = (r: Selectable<GatesTable>): Gate => ({
  id: r.id, engagementId: r.engagement_id, runId: r.run_id, kind: r.kind, subjectKey: r.subject_key, subjectId: r.subject_id,
  subjectHash: r.subject_hash, basisHash: r.basis_hash, qaReport: r.qa_report, attempt: r.attempt, state: r.state,
  signatureId: r.signature_id, comment: r.comment, openedAt: iso(r.opened_at), closedAt: r.closed_at ? iso(r.closed_at) : null,
});

/** Opens a gate. Its attempt counts the subject's earlier gates that were decided or are open; superseded ones do not count. */
export async function insertGate(db: Executor, g: NewGate): Promise<Gate> {
  const prior = await db
    .selectFrom('gates')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('engagement_id', '=', g.engagementId)
    .where('subject_key', '=', g.subjectKey)
    .where('state', '<>', 'superseded')
    .executeTakeFirstOrThrow();
  const row = await db
    .insertInto('gates')
    .values({
      id: `GATE-${crypto.randomBytes(6).toString('hex')}`, engagement_id: g.engagementId, run_id: g.runId, kind: g.kind, subject_key: g.subjectKey,
      subject_id: g.subjectId, subject_hash: g.subjectHash, basis_hash: g.basisHash, qa_report: JSON.stringify(g.qaReport), attempt: Number(prior.n) + 1,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toGate(row);
}

/** Every gate on the engagement, oldest first. */
export async function listGates(db: Executor, engagementId: string): Promise<Gate[]> {
  return (await db.selectFrom('gates').selectAll().where('engagement_id', '=', engagementId).orderBy('seq').execute()).map(toGate);
}

/** True when the engagement has a gate of this kind that has been approved. */
export async function hasApprovedGate(db: Executor, engagementId: string, kind: string): Promise<boolean> {
  const row = await db
    .selectFrom('gates')
    .select('id')
    .where('engagement_id', '=', engagementId)
    .where('kind', '=', kind as never)
    .where('state', '=', 'approved')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** The open gate on a subject (a finding id, or a workpaper kind), or null. */
export async function openGateForSubject(db: Executor, engagementId: string, subjectId: string): Promise<Gate | null> {
  const row = await db
    .selectFrom('gates')
    .selectAll()
    .where('engagement_id', '=', engagementId)
    .where('subject_id', '=', subjectId)
    .where('state', '=', 'open')
    .orderBy('seq', 'desc')
    .executeTakeFirst();
  return row ? toGate(row) : null;
}

export async function getGate(db: Executor, id: string, opts: { forUpdate?: boolean } = {}): Promise<Gate | null> {
  let q = db.selectFrom('gates').selectAll().where('id', '=', id);
  if (opts.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  return row ? toGate(row) : null;
}

/** Closes an open gate with the signature that decided it. */
export async function closeGate(db: Executor, id: string, state: 'approved' | 'rejected', signatureId: string, comment: string): Promise<Gate> {
  const row = await db
    .updateTable('gates')
    .set({ state, signature_id: signatureId, comment, closed_at: new Date().toISOString() })
    .where('id', '=', id)
    .where('state', '=', 'open')
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new AppError(409, 'This gate is no longer open');
  return toGate(row);
}

export async function supersedeGate(db: Executor, id: string): Promise<void> {
  await db.updateTable('gates').set({ state: 'superseded', closed_at: new Date().toISOString() }).where('id', '=', id).where('state', '=', 'open').execute();
}

export async function supersedeOpenGates(db: Executor, runId: string): Promise<void> {
  await db.updateTable('gates').set({ state: 'superseded', closed_at: new Date().toISOString() }).where('run_id', '=', runId).where('state', '=', 'open').execute();
}

/**
 * A finding's open gate closes with the finding's approval or rejection. If the finding changed after the gate opened,
 * the signature is not about what the gate showed, so the gate is superseded instead and the agent reviews it again.
 */
export async function closeFindingGate(
  db: Executor, engagementId: string, findingId: string, contentHash: string, state: 'approved' | 'rejected', signatureId: string, comment: string,
): Promise<void> {
  const g = await db
    .selectFrom('gates')
    .selectAll()
    .where('engagement_id', '=', engagementId)
    .where('kind', '=', 'finding')
    .where('subject_id', '=', findingId)
    .where('state', '=', 'open')
    .forUpdate()
    .executeTakeFirst();
  if (!g) return;
  if (g.subject_hash !== contentHash) return supersedeGate(db, g.id);
  // The row is locked and open, so this update cannot lose a race; a gate closed meanwhile never reaches it.
  await db.updateTable('gates').set({ state, signature_id: signatureId, comment, closed_at: new Date().toISOString() }).where('id', '=', g.id).where('state', '=', 'open').execute();
}
