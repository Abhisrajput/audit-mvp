import { describe, expect, it } from 'vitest';
import { EDITED_BY_HAND, findingMemo, markEditedByHand, markEditedByPerson, planMemo, rcmMemo, sameMemo, scopeMemo } from '../src/judgment/memo';
import { approvedFindingsBasis } from '../src/agents/subjects';
import { findingContentHash, workpaperContentHash } from '../src/signing/content-hash';
import { canonicalJson, sha256 } from '../src/engine/trail';
import { engagement, finding, plan, row, scopeItem } from './agent-fixtures';

describe('memo identity and the hand-edit line', () => {
  it('treats memos as the same when only producedAt or the hand-edit line differs', () => {
    const a = rcmMemo({ rows: [row('R1', { assessedRisk: 'High', riskRating: 'Medium' })], scope: [], context: null, producedAt: '2026-10-22T00:00:00.000Z' });
    const b = { ...a, producedAt: '2026-10-23T00:00:00.000Z' };
    expect(sameMemo(a, b)).toBe(true);
    expect(sameMemo(a, markEditedByHand(b))).toBe(true);
    expect(sameMemo(a, { ...b, calls: [] })).toBe(false);
    expect(sameMemo(undefined, undefined)).toBe(true);
    expect(sameMemo(a, undefined)).toBe(false);
    expect(markEditedByHand(markEditedByHand(a)).forTheReviewer.filter((l) => l === EDITED_BY_HAND)).toHaveLength(1);
    const p = markEditedByPerson(a, 'auditor', ['likelihood likely → rare']);
    expect(p.forTheReviewer.some((l) => l.startsWith('Edited by auditor:') && l.includes('likely → rare'))).toBe(true);
    const again = markEditedByPerson(markEditedByPerson(p, 'other', ['x']), 'auditor', ['impact major → minor']);
    expect(again.forTheReviewer.filter((l) => l.startsWith('Edited by auditor:'))).toEqual(['Edited by auditor: impact major → minor.']);
    expect(again.forTheReviewer.some((l) => l.startsWith('Edited by other:'))).toBe(true);
  });

  it('says "the whole entity" for a factor with no process areas', () => {
    const context = { factors: [{ kind: 'regulatory' as const, processAreas: [], description: 'New FSMA rule' }], background: '', updatedBy: 'u', updatedAt: 't' };
    const items = [scopeItem('A', true, { processArea: 'HACCP', inherentRisk: 'Medium', assessedRisk: 'High', riskFactors: ['New FSMA rule'] })];
    const memo = scopeMemo({ items, coverage: { excluded: [], statement: 's' }, context, unknownAreas: [], modelNotes: [], producedAt: 't' });
    expect(JSON.stringify(memo)).toMatch(/the whole entity/);
  });
});

describe('memos on the plan and the finding', () => {
  it('names the selection reasons, recommended tolerances and refusals for the plans; rating, cause and recommendation for a finding', () => {
    const r1 = row('R1', { frequency: 'Daily', assessedRisk: 'Medium', packId: 'common' });
    const rows = [r1];
    const plans = { R1: plan(r1, { selectionMethod: 'judgemental', recommendedToleranceRate: 0.05 }) };
    const m = planMemo({ plans, rows, context: null, refusals: ['R1: the model proposed a tolerance of 0.2; kept 0.05'], modelChanges: [], producedAt: 't' });
    expect(m.subjectKey).toBe('test_plans');
    expect(m.calls.some((c) => c.decision.includes('judgemental'))).toBe(true);
    expect(m.calls.some((c) => c.decision.includes('5%') || c.decision.includes('0.05'))).toBe(true);
    expect(m.forTheReviewer).toContain('R1: the model proposed a tolerance of 0.2; kept 0.05');
    const f = finding('R1', 'draft', { likelihood: 'likely', impact: 'moderate', rating: 'High', rootCause: { category: 'process', analysis: 'No second check', confirmed: true } });
    const fm = findingMemo({ finding: f, row: { assessedRisk: 'Medium', riskRating: 'Medium', control: 'Reconciliation' }, result: { conclusion: 'Ineffective', exceptionRate: 0.25, severity: 'systemic' }, libraryRecommendation: 'Reconcile monthly.', modelMoves: ['root cause'], producedAt: 't' });
    expect(fm.subjectKey).toBe('finding:R1');
    expect(fm.calls.map((c) => c.source)).toEqual(['rules', 'model', 'rules']);
    expect(fm.calls[0].decision).toMatch(/High/);
  });
});

describe('hashes and bases stay exact without the new fields (plan Review Focus 5)', () => {
  it('rcm and test_plans hash as today without a memo, and findings and the report basis as today without the new fields', () => {
    const r1 = row('R1');
    const e = engagement({ rcm: [r1], testPlans: { R1: plan(r1) }, findings: [finding('R1', 'approved')] });
    expect(workpaperContentHash('rcm', e)).toBe(sha256(canonicalJson({ kind: 'rcm', content: e.rcm })));
    expect(workpaperContentHash('test_plans', e)).toBe(sha256(canonicalJson({ kind: 'test_plans', content: e.testPlans })));
    const withMemo = { ...e, memos: { rcm: rcmMemo({ rows: e.rcm, scope: [], context: null, producedAt: 't' }) } };
    expect(workpaperContentHash('rcm', withMemo)).not.toBe(workpaperContentHash('rcm', e));
    const f = e.findings[0];
    const { likelihood, impact, rootCause, memo, ...rest } = f as typeof f & { likelihood?: unknown; impact?: unknown; rootCause?: unknown; memo?: unknown };
    void likelihood; void impact; void rootCause; void memo;
    expect(findingContentHash(f)).toBe(findingContentHash(rest as typeof f));
    expect(findingContentHash({ ...f, likelihood: 'rare', impact: 'minor' })).not.toBe(findingContentHash(f));
    const legacyBasis = sha256(canonicalJson([{ id: f.id, hash: findingContentHash(f) }]));
    expect(approvedFindingsBasis(e)).toBe(legacyBasis);
    const withResponse = { ...e, responses: { [f.id]: { id: 'r1', findingId: f.id, response: 'agree' as const, owner: 'o', dueDate: null, actionPlan: '', recordedBy: 'u', recordedAt: 't', trailBundleId: 'b' } } };
    expect(approvedFindingsBasis(withResponse)).not.toBe(legacyBasis);
  });
});
