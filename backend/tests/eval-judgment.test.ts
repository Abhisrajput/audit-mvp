import { describe, expect, it } from 'vitest';
import { loadJudgmentCases, runJudgmentCase, runJudgmentCases, type JudgmentCase } from '../src/eval/judgment';

describe('the judgment eval kind (spec §8)', () => {
  it('loads the draft cases file and every case names a known check', () => {
    const cases = loadJudgmentCases();
    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(cases.every((c) => c.status === 'draft' && ['risk-assessment', 'rating', 'opinion'].includes(c.check))).toBe(true);
  });

  it('passes a correct expectation and fails a wrong one with the values in the detail', () => {
    const right: JudgmentCase = { id: 'x', status: 'draft', check: 'rating', description: '', input: { likelihood: 'likely', impact: 'major' }, expected: { rating: 'High' } };
    expect(runJudgmentCase(right)).toMatchObject({ passed: true, kind: 'judgment', packId: 'judgment' });
    const bad = runJudgmentCase({ ...right, expected: { rating: 'Low' } });
    expect(bad).toMatchObject({ passed: false, detail: expect.stringContaining('High') });
    expect(bad.detail).toContain('Low');
  });

  it('every shipped case passes against the rules', () => {
    expect(runJudgmentCases().filter((r) => !r.passed)).toEqual([]);
  });

  it('an incident touching the area steps a Medium control up to High; the whole-entity factor touches every area', () => {
    const incident: JudgmentCase = {
      id: 'inline-incident', status: 'draft', check: 'risk-assessment', description: '',
      input: { processArea: 'Procurement', riskRating: 'Medium', context: { factors: [{ kind: 'incident', processAreas: ['Procurement'], description: 'A duplicate payment' }], background: '' } },
      expected: { assessedRisk: 'High' },
    };
    expect(runJudgmentCase(incident).passed).toBe(true);
    const wholeEntity: JudgmentCase = {
      ...incident, id: 'inline-whole-entity',
      input: { processArea: 'Payroll', riskRating: 'Low', context: { factors: [{ kind: 'change', processAreas: [], description: 'New ERP' }], background: '' } },
      expected: { assessedRisk: 'Medium' },
    };
    expect(runJudgmentCase(wholeEntity).passed).toBe(true);
  });
});
