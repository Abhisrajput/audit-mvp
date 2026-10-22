# Expert Auditor 8A: Context, Standards, Risk Assessment and the Scope Memo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The scope gate shows an assessed, explained scope: an engagement risk assessment built from an auditor-entered context, a coverage statement, and a judgment memo the signer reads before approving.

**Architecture:**
- **Judgment is a pure layer** in `backend/src/judgment/`: no I/O, deterministic rules first, a bounded model overlay that can only tighten. The scope module calls it; the graph, menu, gates and worker are untouched, so the golden traces do not change.
- **The engagement context** is auditor-entered data on the engagement (`context`), never written by the agent. It is part of the scope subject's basis, so changing it reopens the scope. It locks once the RCM gate is approved.
- **The memo is content.** The scope memo and the coverage statement are stored on the engagement (`memos.scope`, `coverage`) and hashed into the scope workpaper's content, so the gate's hash and the Part 11 signature cover the reasoning.
- **The IIA Standards are a content pack** (`backend/packs/iia`, clauses only), loaded like every other pack but never selectable for an engagement and never retrieved for findings. Memos and QA cite it.
- **Backward compatibility is exact:** with no context, no coverage and no memo, every hash equals today's, every existing eval case passes and both golden traces are unchanged.

**Tech Stack:** Node 22, TypeScript, Express 5, Kysely + Postgres 16, zod 4 (backend). React 18, MUI 5, Vite, vitest 5 in a node environment (frontend). **No new dependencies** in either package.

**Spec:** `docs/superpowers/specs/2026-10-21-expert-auditor-design.md`. This plan implements §3.1, §3.2 (scope fields), §3.4, §4, §5.1, §5.2, the scope parts of §7 and §8, and REQ-31 and REQ-35 of §9; it is plan 8A in §10. It builds on `backend/src/agents/` (plans 2A to 2C) and `backend/src/engine/modules/scope.ts`.

## Global Constraints

- **No new npm dependencies**, backend or frontend. No DOM testing library: frontend logic that needs a test lives in a pure module under `frontend/src/` and is tested under node, as `agents.ts` and `signing.ts` are.
- **Code style follows the surrounding files:** plain-language comments, the existing `blocking(...)`/`advisory(...)` helpers in QA, MUI `variant="outlined"` cards and `size="small"` chips on tabs.
- **Tests never call a real model.** Use `FakeProvider` from `backend/tests/helpers.ts`. Never use fake timers (they mix badly with Testcontainers).
- **Values copied from the spec:**
  - §3.1: `ContextFactor.kind ∈ {'change','incident','regulatory','prior_finding','complexity'}`; `description ≤ 500` chars; `factors ≤ 50`; `background ≤ 4000` chars; empty `processAreas` means the whole entity.
  - §3.1: `PUT /api/engagements/:id/context` returns **409** once the engagement has an approved RCM gate; the scope basis must hash identically when `context` is null.
  - §5.1: assessed risk = library rating stepped up one level **per distinct factor kind** touching the control's area, capped at High, never down. An area's risk is the max over its controls. An area is *touched* when at least one factor applies to it.
  - §5.2: inclusion thresholds **High ≥ 0.25, otherwise ≥ 0.30**, keyed on `assessedRisk`. A touched area with no control above threshold gets its **highest-relevance control** included (ties: higher library rating) with the rationale `included: <factor description>`. Exclusion reasons: `below relevance threshold` or `excluded by the scope statement`.
  - §5.2 QA: **blocking** when a touched area whose assessed risk is High is excluded; today's `scope.high-risk-excluded` stays **advisory**; advisory when the coverage statement does not mention every excluded area. §5.1 QA: advisory when a factor names a process area that matches no control in the chosen packs; blocking when any item's `assessedRisk` is below its `inherentRisk`.
  - §4: pack id `iia`, clause ids `IIA-<number>`, `sources: {"IIA Global Internal Audit Standards 2024": "IIA"}`, every clause `draft`, `verified: null`, `stale_after` one year out. **Every number and title is verified against the published Standards before a clause is written.** The pack never appears in `packIds` and is not offered in the UI.
  - §3.4: `JudgmentCall { question, decision, rationale, basis: string[], standard: string[], source: 'rules' | 'model' }`, `JudgmentMemo { subjectKey, calls, forTheReviewer: string[], producedAt }`.
- **Fixed values decided here** (see Rulings):

  | Setting | Value |
  |---|---|
  | Memo storage | `Engagement.memos: Record<string, JudgmentMemo>`, column `engagement_work.memos jsonb NOT NULL DEFAULT '{}'` |
  | Context and coverage storage | `engagement_work.context jsonb NULL`, `engagement_work.coverage jsonb NULL` |
  | Scope basis with a context | `sha256(canonicalJson({ scopeStatement, packIds, context: { factors, background } }))`; without one, exactly today's `{ scopeStatement, packIds }` |
  | Scope content hash | today's `e.scope` when `coverage` is null and there is no scope memo; otherwise `{ items: e.scope, coverage: e.coverage, memo: e.memos.scope }` |
  | Error code for a locked context | `CONTEXT_LOCKED` (409) |
  | Methodology pack id constant | `METHODOLOGY_PACK_ID = 'iia'` in `backend/src/judgment/standards.ts` |
  | Context entry in the UI | the Scope tab only; the create-engagement form is unchanged (the API accepts `context` at creation for tests and the agent eval) |

- **Requirement tags:** new tests carry `[REQ-31]` (memo is part of the signed subject) and `[REQ-35]` (context is human-written and reopens the scope) in their `it(` titles, plus existing ids where they apply (`[REQ-26]` injection, `[REQ-30]` QA). `backend/validation/requirements.json` gains both ids in Task 9; `npm run traceability` fails on a tag with no requirement, so Task 9 runs before any test with a new tag is merged. During development, run the traceability check only in Task 9.
- **Commands:**
  - Backend, from `backend/`: `npx vitest run <files>` needs Docker (Testcontainers). `npm run typecheck` covers only `src/`, so every backend task also runs the test files it touches.
  - Frontend, from `frontend/`: `npm run typecheck && npx vitest run && npm run build`. The type check compiles the backend types the UI imports.
- **Commits** end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Implementer subagents use their own model's name.

## Rulings on the spec (decided here, confirm at plan review)

1. **Where the new engagement fields live.** `engagement_work` already holds one JSONB column per workpaper, so `context`, `coverage` and `memos` are three more columns there, loaded and saved with the rest (`backend/src/db/engagement-repo.ts`). `context` is not on `engagements` because nothing lists or filters by it.
2. **Exact hash compatibility, not approximate.** Both `rootBasis` and `workpaperContentHash('scope')` return today's value when the new fields are absent (table above). An engagement created before 8A keeps its approved scope gate current until someone sets a context or the agent redrafts the scope.
3. **The scope memo is produced by the scope module**, not by the executor: the module is the only place that knows which calls the rules made and which the model changed. `apply` writes `e.coverage` and `e.memos.scope` with `e.scope`. The memo's `producedAt` is the module run's start time, so an unchanged redraft keeps the same hash only if everything else is equal (it never is: `producedAt` differs). That is acceptable: a redraft is a new workpaper.
4. **The model overlay for the scope** returns, per candidate, `included`, `rationale` and an optional `assessedRisk`, plus an optional `coverageStatement` and `exclusions`. The module accepts an `assessedRisk` only when it is exactly one step above the rule's value; it accepts an exclusion reason only for an area that is still excluded; it keeps the rule's coverage statement when the model's omits an excluded area. Every refused overlay is a `ctx.gate` action (`gate: 'judgment-bounds'`, `outcome: 'fail'`, `action: 'blocked'`), so it is in the trail bundle like today's `library-only` refusals.
5. **Inclusion by context pins the decision.** A control included by `included: <factor>` is included in the rules draft; the model may still set `included: false` on it (the model may exclude any control today). The blocking QA check (§5.2) then catches a touched High area left empty, and `keepScopeDecisions` pins the inclusion on rework. The rules draft itself never produces a blocking scope issue.
6. **The `iia` pack is clauses only.** `loadBundle` accepts a pack with `pack.md` and a `clauses/` folder (no `controls/`, no `eval/`). `clausesFor(packIds)` never returns its clauses, because no engagement lists it and no control cites it, so retrieval, citations and the trust gate never see it. `/api/packs` and the default pack list for `/api/search` filter it out; `createEngagement` refuses it with 400.
7. **The memos endpoint** `GET /api/engagements/:id/memos/:subjectKey` exists for the chat assistant and for operators; the UI reads memos from the engagement object it already has.
8. **No golden-trace change.** Task 5 runs `npm run eval` and the eval must report the same agent-trace result as before (both scenarios pass with their existing traces). If the trace changes, the task is wrong, not the trace.
9. **Clause verification is a step with evidence.** Task 4 records, in the commit message, the source used to verify each clause number and title. If a standard in the spec's table cannot be verified, the clause is omitted and `standards.ts` points the affected judgment at the nearest verified clause; the omission is listed in the PR.

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely to bite first. Each has its test added to the owning task.

