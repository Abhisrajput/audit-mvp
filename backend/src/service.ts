import crypto from 'node:crypto';
import type { Transaction } from 'kysely';
import { assertJustificationsUnchanged, assertPlanAttribution, assertWithinRails, keepScopeDecisions, mergeFindings } from './agents/rails';
import { closeFindingGate, closeGate, getGate, hasApprovedGate, type Gate } from './agents/gate-repo';
import { assertLease, getRun, isTerminal, wakeWaitingRuns } from './agents/run-repo';
import type { SignableWorkpaper } from './agents/types';
import { APPROVER_ROLES, PREPARER_ROLES, REVIEWER_ROLES } from './auth/roles';
import type { Db } from './db';
import type { DB } from './db/schema';
import { insertSignature, listSignatures } from './db/signature-repo';
import { findingContentHash, signatureState, withSignatureStatus, workpaperContentHash } from './signing/content-hash';
import { finishIntent } from './signing/intent-repo';
import {
  insertEngagement, listEngagements, loadEngagement, saveEngagement, type EngagementSummary,
} from './db/engagement-repo';
import { lastRevisionTimes, recordWorkpaperRevisions } from './db/revision-repo';
import { getEvalRun, latestEvalRun, listEvalRuns, saveEvalRun } from './db/eval-repo';
import { appendTrail, readTrail, type Executor, type UnsealedBundle } from './db/trail-repo';
import { Bm25Index, clauseText, controlText } from './engine/grounding';
import type { LlmProvider } from './engine/llm/provider';
import { OFFLINE } from './engine/llm/router';
import { ModuleContext, type Grounding } from './engine/module';
import type { AuditModule } from './engine/module';
import { getModule, MODULES } from './engine/modules';
import type { PackRegistry } from './engine/packs';
import { findingCitationGate } from './engine/qa';
import { STRICT_CITATIONS, trustActions, type CitationPolicy } from './engine/trust';
import { verifyChain } from './engine/trail';
import type { Engagement, Finding, JudgmentMemo, QaAction, Role, SignOff, TestInput, TestPlan, TrailBundle, User } from './engine/types';
import { AppError } from './errors';
import type { EngagementContextInput } from './judgment/context';
import { recomputedCoverage } from './judgment/coverage';
import { insertTolerance } from './db/judgment-repo';
import { TOLERANCE_MAX } from './judgment/sampling';
import { markEditedByHand, sameMemo } from './judgment/memo';
import { METHODOLOGY_PACK_ID } from './judgment/standards';
import type { EvalReport } from './eval/harness';

export { AppError } from './errors';

export const ENGINE_VERSION = '0.1.0';

export interface NewEngagement {
  name: string;
  entity: string;
  site: string;
  periodFrom: string;
  periodTo: string;
  auditType: string;
  scopeStatement: string;
  packIds: string[];
  /** What the auditor knows about the business (spec §3.1); the server adds who and when. */
  context?: EngagementContextInput;
}

/** One agent action for the trail. */
export interface AgentEvent {
  moduleId: string;
  /** Who acted, e.g. 'supervisor', 'qa', 'test-plan'; recorded as actor `agent:<agent>`. */
  agent: string;
  runId: string;
  /** The person who started the run. */
  onBehalfOf: string;
  inputs: Record<string, unknown>;
  output: unknown;
  provider?: { id: string; model: string };
}

/** Optional optimistic-concurrency check: the engagement version the caller last saw. */
export interface MutationOptions {
  expectedVersion?: number;
}

/**
 * An agent acting for a run: recorded as `agent:<agent>`, on behalf of the person who started the run. The write is saved
 * only while the worker named `leaseOwner` still holds the run's lease.
 */
export interface AgentActing {
  runId: string;
  agent: string;
  startedBy: User;
  leaseOwner: string;
}

/** Agent writes always state the version they were built on. `rows` limits a Gap Writer redraft to those RCM rows. */
export interface AgentWriteOptions {
  expectedVersion: number;
  rows?: string[];
  /** A reviewer's or signer's feedback for a redraft. The module's model prompt carries it as data. */
  instruction?: string;
  /**
   * The run's metered model for this module (AgentModels.forModules()). Without one the module runs on its offline
   * rules: an agent's module run never falls back to the service's own provider, so no agent call escapes the budget.
   */
  llm?: LlmProvider | null;
}

export type TestPlanPatch = Partial<Pick<TestPlan, 'attribute' | 'population' | 'sampleSize' | 'selectionMethod' | 'evidenceToRequest' | 'procedure' | 'notTestedJustification'>>;

export type SignAction = 'review' | 'approve' | 'reject';

/** Proof that the signer re-authenticated for this exact content (plan 1C). */
export interface SignatureContext {
  /** Content hash captured when the signing request was made; the signature is refused if the finding changed since. */
  contentHash: string;
  reauthMethod: 'oidc' | 'dev';
  /** When the signer re-authenticated (ISO). */
  reauthAt: string;
  intentId: string;
}

/** Server-side signing with nobody to re-authenticate (seed data, tests). Recorded as not re-authenticated. */
export interface UnattendedSigning {
  unattended: 'seed' | 'test';
}

