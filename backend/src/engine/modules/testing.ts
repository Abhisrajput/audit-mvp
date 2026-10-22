import { z } from 'zod';
import type { AuditModule } from '../module';
import { negativeSignals, testEvidenceGate } from '../qa';
import type { RcmRow, Severity, TestInput, TestResult } from '../types';
import { asData } from '../llm/prompt';
import { SEVERITIES, severityOf, toleratedEffective, worsens } from '../../judgment/evaluation';
import { askModel, SYSTEM_PREAMBLE } from './llm-step';

/** Deterministic conclusion from the auditor's field record, under the tolerance a person set for the control (0 when none). */
export function concludeTest(row: RcmRow, input: TestInput | undefined, tolerance = 0): TestResult {
  const concluded = conclude(row, input, tolerance);
  const { severity, rationale } = severityOf(concluded, input);
  return { ...concluded, severity, severityRationale: rationale, toleranceApplied: tolerance };
}

function conclude(row: RcmRow, input: TestInput | undefined, tolerance: number): TestResult {
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
  if (input.exceptions > 0 && toleratedEffective(input.exceptions, input.sampleTested, tolerance)) {
    return { ...base, conclusion: 'Effective', rationale: `${input.exceptions} exception(s) in ${input.sampleTested} items tested (${Math.round(rate * 1000) / 10}%), within the ${Math.round(tolerance * 1000) / 10}% tolerance set for this control.`, exceptionRate: rate };
  }
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
      severity: z.enum(SEVERITIES as readonly [Severity, ...Severity[]]).optional(),
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
    const toleranceOf = (row: RcmRow) => e.tolerances[row.controlId]?.rate ?? 0;
    for (const row of rows) results[row.id] = concludeTest(row, e.testInputs[row.id], toleranceOf(row));
    ctx.step('conclude', `Deterministic conclusions for ${rows.length} rows`);

    const tested = rows.filter((r) => e.testInputs[r.id]);
    const drafted = await askModel(
      ctx,
      SYSTEM_PREAMBLE,
      `Conclude on each control test. Allowed conclusions: Effective, Ineffective, Design deficient, Not tested.\n` +
        `Any recorded exception means the control is not Effective, unless the exception rate is within the tolerance a person set for that control (toleranceApplied; 0 means none). Give a one or two sentence rationale based only on the record. You may also give a severity (none, isolated, systemic, pervasive) for each result; it is accepted only when it is worse than the rule's severity shown as data.\n\n` +
        asData('workpaper:field-work', tested.map((r) => ({ rowId: r.id, control: r.control, plannedSample: r.sampleSize, testOfEffectiveness: r.testOfEffectiveness, record: e.testInputs[r.id], toleranceApplied: toleranceOf(r), severity: results[r.id].severity }))),
      ModelTesting,
    );
    if (drafted) {
      for (const d of drafted.results) {
        if (!results[d.rowId] || !e.testInputs[d.rowId]) continue;
        const row = rows.find((r) => r.id === d.rowId)!;
        const applied = { ...results[d.rowId], conclusion: d.conclusion, rationale: d.rationale };
        // The model may only make severity worse, and it may not relax it by moving the conclusion: the bound is the worse of the
        // severity the rule gave for its own conclusion and the severity that follows the model's conclusion.
        const ruleOwn = results[d.rowId].severity ?? 'none';
        const ruleConclusion = results[d.rowId].conclusion;
        const followed = severityOf(applied, e.testInputs[d.rowId]);
        const keepsRule = worsens(followed.severity, ruleOwn);
        const rule = keepsRule ? { severity: ruleOwn, rationale: results[d.rowId].severityRationale ?? followed.rationale } : followed;
        results[d.rowId] = { ...applied, severity: rule.severity, severityRationale: rule.rationale };
        if (keepsRule) {
          ctx.gate({ gate: 'judgment-bounds', outcome: 'fail', target: row.id, detail: `Model concluded ${d.conclusion} where the rule concluded ${ruleConclusion}, which would lower the severity from ${ruleOwn} to ${followed.severity}; the rule severity ${ruleOwn} stands`, action: 'blocked' });
        }
        if (d.severity !== undefined && d.severity !== rule.severity) {
          if (worsens(rule.severity, d.severity)) {
            results[d.rowId] = { ...results[d.rowId], severity: d.severity, severityRationale: `${rule.rationale} Raised to ${d.severity} by the model: ${d.rationale}` };
          } else {
            ctx.gate({ gate: 'judgment-bounds', outcome: 'fail', target: row.id, detail: `Model proposed severity ${d.severity} where the rule gives ${rule.severity}; only a worse value is accepted, so the rule value stands`, action: 'blocked' });
          }
        }
      }
    }

    for (const row of tested) {
      const { result, actions } = testEvidenceGate(row, e.testInputs[row.id], results[row.id], toleranceOf(row));
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
