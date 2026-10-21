// backend/tests/judgment-rules.test.ts
import { describe, expect, it } from 'vitest';
import { CONTEXT_LIMITS, contextBasis, EngagementContextInputSchema, factorsFor } from '../src/judgment/context';
import { acceptsOverlay, areaRisk, assessControl, isTouched, stepUp } from '../src/judgment/risk-assessment';
import { contextInclusions, coverageStatement, excludedAreas, includedByRule, INCLUSION_THRESHOLD, statementCoversAll } from '../src/judgment/coverage';
import { renderMemo, scopeMemo } from '../src/judgment/memo';
import { IIA } from '../src/judgment/standards';

const ctx = (factors: object[], background = '') => ({ factors, background, updatedBy: 'u', updatedAt: 't' }) as never;
const f = (kind: string, processAreas: string[], description = `${kind} factor`) => ({ kind, processAreas, description });

describe('engagement risk assessment (spec §5.1)', () => {
  it('steps the library rating up once per distinct factor kind touching the area, capped at High', () => {
    const c = { processArea: 'Change control', riskRating: 'Low' as const };
    expect(assessControl(c, null)).toEqual({ assessedRisk: 'Low', riskFactors: [] });
    expect(assessControl(c, ctx([f('incident', ['Change control'])])).assessedRisk).toBe('Medium');
    expect(assessControl(c, ctx([f('incident', ['Change control']), f('incident', ['Change control'], 'second incident')])).assessedRisk).toBe('Medium');
    expect(assessControl(c, ctx([f('incident', ['Change control']), f('change', ['Change control'])])).assessedRisk).toBe('High');
    expect(assessControl(c, ctx([f('incident', ['Change control']), f('change', ['Change control']), f('regulatory', [])])).assessedRisk).toBe('High');
    expect(assessControl(c, ctx([f('incident', ['Other area'])])).assessedRisk).toBe('Low');
  });

  it('applies a factor with no process areas to the whole entity, and lists the descriptions that applied', () => {
    const r = assessControl({ processArea: 'Lab', riskRating: 'Medium' }, ctx([f('regulatory', [], 'FDA 483 issued in May'), f('change', ['Lab'], 'New LIMS')]));
    expect(r).toEqual({ assessedRisk: 'High', riskFactors: ['FDA 483 issued in May', 'New LIMS'] });
    expect(isTouched(ctx([f('regulatory', [])]), 'Anything')).toBe(true);
    expect(isTouched(null, 'Anything')).toBe(false);
  });

  it('never steps down, and an area is as risky as its riskiest control', () => {
    expect(stepUp('High', 3)).toBe('High');
    expect(stepUp('Low', 0)).toBe('Low');
    expect(areaRisk([{ assessedRisk: 'Low' }, { assessedRisk: 'High' }, { assessedRisk: 'Medium' }])).toBe('High');
    expect(areaRisk([])).toBe('Low');
  });
});

describe('the context input (spec §3.1)', () => {
  it('accepts the limits and refuses one past them, naming the field', () => {
    const ok = { factors: Array.from({ length: CONTEXT_LIMITS.factors }, () => f('change', ['A'], 'x'.repeat(CONTEXT_LIMITS.description))), background: 'b'.repeat(CONTEXT_LIMITS.background) };
    expect(EngagementContextInputSchema.safeParse(ok).success).toBe(true);
    const tooMany = EngagementContextInputSchema.safeParse({ ...ok, factors: [...ok.factors, f('change', ['A'])] });
    expect(tooMany.success).toBe(false);
    expect(JSON.stringify(tooMany.error?.issues)).toMatch(/factors/);
    expect(EngagementContextInputSchema.safeParse({ factors: [f('bogus', ['A'])], background: '' }).success).toBe(false);
    expect(EngagementContextInputSchema.safeParse({ factors: [f('change', [' '])], background: '' }).success).toBe(false);
  });

  it('hashes content only: who and when are not part of the basis', () => {
    const a = ctx([f('change', ['A'])], 'bg');
    const b = { ...a, updatedBy: 'someone else', updatedAt: 'later' };
    expect(contextBasis(a)).toEqual(contextBasis(b));
    expect(contextBasis(null)).toBeUndefined();
    expect(factorsFor(a, 'A')).toHaveLength(1);
    expect(factorsFor(a, 'B')).toHaveLength(0);
  });
});

const cand = (controlId: string, processArea: string, inherentRisk: 'High' | 'Medium' | 'Low', relevance: number, assessedRisk = inherentRisk) => ({ controlId, processArea, inherentRisk, assessedRisk, relevance });