type Emit = (bundle: UnsealedBundle) => void;

export interface ServiceOptions {
  /** Defaults to STRICT_CITATIONS: unverified knowledge blocks release. */
  citationPolicy?: CitationPolicy;
}

/** Raised inside a mutation that turns out to change nothing, so its transaction ends without a save or trail entry. */
class NoChange {
  constructor(readonly finding: Finding) {}
}

export class AuditService {
  readonly grounding: Grounding;
  readonly citationPolicy: CitationPolicy;

  constructor(readonly db: Db, readonly registry: PackRegistry, readonly llm: LlmProvider | null, opts: ServiceOptions = {}) {
    this.citationPolicy = opts.citationPolicy ?? STRICT_CITATIONS;
    this.grounding = {
      clauses: new Bm25Index([...registry.clauses.values()].map((c) => ({ id: c.id, text: clauseText(c) }))),
      controls: new Bm25Index([...registry.controls.values()].map((c) => ({ id: c.id, text: controlText(c) }))),
    };
  }

  get providerInfo() {
    return this.llm ? { id: this.llm.id, model: this.llm.model } : { ...OFFLINE };
  }

  private require(user: User, roles: readonly Role[], what: string) {
    if (!roles.includes(user.role)) throw new AppError(403, `${user.role} may not ${what}`);
  }

  async engagement(id: string): Promise<Engagement> {
    const loaded = await loadEngagement(this.db.kysely, id);
    if (!loaded) throw new AppError(404, `Engagement ${id} not found`);
    return loaded.engagement;
  }

  /** The engagement for display: each sign-off checked against the append-only signatures table (broken / legacy). */
  async engagementWithSignatureStatus(id: string): Promise<Engagement> {
    const e = await this.engagement(id);
    return withSignatureStatus(e, await listSignatures(this.db.kysely, id), await lastRevisionTimes(this.db.kysely, id));
  }

  listEngagements(): Promise<EngagementSummary[]> {
    return listEngagements(this.db.kysely);
  }

