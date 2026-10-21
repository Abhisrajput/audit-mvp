import { describe, expect, it } from 'vitest';
import { reviewSubject } from '../src/agents/qa/deterministic';
import { findingKey } from '../src/agents/subjects';
import { impactOf, IMPACTS, LIKELIHOODS, likelihoodOf, oneStepWorse, ratingOf } from '../src/judgment/finding';
import { AuditService } from '../src/service';
import type { Finding } from '../src/engine/types';
import { auditor, engagementWithFailedControl, FakeProvider, LENIENT, newService, registry } from './helpers';
import { appWithDevUsers, draftFinding } from './http';
import { testDb } from './db';

/** The gaps prompt's answer: every finding as the data gives it, plus the overlay; any other request throws so the module falls back to its rules. */
function gapsAnswerFrom(req: { user: string }, overlay: Record<string, unknown>) {
  if (!req.user.includes('Draft one audit finding')) throw new Error('not the gaps prompt');
  const open = req.user.indexOf('>\n', req.user.indexOf('<data source="workpaper:failed-controls"')) + 2;
  const rows = JSON.parse(req.user.slice(open, req.user.lastIndexOf('\n</data>'))) as { rowId: string; control: string; risk: string; record: { observation: string }; allowedClauses: { clauseId: string }[] }[];
  return {
    findings: rows.map((r) => ({
      rowId: r.rowId, title: r.control, condition: r.record.observation, criteria: 'criteria', cause: 'cause', effect: r.risk,
      recommendation: 'Tailored recommendation', clauseIds: r.allowedClauses.map((c) => c.clauseId).slice(0, 1), ...overlay,
    })),
  };
}

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
