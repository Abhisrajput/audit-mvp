import { z } from 'zod';
import type { AuditModule } from '../module';
import { negativeSignals, testEvidenceGate } from '../qa';
import type { RcmRow, TestInput, TestResult } from '../types';
import { asData } from '../llm/prompt';
import { askModel, SYSTEM_PREAMBLE } from './llm-step';

/** Deterministic conclusion from the auditor's field record. */
export function concludeTest(row: RcmRow, input: TestInput | undefined): TestResult {
  const base = { rowId: row.id, qaFlags: [] as string[] };
  if (!input || (input.designAdequate === null && input.sampleTested === 0)) {
    return { ...base, conclusion: 'Not tested', rationale: 'No field work recorded.', exceptionRate: null };
  }
  if (input.designAdequate === false) {
    return { ...base, conclusion: 'Design deficient', rationale: 'Test of design concluded the control, as designed, does not address the risk.', exceptionRate: null };
  }
  if (input.sampleTested === 0) {
    return { ...base, conclusion: 'Not tested', rationale: 'Design is adequate but no operating-effectiveness sample was tested.', exceptionRate: null };
  }
  const rate = Math.round((input.exceptions / input.sampleTested) * 1000) / 1000;
  if (input.exceptions > 0) {
    return { ...base, conclusion: 'Ineffective', rationale: `${input.exceptions} exception(s) in ${input.sampleTested} items tested (${Math.round(rate * 100)}%).`, exceptionRate: rate };
  }
  const signals = negativeSignals(input.observation);
  return {
    ...base,
    conclusion: 'Effective',
    rationale: `No exceptions in ${input.sampleTested} items tested${signals.length ? '; note the observation wording' : ''}.`,
    exceptionRate: 0,
  };
}

const ModelTesting = z.object({
  results: z.array(
    z.object({
      rowId: z.string(),
      conclusion: z.enum(['Effective', 'Ineffective', 'Design deficient', 'Not tested']),
      rationale: z.string(),
    }),
  ),
});

/** Testing (TOD/TOE): concludes on each tested control and applies the evidence gates. */
export const testingModule: AuditModule<Record<string, TestResult>> = {
  id: 'testing',
  name: 'Testing (TOD / TOE)',
  version: '0.1.0',
  description: 'Evaluates the recorded test of design and operating-effectiveness evidence for each RCM row.',
  precondition: (e) => (Object.keys(e.testInputs).length ? null : 'Record field work for at least one RCM row first'),

  async run(ctx) {
    const e = ctx.engagement;
    const rows = e.rcm;
    const results: Record<string, TestResult> = {};
    for (const row of rows) results[row.id] = concludeTest(row, e.testInputs[row.id]);
    ctx.step('conclude', `Deterministic conclusions for ${rows.length} rows`);

    const tested = rows.filter((r) => e.testInputs[r.id]);
    const drafted = await askModel(
      ctx,
      SYSTEM_PREAMBLE,
      `Conclude on each control test. Allowed conclusions: Effective, Ineffective, Design deficient, Not tested.\n` +
        `Any recorded exception means the control is not Effective. Give a one or two sentence rationale based only on the record.\n\n` +
        asData('workpaper:field-work', tested.map((r) => ({ rowId: r.id, control: r.control, plannedSample: r.sampleSize, testOfEffectiveness: r.testOfEffectiveness, record: e.testInputs[r.id] }))),
      ModelTesting,
    );
    if (drafted) {
      for (const d of drafted.results) {
        if (!results[d.rowId] || !e.testInputs[d.rowId]) continue;
        results[d.rowId] = { ...results[d.rowId], conclusion: d.conclusion, rationale: d.rationale };
      }
    }

    for (const row of tested) {
      const { result, actions } = testEvidenceGate(row, e.testInputs[row.id], results[row.id]);
      results[row.id] = result;
      ctx.gate(...actions);
    }
    return results;
  },

  apply(e, results) {
    e.testResults = results;
    e.stage = 'fieldwork';
  },
};
