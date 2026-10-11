import crypto from 'node:crypto';
import type { Transaction } from 'kysely';
import { APPROVER_ROLES, PREPARER_ROLES, REVIEWER_ROLES } from './auth/roles';
import type { Db } from './db';
import type { DB } from './db/schema';
import { insertSignature } from './db/signature-repo';
import { findingContentHash } from './signing/content-hash';
import {
  insertEngagement, listEngagements, loadEngagement, saveEngagement, type EngagementSummary,
} from './db/engagement-repo';
import { getEvalRun, latestEvalRun, listEvalRuns, saveEvalRun } from './db/eval-repo';
import { appendTrail, readTrail, type UnsealedBundle } from './db/trail-repo';
import { Bm25Index, clauseText, controlText } from './engine/grounding';
import type { LlmProvider } from './engine/llm/provider';
import { OFFLINE } from './engine/llm/router';
import { ModuleContext, type Grounding } from './engine/module';
import { getModule, MODULES } from './engine/modules';
import type { PackRegistry } from './engine/packs';
import { findingCitationGate } from './engine/qa';
import { verifyChain } from './engine/trail';
import type { Engagement, Finding, QaAction, Role, SignOff, TestInput, TrailBundle, User } from './engine/types';
import { AppError } from './errors';
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
}

/** Optional optimistic-concurrency check: the engagement version the caller last saw. */
export interface MutationOptions {
  expectedVersion?: number;
}

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

type Emit = (bundle: UnsealedBundle) => void;

export class AuditService {
  readonly grounding: Grounding;