1. A factor whose `processAreas` names an area that exists in no chosen pack (a typo): the assessment ignores it, QA says so as an advisory, nothing errors. (Task 6)
2. A factor with empty `processAreas` steps up every control in every area, and the memo says "whole entity" rather than listing areas. (Task 2)
3. Re-saving the same context (same factors and background, new `updatedAt`) does not change the scope basis, so it does not reopen an approved scope gate. (Task 7)
4. A context at the size limits (50 factors, a 500-character description, a 4000-character background) is accepted; one over any limit is refused with 400 naming the field. (Task 7)
5. The model returns an `assessedRisk` two steps above the rule, or below it: both are refused, the rule's value stays, and the refusal is in the trail bundle's `qaActions`. (Task 5)

---

### Task 1: Types, migration and persistence

**Files:**
- Modify: `backend/src/engine/types.ts` (ScopeItem, Engagement, new judgment types)
- Create: `backend/migrations/012_judgment.sql`
- Modify: `backend/src/db/engagement-repo.ts:44-141` (insert, load, save), `backend/src/db/schema.ts` (the `engagement_work` table type; find it with `grep -n engagement_work backend/src/db/*.ts`)
- Test: `backend/tests/judgment-db.test.ts`

**Interfaces:**
- Produces (in `backend/src/engine/types.ts`):
  ```ts
  export type FactorKind = 'change' | 'incident' | 'regulatory' | 'prior_finding' | 'complexity';
  export interface ContextFactor { kind: FactorKind; processAreas: string[]; description: string }
  export interface EngagementContext { factors: ContextFactor[]; background: string; updatedBy: string; updatedAt: string }
  export interface Coverage { excluded: { processArea: string; reason: string }[]; statement: string }
  export interface JudgmentCall { question: string; decision: string; rationale: string; basis: string[]; standard: string[]; source: 'rules' | 'model' }
  export interface JudgmentMemo { subjectKey: string; calls: JudgmentCall[]; forTheReviewer: string[]; producedAt: string }
  ```
  `ScopeItem` gains `assessedRisk: RiskRating` and `riskFactors: string[]`. `Engagement` gains `context: EngagementContext | null`, `coverage: Coverage | null`, `memos: Record<string, JudgmentMemo>`.
- Every place that builds an `Engagement` or a `ScopeItem` literal (`service.ts#createEngagement`, `tests/agent-fixtures.ts`, `tests/helpers.ts`, `src/eval/*`) compiles again with the new fields: `context: null`, `coverage: null`, `memos: {}`; scope fixtures get `assessedRisk` equal to `inherentRisk` and `riskFactors: []`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/judgment-db.test.ts
import { describe, expect, it } from 'vitest';
import { loadEngagement, saveEngagement } from '../src/db/engagement-repo';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

