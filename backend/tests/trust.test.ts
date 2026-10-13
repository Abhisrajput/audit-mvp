import { describe, expect, it } from 'vitest';
import { loadCitationPolicy } from '../src/config';
import { PackRegistry } from '../src/engine/packs';
import { isCitable, todayUtc, trustProblems } from '../src/engine/trust';
import type { ConceptTrust } from '../src/engine/types';
import { AuditService } from '../src/service';
import { testDb } from './db';
import { approver, auditor, engagementWithFailedControl, FakeProvider, NEW_ENGAGEMENT, registry, reviewer, unattended } from './helpers';

const base: ConceptTrust = {
  nodeId: 'p/clause/x', verifiedBy: 'Dr Rao', verifiedRole: 'Pharma QA SME', verifiedAt: '2026-10-01',
  status: 'active', staleAfter: '2099-01-01', sourcePath: 'p/clauses/x.md',
};

/** The loaded registry with every clause's and control's trust replaced. */
function withTrust(change: (t: ConceptTrust) => ConceptTrust): PackRegistry {
  return new PackRegistry(registry.list().map((p) => ({
    ...p,
    clauses: p.clauses.map((c) => ({ ...c, trust: change(c.trust!) })),
    controls: p.controls.map((c) => ({ ...c, trust: change(c.trust!) })),
  })));
}
const verified = (t: ConceptTrust): ConceptTrust => ({ ...t, verifiedBy: 'Dr Rao', verifiedRole: 'Pharma QA SME', verifiedAt: '2026-10-01', staleAfter: '2099-01-01' });
/**
 * The migrated content as it is (unverified), but never due for re-review, so these tests don't start
 * seeing STALE_SOURCE once the wall clock passes the migrated stale_after (2027-10-11).
 */
const unverifiedCurrent = withTrust((t) => ({ ...t, staleAfter: '2999-12-31' }));
const strict = async (reg = unverifiedCurrent) => new AuditService(await testDb(), reg, null);
const lenient = async (reg = unverifiedCurrent) => new AuditService(await testDb(), reg, null, { citationPolicy: { allowUnverified: true } });
const trustGates = <A extends { gate: string }>(actions: A[]) => actions.filter((a) => a.gate === 'trust');

