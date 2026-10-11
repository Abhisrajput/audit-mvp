import { describe, expect, it } from 'vitest';
import { PackRegistry } from '../src/engine/packs';
import { verifyChain } from '../src/engine/trail';
import type { ContentPack, User } from '../src/engine/types';
import { auditor, admin, approver, engagementWithFailedControl, FakeProvider, newService, registry, reviewer, viewer } from './helpers';

const META = { name: 'x', entity: 'x', site: 'x', periodFrom: 'a', periodTo: 'b', auditType: 'x', packIds: ['common'] };

describe('content packs', () => {
  it('loads all packs with valid cross-references [REQ-12]', () => {
    expect(registry.list().map((p) => p.id).sort()).toEqual(['common', 'food', 'pharma']);
    for (const c of registry.controls.values()) expect(c.clauseRefs.every((r) => registry.clauses.has(r))).toBe(true);
  });

  it('rejects a pack whose control cites an unknown clause [REQ-12]', () => {
    const bad = JSON.parse(JSON.stringify(registry.get('common'))) as ContentPack;
    bad.controls[0].clauseRefs = ['NOPE-1'];
    expect(() => new PackRegistry([bad])).toThrow(/unknown clause NOPE-1/);
  });
});

describe('module chain', () => {
  it('enforces chain order [REQ-11]', async () => {
    const svc = await newService();
    const e = await svc.createEngagement({ ...META, scopeStatement: 'hedging limits' }, auditor);
    await expect(svc.runModule(e.id, 'rcm', auditor)).rejects.toThrow(/Risk & Scope/);
    await expect(svc.runModule(e.id, 'testing', auditor)).rejects.toThrow(/field work/);
  });

  it('scope ranks treasury controls for a hedging scope', async () => {
    const svc = await newService();
    const e = await svc.createEngagement({ ...META, auditType: 'Treasury', scopeStatement: 'Commodity hedging: positions against limits, trade confirmations and hedge documentation' }, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    const included = (await svc.engagement(e.id)).scope.filter((s) => s.included).map((s) => s.controlId);
    expect(included).toEqual(expect.arrayContaining(['CMN-TRS-02', 'CMN-TRS-03', 'CMN-TRS-04']));
  });

  it('every RCM row carries verified citations [REQ-01]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    expect(e.rcm.length).toBeGreaterThan(0);
    for (const row of e.rcm) {
      expect(row.citations.length).toBeGreaterThan(0);
      expect(row.citations.every((c) => registry.clauses.has(c.clauseId))).toBe(true);
    }
    const rcmRun = (await svc.trailFor(e.id)).find((b) => b.moduleId === 'rcm')!;
    expect(rcmRun.qaActions.every((a) => a.gate === 'citation' && a.outcome === 'pass')).toBe(true);
  });
});