describe('scope coverage (spec §5.2)', () => {
  it('keeps today\'s thresholds, keyed on the assessed risk', () => {
    expect(includedByRule('High', INCLUSION_THRESHOLD.High)).toBe(true);
    expect(includedByRule('Medium', 0.29)).toBe(false);
    expect(includedByRule('Medium', INCLUSION_THRESHOLD.other)).toBe(true);
    expect(includedByRule('Low', 0.25)).toBe(false);
  });

  it('includes the best control of a touched area that has nothing above threshold, and nothing without a context', () => {
    const cs = [cand('A1', 'Lab', 'Low', 0.1), cand('A2', 'Lab', 'Medium', 0.1), cand('B1', 'QA', 'High', 0.9)];
    expect(contextInclusions(cs, null).size).toBe(0);
    const inc = contextInclusions(cs, ctx([f('incident', ['Lab'], 'OOS results not investigated')]));
    expect([...inc.entries()]).toEqual([['A2', 'OOS results not investigated']]);   // tie on relevance: the higher library rating
    expect(contextInclusions(cs, ctx([f('incident', ['QA'])])).size).toBe(0);         // QA already has B1 above threshold
  });

  it('lists every empty area with its reason, and writes a statement that names them all', () => {
    const cs = [cand('A1', 'Lab', 'Low', 0.1), cand('B1', 'QA', 'High', 0.9), cand('C1', 'Treasury', 'Medium', 0.5)];
    const excluded = excludedAreas(cs, new Set(['B1', 'C1']), 'Quality system and treasury; lab testing is out of scope');
    expect(excluded).toEqual([{ processArea: 'Lab', reason: 'excluded by the scope statement' }]);
    const s = coverageStatement(cs, new Set(['B1', 'C1']), excluded);
    expect(s).toBe('2 of 3 library controls across 2 process areas are in scope; 1 area excluded: Lab.');
    expect(statementCoversAll(s, excluded)).toBe(true);
    expect(statementCoversAll('All good.', excluded)).toBe(false);
    expect(excludedAreas(cs, new Set(['B1', 'C1']), 'Quality system and treasury')[0].reason).toBe('below relevance threshold');
  });
});

describe('the scope memo (spec §3.4)', () => {
  it('explains each raised area with its factors and standard, and renders for the signer', () => {
    const items = [
      { controlId: 'A1', processArea: 'Lab', inherentRisk: 'Low', assessedRisk: 'High', riskFactors: ['New LIMS', 'FDA 483'], included: true } as never,
      { controlId: 'B1', processArea: 'QA', inherentRisk: 'High', assessedRisk: 'High', riskFactors: [], included: true } as never,
    ];
    const memo = scopeMemo({ items, coverage: { excluded: [], statement: '2 of 2…' }, context: ctx([f('change', ['Lab'], 'New LIMS')]), unknownAreas: ['Warehouse'], modelNotes: [], producedAt: 't' });
    expect(memo.subjectKey).toBe('scope');
    const lab = memo.calls.find((c) => c.question.includes('Lab'))!;
    expect(lab).toMatchObject({ decision: expect.stringMatching(/High \(library: Low\)/), basis: ['New LIMS', 'FDA 483'], standard: [IIA.riskAssessment], source: 'rules' });
    expect(memo.calls.some((c) => c.standard.includes(IIA.scope))).toBe(true);
    expect(memo.forTheReviewer.join(' ')).toMatch(/Warehouse/);
    const md = renderMemo(memo);
    expect(md).toMatch(/^## /m);
    expect(md).toMatch(/For the reviewer/);
  });
});

describe('review fixes', () => {
  it('matches an area name on word boundaries in the scope statement', () => {
    const cs = [cand('A1', 'IT', 'Low', 0.1), cand('B1', 'QA', 'High', 0.9)];
    expect(excludedAreas(cs, new Set(['B1']), 'within collaboration we do not test X')[0].reason).toBe('below relevance threshold');
    expect(excludedAreas(cs, new Set(['B1']), 'IT is out of scope')[0].reason).toBe('excluded by the scope statement');
  });

  it('takes the inclusion basis from the rationale alone', () => {
    const items = [{ controlId: 'A2', processArea: 'Lab', inherentRisk: 'Medium', assessedRisk: 'High', riskFactors: ['New LIMS'], included: true, rationale: 'included: OOS results not investigated' } as never];
    const memo = scopeMemo({ items, coverage: { excluded: [], statement: 's' }, context: ctx([f('change', ['Lab'], 'New LIMS')]), unknownAreas: [], modelNotes: [], producedAt: 't' });
    const inc = memo.calls.find((c) => c.standard.includes(IIA.scope) && c.standard.includes(IIA.riskAssessment))!;
    expect(inc.basis).toEqual(['OOS results not investigated']);
    expect(inc.standard).toEqual([IIA.riskAssessment, IIA.scope]);
  });
});

describe('model overlay bounds (plan Ruling 4)', () => {
  it('accepts a raise of exactly one step and nothing else', () => {
    expect(acceptsOverlay('Low', 'Medium')).toBe(true);
    expect(acceptsOverlay('Medium', 'High')).toBe(true);
    expect(acceptsOverlay('Low', 'High')).toBe(false);
    expect(acceptsOverlay('High', 'High')).toBe(false);
    expect(acceptsOverlay('High', 'Medium')).toBe(false);
  });

  it('credits the model on an area it raised, and changes nothing without raises', () => {
    const items = [{ controlId: 'G1', processArea: 'Governance', inherentRisk: 'Medium', assessedRisk: 'High', riskFactors: [], included: true, rationale: 'r' } as never];
    const input = { items, coverage: { excluded: [], statement: 's' }, context: null, unknownAreas: [], modelNotes: [], producedAt: 't' };
    const plain = scopeMemo(input);
    const withModel = scopeMemo({ ...input, modelRaises: [{ processArea: 'Governance', rationale: 'Board turnover' }, { processArea: 'Nowhere', rationale: 'x' }] });
    const before = plain.calls.find((c) => c.question.includes('Governance'))!;
    const after = withModel.calls.find((c) => c.question.includes('Governance'))!;
    expect(before.source).toBe('rules');
    expect(after.source).toBe('model');
    expect(after.rationale).toBe(`${before.rationale} Model: Board turnover`);
    expect(withModel.calls).toHaveLength(plain.calls.length);
    expect(scopeMemo({ ...input, modelRaises: [] })).toEqual(plain);
  });
});
