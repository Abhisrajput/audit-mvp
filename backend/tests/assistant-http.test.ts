import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { listRuns } from '../src/agents/run-repo';
import { loadAssistantConfig, defaultAssistantConfig, type AssistantConfig } from '../src/assistant/config';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import type { LlmProvider } from '../src/engine/llm/provider';
import { DEFAULT_RATE_LIMITS, type RateLimits } from '../src/http/security';
import { FakeProvider, NEW_ENGAGEMENT } from './helpers';
import { newService } from './helpers';
import { devAuthConfig, signIn } from './http';

const TURNS = '/api/assistant/turns';
const COMMANDS = '/api/assistant/commands';

async function setup(opts: { llm?: LlmProvider; assistant?: AssistantConfig; rateLimits?: RateLimits } = {}) {
  const svc = await newService(opts.llm);
  await ensureDevUsers(svc.db.kysely);
  const app = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, {
    agents: defaultAgentConfig(), assistant: opts.assistant ?? defaultAssistantConfig(), rateLimits: opts.rateLimits ?? DEFAULT_RATE_LIMITS,
  });
  const auditor = await signIn(app, 'auditor');
  const id = (await auditor.post('/api/engagements', NEW_ENGAGEMENT).expect(201)).body.id as string;
  return { svc, app, auditor, id };
}

