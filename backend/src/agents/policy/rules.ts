import type { Action, Decision, Menu, Policy } from '../types';

// The offline policy (spec §5.3). Deterministic and complete on its own: with no model configured, runs use it,
// and a model policy that answers off the menu falls back to it.

export const RULES_VERSION = 'rules-1';

export function rulesChoice(menu: Menu): { action: Action; rationale: string } {
  const find = <T extends Action['type']>(type: T) => menu.actions.find((a): a is Extract<Action, { type: T }> => a.type === type);
  const qa = menu.qa;
  if (qa) {
    const blocking = qa.issues.filter((i) => i.severity === 'blocking').length;
    const rework = find('rework');
    if (blocking) {
      if (rework) return { action: rework, rationale: `QA found ${blocking} blocking issue(s); redrafting` };
      const escalate = find('escalate');
      if (escalate) return { action: escalate, rationale: `QA found ${blocking} blocking issue(s) and no redraft is left; a person must decide` };
    }
    if (qa.score < menu.qaThreshold && rework) return { action: rework, rationale: `QA scored ${qa.score}, below ${menu.qaThreshold}; redrafting` };
    const gate = find('open_gate');
    if (gate) return { action: gate, rationale: `QA scored ${qa.score}; ${qa.issues.length} issue(s) go to the signer with the gate` };
  }
  return { action: menu.actions[0], rationale: 'The first allowed action' };
}

export class RulesPolicy implements Policy {
  readonly kind = 'rules' as const;
  readonly version = RULES_VERSION;

  async decide(menu: Menu): Promise<Decision> {
    const { action, rationale } = rulesChoice(menu);
    return { action, rationale, policy: 'rules', policyVersion: this.version };
  }
}