  constructor(readonly db: Db, readonly registry: PackRegistry, readonly llm: LlmProvider | null) {
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
      const sealed: TrailBundle[] = [];
      for (const b of pending) sealed.push(await appendTrail(trx, b));
      return { result, sealed };
    });
  }

  async createEngagement(input: NewEngagement, actor: User): Promise<Engagement> {
    this.require(actor, PREPARER_ROLES, 'create engagements');
    if (!input.packIds.length) throw new AppError(400, 'Select at least one content pack');
    input.packIds.forEach((id) => {
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
      findings: [],
      report: null,
    };
    await this.db.kysely.transaction().execute(async (trx) => {
      await insertEngagement(trx, e);
      await appendTrail(trx, this.humanBundle(e, 'human:create-engagement', actor, input, { id: e.id }));
    });
    return e;
  }

  // ---------- Module orchestration ----------

  async runModule(engagementId: string, moduleId: string, actor: User, input: Record<string, unknown> = {}, opts: MutationOptions = {}) {
    this.require(actor, PREPARER_ROLES, 'run modules');
    const mod = (() => {
      try {
        return getModule(moduleId);
      } catch {
        throw new AppError(404, `Unknown module ${moduleId}`);
      }
    })();

    const { result: engagement, sealed } = await this.mutate(engagementId, opts, async (e, emit) => {
      const blocker = mod.precondition(e);
      if (blocker) throw new AppError(409, blocker);

      const startedAt = new Date().toISOString();
      const ctx = new ModuleContext(e, this.registry, this.grounding, this.llm, actor, input);
      ctx.step('start', `${mod.name} v${mod.version} on ${e.id}`);
      const output = await mod.run(ctx);
      ctx.step('end', `${ctx.qa.filter((q) => q.outcome === 'fail').length} gate failure(s), ${ctx.qa.filter((q) => q.outcome === 'warn').length} warning(s)`);

      const bundle: UnsealedBundle = {
        id: `RUN-${crypto.randomBytes(4).toString('hex')}`,
        engagementId: e.id,
        moduleId: mod.id,
        moduleVersion: mod.version,
        engineVersion: ENGINE_VERSION,
        packVersions: this.registry.versions(e.packIds),
        provider: this.llm ? { id: this.llm.id, model: ctx.servedModel ?? this.llm.model } : { ...OFFLINE },
        promptHash: ctx.promptHash,
        actor: actor.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        inputs: { moduleInput: input, stage: e.stage },
        retrievalSet: ctx.retrievalSet,
        executionLog: ctx.log,
        qaActions: ctx.qa,
        output,
      };
      emit(structuredClone(bundle));
      mod.apply(e, output, bundle.id);
      // Whoever runs Gap Writer prepared the findings it drafted, so they may not sign them.
      for (const f of e.findings) if (f.bundleId === bundle.id) f.preparedBy = [actor.id];
      return e;
    });
    return { bundle: sealed[0], engagement };
  }

  // ---------- Human steps (also written to the trail) ----------

  async setScope(engagementId: string, items: { controlId: string; included: boolean }[], actor: User, opts: MutationOptions = {}) {
    this.require(actor, PREPARER_ROLES, 'change scope');
    const { result } = await this.mutate(engagementId, opts, (e, emit) => {
      for (const it of items) {
        const s = e.scope.find((x) => x.controlId === it.controlId);
        if (!s) throw new AppError(400, `Control ${it.controlId} is not a scope candidate`);
        s.included = it.included;
      }
      emit(this.humanBundle(e, 'human:scope-decision', actor, items, { included: e.scope.filter((s) => s.included).map((s) => s.controlId) }));
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

  async editFinding(
    engagementId: string,
    findingId: string,
    patch: Partial<Pick<Finding, 'title' | 'rating' | 'condition' | 'criteria' | 'cause' | 'effect' | 'recommendation' | 'evidenceRefs'>>,
    actor: User,
    opts: MutationOptions = {},
  ) {
    this.require(actor, PREPARER_ROLES, 'edit findings');
    const { result } = await this.mutate(engagementId, opts, (e, emit) => {
      const idx = e.findings.findIndex((f) => f.id === findingId);
      if (idx < 0) throw new AppError(404, `Finding ${findingId} not found`);
      if (e.findings[idx].status === 'approved') throw new AppError(409, 'Approved findings are locked', 'FINDING_LOCKED');

      const allowed = new Set(this.registry.clausesFor(e.packIds).map((c) => c.id));
      const previous = e.findings[idx];
      const preparedBy = [...new Set([...(previous.preparedBy ?? []), actor.id])];
      const edited: Finding = { ...previous, ...patch, status: 'draft', signOffs: [], preparedBy };
      const { finding, actions } = findingCitationGate(this.registry, edited, allowed);
      e.findings[idx] = finding;
      emit(this.humanBundle(e, 'human:finding-edit', actor, { findingId, patch }, { status: finding.status }, actions));
      return finding;
    });
    return result;
  }

  /** Who may sign what, and what signing does. The same checks guard the signing request and the signature itself. */
  private signOffGuard(f: Finding, action: SignAction, actor: User): { meaning: SignOff['meaning']; status: Finding['status'] } {
    if (f.status === 'blocked') throw new AppError(409, `Finding is blocked by QA gates: ${f.blockedReasons.join('; ')}`, 'FINDING_BLOCKED');
    const preparedBy = f.preparedBy ?? [];
    if (action === 'review') {
      this.require(actor, REVIEWER_ROLES, 'review findings');
      if (f.status !== 'draft') throw new AppError(409, `Only draft findings can be reviewed (status ${f.status})`);
      if (preparedBy.includes(actor.id)) throw new AppError(403, 'You prepared this finding, so someone else must review it', 'SOD_VIOLATION');
      return { meaning: 'Reviewed', status: 'reviewed' };
    }
    this.require(actor, APPROVER_ROLES, `${action} findings`);
    if (f.status !== 'reviewed') throw new AppError(409, 'Finding must be reviewed before approval or rejection');
    if (preparedBy.includes(actor.id)) throw new AppError(403, 'You prepared this finding, so someone else must approve it', 'SOD_VIOLATION');
    if (f.signOffs.some((s) => s.userId === actor.id)) throw new AppError(403, 'Approver must differ from reviewer', 'SOD_VIOLATION');
    return action === 'approve' ? { meaning: 'Approved', status: 'approved' } : { meaning: 'Rejected', status: 'rejected' };
  }

  /** Checks a signature would be allowed, before the signer is asked to re-authenticate; returns the content to bind. */
  async checkSignOff(engagementId: string, findingId: string, action: SignAction, actor: User): Promise<{ contentHash: string }> {
    const e = await this.engagement(engagementId);
    const f = e.findings.find((x) => x.id === findingId);
    if (!f) throw new AppError(404, `Finding ${findingId} not found`);
    this.signOffGuard(f, action, actor);
    return { contentHash: findingContentHash(f) };
  }

  async signOff(
    engagementId: string, findingId: string, action: SignAction, comment: string, actor: User,
    opts: MutationOptions = {}, signature?: SignatureContext,
  ) {
    const { result } = await this.mutate(engagementId, opts, async (e, emit, trx) => {
      const f = e.findings.find((x) => x.id === findingId);
      if (!f) throw new AppError(404, `Finding ${findingId} not found`);
      const contentHash = findingContentHash(f);
      if (signature && signature.contentHash !== contentHash) {
        throw new AppError(409, 'The finding changed after you started signing; review it again, then sign', 'CONTENT_CHANGED');
      }
      const { meaning, status } = this.signOffGuard(f, action, actor);
      f.status = status;

      // Signature manifestation (§11.50) bound to the signed content (§11.70).
      const at = new Date().toISOString();
      const reauth: NonNullable<SignOff['reauth']> = signature ? { method: signature.reauthMethod, at: signature.reauthAt } : { method: 'none', at: null };
      const sig: SignOff = {
        userId: actor.id, userName: actor.name, role: actor.role, meaning, comment, at,
        signatureId: `SIG-${crypto.randomBytes(6).toString('hex')}`, contentHash, reauth,
      };
      f.signOffs.push(sig);
      const bundle = this.humanBundle(e, 'human:sign-off', actor, { findingId, action, comment, intentId: signature?.intentId ?? null }, sig);
      emit(bundle);
      await insertSignature(trx, {
        id: sig.signatureId!, engagementId: e.id, findingId, userId: actor.id, userName: actor.name, role: actor.role, meaning, comment,
        contentHash, reauthMethod: reauth.method, reauthAt: reauth.at, intentId: signature?.intentId ?? null, trailBundleId: bundle.id, signedAt: at,
      });
      return f;
    });
    return result;
  }
  // ---------- Trail ----------

  private humanBundle(e: Engagement, moduleId: string, actor: User, inputs: unknown, output: unknown, qaActions: QaAction[] = []): UnsealedBundle {
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
    const e = await this.engagement(engagementId);
    const cols = ['id', 'status', 'rating', 'controlId', 'title', 'condition', 'criteria', 'cause', 'effect', 'recommendation', 'citations', 'evidenceRefs', 'approvedBy', 'bundleId'];
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = e.findings.map((f) =>
      [
        f.id, f.status, f.rating, f.controlId, f.title, f.condition, f.criteria, f.cause, f.effect, f.recommendation,
        f.citations.map((c) => `${c.regulation} ${c.ref}`).join('; '),
        f.evidenceRefs.join('; '),
        f.signOffs.filter((s) => s.meaning === 'Approved').map((s) => `${s.userName} ${s.at}`).join('; '),
        f.bundleId,
      ].map((v) => esc(String(v))).join(','),
    );
    return [cols.join(','), ...rows].join('\n');
  }
}
