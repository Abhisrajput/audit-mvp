import { describe, expect, it } from 'vitest';
import { insertEngagement, loadEngagement, saveEngagement } from '../src/db/engagement-repo';
import type { Engagement, TestPlan } from '../src/engine/types';
import type { AuditService } from '../src/service';
import { workpaperContentHash } from '../src/signing/content-hash';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

const revisions = (svc: AuditService, id: string) =>
  svc.db.kysely.selectFrom('workpaper_revisions').select(['kind', 'revision']).where('engagement_id', '=', id).orderBy('kind').orderBy('revision').execute();

const plan: TestPlan = {
  rowId: 'FD-HACCP-03', rowHash: 'h', attribute: 'CCP logs are signed', population: 'All CCP logs in the period', sampleSize: 5,
  selectionMethod: 'random', evidenceToRequest: ['CCP log'], procedure: 'Inspect signatures',
};

describe('workpapers', () => {
  it('binds each workpaper to a hash of its content [REQ-19]', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    const scoped = await svc.engagement(e.id);
    const hash = workpaperContentHash('scope', scoped);
    expect(workpaperContentHash('scope', structuredClone(scoped))).toBe(hash);
    const toggled = structuredClone(scoped);
    toggled.scope[0].included = !toggled.scope[0].included;
    expect(workpaperContentHash('scope', toggled)).not.toBe(hash);
    // An empty RCM and a missing report never collide: the kind is part of the hash.
    expect(workpaperContentHash('rcm', { ...scoped, rcm: [] })).not.toBe(workpaperContentHash('scope', { ...scoped, scope: [] }));
  });

  it('records a workpaper revision whenever its content changes, and only then [REQ-19]', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    expect(await revisions(svc, e.id)).toEqual([]);
    await svc.runModule(e.id, 'scope', auditor);
    expect(await revisions(svc, e.id)).toEqual([{ kind: 'scope', revision: 1 }]);
    const first = (await svc.engagement(e.id)).scope[0];
    await svc.setScope(e.id, [{ controlId: first.controlId, included: !first.included }], auditor);
    await svc.setScope(e.id, [{ controlId: first.controlId, included: !first.included }], auditor);
    expect(await revisions(svc, e.id)).toEqual([{ kind: 'scope', revision: 1 }, { kind: 'scope', revision: 2 }]);
  });

  it('stores test plans with the engagement and records their revisions', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    expect(e.testPlans).toEqual({});
    await svc.db.kysely.transaction().execute(async (trx) => {
      const loaded = (await loadEngagement(trx, e.id, { forUpdate: true }))!;
      loaded.engagement.testPlans = { [plan.rowId]: plan };
      await saveEngagement(trx, loaded);
    });
    expect((await svc.engagement(e.id)).testPlans).toEqual({ [plan.rowId]: plan });
    expect(await revisions(svc, e.id)).toEqual([{ kind: 'test_plans', revision: 1 }]);
  });

  it('loads an engagement saved without test plans (an MVP import) with none', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const legacy = { ...structuredClone(e), id: 'ENG-LEGACY' } as Partial<Engagement>;
    delete legacy.testPlans;
    await svc.db.kysely.transaction().execute((trx) => insertEngagement(trx, legacy as Engagement));
    expect((await svc.engagement('ENG-LEGACY')).testPlans).toEqual({});
  });
});
