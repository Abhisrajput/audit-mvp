import fs from 'node:fs';
import { verifyChain } from '../engine/trail';
import type { Engagement, TrailBundle } from '../engine/types';
import type { EvalReport } from '../eval/harness';
import { insertEngagement } from './engagement-repo';
import { saveEvalRun } from './eval-repo';
import type { Db } from './index';
import { insertSealed, readTrail } from './trail-repo';

interface MvpData {
  engagements?: Engagement[];
  trail?: TrailBundle[];
  evalRuns?: EvalReport[];
}

/**
 * One-off migration of an MVP data/db.json into an empty database. The source
 * chain is verified first and imported with its original seq and hashes, so
 * the evidence stays provably unaltered. All or nothing.
 */
export async function importJson(db: Db, file: string) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as MvpData;
  const trail = data.trail ?? [];
  const engagements = data.engagements ?? [];
  const evalRuns = data.evalRuns ?? [];

  const source = verifyChain(trail);
  if (!source.valid) {
    throw new Error(`Refusing to import: the source trail is broken at bundle ${source.brokenAt} (${source.reason})`);
  }

  await db.kysely.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('engagements').select('id').limit(1).execute();
    const existingTrail = await trx.selectFrom('trail').select('seq').limit(1).execute();
    if (existing.length || existingTrail.length) {
      throw new Error('Refusing to import: the target database already has engagements or trail entries');
    }
    for (const e of engagements) await insertEngagement(trx, e);
    for (const b of trail) await insertSealed(trx, b);
    for (const r of evalRuns) await saveEvalRun(trx, r);
  });

  const imported = verifyChain(await readTrail(db.kysely));
  if (!imported.valid) throw new Error(`Imported trail failed verification: ${imported.reason}`);
  return { engagements: engagements.length, trail: trail.length, evalRuns: evalRuns.length };
}
