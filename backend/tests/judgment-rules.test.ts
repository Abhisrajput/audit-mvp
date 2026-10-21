// backend/tests/judgment-rules.test.ts
import { describe, expect, it } from 'vitest';
import { CONTEXT_LIMITS, contextBasis, EngagementContextInputSchema, factorsFor } from '../src/judgment/context';
import { areaRisk, assessControl, isTouched, stepUp } from '../src/judgment/risk-assessment';

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
