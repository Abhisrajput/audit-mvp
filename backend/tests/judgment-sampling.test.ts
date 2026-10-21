import { describe, expect, it } from 'vitest';
import { subjectInfo } from '../src/agents/subjects';
import { draftTestPlans } from '../src/agents/specialists/test-plan';
import { reviewSubject } from '../src/agents/qa/deterministic';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

const AREA = 'Food safety – HACCP';
const INCIDENT = { factors: [{ kind: 'incident' as const, processAreas: [AREA], description: 'Two CCP deviations in March' }], background: '' };

describe('sampling in the RCM and the plans (spec §5.3) [REQ-32]', () => {
  it('keys the sample on the assessed risk, writes the rationale and the RCM memo, selects judgementally for the incident area, and recommends 0 tolerance for a food row', async () => {
    const svc = await newService();
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, context: INCIDENT }, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    await svc.runModule(e.id, 'rcm', auditor);
    const after = await svc.engagement(e.id);
    const haccp = after.rcm.filter((r) => r.processArea === AREA);
    expect(haccp.length).toBeGreaterThan(0);
    for (const r of haccp) {
      expect(r.assessedRisk).toBe(r.riskRating === 'Low' ? 'Medium' : 'High');
      expect(r.samplingRationale).toMatch(new RegExp(r.assessedRisk!));
    }
    expect(after.memos.rcm.subjectKey).toBe('rcm');
    expect(after.memos.rcm.calls.some((c) => c.question.includes(haccp[0].control) || c.question.includes('HACCP'))).toBe(true);
    const plans = draftTestPlans(after);
    for (const r of haccp) {
      expect(['judgemental', 'all']).toContain(plans[r.id].selectionMethod);
      expect(plans[r.id].recommendedToleranceRate).toBe(0);
    }
    const common = after.rcm.find((r) => r.packId === 'common' && (r.assessedRisk ?? r.riskRating) !== 'High');
    if (common) expect(plans[common.id].recommendedToleranceRate).toBeGreaterThan(0);
  });

  it('with no context produces today\'s rows apart from the two new fields, and the rcm hash moves only through the memo', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    await svc.runModule(e.id, 'rcm', auditor);
    const after = await svc.engagement(e.id);
    for (const r of after.rcm) expect(r.assessedRisk).toBe(r.riskRating);
    const plans = draftTestPlans(after);
    for (const r of after.rcm) expect(plans[r.id].selectionMethod).toBe(['Annual', 'Quarterly'].includes(r.frequency) ? 'all' : 'random');
    expect(subjectInfo(after, 'rcm')!.hash).not.toBe(subjectInfo({ ...after, memos: {} }, 'rcm')!.hash);
  });

  it('flags a random selection for a row with an incident factor [REQ-30]', async () => {
    const svc = await newService();
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, context: INCIDENT }, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    await svc.runModule(e.id, 'rcm', auditor);
    const after = await svc.engagement(e.id);
    const plans = draftTestPlans(after);
    const haccpRow = after.rcm.find((r) => r.processArea === AREA)!;
    plans[haccpRow.id] = { ...plans[haccpRow.id], selectionMethod: 'random' };
    const r = reviewSubject({ ...after, testPlans: plans }, 'test_plans');
    expect(r.issues.map((i) => [i.severity, i.criterion])).toContainEqual(['advisory', 'plans.selection-incident']);
  });
});
