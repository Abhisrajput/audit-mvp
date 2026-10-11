import type { GenerateRequest, GenerateResult, LlmProvider } from '../src/engine/llm/provider';
import { PackRegistry } from '../src/engine/packs';
import { AuditService, USERS } from '../src/service';
import { testDb } from './db';

export const registry = PackRegistry.loadFromDir();
export const [auditor, reviewer, approver] = USERS;

/** A service on its own fresh database. */
export async function newService(llm: LlmProvider | null = null) {
  return new AuditService(await testDb(), registry, llm);
}

/** A scripted model: returns whatever the handler builds for the request. */
export class FakeProvider implements LlmProvider {
  readonly id = 'fake';
  readonly model = 'fake-1';
  constructor(private handler: (req: GenerateRequest<any>) => unknown) {}
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    return { output: req.schema.parse(this.handler(req)), servedModel: this.model };
  }
}

export const NEW_ENGAGEMENT = {
  name: 'Test audit', entity: 'Demo Foods', site: 'Plant 1', periodFrom: '2026-01-01', periodTo: '2026-06-30',
  auditType: 'Food safety', scopeStatement: 'HACCP CCP monitoring, supplier approval, traceability and allergen controls', packIds: ['food', 'common'],
};

export async function engagementWithFailedControl(svc: AuditService, controlId = 'FD-HACCP-03', evidenceRefs = ['CCP-LOG-MAR']) {
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  await svc.runModule(e.id, 'scope', auditor);
  await svc.setScope(e.id, [{ controlId, included: true }], auditor);
  await svc.runModule(e.id, 'rcm', auditor);
  await svc.recordTest(e.id, controlId, { designAdequate: true, observation: '3 of 20 CCP logs unsigned.', evidenceRefs, sampleTested: 20, exceptions: 3 }, auditor);
  await svc.runModule(e.id, 'testing', auditor);
  await svc.runModule(e.id, 'gaps', auditor);
  return svc.engagement(e.id);
}
