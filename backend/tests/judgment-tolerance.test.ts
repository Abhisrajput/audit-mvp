import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import { reviewSubject } from '../src/agents/qa/deterministic';
import { concludeTest } from '../src/engine/modules/testing';
import { testEvidenceGate } from '../src/engine/qa';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';
import { appWithDevUsers, signIn } from './http';
import { row, input } from './agent-fixtures';

const record = (over: { sampleTested: number; exceptions: number }) => ({ ...input(), ...over, designAdequate: true });

describe('tolerance set by a person (spec §3.3, §5.4) [REQ-33]', () => {
  it('concludes Effective within the tolerance, Ineffective without one, and records what it applied', () => {
    const r = row('R1', { sampleSize: 40 });
    const i = record({ sampleTested: 40, exceptions: 1 });
    const tolerated = concludeTest(r, i, 0.05);
    expect(tolerated).toMatchObject({ conclusion: 'Effective', toleranceApplied: 0.05, severity: 'isolated' });
    expect(testEvidenceGate(r, i, tolerated, 0.05).result.conclusion).toBe('Effective');
    const strict = concludeTest(r, i);
    expect(strict).toMatchObject({ conclusion: 'Ineffective', toleranceApplied: 0, severity: 'isolated' });
    expect(testEvidenceGate(r, i, { ...tolerated, toleranceApplied: 0 }).result.conclusion).toBe('Ineffective');
    expect(concludeTest(r, record({ sampleTested: 40, exceptions: 3 }), 0.05).conclusion).toBe('Ineffective');
  });

  it('is recorded through the API with a trail entry, survives an RCM rebuild, and is refused once the control has a test', async () => {
    const { app, svc } = await appWithDevUsers();
    const user = await signIn(app, 'auditor');
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    await svc.runModule(e.id, 'rcm', auditor);
    const control = (await svc.engagement(e.id)).rcm[0].controlId;
    const bad = await user.put(`/api/engagements/${e.id}/tolerances/${control}`, { rate: 0.3 });
    expect(bad.status).toBe(400);
    const ok = await user.put(`/api/engagements/${e.id}/tolerances/${control}`, { rate: 0.05 });
    expect(ok.status).toBe(200);
    expect(ok.body.tolerances[control]).toMatchObject({ rate: 0.05, recordedBy: 'auditor' });
    const trail = await svc.trailFor(e.id);
    const entry = trail.find((b) => b.moduleId === 'human:set-tolerance');
    expect(entry).toBeDefined();
    expect(ok.body.tolerances[control].trailBundleId).toBe(entry!.id);
    await svc.runModule(e.id, 'rcm', auditor); // rebuild
    expect((await svc.engagement(e.id)).tolerances[control].rate).toBe(0.05);
    await svc.recordTest(e.id, control, { designAdequate: true, observation: 'ok', evidenceRefs: ['E1'], sampleTested: 40, exceptions: 1 }, auditor);
    await expect(svc.setTolerance(e.id, control, 0.1, auditor)).rejects.toMatchObject({ status: 409, code: 'TOLERANCE_LOCKED' });
    const viewer = await signIn(app, 'viewer');
    expect((await viewer.put(`/api/engagements/${e.id}/tolerances/${control}`, { rate: 0.05 })).status).toBe(403);
  });

  it('is honoured by the testing module end to end, and flagged by QA when above the recommendation [REQ-30]', async () => {
    const control = 'FD-HACCP-03';
    const build = async (tolerance: number | null) => {
      const svc = await newService();
      await ensureDevUsers(svc.db.kysely); // a tolerance names its author
      const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
      await svc.runModule(e.id, 'scope', auditor);
      await svc.setScope(e.id, [{ controlId: control, included: true }], auditor);
      await svc.runModule(e.id, 'rcm', auditor);
      if (tolerance !== null) await svc.setTolerance(e.id, control, tolerance, auditor);
      await svc.recordTest(e.id, control, { designAdequate: true, observation: 'One CCP log unsigned.', evidenceRefs: ['CCP-LOG-MAR'], sampleTested: 40, exceptions: 1 }, auditor);
      const { bundle } = await svc.runModule(e.id, 'testing', auditor);
      return { svc, id: e.id, bundle, after: await svc.engagement(e.id) };
    };

    const withTolerance = await build(0.05);
    expect(withTolerance.after.testResults[control]).toMatchObject({ conclusion: 'Effective', toleranceApplied: 0.05, severity: 'isolated' });
    const fails = (withTolerance.bundle.qaActions ?? []).filter((a) => a.gate === 'evidence' && a.outcome === 'fail' && a.target === control);
    expect(fails).toEqual([]);

    const rcmRow = withTolerance.after.rcm.find((r) => r.controlId === control)!;
    const plans = { [rcmRow.id]: { rowId: rcmRow.id, sampleSize: rcmRow.sampleSize, selectionMethod: 'random', evidenceToRequest: ['log'], recommendedToleranceRate: 0 } } as unknown as typeof withTolerance.after.testPlans;
    const report = reviewSubject({ ...withTolerance.after, testPlans: plans }, 'test_plans');
    expect(report.issues.map((x) => [x.severity, x.criterion])).toContainEqual(['advisory', 'plans.tolerance-above-recommendation']);

    const without = await build(null);
    expect(without.after.testResults[control]).toMatchObject({ conclusion: 'Ineffective', toleranceApplied: 0 });
  });
});
