import type { EvalReport } from '../eval/harness';
import type { Executor } from './trail-repo';

export async function saveEvalRun(db: Executor, r: EvalReport): Promise<void> {
  await db.insertInto('eval_runs').values({ id: r.id, at: r.at, body: JSON.stringify(r) }).execute();
}

export async function listEvalRuns(db: Executor): Promise<Omit<EvalReport, 'cases'>[]> {
  const rows = await db.selectFrom('eval_runs').select('body').orderBy('at', 'desc').execute();
  return rows.map(({ body: { cases: _cases, ...summary } }) => summary);
}

export async function getEvalRun(db: Executor, id: string): Promise<EvalReport | null> {
  const row = await db.selectFrom('eval_runs').select('body').where('id', '=', id).executeTakeFirst();
  return row?.body ?? null;
}

export async function latestEvalRun(db: Executor): Promise<EvalReport | null> {
  const row = await db.selectFrom('eval_runs').select('body').orderBy('at', 'desc').limit(1).executeTakeFirst();
  return row?.body ?? null;
}
