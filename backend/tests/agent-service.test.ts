import { describe, expect, it } from 'vitest';
import { AGENT_PORT_METHODS, agentPort } from '../src/agents/port';
import { draftTestPlans } from '../src/agents/specialists/test-plan';
import { readTrail } from '../src/db/trail-repo';
import { ProviderError, type GenerateRequest, type GenerateResult, type LlmProvider } from '../src/engine/llm/provider';
import { runWithRequestId } from '../src/observability/context';
import { AuditService } from '../src/service';
import { testDb } from './db';
import { auditor, engagementWithFailedControl, LENIENT, NEW_ENGAGEMENT, newService, registry, reviewer, unattended, viewer } from './helpers';

const acting = (agent = 'scope') => ({ runId: 'AR-test', agent, startedBy: auditor });

/** A model call during which a person saves a change. Inside the engagement lock that save would wait for ever. */
class EditsDuringTheCall implements LlmProvider {
  readonly id = 'edit';
  readonly model = 'edit-1';
  engagementId = '';
  constructor(private svc: () => AuditService) {}
  async generate<T>(_req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    await this.svc().setScope(this.engagementId, [], auditor);
    throw new ProviderError('no model in this test');
  }
}

/** Two failed controls with draft findings. */
async function twoFindings(svc: AuditService) {
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  await svc.runModule(e.id, 'scope', auditor);
  const scope = (await svc.engagement(e.id)).scope;
  const [a, b] = scope.slice(0, 2).map((s) => s.controlId);
  await svc.setScope(e.id, scope.map((s) => ({ controlId: s.controlId, included: s.controlId === a || s.controlId === b })), auditor);
  await svc.runModule(e.id, 'rcm', auditor);
  for (const id of [a, b]) {
    await svc.recordTest(e.id, id, { designAdequate: true, observation: '2 of 10 records unsigned.', evidenceRefs: ['EV-1'], sampleTested: 10, exceptions: 2 }, auditor);
  }
  await svc.runModule(e.id, 'testing', auditor);
  await svc.runModule(e.id, 'gaps', auditor);
  return { id: e.id, a, b };
}

describe('the agent path into the service', () => {
  it('records specialist work as the agent’s, on behalf of the person who started the run, under the run id [REQ-28]', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const { bundle } = await runWithRequestId('AR-test', () => svc.runModuleAsAgent(e.id, 'scope', acting(), { expectedVersion: e.version! }));
    expect(bundle).toMatchObject({ moduleId: 'scope', actor: 'agent:scope', requestId: 'AR-test', inputs: { runId: 'AR-test', onBehalfOf: 'auditor' } });
    expect((await svc.engagement(e.id)).scope.length).toBeGreaterThan(0);
  });

  it('refuses to apply work begun on an older version of the engagement [REQ-21]', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    await expect(svc.runModuleAsAgent(e.id, 'scope', acting(), { expectedVersion: e.version! + 1 })).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
  });

  it('calls the model outside the engagement lock, and refuses to apply over a change made meanwhile [REQ-21]', async () => {
    let svc!: AuditService;
    const model = new EditsDuringTheCall(() => svc);
    svc = new AuditService(await testDb(), registry, model, LENIENT);
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    model.engagementId = e.id;
    await expect(svc.runModuleAsAgent(e.id, 'scope', acting(), { expectedVersion: e.version! })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await svc.engagement(e.id)).scope).toEqual([]);
    expect((await readTrail(svc.db.kysely, e.id)).map((b) => b.moduleId)).toEqual(['human:create-engagement', 'human:scope-decision']);
  });

  it("keeps people's scope decisions when the agent redrafts the scope", async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    const flipped = (await svc.engagement(e.id)).scope.slice(0, 2).map((s) => ({ controlId: s.controlId, included: !s.included }));
    const edited = await svc.setScope(e.id, flipped, auditor);
    await svc.runModuleAsAgent(e.id, 'scope', acting(), { expectedVersion: edited.version! });
    const after = (await svc.engagement(e.id)).scope;
    for (const f of flipped) expect(after.find((s) => s.controlId === f.controlId)!.included).toBe(f.included);
  });

  it('redrafts only the targeted findings; every other finding stays exactly as it was', async () => {
    const svc = await newService();
    const { id, a, b } = await twoFindings(svc);
    const drafted = await svc.engagement(id);
    const editedB = await svc.editFinding(id, drafted.findings.find((f) => f.rowId === b)!.id, { title: 'Records left unsigned' }, auditor);
    const current = await svc.engagement(id);
    await svc.runModuleAsAgent(id, 'gaps', acting('gaps'), { expectedVersion: current.version!, rows: [a] });
    const after = await svc.engagement(id);
    expect(after.findings.find((f) => f.rowId === b)).toEqual(editedB);
    const redrafted = after.findings.find((f) => f.rowId === a)!;
    expect(redrafted.id).not.toBe(drafted.findings.find((f) => f.rowId === a)!.id);
    expect(redrafted.preparedBy).toEqual(['auditor']);
  });

  it('refuses any agent change to a reviewed finding, and saves nothing [REQ-27]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.signOff(e.id, f.id, 'review', '', reviewer, {}, unattended);
    const before = await svc.engagement(e.id);
    // The graph never asks for this; the rails refuse it anyway.
    await expect(svc.runModuleAsAgent(e.id, 'gaps', acting('gaps'), { expectedVersion: before.version!, rows: [f.rowId] }))
      .rejects.toMatchObject({ status: 403, code: 'AGENT_FORBIDDEN' });
    expect(await svc.engagement(e.id)).toEqual(before);
  });

  it('lets only an auditor decide not to test a row; the agent can neither set nor clear it [REQ-27]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const saved = await svc.saveTestPlansAsAgent(e.id, draftTestPlans(e), acting('test-plan'), { expectedVersion: e.version! });
    expect(saved.bundle).toMatchObject({ moduleId: 'agent:test-plans', actor: 'agent:test-plan' });
    const rowId = e.rcm[0].id;
    await expect(svc.editTestPlan(e.id, rowId, { notTestedJustification: 'x' }, viewer)).rejects.toMatchObject({ status: 403 });
    expect(await svc.editTestPlan(e.id, rowId, { notTestedJustification: 'Control retired in March' }, auditor))
      .toMatchObject({ notTestedJustification: 'Control retired in March', editedBy: 'auditor' });
    const now = await svc.engagement(e.id);
    const { notTestedJustification: _, ...plain } = now.testPlans[rowId];
    await expect(svc.saveTestPlansAsAgent(e.id, { ...now.testPlans, [rowId]: plain }, acting('test-plan'), { expectedVersion: now.version! }))
      .rejects.toMatchObject({ code: 'AGENT_FORBIDDEN' });
    await expect(svc.saveTestPlansAsAgent(e.id, { ...now.testPlans, [rowId]: { ...plain, notTestedJustification: 'agent says no' } }, acting('test-plan'), { expectedVersion: now.version! }))
      .rejects.toMatchObject({ code: 'AGENT_FORBIDDEN' });
    expect(draftTestPlans(now)[rowId].notTestedJustification).toBe('Control retired in March');
  });

  it('gives the agent runtime no way to sign, record tests or edit anything by hand [REQ-27]', async () => {
    const port = agentPort(await newService());
    expect(Object.keys(port).sort()).toEqual([...AGENT_PORT_METHODS].sort());
    for (const name of ['signOff', 'signGate', 'recordTest', 'editFinding', 'editTestPlan', 'setScope', 'db']) expect(name in port).toBe(false);
  });
});