describe('judgment fields on the engagement', () => {
  it('round-trips the context, coverage and memos, and loads older rows as empty', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const k = svc.db.kysely;
    const fresh = (await loadEngagement(k, e.id))!;
    expect(fresh.engagement).toMatchObject({ context: null, coverage: null, memos: {} });
    fresh.engagement.context = { factors: [{ kind: 'incident', processAreas: ['HACCP'], description: 'Two CCP deviations in March' }], background: 'One plant.', updatedBy: 'auditor', updatedAt: '2026-10-21T00:00:00.000Z' };
    fresh.engagement.coverage = { excluded: [{ processArea: 'Procure to pay', reason: 'below relevance threshold' }], statement: '1 area excluded.' };
    fresh.engagement.memos = { scope: { subjectKey: 'scope', calls: [], forTheReviewer: ['Nothing to verify.'], producedAt: '2026-10-21T00:00:00.000Z' } };
    await saveEngagement(k, fresh);
    const again = (await loadEngagement(k, e.id))!.engagement;
    expect(again.context?.factors[0].description).toBe('Two CCP deviations in March');
    expect(again.coverage?.excluded).toHaveLength(1);
    expect(again.memos.scope.forTheReviewer).toEqual(['Nothing to verify.']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run tests/judgment-db.test.ts`
Expected: FAIL (type errors on `context`/`coverage`/`memos`, or `memos` undefined after load).

- [ ] **Step 3: Add the types to `backend/src/engine/types.ts`** as in Interfaces, next to `ScopeItem` and `Engagement`, with one-line doc comments naming the spec section (§3.1, §3.2, §3.4).

- [ ] **Step 4: Write `backend/migrations/012_judgment.sql`**

```sql
-- Expert Auditor 8A (spec §3): the auditor-entered engagement context, the scope coverage statement, and the judgment memos.
-- All three travel with the engagement's working state. NULL context and coverage, and an empty memos object, are
-- exactly what every engagement created before this migration has.
ALTER TABLE engagement_work
  ADD COLUMN context  jsonb,
  ADD COLUMN coverage jsonb,
  ADD COLUMN memos    jsonb NOT NULL DEFAULT '{}'::jsonb;
```

- [ ] **Step 5: Persist the fields** in `backend/src/db/engagement-repo.ts`: add the three columns to the `engagement_work` row type in `schema.ts`, to `insertEngagement`, `loadEngagement` (`context: w.context ?? null, coverage: w.coverage ?? null, memos: w.memos ?? {}`) and `saveEngagement`. Add `context: null, coverage: null, memos: {}` to the engagement literal in `service.ts#createEngagement` (Task 7 extends this).

- [ ] **Step 6: Fix every compile error** from the new required fields (`npm run typecheck`, then the test files: `npx vitest run tests/agent-fixtures.ts tests/engine.test.ts tests/agent-qa.test.ts` surface the fixture builders). Scope fixtures: `assessedRisk: inherentRisk`, `riskFactors: []`.

- [ ] **Step 7: Run the test and the suite**

Run: `cd backend && npm run typecheck && npx vitest run`
Expected: `judgment-db.test.ts` passes; the whole suite still passes (567 tests before this task).

- [ ] **Step 8: Commit**

```bash
git add backend/migrations/012_judgment.sql backend/src/engine/types.ts backend/src/db backend/src/service.ts backend/tests
git commit -m "feat(judgment): engagement context, coverage and memo fields with migration 012"
```

---

### Task 2: Context schema and the engagement risk assessment

**Files:**
- Create: `backend/src/judgment/context.ts`, `backend/src/judgment/risk-assessment.ts`
- Test: `backend/tests/judgment-rules.test.ts`

**Interfaces:**
- Produces (`context.ts`):
  ```ts
  export const FACTOR_KINDS: readonly FactorKind[];
  export const CONTEXT_LIMITS = { factors: 50, description: 500, background: 4000 } as const;
  /** The request body: no updatedBy/updatedAt. zod, with the limits above; processAreas entries trimmed and non-empty. */
  export const EngagementContextInputSchema: z.ZodType<EngagementContextInput>;
  export type EngagementContextInput = { factors: ContextFactor[]; background: string };
  /** Factors that apply to a process area: those naming it, plus those with empty processAreas (the whole entity). */
  export function factorsFor(context: EngagementContext | null, processArea: string): ContextFactor[];
  /** Areas named by any factor. */
  export function namedAreas(context: EngagementContext | null): string[];
  /** What the basis hashes: content only, never who or when. */
  export function contextBasis(context: EngagementContext | null): { factors: ContextFactor[]; background: string } | undefined;
  ```
- Produces (`risk-assessment.ts`):
  ```ts
  export function stepUp(rating: RiskRating, steps: number): RiskRating;   // Low→Medium→High, capped
  export interface Assessed { assessedRisk: RiskRating; riskFactors: string[] }
  /** §5.1: one step per distinct factor kind among the factors that apply to the control's area. */
  export function assessControl(control: Pick<Control, 'processArea' | 'riskRating'>, context: EngagementContext | null): Assessed;
  /** Max over the items of one area; 'Low' for an empty list. */
  export function areaRisk(items: Pick<ScopeItem, 'assessedRisk'>[]): RiskRating;
  export function isTouched(context: EngagementContext | null, processArea: string): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// backend/tests/judgment-rules.test.ts
import { describe, expect, it } from 'vitest';
import { CONTEXT_LIMITS, contextBasis, EngagementContextInputSchema, factorsFor } from '../src/judgment/context';
import { areaRisk, assessControl, isTouched, stepUp } from '../src/judgment/risk-assessment';

const ctx = (factors: object[], background = '') => ({ factors, background, updatedBy: 'u', updatedAt: 't' }) as never;
const f = (kind: string, processAreas: string[], description = `${kind} factor`) => ({ kind, processAreas, description });

describe('engagement risk assessment (spec §5.1)', () => {
  it('steps the library rating up once per distinct factor kind touching the area, capped at High', () => {
    const c = { processArea: 'Change control', riskRating: 'Low' as const };
    expect(assessControl(c, null)).toEqual({ assessedRisk: 'Low', riskFactors: [] });
    expect(assessControl(c, ctx([f('incident', ['Change control'])])).assessedRisk).toBe('Medium');
    expect(assessControl(c, ctx([f('incident', ['Change control']), f('incident', ['Change control'], 'second incident')])).assessedRisk).toBe('Medium');
    expect(assessControl(c, ctx([f('incident', ['Change control']), f('change', ['Change control'])])).assessedRisk).toBe('High');
    expect(assessControl(c, ctx([f('incident', ['Change control']), f('change', ['Change control']), f('regulatory', [])])).assessedRisk).toBe('High');
    expect(assessControl(c, ctx([f('incident', ['Other area'])])).assessedRisk).toBe('Low');
  });

  it('applies a factor with no process areas to the whole entity, and lists the descriptions that applied', () => {
    const r = assessControl({ processArea: 'Lab', riskRating: 'Medium' }, ctx([f('regulatory', [], 'FDA 483 issued in May'), f('change', ['Lab'], 'New LIMS')]));
    expect(r).toEqual({ assessedRisk: 'High', riskFactors: ['FDA 483 issued in May', 'New LIMS'] });
    expect(isTouched(ctx([f('regulatory', [])]), 'Anything')).toBe(true);
    expect(isTouched(null, 'Anything')).toBe(false);
  });

  it('never steps down, and an area is as risky as its riskiest control', () => {
    expect(stepUp('High', 3)).toBe('High');
    expect(stepUp('Low', 0)).toBe('Low');
    expect(areaRisk([{ assessedRisk: 'Low' }, { assessedRisk: 'High' }, { assessedRisk: 'Medium' }])).toBe('High');
    expect(areaRisk([])).toBe('Low');
  });
});

describe('the context input (spec §3.1)', () => {
  it('accepts the limits and refuses one past them, naming the field', () => {
    const ok = { factors: Array.from({ length: CONTEXT_LIMITS.factors }, () => f('change', ['A'], 'x'.repeat(CONTEXT_LIMITS.description))), background: 'b'.repeat(CONTEXT_LIMITS.background) };
    expect(EngagementContextInputSchema.safeParse(ok).success).toBe(true);
    const tooMany = EngagementContextInputSchema.safeParse({ ...ok, factors: [...ok.factors, f('change', ['A'])] });
    expect(tooMany.success).toBe(false);
    expect(JSON.stringify(tooMany.error?.issues)).toMatch(/factors/);
    expect(EngagementContextInputSchema.safeParse({ factors: [f('bogus', ['A'])], background: '' }).success).toBe(false);
    expect(EngagementContextInputSchema.safeParse({ factors: [f('change', [' '])], background: '' }).success).toBe(false);
  });

  it('hashes content only: who and when are not part of the basis', () => {
    const a = ctx([f('change', ['A'])], 'bg');
    const b = { ...a, updatedBy: 'someone else', updatedAt: 'later' };
    expect(contextBasis(a)).toEqual(contextBasis(b));
    expect(contextBasis(null)).toBeUndefined();
    expect(factorsFor(a, 'A')).toHaveLength(1);
    expect(factorsFor(a, 'B')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/judgment-rules.test.ts`
Expected: FAIL with "Cannot find module '../src/judgment/context'".

- [ ] **Step 3: Implement `context.ts` and `risk-assessment.ts`** with the signatures in Interfaces. `assessControl`: the applicable factors are `factorsFor(context, control.processArea)`; steps = number of distinct `kind` values among them; `riskFactors` = their descriptions in input order. File header comments name the spec sections.

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx vitest run tests/judgment-rules.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/judgment/context.ts backend/src/judgment/risk-assessment.ts backend/tests/judgment-rules.test.ts
git commit -m "feat(judgment): engagement context schema and the engagement risk assessment rules"
```

---

### Task 3: Coverage, the memo and the standards map

**Files:**
- Create: `backend/src/judgment/coverage.ts`, `backend/src/judgment/memo.ts`, `backend/src/judgment/standards.ts`
- Test: `backend/tests/judgment-rules.test.ts` (extend)

**Interfaces:**
- Produces (`standards.ts`):
  ```ts
  export const METHODOLOGY_PACK_ID = 'iia';
  /** The clause each judgment cites (spec §4). Ids are checked against the loaded pack in Task 4's test. */
  export const IIA = {
    dueCare: 'IIA-4.2', scepticism: 'IIA-4.3', communication: 'IIA-13.1', riskAssessment: 'IIA-13.2', scope: 'IIA-13.3',
    criteria: 'IIA-13.4', resources: 'IIA-13.5', workProgram: 'IIA-13.6', gathering: 'IIA-14.1', analysis: 'IIA-14.2',
    evaluation: 'IIA-14.3', recommendations: 'IIA-14.4', conclusions: 'IIA-14.5', documentation: 'IIA-14.6',
    finalCommunication: 'IIA-15.1', followUp: 'IIA-15.2',
  } as const;
  ```
- Produces (`coverage.ts`):
  ```ts
  export const INCLUSION_THRESHOLD = { High: 0.25, other: 0.30 } as const;
  export const REASON = { threshold: 'below relevance threshold', statement: 'excluded by the scope statement' } as const;
  export function includedByRule(assessedRisk: RiskRating, relevance: number): boolean;
  /** A candidate as the scope module sees it before inclusion is decided. */
  export interface Candidate { controlId: string; processArea: string; inherentRisk: RiskRating; assessedRisk: RiskRating; relevance: number }
  /** §5.2: controls to include because their area is touched and has nothing above threshold. Keyed by controlId → the factor description used in the rationale. */
  export function contextInclusions(candidates: Candidate[], context: EngagementContext | null): Map<string, string>;
  /** Every area of the candidates with no included control, with its reason. `scopeStatement` decides REASON.statement (case-insensitive "not"/"excluding"/"out of scope" within 60 characters before or after the area name; the builder picks the regex). */
  export function excludedAreas(candidates: Candidate[], included: Set<string>, scopeStatement: string): Coverage['excluded'];
  /** The fixed sentence: "<n> of <m> library controls across <a> process areas are in scope; <x> area(s) excluded: <names>." or "...; no area excluded." */
  export function coverageStatement(candidates: Candidate[], included: Set<string>, excluded: Coverage['excluded']): string;
  /** True when the statement names every excluded area (case-insensitive substring). */
  export function statementCoversAll(statement: string, excluded: Coverage['excluded']): boolean;
  ```
- Produces (`memo.ts`):
  ```ts
  export function call(partial: Omit<JudgmentCall, 'source'> & { source?: JudgmentCall['source'] }): JudgmentCall;  // default source 'rules'
  /** The scope memo: one call per area whose assessed risk differs from the library (and a "no change" summary when none), one call for the coverage, one per context inclusion; forTheReviewer lists unverified model claims and any factor naming an unknown area. */
  export function scopeMemo(input: { items: ScopeItem[]; coverage: Coverage; context: EngagementContext | null; unknownAreas: string[]; modelNotes: string[]; producedAt: string }): JudgmentMemo;
  /** Markdown for the gate panel: a heading per call, then "For the reviewer". */
  export function renderMemo(memo: JudgmentMemo): string;
  ```

- [ ] **Step 1: Write the failing tests** (append to `tests/judgment-rules.test.ts`)

```ts
import { contextInclusions, coverageStatement, excludedAreas, includedByRule, INCLUSION_THRESHOLD, statementCoversAll } from '../src/judgment/coverage';
import { renderMemo, scopeMemo } from '../src/judgment/memo';
import { IIA } from '../src/judgment/standards';

const cand = (controlId: string, processArea: string, inherentRisk: 'High' | 'Medium' | 'Low', relevance: number, assessedRisk = inherentRisk) => ({ controlId, processArea, inherentRisk, assessedRisk, relevance });

describe('scope coverage (spec §5.2)', () => {
  it('keeps today\'s thresholds, keyed on the assessed risk', () => {
    expect(includedByRule('High', INCLUSION_THRESHOLD.High)).toBe(true);
    expect(includedByRule('Medium', 0.29)).toBe(false);
    expect(includedByRule('Medium', INCLUSION_THRESHOLD.other)).toBe(true);
    expect(includedByRule('Low', 0.25)).toBe(false);
  });

  it('includes the best control of a touched area that has nothing above threshold, and nothing without a context', () => {
    const cs = [cand('A1', 'Lab', 'Low', 0.1), cand('A2', 'Lab', 'Medium', 0.1), cand('B1', 'QA', 'High', 0.9)];
    expect(contextInclusions(cs, null).size).toBe(0);
    const inc = contextInclusions(cs, ctx([f('incident', ['Lab'], 'OOS results not investigated')]));
    expect([...inc.entries()]).toEqual([['A2', 'OOS results not investigated']]);   // tie on relevance: the higher library rating
    expect(contextInclusions(cs, ctx([f('incident', ['QA'])])).size).toBe(0);         // QA already has B1 above threshold
  });

  it('lists every empty area with its reason, and writes a statement that names them all', () => {
    const cs = [cand('A1', 'Lab', 'Low', 0.1), cand('B1', 'QA', 'High', 0.9), cand('C1', 'Treasury', 'Medium', 0.5)];
    const excluded = excludedAreas(cs, new Set(['B1', 'C1']), 'Quality system and treasury; lab testing is out of scope');
    expect(excluded).toEqual([{ processArea: 'Lab', reason: 'excluded by the scope statement' }]);
    const s = coverageStatement(cs, new Set(['B1', 'C1']), excluded);
    expect(s).toBe('2 of 3 library controls across 2 process areas are in scope; 1 area excluded: Lab.');
    expect(statementCoversAll(s, excluded)).toBe(true);
    expect(statementCoversAll('All good.', excluded)).toBe(false);
    expect(excludedAreas(cs, new Set(['B1', 'C1']), 'Quality system and treasury')[0].reason).toBe('below relevance threshold');
  });
});

describe('the scope memo (spec §3.4)', () => {
  it('explains each raised area with its factors and standard, and renders for the signer', () => {
    const items = [
      { controlId: 'A1', processArea: 'Lab', inherentRisk: 'Low', assessedRisk: 'High', riskFactors: ['New LIMS', 'FDA 483'], included: true } as never,
      { controlId: 'B1', processArea: 'QA', inherentRisk: 'High', assessedRisk: 'High', riskFactors: [], included: true } as never,
    ];
    const memo = scopeMemo({ items, coverage: { excluded: [], statement: '2 of 2…' }, context: ctx([f('change', ['Lab'], 'New LIMS')]), unknownAreas: ['Warehouse'], modelNotes: [], producedAt: 't' });
    expect(memo.subjectKey).toBe('scope');
    const lab = memo.calls.find((c) => c.question.includes('Lab'))!;
    expect(lab).toMatchObject({ decision: expect.stringMatching(/High \(library: Low\)/), basis: ['New LIMS', 'FDA 483'], standard: [IIA.riskAssessment], source: 'rules' });
    expect(memo.calls.some((c) => c.standard.includes(IIA.scope))).toBe(true);
    expect(memo.forTheReviewer.join(' ')).toMatch(/Warehouse/);
    const md = renderMemo(memo);
    expect(md).toMatch(/^## /m);
    expect(md).toMatch(/For the reviewer/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/judgment-rules.test.ts`
Expected: FAIL with "Cannot find module '../src/judgment/coverage'".

- [ ] **Step 3: Implement the three files** with the signatures in Interfaces. `contextInclusions`: group candidates by area; for each touched area with no candidate passing `includedByRule`, pick max relevance, then higher library rating (High > Medium > Low), then lower `controlId`; the value is the first applicable factor's description. `coverageStatement` wording is fixed by the test.

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx vitest run tests/judgment-rules.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/judgment backend/tests/judgment-rules.test.ts
git commit -m "feat(judgment): scope coverage rules, the judgment memo, and the IIA standards map"
```

---

### Task 4: The IIA Standards pack

**Files:**
- Create: `backend/packs/iia/pack.md`, `backend/packs/iia/clauses/iia-4-2.md` … one file per row of spec §4's table (16 files, names from the slug rule: lower-cased id, other characters as hyphens, so `IIA-13.2` is `iia-13-2.md`)
- Modify: `backend/src/app.ts:119-131` (`/api/packs`, `/api/search` defaults), `backend/src/service.ts:189-194` (`createEngagement` refuses the pack)
- Test: `backend/tests/judgment-pack.test.ts`

**Interfaces:**
- Consumes: `METHODOLOGY_PACK_ID`, `IIA` (Task 3).
- Produces: the registry holds pack `iia` with 16 clauses, ids exactly the values of `IIA`; `svc.registry.get('iia').sources` is `{ 'IIA Global Internal Audit Standards 2024': 'IIA' }`.

- [ ] **Step 1: Verify the standards** against the published Global Internal Audit Standards (the IIA's own site or PDF; a vendor summary is not enough). For each row of the spec §4 table, confirm the number and title. Record the source URL(s) for the commit message. Drop any row that cannot be confirmed and note it for the PR.

- [ ] **Step 2: Write the failing test**

```ts
// backend/tests/judgment-pack.test.ts
import { describe, expect, it } from 'vitest';
import { IIA, METHODOLOGY_PACK_ID } from '../src/judgment/standards';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';
import { appWithDevUsers, signIn } from './http';

describe('the IIA methodology pack (spec §4)', () => {
  it('loads with every clause the judgments cite, all draft and unverified', async () => {
    const svc = await newService();
    const pack = svc.registry.get(METHODOLOGY_PACK_ID);
    expect(pack.controls).toHaveLength(0);
    expect(pack.sources).toEqual({ 'IIA Global Internal Audit Standards 2024': 'IIA' });
    for (const id of Object.values(IIA)) {
      const c = svc.registry.clauses.get(id);
      expect(c, id).toBeDefined();
      expect(c!.reviewStatus).toBe('draft');
      expect(c!.trust?.verifiedBy ?? null).toBeNull();
      expect(svc.registry.citationLabel(id)).toMatch(/^IIA /);
    }
  });

  it('is never an engagement pack: not offered, not accepted, not retrieved', async () => {
    const { app, svc } = await appWithDevUsers();
    const user = await signIn(app, 'auditor');
    const listed = (await user.get('/api/packs').expect(200)).body.map((p: { id: string }) => p.id);
    expect(listed).not.toContain(METHODOLOGY_PACK_ID);
    expect((await user.post('/api/engagements', { ...NEW_ENGAGEMENT, packIds: ['common', METHODOLOGY_PACK_ID] })).status).toBe(400);
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    expect(svc.registry.clausesFor(e.packIds).some((c) => c.packId === METHODOLOGY_PACK_ID)).toBe(false);
    const hits = (await user.get('/api/search?q=risk assessment').expect(200)).body as { clause: { packId: string } }[];
    expect(hits.some((h) => h.clause.packId === METHODOLOGY_PACK_ID)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && npx vitest run tests/judgment-pack.test.ts`
Expected: FAIL with "Unknown pack iia" (or the registry `get` error).

- [ ] **Step 4: Write the pack.** `pack.md` follows `backend/packs/common/pack.md`: `type: pack`, `x_audit.id: iia`, `version: 0.1.0`, `vertical: common`, `citation_prefixes: { "IIA Global Internal Audit Standards 2024": "IIA" }`, `generated.by: expert-auditor-8a`, `verified: null`, `stale_after` one year from today, and the body sentence that the summaries are paraphrased drafts pending expert review. Each clause follows `backend/packs/common/clauses/coso-p10.md`: `type: clause`, `title` the verified title, `description` a one-sentence paraphrase in your own words (never the Standard's text), `x_audit: { id: 'IIA-<n>', regulation: 'IIA Global Internal Audit Standards 2024', ref: 'Standard <n>' }`, tags from the title.

- [ ] **Step 5: Hide it from engagements.** In `app.ts`, `/api/packs` and the default `packIds` of `/api/search` use `svc.registry.list().filter((p) => p.id !== METHODOLOGY_PACK_ID)`. In `service.ts#createEngagement`, refuse `packIds` containing it: `new AppError(400, 'The IIA methodology pack is not an engagement pack')`.

- [ ] **Step 6: Run the test and the pack-loading tests**

Run: `cd backend && npx vitest run tests/judgment-pack.test.ts tests/knowledge-*.test.ts tests/packs*.test.ts && npm run typecheck`
(Use `ls backend/tests | grep -i -E 'pack|knowledge|okf'` for the exact file names.)
Expected: PASS; no bundle error from `loadBundles`.

- [ ] **Step 7: Commit**, naming the verification sources in the body:

```bash
git add backend/packs/iia backend/src/app.ts backend/src/service.ts backend/tests/judgment-pack.test.ts
git commit -m "feat(packs): IIA Global Internal Audit Standards methodology pack (draft paraphrases)

Standard numbers and titles verified against: <URL(s)>.
Omitted (could not verify): <none, or the list>."
```

---

### Task 5: The scope module uses the judgment layer

**Files:**
- Modify: `backend/src/engine/modules/scope.ts`, `backend/src/agents/subjects.ts:15` (`rootBasis`), `backend/src/signing/content-hash.ts` (`workpaperContentHash`, the `scope` branch), `backend/src/agents/rails.ts` (`keepScopeDecisions`, only if it drops the new item fields; read it first)
- Test: `backend/tests/judgment-scope.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: after `runModule(id, 'scope')`, `e.scope[i]` carries `assessedRisk` and `riskFactors`, `e.coverage` is set, `e.memos.scope` is set. `rootBasis(e)` and `workpaperContentHash('scope', e)` follow the Global Constraints table. The model schema becomes:
  ```ts
  const ModelScope = z.object({
    items: z.array(z.object({ controlId: z.string(), included: z.boolean(), rationale: z.string(), assessedRisk: z.enum(['High', 'Medium', 'Low']).optional() })),
    coverageStatement: z.string().optional(),
    exclusions: z.array(z.object({ processArea: z.string(), reason: z.string() })).optional(),
  });
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// backend/tests/judgment-scope.test.ts
import { describe, expect, it } from 'vitest';
import { rootBasis } from '../src/agents/subjects';
import { workpaperContentHash } from '../src/signing/content-hash';
import { AuditService } from '../src/service';
import { auditor, FakeProvider, LENIENT, NEW_ENGAGEMENT, newService, registry } from './helpers';
import { testDb } from './db';

const INCIDENT = { factors: [{ kind: 'incident' as const, processAreas: ['Procure to pay'], description: 'Duplicate vendor payments found in Q1' }], background: '' };

describe('the scope module with the judgment layer (spec §5.1, §5.2)', () => {
  it('assesses risk from the context, includes the best control of a touched empty area, and writes the coverage and memo', async () => {
    const svc = await newService();
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, context: INCIDENT }, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    const after = await svc.engagement(e.id);
    const p2p = after.scope.filter((s) => s.processArea === 'Procure to pay');
    expect(p2p.length).toBeGreaterThan(0);
    for (const s of p2p) expect(s.assessedRisk).toBe(s.inherentRisk === 'Low' ? 'Medium' : 'High');
    expect(p2p.some((s) => s.included && s.rationale.startsWith('included: Duplicate vendor payments'))).toBe(true);
    expect(after.coverage?.statement).toMatch(/library controls across/);
    expect(after.memos.scope.calls.some((c) => c.question.includes('Procure to pay'))).toBe(true);
    expect(after.scope.filter((s) => s.processArea !== 'Procure to pay').every((s) => s.assessedRisk === s.inherentRisk)).toBe(true);
  });

  it('with no context produces exactly today\'s inclusion, and hashes exactly as before', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    expect(rootBasis(e)).toBe(rootBasis({ ...e, context: null }));
    const legacyBasis = (await import('../src/engine/trail')).sha256((await import('../src/engine/trail')).canonicalJson({ scopeStatement: e.scopeStatement, packIds: e.packIds }));
    expect(rootBasis(e)).toBe(legacyBasis);
    await svc.runModule(e.id, 'scope', auditor);
    const after = await svc.engagement(e.id);
    for (const s of after.scope) {
      expect(s.assessedRisk).toBe(s.inherentRisk);
      expect(s.included).toBe(s.relevance >= 0.3 || (s.inherentRisk === 'High' && s.relevance >= 0.25));
    }
    // An engagement whose scope was saved before 8A: no coverage, no memo → today's hash shape.
    const legacy = { ...after, coverage: null, memos: {} };
    const { sha256, canonicalJson } = await import('../src/engine/trail');
    expect(workpaperContentHash('scope', legacy)).toBe(sha256(canonicalJson({ kind: 'scope', content: legacy.scope })));
    expect(workpaperContentHash('scope', after)).not.toBe(workpaperContentHash('scope', legacy));
  });

  it('lets the model raise an area one step and refuses anything else, in the trail [REQ-26]', async () => {
    const model = new FakeProvider((req) => {
      // FakeProvider (tests/helpers.ts) answers each GenerateRequest from this handler. Return every candidate included, with
      // CMN-P2P-01 raised one step, CMN-P2P-02 raised two steps, and one control lowered below its library rating.
      return scopeAnswerFrom(req, { 'CMN-P2P-01': 'Medium', 'CMN-P2P-02': 'High' /* from Low */, 'CMN-GOV-01': 'Low' /* from High */ });
    });
    const svc = new AuditService(await testDb(), registry, model, LENIENT);
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, packIds: ['common'], auditType: 'Finance', scopeStatement: 'Procure to pay and governance' }, auditor);
    const { bundle, engagement: after } = await svc.runModule(e.id, 'scope', auditor);
    const by = Object.fromEntries(after.scope.map((s) => [s.controlId, s]));
    expect(by['CMN-P2P-01'].assessedRisk).toBe('Medium');                         // one step up: accepted
    expect(by['CMN-P2P-02'].assessedRisk).toBe(by['CMN-P2P-02'].inherentRisk);    // two steps: refused
    expect(by['CMN-GOV-01'].assessedRisk).toBe('High');                           // lowered: refused
    const refusals = bundle.qaActions.filter((a) => a.gate === 'judgment-bounds');
    expect(refusals.map((a) => a.target).sort()).toEqual(['CMN-GOV-01', 'CMN-P2P-02']);
    expect(after.memos.scope.calls.find((c) => c.question.includes('CMN-P2P-01') || c.question.includes(by['CMN-P2P-01'].processArea))?.source).toBe('model');
  });
});
```

Write `scopeAnswerFrom(req, raises)` in the test file: parse the candidate lines from the request's user text (`id | area | title | risk | relevance`, as `scope.ts` formats them) and build `{ items: [...] }` with `included: true` for each, applying `raises`. Check the library ratings of the three controls in `backend/packs/common/controls/` first and adjust the comments; the assertions must use library values, not guesses.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/judgment-scope.test.ts`
Expected: FAIL (`context` not accepted by `createEngagement` is fixed in Task 7; for this task, set the context in the test through `loadEngagement`/`saveEngagement` as Task 1's test does, then switch to `createEngagement({ ...NEW_ENGAGEMENT, context })` in Task 7). The first test fails on `assessedRisk` undefined.

- [ ] **Step 3: Change `scope.ts`.** In order: compute `relevance` as today; build `Candidate`s with `assessControl(c, e.context)`; `included = includedByRule(assessedRisk, rel)`; apply `contextInclusions` (set `included = true`, rationale `included: <description>`); build the `ScopeItem`s with `assessedRisk`/`riskFactors`; the prompt lists `assessed risk` and the context as data (`asData('engagement-context', e.context)` when present) and asks for the optional fields in the new `ModelScope`; apply the overlay within Ruling 4's bounds, recording refusals with `ctx.gate({ gate: 'judgment-bounds', outcome: 'fail', target: controlId | processArea, detail, action: 'blocked' })`; compute `excludedAreas`, `coverageStatement` (model's statement kept only if `statementCoversAll`); build `scopeMemo` with `unknownAreas = namedAreas(e.context)` minus the candidates' areas and `modelNotes` from accepted overlays; return `{ items, coverage, memo }` and let `apply` set `e.scope`, `e.coverage`, `e.memos = { ...e.memos, scope: memo }`. Keep the `scope-coverage` warn gate as it is.

- [ ] **Step 4: Change the hashes.** `subjects.ts#rootBasis`: `sha256(canonicalJson({ scopeStatement, packIds, ...(contextBasis(e.context) ? { context: contextBasis(e.context) } : {}) }))`. `content-hash.ts` `scope` branch: `e.coverage === null && !e.memos?.scope ? e.scope : { items: e.scope, coverage: e.coverage, memo: e.memos.scope }`. Read `agents/rails.ts#keepScopeDecisions` and keep the new item fields through a rework.

- [ ] **Step 5: Run the tests, the scope-related suites, and the eval**

Run: `cd backend && npx vitest run tests/judgment-scope.test.ts tests/engine.test.ts tests/workpapers.test.ts tests/agent-rails.test.ts tests/agents-e2e.test.ts tests/agent-eval.test.ts && npm run typecheck && ALLOW_UNVERIFIED_CITATIONS=true npm run eval`
Expected: all PASS; the eval prints `agent:food-haccp … PASS` and `agent:pharma-data-integrity … PASS` with their existing traces (Ruling 8), and every retrieval case passes.

- [ ] **Step 6: Commit**

```bash
git add backend/src/engine/modules/scope.ts backend/src/agents/subjects.ts backend/src/agents/rails.ts backend/src/signing/content-hash.ts backend/tests/judgment-scope.test.ts
git commit -m "feat(scope): engagement risk assessment, context inclusions, coverage statement and the scope memo"
```

---

### Task 6: QA checks and the rubric cite the standards

**Files:**
- Modify: `backend/src/agents/qa/deterministic.ts` (`scopeIssues`, and the call site that has a registry), `backend/src/agents/qa/rubric.ts` (`RubricCriterion`, `scope` criteria, `subjectContent('scope')`), `backend/src/agents/qa/agent.ts:50` (`reviewPrompt` prints each criterion's standard)
- Test: `backend/tests/agent-qa.test.ts` (extend), `backend/tests/qa-agent.test.ts` (one assertion on the prompt)

**Interfaces:**
- Produces: new issue criteria `scope.assessed-below-library` (blocking), `scope.touched-high-excluded` (blocking), `scope.factor-unknown-area` (advisory), `scope.coverage-statement` (advisory). `RubricCriterion` gains `standard?: string` (an IIA clause id); the scope criteria cite `IIA.riskAssessment`, `IIA.scope`, `IIA.communication`. `subjectContent(e, 'scope')` adds `assessedRisk`, `riskFactors` per item, and `coverage`.
- `scopeIssues(e, knownAreas?: Set<string>)`: the unknown-area check runs only when `knownAreas` is given (the checked reviewer passes the areas of `registry.controlsFor(e.packIds)`).

- [ ] **Step 1: Write the failing tests** (append to `tests/agent-qa.test.ts`; use the existing fixture builders and add `context`/`coverage` through `engagement({ ... })`)

```ts
it('blocks an assessed risk below the library, and a touched High area left out; flags unknown areas and a thin statement [REQ-30]', () => {
  const ctxt = { factors: [{ kind: 'incident' as const, processAreas: ['Lab', 'Warehouse'], description: 'OOS' }], background: '', updatedBy: 'u', updatedAt: 't' };
  const e = engagement({
    context: ctxt,
    scope: [scopeItem('A', false, { processArea: 'Lab', inherentRisk: 'Medium', assessedRisk: 'High' }), scopeItem('B', true, { processArea: 'QA', inherentRisk: 'High', assessedRisk: 'Medium' })],
    coverage: { excluded: [{ processArea: 'Lab', reason: 'below relevance threshold' }], statement: 'All good.' },
  });
  const r = reviewSubject(e, 'scope', new Set(['Lab', 'QA']));
  expect(issues(r)).toEqual(expect.arrayContaining([
    ['blocking', 'scope.assessed-below-library'], ['blocking', 'scope.touched-high-excluded'],
    ['advisory', 'scope.factor-unknown-area'], ['advisory', 'scope.coverage-statement'],
  ]));
  expect(issues(r)).not.toContainEqual(['blocking', 'scope.high-risk-excluded']);   // today's check stays advisory
});

it('raises nothing new for a scope with no context, so the golden-trace engagements are unchanged', () => {
  const r = reviewSubject(engagement({ scope: [scopeItem('A', true), scopeItem('B', false, { inherentRisk: 'High' })] }), 'scope');
  expect(issues(r)).toEqual([['advisory', 'scope.high-risk-excluded']]);
});
```

In `tests/qa-agent.test.ts`, add to an existing prompt test: `expect(prompt).toMatch(/IIA-13\.2/)` for the scope review prompt (find the test that calls `reviewPrompt` or inspects the fake provider's request).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/agent-qa.test.ts tests/qa-agent.test.ts`
Expected: FAIL on the missing criteria.

- [ ] **Step 3: Implement.** `scopeIssues(e, knownAreas?)`: the four checks per Global Constraints (§5.1, §5.2 QA); `touched` uses `isTouched(e.context, area)` and the area's risk `areaRisk(items of that area)`. Thread `knownAreas` from the registry in the checked reviewer path (`CHECKED_REVIEWER`), and extend `reviewSubject`'s signature with the optional third argument the test uses. `rubric.ts`: `standard?: string` on the criterion, set on the scope criteria; `reviewPrompt` appends ` (IIA <id>)` to a criterion line when present; `subjectContent('scope')` adds the fields. Fixture builders in `tests/agent-fixtures.ts` accept `context` and `coverage`.

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx vitest run tests/agent-qa.test.ts tests/qa-agent.test.ts tests/agent-injection.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agents/qa backend/tests/agent-qa.test.ts backend/tests/qa-agent.test.ts backend/tests/agent-fixtures.ts
git commit -m "feat(qa): scope checks for the risk assessment and coverage; rubric criteria cite the IIA Standards"
```

---

### Task 7: Setting the context, the lock, and the memos endpoint

**Files:**
- Modify: `backend/src/service.ts` (`NewEngagement`, `createEngagement`, new `setEngagementContext`), `backend/src/app.ts:24-33,143-146` (`NewEngagementSchema`, new `PUT /api/engagements/:id/context`), `backend/src/agents/routes.ts` (new `GET /api/engagements/:id/memos/:subjectKey`), `backend/src/agents/gate-repo.ts` (a query for "has an approved gate of kind", if none exists)
- Test: `backend/tests/judgment-context.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // service.ts
  export interface NewEngagement { …; context?: EngagementContextInput }
  async setEngagementContext(engagementId: string, input: EngagementContextInput, actor: User, opts?: MutationOptions): Promise<Engagement>;
  // throws AppError(409, 'The scope and RCM are approved; record late matters in the relevant finding, or start a new engagement', 'CONTEXT_LOCKED') when gates has a row kind='rcm' state='approved' for the engagement.
  // Trail: human:set-context with inputs = the input and output = { factors: n, background: chars }.
  ```
  Routes: `PUT /api/engagements/:id/context` (readers + `PREPARER_ROLES` via the service's `require`), body `EngagementContextInputSchema`, `ifMatch` as the other PUTs; `GET /api/engagements/:id/memos/:subjectKey` → `{ memo: JudgmentMemo, markdown: string }` or 404 `'No memo for <key>'`.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/tests/judgment-context.test.ts
import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { startRun } from '../src/agents/runs';
import { subjectInfo } from '../src/agents/subjects';
import { listGates } from '../src/agents/gate-repo';
import { AgentWorker } from '../src/agents/worker';
import { auditor, NEW_ENGAGEMENT, reviewer, unattended } from './helpers';
import { appWithDevUsers, signIn } from './http';

const CONTEXT = { factors: [{ kind: 'change' as const, processAreas: ['HACCP'], description: 'New metal detector line 2' }], background: 'Single site.' };

describe('the engagement context (spec §3.1) [REQ-35]', () => {
  it('is set by people, trailed, and refused past its limits', async () => {
    const { app, svc } = await appWithDevUsers();
    const user = await signIn(app, 'auditor');
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const saved = await user.put(`/api/engagements/${e.id}/context`, CONTEXT);
    expect(saved.status).toBe(200);
    expect(saved.body.context).toMatchObject({ ...CONTEXT, updatedBy: 'auditor' });
    const trail = await svc.trailFor(e.id);
    expect(trail.some((b) => b.moduleId === 'human:set-context' && b.actor === 'auditor')).toBe(true);
    const tooLong = await user.put(`/api/engagements/${e.id}/context`, { ...CONTEXT, background: 'x'.repeat(4001) });
    expect(tooLong.status).toBe(400);
    expect(JSON.stringify(tooLong.body)).toMatch(/background/);
    const viewer = await signIn(app, 'viewer');
    expect((await viewer.put(`/api/engagements/${e.id}/context`, CONTEXT)).status).toBe(403);
  });

  it('reopens an approved scope, but not when re-saved unchanged, and locks once the RCM gate is approved', async () => {
    const { svc } = await appWithDevUsers();
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, context: CONTEXT }, auditor);
    const { run } = await startRun(svc, defaultAgentConfig(), e.id, auditor);
    const worker = new AgentWorker(svc, defaultAgentConfig(), { id: 'w-ctx' });
    await worker.drain();
    const scopeGate = (await listGates(svc.db.kysely, e.id)).find((g) => g.kind === 'scope' && g.state === 'open')!;
    await svc.signGate(scopeGate.id, 'approve', 'ok', reviewer, unattended);
    const before = subjectInfo(await svc.engagement(e.id), 'scope')!;
    await svc.setEngagementContext(e.id, CONTEXT, auditor);                     // same content
    expect(subjectInfo(await svc.engagement(e.id), 'scope')!.basis).toBe(before.basis);
    await svc.setEngagementContext(e.id, { ...CONTEXT, factors: [...CONTEXT.factors, { kind: 'incident', processAreas: ['Allergens'], description: 'Undeclared allergen recall' }] }, auditor);
    expect(subjectInfo(await svc.engagement(e.id), 'scope')!.basis).not.toBe(before.basis);
    await worker.drain();
    const gates = await listGates(svc.db.kysely, e.id);
    expect(gates.filter((g) => g.kind === 'scope')).toHaveLength(2);           // the old one approved, a fresh one open
    expect(gates.find((g) => g.kind === 'scope' && g.state === 'open')).toBeDefined();
    // Approve scope again and the RCM, then the context is locked.
    await svc.signGate(gates.find((g) => g.kind === 'scope' && g.state === 'open')!.id, 'approve', 'ok', reviewer, unattended);
    await worker.drain();
    const rcm = (await listGates(svc.db.kysely, e.id)).find((g) => g.kind === 'rcm' && g.state === 'open')!;
    await svc.signGate(rcm.id, 'approve', 'ok', reviewer, unattended);
    await expect(svc.setEngagementContext(e.id, CONTEXT, auditor)).rejects.toMatchObject({ status: 409, code: 'CONTEXT_LOCKED' });
    void run;
  });
});

describe('the scope memo on the gate [REQ-31]', () => {
  it('is part of the content the scope gate and its signature cover, and is served for the panel', async () => {
    const { app, svc } = await appWithDevUsers();
    const user = await signIn(app, 'auditor');
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, context: CONTEXT }, auditor);
    await startRun(svc, defaultAgentConfig(), e.id, auditor);
    await new AgentWorker(svc, defaultAgentConfig(), { id: 'w-memo' }).drain();
    const gate = (await listGates(svc.db.kysely, e.id)).find((g) => g.kind === 'scope' && g.state === 'open')!;
    const current = await svc.engagement(e.id);
    expect(gate.subjectHash).toBe(subjectInfo(current, 'scope')!.hash);
    const edited = { ...current, memos: { ...current.memos, scope: { ...current.memos.scope, forTheReviewer: ['tampered'] } } };
    expect(subjectInfo(edited, 'scope')!.hash).not.toBe(gate.subjectHash);
    const memo = await user.get(`/api/engagements/${e.id}/memos/scope`).expect(200);
    expect(memo.body.memo.subjectKey).toBe('scope');
    expect(memo.body.markdown).toMatch(/For the reviewer/);
    await user.get(`/api/engagements/${e.id}/memos/report`).expect(404);
  });
});
```

`tests/http.ts`'s `Session.put(path, body)` sends the CSRF token and takes no `ifMatch`; the route still accepts `If-Match` as the other PUTs do.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/judgment-context.test.ts`
Expected: FAIL with 404 on the `PUT` (route missing) and `setEngagementContext is not a function`.

- [ ] **Step 3: Implement.** `createEngagement` accepts `context` and stamps `updatedBy: actor.id`, `updatedAt: now` (validated by the same schema at the route). `setEngagementContext` goes through `mutate` (which wakes a waiting run), checks the lock first with one query on `gates` (`kind = 'rcm' AND state = 'approved' AND engagement_id = ?`), sets `e.context`, emits `human:set-context`. Routes per Interfaces; the memos route renders with `renderMemo`.

- [ ] **Step 4: Run the tests and the agent suites**

Run: `cd backend && npx vitest run tests/judgment-context.test.ts tests/judgment-scope.test.ts tests/agents-http.test.ts tests/agents-e2e.test.ts tests/gates.test.ts && npm run typecheck`
Expected: PASS. Then switch Task 5's first test to `createEngagement({ ...NEW_ENGAGEMENT, context: INCIDENT })` if it still sets the context through the repo, and re-run it.

- [ ] **Step 5: Commit**

```bash
git add backend/src/service.ts backend/src/app.ts backend/src/agents/routes.ts backend/src/agents/gate-repo.ts backend/tests/judgment-context.test.ts backend/tests/judgment-scope.test.ts
git commit -m "feat(api): engagement context with its lock after the RCM gate, and the memos endpoint"
```

---

### Task 8: UI: context form, assessed scope, coverage and the memo on the gate

**Files:**
- Create: `frontend/src/judgment.ts`, `frontend/src/judgment.test.ts`, `frontend/src/components/engagement/ContextForm.tsx`, `frontend/src/components/engagement/MemoView.tsx`
- Modify: `frontend/src/components/engagement/ScopeTab.tsx`, `frontend/src/components/engagement/GateList.tsx:45-48`, `frontend/src/api.ts:9-19` (`FRIENDLY.CONTEXT_LOCKED`), `frontend/src/pages/EngagementPage.tsx` (pass `gates` to the Scope tab if `TabProps` does not already carry them; read `TabProps` first)

**Interfaces:**
- Produces (`judgment.ts`, pure, tested under node):
  ```ts
  export const FACTOR_LABELS: Record<FactorKind, string>;  // 'change' → 'Process or system change', 'incident' → 'Incident, deviation or complaint', 'regulatory' → 'Regulatory action or inspection', 'prior_finding' → 'Prior audit finding', 'complexity' → 'Complexity or volume'
  /** Distinct process areas of the engagement's scope candidates (after a scope run) or of the chosen packs' controls (before), sorted. */
  export function areaOptions(scope: ScopeItem[], packControls: { processArea: string; packId: string }[], packIds: string[]): string[];
  /** Client-side problems before a save, mirroring the server's limits; [] when fine. */
  export function contextProblems(input: { factors: ContextFactor[]; background: string }): string[];
  /** True once the engagement has an approved RCM gate. */
  export function contextLocked(gates: Gate[]): boolean;
  /** Areas raised by the context, with library and assessed ratings, for the risk table. */
  export function raisedAreas(scope: ScopeItem[]): { processArea: string; library: RiskRating; assessed: RiskRating; factors: string[] }[];
  ```
- `ContextForm` props: `{ engagement: Engagement; locked: boolean; areas: string[]; onSaved: (e: Engagement) => void }`. `MemoView` props: `{ memo: JudgmentMemo }` and renders `forTheReviewer` first as an `Alert severity="info"`, then one block per call (question, decision as a chip-like bold line, rationale, basis as a small list, standards as `IIA 13.2` captions).

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/judgment.test.ts
import { describe, expect, it } from 'vitest';
import { areaOptions, contextLocked, contextProblems, raisedAreas } from './judgment';
import type { Gate, ScopeItem } from './types';

const item = (controlId: string, processArea: string, inherentRisk: 'High' | 'Medium' | 'Low', assessedRisk = inherentRisk, riskFactors: string[] = []) =>
  ({ controlId, processArea, inherentRisk, assessedRisk, riskFactors, packId: 'common', risk: '', relevance: 0, rationale: '', citations: [], included: true }) as ScopeItem;

describe('context helpers', () => {
  it('offers the areas of the scope when there is one, else those of the chosen packs', () => {
    expect(areaOptions([item('A', 'Lab', 'Low')], [{ processArea: 'QA', packId: 'common' }], ['common'])).toEqual(['Lab']);
    expect(areaOptions([], [{ processArea: 'QA', packId: 'common' }, { processArea: 'HACCP', packId: 'food' }], ['common'])).toEqual(['QA']);
  });

  it('mirrors the server limits', () => {
    expect(contextProblems({ factors: [], background: '' })).toEqual([]);
    expect(contextProblems({ factors: [{ kind: 'change', processAreas: [], description: '' }], background: '' })).toEqual(['Factor 1 needs a description']);
    expect(contextProblems({ factors: [], background: 'x'.repeat(4001) })[0]).toMatch(/4000/);
  });

  it('locks after an approved RCM gate and lists the raised areas', () => {
    expect(contextLocked([{ kind: 'rcm', state: 'open' } as Gate])).toBe(false);
    expect(contextLocked([{ kind: 'rcm', state: 'approved' } as Gate])).toBe(true);
    const rows = raisedAreas([item('A', 'Lab', 'Low', 'High', ['New LIMS']), item('B', 'Lab', 'Medium', 'High', ['New LIMS']), item('C', 'QA', 'High')]);
    expect(rows).toEqual([{ processArea: 'Lab', library: 'Medium', assessed: 'High', factors: ['New LIMS'] }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/judgment.test.ts`
Expected: FAIL with "Failed to resolve import './judgment'".

- [ ] **Step 3: Implement `judgment.ts`**, then the components:
  - `ContextForm`: a `Card variant="outlined"` titled "Engagement context", a table of factors (kind `Select` with `FACTOR_LABELS`, areas as a multi-`Select` from `areas`, description `TextField`), add/remove rows, the background `TextField multiline`, and a `Save context` `ActionButton` that `PUT`s `/engagements/${id}/context` with `ifMatch` and calls `onSaved`. When `locked`, fields are read-only and a caption says "Locked: the scope and RCM are approved." Show `contextProblems` under the button and disable it when any.
  - `ScopeTab`: `ContextForm` above the run button (pass `locked` from `contextLocked(gates)`; load pack controls once with `api('/packs/:id')` for the chosen packs for `areaOptions`); a new column "Assessed risk" (`RiskChip` plus a tooltip listing `riskFactors` when any); a "Risk assessment" card from `raisedAreas` shown only when non-empty; a "Coverage" card with `coverage.statement` and the exclusions table when `e.coverage`.
  - `GateList`: above `QaReportView`, `{gate.kind === 'scope' && engagement.memos.scope && <MemoView memo={engagement.memos.scope} />}` (the list needs the engagement; thread it from `RunPanel` as the gates and settings are threaded today). Finding, RCM and report memos arrive in 8B/8C; render whatever `engagement.memos[gate.subjectKey]` holds when present, so later plans only add data.
  - `api.ts`: `CONTEXT_LOCKED: 'The scope and RCM are approved, so the engagement context can no longer change. Record late matters in the relevant finding, or start a new engagement.'`

- [ ] **Step 4: Run the frontend checks**

Run: `cd frontend && npm run typecheck && npx vitest run && npm run build`
Expected: typecheck clean, 42+ tests pass, build passes.

- [ ] **Step 5: Look at it.** Run the stack (`docker compose up` per the README quick start, or the two dev servers) with the seed, open an engagement, add a factor for a HACCP area, save, run the scope, and confirm: the assessed-risk column moved for that area, the Risk assessment card lists it, the Coverage card shows, and after starting an agent run the scope gate shows the memo above the QA review. No console errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "feat(ui): engagement context form, assessed scope with coverage, and the judgment memo on the scope gate"
```

---

### Task 9: Requirements, docs and the CI run

**Files:**
- Modify: `backend/validation/requirements.json`, `README.md:257-268` (agent runs section) and `README.md` packs section, `docs/deploy/operations.md` (no new verify messages in 8A; add one line under the agent runbook that a context change after the scope gate reopens it and is refused after the RCM gate)
- Test: none new; `npm run traceability` is the check.

- [ ] **Step 1: Add the requirements** to `backend/validation/requirements.json`, after REQ-30:

```json
{ "id": "REQ-31", "risk": "High", "text": "Every judgment the agent makes is recorded with its basis and rationale in a memo that is part of the subject the signer approves.", "evalKinds": [] },
{ "id": "REQ-35", "risk": "Medium", "text": "The engagement context is written only by people, and a change to it after the scope gate reopens the scope.", "evalKinds": [] }
```

(REQ-32 to REQ-34 are added by plan 8B with their tests; ids are reserved by the spec.)

- [ ] **Step 2: Docs.** README agent section: one paragraph that the auditor records the engagement context (changes, incidents, regulatory actions, prior findings, complexity) on the Scope tab, the agent assesses risk per area from it and explains its scope in a memo the signer reads on the gate, and the context locks once the RCM gate is approved. Packs section: the `iia` methodology pack, draft summaries, never an engagement pack. `operations.md` agent runbook: the one line above.

- [ ] **Step 3: Run everything CI runs**

```bash
# backend/
npm run typecheck && npm test && ALLOW_UNVERIFIED_CITATIONS=true npm run eval && npm run traceability && npm audit --omit=dev --audit-level=high
# frontend/
npm run typecheck && npm test && npm run build && npm audit --omit=dev --audit-level=high
# repo root
docker build -t audit-platform-backend:ci backend && docker build -f frontend/Dockerfile -t audit-platform-frontend:ci . && docker compose --env-file .env.example config --quiet
```

Expected: every command exits 0; the traceability matrix lists REQ-31 and REQ-35 with the Task 7 tests; the eval shows both agent traces passing unchanged.

- [ ] **Step 4: Commit**

```bash
git add backend/validation/requirements.json README.md docs/deploy/operations.md
git commit -m "docs: engagement context, the IIA pack and the scope memo; REQ-31 and REQ-35"
```

---

## Self-review notes

- **Spec coverage (8A scope):** §3.1 (Tasks 1, 2, 7, 8), §3.2 scope fields (Tasks 1, 5), §3.4 (Tasks 1, 3), §4 (Task 4; the trust exemption is moot because the pack is never cited by a finding, Ruling 6), §5.1 (Tasks 2, 5, 6), §5.2 (Tasks 3, 5, 6), §6 memos to the policy and the hostile-memo injection case are **8C**, §7 context and memos endpoints and the Scope tab and gate panel (Tasks 7, 8), §8 unit, injection (model bounds in Task 5; hostile memo in 8C), integration (Task 7), eval unchanged (Task 5), §9 REQ-31 and REQ-35 (Tasks 7, 9).
- **Deferred to 8B/8C on purpose:** RCM `assessedRisk`, sampling, tolerances, severity, findings, responses, opinion, memos for other subjects, the `judgment` eval kind, `verify` additions.
- **Type consistency:** `EngagementContextInput` (Task 2) is what `NewEngagement.context`, `setEngagementContext` and the route schema take (Task 7); `Candidate` (Task 3) is built in `scope.ts` (Task 5); `reviewSubject(e, key, knownAreas?)` (Task 6) is the only signature change in QA.