describe('trust rules [REQ-22]', () => {
  it('cites only verified, active knowledge that is not due for re-review [REQ-22]', () => {
    const today = '2026-10-11';
    expect(trustProblems(base, today)).toEqual([]);
    expect(isCitable(base, today)).toBe(true);
    expect(trustProblems({ ...base, verifiedBy: null, verifiedRole: null, verifiedAt: null }, today)).toEqual(['UNVERIFIED_SOURCE']);
    expect(trustProblems({ ...base, status: 'deprecated' }, today)).toEqual(['UNVERIFIED_SOURCE']);
    expect(trustProblems({ ...base, staleAfter: today }, today)).toEqual(['STALE_SOURCE']);
    expect(trustProblems({ ...base, staleAfter: '2026-10-12' }, today)).toEqual([]);
    expect(trustProblems({ ...base, staleAfter: null }, today)).toEqual([]);
    expect(trustProblems(undefined, today)).toEqual(['UNVERIFIED_SOURCE']);
    expect(isCitable({ ...base, staleAfter: today }, today)).toBe(false);
    expect(todayUtc(new Date('2026-10-11T23:30:00-05:00'))).toBe('2026-10-12');
  });

  it('blocks a finding that cites unverified knowledge unless unverified citations are allowed [REQ-22]', async () => {
    const svc = await strict();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    expect(f.status).toBe('blocked');
    expect(f.blockedReasons.join(' ')).toMatch(/UNVERIFIED_SOURCE: .*FD-HACCP-03/);

    const trail = await svc.trailFor(e.id);
    const gaps = trail.find((b) => b.moduleId === 'gaps')!;
    expect(trustGates(gaps.qaActions)).toEqual([expect.objectContaining({ outcome: 'fail', action: 'blocked', detail: expect.stringMatching(/^UNVERIFIED_SOURCE: /) })]);
    const rcm = trail.find((b) => b.moduleId === 'rcm')!;
    expect(trustGates(rcm.qaActions).every((a) => a.action === 'blocked')).toBe(true);
    expect(trustGates(rcm.qaActions).length).toBeGreaterThan(0);
  });

  it('flags unverified knowledge instead when allowed outside production [REQ-22]', async () => {
    const svc = await lenient();
    const e = await engagementWithFailedControl(svc);
    expect(e.findings[0].status).toBe('draft');
    const gaps = (await svc.trailFor(e.id)).find((b) => b.moduleId === 'gaps')!;
    expect(trustGates(gaps.qaActions)).toEqual([expect.objectContaining({ outcome: 'warn', action: 'flagged', detail: expect.stringMatching(/^UNVERIFIED_SOURCE: .*allowed outside production/) })]);
  });

  it('releases a finding that cites verified knowledge, and only flags stale knowledge [REQ-22]', async () => {
    const ok = await strict(withTrust(verified));
    const e = await engagementWithFailedControl(ok);
    expect(e.findings[0].status).toBe('draft');
    expect(trustGates((await ok.trailFor(e.id)).find((b) => b.moduleId === 'gaps')!.qaActions)).toEqual([expect.objectContaining({ outcome: 'pass' })]);

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const stale = await strict(withTrust((t) => ({ ...verified(t), staleAfter: yesterday })));
    const s = await engagementWithFailedControl(stale);
    expect(s.findings[0].status).toBe('draft');
    expect(trustGates((await stale.trailFor(s.id)).find((b) => b.moduleId === 'gaps')!.qaActions)).toEqual([
      expect.objectContaining({ outcome: 'warn', action: 'flagged', detail: expect.stringMatching(/^STALE_SOURCE: .*past re-review date/) }),
    ]);
  });

  it('applies the rules to human edits too [REQ-22]', async () => {
    const svc = await lenient();
    const e = await engagementWithFailedControl(svc);
    const strictSameDb = new AuditService(svc.db, unverifiedCurrent, null);
    const edited = await strictSameDb.editFinding(e.id, e.findings[0].id, { title: 'Edited title' }, auditor);
    expect(edited.status).toBe('blocked');
    expect(edited.blockedReasons.join(' ')).toMatch(/UNVERIFIED_SOURCE/);
  });

  it('lists every cited clause and control that is not citable in the report [REQ-22]', async () => {
    const svc = await lenient();
    const e = await engagementWithFailedControl(svc);
    await svc.runModule(e.id, 'report', auditor);
    const md = (await svc.engagement(e.id)).report!.markdown;
    const line = md.split('\n').find((l) => l.startsWith('Cited sources not yet verified'))!;
    const expected = new Set(e.rcm.flatMap((r) => [...r.citations.map((c) => c.clauseId), r.controlId]));
    expect(e.rcm.map((r) => r.controlId)).toContain('FD-HACCP-03');
    for (const id of expected) expect(line).toContain(id);
    expect(line).toContain(`(${expected.size})`);

    const ok = await strict(withTrust(verified));
    const v = await engagementWithFailedControl(ok);
    await ok.runModule(v.id, 'report', auditor);
    expect((await ok.engagement(v.id)).report!.markdown).toContain('due for re-review (0): none.');
  });

  it('lists clauses a finding cites outside its RCM row in the report [REQ-22]', async () => {
    // The model cites a grounding-set clause that is not one of the row's own clauses; only that clause is unverified.
    const rowClauses = new Set(registry.controls.get('FD-HACCP-03')!.clauseRefs);
    let extra = '';
    const llm = new FakeProvider((req) => {
      if (req.user.includes('Draft one audit finding')) {
        const [row] = JSON.parse(req.user.slice(req.user.indexOf('>\n', req.user.indexOf('<data source="workpaper:failed-controls"')) + 2, req.user.lastIndexOf('\n</data>'))) as { allowedClauses: { clauseId: string }[] }[];
        extra = row.allowedClauses.map((c) => c.clauseId).find((id) => !rowClauses.has(id))!;
        return { findings: [{ rowId: 'FD-HACCP-03', title: 't', rating: 'High', condition: 'c', criteria: 'c', cause: 'c', effect: 'e', recommendation: 'r', clauseIds: [...rowClauses, extra] }] };
      }
      if (req.user.includes('Conclude on each')) return { results: [] };
      if (req.user.includes('Tailor these')) return { rows: [] };
      return { items: [] };
    });
    // The extra clause is marked unverified once the model has picked it; the report reads trust from the registry.
    const reg = withTrust(verified);
    const svc = new AuditService(await testDb(), reg, llm, { citationPolicy: { allowUnverified: true } });
    // Only the failed control in scope, so the RCM's citations are exactly that row's.
    const created = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    await svc.runModule(created.id, 'scope', auditor);
    const candidates = (await svc.engagement(created.id)).scope.map((x) => ({ controlId: x.controlId, included: x.controlId === 'FD-HACCP-03' }));
    await svc.setScope(created.id, candidates, auditor);
    await svc.runModule(created.id, 'rcm', auditor);
    await svc.recordTest(created.id, 'FD-HACCP-03', { designAdequate: true, observation: '3 of 20 CCP logs unsigned.', evidenceRefs: ['CCP-LOG-MAR'], sampleTested: 20, exceptions: 3 }, auditor);
    await svc.runModule(created.id, 'testing', auditor);
    await svc.runModule(created.id, 'gaps', auditor);
    const e = await svc.engagement(created.id);
    expect(e.rcm.map((r) => r.controlId)).toEqual(['FD-HACCP-03']);
    expect(extra).not.toBe('');
    const f = e.findings[0];
    expect(f.citations.map((c) => c.clauseId)).toContain(extra);
    expect(e.rcm.flatMap((r) => r.citations.map((c) => c.clauseId))).not.toContain(extra);
    const clause = reg.clauses.get(extra)!; // the registry's own copy
    clause.trust = { ...clause.trust!, verifiedBy: null, verifiedRole: null, verifiedAt: null };
    await svc.signOff(e.id, f.id, 'review', '', reviewer, {}, unattended);
    await svc.signOff(e.id, f.id, 'approve', '', approver, {}, unattended);
    await svc.runModule(e.id, 'report', auditor);
    const line = (await svc.engagement(e.id)).report!.markdown.split('\n').find((l) => l.startsWith('Cited sources not yet verified'))!;
    expect(line).toContain('(1)');
    expect(line).toContain(extra);
  });

  it('re-checks trust when a finding is approved [REQ-22]', async () => {
    // Drafted and reviewed while its sources were verified; a later content release leaves them unverified.
    const drafting = await strict(withTrust(verified));
    const e = await engagementWithFailedControl(drafting);
    const f = e.findings[0];
    expect(f.status).toBe('draft');
    await drafting.signOff(e.id, f.id, 'review', '', reviewer, {}, unattended);

    const strictNow = new AuditService(drafting.db, unverifiedCurrent, null);
    await expect(strictNow.checkSignOff(e.id, f.id, 'approve', approver)).rejects.toMatchObject({ code: 'FINDING_BLOCKED', message: expect.stringMatching(/UNVERIFIED_SOURCE/) });
    await expect(strictNow.signOff(e.id, f.id, 'approve', '', approver, {}, unattended)).rejects.toMatchObject({ code: 'FINDING_BLOCKED' });
    expect((await strictNow.engagement(e.id)).findings[0].status).toBe('reviewed');

    // A concept no longer in the library is not citable either.
    const cited = f.citations[0].clauseId;
    const without = new PackRegistry(registry.list().map((p) => ({
      ...p,
      clauses: p.clauses.filter((c) => c.id !== cited).map((c) => ({ ...c, trust: verified(c.trust!) })),
      controls: p.controls.map((c) => ({ ...c, clauseRefs: c.clauseRefs.filter((id) => id !== cited), trust: verified(c.trust!) })),
    })));
    await expect(new AuditService(drafting.db, without, null).signOff(e.id, f.id, 'approve', '', approver, {}, unattended))
      .rejects.toMatchObject({ code: 'FINDING_BLOCKED', message: expect.stringContaining(cited) });

    const lenientNow = new AuditService(drafting.db, unverifiedCurrent, null, { citationPolicy: { allowUnverified: true } });
    const done = await lenientNow.signOff(e.id, f.id, 'approve', '', approver, {}, unattended);
    expect(done.status).toBe('approved');
    const signOff = (await lenientNow.trailFor(e.id)).filter((b) => b.moduleId === 'human:sign-off').at(-1)!;
    expect(trustGates(signOff.qaActions)).toEqual([expect.objectContaining({ target: f.id, outcome: 'warn', action: 'flagged', detail: expect.stringMatching(/^UNVERIFIED_SOURCE: /) })]);
  });

  it('refuses ALLOW_UNVERIFIED_CITATIONS in production and anything but true or false [REQ-22]', () => {
    expect(loadCitationPolicy({})).toEqual({ allowUnverified: false });
    expect(loadCitationPolicy({ ALLOW_UNVERIFIED_CITATIONS: 'true', NODE_ENV: 'development' })).toEqual({ allowUnverified: true });
    expect(() => loadCitationPolicy({ ALLOW_UNVERIFIED_CITATIONS: 'true', NODE_ENV: 'production' })).toThrow(/ALLOW_UNVERIFIED_CITATIONS: must not be true in production/);
    expect(() => loadCitationPolicy({ ALLOW_UNVERIFIED_CITATIONS: 'yes' })).toThrow(/ALLOW_UNVERIFIED_CITATIONS: must be "true" or "false"/);
  });
});
