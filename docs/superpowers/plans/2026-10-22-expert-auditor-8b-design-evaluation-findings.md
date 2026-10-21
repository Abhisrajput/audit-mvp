# Expert Auditor 8B: Test Design, Evaluation, Findings and Responses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Findings carry rating logic (likelihood × impact), a root cause and a tailored recommendation; test plans carry a sampling rationale and a recommended tolerance only a person can apply; test results carry a severity; management responses are recorded outside the signed finding; and each of those judgments has a memo the signer reads.

**Architecture:**
- **Three more pure judgment modules** in `backend/src/judgment/`: `sampling.ts` (§5.3), `evaluation.ts` (§5.4), `finding.ts` (§5.5). The RCM module, the test-plan specialist, the testing module and the gap writer call them. The graph, menu, gates and worker are untouched, so the golden traces do not change.
- **Two person-made records live in their own append-only tables** (`test_tolerances`, `finding_responses`, spec §3.3), loaded into the engagement view (`Engagement.tolerances`, `Engagement.responses`, latest per key) and never saved from it. No workpaper hash covers them; the report *basis* covers responses, so recording one reopens the report, as the spec asks.
- **Memos travel with their subject.** `memos.rcm` and `memos.test_plans` sit on the engagement like `memos.scope`; a finding's memo sits on the finding (`Finding.memo`) because a finding is loaded, hashed and signed on its own.
- **Backward compatibility is exact:** a row, plan, result or finding written before 8B has none of the new fields (they are optional in the types and appear only on a redraft), and every hash and basis equals today's when the new fields are absent. Readers fall back (`assessedRisk ?? riskRating`); QA checks that need a new field stay silent without it.
- **Tighten-only overlays, as in 8A:** every refused model proposal is a `judgment-bounds` gate action in the module's trail bundle, or a `forTheReviewer` line where there is no bundle (test plans).

**Tech Stack:** Node 22, TypeScript, Express 5, Kysely + Postgres 16, zod 4 (backend). React 18, MUI 5, Vite, vitest in a node environment (frontend). **No new dependencies** in either package.

**Spec:** `docs/superpowers/specs/2026-10-21-expert-auditor-design.md`. This plan implements §3.2 (RCM, plan, result and finding fields), §3.3, §5.3, §5.4, §5.5, the matching rows of §7 and §8, the `verify` additions of §9, and REQ-32, REQ-33, REQ-34; it is plan 8B in §10. It builds on plan 8A (`docs/superpowers/plans/2026-10-21-expert-auditor-8a-context-risk-scope.md`, merged into this branch at a2be88c), whose decisions §12 of the spec now records.

## Global Constraints

