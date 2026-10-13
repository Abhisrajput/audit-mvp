import { describe, expect, it } from 'vitest';
import { LLM_POLICY_VERSION, LlmPolicy, POLICY_SYSTEM, policyPrompt } from '../src/agents/policy/llm';
import { RULES_VERSION } from '../src/agents/policy/rules';
import type { Menu, QaReport } from '../src/agents/types';
import { chooseDecision } from '../src/agents/worker';
import { DATA_RULES } from '../src/engine/llm/prompt';
import { FakeProvider, testModels } from './helpers';

const report: QaReport = {
  subjectKey: 'scope', subjectHash: 'h', mode: 'review', reviewer: 'deterministic-1', score: 60,
  issues: [{ criterion: 'scope.citations', severity: 'advisory', detail: 'FD-HACCP-03 is in scope without a regulatory citation' }],
};
const menu: Menu = {
  stage: 'scope', qa: report, qaThreshold: 70,
  actions: [
    { type: 'open_gate', subjectKey: 'scope' },
    { type: 'rework', specialist: 'scope', subjectKey: 'scope', instruction: 'scope.citations: FD-HACCP-03 is in scope without a regulatory citation' },
    { type: 'request_qa', subjectKey: 'scope', mode: 'challenge' },
    { type: 'escalate', reason: 'QA found 1 issue(s) in the scope' },
  ],
};

const decide = (handler: ConstructorParameters<typeof FakeProvider>[0]) => {
  const fake = new FakeProvider(handler);
  return { fake, decision: new LlmPolicy().decide(menu, testModels(fake)) };
};

describe('the LLM policy [REQ-26]', () => {
  it('takes the menu entry the model chose, with its reason, and records the attempt', async () => {
    const { decision } = decide(() => ({ choice: 2, rationale: 'Borderline score: challenge before the gate.' }));
    expect(await decision).toEqual({
      action: menu.actions[2], rationale: 'Borderline score: challenge before the gate.', policy: 'llm', policyVersion: LLM_POLICY_VERSION,
      attempts: [{ outcome: 'chosen', model: 'fake-1', detail: 'chose 2' }],
    });
  });

  it('asks once more after an answer off the menu, saying why the first was refused', async () => {
    const { fake, decision } = decide((_req, call) => (call === 1 ? { choice: 9, rationale: 'x' } : { choice: 0, rationale: 'Open the gate.' }));
    expect(await decision).toMatchObject({ action: menu.actions[0], policy: 'llm', attempts: [{ outcome: 'off_menu' }, { outcome: 'chosen' }] });
    expect(fake.requests[1].user).toContain('Your previous answer was refused: 9 is not on the list');
  });

  it('lets the rules decide after two answers off the menu, and logs both', async () => {
    const { decision } = decide(() => ({ choice: -1, rationale: 'x' }));
    const d = await decision;
    // The rules redraft: QA scored 60, below the threshold of 70, and a redraft is on the menu.
    expect(d).toMatchObject({ action: menu.actions[1], policy: 'rules', policyVersion: RULES_VERSION, attempts: [{ outcome: 'off_menu' }, { outcome: 'off_menu' }] });
    expect(d.rationale).toMatch(/rules decided: the model answered off the menu twice/);
  });

  it('asks once more after a malformed answer', async () => {
    const { decision } = decide((_req, call) => (call === 1 ? { pick: 'the gate' } : { choice: 1, rationale: 'Redraft first.' }));
    expect(await decision).toMatchObject({ action: menu.actions[1], policy: 'llm', attempts: [{ outcome: 'malformed' }, { outcome: 'chosen' }] });
  });

  it('falls back to the rules, flagged, when the model is down', async () => {
    const { fake, decision } = decide(() => { throw new Error('overloaded'); });
    const d = await decision;
    expect(fake.requests).toHaveLength(4);
    expect(d).toMatchObject({ policy: 'rules', attempts: [{ outcome: 'model_error' }] });
    expect(d.rationale).toMatch(/drafted without model/);
  });

  it('keeps a long or empty rationale within the decision\'s limits', async () => {
    expect((await decide(() => ({ choice: 0, rationale: 'x'.repeat(2000) })).decision).rationale).toHaveLength(500);
    expect((await decide(() => ({ choice: 0, rationale: '   ' })).decision).rationale).toBe('No reason given');
  });

  it('shows the model the stage, the numbered menu and the QA report, as data, and never a rework instruction', () => {
    const prompt = policyPrompt(menu);
    expect(prompt).toContain('0. {"type":"open_gate","subjectKey":"scope"}');
    expect(prompt).toContain('<data source="qa-report">');
    expect(prompt).not.toContain('"instruction"');
    expect(POLICY_SYSTEM).toContain(DATA_RULES);
  });

  it('is not asked at all when the menu has one entry', async () => {
    const fake = new FakeProvider(() => ({ choice: 0, rationale: 'x' }));
    const only: Menu = { ...menu, actions: [menu.actions[0]] };
    expect(await chooseDecision(new LlmPolicy(), only, testModels(fake))).toMatchObject({ policy: 'forced', policyVersion: LLM_POLICY_VERSION });
    expect(fake.requests).toHaveLength(0);
  });
});
