import type { GenerateRequest, GenerateResult, LlmProvider } from '../src/engine/llm/provider';
import { registryFromBundles } from '../src/knowledge/packs';
import { defaultAgentConfig } from '../src/agents/config';
import { RULES_VERSION } from '../src/agents/policy/rules';
import { createRun, leaseNext } from '../src/agents/run-repo';
import { DEV_USERS, ensureDevUsers } from '../src/auth/dev-users';
import { AuditService, type AgentActing } from '../src/service';
import { testDb } from './db';

/** Server-side signing in tests: no person re-authenticates, and the signature records that. */
export const unattended = { unattended: 'test' } as const;

export const registry = registryFromBundles();
export const [auditor, reviewer, approver, admin, viewer] = DEV_USERS;

/**
 * The MVP packs are not yet expert-verified, so tests run the way demos do: unverified knowledge is
 * cited with a warning. tests/trust.test.ts covers the strict default.
 */
export const LENIENT = { citationPolicy: { allowUnverified: true } } as const;

/** A service on its own fresh database. */
export async function newService(llm: LlmProvider | null = null) {
  return new AuditService(await testDb(), registry, llm, LENIENT);
}

/**
 * Starts an agent run on the engagement and leases it the way a worker does, since the service saves an agent's work
 * only while its worker holds the run's lease. Returns how each specialist of that run acts.
 */
export async function leasedRun(svc: AuditService, engagementId: string, leaseOwner = 'w-test') {
  await ensureDevUsers(svc.db.kysely);
  const run = await createRun(svc.db.kysely, { engagementId, startedBy: auditor.id, policy: 'rules', policyVersion: RULES_VERSION, budget: defaultAgentConfig().budget });
  const leased = await leaseNext(svc.db.kysely, leaseOwner, 60_000);
  if (leased?.id !== run.id) throw new Error(`expected to lease ${run.id}`);
  return { run: leased, acting: (agent = 'scope'): AgentActing => ({ runId: run.id, agent, startedBy: auditor, leaseOwner }) };
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
