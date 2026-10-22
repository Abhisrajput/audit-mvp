import { MalformedOutputError, type GenerateRequest, type GenerateResult, type LlmProvider } from '../src/engine/llm/provider';
import { ModelMeter } from '../src/agents/budget';
import type { AgentLlmConfig, RoleSettings } from '../src/agents/config';
import { AgentModels } from '../src/agents/llm/models';
import { NO_SPEND, type Budget } from '../src/agents/types';
import { registryFromBundles } from '../src/knowledge/packs';
import { defaultAgentConfig } from '../src/agents/config';
import { RULES_VERSION } from '../src/agents/policy/rules';
import { createRun, leaseNext, recordSpend, type AgentRun } from '../src/agents/run-repo';
import { DEV_USERS, ensureDevUsers } from '../src/auth/dev-users';
import type { TestInput } from '../src/engine/types';
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

/**
 * A scripted model. The handler builds each answer (or throws, to act as an outage); an answer that does not fit the
 * request's schema is refused the way the real provider refuses one (MalformedOutputError). Every request is kept.
 */
export class FakeProvider implements LlmProvider {
  readonly id = 'fake';
  readonly model = 'fake-1';
  readonly requests: GenerateRequest<any>[] = [];

  constructor(
    private handler: (req: GenerateRequest<any>, call: number) => unknown,
    private opts: { usage?: { inputTokens: number; outputTokens: number } | null; servedModel?: string } = {},
  ) {}

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.requests.push(req);
    const raw = await this.handler(req, this.requests.length);
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) throw new MalformedOutputError(`The fake model's answer did not match the schema: ${parsed.error.message}`);
    const usage = this.opts.usage === undefined ? { inputTokens: 1000, outputTokens: 200 } : this.opts.usage;
    return { output: parsed.data, servedModel: this.opts.servedModel ?? req.model ?? this.model, ...(usage ? { usage } : {}) };
  }
}

const FAKE_ROLE: RoleSettings = { model: 'fake-1', maxTokens: 500, effort: 'low' };

/** Agent model settings for tests: every role on the fake model, at $10 per million tokens each way. */
export const TEST_LLM: AgentLlmConfig = {
  roles: { policy: FAKE_ROLE, qa: FAKE_ROLE, 'test-plan': FAKE_ROLE, specialist: FAKE_ROLE },
  prices: { 'fake-1': { inputPerMTok: 10, outputPerMTok: 10 } },
  timeoutMs: 1000,
};

/** Retry backoff that does not wait. */
export const noWait = async () => {};

/** Model access for tests without a run: metered against a generous budget, with nothing written anywhere. */
export function testModels(provider: LlmProvider | null, budget: Budget = { maxSteps: 100, maxTokens: 10_000_000, maxCostUsd: 1000 }) {
  return new AgentModels(provider, TEST_LLM, new ModelMeter(budget, NO_SPEND, async () => {}), { wait: noWait });
}

export const NEW_ENGAGEMENT = {
  name: 'Test audit', entity: 'Demo Foods', site: 'Plant 1', periodFrom: '2026-01-01', periodTo: '2026-06-30',
  auditType: 'Food safety', scopeStatement: 'HACCP CCP monitoring, supplier approval, traceability and allergen controls', packIds: ['food', 'common'],
};

export async function engagementWithFailedControl(svc: AuditService, controlId = 'FD-HACCP-03', evidenceRefs = ['CCP-LOG-MAR'], overrides: Partial<Omit<TestInput, 'updatedBy' | 'updatedAt'>> = {}) {
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  await svc.runModule(e.id, 'scope', auditor);
  await svc.setScope(e.id, [{ controlId, included: true }], auditor);
  await svc.runModule(e.id, 'rcm', auditor);
  await svc.recordTest(e.id, controlId, { designAdequate: true, observation: '3 of 20 CCP logs unsigned.', evidenceRefs, sampleTested: 20, exceptions: 3, ...overrides }, auditor);
  await svc.runModule(e.id, 'testing', auditor);
  await svc.runModule(e.id, 'gaps', auditor);
  return svc.engagement(e.id);
}

/** Model access for a leased run, the way the worker builds it: every charge is written to the run while its lease holds. */
export function runModels(svc: AuditService, run: AgentRun, provider: LlmProvider | null) {
  const db = svc.db.kysely;
  const meter = new ModelMeter(run.budget, run.spent, (s) => db.transaction().execute((trx) => recordSpend(trx, run.id, run.leaseOwner!, s)));
  return new AgentModels(provider, TEST_LLM, meter, { wait: noWait });
}

/** The gaps prompt's answer: every finding as the data gives it, plus the overlay; any other request throws so the module falls back to its rules. */
export function gapsAnswerFrom(req: { user: string }, overlay: Record<string, unknown>) {
  if (!req.user.includes('Draft one audit finding')) throw new Error('not the gaps prompt');
  const open = req.user.indexOf('>\n', req.user.indexOf('<data source="workpaper:failed-controls"')) + 2;
  const rows = JSON.parse(req.user.slice(open, req.user.lastIndexOf('\n</data>'))) as { rowId: string; control: string; risk: string; record: { observation: string }; allowedClauses: { clauseId: string }[] }[];
  return {
    findings: rows.map((r) => ({
      rowId: r.rowId, title: r.control, condition: r.record.observation, criteria: 'criteria', cause: 'cause', effect: r.risk,
      recommendation: 'Tailored recommendation', clauseIds: r.allowedClauses.map((c) => c.clauseId).slice(0, 1), ...overlay,
    })),
  };
}