describe('QA gates', () => {
  it('overrides an Effective conclusion when exceptions exist [REQ-04]', async () => {
    const lying = new FakeProvider((req) =>
      req.system && req.user.includes('Conclude on each control test')
        ? { results: [{ rowId: 'FD-HACCP-03', conclusion: 'Effective', rationale: 'Looks fine.' }] }
        : JSON.parse('{"items":[],"rows":[],"findings":[],"executiveSummary":"x"}'),
    );
    const svc = await newService(lying);
    const e = await engagementWithFailedControl(svc);
    expect(e.testResults['FD-HACCP-03'].conclusion).toBe('Ineffective');
    const run = (await svc.trailFor(e.id)).find((b) => b.moduleId === 'testing')!;
    expect(run.qaActions).toContainEqual(expect.objectContaining({ gate: 'evidence', outcome: 'fail', action: 'downgraded' }));
  });

  it('downgrades Effective without evidence to Not tested [REQ-05]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    await svc.recordTest(e.id, 'FD-HACCP-03', { designAdequate: true, observation: 'All logs signed.', evidenceRefs: [], sampleTested: 20, exceptions: 0 }, auditor);
    await svc.runModule(e.id, 'testing', auditor);
    expect((await svc.engagement(e.id)).testResults['FD-HACCP-03'].conclusion).toBe('Not tested');
  });

  it('blocks a finding without an evidence reference [REQ-02]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc, 'FD-HACCP-03', []);
    const f = e.findings[0];
    expect(f.status).toBe('blocked');
    expect(f.blockedReasons.join()).toMatch(/evidence/);
    await expect(svc.signOff(e.id, f.id, 'review', '', reviewer)).rejects.toThrow(/blocked/);
  });

  it('releases a finding with clause, control and evidence citations [REQ-02]', async () => {
    const e = await engagementWithFailedControl(await newService());
    const f = e.findings[0];
    expect(f.status).toBe('draft');
    expect(f.citations.map((c) => c.clauseId)).toContain('21CFR117.145');
    expect(f.controlId).toBe('FD-HACCP-03');
    expect(f.evidenceRefs).toEqual(['CCP-LOG-MAR']);
  });

  it('blocks a model-drafted finding that cites a clause outside its grounding set [REQ-03]', async () => {
    const llm = new FakeProvider((req) => {
      if (req.user.includes('Draft one audit finding')) {
        return { findings: [{ rowId: 'FD-HACCP-03', title: 't', rating: 'High', condition: 'c', criteria: '§211.192', cause: 'c', effect: 'e', recommendation: 'r', clauseIds: ['21CFR211.192'] }] };
      }
      if (req.user.includes('Conclude on each')) return { results: [] };
      if (req.user.includes('Tailor these')) return { rows: [] };
      return { items: [] };
    });
    const e = await engagementWithFailedControl(await newService(llm));
    expect(e.findings[0].status).toBe('blocked');
    expect(e.findings[0].blockedReasons.join()).toMatch(/outside the grounding set/);
  });

  it('rejects model-proposed controls not in the library [REQ-14]', async () => {
    const llm = new FakeProvider((req) => (req.user.includes('Candidate controls') ? { items: [{ controlId: 'MADE-UP-1', included: true, rationale: 'x' }] } : { rows: [], results: [], findings: [] }));
    const svc = await newService(llm);
    const e = await svc.createEngagement({ ...META, scopeStatement: 'hedging' }, auditor);
    const { bundle } = await svc.runModule(e.id, 'scope', auditor);
    expect((await svc.engagement(e.id)).scope.some((s) => s.controlId === 'MADE-UP-1')).toBe(false);
    expect(bundle.qaActions).toContainEqual(expect.objectContaining({ gate: 'library-only', outcome: 'fail' }));
    expect(bundle.provider).toEqual({ id: 'fake', model: 'fake-1' });
    expect(bundle.promptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('falls back to deterministic rules with a QA flag when the model fails [REQ-14]', async () => {
    const broken = { id: 'broken', model: 'b', generate: async () => { throw new Error('upstream 529'); } };
    const svc = await newService(broken);
    const e = await svc.createEngagement({ ...META, scopeStatement: 'hedging limits' }, auditor);
    const { bundle } = await svc.runModule(e.id, 'scope', auditor);
    expect((await svc.engagement(e.id)).scope.length).toBeGreaterThan(0);
    expect(bundle.qaActions).toContainEqual(expect.objectContaining({ gate: 'model-availability', outcome: 'warn' }));
  });
});

describe('sign-off and release', () => {
  it('requires review then approval by a different person, with signature manifestation [REQ-08, REQ-15]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await expect(svc.signOff(e.id, f.id, 'approve', '', approver)).rejects.toThrow(/reviewed before/);
    await expect(svc.signOff(e.id, f.id, 'review', '', auditor)).rejects.toThrow(/may not/);
    await svc.signOff(e.id, f.id, 'review', 'ok', reviewer);
    await expect(svc.signOff(e.id, f.id, 'approve', '', reviewer)).rejects.toThrow(/may not/);
    const done = await svc.signOff(e.id, f.id, 'approve', 'agreed', approver);
    expect(done.status).toBe('approved');
    expect(done.signOffs.map((s) => [s.userId, s.role, s.meaning])).toEqual([
      ['reviewer', 'audit_manager', 'Reviewed'],
      ['approver', 'cae', 'Approved'],
    ]);
    expect(done.signOffs.every((s) => !Number.isNaN(Date.parse(s.at)))).toBe(true);
  });

  it('locks approved findings against edit and regeneration [REQ-09]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.signOff(e.id, f.id, 'review', '', reviewer);
    await svc.signOff(e.id, f.id, 'approve', '', approver);
    await expect(svc.editFinding(e.id, f.id, { title: 'changed' }, auditor)).rejects.toThrow(/locked/);
    await svc.runModule(e.id, 'gaps', auditor);
    expect((await svc.engagement(e.id)).findings.find((x) => x.id === f.id)?.title).toBe(f.title);
  });

  it('editing a reviewed finding resets it to draft and re-runs the citation gate [REQ-08]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.signOff(e.id, f.id, 'review', '', reviewer);
    const edited = await svc.editFinding(e.id, f.id, { evidenceRefs: [] }, auditor);
    expect(edited.status).toBe('blocked');
    expect(edited.signOffs).toEqual([]);
  });

  it('report includes approved findings only [REQ-10]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.runModule(e.id, 'report', auditor);
    expect((await svc.engagement(e.id)).report!.includedFindingIds).toEqual([]);
    expect((await svc.engagement(e.id)).report!.excludedFindingIds).toEqual([f.id]);
    await svc.signOff(e.id, f.id, 'review', '', reviewer);
    await svc.signOff(e.id, f.id, 'approve', '', approver);
    await svc.runModule(e.id, 'report', auditor);
    const report = (await svc.engagement(e.id)).report!;
    expect(report.includedFindingIds).toEqual([f.id]);
    expect(report.markdown).toContain(f.title);
    expect(report.markdown).toContain('21 CFR Part 117');
  });
});

