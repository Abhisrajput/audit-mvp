import { describe, expect, it } from 'vitest';
import { boundInput, LIMITS, ModelPlanner, rulesPlan, validateAnswer, type PlannerData } from '../src/assistant/planner';
import { DATA_RULES } from '../src/engine/llm/prompt';
import type { LlmProvider } from '../src/engine/llm/provider';
import { FakeProvider } from './helpers';

const data: PlannerData = {
  engagements: [{ id: 'ENG-1', name: 'Plant 1 audit', entity: 'Demo Foods', site: 'Plant 1', stage: 'planning' }],
  packs: [{ id: 'food', name: 'Food', vertical: 'food' }],
  today: '2026-10-22',
};
const input = (message: string, context = {}) => boundInput({ message, context });

describe('the rules planner (spec §4.4)', () => {
  it.each([
    ['list engagements', 'list_engagements', {}], ['Show ENG-1', 'show_engagement', { engagementId: 'ENG-1' }],
    ['list findings for ENG-1', 'list_findings', { engagementId: 'ENG-1' }], ['find documents about allergen swabs', 'find_documents', { query: 'allergen swabs' }],
    ['find the HACCP SOP', 'find_documents', { query: 'the HACCP SOP' }], ['search standards for sanitation', 'search_standards', { query: 'sanitation' }],
    ['list packs', 'list_packs', {}], ['start the run on ENG-1', 'start_run', { engagementId: 'ENG-1' }],
  ])('%s → %s', (message, name, args) => {
    const plan = rulesPlan(input(message), 'auditor');
    expect(plan).toMatchObject({ kind: 'command', command: { name }, args });
  });

  it('takes the engagement from the context and asks when there is none; a named engagement wins', () => {
    expect(rulesPlan(input('list findings', { engagementId: 'ENG-9' }), 'auditor')).toMatchObject({ kind: 'command', args: { engagementId: 'ENG-9' } });
    expect(rulesPlan(input('list findings for ENG-1', { engagementId: 'ENG-9' }), 'auditor')).toMatchObject({ kind: 'command', args: { engagementId: 'ENG-1' } });
    expect(rulesPlan(input('list findings'), 'auditor')).toEqual({ kind: 'reply', say: 'To list the findings of an engagement I need: the engagement.' });
  });

  it('answers signing and unknown phrases with a reply, and a write for a viewer with a refusal', () => {
    expect(rulesPlan(input('approve the report gate'), 'auditor')).toMatchObject({ kind: 'reply', say: expect.stringContaining('gate card') });
    expect(rulesPlan(input('what is the weather'), 'auditor')).toMatchObject({ kind: 'reply', say: expect.stringContaining('fixed phrases') });
    expect(rulesPlan(input('start the run on ENG-1'), 'viewer')).toEqual({ kind: 'reply', say: 'That command is not available to your role.' });
  });

  it('does not mistake a word that merely contains "sign" for a signing request', () => {
    expect(rulesPlan(input('find the design review'), 'auditor')).toMatchObject({ kind: 'command', command: { name: 'find_documents' } });
  });
});

describe('boundInput', () => {
  it('keeps the last 8 history turns, cuts texts to 500 and labels to 80, and keeps at most 20 shown items', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: 'person' as const, text: `${i}`.padEnd(600, 'x') }));
    const shown = Array.from({ length: 25 }, (_, i) => ({ kind: 'finding' as const, id: `F-${i}`, label: 'l'.repeat(100) }));
    const out = boundInput({ message: 'm'.repeat(2000), context: { engagementId: 'ENG-1', shown }, history });
    expect(out.history).toHaveLength(LIMITS.history);
    expect(out.history[0].text.startsWith('2')).toBe(true);
    expect(out.history.every((h) => h.text.length === LIMITS.historyText)).toBe(true);
    expect(out.context.shown).toHaveLength(LIMITS.shown);
    expect(out.context.shown!.every((s) => s.label.length === LIMITS.label)).toBe(true);
    expect(out.context.engagementId).toBe('ENG-1');
    expect(out.message).toHaveLength(2000);
    expect(shown[0].label).toHaveLength(100);
    expect(history).toHaveLength(10);
  });
  it('tolerates a missing context and history', () => {
    expect(boundInput({ message: 'hi' })).toEqual({ message: 'hi', context: {}, history: [] });
  });
});

describe('validateAnswer', () => {
  it('lists the missing fields and refuses a name the role cannot use', () => {
    expect(validateAnswer({ name: 'create_engagement', args: { name: 'x' } }, 'auditor', {})).toMatchObject({ ok: false, refusal: '', missing: expect.arrayContaining(['entity', 'packIds']) });
    expect(validateAnswer({ name: 'start_run', args: {} }, 'viewer', {})).toEqual({ ok: false, missing: [], refusal: 'start_run is not one of the commands' });
    expect(validateAnswer({ name: 'nope', args: {} }, 'auditor', {})).toMatchObject({ ok: false, refusal: 'nope is not one of the commands' });
    expect(validateAnswer({ name: 'start_run', args: {} }, 'auditor', { engagementId: 'ENG-1' })).toMatchObject({ ok: true, args: { engagementId: 'ENG-1' } });
  });
});