- **No new npm dependencies**, backend or frontend. No DOM testing library: frontend logic that needs a test lives in a pure module under `frontend/src/` (`judgment.ts`, `agents.ts`) and is tested under node.
- **Code style follows the surrounding files:** plain-language comments naming the spec section, the private `blocking(...)`/`advisory(...)` helpers in `agents/qa/deterministic.ts`, `ctx.gate({ gate: 'judgment-bounds', outcome: 'fail', target, detail, action: 'blocked' })` for a refused overlay, MUI `variant="outlined"` cards and `size="small"` chips.
- **Tests never call a real model.** Use `FakeProvider` from `backend/tests/helpers.ts`. Never use fake timers.
- **Exact hash compatibility** (the rule 8A set, extended): with none of the new fields present, `workpaperContentHash('rcm' | 'test_plans', e)`, `rcmRowHash(row)`, `findingContentHash(f)`, `rowBasis` and the report basis are byte-identical to today's. New fields appear only when a module redrafts; nothing is normalised on load or backfilled.
- **Values copied from the spec:**
  - §3.3: `test_tolerances.rate numeric(4,3) CHECK (rate >= 0 AND rate <= 0.25)`; `finding_responses.response IN ('agree', 'partially_agree', 'disagree')`; both tables append-only, keyed by `control_id` / `finding_id`, latest row in force; `trail_bundle_id text NOT NULL`.
  - §3.3: a tolerance is refused once the control has a recorded test; a response needs an Approved finding and is refused once the report gate is approved; recording either goes through the engagement mutation path so a waiting run wakes.
  - §5.3: sample size is today's `SAMPLE_TABLE` keyed on `assessedRisk`; selection `all` for Annual or Quarterly, `judgemental` when an `incident` or `prior_finding` factor touches the area, else `random`; `recommendedToleranceRate` is **0** for a pharma or food pack row (by the row's `packId`) and for any High assessed area, **0.05** for common Medium, **0.10** for common Low; the rule never sets a tolerance.
  - §5.3 model: may raise the sample, may switch `random` to `judgemental`, may only lower the recommended tolerance. §5.3 QA: advisory when a plan is `random` for a row with an incident factor; advisory when a person's tolerance exceeds the recommendation.
  - §5.4: with a tolerance in force, `exceptions / sampleTested ≤ rate` concludes Effective and the result records `toleranceApplied`; severity `none` for 0 exceptions, `isolated` when exceptions = 1 or rate ≤ 0.10, `systemic` otherwise and always for Design deficient, `pervasive` only from the model; the model may only worsen severity. QA: advisory when the observation matches the negative-signal list and severity is `none`.
  - §5.5: `impact` Low→minor, Medium→moderate, High→major from the row's `assessedRisk`; `likelihood` `possible` for Design deficient or rate 0, `rare` for 0 < rate < 0.05, `likely` for rate ≥ 0.20, else `possible`; the matrix (major: Medium/High/High; moderate: Medium/Medium/High; minor: Low/Low/Low for rare/possible/likely); `rootCause` from the rule is `{ category: 'unknown', analysis: <today's placeholder>, confirmed: false }`; the rule's recommendation is the library text. `rating` is always the matrix; `editFinding` no longer accepts `rating`; people edit `likelihood` and `impact` in either direction and the memo names who changed what. The model may move likelihood or impact one step worse, fills `rootCause`, sets `confirmed: true` only when the observation states the cause, tailors the recommendation. QA: blocking when `rating ≠ matrix(likelihood, impact)`; blocking when `confirmed` and the observation does not mention the cause; advisory when the recommendation is still the library text verbatim for a confirmed cause.
  - §9 `verify`: each `finding_responses` and `test_tolerances` row names a trail entry of the matching human module for that finding or control; no response exists for a finding that was never Approved.
- **Fixed values decided here** (see Rulings):

  | Setting | Value |
  |---|---|
  | Migration | `backend/migrations/013_tolerances_responses.sql`: the two §3.3 tables, append-only triggers (`reject_change()`), `GRANT SELECT, INSERT ... TO audit_api` |
  | Engagement view | `Engagement.tolerances: Record<controlId, Tolerance>`, `Engagement.responses: Record<findingId, FindingResponse>` (latest per key), filled by `loadEngagement`, ignored by `saveEngagement` |
  | Trail module ids | `human:set-tolerance` (inputs `{ controlId, rate }`), `human:management-response` (inputs `{ findingId, response, owner, dueDate, actionPlan }`) |
  | Error codes (409) | `TOLERANCE_LOCKED` (control has a recorded test), `FINDING_NOT_APPROVED`, `RESPONSE_LOCKED` (report gate approved) |
  | Memo keys | `e.memos.rcm`, `e.memos.test_plans`; `Finding.memo` for `finding:<rowId>` |
  | `rcm` content hash | `!e.memos?.rcm ? e.rcm : { rows: e.rcm, memo: e.memos.rcm }` |
  | `test_plans` content hash | `!e.memos?.test_plans ? e.testPlans ?? {} : { plans: e.testPlans ?? {}, memo: e.memos.test_plans }` |
  | Finding content hash | today's twelve fields plus `likelihood`, `impact`, `rootCause`, `memo` (absent ones are dropped by `canonicalJson`) — mirrored in `frontend/src/agents.ts#findingContentHash` |
  | Report basis | today's sorted `[{ id, hash }]` when `e.responses` is empty; otherwise `{ findings: <that array>, responses: sorted [{ findingId, id }] }` |
  | Sampling constants (`judgment/sampling.ts`) | `SAMPLE_TABLE` (moved from `rcm.ts`, re-exported there), `RECOMMENDED_TOLERANCE = { High: 0, Medium: 0.05, Low: 0.1 }`, `ZERO_TOLERANCE_PACKS = ['pharma', 'food']`, `TOLERANCE_MAX = 0.25` |
  | Evaluation constants (`judgment/evaluation.ts`) | `ISOLATED_MAX_RATE = 0.1`; `SEVERITIES = ['none', 'isolated', 'systemic', 'pervasive']` in worsening order |
  | Finding constants (`judgment/finding.ts`) | `RARE_BELOW = 0.05`, `LIKELY_FROM = 0.2`, `MATRIX`, `LIKELIHOODS = ['rare', 'possible', 'likely']`, `IMPACTS = ['minor', 'moderate', 'major']` (worsening order), `PLACEHOLDER_CAUSE` (today's sentence) |
  | Memo identity | `sameMemo(a, b)`: equal with `producedAt` blanked and the `EDITED_BY_HAND` line removed from both; used by every module's `apply` |

- **New types are optional where a row may predate 8B:** `RcmRow.assessedRisk?`, `RcmRow.samplingRationale?`, `TestPlan.recommendedToleranceRate?`, `TestResult.severity?`, `TestResult.severityRationale?`, `TestResult.toleranceApplied?`, `Finding.likelihood?`, `Finding.impact?`, `Finding.rootCause?`, `Finding.memo?`. Each carries the doc comment "absent on rows written before 8B". `Engagement.tolerances` and `Engagement.responses` are required (always loaded).
- **Requirement tags:** `[REQ-32]` (tighten-only, relaxations by people, trailed and named), `[REQ-33]` (tolerance), `[REQ-34]` (responses) inside `it('...')` titles, plus existing ids where they apply (`[REQ-30]` QA, `[REQ-31]` memo on the subject). Task 1 adds the three ids to `backend/validation/requirements.json`, so `npm run traceability` may run from any task on.
- **Commands:**
  - Backend, from `backend/`: `npx vitest run <files>` needs Docker (Testcontainers). `npm run typecheck` covers only `src/`, so every backend task also runs the test files it touches. `ALLOW_UNVERIFIED_CITATIONS=true npm run eval` must keep printing both agent traces as PASS with their existing files.
  - Frontend, from `frontend/`: `npm run typecheck && npx vitest run && npm run build`.
  - **No `git push` and no PR in this plan.** The user said GitHub Actions minutes are not available; verification is the local suites.
- **Commits** end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Implementer subagents use their own model's name.

## Rulings on the spec (decided here, recorded for the user)

1. **Optional new fields, not required ones with reader guards.** 8A made `ScopeItem.assessedRisk` required and then needed a fix wave of frontend guards for stored rows lacking it. Here the new workpaper fields are optional in the types and every reader falls back; the "pre-8B row" case is then a type, not a convention.
2. **The finding memo lives on the finding.** A finding is loaded from its own table, hashed by `findingContentHash` and signed on its own; the gate and the signature can only cover a memo that is in that hash. `GET /memos/finding:<rowId>` serves it from the finding. `Engagement.memos` keeps `scope`, `rcm` and `test_plans`.
3. **Tolerances and responses are read-only members of the engagement view.** `loadEngagement` fills them from the two tables; `saveEngagement` never writes them; the service writes a row and the trail entry inside the same `mutate`. `assertWithinRails` asserts both unchanged, so the agent path cannot touch them even in memory.
4. **The report basis changes only when a response exists**, so every approved report from before 8B stays current on deploy. The report *markdown* (opinion, response table) is plan 8C.
5. **"Population is at most the sample" is not decidable** (populations are free text), so `all` comes from frequency alone (Annual, Quarterly). The memo says so.
6. **Test-plan refusals go into the plans memo.** The specialist has no module bundle, so a model proposal outside the bounds (a lower sample, a switch other than random→judgemental, a higher tolerance) is kept out and named in `memos.test_plans.forTheReviewer`.
7. **The gaps model no longer returns `rating`.** Its schema gains `likelihood?`, `impact?` and `rootCause`; the rating is always the matrix. Tests that sent `rating` to `PUT /findings/:fid` are rewritten to send `likelihood`/`impact`; a body with `rating` is a 400.
8. **`rate()` in `gaps.ts` is deleted**, and the legacy rule is kept verbatim inside the Task 2 test as `legacyRate` to prove the matrix reproduces it for every combination.
9. **Memo identity ignores the hand-edit line** (an 8A carry-over): otherwise one hand edit makes every later no-op redraft a new hash.
10. **No golden-trace change.** Tasks 4, 5, 6 and 7 run the eval; both agent traces must pass with their existing files. If a trace changes, the task is wrong.
11. **Carried from 8A into this plan:** "the whole entity" wording in the scope memo for a factor with no process areas (Task 3). Left out: a cap on model exclusion reasons; `decidedBy` hash exclusion and trail backfill.

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely to bite first. Each has its test in the owning task.

1. A finding drafted before 8B (no `likelihood`/`impact`) passes the finding QA with no new issue, so open engagements' finding gates do not jam on deploy. (Task 6)
2. `PUT /findings/:fid` with `rating` in the body is a 400, and existing API tests that sent it are rewritten, not loosened. (Task 6)
3. A tolerance set before an RCM rebuild is still in force after it (keyed by control id), and refused once that control has a recorded test. (Task 5)
4. A person lowers `likelihood` on a draft finding: the rating is recomputed from the matrix, QA passes, and the memo names who changed what. (Task 6)
5. The RCM, test plans, finding and report hashes and bases of an engagement with none of the new fields equal today's values. (Tasks 3 and 7)

---

### Task 1: Types, migration 013, the two record tables and the requirements

**Files:**
- Modify: `backend/src/engine/types.ts` (RcmRow, TestPlan, TestResult, Finding, Engagement, new types), `backend/src/db/schema.ts` (two tables, `DB`), `backend/src/db/engagement-repo.ts` (`loadEngagement` fills the two maps), `backend/src/errors.ts` (three codes), `backend/validation/requirements.json`, `backend/tests/db-roles.test.ts:23-26` (inventory map), `backend/tests/agent-fixtures.ts` (`engagement()` gets `tolerances: {}`, `responses: {}`)
- Create: `backend/migrations/013_tolerances_responses.sql`, `backend/src/db/judgment-repo.ts`
- Test: `backend/tests/judgment-records.test.ts`

**Interfaces:**
- Produces (in `types.ts`):
  ```ts
  export type Severity = 'none' | 'isolated' | 'systemic' | 'pervasive';
  export type Likelihood = 'rare' | 'possible' | 'likely';
  export type Impact = 'minor' | 'moderate' | 'major';
  export type RootCauseCategory = 'people' | 'process' | 'system' | 'governance' | 'unknown';
  export interface RootCause { category: RootCauseCategory; analysis: string; confirmed: boolean }
  export interface Tolerance { controlId: string; rate: number; recordedBy: string; recordedAt: string; trailBundleId: string }
  export type ResponseKind = 'agree' | 'partially_agree' | 'disagree';
  export interface FindingResponse { id: string; findingId: string; response: ResponseKind; owner: string; dueDate: string | null; actionPlan: string; recordedBy: string; recordedAt: string; trailBundleId: string }
  ```
  plus the optional fields listed in Global Constraints and `Engagement.tolerances`, `Engagement.responses`.
- Produces (in `judgment-repo.ts`):
  ```ts
  export async function insertTolerance(db: Executor, engagementId: string, t: Tolerance & { id: string }): Promise<void>;
  export async function tolerancesFor(db: Executor, engagementId: string): Promise<Record<string, Tolerance>>;        // latest per controlId
  export async function insertResponse(db: Executor, engagementId: string, r: FindingResponse): Promise<void>;
  export async function responsesFor(db: Executor, engagementId: string): Promise<Record<string, FindingResponse>>;   // latest per findingId
  export async function responseHistory(db: Executor, engagementId: string, findingId: string): Promise<FindingResponse[]>; // oldest first
  ```
  `Executor` is whatever type `engagement-repo.ts` uses for its `db` parameter (a `Kysely<DB>` or a transaction); use the same.
- `errors.ts`: `'TOLERANCE_LOCKED' | 'FINDING_NOT_APPROVED' | 'RESPONSE_LOCKED'` join the `ErrorCode` union.
- `requirements.json` gains, after REQ-31 and before REQ-35 (keep the one-entry-per-line style and the trailing-comma rule the file uses):
  ```
  { "id": "REQ-32", "risk": "High", "text": "Offline, every judgment is a deterministic rule; a model may only tighten a judgment (raise a risk, worsen a severity or an opinion, add an issue), never relax one. Only a person relaxes one, and each relaxation is trailed and named in the memo.", "evalKinds": [] },
  { "id": "REQ-33", "risk": "High", "text": "A test conclusion accepts exceptions only within a tolerance a person set for that control, recorded outside the signed workpapers; the agent never sets a tolerance.", "evalKinds": [] },
  { "id": "REQ-34", "risk": "Medium", "text": "Management responses are recorded outside signed finding content; recording one never alters a signed finding or breaks its signature.", "evalKinds": [] },
  ```

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/judgment-records.test.ts
import { describe, expect, it } from 'vitest';
import { loadEngagement } from '../src/db/engagement-repo';
import { insertResponse, insertTolerance, responseHistory, responsesFor, tolerancesFor } from '../src/db/judgment-repo';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

describe('tolerances and management responses (spec §3.3)', () => {
  it('keeps the latest row per control and per finding, loads them into the engagement, and never updates or deletes a row', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const k = svc.db.kysely;
    expect((await loadEngagement(k, e.id))!.engagement).toMatchObject({ tolerances: {}, responses: {} });
    await insertTolerance(k, e.id, { id: 't1', controlId: 'FD-HACCP-03', rate: 0.05, recordedBy: 'auditor', recordedAt: '2026-10-22T00:00:00.000Z', trailBundleId: 'b1' });
    await insertTolerance(k, e.id, { id: 't2', controlId: 'FD-HACCP-03', rate: 0.1, recordedBy: 'auditor', recordedAt: '2026-10-22T00:00:01.000Z', trailBundleId: 'b2' });
    expect((await tolerancesFor(k, e.id))['FD-HACCP-03']).toMatchObject({ rate: 0.1, trailBundleId: 'b2' });
    await insertResponse(k, e.id, { id: 'r1', findingId: 'F-1', response: 'disagree', owner: 'Plant manager', dueDate: null, actionPlan: '', recordedBy: 'auditor', recordedAt: '2026-10-22T00:00:00.000Z', trailBundleId: 'b3' });
    await insertResponse(k, e.id, { id: 'r2', findingId: 'F-1', response: 'agree', owner: 'Plant manager', dueDate: '2026-12-31', actionPlan: 'Retrain the line leads', recordedBy: 'auditor', recordedAt: '2026-10-22T00:00:01.000Z', trailBundleId: 'b4' });
    expect((await responsesFor(k, e.id))['F-1']).toMatchObject({ response: 'agree', dueDate: '2026-12-31' });
    expect((await responseHistory(k, e.id, 'F-1')).map((r) => r.id)).toEqual(['r1', 'r2']);
    const loaded = (await loadEngagement(k, e.id))!.engagement;
    expect(loaded.tolerances['FD-HACCP-03'].rate).toBe(0.1);
    expect(loaded.responses['F-1'].response).toBe('agree');
    await expect(k.updateTable('test_tolerances').set({ rate: 0 }).where('id', '=', 't1').execute()).rejects.toThrow();
    await expect(k.deleteFrom('finding_responses').where('id', '=', 'r1').execute()).rejects.toThrow();
    await expect(insertTolerance(k, e.id, { id: 't3', controlId: 'X', rate: 0.3, recordedBy: 'auditor', recordedAt: '2026-10-22T00:00:02.000Z', trailBundleId: 'b5' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run tests/judgment-records.test.ts`
Expected: FAIL (module `judgment-repo` not found).

- [ ] **Step 3: Write the migration** `013_tolerances_responses.sql`: the two `CREATE TABLE`s from spec §3.3 verbatim (with their indexes), then for each table the two append-only triggers in the pattern of migration 010 (`<table>_append_only BEFORE UPDATE OR DELETE ... reject_change()`, `<table>_no_truncate BEFORE TRUNCATE ...`), then `GRANT SELECT, INSERT ON test_tolerances, finding_responses TO audit_api;`. A header comment names spec §3.3 and says why the rows live outside the workpapers. `rate` is read back as a number (`numeric` comes out of pg as a string: parse it in the repo).

- [ ] **Step 4: Types, schema, repo, loader.** Add the types to `types.ts` next to the structures they extend, with the "absent on rows written before 8B" comment on each optional field. Add `TestTolerancesTable` and `FindingResponsesTable` to `schema.ts` and `DB`. Write `judgment-repo.ts` per Interfaces ("latest per key" = order by `recorded_at, id` and let later rows overwrite earlier ones in the map). In `loadEngagement`, fill `tolerances` and `responses` with the two queries; `insertEngagement`/`saveEngagement` do not touch them. Add the three error codes. Add the three requirements. Add both tables to `db-roles.test.ts` as `'append'`.

- [ ] **Step 5: Fix every compile error** from the two new required `Engagement` fields (`npm run typecheck`, then `npx vitest run tests/agent-fixtures.ts tests/engine.test.ts tests/agent-qa.test.ts tests/agent-eval.test.ts` to surface fixtures and the eval's in-memory engagements): `tolerances: {}`, `responses: {}`. Then `cd ../frontend && npm run typecheck` (frontend test literals build `Engagement`s too).

- [ ] **Step 6: Run the test, the suite and the traceability**

Run: `cd backend && npm run typecheck && npx vitest run && npm run traceability`
Expected: `judgment-records.test.ts` passes; the suite still passes (604 tests before this task); traceability lists REQ-32, REQ-33 and REQ-34 as not yet covered (no error).

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/013_tolerances_responses.sql backend/src backend/validation/requirements.json backend/tests
git commit -m "feat(judgment): tolerance and management-response tables, judgment fields on rows, plans, results and findings"
```

---

### Task 2: Sampling, evaluation and finding rules (pure)

**Files:**
- Create: `backend/src/judgment/sampling.ts`, `backend/src/judgment/evaluation.ts`, `backend/src/judgment/finding.ts`
- Modify: `backend/src/engine/modules/rcm.ts:1-30` (`SAMPLE_TABLE` and `sampleSize` move to `sampling.ts`; `rcm.ts` re-exports `sampleSize` so existing imports stand)
- Test: `backend/tests/judgment-rules-8b.test.ts`

**Interfaces:**
- Produces (`sampling.ts`):
  ```ts
  export const SAMPLE_TABLE: Record<Frequency, [number, number]>;                  // today's table, verbatim
  export function sampleSize(frequency: Frequency, risk: RiskRating): number;      // today's function, now keyed by the caller on assessedRisk
  export const RECOMMENDED_TOLERANCE: Record<RiskRating, number>;                 // High 0, Medium 0.05, Low 0.1
  export const ZERO_TOLERANCE_PACKS: readonly string[];                            // ['pharma', 'food']
  export const TOLERANCE_MAX = 0.25;
  export type Selection = TestPlan['selectionMethod'];
  export function selectionFor(row: Pick<RcmRow, 'frequency' | 'processArea'>, context: EngagementContext | null): { method: Selection; reason: string };
  export function recommendedTolerance(row: Pick<RcmRow, 'packId'>, assessedRisk: RiskRating): number;
  export function samplingRationale(row: Pick<RcmRow, 'frequency'>, assessedRisk: RiskRating, size: number, selection: { method: Selection; reason: string }): string;   // one fixed sentence
  export function acceptsSelection(rule: Selection, proposed: Selection): boolean;   // only random → judgemental
  ```
- Produces (`evaluation.ts`):
  ```ts
  export const SEVERITIES: readonly Severity[];        // worsening order
  export const ISOLATED_MAX_RATE = 0.1;
  export function severityOf(result: Pick<TestResult, 'conclusion' | 'exceptionRate'>, input: Pick<TestInput, 'exceptions'> | undefined): { severity: Severity; rationale: string };
  export function worsens(rule: Severity, proposed: Severity): boolean;             // strictly later in SEVERITIES
  export function toleratedEffective(exceptions: number, sampleTested: number, rate: number): boolean;   // rate > 0 && exceptions / sampleTested <= rate
  ```
- Produces (`finding.ts`):
  ```ts
  export const LIKELIHOODS: readonly Likelihood[]; export const IMPACTS: readonly Impact[];   // worsening order
  export const RARE_BELOW = 0.05; export const LIKELY_FROM = 0.2;
  export const MATRIX: Record<Impact, Record<Likelihood, RiskRating>>;
  export const PLACEHOLDER_CAUSE = 'Root cause to be confirmed with the process owner at the exit meeting.';
  export function impactOf(assessedRisk: RiskRating): Impact;
  export function likelihoodOf(result: Pick<TestResult, 'conclusion' | 'exceptionRate'>): Likelihood;
  export function ratingOf(likelihood: Likelihood, impact: Impact): RiskRating;
  export function oneStepWorse<T extends Likelihood | Impact>(order: readonly T[], rule: T, proposed: T): boolean;   // exactly one step later in `order`
  export const CAUSE_STOP_WORDS: readonly string[];   // audit-common words that cannot confirm a cause on their own: control, controls, process, because, performed, recorded, evidence, review, reviewed, sample, sampled, exception, exceptions, testing, tested, finding, procedure, management, monthly, quarterly, during, period, without, should
  export function causeSupported(observation: string, analysis: string): boolean;   // ≥ 1 shared word of ≥ 6 letters, case-insensitive, not in CAUSE_STOP_WORDS — the string-overlap check of §5.5
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// backend/tests/judgment-rules-8b.test.ts
import { describe, expect, it } from 'vitest';
import { acceptsSelection, recommendedTolerance, sampleSize, selectionFor, SAMPLE_TABLE } from '../src/judgment/sampling';
import { severityOf, toleratedEffective, worsens } from '../src/judgment/evaluation';
import { causeSupported, impactOf, likelihoodOf, MATRIX, oneStepWorse, ratingOf, IMPACTS, LIKELIHOODS } from '../src/judgment/finding';
import type { RcmRow, RiskRating, TestResult } from '../src/engine/types';

const ctx = (kind: 'incident' | 'prior_finding' | 'change', area: string) => ({ factors: [{ kind, processAreas: [area], description: 'x' }], background: '', updatedBy: 'u', updatedAt: 't' });

// Today's gaps.ts rule, kept here verbatim so the matrix is proven against it (plan Ruling 8).
function legacyRate(row: Pick<RcmRow, 'riskRating'>, result: Pick<TestResult, 'conclusion' | 'exceptionRate'>): RiskRating {
  if (result.conclusion === 'Design deficient') return row.riskRating;
  const r = result.exceptionRate ?? 0;
  if (row.riskRating === 'Medium' && r >= 0.2) return 'High';
  if (row.riskRating === 'High' && r > 0 && r < 0.05) return 'Medium';
  return row.riskRating;
}

describe('sampling (spec §5.3)', () => {
  it('keys the table on the rating it is given, selects by frequency and factors, and recommends tolerance by pack and risk [REQ-32]', () => {
    expect(sampleSize('Daily', 'High')).toBe(SAMPLE_TABLE.Daily[1]);
    expect(sampleSize('Daily', 'Low')).toBe(SAMPLE_TABLE.Daily[0]);
    expect(selectionFor({ frequency: 'Quarterly', processArea: 'HACCP' }, null).method).toBe('all');
    expect(selectionFor({ frequency: 'Daily', processArea: 'HACCP' }, null).method).toBe('random');
    expect(selectionFor({ frequency: 'Daily', processArea: 'HACCP' }, ctx('incident', 'HACCP')).method).toBe('judgemental');
    expect(selectionFor({ frequency: 'Daily', processArea: 'HACCP' }, ctx('change', 'HACCP')).method).toBe('random');
    expect(recommendedTolerance({ packId: 'pharma' }, 'Low')).toBe(0);
    expect(recommendedTolerance({ packId: 'common' }, 'High')).toBe(0);
    expect(recommendedTolerance({ packId: 'common' }, 'Medium')).toBe(0.05);
    expect(recommendedTolerance({ packId: 'common' }, 'Low')).toBe(0.1);
    expect(acceptsSelection('random', 'judgemental')).toBe(true);
    expect(acceptsSelection('all', 'random')).toBe(false);
    expect(acceptsSelection('judgemental', 'random')).toBe(false);
  });
});

describe('severity (spec §5.4)', () => {
  it('follows the count and rate boundaries, is systemic for a design deficiency, and only worsens', () => {
    const r = (conclusion: TestResult['conclusion'], exceptionRate: number | null) => ({ conclusion, exceptionRate });
    expect(severityOf(r('Effective', 0), { exceptions: 0 }).severity).toBe('none');
    expect(severityOf(r('Ineffective', 0.5), { exceptions: 1 }).severity).toBe('isolated');
    expect(severityOf(r('Ineffective', 0.1), { exceptions: 3 }).severity).toBe('isolated');
    expect(severityOf(r('Ineffective', 0.101), { exceptions: 3 }).severity).toBe('systemic');
    expect(severityOf(r('Design deficient', null), { exceptions: 0 }).severity).toBe('systemic');
    expect(worsens('isolated', 'pervasive')).toBe(true);
    expect(worsens('systemic', 'isolated')).toBe(false);
    expect(toleratedEffective(1, 40, 0.05)).toBe(true);
    expect(toleratedEffective(3, 40, 0.05)).toBe(false);
    expect(toleratedEffective(1, 40, 0)).toBe(false);
  });
});

describe('finding rating (spec §5.5)', () => {
  it('reproduces today\'s rating rule for every row rating, conclusion and exception rate with no context [REQ-32]', () => {
    const rates = [null, 0, 0.01, 0.049, 0.05, 0.1, 0.199, 0.2, 0.5, 1];
    for (const riskRating of ['High', 'Medium', 'Low'] as const) {
      for (const conclusion of ['Ineffective', 'Design deficient'] as const) {
        for (const exceptionRate of rates) {
          const result = { conclusion, exceptionRate: conclusion === 'Design deficient' ? null : exceptionRate };
          expect(ratingOf(likelihoodOf(result), impactOf(riskRating)), `${riskRating} ${conclusion} ${exceptionRate}`).toBe(legacyRate({ riskRating }, result));
        }
      }
    }
    expect(MATRIX.major.possible).toBe('High');
    expect(MATRIX.minor.likely).toBe('Low');
  });

  it('accepts a one-step worse move only, and supports a cause only when the observation mentions it', () => {
    expect(oneStepWorse(LIKELIHOODS, 'rare', 'possible')).toBe(true);
    expect(oneStepWorse(LIKELIHOODS, 'rare', 'likely')).toBe(false);
    expect(oneStepWorse(IMPACTS, 'moderate', 'minor')).toBe(false);
    expect(causeSupported('The reconciliation was not performed because the preparer left in March', 'A vacancy: the preparer left and the task was not reassigned')).toBe(true);
    expect(causeSupported('Two deviations in March', 'Inadequate supervision of temporary staff')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/judgment-rules-8b.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the three modules** per Interfaces and the Global Constraints values. Move `SAMPLE_TABLE` and `sampleSize` into `sampling.ts` and re-export from `rcm.ts` (`export { sampleSize } from '../../judgment/sampling'`). `selectionFor` reads `factorsFor(context, processArea)` from `judgment/context.ts` and names the factor in `reason`. `samplingRationale` is one sentence: frequency, assessed risk, the table cell, the selection reason (and, for `all`, that the population count is not recorded so frequency decides, Ruling 5).

- [ ] **Step 4: Run the tests and the module suites that import `sampleSize`**

Run: `cd backend && npx vitest run tests/judgment-rules-8b.test.ts tests/engine.test.ts tests/workpapers.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/judgment backend/src/engine/modules/rcm.ts backend/tests/judgment-rules-8b.test.ts
git commit -m "feat(judgment): sampling, severity and finding-rating rules"
```

---

### Task 3: Memos for the RCM, the plans and the finding; hashes and bases

**Files:**
- Modify: `backend/src/judgment/memo.ts` (new builders, `sameMemo`, whole-entity wording), `backend/src/signing/content-hash.ts` (`findingContentHash`, `workpaperContentHash` rcm and test_plans branches), `backend/src/agents/subjects.ts` (`approvedFindingsBasis`), `backend/src/engine/modules/scope.ts:169-178` (`apply` uses `sameMemo`), `frontend/src/agents.ts:304` (the hash mirror)
- Test: `backend/tests/judgment-memo.test.ts`, `backend/tests/signing-store.test.ts` (extend), `frontend/src/agents.test.ts` (extend)

**Interfaces:**
- Produces (`memo.ts`):
  ```ts
  export function sameMemo(a: JudgmentMemo | undefined, b: JudgmentMemo | undefined): boolean;
  export function rcmMemo(input: { rows: RcmRow[]; scope: ScopeItem[]; context: EngagementContext | null; producedAt: string }): JudgmentMemo;
  //   one call per row whose assessedRisk differs from riskRating (sample size named), one summary call; standard IIA.resources
  export function planMemo(input: { plans: Record<string, TestPlan>; rows: RcmRow[]; context: EngagementContext | null; refusals: string[]; modelChanges: string[]; producedAt: string }): JudgmentMemo;
  //   one call per plan whose selection is not random (reason) and one per non-zero recommended tolerance; refusals → forTheReviewer; standard IIA.workProgram
  export function findingMemo(input: { finding: Pick<Finding, 'rowId' | 'likelihood' | 'impact' | 'rating' | 'rootCause' | 'recommendation'>; row: Pick<RcmRow, 'assessedRisk' | 'riskRating' | 'control'>; result: Pick<TestResult, 'conclusion' | 'exceptionRate' | 'severity'>; libraryRecommendation: string; modelMoves: string[]; producedAt: string }): JudgmentMemo;
  //   three calls: rating (IIA.evaluation), root cause (IIA.analysis), recommendation (IIA.recommendations); each 'model' when the model changed it
  export function markEditedByPerson(memo: JudgmentMemo, actor: string, changes: string[]): JudgmentMemo;
  //   adds or replaces one forTheReviewer line: `Edited by ${actor}: ${changes.join('; ')}.`
  ```
- Hashes and bases per the Global Constraints table. `frontend/src/agents.ts#findingContentHash` adds the same four optional fields in the same order.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/tests/judgment-memo.test.ts
import { describe, expect, it } from 'vitest';
import { EDITED_BY_HAND, findingMemo, markEditedByHand, markEditedByPerson, planMemo, rcmMemo, sameMemo, scopeMemo } from '../src/judgment/memo';
import { approvedFindingsBasis } from '../src/agents/subjects';
import { findingContentHash, workpaperContentHash } from '../src/signing/content-hash';
import { canonicalJson, sha256 } from '../src/engine/trail';
import { engagement, finding, plan, row, scopeItem } from './agent-fixtures';

describe('memo identity and the hand-edit line', () => {
  it('treats memos as the same when only producedAt or the hand-edit line differs', () => {
    const a = rcmMemo({ rows: [row('R1', { assessedRisk: 'High', riskRating: 'Medium' })], scope: [], context: null, producedAt: '2026-10-22T00:00:00.000Z' });
    const b = { ...a, producedAt: '2026-10-23T00:00:00.000Z' };
    expect(sameMemo(a, b)).toBe(true);
    expect(sameMemo(a, markEditedByHand(b))).toBe(true);
    expect(sameMemo(a, { ...b, calls: [] })).toBe(false);
    expect(markEditedByHand(markEditedByHand(a)).forTheReviewer.filter((l) => l === EDITED_BY_HAND)).toHaveLength(1);
    const p = markEditedByPerson(a, 'auditor', ['likelihood likely → rare']);
    expect(p.forTheReviewer.some((l) => l.startsWith('Edited by auditor:') && l.includes('likely → rare'))).toBe(true);
  });

  it('says "the whole entity" for a factor with no process areas', () => {
    const context = { factors: [{ kind: 'regulatory' as const, processAreas: [], description: 'New FSMA rule' }], background: '', updatedBy: 'u', updatedAt: 't' };
    const items = [scopeItem('A', true, { processArea: 'HACCP', inherentRisk: 'Medium', assessedRisk: 'High', riskFactors: ['New FSMA rule'] })];
    const memo = scopeMemo({ items, coverage: { excluded: [], statement: 's' }, context, unknownAreas: [], modelNotes: [], producedAt: 't' });
    expect(JSON.stringify(memo)).toMatch(/the whole entity/);
  });
});

describe('memos on the plan and the finding', () => {
  it('names the selection reasons, recommended tolerances and refusals for the plans; rating, cause and recommendation for a finding', () => {
    const rows = [row('R1', { frequency: 'Daily', assessedRisk: 'Medium', packId: 'common' })];
    const plans = { R1: plan('R1', { selectionMethod: 'judgemental', recommendedToleranceRate: 0.05 }) };
    const m = planMemo({ plans, rows, context: null, refusals: ['R1: the model proposed a tolerance of 0.2; kept 0.05'], modelChanges: [], producedAt: 't' });
    expect(m.subjectKey).toBe('test_plans');
    expect(m.calls.some((c) => c.decision.includes('judgemental'))).toBe(true);
    expect(m.calls.some((c) => c.decision.includes('5%') || c.decision.includes('0.05'))).toBe(true);
    expect(m.forTheReviewer).toContain('R1: the model proposed a tolerance of 0.2; kept 0.05');
    const f = finding('F1', { rowId: 'R1', likelihood: 'likely', impact: 'moderate', rating: 'High', rootCause: { category: 'process', analysis: 'No second check', confirmed: true } });
    const fm = findingMemo({ finding: f, row: { assessedRisk: 'Medium', riskRating: 'Medium', control: 'Reconciliation' }, result: { conclusion: 'Ineffective', exceptionRate: 0.25, severity: 'systemic' }, libraryRecommendation: 'Reconcile monthly.', modelMoves: ['root cause'], producedAt: 't' });
    expect(fm.subjectKey).toBe('finding:R1');
    expect(fm.calls.map((c) => c.source)).toEqual(['rules', 'model', 'rules']);
    expect(fm.calls[0].decision).toMatch(/High/);
  });
});

describe('hashes and bases stay exact without the new fields (plan Review Focus 5)', () => {
  it('rcm and test_plans hash as today without a memo, and findings and the report basis as today without the new fields', () => {
    const e = engagement({ rcm: [row('R1')], testPlans: { R1: plan('R1') }, findings: [finding('F1', { status: 'approved' })] });
    expect(workpaperContentHash('rcm', e)).toBe(sha256(canonicalJson({ kind: 'rcm', content: e.rcm })));
    expect(workpaperContentHash('test_plans', e)).toBe(sha256(canonicalJson({ kind: 'test_plans', content: e.testPlans })));
    const withMemo = { ...e, memos: { rcm: rcmMemo({ rows: e.rcm, scope: [], context: null, producedAt: 't' }) } };
    expect(workpaperContentHash('rcm', withMemo)).not.toBe(workpaperContentHash('rcm', e));
    const f = e.findings[0];
    const { likelihood, impact, rootCause, memo, ...rest } = f as typeof f & { likelihood?: unknown; impact?: unknown; rootCause?: unknown; memo?: unknown };
    void likelihood; void impact; void rootCause; void memo;
    expect(findingContentHash(f)).toBe(findingContentHash(rest as typeof f));
    expect(findingContentHash({ ...f, likelihood: 'rare', impact: 'minor' })).not.toBe(findingContentHash(f));
    const legacyBasis = sha256(canonicalJson([{ id: 'F1', hash: findingContentHash(f) }]));
    expect(approvedFindingsBasis(e)).toBe(legacyBasis);
    const withResponse = { ...e, responses: { F1: { id: 'r1', findingId: 'F1', response: 'agree' as const, owner: 'o', dueDate: null, actionPlan: '', recordedBy: 'u', recordedAt: 't', trailBundleId: 'b' } } };
    expect(approvedFindingsBasis(withResponse)).not.toBe(legacyBasis);
  });
});
```

Add to `tests/signing-store.test.ts` one vector: a finding with `likelihood: 'rare'`, `impact: 'minor'`, `rootCause: { category: 'people', analysis: 'a', confirmed: false }` and a one-call memo, with its hex hash computed once and pasted as a constant; add the same finding and constant to `frontend/src/agents.test.ts` against the frontend `findingContentHash`, so the two copies are proven equal.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/judgment-memo.test.ts tests/signing-store.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement.** Memo builders per Interfaces, each call citing the `IIA` ids from `standards.ts`; `sameMemo` as the Global Constraints define it, and `scope.ts#apply` uses it instead of its inline comparison. `scopeMemo`: wherever a factor's areas are listed, an empty `processAreas` reads "the whole entity". Hashes and bases per the table. Frontend mirror in `agents.ts`.

- [ ] **Step 4: Run the tests on both sides**

Run: `cd backend && npx vitest run tests/judgment-memo.test.ts tests/signing-store.test.ts tests/judgment-scope.test.ts tests/workpapers.test.ts tests/gates.test.ts && npm run typecheck && cd ../frontend && npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/judgment/memo.ts backend/src/signing/content-hash.ts backend/src/agents/subjects.ts backend/src/engine/modules/scope.ts backend/tests frontend/src/agents.ts frontend/src/agents.test.ts
git commit -m "feat(judgment): memos for the RCM, the plans and findings; finding hash and report basis cover the new fields only when present"
```

---

### Task 4: The RCM module and the test-plan drafter use the sampling rules

**Files:**
- Modify: `backend/src/engine/modules/rcm.ts` (rows get `assessedRisk`, `samplingRationale`, sample keyed on assessed risk; `apply` writes `memos.rcm`), `backend/src/agents/specialists/test-plan.ts` (selection, recommended tolerance, model bounds, memo), `backend/src/agents/executor.ts:80-85` (passes the memo), `backend/src/service.ts#saveTestPlansAsAgent` (stores `memos.test_plans`), `backend/src/agents/port.ts` (the method's signature only; `AGENT_PORT_METHODS` unchanged), `backend/src/agents/qa/deterministic.ts#planIssues` (`plans.selection-incident`)
- Test: `backend/tests/judgment-sampling.test.ts`, `backend/tests/agent-test-plans.test.ts` (extend)

**Interfaces:**
- `rcmModule.run`: for each included scope item, `assessedRisk = scopeItem.assessedRisk ?? c.riskRating`, `sampleSize = sampleSize(c.frequency, assessedRisk)`, `samplingRationale = samplingRationale(...)` with `selectionFor(row, e.context)`; output becomes `{ rows: RcmRow[]; memo: JudgmentMemo }` and `apply` sets `e.rcm = rows` and `e.memos = { ...e.memos, rcm: sameMemo(e.memos.rcm, memo) ? e.memos.rcm : memo }`. The model schema is unchanged (text only).
- `test-plan.ts`: `draftTestPlans(e)` sets `selectionMethod` from `selectionFor` and `recommendedToleranceRate` from `recommendedTolerance(row, row.assessedRisk ?? row.riskRating)`; `ModelPlansSchema` plans gain `recommendedToleranceRate: z.number().min(0).max(TOLERANCE_MAX).optional()`; `applyModelPlans(base, rows, drafted)` returns `{ plans, refusals: string[], changes: string[] }`, keeping the sample floor, accepting a selection only through `acceptsSelection`, and `min(model, rule)` for the tolerance; `PlanDraft` gains `memo: JudgmentMemo` (`planMemo` with the refusals and changes).
- `saveTestPlansAsAgent(engagementId, plans, acting, opts, memo?: JudgmentMemo)` stores the memo under `memos.test_plans` (same `sameMemo` rule). `executor.ts` passes `draft.memo`.
- QA: `plans.selection-incident` (advisory) when a plan's `selectionMethod` is `random` and `factorsFor(e.context, row.processArea)` has an `incident` factor.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/tests/judgment-sampling.test.ts
import { describe, expect, it } from 'vitest';
import { subjectInfo } from '../src/agents/subjects';
import { draftTestPlans } from '../src/agents/specialists/test-plan';
import { reviewSubject } from '../src/agents/qa/deterministic';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

const INCIDENT = { factors: [{ kind: 'incident' as const, processAreas: ['HACCP'], description: 'Two CCP deviations in March' }], background: '' };

describe('sampling in the RCM and the plans (spec §5.3) [REQ-32]', () => {
  it('keys the sample on the assessed risk, writes the rationale and the RCM memo, selects judgementally for the incident area, and recommends 0 tolerance for a food row', async () => {
    const svc = await newService();
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, context: INCIDENT }, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    await svc.runModule(e.id, 'rcm', auditor);
    const after = await svc.engagement(e.id);
    const haccp = after.rcm.filter((r) => r.processArea === 'HACCP');
    expect(haccp.length).toBeGreaterThan(0);
    for (const r of haccp) {
      expect(r.assessedRisk).toBe(r.riskRating === 'Low' ? 'Medium' : 'High');
      expect(r.samplingRationale).toMatch(new RegExp(r.assessedRisk!));
    }
    expect(after.memos.rcm.subjectKey).toBe('rcm');
    expect(after.memos.rcm.calls.some((c) => c.question.includes(haccp[0].control) || c.question.includes('HACCP'))).toBe(true);
    const plans = draftTestPlans(after);
    for (const r of haccp) {
      expect(['judgemental', 'all']).toContain(plans[r.id].selectionMethod);
      expect(plans[r.id].recommendedToleranceRate).toBe(0);
    }
    const common = after.rcm.find((r) => r.packId === 'common' && (r.assessedRisk ?? r.riskRating) !== 'High');
    if (common) expect(plans[common.id].recommendedToleranceRate).toBeGreaterThan(0);
  });

  it('with no context produces today\'s rows apart from the two new fields, and the rcm hash moves only through the memo', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    await svc.runModule(e.id, 'rcm', auditor);
    const after = await svc.engagement(e.id);
    for (const r of after.rcm) expect(r.assessedRisk).toBe(r.riskRating);
    const plans = draftTestPlans(after);
    for (const r of after.rcm) expect(plans[r.id].selectionMethod).toBe(['Annual', 'Quarterly'].includes(r.frequency) ? 'all' : 'random');
    expect(subjectInfo(after, 'rcm')!.hash).not.toBe(subjectInfo({ ...after, memos: {} }, 'rcm')!.hash);
  });

  it('flags a random selection for a row with an incident factor [REQ-30]', async () => {
    const svc = await newService();
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, context: INCIDENT }, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    await svc.runModule(e.id, 'rcm', auditor);
    const after = await svc.engagement(e.id);
    const plans = draftTestPlans(after);
    const haccpRow = after.rcm.find((r) => r.processArea === 'HACCP')!;
    plans[haccpRow.id] = { ...plans[haccpRow.id], selectionMethod: 'random' };
    const r = reviewSubject({ ...after, testPlans: plans }, 'test_plans');
    expect(r.issues.map((i) => [i.severity, i.criterion])).toContainEqual(['advisory', 'plans.selection-incident']);
  });
});
```

In `tests/agent-test-plans.test.ts`, add one test with a `FakeProvider` answering the plans prompt: a plan with a lower `sampleSize` (kept at the floor, as today), `selectionMethod: 'random'` for a row whose rule is `all` (refused), `judgemental` for a `random` row (accepted), `recommendedToleranceRate: 0.2` against a rule of `0.05` (kept at 0.05, refused) and `0.01` against `0.05` (accepted). Assert `draft.memo.forTheReviewer` names the two refusals and that `draft.plans` carries the accepted values. Read the file's existing helper for building the fake answer first.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/judgment-sampling.test.ts tests/agent-test-plans.test.ts`
Expected: FAIL (`assessedRisk` undefined on rows; `memo` undefined on the draft).

- [ ] **Step 3: Implement** per Interfaces. The rcm prompt shows `assessedRisk` next to the library rating in its row lines (as data). `planPrompt` adds the row's `assessedRisk`, `samplingRationale` and the recommended tolerance to the `row` data block and asks for the optional `recommendedToleranceRate` with the sentence that a lower value is the only accepted change.

- [ ] **Step 4: Run the tests, the agent suites and the eval**

Run: `cd backend && npx vitest run tests/judgment-sampling.test.ts tests/agent-test-plans.test.ts tests/engine.test.ts tests/workpapers.test.ts tests/agent-rails.test.ts tests/agent-service.test.ts tests/executor.test.ts tests/agents-e2e.test.ts tests/agent-eval.test.ts tests/agent-qa.test.ts && npm run typecheck && ALLOW_UNVERIFIED_CITATIONS=true npm run eval`
Expected: all PASS; both agent traces PASS with their existing files (Ruling 10).

- [ ] **Step 5: Commit**

```bash
git add backend/src/engine/modules/rcm.ts backend/src/agents backend/src/service.ts backend/tests/judgment-sampling.test.ts backend/tests/agent-test-plans.test.ts
git commit -m "feat(sampling): RCM sample keyed on assessed risk with a rationale and memo; plans select by factors and recommend a tolerance"
```

---

### Task 5: A person sets a tolerance; the conclusion honours it; results carry a severity

**Files:**
- Modify: `backend/src/engine/modules/testing.ts` (`concludeTest` takes a tolerance; severity; model may worsen severity), `backend/src/engine/qa.ts#testEvidenceGate` (tolerance parameter), `backend/src/service.ts` (new `setTolerance`), `backend/src/app.ts` (new `PUT /api/engagements/:id/tolerances/:controlId`), `backend/src/agents/rails.ts#assertWithinRails` (tolerances and responses unchanged), `backend/src/agents/qa/deterministic.ts#planIssues` (`plans.tolerance-above-recommendation`), `backend/src/agents/qa/rubric.ts#subjectContent` (`test_plans` adds the tolerance in force and the recommendation; `finding` adds `severity`)
- Test: `backend/tests/judgment-tolerance.test.ts`, `backend/tests/agent-rails.test.ts` (extend)

**Interfaces:**
- `concludeTest(row: RcmRow, input: TestInput | undefined, tolerance = 0): TestResult`: with `tolerance > 0` and `toleratedEffective(exceptions, sampleTested, tolerance)`, the conclusion is `Effective` with a rationale naming the rate; every result gets `severity`, `severityRationale` (from `severityOf`) and `toleranceApplied: tolerance`. With `tolerance = 0` the result is today's plus the three fields.
- `testEvidenceGate(row, input, result, tolerance = 0)`: the "Effective with exceptions" downgrade applies only when `!toleratedEffective(...)`.
- `testingModule.run`: `tolerance = e.tolerances[row.controlId]?.rate ?? 0` per row; `ModelTesting` results gain `severity: z.enum([...SEVERITIES]).optional()`, accepted only through `worsens`, refusals via `ctx.gate('judgment-bounds')`.
- `service.ts`:
  ```ts
  async setTolerance(engagementId: string, controlId: string, rate: number, actor: User, opts: MutationOptions = {}): Promise<Engagement>;
  // PREPARER_ROLES; 400 unless 0 ≤ rate ≤ TOLERANCE_MAX; 404 unless e.rcm has a row with that controlId; 409 TOLERANCE_LOCKED when e.testInputs[rowId] exists;
  // inserts the row (id from crypto.randomUUID(), trailBundleId = the bundle's id) and emits human:set-tolerance inside the same mutate; returns the engagement with e.tolerances updated.
  ```
  Route in `app.ts`: `PUT /api/engagements/:id/tolerances/:controlId`, body `z.object({ rate: z.number().min(0).max(TOLERANCE_MAX) }).strict()`, `readers`, `ifMatch`.
- `assertWithinRails`: `canonicalJson(before.tolerances) === canonicalJson(after.tolerances)` and the same for `responses`, else `AGENT_FORBIDDEN`.
- QA: `plans.tolerance-above-recommendation` (advisory) when `e.tolerances[row.controlId].rate > plan.recommendedToleranceRate` (skipped when the plan has no recommendation).

- [ ] **Step 1: Write the failing tests**

```ts
// backend/tests/judgment-tolerance.test.ts
import { describe, expect, it } from 'vitest';
import { concludeTest } from '../src/engine/modules/testing';
import { testEvidenceGate } from '../src/engine/qa';
import { auditor, engagementWithFailedControl, NEW_ENGAGEMENT, newService } from './helpers';
import { appWithDevUsers, signIn } from './http';
import { row, input } from './agent-fixtures';

describe('tolerance set by a person (spec §3.3, §5.4) [REQ-33]', () => {
  it('concludes Effective within the tolerance, Ineffective without one, and records what it applied', () => {
    const r = row('R1', { sampleSize: 40 });
    const i = input({ sampleTested: 40, exceptions: 1, evidenceRefs: ['E1'], designAdequate: true });
    const tolerated = concludeTest(r, i, 0.05);
    expect(tolerated).toMatchObject({ conclusion: 'Effective', toleranceApplied: 0.05, severity: 'isolated' });
    expect(testEvidenceGate(r, i, tolerated, 0.05).result.conclusion).toBe('Effective');
    const strict = concludeTest(r, i);
    expect(strict).toMatchObject({ conclusion: 'Ineffective', toleranceApplied: 0, severity: 'isolated' });
    expect(testEvidenceGate(r, i, { ...tolerated, toleranceApplied: 0 }).result.conclusion).toBe('Ineffective');
    expect(concludeTest(r, input({ sampleTested: 40, exceptions: 3, evidenceRefs: ['E1'], designAdequate: true }), 0.05).conclusion).toBe('Ineffective');
  });

  it('is recorded through the API with a trail entry, survives an RCM rebuild, and is refused once the control has a test', async () => {
    const { app, svc } = await appWithDevUsers();
    const user = await signIn(app, 'auditor');
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    await svc.runModule(e.id, 'rcm', auditor);
    const control = (await svc.engagement(e.id)).rcm[0].controlId;
    const bad = await user.put(`/api/engagements/${e.id}/tolerances/${control}`, { rate: 0.3 });
    expect(bad.status).toBe(400);
    const ok = await user.put(`/api/engagements/${e.id}/tolerances/${control}`, { rate: 0.05 });
    expect(ok.status).toBe(200);
    expect(ok.body.tolerances[control]).toMatchObject({ rate: 0.05, recordedBy: 'auditor' });
    const trail = await svc.trailFor(e.id);
    const entry = trail.find((b) => b.moduleId === 'human:set-tolerance');
    expect(entry).toBeDefined();
    expect(ok.body.tolerances[control].trailBundleId).toBe(entry!.id);
    await svc.runModule(e.id, 'rcm', auditor);                                   // rebuild
    expect((await svc.engagement(e.id)).tolerances[control].rate).toBe(0.05);
    await svc.recordTest(e.id, control, { designAdequate: true, observation: 'ok', evidenceRefs: ['E1'], sampleTested: 40, exceptions: 1 }, auditor);
    await expect(svc.setTolerance(e.id, control, 0.1, auditor)).rejects.toMatchObject({ status: 409, code: 'TOLERANCE_LOCKED' });
    const viewer = await signIn(app, 'viewer');
    expect((await viewer.put(`/api/engagements/${e.id}/tolerances/${control}`, { rate: 0.05 })).status).toBe(403);
  });

  it('is honoured by the testing module end to end, and flagged by QA when above the recommendation [REQ-30]', async () => {
    const svc = await newService();
    const { id, controlId } = await engagementWithFailedControl(svc);         // read helpers.ts: this records exceptions on one control
    // Re-record 1 exception in 40 on that control, set a 5% tolerance before... (the helper already recorded a test, so set the tolerance on a fresh engagement instead if the helper locks it — read the helper and adjust: the tolerance must be set BEFORE recordTest)
    void id; void controlId;
  });
});
```

Replace the third test's body after reading `engagementWithFailedControl` in `tests/helpers.ts`. If the helper takes no `TestInput` overrides, **this task** extends it with an optional overrides argument (Task 6 consumes it): build the engagement the way the helper does but call `svc.setTolerance(e.id, controlId, 0.05, auditor)` before `recordTest(... sampleTested: 40, exceptions: 1 ...)`, then `runModule(e.id, 'testing', auditor)` and assert `testResults[controlId]` is `Effective` with `toleranceApplied: 0.05` and `severity: 'isolated'`, that the module bundle's `qaActions` has no `evidence` fail for that row, and that `reviewSubject(e, 'test_plans')` (after drafting plans with a `recommendedToleranceRate` of 0 for that food row) contains `['advisory', 'plans.tolerance-above-recommendation']`. Then the same engagement without a tolerance concludes `Ineffective`, as today.

In `tests/agent-rails.test.ts`, add: `assertWithinRails(before, { ...before, tolerances: { X: {...} } })` throws `AGENT_FORBIDDEN`, and the same for `responses`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/judgment-tolerance.test.ts tests/agent-rails.test.ts`
Expected: FAIL (`toleranceApplied` undefined; `setTolerance is not a function`).

- [ ] **Step 3: Implement** per Interfaces. The testing prompt lists each row's `toleranceApplied` and the rule's `severity` as data and asks for an optional `severity`, stating only a worse value is accepted. `rubric.ts#subjectContent`: `test_plans` adds `{ tolerance: e.tolerances[row.controlId] ?? null, recommendedToleranceRate: plan.recommendedToleranceRate ?? null }`; `finding` adds `result.severity`.

- [ ] **Step 4: Run the tests, the suites that conclude tests, and the eval**

Run: `cd backend && npx vitest run tests/judgment-tolerance.test.ts tests/agent-rails.test.ts tests/engine.test.ts tests/api.test.ts tests/agent-qa.test.ts tests/agents-e2e.test.ts tests/agent-eval.test.ts && npm run typecheck && ALLOW_UNVERIFIED_CITATIONS=true npm run eval`
Expected: PASS; every `testing` eval case passes as before (tolerance 0); both traces PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/engine backend/src/service.ts backend/src/app.ts backend/src/agents backend/tests/judgment-tolerance.test.ts backend/tests/agent-rails.test.ts
git commit -m "feat(testing): person-set tolerance honoured by the conclusion and the evidence gate; severity on every result"
```

---

### Task 6: The gap writer rates by the matrix, finds a cause, tailors the recommendation; people edit likelihood and impact

**Files:**
- Modify: `backend/src/engine/modules/gaps.ts` (`rate()` deleted; `draftFinding` sets the new fields; model schema; bounds; memo), `backend/src/service.ts#editFinding` and `applyFindingEdit` (patch type; rating recomputed; memo marked), `backend/src/app.ts#FindingPatchSchema` (drop `rating`, add `likelihood`, `impact`), `backend/src/agents/routes.ts` (memos route serves `finding:<rowId>`), `backend/src/agents/qa/deterministic.ts#findingIssues` (three checks plus the severity signal), `backend/src/agents/qa/rubric.ts` (`standard` on rcm, plans and finding criteria; `subjectContent('finding')` adds `likelihood`, `impact`, `rootCause`), `backend/tests/api.test.ts` and any other test that sends `rating` in a finding edit (`grep -rn "rating" backend/tests/*.test.ts | grep -i "put\|patch\|editFinding"`)
- Test: `backend/tests/judgment-finding.test.ts`, `backend/tests/agent-qa.test.ts` (extend)

**Interfaces:**
- `draftFinding(registry, row, input, result, recommendation)`: `likelihood = likelihoodOf(result)`, `impact = impactOf(row.assessedRisk ?? row.riskRating)`, `rating = ratingOf(likelihood, impact)`, `rootCause = { category: 'unknown', analysis: PLACEHOLDER_CAUSE, confirmed: false }`, `cause` stays the placeholder sentence (the 5 C's field), `memo` from `findingMemo` with `modelMoves: []`.
- `ModelFinding` entries: `rating` removed (every scripted gaps answer in the suite breaks, because `FakeProvider` validates against the request schema: find them with `grep -rln clauseIds backend/tests` and rewrite each); `likelihood: z.enum(LIKELIHOODS).optional()`, `impact: z.enum(IMPACTS).optional()`, `rootCause: z.object({ category: z.enum([...]), analysis: z.string(), confirmed: z.boolean() })`. The module accepts a likelihood or impact only through `oneStepWorse`; sets `confirmed` to false (with a `judgment-bounds` refusal) when `!causeSupported(input.observation, rootCause.analysis)`; always recomputes `rating`; takes the model's `recommendation` and `cause` as today; rebuilds the memo with the accepted moves as `modelMoves`.
- `editFinding(..., patch: Partial<Pick<Finding, 'title' | 'likelihood' | 'impact' | 'condition' | 'criteria' | 'cause' | 'effect' | 'recommendation' | 'evidenceRefs'>>, ...)`: when `likelihood` or `impact` is in the patch, `rating = ratingOf(next.likelihood ?? likelihoodFallback, next.impact ?? impactFallback)` where the fallbacks for a pre-8B finding are `possible` and `impactOf(rating)`, and **both** `likelihood` and `impact` are written to the finding (the fallback included) so the matrix check always engages afterwards; the memo (if any) is `markEditedByPerson(memo, actor.id, ['likelihood a → b', ...])`. `FindingPatchSchema` becomes `.strict()` (today only the `agents/routes.ts` schemas are) so `rating` is a 400; check that `EditDialog` in `frontend/src/components/engagement/FindingsTab.tsx` sends no key outside the new `Pick` (Task 8 changes the dialog; until then the backend change must not break the current body apart from `rating`).
- Memos route: when `Object.hasOwn(memos, key)` fails and `rowOfKey(key)` is a row id, serve `e.findings.find((f) => f.rowId === rowId)?.memo`.
- QA (`findingIssues`): `finding.rating-matrix` (blocking) when `likelihood` and `impact` are present and `rating !== ratingOf(...)`; `finding.root-cause-unsupported` (blocking) when `rootCause?.confirmed` and `!causeSupported(input.observation, rootCause.analysis)`; `finding.recommendation-verbatim` (advisory) when `rootCause?.confirmed` and `recommendation === registry control's recommendation` (this check needs the registry: run it in `checkedIssues`); `finding.severity-signal` (advisory) when `result?.severity === 'none'` and `negativeSignals(input.observation).length`. Rubric `standard`s: `rcm.sample-appropriateness → IIA.resources`, `plans.* → IIA.workProgram`, `finding.condition-evidence → IIA.gathering`, `finding.criteria-citation → IIA.criteria`, `finding.cause-effect → IIA.analysis`, `finding.recommendation → IIA.recommendations`.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/tests/judgment-finding.test.ts
import { describe, expect, it } from 'vitest';
import { reviewSubject } from '../src/agents/qa/deterministic';
import { findingKey } from '../src/agents/subjects';
import { AuditService } from '../src/service';
import { auditor, engagementWithFailedControl, FakeProvider, LENIENT, newService, registry } from './helpers';
import { appWithDevUsers, draftFinding, signIn } from './http';
import { testDb } from './db';

describe('finding judgment (spec §5.5) [REQ-32]', () => {
  it('rates by the matrix from the assessed risk and the result, with an unconfirmed cause and the library recommendation, and a memo on the finding [REQ-31]', async () => {
    const svc = await newService();
    const { id, controlId } = await engagementWithFailedControl(svc);
    await svc.runModule(id, 'gaps', auditor);
    const e = await svc.engagement(id);
    const f = e.findings.find((x) => x.controlId === controlId)!;
    expect(f).toMatchObject({ likelihood: expect.any(String), impact: expect.any(String), rootCause: { category: 'unknown', confirmed: false } });
    expect(f.memo?.subjectKey).toBe(findingKey(f.rowId));
    expect(f.memo?.calls.map((c) => c.question)).toHaveLength(3);
    const r = reviewSubject(e, findingKey(f.rowId));
    expect(r.issues.map((i) => i.criterion)).not.toContain('finding.rating-matrix');
  });

  it('lets the model worsen likelihood or impact by one step and confirm a supported cause; refuses the rest, in the trail', async () => {
    const model = new FakeProvider((req) => gapsAnswerFrom(req, { likelihood: 'likely', impact: 'minor', rootCause: { category: 'people', analysis: 'The line lead was on leave and nobody covered the check', confirmed: true } }));
    const svc = new AuditService(await testDb(), registry, model, LENIENT);
    const { id, controlId } = await engagementWithFailedControl(svc, 'FD-HACCP-03', { observation: 'Checks missed while the line lead was on leave; nobody covered.' });
    const { bundle, engagement: e } = await svc.runModule(id, 'gaps', auditor);
    const f = e.findings.find((x) => x.controlId === controlId)!;
    // likelihood: rule value for the helper's exceptions; the model's 'likely' is accepted only if exactly one step worse — assert against the rule computed here.
    expect(f.rootCause).toMatchObject({ category: 'people', confirmed: true });
    expect(f.memo?.calls.find((c) => c.question.toLowerCase().includes('root cause'))?.source).toBe('model');
    const refusals = bundle.qaActions.filter((a) => a.gate === 'judgment-bounds');
    expect(refusals.some((a) => a.detail.includes('impact'))).toBe(true);          // 'minor' from the rule's value is an improvement: refused
    expect(f.rating).toBe(ratingFromMatrix(f));
    void refusals;
  });

  it('lets a person lower the likelihood, recomputes the rating, names them in the memo, passes QA, and refuses a rating in the body (plan Review Focus 2, 4)', async () => {
    const { app, svc } = await appWithDevUsers();
    const { auditor: user, id, fid } = await draftFinding(app);
    const before = (await svc.engagement(id)).findings.find((f) => f.id === fid)!;
    const bad = await user.put(`/api/engagements/${id}/findings/${fid}`, { rating: 'Low' });
    expect(bad.status).toBe(400);
    const ok = await user.put(`/api/engagements/${id}/findings/${fid}`, { likelihood: 'rare', impact: 'minor' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ likelihood: 'rare', impact: 'minor', rating: 'Low' });
    expect(ok.body.memo.forTheReviewer.some((l: string) => l.startsWith('Edited by auditor:') && l.includes('likelihood'))).toBe(true);
    const e = await svc.engagement(id);
    expect(reviewSubject(e, findingKey(before.rowId)).issues.map((i) => i.criterion)).not.toContain('finding.rating-matrix');
    expect((await svc.trailFor(id)).some((b) => b.moduleId === 'human:finding-edit')).toBe(true);
  });

  it('raises no new issue for a finding drafted before 8B (plan Review Focus 1)', async () => {
    const svc = await newService();
    const { id } = await engagementWithFailedControl(svc);
    await svc.runModule(id, 'gaps', auditor);
    const e = await svc.engagement(id);
    const legacy = { ...e, findings: e.findings.map(({ likelihood, impact, rootCause, memo, ...f }) => f as typeof e.findings[number]) };
    const issues = reviewSubject(legacy, findingKey(e.findings[0].rowId)).issues.map((i) => i.criterion);
    expect(issues.filter((c) => c.startsWith('finding.rating') || c.startsWith('finding.root-cause') || c.startsWith('finding.recommendation-verbatim'))).toEqual([]);
  });
});
```

Write `gapsAnswerFrom(req, overlay)` in the test file: `engagementWithFailedControl` runs scope, rcm and testing with the same provider, so the handler must recognise the gaps prompt (its schema or a fixed phrase in its system text) and throw for every other request so that `askModel` falls back to the rules for those modules; for the gaps prompt, parse the row ids from the data block as the scope test does and answer every finding with the data's fields plus `overlay`, and `ratingFromMatrix(f)` as `ratingOf(f.likelihood!, f.impact!)`. `engagementWithFailedControl` takes the `TestInput` overrides argument Task 5 added. In the second test, compute the rule's likelihood for the helper's exceptions and assert `f.likelihood` is the model's value when `oneStepWorse` would accept it, else the rule's.

Add to `tests/agent-qa.test.ts` one test with fixtures: a finding with `likelihood: 'rare', impact: 'minor', rating: 'High'` → `['blocking', 'finding.rating-matrix']`; `rootCause.confirmed: true` with an analysis sharing no word with the observation → `['blocking', 'finding.root-cause-unsupported']`; a result with `severity: 'none'` and an observation containing "exception" → `['advisory', 'finding.severity-signal']`; and in `tests/qa-agent.test.ts` assert the finding review prompt mentions `IIA-14.3`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/judgment-finding.test.ts tests/agent-qa.test.ts tests/qa-agent.test.ts`
Expected: FAIL (`likelihood` undefined; `rating` still accepted).

- [ ] **Step 3: Implement** per Interfaces. The gaps prompt gives each failed row's `assessedRisk`, the rule's `likelihood`, `impact`, `rating` and `severity` as data, asks for the optional one-step moves, the root cause (with the existing "do not state a root cause as fact unless the record supports it" sentence) and a recommendation tailored to the cause category and the engagement context (`asData('engagement-context', ...)` when present), and says the rating is computed, never taken. Rewrite the finding-edit tests that sent `rating`.

- [ ] **Step 4: Run the tests, the finding suites, and the eval**

Run: `cd backend && npm run typecheck && npx vitest run && ALLOW_UNVERIFIED_CITATIONS=true npm run eval`
Expected: the whole suite PASS (the model schema change touches scripted answers in several files); every `gaps` eval case passes as before; both traces PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src backend/tests
git commit -m "feat(findings): rating from likelihood and impact, root cause and tailored recommendation with bounds; people edit likelihood and impact"
```

---

### Task 7: Management responses, the report basis, and `verify`

**Files:**
- Modify: `backend/src/service.ts` (new `recordManagementResponse`), `backend/src/app.ts` (`POST /api/engagements/:id/findings/:fid/responses`, `GET .../responses`), `backend/src/ops/verify.ts` (`checkRecords`, `IntegrityReport.records`), `backend/src/db/cli.ts` (prints the new member if it prints members by name), `docs/deploy/operations.md` §4 (two bullets) and §7 (one line on `RESPONSE_LOCKED`)
- Test: `backend/tests/judgment-responses.test.ts`, `backend/tests/verify.test.ts` (extend)

**Interfaces:**
- `service.ts`:
  ```ts
  export interface ResponseInput { response: ResponseKind; owner: string; dueDate?: string | null; actionPlan?: string }
  async recordManagementResponse(engagementId: string, findingId: string, input: ResponseInput, actor: User, opts: MutationOptions = {}): Promise<FindingResponse>;
  // PREPARER_ROLES; 404 unless the finding exists; 409 FINDING_NOT_APPROVED unless f.status === 'approved'; 409 RESPONSE_LOCKED when hasApprovedGate(trx, id, 'report');
  // inserts the row (id crypto.randomUUID(), trailBundleId = bundle id), sets e.responses[findingId], emits human:management-response, all inside mutate (so a waiting run wakes and the open report gate is superseded by the basis change).
  ```
  Routes: `POST .../findings/:fid/responses` body `z.object({ response: z.enum(['agree','partially_agree','disagree']), owner: z.string().trim().min(1).max(200), dueDate: z.string().date().nullable().optional(), actionPlan: z.string().max(4000).optional() }).strict()` → 201 with the response; `GET .../findings/:fid/responses` → `responseHistory` (oldest first).
- `verify.ts`: `checkRecords(db, trail): Promise<{ checked: number; problems: string[] }>` over both tables: for each row, the trail bundle `trail_bundle_id` must exist, be for the same engagement, have `moduleId` `human:set-tolerance` / `human:management-response`, and name the same `controlId` / `findingId` in its `inputs`; for each response, a `signatures` row for that `finding_id` with the Approved meaning must exist (read the meaning value from `signing/` first). Messages: `Tolerance <id> (control <controlId>): its trail entry <bundle> is missing or is not a human:set-tolerance entry for this control`, `Response <id> (finding <findingId>): its trail entry ... human:management-response ...`, `Response <id> is recorded for finding <findingId>, which was never approved`. `IntegrityReport` gains `records: { checked, problems }` and `ok` requires `records.problems` empty.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/tests/judgment-responses.test.ts
import { describe, expect, it } from 'vitest';
import { listGates } from '../src/agents/gate-repo';
import { subjectInfo } from '../src/agents/subjects';
import { verifyIntegrity } from '../src/ops/verify';
import type { Engagement } from '../src/engine/types';
import { appWithDevUsers, devSign, draftFinding, signIn } from './http';

describe('management responses (spec §3.3) [REQ-34]', () => {
  it('is refused before approval, recorded after it without touching the signature, reopens the report, and is served with its history', async () => {
    const { app, svc } = await appWithDevUsers();
    const { auditor: user, id, fid } = await draftFinding(app);
    const body = { response: 'partially_agree', owner: 'Plant manager', dueDate: '2026-12-31', actionPlan: 'Retrain the line leads' };
    expect((await user.post(`/api/engagements/${id}/findings/${fid}/responses`, body)).status).toBe(409);
    const reviewer = await signIn(app, 'reviewer');
    await devSign(reviewer, 'reviewer', id, fid, 'review');
    const approver = await signIn(app, 'approver');
    await devSign(approver, 'approver', id, fid, 'approve');
    const signed = (await svc.engagement(id)).findings.find((f) => f.id === fid)!;
    const reportBasisBefore = subjectInfo(await svc.engagement(id), 'report')!.basis;
    const created = await user.post(`/api/engagements/${id}/findings/${fid}/responses`, body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ findingId: fid, response: 'partially_agree', recordedBy: 'auditor' });
    // svc.engagement() does not run withSignatureStatus; the HTTP path does, so the signature check goes through it.
    const shown = (await user.get(`/api/engagements/${id}`).expect(200)).body as Engagement;
    const f = shown.findings.find((x) => x.id === fid)!;
    expect(f.signOffs.length).toBeGreaterThanOrEqual(2);
    expect(f.signOffs.every((s) => !s.broken && !s.legacy)).toBe(true);
    expect(f.signatureIssues ?? []).toEqual([]);
    expect(f.status).toBe('approved');
    const after = await svc.engagement(id);
    expect(after.responses[fid].id).toBe(created.body.id);
    expect(subjectInfo(after, 'report')!.basis).not.toBe(reportBasisBefore);
    expect((await svc.trailFor(id)).some((b) => b.moduleId === 'human:management-response' && b.id === created.body.trailBundleId)).toBe(true);
    const again = await user.post(`/api/engagements/${id}/findings/${fid}/responses`, { ...body, response: 'agree' });
    expect(again.status).toBe(201);
    const history = await user.get(`/api/engagements/${id}/findings/${fid}/responses`).expect(200);
    expect(history.body.map((r: { response: string }) => r.response)).toEqual(['partially_agree', 'agree']);
    const report = await verifyIntegrity(svc.db.kysely, null);
    expect(report.signatures.problems).toEqual([]);
    expect(report.records).toEqual({ checked: 2, problems: [] });
    void signed; void listGates;
  });

  it('is refused once the report gate is approved', async () => {
    // Drive the offline agent to the report gate (as tests/judgment-context.test.ts does with startRun + AgentWorker.drain), approve the report gate with svc.signGate(..., unattended),
    // then expect recordManagementResponse(...) to reject with { status: 409, code: 'RESPONSE_LOCKED' }. Read judgment-context.test.ts and agents-e2e.test.ts for the driving pattern.
  });
});
```

Fill the second test's body from the named pattern. In `tests/verify.test.ts`, add: insert a `finding_responses` row by hand whose `trail_bundle_id` names no bundle, and one for a finding id that was never approved → `verifyIntegrity(...).records.problems` has the two expected messages and `ok` is false.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/judgment-responses.test.ts tests/verify.test.ts`
Expected: FAIL with 404 on the POST route.

- [ ] **Step 3: Implement** per Interfaces; the two operations.md §4 bullets (one per message family) and the §7 line.

- [ ] **Step 4: Run the tests, the signing and gate suites, and the eval**

Run: `cd backend && npx vitest run tests/judgment-responses.test.ts tests/verify.test.ts tests/signing-service.test.ts tests/signing-http.test.ts tests/gates.test.ts tests/agents-e2e.test.ts tests/agent-eval.test.ts tests/api.test.ts && npm run typecheck && ALLOW_UNVERIFIED_CITATIONS=true npm run eval`
Expected: PASS; both traces PASS (no scenario records a response).

- [ ] **Step 5: Commit**

```bash
git add backend/src backend/tests docs/deploy/operations.md
git commit -m "feat(findings): management responses outside the signed finding, covered by the report basis and checked by verify"
```

---

### Task 8: UI: sampling on the RCM, tolerance on the plans, severity on fieldwork, judgment and responses on findings

**Files:**
- Modify: `frontend/src/judgment.ts` and `frontend/src/judgment.test.ts` (helpers), `frontend/src/components/engagement/RcmTab.tsx`, `TestPlansTab.tsx`, `FieldworkTab.tsx`, `FindingsTab.tsx`, `GateList.tsx:113` (memo lookup), `frontend/src/api.ts:8-19` (`FRIENDLY` for the three codes), `frontend/src/agents.ts` (`agentApi.setTolerance`, `agentApi.recordResponse`, `agentApi.responses`)
- Create: `frontend/src/components/engagement/ResponsePanel.tsx`

**Interfaces:**
- Produces (`judgment.ts`, pure):
  ```ts
  export const SEVERITY_LABELS: Record<Severity, string>;
  export const LIKELIHOOD_LABELS: Record<Likelihood, string>; export const IMPACT_LABELS: Record<Impact, string>;
  export function ratingOf(likelihood: Likelihood, impact: Impact): RiskRating;     // the §5.5 matrix, duplicated like RANK
  export function memoFor(e: Pick<Engagement, 'memos' | 'findings'>, subjectKey: string): JudgmentMemo | undefined;   // memos[key], else the finding's memo for finding:<rowId>
  export function toleranceEditable(e: Pick<Engagement, 'testInputs'>, rowId: string): boolean;   // no test recorded
  export function responsesLocked(gates: Gate[]): boolean;                            // an approved report gate
  export function toleranceProblems(rate: number): string[];                          // 0..0.25
  ```
- `agentApi.setTolerance(engagementId, controlId, rate, version)`, `agentApi.recordResponse(engagementId, findingId, body, version)`, `agentApi.responses(engagementId, findingId)`.
- UI per spec §7: RCM rows show `assessedRisk` (chip) and `samplingRationale`; the Test plans tab shows "Recommended tolerance n%" beside a numeric tolerance field per row (editable while `toleranceEditable`, showing "set by <recordedBy>" when one is in force); fieldwork results show a severity chip with `severityRationale` as its tooltip; the finding card shows Likelihood and Impact as selects in the edit dialog (Rating read-only, computed with `ratingOf` as the user changes them), the root cause with its category and a "confirmed" chip or an "unconfirmed" warning, and `ResponsePanel` on an Approved finding (response, owner, due date, plan; history below; disabled with a caption when `responsesLocked`). Gate cards use `memoFor`.

- [ ] **Step 1: Write the failing tests** (`judgment.test.ts`): `ratingOf` for the nine matrix cells; `memoFor` finds a finding memo by `finding:<rowId>` and returns `undefined` for an unknown key; `toleranceEditable` false once `testInputs[rowId]` exists; `responsesLocked` true only with an approved `report` gate; `toleranceProblems(0.3)` names the limit.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/judgment.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement** the helpers, the client calls, and the components. Readers of pre-8B rows fall back: no `assessedRisk` → show the library chip only; no `severity` → no chip; no `likelihood`/`impact` → the dialog starts from `possible` and `impactOf(rating)`-equivalent defaults (`minor`/`moderate`/`major` for Low/Medium/High) and says so in a caption.

- [ ] **Step 4: Type check, test, build**

Run: `cd frontend && npm run typecheck && npx vitest run && npm run build`
Expected: PASS, build ok.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(ui): sampling rationale, tolerance field, severity chip, likelihood and impact editing, root cause and management responses"
```

---

### Task 9: README, runbook, visual check and the full local CI set

**Files:**
- Modify: `README.md` (the agent section: one paragraph on sampling, tolerance, severity, the finding judgment and responses; the "edit a finding" sentence no longer says rating), `docs/deploy/operations.md` (check §4 and §7 read well after Task 7), `backend/validation/README.md` (if it lists requirements by id)

- [ ] **Step 1: Docs.** Write the README paragraph in the register of the existing agent section; name the two trail module ids and the three 409 codes in the runbook if §7 lists codes.

- [ ] **Step 2: Full local CI set**

Run: `cd backend && npm run typecheck && npx vitest run && ALLOW_UNVERIFIED_CITATIONS=true npm run eval && npm run traceability && cd ../frontend && npm run typecheck && npx vitest run && npm run build`
Expected: all green; traceability lists REQ-32, REQ-33 and REQ-34 with their tests; both traces PASS.

- [ ] **Step 3: Visual check** (the controller does this, with the local stack described in the session memory `local-dev-stack`): seed, start an agent run on the food engagement with an incident factor, approve the scope and RCM gates, open the RCM tab (assessed chip, rationale), the Test plans tab (tolerance field and recommendation; set 5% on a common row), record a test, run testing (severity chip), reach a finding (likelihood/impact dialog, rating recomputes, root cause), approve it, record a response (panel, history), confirm the report gate reopens. Fix anything that does not render, with a test where the fix is logic.

- [ ] **Step 4: Commit**

```bash
git add README.md docs backend/validation
git commit -m "docs: sampling, tolerance, severity, finding judgment and management responses in the README and runbook"
```

---

## Self-review notes

- **Spec coverage.** §3.2 RCM/plan/result/finding fields → Tasks 1, 4, 5, 6. §3.3 both tables, trail ids, refusal rules, the mutation path → Tasks 1, 5, 7. §5.3 → Tasks 2, 4 (QA `plans.selection-incident` in 4, `plans.tolerance-above-recommendation` in 5). §5.4 → Tasks 2, 5. §5.5 → Tasks 2, 6. §7 endpoints → Tasks 5, 7; UI → Task 8. §8 unit rows for sampling, severity, finding, model overlays → Tasks 2, 4, 5, 6; integration rows (tolerance 5% / 0, response after approval, tolerance survives rebuild, response refused after report, person lowering likelihood) → Tasks 5, 6, 7. §9 `verify` → Task 7; REQ-32/33/34 → Task 1 plus tagged tests. Not in 8B by the spec's §10: the opinion, report markdown, memos to the policy, injection cases, the `judgment` eval kind.
- **Type consistency.** `Tolerance`, `FindingResponse`, `Severity`, `Likelihood`, `Impact`, `RootCause` are defined once in Task 1 and used by name afterwards; `sameMemo`, `planMemo`, `findingMemo`, `markEditedByPerson` (Task 3) are consumed by Tasks 4, 5, 6; `selectionFor`, `recommendedTolerance`, `acceptsSelection`, `severityOf`, `worsens`, `toleratedEffective`, `ratingOf`, `oneStepWorse`, `causeSupported` (Task 2) by Tasks 4, 5, 6 and 8 (`ratingOf` duplicated in the frontend by design).
- **Proportion.** The spec's 8B share is about 120 lines; this plan is about 560. Code appears only for tests, the migration's shape and the schemas the implementer could not infer.
