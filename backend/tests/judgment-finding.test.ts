import { describe, expect, it } from 'vitest';
import { reviewSubject } from '../src/agents/qa/deterministic';
import { findingKey } from '../src/agents/subjects';
import { impactOf, IMPACTS, LIKELIHOODS, likelihoodOf, oneStepWorse, ratingOf } from '../src/judgment/finding';
import { AuditService } from '../src/service';
import type { Finding } from '../src/engine/types';
import { auditor, engagementWithFailedControl, FakeProvider, gapsAnswerFrom, LENIENT, newService, registry } from './helpers';
import { appWithDevUsers, draftFinding } from './http';
import { testDb } from './db';

const ratingFromMatrix = (f: Finding) => ratingOf(f.likelihood!, f.impact!);

describe('finding judgment (spec §5.5) [REQ-32]', () => {
  it('rates by the matrix from the assessed risk and the result, with an unconfirmed cause and the library recommendation, and a memo on the finding [REQ-31]', async () => {
    const svc = await newService();
    const { id } = await engagementWithFailedControl(svc);
    await svc.runModule(id, 'gaps', auditor);
    const e = await svc.engagement(id);
    const f = e.findings.find((x) => x.controlId === 'FD-HACCP-03')!;
    expect(f).toMatchObject({ likelihood: expect.any(String), impact: expect.any(String), rootCause: { category: 'unknown', confirmed: false } });
    expect(f.rating).toBe(ratingFromMatrix(f));
    expect(f.memo?.subjectKey).toBe(findingKey(f.rowId));
    expect(f.memo?.calls.map((c) => c.question)).toHaveLength(3);
    const r = reviewSubject(e, findingKey(f.rowId));
    expect(r.issues.map((i) => i.criterion)).not.toContain('finding.rating-matrix');
  });

  it('lets the model worsen likelihood or impact by one step and confirm a supported cause; refuses the rest, in the trail', async () => {
    const model = new FakeProvider((req) => gapsAnswerFrom(req, { likelihood: 'likely', impact: 'minor', rootCause: { category: 'people', analysis: 'The line lead was on leave and nobody covered the check', confirmed: true } }));
    const svc = new AuditService(await testDb(), registry, model, LENIENT);
    const e0 = await engagementWithFailedControl(svc, 'FD-HACCP-03', undefined, { observation: 'Checks missed while the line lead was on leave; nobody covered.' });
    const { bundle, engagement: e } = await svc.runModule(e0.id, 'gaps', auditor);
    const f = e.findings.find((x) => x.controlId === 'FD-HACCP-03')!;
    const row = e.rcm.find((r) => r.id === f.rowId)!;
    const ruleLikelihood = likelihoodOf(e.testResults[f.rowId]);
    const ruleImpact = impactOf(row.assessedRisk ?? row.riskRating);
    expect(f.likelihood).toBe(oneStepWorse(LIKELIHOODS, ruleLikelihood, 'likely') ? 'likely' : ruleLikelihood);
    expect(f.impact).toBe(oneStepWorse(IMPACTS, ruleImpact, 'minor') ? 'minor' : ruleImpact);
    expect(f.rootCause).toMatchObject({ category: 'people', confirmed: true });
    expect(f.memo?.calls.find((c) => c.question.toLowerCase().includes('root cause'))?.source).toBe('model');
    const refusals = bundle.qaActions.filter((a) => a.gate === 'judgment-bounds');
    expect(refusals.some((a) => a.detail.includes('impact'))).toBe(true); // 'minor' is never worse than the rule's value
    expect(f.rating).toBe(ratingFromMatrix(f));
  });

  describe('bounds on a model move, against known rule values', () => {
    const cause = { category: 'process', analysis: 'No second check', confirmed: false };
    // 1 exception in 40 is a rate of 0.025, below RARE_BELOW, so the rule's likelihood is rare.
    async function run(overlay: Record<string, unknown>) {
      const model = new FakeProvider((req) => gapsAnswerFrom(req, { rootCause: cause, ...overlay }));
      const svc = new AuditService(await testDb(), registry, model, LENIENT);
      const e0 = await engagementWithFailedControl(svc, 'FD-HACCP-03', undefined, { sampleTested: 40, exceptions: 1 });
      const { bundle, engagement: e } = await svc.runModule(e0.id, 'gaps', auditor);
      const f = e.findings.find((x) => x.controlId === 'FD-HACCP-03')!;
      return { f, refusals: bundle.qaActions.filter((a) => a.gate === 'judgment-bounds' && a.target === f.rowId) };
    }

    it('accepts a likelihood exactly one step worse', async () => {
      const { f, refusals } = await run({ likelihood: 'possible' });
      expect(f.likelihood).toBe('possible');
      expect(f.rating).toBe(ratingFromMatrix(f));
      expect(refusals.some((a) => a.detail.includes('likelihood'))).toBe(false);
    });

    it('refuses a likelihood two steps worse and keeps the rule value', async () => {
      const { f, refusals } = await run({ likelihood: 'likely' });
      expect(f.likelihood).toBe('rare');
      expect(refusals.some((a) => a.detail.includes('likelihood'))).toBe(true);
    });

    it('keeps the rule values, with no refusal, when the model omits likelihood and impact', async () => {
      const { f, refusals } = await run({});
      expect(f.likelihood).toBe('rare');
      expect(f.impact).toBe('major');
      expect(f.recommendation).toBe('Tailored recommendation'); // the model's text was used, not a silent rules fallback
      expect(refusals).toEqual([]);
    });
  });

  it('edits a finding drafted before 8B: likelihood falls back to possible, impact follows the patch, and a memo-less finding edits cleanly', async () => {
    const svc = await newService();
    const e0 = await engagementWithFailedControl(svc);
    // There is no public way to persist a pre-8B finding, so strip the new fields through the service's own mutation.
    await (svc as unknown as { mutate: (id: string, o: object, fn: (e: typeof e0) => unknown) => Promise<unknown> }).mutate(e0.id, {}, (e) => {
      e.findings = e.findings.map(({ likelihood, impact, rootCause, memo, ...f }) => f as Finding);
      return null;
    });
    const stripped = (await svc.engagement(e0.id)).findings[0];
    expect(stripped.memo).toBeUndefined();
    const edited = await svc.editFinding(e0.id, stripped.id, { impact: 'minor' }, auditor);
    expect(edited).toMatchObject({ likelihood: 'possible', impact: 'minor', rating: ratingOf('possible', 'minor') });
  });

  it('edits only the likelihood of a finding drafted before 8B: impact is the one its stored rating implies, and the rating follows both', async () => {
    const svc = await newService();
    const e0 = await engagementWithFailedControl(svc);
    await (svc as unknown as { mutate: (id: string, o: object, fn: (e: typeof e0) => unknown) => Promise<unknown> }).mutate(e0.id, {}, (e) => {
      e.findings = e.findings.map(({ likelihood, impact, rootCause, memo, ...f }) => f as Finding);
      return null;
    });
    const stripped = (await svc.engagement(e0.id)).findings[0];
    expect(stripped.impact).toBeUndefined();
    const edited = await svc.editFinding(e0.id, stripped.id, { likelihood: 'rare' }, auditor);
    expect(edited.impact).toBe(impactOf(stripped.rating));
    expect(edited).toMatchObject({ likelihood: 'rare', rating: ratingOf('rare', impactOf(stripped.rating)) });
  });

  it('lets a person lower the likelihood, recomputes the rating, names them in the memo, passes QA, and refuses a rating in the body (plan Review Focus 2, 4)', async () => {
    const { app, svc } = await appWithDevUsers();
    const { auditor: user, id, fid } = await draftFinding(app);
    const before = (await svc.engagement(id)).findings.find((f) => f.id === fid)!;
    const bad = await user.put(`/api/engagements/${id}/findings/${fid}`, { rating: 'Low' });
    expect(bad.status).toBe(400);
    const ok = await user.put(`/api/engagements/${id}/findings/${fid}`, { likelihood: 'rare', impact: 'minor' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ likelihood: 'rare', impact: 'minor', rating: 'Low' });
    expect(ok.body.memo.forTheReviewer.some((l: string) => l.startsWith('Edited by auditor:') && l.includes('likelihood'))).toBe(true);
    const e = await svc.engagement(id);
    expect(reviewSubject(e, findingKey(before.rowId)).issues.map((i) => i.criterion)).not.toContain('finding.rating-matrix');
    expect((await svc.trailFor(id)).some((b) => b.moduleId === 'human:finding-edit')).toBe(true);
  });

  describe('a person\'s edit keeps the memo consistent with the finding (final review I1)', () => {
    const editLine = (memo: { forTheReviewer: string[] } | undefined) => memo?.forTheReviewer.find((l) => l.startsWith('Edited by auditor:'));
    const callOf = (f: Finding, question: string) => f.memo!.calls.find((c) => c.question === question)!;

    it('rebuilds the rating call from the new likelihood and impact, marked as the person\'s change, keeping the standards', async () => {
      const { app, svc } = await appWithDevUsers();
      const { auditor: user, id, fid } = await draftFinding(app);
      const before = (await svc.engagement(id)).findings.find((f) => f.id === fid)!;
      const wasDecision = callOf(before, 'Rating of the finding').decision;
      const ok = await user.put(`/api/engagements/${id}/findings/${fid}`, { likelihood: 'rare', impact: 'minor' });
      const f = ok.body as Finding;
      const rating = callOf(f, 'Rating of the finding');
      expect(rating.decision).toBe(`${f.rating} (rare likelihood, minor impact)`);
      expect(rating.rationale).toContain(`Set by auditor: was ${wasDecision}`);
      expect(rating.standard).toEqual(callOf(before, 'Rating of the finding').standard);
    });

    it('refreshes the recommendation call when the recommendation changes, and names the field in a text-only edit with no likelihood or impact pair', async () => {
      const { app, svc } = await appWithDevUsers();
      const { auditor: user, id, fid } = await draftFinding(app);
      const before = (await svc.engagement(id)).findings.find((f) => f.id === fid)!;
      const ok = await user.put(`/api/engagements/${id}/findings/${fid}`, { recommendation: 'Add a second check at the line', likelihood: before.likelihood, impact: before.impact });
      expect(ok.status).toBe(200);
      const f = ok.body as Finding;
      const rec = callOf(f, 'Recommendation');
      expect(rec.decision).toBe('Add a second check at the line');
      expect(rec.rationale).toContain('Set by auditor');
      const line = editLine(f.memo)!;
      expect(line).toContain('recommendation');
      expect(line).not.toMatch(/likelihood|impact/);
      expect(callOf(f, 'Rating of the finding').decision).toBe(callOf(before, 'Rating of the finding').decision);
    });

    it('writes an Edited by line for a text-only patch, and no pair for a same-value likelihood and impact resubmission', async () => {
      const { app, svc } = await appWithDevUsers();
      const { auditor: user, id, fid } = await draftFinding(app);
      const before = (await svc.engagement(id)).findings.find((f) => f.id === fid)!;
      const text = await user.put(`/api/engagements/${id}/findings/${fid}`, { condition: `${before.condition} (corrected)` });
      expect(editLine(text.body.memo)).toContain('condition');
      const same = await user.put(`/api/engagements/${id}/findings/${fid}`, { condition: `${before.condition} (corrected again)`, likelihood: before.likelihood, impact: before.impact });
      const line = editLine(same.body.memo)!;
      expect(line).toContain('condition');
      expect(line).not.toMatch(/likelihood|impact/);
    });
  });

  it('serves the finding memo from the memos route', async () => {
    const { app, svc } = await appWithDevUsers();
    const { auditor: user, id, fid } = await draftFinding(app);
    const finding = (await svc.engagement(id)).findings.find((f) => f.id === fid)!;
    const res = await user.get(`/api/engagements/${id}/memos/${findingKey(finding.rowId)}`);
    expect(res.status).toBe(200);
    expect(res.body.memo.subjectKey).toBe(findingKey(finding.rowId));
  });

  it('raises no new issue for a finding drafted before 8B (plan Review Focus 1)', async () => {
    const svc = await newService();
    const { id } = await engagementWithFailedControl(svc);
    await svc.runModule(id, 'gaps', auditor);
    const e = await svc.engagement(id);
    const legacy = { ...e, findings: e.findings.map(({ likelihood, impact, rootCause, memo, ...f }) => f as typeof e.findings[number]) };
    const issues = reviewSubject(legacy, findingKey(e.findings[0].rowId)).issues.map((i) => i.criterion);
    expect(issues.filter((c) => c.startsWith('finding.rating') || c.startsWith('finding.root-cause') || c.startsWith('finding.recommendation-verbatim'))).toEqual([]);
  });
});
