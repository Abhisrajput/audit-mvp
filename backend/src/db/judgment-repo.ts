import type { FindingResponse, Tolerance } from '../engine/types';
import type { Executor } from './trail-repo';

// Tolerances and management responses are person-made records kept outside the signed workpapers (spec §3.3).
// Both tables are append-only: a new answer is a new row, and the latest row per key is the one in force.

const iso = (d: Date | string) => new Date(d).toISOString();

export async function insertTolerance(db: Executor, engagementId: string, t: Tolerance & { id: string }): Promise<void> {
  await db
    .insertInto('test_tolerances')
    .values({ id: t.id, engagement_id: engagementId, control_id: t.controlId, rate: t.rate, recorded_by: t.recordedBy, recorded_at: t.recordedAt, trail_bundle_id: t.trailBundleId })
    .execute();
}

/** The tolerance in force for each control: the latest row wins. A control with no row has none (treated as 0). */
export async function tolerancesFor(db: Executor, engagementId: string): Promise<Record<string, Tolerance>> {
  const rows = await db.selectFrom('test_tolerances').selectAll().where('engagement_id', '=', engagementId).orderBy('recorded_at').orderBy('id').execute();
  const out: Record<string, Tolerance> = {};
  for (const r of rows) {
    // numeric comes back from pg as a string.
    out[r.control_id] = { controlId: r.control_id, rate: Number(r.rate), recordedBy: r.recorded_by, recordedAt: iso(r.recorded_at), trailBundleId: r.trail_bundle_id };
  }
  return out;
}

export async function insertResponse(db: Executor, engagementId: string, r: FindingResponse): Promise<void> {
  await db
    .insertInto('finding_responses')
    .values({
      id: r.id, engagement_id: engagementId, finding_id: r.findingId, response: r.response, owner: r.owner, due_date: r.dueDate,
      action_plan: r.actionPlan, recorded_by: r.recordedBy, recorded_at: r.recordedAt, trail_bundle_id: r.trailBundleId,
    })
    .execute();
}

type ResponseRow = Awaited<ReturnType<typeof responseRows>>[number];

function responseRows(db: Executor, engagementId: string, findingId?: string) {
  let q = db.selectFrom('finding_responses').selectAll().where('engagement_id', '=', engagementId);
  if (findingId !== undefined) q = q.where('finding_id', '=', findingId);
  return q.orderBy('recorded_at').orderBy('id').execute();
}

const toResponse = (r: ResponseRow): FindingResponse => ({
  id: r.id, findingId: r.finding_id, response: r.response, owner: r.owner, dueDate: r.due_date, actionPlan: r.action_plan,
  recordedBy: r.recorded_by, recordedAt: iso(r.recorded_at), trailBundleId: r.trail_bundle_id,
});

/** The current response to each finding: the latest row wins. */
export async function responsesFor(db: Executor, engagementId: string): Promise<Record<string, FindingResponse>> {
  const out: Record<string, FindingResponse> = {};
  for (const r of await responseRows(db, engagementId)) out[r.finding_id] = toResponse(r);
  return out;
}

/** Every response recorded for one finding, oldest first. */
export async function responseHistory(db: Executor, engagementId: string, findingId: string): Promise<FindingResponse[]> {
  return (await responseRows(db, engagementId, findingId)).map(toResponse);
}
