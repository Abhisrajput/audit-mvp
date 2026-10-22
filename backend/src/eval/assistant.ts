import fs from 'node:fs';
import path from 'node:path';
import type { CommandName } from '../assistant/commands';
import { loadAssistantConfig } from '../assistant/config';
import { ModelPlanner, boundInput, rulesPlan, type Plan, type PlannerData, type TurnContext } from '../assistant/planner';
import type { LlmProvider } from '../engine/llm/provider';
import type { Role } from '../engine/types';
import type { EvalCaseResult } from './harness';

// Assistant eval cases: a plain-words request checked against the command (or reply) the planner gives. The offline
// cases run the rules and cost nothing; the `needsModel` cases need a model, so they run only with one, as information.

export interface AssistantCase {
  id: string;
  status: 'draft';
  description: string;
  message: string;
  context?: TurnContext;
  role?: Role; // default 'auditor'
  expect: { kind: 'command'; name: CommandName; args?: Record<string, unknown> } | { kind: 'reply' };
  needsModel?: boolean;
}

export const ASSISTANT_CASES_FILE = path.resolve(__dirname, '../../eval/assistant/cases.json');

export function loadAssistantCases(file: string = ASSISTANT_CASES_FILE): AssistantCase[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as AssistantCase[];
}

const EVAL_DATA: PlannerData = {
  engagements: [{ id: 'ENG-1', name: 'Plant 1 audit', entity: 'Demo Foods', site: 'Plant 1', stage: 'planning' }],
  packs: [{ id: 'food', name: 'Food', vertical: 'food' }, { id: 'common', name: 'Common', vertical: 'common' }],
  today: '2026-10-22',
};

const planName = (plan: Plan) => (plan.kind === 'command' ? plan.command.name : 'reply');

export async function runAssistantCase(c: AssistantCase, llm: LlmProvider | null, opts: { model: string; timeoutMs: number }): Promise<EvalCaseResult> {
  const base = { id: c.id, packId: 'assistant', kind: 'assistant' as const, description: c.description, ...(c.needsModel ? { informational: true } : {}) };
  try {
    const role = c.role ?? 'auditor';
    const input = boundInput({ message: c.message, context: c.context });
    let plan: Plan;
    let outcome = 'rules';
    let plannerDetail = '';
    if (llm) {
      const planned = await new ModelPlanner(llm, opts).plan(input, role, EVAL_DATA);
      ({ plan, outcome } = planned);
      plannerDetail = planned.detail;
    } else {
      plan = rulesPlan(input, role);
    }
    const tag = `outcome: ${outcome}`;
    if (c.needsModel && outcome !== 'command' && outcome !== 'reply') return { ...base, passed: false, detail: `the model did not answer (${tag}): ${plannerDetail}` };
    const expected = c.expect.kind === 'reply' ? 'reply' : c.expect.name;
    const got = planName(plan);
    if (got !== expected) return { ...base, passed: false, detail: `expected ${expected} got ${got}; ${tag}` };
    if (c.expect.kind === 'command' && plan.kind === 'command') {
      const planned = (plan.args ?? {}) as Record<string, unknown>;
      const wrong = Object.entries(c.expect.args ?? {}).filter(([key, value]) => JSON.stringify(planned[key]) !== JSON.stringify(value));
      if (wrong.length) return { ...base, passed: false, detail: `${wrong.map(([key, value]) => `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(planned[key])}`).join('; ')}; ${tag}` };
    }
    return { ...base, passed: true, detail: `matches: ${expected}; ${tag}` };
  } catch (err) {
    return { ...base, passed: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A missing or malformed cases file (the container image may not carry eval/) is one failed row, so the eval request still answers. */
export async function runAssistantCases(llm: LlmProvider | null, file: string = ASSISTANT_CASES_FILE): Promise<EvalCaseResult[]> {
  let cases: AssistantCase[];
  try {
    cases = loadAssistantCases(file);
    if (!Array.isArray(cases)) throw new Error('the cases file is not a list');
  } catch (err) {
    return [{ id: 'assistant:cases-missing', packId: 'assistant', kind: 'assistant', description: 'The assistant cases file could not be read', passed: false, detail: `${file}: ${err instanceof Error ? err.message : String(err)}` }];
  }
  const rows: EvalCaseResult[] = [];
  // The model rows measure the live assistant's own planner settings.
  const { model, timeoutMs } = loadAssistantConfig();
  for (const [index, c] of (cases as unknown[]).entries()) {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      rows.push({ id: `assistant:bad-case-${index}`, packId: 'assistant', kind: 'assistant', description: 'A case in the assistant cases file is not an object', passed: false, detail: `case ${index} is ${c === null ? 'null' : Array.isArray(c) ? 'a list' : typeof c}` });
      continue;
    }
    const one = c as AssistantCase;
    if (one.needsModel && !llm) continue;
    rows.push(await runAssistantCase(one, llm, { model, timeoutMs }));
  }
  return rows;
}