  /**
   * One transaction per change: lock the engagement row, load it, apply `fn`,
   * save it with a version bump, then seal the trail bundles `fn` emitted.
   * Any failure rolls back the state and the trail together.
   */
  private async mutate<T>(
    engagementId: string,
    opts: MutationOptions,
    fn: (e: Engagement, emit: Emit, trx: Transaction<DB>) => Promise<T> | T,
  ): Promise<{ result: T; sealed: TrailBundle[] }> {
    return this.db.kysely.transaction().execute(async (trx) => {
      const loaded = await loadEngagement(trx, engagementId, { forUpdate: true });
      if (!loaded) throw new AppError(404, `Engagement ${engagementId} not found`);
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== loaded.version) {
        throw new AppError(
          409,
          `Engagement ${engagementId} is at version ${loaded.version}, not ${opts.expectedVersion}; reload and try again`,
          'VERSION_CONFLICT',
        );
      }
      const pending: UnsealedBundle[] = [];
      const result = await fn(loaded.engagement, (b) => pending.push(b), trx);
      await saveEngagement(trx, loaded);
      // Any change wakes the engagement's waiting agent run, in this same transaction (spec §6.2). This comes before the
      // trail lock, since a worker may hold the run row while it waits for that lock.
      await wakeWaitingRuns(trx, engagementId);
      const sealed: TrailBundle[] = [];
      for (const b of pending) sealed.push(await appendTrail(trx, b));
      return { result, sealed };
    });
  }

  async createEngagement(input: NewEngagement, actor: User): Promise<Engagement> {
    this.require(actor, PREPARER_ROLES, 'create engagements');
    if (!input.packIds.length) throw new AppError(400, 'Select at least one content pack');
    input.packIds.forEach((id) => {
      // The IIA pack holds the standards the judgments cite; it is never loaded into an engagement.
      if (id === METHODOLOGY_PACK_ID) throw new AppError(400, 'The IIA methodology pack is not an engagement pack');
      if (!this.registry.packs.has(id)) throw new AppError(400, `Unknown pack ${id}`);
    });
    const e: Engagement = {
      id: `ENG-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      ...input,
      createdBy: actor.id,
      createdAt: new Date().toISOString(),
      stage: 'planning',
      scope: [],
      rcm: [],
      testInputs: {},
      testResults: {},
      testPlans: {},
      findings: [],
      report: null,
      context: input.context ? { ...input.context, updatedBy: actor.id, updatedAt: new Date().toISOString() } : null,
      coverage: null,
      memos: {},
      tolerances: {},
      responses: {},
    };
    await this.db.kysely.transaction().execute(async (trx) => {
      await insertEngagement(trx, e);
      await appendTrail(trx, this.humanBundle(e, 'human:create-engagement', actor, input, { id: e.id }));
    });
    return e;
  }

  // ---------- Module orchestration ----------

  private moduleById(moduleId: string) {
    try {
      return getModule(moduleId);
    } catch {
      throw new AppError(404, `Unknown module ${moduleId}`);
    }
  }

  async runModule(engagementId: string, moduleId: string, actor: User, input: Record<string, unknown> = {}, opts: MutationOptions = {}) {
    this.require(actor, PREPARER_ROLES, 'run modules');
    const mod = this.moduleById(moduleId);
    const { result: engagement, sealed } = await this.mutate(engagementId, opts, async (e, emit, trx) => {
      const blocker = mod.precondition(e);
      if (blocker) throw new AppError(409, blocker);
      // Report Writer prints each signature with its status, which only the signatures table can tell, so it reads
      // an annotated copy. Its apply() only sets e.report and e.stage, so no annotation reaches the stored findings.
      // Other modules see the stored engagement: Gap Writer copies locked findings into its output.
      const view = mod.id === 'report' ? withSignatureStatus(e, await listSignatures(trx, e.id), await lastRevisionTimes(trx, e.id)) : e;
      const { output, bundle } = await this.executeModule(mod, view, actor, input);
      emit(structuredClone(bundle));
      mod.apply(e, output, bundle.id);
      // Whoever runs Gap Writer prepared the findings it drafted, so they may not sign them.
      for (const f of e.findings) if (f.bundleId === bundle.id) f.preparedBy = [actor.id];
      return e;
    });
    return { bundle: sealed[0], engagement };
  }

  /** Runs one module on `view` and builds its trail bundle. Work done for an agent run is recorded as the agent's. */
  private async executeModule(mod: AuditModule<unknown>, view: Engagement, actor: User, input: Record<string, unknown>, acting?: AgentActing, llm: LlmProvider | null = this.llm) {
    const startedAt = new Date().toISOString();
    const ctx = new ModuleContext(view, this.registry, this.grounding, llm, actor, input, this.citationPolicy);
    ctx.step('start', `${mod.name} v${mod.version} on ${view.id}`);
    const output = await mod.run(ctx);
    ctx.step('end', `${ctx.qa.filter((q) => q.outcome === 'fail').length} gate failure(s), ${ctx.qa.filter((q) => q.outcome === 'warn').length} warning(s)`);
    const bundle: UnsealedBundle = {
      id: `RUN-${crypto.randomBytes(4).toString('hex')}`,
      engagementId: view.id,
      moduleId: mod.id,
      moduleVersion: mod.version,
      engineVersion: ENGINE_VERSION,
      packVersions: this.registry.versions(view.packIds),
      provider: llm ? { id: llm.id, model: ctx.servedModel ?? llm.model } : { ...OFFLINE },
      promptHash: ctx.promptHash,
      actor: acting ? `agent:${acting.agent}` : actor.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      inputs: acting ? { moduleInput: input, stage: view.stage, runId: acting.runId, onBehalfOf: actor.id } : { moduleInput: input, stage: view.stage },
      retrievalSet: ctx.retrievalSet,
      executionLog: ctx.log,
      qaActions: ctx.qa,
      output,
    };
    return { output, bundle };
  }

  /**
   * A specialist's module run for an agent (spec §2): the module, and any model call it makes, runs on an unlocked
   * snapshot, and its result is applied only if nobody changed the engagement meanwhile. Redrafts keep people's decisions
   * (rails.ts), and the rails are checked before anything is saved.
   */
  async runModuleAsAgent(engagementId: string, moduleId: string, acting: AgentActing, opts: AgentWriteOptions) {
    this.require(acting.startedBy, PREPARER_ROLES, 'prepare audit work');
    const mod = this.moduleById(moduleId);
    const loaded = await loadEngagement(this.db.kysely, engagementId);
    if (!loaded) throw new AppError(404, `Engagement ${engagementId} not found`);
    if (loaded.version !== opts.expectedVersion) {
      throw new AppError(409, `Engagement ${engagementId} is at version ${loaded.version}, not ${opts.expectedVersion}; reload and try again`, 'VERSION_CONFLICT');
    }
    const blocker = mod.precondition(loaded.engagement);
    if (blocker) throw new AppError(409, blocker);
    const snapshot = loaded.engagement;
    const view = mod.id === 'report'
      ? withSignatureStatus(snapshot, await listSignatures(this.db.kysely, engagementId), await lastRevisionTimes(this.db.kysely, engagementId))
      : snapshot;
    // keepDecisions: the scope module pins the in/out decisions people made (decidedBy) before it builds coverage and the memo.
    const input = { keepDecisions: true, ...(opts.rows ? { rows: opts.rows } : {}), ...(opts.instruction ? { reworkInstruction: opts.instruction } : {}) };
    const { output, bundle } = await this.executeModule(mod, view, acting.startedBy, input, acting, opts.llm ?? null);
    const { result: engagement, sealed } = await this.mutate(engagementId, { expectedVersion: loaded.version }, async (e, emit, trx) => {
      // Lock order is engagement (taken by mutate), then run: a worker that lost the run, or a cancelled run, saves nothing.
      await assertLease(trx, acting.runId, acting.leaseOwner);
      const before = structuredClone(e);
      emit(structuredClone(bundle));
      mod.apply(e, output, bundle.id);
      if (mod.id === 'scope' && before.scope.length) keepScopeDecisions(before.scope, e.scope);
      if (mod.id === 'gaps' && opts.rows) e.findings = mergeFindings(before.findings, e.findings, opts.rows, e.rcm.map((r) => r.id));
      // The person who started the run is the accountable preparer of what the agent drafted, so they may not sign it.
      for (const f of e.findings) if (f.bundleId === bundle.id) f.preparedBy = [acting.startedBy.id];
      assertWithinRails(before, e);
      return e;
    });
    return { bundle: sealed[0], engagement };
  }

  /** Saves drafted test plans for an agent. The agent never sets or clears a reason not to test a row. */
  async saveTestPlansAsAgent(engagementId: string, plans: Record<string, TestPlan>, acting: AgentActing, opts: AgentWriteOptions, memo?: JudgmentMemo) {
    this.require(acting.startedBy, PREPARER_ROLES, 'prepare audit work');
    const { result: engagement, sealed } = await this.mutate(engagementId, { expectedVersion: opts.expectedVersion }, async (e, emit, trx) => {
      await assertLease(trx, acting.runId, acting.leaseOwner);
      assertJustificationsUnchanged(e.testPlans, plans, e.rcm.map((r) => r.id));
      assertPlanAttribution(e.testPlans, plans);
      e.testPlans = plans;
      if (memo) {
        const before = e.memos?.test_plans;
        e.memos = { ...e.memos, test_plans: sameMemo(before, memo) ? before : memo };
      }
      emit(this.agentBundle(e, {
        moduleId: 'agent:test-plans', agent: acting.agent, runId: acting.runId, onBehalfOf: acting.startedBy.id,
        inputs: { rows: Object.keys(plans) }, output: plans,
      }));
      return e;
    });
    return { bundle: sealed[0], engagement };
  }

  /** A person edits one row's test plan, including the decision not to test it (an empty reason clears that decision). */
  async editTestPlan(engagementId: string, rowId: string, patch: TestPlanPatch, actor: User, opts: MutationOptions = {}): Promise<TestPlan> {
    this.require(actor, PREPARER_ROLES, 'edit test plans');
    const { result } = await this.mutate(engagementId, opts, (e, emit) => {
      if (!e.rcm.some((r) => r.id === rowId)) throw new AppError(404, `RCM row ${rowId} not found`);
      const current = e.testPlans[rowId];
      if (!current) throw new AppError(404, `There is no test plan for ${rowId} yet`);
      const next: TestPlan = { ...current, ...patch, editedBy: actor.id, editedAt: new Date().toISOString() };
      if (!next.notTestedJustification?.trim()) delete next.notTestedJustification;
      e.testPlans = { ...e.testPlans, [rowId]: next };
      emit(this.humanBundle(e, 'human:test-plan-edit', actor, { rowId, patch }, next));
      return next;
    });
    return result;
  }

  // ---------- Human steps (also written to the trail) ----------

  async setScope(engagementId: string, items: { controlId: string; included: boolean }[], actor: User, opts: MutationOptions = {}) {
    this.require(actor, PREPARER_ROLES, 'change scope');
    const { result } = await this.mutate(engagementId, opts, (e, emit) => {
      let changed = false;
      for (const it of items) {
        const s = e.scope.find((x) => x.controlId === it.controlId);
        if (!s) throw new AppError(400, `Control ${it.controlId} is not a scope candidate`);
        // The screen sends every item; only a flag that moves is this person's decision, and a redraft keeps it.
        if (s.included === it.included) continue;
        s.included = it.included;
        s.decidedBy = actor.id;
        changed = true;
      }
      // The coverage and the memo are inside the hash the signer approves, so they must describe the edited scope.
      if (changed && e.coverage) {
        const candidates = e.scope.map((s) => ({ controlId: s.controlId, processArea: s.processArea, inherentRisk: s.inherentRisk, assessedRisk: s.assessedRisk, relevance: s.relevance }));
        e.coverage = recomputedCoverage(candidates, new Set(e.scope.filter((s) => s.included).map((s) => s.controlId)), e.scopeStatement, e.coverage);
      }
      if (changed && e.memos?.scope) e.memos = { ...e.memos, scope: markEditedByHand(e.memos.scope) };
      emit(this.humanBundle(e, 'human:scope-decision', actor, items, { included: e.scope.filter((s) => s.included).map((s) => s.controlId) }));
      return e;
    });
    return result;
  }

  /**
   * Set the engagement context (spec §3.1). It feeds the scope's risk assessment, so it is locked once the RCM gate is
   * approved: after that, late matters belong in the relevant finding or a new engagement.
   */
  async setEngagementContext(engagementId: string, input: EngagementContextInput, actor: User, opts: MutationOptions = {}) {
    this.require(actor, PREPARER_ROLES, 'set the engagement context');
    const { result } = await this.mutate(engagementId, opts, async (e, emit, trx) => {
      if (await hasApprovedGate(trx, engagementId, 'rcm')) {
        throw new AppError(409, 'The scope and RCM are approved; record late matters in the relevant finding, or start a new engagement', 'CONTEXT_LOCKED');
      }
      e.context = { ...input, updatedBy: actor.id, updatedAt: new Date().toISOString() };
      emit(this.humanBundle(e, 'human:set-context', actor, input, { factors: input.factors.length, background: input.background.length }));
      return e;
    });
    return result;
  }

  async recordTest(engagementId: string, rowId: string, input: Omit<TestInput, 'updatedBy' | 'updatedAt'>, actor: User, opts: MutationOptions = {}) {
    this.require(actor, PREPARER_ROLES, 'record test work');
    if (input.exceptions > input.sampleTested) throw new AppError(400, 'Exceptions cannot exceed the sample tested');
    const { result } = await this.mutate(engagementId, opts, (e, emit) => {
      if (!e.rcm.some((r) => r.id === rowId)) throw new AppError(404, `RCM row ${rowId} not found`);
      const record: TestInput = { ...input, updatedBy: actor.id, updatedAt: new Date().toISOString() };
      e.testInputs[rowId] = record;
      delete e.testResults[rowId];
      emit(this.humanBundle(e, 'human:test-record', actor, { rowId, ...input }, record));
      return e;
    });
    return result;
  }

  /** A person sets the tolerance for a control (spec §3.3). It is locked once the control has a recorded test. */
  async setTolerance(engagementId: string, controlId: string, rate: number, actor: User, opts: MutationOptions = {}): Promise<Engagement> {
    this.require(actor, PREPARER_ROLES, 'set a tolerance');
    if (!Number.isFinite(rate) || rate < 0 || rate > TOLERANCE_MAX) throw new AppError(400, `A tolerance must be between 0 and ${TOLERANCE_MAX}`);
    const { result } = await this.mutate(engagementId, opts, async (e, emit, trx) => {
      const rows = e.rcm.filter((r) => r.controlId === controlId);
      if (!rows.length) throw new AppError(404, `No RCM row for control ${controlId}`);
      if (rows.some((r) => e.testInputs[r.id])) throw new AppError(409, `Control ${controlId} already has a recorded test, so its tolerance can no longer change`, 'TOLERANCE_LOCKED');
      const recordedAt = new Date().toISOString();
      const bundle = this.humanBundle(e, 'human:set-tolerance', actor, { controlId, rate }, { controlId, rate });
      const record = { controlId, rate, recordedBy: actor.id, recordedAt, trailBundleId: bundle.id };
      await insertTolerance(trx, engagementId, { id: crypto.randomUUID(), ...record });
      e.tolerances = { ...e.tolerances, [controlId]: record };
      emit(bundle);
      return e;
    });
    return result;
  }

  async editFinding(
    engagementId: string,
    findingId: string,
    patch: Partial<Pick<Finding, 'title' | 'rating' | 'condition' | 'criteria' | 'cause' | 'effect' | 'recommendation' | 'evidenceRefs'>>,
    actor: User,
    opts: MutationOptions = {},
  ) {
    this.require(actor, PREPARER_ROLES, 'edit findings');
    try {
      return await this.applyFindingEdit(engagementId, findingId, patch, actor, opts);
    } catch (err) {
      if (err instanceof NoChange) return err.finding;
      throw err;
    }
  }

  private async applyFindingEdit(
    engagementId: string,
    findingId: string,
    patch: Partial<Pick<Finding, 'title' | 'rating' | 'condition' | 'criteria' | 'cause' | 'effect' | 'recommendation' | 'evidenceRefs'>>,
    actor: User,
    opts: MutationOptions,
  ) {
    const { result } = await this.mutate(engagementId, opts, (e, emit) => {
      const idx = e.findings.findIndex((f) => f.id === findingId);
      if (idx < 0) throw new AppError(404, `Finding ${findingId} not found`);
      if (e.findings[idx].status === 'approved') throw new AppError(409, 'Approved findings are locked', 'FINDING_LOCKED');

      const previous = e.findings[idx];
      // A save that leaves the content as it was is not an edit: status, sign-offs and preparers stay, and nothing is
      // written (throwing rolls back this transaction, which has written nothing yet).
      if (findingContentHash({ ...previous, ...patch }) === findingContentHash(previous)) throw new NoChange(previous);

      const allowed = new Set(this.registry.clausesFor(e.packIds).map((c) => c.id));
      const preparedBy = [...new Set([...(previous.preparedBy ?? []), actor.id])];
      const edited: Finding = { ...previous, ...patch, status: 'draft', signOffs: [], preparedBy };
      const { finding, actions } = findingCitationGate(this.registry, edited, allowed, this.citationPolicy);
      e.findings[idx] = finding;
      emit(this.humanBundle(e, 'human:finding-edit', actor, { findingId, patch }, { status: finding.status }, actions));
      return finding;
    });
    return result;
  }

  /** Who may sign what, and what signing does. The same checks guard the signing request and the signature itself. */
  private signOffGuard(f: Finding, action: SignAction, actor: User): { meaning: SignOff['meaning']; status: Finding['status']; trust: QaAction[] } {
    if (f.status === 'blocked') throw new AppError(409, `Finding is blocked by QA gates: ${f.blockedReasons.join('; ')}`, 'FINDING_BLOCKED');
    const preparedBy = f.preparedBy ?? [];
    if (action === 'review') {
      this.require(actor, REVIEWER_ROLES, 'review findings');
      if (f.status !== 'draft') throw new AppError(409, `Only draft findings can be reviewed (status ${f.status})`);
      if (preparedBy.includes(actor.id)) throw new AppError(403, 'You prepared this finding, so someone else must review it', 'SOD_VIOLATION');
      return { meaning: 'Reviewed', status: 'reviewed', trust: [] };
    }
    this.require(actor, APPROVER_ROLES, `${action} findings`);
    if (f.status !== 'reviewed') throw new AppError(409, 'Finding must be reviewed before approval or rejection');
    if (preparedBy.includes(actor.id)) throw new AppError(403, 'You prepared this finding, so someone else must approve it', 'SOD_VIOLATION');
    if (f.signOffs.some((s) => s.userId === actor.id)) throw new AppError(403, 'Approver must differ from reviewer', 'SOD_VIOLATION');
    if (action === 'reject') return { meaning: 'Rejected', status: 'rejected', trust: [] };
    // Approval is the release (REQ-22): trust is checked again against today's library and policy.
    const trust = this.approvalTrust(f);
    const blocked = trust.filter((a) => a.action === 'blocked');
    if (blocked.length) throw new AppError(409, `Finding is blocked by QA gates: ${blocked.map((a) => a.detail).join('; ')}`, 'FINDING_BLOCKED');
    return { meaning: 'Approved', status: 'approved', trust };
  }

  /** Trust gate actions for a finding's clauses and control; a concept no longer in the library counts as unverified. */
  private approvalTrust(f: Finding): QaAction[] {
    const clauseIds = f.citations.map((c) => c.clauseId);
    const current = {
      clauses: new Map(clauseIds.map((id) => [id, this.registry.clauses.get(id) ?? { id }])),
      controls: new Map([[f.controlId, this.registry.controls.get(f.controlId) ?? { id: f.controlId }]]),
    } as unknown as PackRegistry;
    return trustActions(current, f.id, { clauseIds, controlId: f.controlId }, this.citationPolicy);
  }

  /** Checks a signature would be allowed, before the signer is asked to re-authenticate; returns the content to bind. */
  async checkSignOff(engagementId: string, findingId: string, action: SignAction, actor: User): Promise<{ contentHash: string }> {
    const e = await this.engagement(engagementId);
    const f = e.findings.find((x) => x.id === findingId);
    if (!f) throw new AppError(404, `Finding ${findingId} not found`);
    this.signOffGuard(f, action, actor);
    return { contentHash: findingContentHash(f) };
  }

  /**
   * Signs a finding. `signature` is required: proof of re-authentication from a signing request, or an explicit
   * unattended marker for seed data and tests. Anything else fails closed (428 REAUTH_REQUIRED).
   */
  async signOff(
    engagementId: string, findingId: string, action: SignAction, comment: string, actor: User,
    opts: MutationOptions, signature: SignatureContext | UnattendedSigning,
  ) {
    const { unattended, reauthed } = this.signatureProof(signature);
    const { result } = await this.mutate(engagementId, opts, async (e, emit, trx) => {
      const f = e.findings.find((x) => x.id === findingId);
      if (!f) throw new AppError(404, `Finding ${findingId} not found`);
      const contentHash = findingContentHash(f);
      if (reauthed && reauthed.contentHash !== contentHash) {
        throw new AppError(409, 'The finding changed after you started signing; review it again, then sign', 'CONTENT_CHANGED');
      }
      const { meaning, status, trust } = this.signOffGuard(f, action, actor);
      f.status = status;

      // Signature manifestation (§11.50) bound to the signed content (§11.70).
      const at = new Date().toISOString();
      const reauth: NonNullable<SignOff['reauth']> = reauthed ? { method: reauthed.reauthMethod, at: reauthed.reauthAt } : { method: 'none', at: null };
      const sig: SignOff = {
        userId: actor.id, userName: actor.name, role: actor.role, meaning, comment, at,
        signatureId: `SIG-${crypto.randomBytes(6).toString('hex')}`, contentHash, reauth,
      };
      f.signOffs.push(sig);
      const bundle = this.humanBundle(e, 'human:sign-off', actor, { findingId, action, comment, intentId: reauthed?.intentId ?? null, ...(unattended ? { unattended } : {}) }, sig, trust);
      emit(bundle);
      await insertSignature(trx, {
        id: sig.signatureId!, engagementId: e.id, findingId, subjectKind: 'finding', workpaper: null, gateId: null, userId: actor.id, userName: actor.name, role: actor.role, meaning, comment,
        contentHash, reauthMethod: reauth.method, reauthAt: reauth.at, intentId: reauthed?.intentId ?? null, trailBundleId: bundle.id, signedAt: at,
      });
      // An approval or rejection decides the finding's gate, if the agent opened one; a review leaves it open.
      if (meaning !== 'Reviewed') {
        await closeFindingGate(trx, e.id, findingId, contentHash, meaning === 'Approved' ? 'approved' : 'rejected', sig.signatureId!, comment);
      }
      // The signing request is marked signed in this same transaction, so it is never left 'claimed' after a signature commits.
      // A request this attempt does not hold (pending, failed, signed or unknown) rolls back the whole signature.
      if (reauthed && !(await finishIntent(trx, reauthed.intentId, { status: 'signed' }, ['claimed']))) {
        throw new AppError(409, 'This signing request is no longer valid', 'INTENT_EXPIRED');
      }
      return f;
    });
    return result;
  }

  /** The proof a signature needs: re-authentication for this exact content, or an explicit unattended marker. Anything else fails closed. */
  private signatureProof(signature: SignatureContext | UnattendedSigning) {
    const unattended = signature && 'unattended' in signature && (signature.unattended === 'seed' || signature.unattended === 'test') ? signature.unattended : null;
    const reauthed = signature && !unattended && 'contentHash' in signature && signature.intentId ? (signature as SignatureContext) : null;
    if (!unattended && !reauthed) {
      throw new AppError(428, 'Signing needs re-authentication: start a signing request instead', 'REAUTH_REQUIRED');
    }
    return { unattended, reauthed };
  }

  /** Who may sign a scope, RCM or report gate, and whether its workpaper is still what the gate showed (agent spec §4.3, §4.4). */
  private async gateGuard(db: Executor, gate: Gate, e: Engagement, actor: User): Promise<{ workpaper: SignableWorkpaper; contentHash: string }> {
    if (gate.kind === 'finding') throw new AppError(409, "A finding gate closes with the finding's own review and approval signatures");
    if (gate.state !== 'open') throw new AppError(409, `This gate is already ${gate.state}`);
    const workpaper: SignableWorkpaper = gate.kind;
    this.require(actor, workpaper === 'report' ? APPROVER_ROLES : REVIEWER_ROLES, `sign ${workpaper} gates`);
    const run = await getRun(db, gate.runId);
    if (!run) throw new AppError(409, 'The agent run for this gate no longer exists', 'RUN_NOT_ACTIVE');
    if (isTerminal(run.status)) throw new AppError(409, `The agent run for this gate has ended (${run.status}), so it can no longer be signed`, 'RUN_NOT_ACTIVE');
    if (run.startedBy === actor.id) throw new AppError(403, 'You started this agent run, so someone else must sign its gates', 'SOD_VIOLATION');
    const contentHash = workpaperContentHash(workpaper, e);
    if (contentHash !== gate.subjectHash) {
      throw new AppError(409, 'The workpaper changed after this gate opened; the agent will review it again before asking for a signature', 'GATE_STALE');
    }
    return { workpaper, contentHash };
  }

  /**
   * Checks a gate could be signed by this person now, before they are asked to re-authenticate. Returns the content to
   * bind, and the gate's QA report for the signer to read (agent spec REQ-30).
   */
  async checkGateSignOff(gateId: string, actor: User): Promise<{ engagementId: string; workpaper: SignableWorkpaper; contentHash: string; qaReport: Gate['qaReport'] }> {
    const gate = await getGate(this.db.kysely, gateId);
    if (!gate) throw new AppError(404, `Gate ${gateId} not found`);
    const e = await this.engagement(gate.engagementId);
    return { engagementId: e.id, ...(await this.gateGuard(this.db.kysely, gate, e, actor)), qaReport: gate.qaReport };
  }

  /**
   * Signs a scope, RCM or report gate (Part 11, like a finding signature): the signature is bound to the workpaper's
   * content hash, recorded in the signatures table and the trail, and closes the gate; the run waiting on it wakes.
   */
  async signGate(gateId: string, action: 'approve' | 'reject', comment: string, actor: User, signature: SignatureContext | UnattendedSigning): Promise<Gate> {
    const { unattended, reauthed } = this.signatureProof(signature);
    if (action === 'reject' && !comment.trim()) throw new AppError(400, 'Say why you are rejecting this workpaper: the agent redrafts it from your comment');
    return this.db.kysely.transaction().execute(async (trx) => {
      // Lock order is engagement, then gate (as in mutate): learn the engagement from an unlocked read first.
      const unlocked = await getGate(trx, gateId);
      if (!unlocked) throw new AppError(404, `Gate ${gateId} not found`);
      const loaded = await loadEngagement(trx, unlocked.engagementId, { forUpdate: true });
      if (!loaded) throw new AppError(404, `Engagement ${unlocked.engagementId} not found`);
      const gate = await getGate(trx, gateId, { forUpdate: true });
      if (!gate) throw new AppError(404, `Gate ${gateId} not found`);
      const e = loaded.engagement;
      const { workpaper, contentHash } = await this.gateGuard(trx, gate, e, actor);
      if (reauthed && reauthed.contentHash !== contentHash) {
        throw new AppError(409, 'The workpaper changed after you started signing; review it again, then sign', 'CONTENT_CHANGED');
      }
      // The signed content must be in the workpaper's history (verify checks it); this is a no-op when it already is.
      await recordWorkpaperRevisions(trx, e);
      // Wake the run before taking the trail lock: a worker may hold the run row while it waits for that lock.
      await wakeWaitingRuns(trx, e.id);
      const meaning = action === 'approve' ? 'Approved' : 'Rejected';
      const at = new Date().toISOString();
      const reauth: NonNullable<SignOff['reauth']> = reauthed ? { method: reauthed.reauthMethod, at: reauthed.reauthAt } : { method: 'none', at: null };
      const signatureId = `SIG-${crypto.randomBytes(6).toString('hex')}`;
      const output = { signatureId, gateId, kind: workpaper, meaning, contentHash, userId: actor.id, userName: actor.name, role: actor.role, at, reauth, comment };
      const inputs = { gateId, kind: workpaper, action, comment, intentId: reauthed?.intentId ?? null, ...(unattended ? { unattended } : {}) };
      const bundle = await appendTrail(trx, this.humanBundle(e, 'human:gate-sign', actor, inputs, output));
      await insertSignature(trx, {
        id: signatureId, engagementId: e.id, findingId: null, subjectKind: 'workpaper', workpaper, gateId, userId: actor.id, userName: actor.name,
        role: actor.role, meaning, comment, contentHash, reauthMethod: reauth.method, reauthAt: reauth.at, intentId: reauthed?.intentId ?? null,
        trailBundleId: bundle.id, signedAt: at,
      });
      if (reauthed && !(await finishIntent(trx, reauthed.intentId, { status: 'signed' }, ['claimed']))) {
        throw new AppError(409, 'This signing request is no longer valid', 'INTENT_EXPIRED');
      }
      return closeGate(trx, gateId, action === 'approve' ? 'approved' : 'rejected', signatureId, comment);
    });
  }

  // ---------- Trail ----------

  /** A trail bundle for a person's action on the engagement. */
  humanBundle(e: Engagement, moduleId: string, actor: User, inputs: unknown, output: unknown, qaActions: QaAction[] = []): UnsealedBundle {
    const now = new Date().toISOString();
    return {
      id: `HUM-${crypto.randomBytes(4).toString('hex')}`,
      engagementId: e.id,
      moduleId,
      moduleVersion: ENGINE_VERSION,
      engineVersion: ENGINE_VERSION,
      packVersions: this.registry.versions(e.packIds),
      provider: { id: 'human', model: actor.id },
      promptHash: null,
      actor: actor.id,
      startedAt: now,
      finishedAt: now,
      inputs,
      retrievalSet: [],
      executionLog: [{ at: now, step: moduleId, detail: `${actor.name} (${actor.role})` }],
      qaActions,
      output,
    };
  }

  /** A trail bundle for an agent's action (agent spec §3.3): the agent is the actor, on behalf of whoever started the run. */
  agentBundle(e: Engagement, a: AgentEvent): UnsealedBundle {
    const now = new Date().toISOString();
    return {
      id: `AGT-${crypto.randomBytes(4).toString('hex')}`,
      engagementId: e.id,
      moduleId: a.moduleId,
      moduleVersion: ENGINE_VERSION,
      engineVersion: ENGINE_VERSION,
      packVersions: this.registry.versions(e.packIds),
      provider: a.provider ?? { id: 'agent', model: a.agent },
      promptHash: null,
      actor: `agent:${a.agent}`,
      startedAt: now,
      finishedAt: now,
      inputs: { ...a.inputs, runId: a.runId, onBehalfOf: a.onBehalfOf },
      retrievalSet: [],
      executionLog: [{ at: now, step: a.moduleId, detail: `${a.agent} for run ${a.runId}` }],
      qaActions: [],
      output: a.output,
    };
  }

  trailFor(engagementId: string): Promise<TrailBundle[]> {
    return readTrail(this.db.kysely, engagementId);
  }

  async verifyTrail() {
    return verifyChain(await readTrail(this.db.kysely));
  }

  modules() {
    return MODULES.map((m) => ({ id: m.id, name: m.name, version: m.version, description: m.description }));
  }

  // ---------- Evaluation runs ----------

  saveEvalRun(r: EvalReport) {
    return saveEvalRun(this.db.kysely, r);
  }
  listEvalRuns() {
    return listEvalRuns(this.db.kysely);
  }
  getEvalRun(id: string) {
    return getEvalRun(this.db.kysely, id);
  }
  latestEvalRun() {
    return latestEvalRun(this.db.kysely);
  }

  /** Flat export for write-back into the client's QMS / GRC system of record. */
  async findingsCsv(engagementId: string): Promise<string> {
    const e = await this.engagementWithSignatureStatus(engagementId);
    const cols = ['id', 'status', 'rating', 'controlId', 'title', 'condition', 'criteria', 'cause', 'effect', 'recommendation', 'citations', 'evidenceRefs', 'signatures', 'signature_issues', 'bundleId'];
    // Every sign-off: meaning|name|role|time|re-authentication method|signature id|valid, broken or legacy.
    // A legacy sign-off (no signature record) is never shown as re-authenticated.
    const signature = (s: SignOff) => {
      const state = signatureState(s);
      return [s.meaning, s.userName, s.role, s.at, state === 'legacy' ? 'none' : (s.reauth?.method ?? 'none'), s.signatureId ?? '', state].join('|');
    };
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = e.findings.map((f) =>
      [
        f.id, f.status, f.rating, f.controlId, f.title, f.condition, f.criteria, f.cause, f.effect, f.recommendation,
        f.citations.map((c) => `${c.regulation} ${c.ref}`).join('; '),
        f.evidenceRefs.join('; '),
        f.signOffs.map(signature).join('; '),
        (f.signatureIssues ?? []).join('; '),
        f.bundleId,
      ].map((v) => esc(String(v))).join(','),
    );
    return [cols.join(','), ...rows].join('\n');
  }
}