describe('audit trail', () => {
  it('records a complete bundle for module runs and human actions [REQ-06]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const trail = await svc.trailFor(e.id);
    expect(trail.map((b) => b.moduleId)).toEqual([
      'human:create-engagement', 'scope', 'human:scope-decision', 'rcm', 'human:test-record', 'testing', 'gaps',
    ]);
    const gaps = trail.find((b) => b.moduleId === 'gaps')!;
    expect(gaps.retrievalSet.length).toBeGreaterThan(0);
    expect(gaps.executionLog.length).toBeGreaterThan(0);
    expect(gaps.qaActions.length).toBeGreaterThan(0);
    expect(gaps.packVersions).toEqual({ food: '0.1.0', common: '0.1.0' });
    expect(gaps.provider.id).toBe('offline');
    expect(gaps.actor).toBe('auditor');
    expect(e.findings[0].bundleId).toBe(gaps.id);
  });

  it('detects tampering with any past bundle [REQ-07]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    await svc.signOff(e.id, e.findings[0].id, 'review', '', reviewer);
    await svc.setScope(e.id, e.scope.map((s) => ({ controlId: s.controlId, included: !s.included })), auditor);
    expect((await svc.verifyTrail()).valid).toBe(true);
    const chain = await svc.trailFor(e.id);
    (chain[2].output as any) = { tampered: true };
    const v = verifyChain(chain);
    expect(v.valid).toBe(false);
    expect(v.brokenAt).toBe(3);
  });
});

