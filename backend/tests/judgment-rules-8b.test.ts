import { describe, expect, it } from 'vitest';
import { acceptsSelection, recommendedTolerance, sampleSize, selectionFor, SAMPLE_TABLE } from '../src/judgment/sampling';
import { severityOf, toleratedEffective, worsens } from '../src/judgment/evaluation';
import { causeSupported, impactOf, likelihoodOf, MATRIX, oneStepWorse, ratingOf, IMPACTS, LIKELIHOODS } from '../src/judgment/finding';
import type { RcmRow, RiskRating, TestResult } from '../src/engine/types';

const ctx = (kind: 'incident' | 'prior_finding' | 'change', area: string) => ({ factors: [{ kind, processAreas: [area], description: 'x' }], background: '', updatedBy: 'u', updatedAt: 't' });

// Today's gaps.ts rule, kept here verbatim so the matrix is proven against it (plan Ruling 8).
function legacyRate(row: Pick<RcmRow, 'riskRating'>, result: Pick<TestResult, 'conclusion' | 'exceptionRate'>): RiskRating {
  if (result.conclusion === 'Design deficient') return row.riskRating;
  const r = result.exceptionRate ?? 0;
  if (row.riskRating === 'Medium' && r >= 0.2) return 'High';
  if (row.riskRating === 'High' && r > 0 && r < 0.05) return 'Medium';
  return row.riskRating;
}

describe('sampling (spec §5.3)', () => {
  it('keys the table on the rating it is given, selects by frequency and factors, and recommends tolerance by pack and risk [REQ-32]', () => {
    expect(sampleSize('Daily', 'High')).toBe(SAMPLE_TABLE.Daily[1]);
    expect(sampleSize('Daily', 'Low')).toBe(SAMPLE_TABLE.Daily[0]);
    expect(selectionFor({ frequency: 'Quarterly', processArea: 'HACCP' }, null).method).toBe('all');
    expect(selectionFor({ frequency: 'Daily', processArea: 'HACCP' }, null).method).toBe('random');
    expect(selectionFor({ frequency: 'Daily', processArea: 'HACCP' }, ctx('incident', 'HACCP')).method).toBe('judgemental');
    expect(selectionFor({ frequency: 'Daily', processArea: 'HACCP' }, ctx('change', 'HACCP')).method).toBe('random');
    expect(recommendedTolerance({ packId: 'pharma' }, 'Low')).toBe(0);
    expect(recommendedTolerance({ packId: 'common' }, 'High')).toBe(0);
    expect(recommendedTolerance({ packId: 'common' }, 'Medium')).toBe(0.05);
    expect(recommendedTolerance({ packId: 'common' }, 'Low')).toBe(0.1);
    expect(acceptsSelection('random', 'judgemental')).toBe(true);
    expect(acceptsSelection('all', 'random')).toBe(false);
    expect(acceptsSelection('judgemental', 'random')).toBe(false);
  });
});

describe('severity (spec §5.4)', () => {
  it('follows the count and rate boundaries, is systemic for a design deficiency, and only worsens', () => {
    const r = (conclusion: TestResult['conclusion'], exceptionRate: number | null) => ({ conclusion, exceptionRate });
    expect(severityOf(r('Effective', 0), { exceptions: 0 }).severity).toBe('none');
    expect(severityOf(r('Ineffective', 0.5), { exceptions: 1 }).severity).toBe('isolated');
    expect(severityOf(r('Ineffective', 0.1), { exceptions: 3 }).severity).toBe('isolated');
    expect(severityOf(r('Ineffective', 0.101), { exceptions: 3 }).severity).toBe('systemic');
    expect(severityOf(r('Design deficient', null), { exceptions: 0 }).severity).toBe('systemic');
    expect(worsens('isolated', 'pervasive')).toBe(true);
    expect(worsens('systemic', 'isolated')).toBe(false);
    expect(toleratedEffective(1, 40, 0.05)).toBe(true);
    expect(toleratedEffective(3, 40, 0.05)).toBe(false);
    expect(toleratedEffective(1, 40, 0)).toBe(false);
  });
});

describe('finding rating (spec §5.5)', () => {
  it('reproduces today\'s rating rule for every row rating, conclusion and exception rate with no context [REQ-32]', () => {
    const rates = [null, 0, 0.01, 0.049, 0.05, 0.1, 0.199, 0.2, 0.5, 1];
    for (const riskRating of ['High', 'Medium', 'Low'] as const) {
      for (const conclusion of ['Ineffective', 'Design deficient'] as const) {
        for (const exceptionRate of rates) {
          const result = { conclusion, exceptionRate: conclusion === 'Design deficient' ? null : exceptionRate };
          expect(ratingOf(likelihoodOf(result), impactOf(riskRating)), `${riskRating} ${conclusion} ${exceptionRate}`).toBe(legacyRate({ riskRating }, result));
        }
      }
    }
    expect(MATRIX.major.possible).toBe('High');
    expect(MATRIX.minor.likely).toBe('Low');
  });

  it('accepts a one-step worse move only, and supports a cause only when the observation mentions it', () => {
    expect(oneStepWorse(LIKELIHOODS, 'rare', 'possible')).toBe(true);
    expect(oneStepWorse(LIKELIHOODS, 'rare', 'likely')).toBe(false);
    expect(oneStepWorse(IMPACTS, 'moderate', 'minor')).toBe(false);
    expect(causeSupported('The reconciliation was not performed because the preparer left in March', 'A vacancy: the preparer left and the task was not reassigned')).toBe(true);
    expect(causeSupported('Two deviations in March', 'Inadequate supervision of temporary staff')).toBe(false);
  });
});
