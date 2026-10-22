import { describe, expect, it } from 'vitest';
import { areaOptions, contextLocked, contextProblems, raisedAreas } from './judgment';
import type { Gate, ScopeItem } from './types';

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