describe('the model planner (spec §4.2–4.3)', () => {
  const planner = (p: LlmProvider) => new ModelPlanner(p, { model: 'fake-1', timeoutMs: 1000 });

  it("runs a valid command from one call, and shows the model only this role's commands", async () => {
    const p = new FakeProvider(() => ({ kind: 'command', name: 'show_engagement', args: { engagementId: 'ENG-1' }, say: 'Here it is.' }));
    expect(await planner(p).plan(input('show the plant 1 audit'), 'viewer', data)).toMatchObject({ outcome: 'command', plan: { kind: 'command', command: { name: 'show_engagement' }, args: { engagementId: 'ENG-1' }, say: 'Here it is.' } });
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0].user).not.toContain('create_engagement');
    expect(p.requests[0]).toMatchObject({ model: 'fake-1', maxTokens: 1500, effort: 'low', timeoutMs: 1000, sdkRetries: 0 });
  });

  it('asks for missing fields deterministically, with no second call', async () => {
    const p = new FakeProvider(() => ({ kind: 'command', name: 'create_engagement', args: { name: 'Supplier approval audit' }, say: 'Creating it.' }));
    const r = await planner(p).plan(input('initiate an audit on supplier approval'), 'auditor', data);
    expect(r).toMatchObject({ outcome: 'reply', plan: { kind: 'reply', say: 'To create a new engagement I need: the entity, the site, the period start, the period end, the audit type, a scope statement, the content packs.' } });
    expect(p.requests).toHaveLength(1);
  });

  it('refuses an off-list name once with the reason, then falls back to the rules', async () => {
    const p = new FakeProvider(() => ({ kind: 'command', name: 'sign_gate', args: {}, say: 'Signing.' }));
    const r = await planner(p).plan(input('approve the report gate'), 'auditor', data);
    expect(p.requests).toHaveLength(2);
    expect(p.requests[1].user).toContain('Your previous answer was refused: sign_gate is not one of the commands');
    expect(r).toMatchObject({ outcome: 'refused', plan: { kind: 'reply', say: expect.stringContaining('gate card') } });
  });

  it("a viewer's write answer is refused even though the name exists", async () => {
    const p = new FakeProvider(() => ({ kind: 'command', name: 'start_run', args: { engagementId: 'ENG-1' }, say: 'Starting.' }));
    const r = await planner(p).plan(input('please run the audit'), 'viewer', data);
    expect(r.outcome).toBe('refused');
    expect(r.plan.kind).toBe('reply');
  });

  it('a corrected second answer is accepted', async () => {
    const p = new FakeProvider((_req, n) => (n === 1 ? { kind: 'command', name: 'nope', args: {}, say: 'x' } : { kind: 'command', name: 'list_packs', args: {}, say: 'Packs.' }));
    expect(await planner(p).plan(input('packs please'), 'auditor', data)).toMatchObject({ outcome: 'command', plan: { command: { name: 'list_packs' } } });
    expect(p.requests).toHaveLength(2);
  });

  it('invalid args are refused once with the first issue; two malformed answers and a provider error end in the fallback reply', async () => {
    const bad = new FakeProvider(() => ({ kind: 'command', name: 'set_tolerance', args: { engagementId: 'ENG-1', controlId: 'C-1', rate: 0.9 }, say: 'Setting.' }));
    const r1 = await planner(bad).plan(input('set the tolerance to 90%'), 'auditor', data);
    expect(bad.requests).toHaveLength(2);
    expect(bad.requests[1].user).toContain('the arguments were not valid: rate');
    expect(r1.outcome).toBe('refused');

    const junk = new FakeProvider(() => ({ nonsense: true }));
    const r2 = await planner(junk).plan(input('what is the weather'), 'auditor', data);
    expect(junk.requests).toHaveLength(2);
    expect(r2).toMatchObject({ outcome: 'refused', plan: { kind: 'reply', say: expect.stringContaining('I could not turn that into a command. I can:') } });

    const down = new FakeProvider(() => { throw new Error('boom'); });
    const r3 = await planner(down).plan(input('what is the weather'), 'auditor', data);
    expect(down.requests).toHaveLength(1);
    expect(r3).toMatchObject({ outcome: 'fallback', plan: { kind: 'reply', say: expect.stringContaining('I could not turn that into a command. I can:') } });
  });

  it('falls back to a rules command when the model is down and the phrase is known', async () => {
    const down = new FakeProvider(() => { throw new Error('boom'); });
    expect(await planner(down).plan(input('list packs'), 'auditor', data)).toMatchObject({ outcome: 'fallback', plan: { kind: 'command', command: { name: 'list_packs' } } });
  });

  it('trims a reply and cuts it to 400 characters', async () => {
    const p = new FakeProvider(() => ({ kind: 'reply', say: `  ${'a'.repeat(500)}  ` }));
    const r = await planner(p).plan(input('hello'), 'auditor', data);
    expect(r).toMatchObject({ outcome: 'reply' });
    expect(r.plan.say).toHaveLength(400);
  });

  it("wraps every piece of people-written text as data, in the spec's order", async () => {
    const p = new FakeProvider(() => ({ kind: 'reply', say: 'ok' }));
    await planner(p).plan(boundInput({ message: 'find the SOP', context: { shown: [{ kind: 'finding', id: 'F-1', label: 'Unsigned CCP logs' }] }, history: [{ role: 'person', text: 'hi' }] }), 'auditor', data);
    const u = p.requests[0].user;
    for (const s of ['engagements', 'packs', 'shown', 'history', 'message']) expect(u).toContain(`<data source="${s}">`);
    expect(u.indexOf('<data source="engagements">')).toBeLessThan(u.indexOf('<data source="message">'));
    expect(u).toContain('Today is 2026-10-22.');
    expect(p.requests[0].system).toContain(DATA_RULES);
  });
});
