import { describe, expect, it } from 'vitest';
import { areaOptions, contextLocked, contextProblems, memoFor, raisedAreas, ratingOf, responsesLocked, toleranceEditable, percentToRate, toleranceProblems } from './judgment';
import type { Gate, Impact, JudgmentMemo, Likelihood, RiskRating, ScopeItem } from './types';

const item = (controlId: string, processArea: string, inherentRisk: 'High' | 'Medium' | 'Low', assessedRisk = inherentRisk, riskFactors: string[] = []) =>
  ({ controlId, processArea, inherentRisk, assessedRisk, riskFactors, packId: 'common', risk: '', relevance: 0, rationale: '', citations: [], included: true }) as ScopeItem;

describe('context helpers', () => {
  it('offers the areas of the scope when there is one, else those of the chosen packs', () => {
    expect(areaOptions([item('A', 'Lab', 'Low')], [{ processArea: 'QA', packId: 'common' }], ['common'])).toEqual(['Lab']);
    expect(areaOptions([], [{ processArea: 'QA', packId: 'common' }, { processArea: 'HACCP', packId: 'food' }], ['common'])).toEqual(['QA']);
  });

  it('mirrors the server limits', () => {
    expect(contextProblems({ factors: [], background: '' })).toEqual([]);
    expect(contextProblems({ factors: [{ kind: 'change', processAreas: [], description: '' }], background: '' })).toEqual(['Factor 1 needs a description']);
    expect(contextProblems({ factors: [], background: 'x'.repeat(4001) })[0]).toMatch(/4000/);
    const named = (processAreas: string[]) => contextProblems({ factors: [{ kind: 'change', processAreas, description: 'd' }], background: '' });
    expect(named(Array.from({ length: 50 }, (_, i) => `Area ${i}`))).toEqual([]);
    expect(named(Array.from({ length: 51 }, (_, i) => `Area ${i}`))).toEqual(['Factor 1 names more than 50 areas']);
    expect(named(['x'.repeat(101)])).toEqual(['Factor 1 names an area over 100 characters']);
  });

  it('locks after an approved RCM gate and lists the raised areas', () => {
    expect(contextLocked([{ kind: 'rcm', state: 'open' } as Gate])).toBe(false);
    expect(contextLocked([{ kind: 'rcm', state: 'approved' } as Gate])).toBe(true);
    const rows = raisedAreas([item('A', 'Lab', 'Low', 'High', ['New LIMS']), item('B', 'Lab', 'Medium', 'High', ['New LIMS']), item('C', 'QA', 'High')]);
    expect(rows).toEqual([{ processArea: 'Lab', library: 'Medium', assessed: 'High', factors: ['New LIMS'] }]);
  });

  it('reads scope items stored before the risk assessment existed, which lack assessedRisk and riskFactors', () => {
    const { assessedRisk: _a, riskFactors: _f, ...old } = item('OLD', 'QA', 'High');
    const raised = item('NEW', 'Lab', 'Low', 'Medium');
    delete (raised as Partial<ScopeItem>).riskFactors;
    expect(raisedAreas([old as unknown as ScopeItem, raised])).toEqual([{ processArea: 'Lab', library: 'Low', assessed: 'Medium', factors: [] }]);
  });
});

describe('finding judgment helpers', () => {
  it('computes the rating from the nine matrix cells', () => {
    const cells: [Impact, Likelihood, RiskRating][] = [
      ['major', 'rare', 'Medium'], ['major', 'possible', 'High'], ['major', 'likely', 'High'],
      ['moderate', 'rare', 'Medium'], ['moderate', 'possible', 'Medium'], ['moderate', 'likely', 'High'],
      ['minor', 'rare', 'Low'], ['minor', 'possible', 'Low'], ['minor', 'likely', 'Low'],
    ];
    for (const [impact, likelihood, rating] of cells) expect(ratingOf(likelihood, impact)).toBe(rating);
  });

  it('finds a finding memo by its subject key, and nothing for an unknown key', () => {
    const memo = { forTheReviewer: ['d'] } as unknown as JudgmentMemo;
    const e = { memos: { 'rcm:x': { forTheReviewer: ['r'] } as unknown as JudgmentMemo }, findings: [{ rowId: 'R1', memo }] } as never;
    expect(memoFor(e, 'finding:R1')).toBe(memo);
    expect(memoFor(e, 'rcm:x')?.forTheReviewer).toEqual(['r']);
    expect(memoFor(e, 'finding:R2')).toBeUndefined();
    expect(memoFor(e, 'nothing')).toBeUndefined();
  });

  it('allows a tolerance only until a test is recorded', () => {
    expect(toleranceEditable({ testInputs: {} }, 'R1')).toBe(true);
    expect(toleranceEditable({ testInputs: { R1: {} } } as never, 'R1')).toBe(false);
  });

  it('locks responses only after an approved report gate', () => {
    expect(responsesLocked([{ kind: 'report', state: 'open' } as Gate])).toBe(false);
    expect(responsesLocked([{ kind: 'rcm', state: 'approved' } as Gate])).toBe(false);
    expect(responsesLocked([{ kind: 'report', state: 'approved' } as Gate])).toBe(true);
  });

  it('turns typed percents into clean rates', () => {
    expect(percentToRate('5')).toBe(0.05);
    expect(percentToRate('12.3')).toBe(0.123);
    expect(percentToRate('0')).toBe(0);
  });

  it('names the limit for a tolerance outside 0 to 25%', () => {
    expect(toleranceProblems(0)).toEqual([]);
    expect(toleranceProblems(0.25)).toEqual([]);
    expect(toleranceProblems(0.3)[0]).toMatch(/25%/);
    expect(toleranceProblems(-0.01)[0]).toMatch(/negative|0%/);
  });
});