describe('transactions and concurrency', () => {
  it('rolls back state and trail together when a module is refused', async () => {
    const svc = await newService();
    const e = await svc.createEngagement({ ...META, scopeStatement: 'hedging limits' }, auditor);
    await expect(svc.runModule(e.id, 'testing', auditor)).rejects.toThrow();
    expect((await svc.trailFor(e.id)).map((b) => b.moduleId)).toEqual(['human:create-engagement']);
    expect((await svc.engagement(e.id)).version).toBe(1);
  });

  it('rejects a change made from a stale version and keeps the winner [REQ-21]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const v = e.version!;
    const record = (observation: string) =>
      svc.recordTest(e.id, 'FD-HACCP-03', { designAdequate: true, observation, evidenceRefs: ['X'], sampleTested: 20, exceptions: 1 }, auditor, { expectedVersion: v });
    const results = await Promise.allSettled([record('first'), record('second')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect((await svc.engagement(e.id)).version).toBe(v + 1);
    expect((await svc.verifyTrail()).valid).toBe(true);
  });

  it('serialises concurrent changes without a version check, losing nothing', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const v = e.version!;
    const before = (await svc.trailFor(e.id)).length;
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        svc.recordTest(e.id, 'FD-HACCP-03', { designAdequate: true, observation: `pass ${n}`, evidenceRefs: ['X'], sampleTested: 20, exceptions: 0 }, auditor),
      ),
    );
    const after = await svc.engagement(e.id);
    expect(after.version).toBe(v + 5);
    const trail = await svc.trailFor(e.id);
    expect(trail).toHaveLength(before + 5);
    const last = trail.at(-1)!.inputs as { observation: string };
    expect(after.testInputs['FD-HACCP-03'].observation).toBe(last.observation);
    expect((await svc.verifyTrail()).valid).toBe(true);
  });
});

describe('segregation of duties', () => {
  const manager2: User = { id: 'manager2', name: 'Maya Manager', role: 'audit_manager' };

  it('stops whoever ran Gap Writer from reviewing the findings it drafted [REQ-17]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    await svc.runModule(e.id, 'gaps', reviewer); // the audit manager redrafts, so now prepares the finding
    const f = (await svc.engagement(e.id)).findings[0];
    expect(f.preparedBy).toEqual(['reviewer']);
    await expect(svc.signOff(e.id, f.id, 'review', '', reviewer)).rejects.toMatchObject({ status: 403, code: 'SOD_VIOLATION' });
    await expect(svc.signOff(e.id, f.id, 'review', '', manager2)).resolves.toMatchObject({ status: 'reviewed' });
  });

  it('treats editing a finding as preparing it [REQ-17]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    expect(f.preparedBy).toEqual(['auditor']);
    const edited = await svc.editFinding(e.id, f.id, { title: 'Roaster CCP logs unsigned' }, reviewer);
    expect(edited.preparedBy).toEqual(['auditor', 'reviewer']);
    await expect(svc.signOff(e.id, f.id, 'review', '', reviewer)).rejects.toMatchObject({ code: 'SOD_VIOLATION' });
  });

  it('keeps the reviewer from also approving, judged by person rather than role [REQ-17]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.signOff(e.id, f.id, 'review', '', reviewer);
    const promoted: User = { ...reviewer, role: 'cae' }; // same person, given the CAE role between steps
    await expect(svc.signOff(e.id, f.id, 'approve', '', promoted)).rejects.toMatchObject({ status: 403, code: 'SOD_VIOLATION' });
  });

  it('gives admins and viewers no way to change audit work [REQ-15]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    for (const u of [admin, viewer]) {
      await expect(svc.runModule(e.id, 'report', u)).rejects.toMatchObject({ status: 403 });
      await expect(
        svc.recordTest(e.id, 'FD-HACCP-03', { designAdequate: true, observation: 'x', evidenceRefs: ['X'], sampleTested: 1, exceptions: 0 }, u),
      ).rejects.toMatchObject({ status: 403 });
      await expect(svc.signOff(e.id, e.findings[0].id, 'review', '', u)).rejects.toMatchObject({ status: 403 });
    }
  });
});