describe('the assistant over HTTP (spec §7)', () => {
  it('tells each role what it may do; admins get nothing [REQ-36]', async () => {
    const { app, auditor } = await setup();
    const viewer = (await (await signIn(app, 'viewer')).get('/api/assistant/settings').expect(200)).body;
    expect(viewer.planner).toBe('rules');
    expect(viewer.enabled).toBe(true);
    expect(viewer.commands.length).toBeGreaterThan(0);
    expect(viewer.commands.some((c: { kind: string }) => c.kind === 'write')).toBe(false);
    const names = (await auditor.get('/api/assistant/settings').expect(200)).body.commands.map((c: { name: string }) => c.name);
    expect(names).toContain('create_engagement');
    expect((await (await signIn(app, 'admin')).get('/api/assistant/settings')).status).toBe(403);
  });

  it('a read turn runs the command and returns the result', async () => {
    const { auditor, id } = await setup();
    const res = await auditor.post(TURNS, { message: 'list engagements' }).expect(200);
    expect(res.body.command).toMatchObject({ name: 'list_engagements', kind: 'read', summary: 'List engagements' });
    expect(typeof res.body.say).toBe('string');
    expect(res.body.result).toMatchObject([{ id }]);
    expect(res.body.proposal).toBeUndefined();
  });

  it('a write turn returns a proposal and writes nothing [REQ-36]', async () => {
    const { svc, auditor, id } = await setup();
    const res = await auditor.post(TURNS, { message: `start the run on ${id}` }).expect(200);
    expect(res.body.proposal).toEqual({ name: 'start_run', args: { engagementId: id }, summary: `Start an agent run on ${id}`, expectedVersion: 1 });
    expect(res.body.command).toBeUndefined();
    expect(await listRuns(svc.db.kysely, id)).toEqual([]);
  });

  it('confirming the proposal runs it as the caller, trailed as their own action [REQ-36]', async () => {
    const { svc, auditor, id } = await setup();
    const proposal = (await auditor.post(TURNS, { message: `start the run on ${id}` }).expect(200)).body.proposal;
    const res = await auditor.post(COMMANDS, { name: proposal.name, args: proposal.args, expectedVersion: proposal.expectedVersion }).expect(200);
    expect(res.body.summary).toBe(proposal.summary);
    expect(res.body.result).toMatchObject({ run: { status: 'runnable', startedBy: 'auditor' } });
    expect((await readTrail(svc.db.kysely, id)).at(-1)).toMatchObject({ moduleId: 'human:agent-run-start', actor: 'auditor' });
  });

  it('a stale expectedVersion is 409 VERSION_CONFLICT', async () => {
    const { auditor, id } = await setup();
    await auditor.post(`/api/engagements/${id}/modules/scope/run`).expect(200);
    await auditor.post(`/api/engagements/${id}/modules/rcm/run`).expect(200);
    const res = await auditor.post(COMMANDS, { name: 'set_tolerance', args: { engagementId: id, controlId: 'FD-HACCP-03', rate: 0.1 }, expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
  });

  it('every engagement write is version-checked at confirm, even one whose service does not check [REQ-36]', async () => {
    const { svc, auditor, id } = await setup();
    const proposal = (await auditor.post(TURNS, { message: `start the run on ${id}` }).expect(200)).body.proposal;
    expect(proposal.expectedVersion).toBe(1);
    await auditor.post(`/api/engagements/${id}/modules/scope/run`).expect(200);
    const res = await auditor.post(COMMANDS, { name: proposal.name, args: proposal.args, expectedVersion: proposal.expectedVersion });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(await listRuns(svc.db.kysely, id)).toEqual([]);
  });

  it('a turn naming a missing engagement answers in words, for a read and for a write', async () => {
    const { auditor } = await setup();
    const read = await auditor.post(TURNS, { message: 'show ENG-NOPE' }).expect(200);
    expect(read.body).toEqual({ say: 'I could not find ENG-NOPE.' });
    const write = await auditor.post(TURNS, { message: 'start the run on ENG-NOPE' }).expect(200);
    expect(write.body).toEqual({ say: 'I could not find ENG-NOPE.' });
  });

  it('context.engagementId and shown ids are capped at 200 characters', async () => {
    const { auditor } = await setup();
    expect((await auditor.post(TURNS, { message: 'list packs', context: { engagementId: 'E'.repeat(201) } })).status).toBe(400);
    expect((await auditor.post(TURNS, { message: 'list packs', context: { shown: [{ kind: 'document', id: 'd'.repeat(201), label: 'x' }] } })).status).toBe(400);
    await auditor.post(TURNS, { message: 'list packs', context: { engagementId: 'E'.repeat(200) } }).expect(200);
  });

  it('a viewer may not confirm a write, and unknown names or bad args are 400/403', async () => {
    const { app, auditor, id } = await setup();
    const viewer = await signIn(app, 'viewer');
    expect((await viewer.post(COMMANDS, { name: 'start_run', args: { engagementId: id } })).status).toBe(403);
    expect((await auditor.post(COMMANDS, { name: 'sign_gate', args: {} })).status).toBe(400);
    expect((await auditor.post(COMMANDS, { name: 'set_tolerance', args: { engagementId: id, controlId: 'FD-HACCP-03', rate: 0.9 } })).status).toBe(400);
  });

  it('is switched off by ASSISTANT_ENABLED=false on both posts [REQ-36]', async () => {
    const { auditor, id } = await setup({ assistant: { ...defaultAssistantConfig(), enabled: false } });
    for (const [path, body] of [[TURNS, { message: 'list engagements' }], [COMMANDS, { name: 'start_run', args: { engagementId: id } }]] as const) {
      const res = await auditor.post(path, body);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('ASSISTANT_DISABLED');
    }
    expect((await auditor.get('/api/assistant/settings').expect(200)).body.enabled).toBe(false);
  });

  it('rate-limits a chatty client', async () => {
    const { auditor } = await setup({ rateLimits: { ...DEFAULT_RATE_LIMITS, assistantPerMinute: 2 } });
    await auditor.post(TURNS, { message: 'list packs' }).expect(200);
    await auditor.post(TURNS, { message: 'list packs' }).expect(200);
    const third = await auditor.post(TURNS, { message: 'list packs' });
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('RATE_LIMITED');
  });

  it('bodies over the caps are truncated, a 1001-char message is 400, and unknown fields are 400 [REQ-36]', async () => {
    const llm = new FakeProvider(() => ({ kind: 'reply', say: 'ok' }));
    const { auditor } = await setup({ llm });
    const shown = Array.from({ length: 25 }, (_, i) => ({ kind: 'document', id: `d${i}`, label: `L${String(i).padStart(2, '0')}${'x'.repeat(97)}` }));
    const history = Array.from({ length: 10 }, (_, i) => ({ role: 'person', text: `turn-${i}` }));
    await auditor.post(TURNS, { message: 'hello', context: { shown }, history }).expect(200);
    const prompt = llm.requests[0].user as string;
    expect(prompt.match(/"id": "d\d+"/g)).toHaveLength(20);
    expect(prompt).not.toContain('"d20"');
    const labels = prompt.match(/"label": "L\d\dx*"/g)!;
    expect(labels).toHaveLength(20);
    expect(labels.every((l) => l.length === '"label": "'.length + 80 + 1)).toBe(true);
    expect(prompt).not.toContain('turn-1"');
    expect(prompt.match(/turn-\d/g)).toHaveLength(8);
    expect((await auditor.post(TURNS, { message: 'x'.repeat(1001) })).status).toBe(400);
    expect((await auditor.post(TURNS, { message: 'hello', extra: 1 })).status).toBe(400);
  });

  it('with a model, the proposal comes from the model and the fallback reply from the rules', async () => {
    const answering = await setup({ llm: new FakeProvider(() => ({ kind: 'command', name: 'find_documents', args: { query: 'haccp' }, say: 'Searching.' })) });
    const found = await answering.auditor.post(TURNS, { message: 'where is the haccp stuff' }).expect(200);
    expect(found.body.command.name).toBe('find_documents');
    expect(found.body.result).toEqual([]);
    const failing = await setup({ llm: new FakeProvider(() => { throw new Error('provider down'); }) });
    const fallback = await failing.auditor.post(TURNS, { message: 'gibberish please' }).expect(200);
    expect(fallback.body.say).toMatch(/fixed phrases|I could not/);
  });
});

describe('loadAssistantConfig (spec §9)', () => {
  it('defaults, reads the three variables, and rejects a bad timeout', () => {
    expect(loadAssistantConfig({})).toEqual({ enabled: true, model: 'claude-sonnet-5-5', timeoutMs: 20000 });
    expect(loadAssistantConfig({ ASSISTANT_ENABLED: 'false', ASSISTANT_MODEL: 'claude-haiku-5-5', ASSISTANT_MODEL_TIMEOUT_MS: '5000' })).toEqual({ enabled: false, model: 'claude-haiku-5-5', timeoutMs: 5000 });
    expect(() => loadAssistantConfig({ ASSISTANT_MODEL_TIMEOUT_MS: '10' })).toThrow(/ASSISTANT_MODEL_TIMEOUT_MS/);
  });
});
