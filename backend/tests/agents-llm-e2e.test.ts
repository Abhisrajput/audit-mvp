import { describe, expect, it } from 'vitest';
import { defaultAgentConfig, type AgentConfig } from '../src/agents/config';
import { POLICY_SYSTEM } from '../src/agents/policy/llm';
import { CHALLENGE_SYSTEM, LOOKUP_SYSTEM, REVIEW_SYSTEM } from '../src/agents/qa/agent';
import { listSteps } from '../src/agents/run-repo';
import { PLAN_SYSTEM } from '../src/agents/specialists/test-plan';
import type { Decision, QaReport } from '../src/agents/types';
import { AgentWorker } from '../src/agents/worker';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { ProviderError, type GenerateRequest } from '../src/engine/llm/provider';
import { verifyChain } from '../src/engine/trail';
import { verifyIntegrity } from '../src/ops/verify';
import { FakeProvider, newService, noWait, TEST_LLM } from './helpers';
import { devAuthConfig, devSign, devSignGate, signIn } from './http';

type GateView = { id: string; kind: string; state: string; subjectKey: string; subjectHash: string; qaReport: QaReport | null };

/**
 * A model that behaves sensibly: the policy opens a gate when the menu offers one, QA scores every criterion 3 of 4,
 * the test-plan drafter keeps the rule-based starting points, and the specialist modules' model is down, so they
 * draft on their rules (flagged).
 */
function sensibleModel() {
  return new FakeProvider((req: GenerateRequest<unknown>) => {
    if (req.system === POLICY_SYSTEM) {
      const entries = req.user.split('\n').filter((l) => /^\d+\. /.test(l));
      const gate = entries.find((l) => l.includes('"open_gate"')) ?? entries[0];
      return { choice: Number(gate.split('.')[0]), rationale: 'QA found nothing blocking: open the gate.' };
    }
    if (req.system === REVIEW_SYSTEM || req.system === CHALLENGE_SYSTEM) {
      return { criteria: [...req.user.matchAll(/^- ([a-z][a-z.-]*): /gm)].map((m) => ({ id: m[1], score: 3, note: 'Adequate.' })), issues: [] };
    }
    if (req.system === LOOKUP_SYSTEM) return { lookups: [] };
    if (req.system === PLAN_SYSTEM) return { plans: [] };
    throw new ProviderError('The specialist model is unavailable in this test');
  });
}

async function setup() {
  const svc = await newService(sensibleModel());
  await ensureDevUsers(svc.db.kysely);
  const agents: AgentConfig = { ...defaultAgentConfig(), llm: TEST_LLM };
  const app = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { agents });
  const worker = new AgentWorker(svc, agents, { id: 'w-llm-e2e', wait: noWait });
  const auditor = await signIn(app, 'auditor');
  const manager = await signIn(app, 'reviewer');
  const cae = await signIn(app, 'approver');
  const id = (await auditor.post('/api/engagements', {
    name: 'Pharma self-inspection', entity: 'Demo Pharma', site: 'OSD plant', periodFrom: '2026-01-01', periodTo: '2026-06-30',
    auditType: 'GMP self-inspection', scopeStatement: 'Data integrity: HPLC audit trails and user access', packIds: ['pharma'],
  }).expect(201)).body.id as string;
  const run = (await auditor.post(`/api/engagements/${id}/runs`, {}).expect(201)).body.run as { id: string; policy: string };
  const state = async () => (await auditor.get(`/api/runs/${run.id}`).expect(200)).body.run as { status: string; statusReason: string; spent: { tokensIn: number; tokensOut: number; costUsd: number } };
  const gates = async () => (await auditor.get(`/api/engagements/${id}/gates`).expect(200)).body as GateView[];
  const openGate = async (kind: string) => (await gates()).find((g) => g.kind === kind && g.state === 'open')!;
  return { svc, worker, auditor, manager, cae, id, run, state, gates, openGate };
}

describe('an agent run with a model, end to end', () => {
  it('decides with the model, pays for every call from its budget, and puts a QA review in front of every signer [REQ-26, REQ-28, REQ-29, REQ-30]', async () => {
    const { svc, worker, auditor, manager, cae, id, run, state, gates, openGate } = await setup();
    expect(run.policy).toBe('llm');

    await worker.drain();
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: 'awaiting scope gate signature' });
    const scopeGate = await openGate('scope');
    const signedScope = await devSignGate(manager, 'reviewer', scopeGate.id, 'approve');
    expect(signedScope.intent.body.qa).toEqual(scopeGate.qaReport);
    expect(signedScope.status!.status).toBe('signed');
    await worker.drain();
    expect((await devSignGate(manager, 'reviewer', (await openGate('rcm')).id, 'approve')).status!.status).toBe('signed');
    await worker.drain();

    const planned = (await auditor.get(`/api/engagements/${id}`).expect(200)).body;
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: `awaiting test results for ${planned.rcm.length} control(s)` });
    for (const row of planned.rcm as { id: string }[]) {
      const failing = row.id === 'PH-DI-01';
      await auditor.put(`/api/engagements/${id}/tests/${row.id}`, {
        designAdequate: true, observation: failing ? 'Audit trail review missing for 5 of 20 sequences' : 'All 20 items reviewed',
        evidenceRefs: ['EV-1'], sampleTested: 20, exceptions: failing ? 5 : 0,
      }).expect(200);
    }
    await worker.drain();
    const finding = (await auditor.get(`/api/engagements/${id}`).expect(200)).body.findings[0];
    const review = await devSign(manager, 'reviewer', id, finding.id, 'review');
    expect(review.intent.body.qa).toMatchObject({ subjectKey: `finding:${finding.rowId}` });
    expect(review.status!.status).toBe('signed');
    expect((await devSign(cae, 'approver', id, finding.id, 'approve')).status!.status).toBe('signed');
    await worker.drain();
    expect((await devSignGate(cae, 'approver', (await openGate('report')).id, 'approve')).status!.status).toBe('signed');
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'completed' });

    // REQ-30: every gate carried the QA agent's review of exactly the content it opened on.
    const all = await gates();
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const g of all) {
      expect(g.qaReport).toMatchObject({ subjectKey: g.subjectKey, subjectHash: g.subjectHash });
      expect(g.qaReport!.reviewer).toMatch(/^qa-llm-1:/);
    }

    // REQ-26 and REQ-28: the model chose at least once, every decision was on its menu, and the trail holds them all.
    const steps = await listSteps(svc.db.kysely, run.id);
    const decisions = steps.filter((s) => s.kind === 'decision').map((s) => s.decision as Decision);
    expect(decisions.some((d) => d.policy === 'llm' && d.attempts?.at(-1)?.outcome === 'chosen')).toBe(true);
    expect(verifyChain(await readTrail(svc.db.kysely)).valid).toBe(true);
    expect((await verifyIntegrity(svc.db.kysely, null)).signatures.problems).toEqual([]);

    // REQ-29: what the run spent is exactly what its steps record, call by call.
    const spent = (await state()).spent;
    expect(spent.tokensIn).toBeGreaterThan(0);
    expect(steps.reduce((n, s) => n + s.tokensIn, 0)).toBe(spent.tokensIn);
    expect(steps.reduce((n, s) => n + s.tokensOut, 0)).toBe(spent.tokensOut);
    expect(steps.reduce((n, s) => n + s.costUsd, 0)).toBeCloseTo(spent.costUsd, 6);
  }, 120_000);
});
