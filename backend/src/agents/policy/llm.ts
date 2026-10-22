import { z } from 'zod';
import { asData, DATA_RULES } from '../../engine/llm/prompt';
import { MalformedOutputError } from '../../engine/llm/provider';
import { ModelUnavailableError, type AgentModels } from '../llm/models';
import type { Action, Decision, Menu, Policy, PolicyAttempt } from '../types';
import { rulesChoice, RULES_VERSION } from './rules';

// The model policy (spec §5.3). The model sees a compact summary (the stage, the numbered menu, the latest QA report)
// and answers with the number of one entry. The action taken is that menu entry itself, so the model cannot change an
// action's arguments. Off the menu or malformed: one more try, then the rules. Model down: the rules, flagged.

export const LLM_POLICY_VERSION = 'llm-1';

const Answer = z.object({ choice: z.number().int(), rationale: z.string() });

export const POLICY_SYSTEM = `You supervise one internal-audit engagement run. At each step the platform lists the actions its rules allow, numbered from 0. Answer with the number of exactly one, and say why in one or two sentences.
- You can only choose from the list. Any other answer is refused, and the platform's fixed rules decide instead.
- People sign every gate and record every test result. You cannot do either, and no choice of yours skips a gate.
- Opening a gate suits work that QA found no blocking issue in and scored at or above the threshold. A redraft suits blocking issues. A challenge pass (request_qa, mode challenge) is worth it before a borderline gate. Escalate when a person must decide.
${DATA_RULES}`;

/**
 * How an action is shown to the model. A rework's instruction is left out: it is reviewer text, and the model does not
 * need it to choose. So is the signature a rework carries (directiveBy).
 */
function describe(a: Action): string {
  if (a.type === 'rework') return JSON.stringify({ type: a.type, specialist: a.specialist, subjectKey: a.subjectKey, ...(a.rows ? { rows: a.rows } : {}) });
  return JSON.stringify(a);
}

/** What the model is shown: never whole workpapers (spec §5.3). */
export function policyPrompt(menu: Menu, refusal?: string): string {
  const lines = [`Stage: ${menu.stage}. QA threshold: ${menu.qaThreshold}.`, 'Allowed actions:', ...menu.actions.map((a, i) => `${i}. ${describe(a)}`)];
  if (menu.qa) {
    const { subjectKey, mode, score, issues } = menu.qa;
    lines.push('', 'Latest QA report on this subject:', asData('qa-report', { subjectKey, mode, score, issues: issues.map((i) => ({ criterion: i.criterion, severity: i.severity, detail: i.detail.slice(0, 300) })) }));
  }
  if (refusal) lines.push('', `Your previous answer was refused: ${refusal}. Answer with a number from the list.`);
  return lines.join('\n');
}

export class LlmPolicy implements Policy {
  readonly kind = 'llm' as const;
  readonly version = LLM_POLICY_VERSION;

  async decide(menu: Menu, models?: AgentModels): Promise<Decision> {
    const attempts: PolicyAttempt[] = [];
    if (!models?.available) return this.byRules(menu, attempts, 'no model is configured');
    let refusal: string | undefined;
    for (let i = 0; i < 2; i++) {
      try {
        const { output, servedModel } = await models.generate('policy', { system: POLICY_SYSTEM, user: policyPrompt(menu, refusal), schema: Answer });
        const action = output.choice >= 0 ? menu.actions[output.choice] : undefined;
        if (!action) {
          refusal = `${output.choice} is not on the list`;
          attempts.push({ outcome: 'off_menu', model: servedModel, detail: refusal });
          continue;
        }
        attempts.push({ outcome: 'chosen', model: servedModel, detail: `chose ${output.choice}` });
        return { action, rationale: output.rationale.trim().slice(0, 500) || 'No reason given', policy: 'llm', policyVersion: this.version, attempts };
      } catch (err) {
        if (err instanceof MalformedOutputError) {
          refusal = 'it was not in the required shape';
          attempts.push({ outcome: 'malformed', model: null, detail: err.message.slice(0, 500) });
          continue;
        }
        if (err instanceof ModelUnavailableError) {
          attempts.push({ outcome: 'model_error', model: null, detail: err.message.slice(0, 500) });
          return this.byRules(menu, attempts, `drafted without model: ${err.message}`);
        }
        throw err; // a refused budget or a lost lease ends the iteration
      }
    }
    return this.byRules(menu, attempts, 'the model answered off the menu twice');
  }

  private byRules(menu: Menu, attempts: PolicyAttempt[], why: string): Decision {
    const { action, rationale } = rulesChoice(menu);
    return { action, rationale: `${rationale} (rules decided: ${why})`.slice(0, 500), policy: 'rules', policyVersion: RULES_VERSION, attempts };
  }
}
