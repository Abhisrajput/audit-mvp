import { sql } from 'kysely';
import { canonicalJson } from '../engine/trail';
import type { Engagement, Finding } from '../engine/types';
import { AppError } from '../errors';
import { recordRevision, recordWorkpaperRevisions } from './revision-repo';
import type { Executor } from './trail-repo';

// Engagements are stored as a header row (with an optimistic version), one
// JSONB row of engine working output, and one row per finding. The service
// works on the assembled Engagement object exactly as the engine expects.

export interface LoadedEngagement {
  engagement: Engagement;
  version: number;
  /** canonicalJson of each live finding as loaded, to write only what changed. */
  findingSnapshots: Map<string, string>;
}

export interface EngagementSummary {
  id: string;
  name: string;
  entity: string;
  site: string;
  auditType: string;
  packIds: string[];
  stage: Engagement['stage'];
  createdAt: string;
  findings: number;
  rcm: number;
  version: number;
}

const json = (v: unknown) => JSON.stringify(v);
const iso = (d: Date | string) => new Date(d).toISOString();

export async function insertFinding(db: Executor, engagementId: string, f: Finding): Promise<void> {
  await db
    .insertInto('findings')
    .values({ engagement_id: engagementId, id: f.id, row_id: f.rowId, control_id: f.controlId, status: f.status, rating: f.rating, data: json(f) })
    .execute();
  await recordRevision(db, engagementId, f);
}

export async function insertEngagement(db: Executor, e: Engagement): Promise<void> {
  await db
    .insertInto('engagements')
    .values({
      id: e.id, name: e.name, entity: e.entity, site: e.site, period_from: e.periodFrom, period_to: e.periodTo,
      audit_type: e.auditType, scope_statement: e.scopeStatement, pack_ids: json(e.packIds), created_by: e.createdBy,
      created_at: e.createdAt, stage: e.stage, version: 1,
    })
    .execute();
  await db
    .insertInto('engagement_work')
    .values({
      engagement_id: e.id, scope: json(e.scope), rcm: json(e.rcm), test_inputs: json(e.testInputs),
      test_results: json(e.testResults), test_plans: json(e.testPlans ?? {}), report: e.report ? json(e.report) : null,
    })
    .execute();
  for (const f of e.findings) await insertFinding(db, e.id, f);
  await recordWorkpaperRevisions(db, e);
  e.version = 1;
}

export async function loadEngagement(db: Executor, id: string, opts: { forUpdate?: boolean } = {}): Promise<LoadedEngagement | null> {
  let header = db.selectFrom('engagements').selectAll().where('id', '=', id);
  if (opts.forUpdate) header = header.forUpdate();
  const h = await header.executeTakeFirst();
  if (!h) return null;
  const w = await db.selectFrom('engagement_work').selectAll().where('engagement_id', '=', id).executeTakeFirstOrThrow();
  const rows = await db
    .selectFrom('findings')
    .select('data')
    .where('engagement_id', '=', id)
    .where('superseded_at', 'is', null)
    .orderBy('seq')
    .execute();
  const findings = rows.map((r) => r.data);
  const engagement: Engagement = {
    id: h.id, name: h.name, entity: h.entity, site: h.site, periodFrom: h.period_from, periodTo: h.period_to,
    auditType: h.audit_type, scopeStatement: h.scope_statement, packIds: h.pack_ids, createdBy: h.created_by,
    createdAt: iso(h.created_at), stage: h.stage, scope: w.scope, rcm: w.rcm, testInputs: w.test_inputs,
    testResults: w.test_results, testPlans: w.test_plans ?? {}, findings, report: w.report, version: h.version,
  };
  return { engagement, version: h.version, findingSnapshots: new Map(findings.map((f) => [f.id, canonicalJson(f)])) };
}

/**
 * Writes the engagement back if nobody else saved since it was loaded.
 * Findings are diffed against their load-time snapshot: new ones are inserted,
 * changed ones updated, dropped ones superseded. Unchanged rows (including
 * every approved finding) are never written, so the approved-row trigger only
 * fires on a real attempt to change an approved finding.
 */
export async function saveEngagement(db: Executor, loaded: LoadedEngagement): Promise<void> {
  const e = loaded.engagement;
  const now = new Date().toISOString();
  const res = await db
    .updateTable('engagements')
    .set({ stage: e.stage, version: loaded.version + 1, updated_at: now })
    .where('id', '=', e.id)
    .where('version', '=', loaded.version)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) !== 1) {
    throw new AppError(409, `Engagement ${e.id} was changed by someone else; reload and try again`, 'VERSION_CONFLICT');
  }
  await db
    .updateTable('engagement_work')
    .set({
      scope: json(e.scope), rcm: json(e.rcm), test_inputs: json(e.testInputs),
      test_results: json(e.testResults), test_plans: json(e.testPlans ?? {}), report: e.report ? json(e.report) : null,
    })
    .where('engagement_id', '=', e.id)
    .execute();

  const live = new Set<string>();
  for (const f of e.findings) {
    live.add(f.id);
    const before = loaded.findingSnapshots.get(f.id);
    if (before === undefined) {
      await insertFinding(db, e.id, f);
    } else if (before !== canonicalJson(f)) {
      await db
        .updateTable('findings')
        .set({ status: f.status, rating: f.rating, data: json(f), updated_at: now })
        .where('engagement_id', '=', e.id)
        .where('id', '=', f.id)
        .where('superseded_at', 'is', null)
        .execute();
      await recordRevision(db, e.id, f);
    }
  }
  for (const id of loaded.findingSnapshots.keys()) {
    if (!live.has(id)) {
      await db.updateTable('findings').set({ superseded_at: now }).where('engagement_id', '=', e.id).where('id', '=', id).where('superseded_at', 'is', null).execute();
    }
  }
  await recordWorkpaperRevisions(db, e);
  e.version = loaded.version + 1;
}

export async function listEngagements(db: Executor): Promise<EngagementSummary[]> {
  const rows = await db
    .selectFrom('engagements as e')
    .innerJoin('engagement_work as w', 'w.engagement_id', 'e.id')
    .select((eb) => [
      'e.id', 'e.name', 'e.entity', 'e.site', 'e.audit_type', 'e.pack_ids', 'e.stage', 'e.created_at', 'e.version',
      sql<number>`jsonb_array_length(w.rcm)`.as('rcm_count'),
      eb
        .selectFrom('findings as f')
        .select((sub) => sub.fn.countAll<number>().as('n'))
        .whereRef('f.engagement_id', '=', 'e.id')
        .where('f.superseded_at', 'is', null)
        .as('finding_count'),
    ])
    .orderBy('e.created_at')
    .orderBy('e.id')
    .execute();
  return rows.map((r) => ({
    id: r.id, name: r.name, entity: r.entity, site: r.site, auditType: r.audit_type, packIds: r.pack_ids,
    stage: r.stage, createdAt: iso(r.created_at), findings: Number(r.finding_count ?? 0), rcm: Number(r.rcm_count), version: r.version,
  }));
}
