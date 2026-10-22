import fs from 'node:fs';
import path from 'node:path';
import type { EngagementContext, Impact, Likelihood, RiskRating } from '../engine/types';
import { ratingOf } from '../judgment/finding';
import { opinionOf } from '../judgment/opinion';
import { assessControl } from '../judgment/risk-assessment';
import type { EvalCaseResult } from './harness';

// Judgment eval cases: the deterministic rules (risk assessment, the rating matrix, the opinion) checked against
// written expectations. They live outside the packs, so a draft case never needs a pack version bump, and they
// make no model call. A draft case is a release gate for the rules, not an expert benchmark.

export interface JudgmentCase {
  id: string;
  status: 'draft' | 'expert-reviewed';
  check: 'risk-assessment' | 'rating' | 'opinion';
  description: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export const JUDGMENT_CASES_FILE = path.resolve(__dirname, '../../eval/judgment/cases.json');

export function loadJudgmentCases(file: string = JUDGMENT_CASES_FILE): JudgmentCase[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as JudgmentCase[];
}

/** The value the rules give for a case, under the key the case's `expected` uses. */
function actualFor(c: JudgmentCase): Record<string, unknown> {
  if (c.check !== 'rating' && c.check !== 'opinion' && c.check !== 'risk-assessment') throw new Error(`unknown check: ${String(c.check)}`);
  if (c.check === 'rating') {
    return { rating: ratingOf(c.input.likelihood as Likelihood, c.input.impact as Impact) };
  }
  if (c.check === 'opinion') {
    const ratings = c.input.ratings as RiskRating[];
    return { opinion: opinionOf(ratings.map((rating) => ({ rating, status: 'approved' as const }))) };
  }
  const given = c.input.context as Pick<EngagementContext, 'factors' | 'background'> | null;
  const context: EngagementContext | null = given ? { ...given, updatedBy: 'eval', updatedAt: '2026-01-01T00:00:00.000Z' } : null;
  const { assessedRisk } = assessControl({ processArea: String(c.input.processArea), riskRating: c.input.riskRating as RiskRating }, context);
  return { assessedRisk };
}

export function runJudgmentCase(c: JudgmentCase): EvalCaseResult {
  const base = { id: c.id, packId: 'judgment', kind: 'judgment' as const, description: c.description };
  try {
    const actual = actualFor(c);
    const wrong = Object.keys(c.expected).filter((key) => actual[key] !== c.expected[key]);
    return {
      ...base,
      passed: wrong.length === 0,
      detail: wrong.length ? wrong.map((key) => `${key}: expected ${String(c.expected[key])}, got ${String(actual[key])}`).join('; ') : `matches: ${JSON.stringify(c.expected)}`,
    };
  } catch (err) {
    return { ...base, passed: false, detail: err instanceof Error && err.message.startsWith('unknown check:') ? err.message : `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A missing or malformed cases file (the container image does not carry eval/) is one failed row, so the eval request still answers. */
export function runJudgmentCases(file: string = JUDGMENT_CASES_FILE): EvalCaseResult[] {
  let cases: JudgmentCase[];
  try {
    cases = loadJudgmentCases(file);
    if (!Array.isArray(cases)) throw new Error('the cases file is not a list');
  } catch (err) {
    return [{ id: 'judgment:cases-missing', packId: 'judgment', kind: 'judgment', description: 'The judgment cases file could not be read', passed: false, detail: `${file}: ${err instanceof Error ? err.message : String(err)}` }];
  }
  return cases.map(runJudgmentCase);
}
