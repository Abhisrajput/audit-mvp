# Agent Orchestration 2A: Rails and Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A supervisor run takes an engagement from scope to the report gate offline. It works inside code-enforced rails, stops at human-signed gates, waits for human field work, and records every decision in `agent_steps` and the hash-chained trail.

**Architecture:**
- **Graph.** `graph.ts` is a pure function: from the engagement, its gates and the run's QA and redraft history, it computes the legal next actions (the "menu").
- **Policy.** A policy picks one action from the menu. 2A ships only the deterministic rules policy.
- **Executor.** The executor applies the action through a narrow `AgentPort` onto `AuditService`. Specialists run on an unlocked snapshot and commit with `expectedVersion`.
- **Worker.** A Postgres-leased worker runs one iteration per `tick()`.
- **Gates.** Scope, RCM and report gates are signed through the existing Part 11 sign intents, generalised to workpapers. Finding gates close through the existing finding signatures.

**Tech Stack:** Node 22, TypeScript, Express 5, Kysely + Postgres 16, zod, vitest + Testcontainers + supertest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-agent-orchestration-design.md`

## Global Constraints

- **No new npm dependencies.** Code style follows the surrounding files: comment density, naming, plain-language comments.
- **Defaults, copied from the spec.** Each is overridable by the env var named:

  | Setting | Default |
  |---|---|
  | `AGENT_MAX_STEPS` | 200 |
  | `AGENT_MAX_TOKENS` | 2000000 |
  | `AGENT_MAX_COST_USD` | 25 |
  | `AGENT_QA_THRESHOLD` | 70 |
  | `AGENT_POLL_MS` | 3000 |
  | `AGENT_WORKER_CONCURRENCY` | 2 |
  | `AGENT_ENABLED` | `true` (`false` is the kill switch) |

- **Fixed values:**
  - Lease 60 s, heartbeat 15 s.
  - Three `VERSION_CONFLICT`s in a row → `waiting`, reason `engagement being edited`, retried after 60 s.
  - Three consecutive failed iterations → `needs_human`.
  - Self-rework cap: 2 per subject per gate attempt.
  - The second rejected gate for a subject → `needs_human`, reason `gate_rejected_twice: <subjectKey>`.
- **The agent never signs, never writes `testInputs`, never changes a finding whose status is `reviewed` or `approved`, and never sets or clears `notTestedJustification`.**
  - Each refusal is an `AppError(403, …, 'AGENT_FORBIDDEN')` thrown before commit.
- **Agent trail bundles:**
  - `actor` is `agent:<name>`.
  - `inputs` carry `runId` and `onBehalfOf: <started_by user id>`.
  - The worker runs each iteration inside `runWithRequestId(run.id, …)`, so `requestId` is the run ID.
- **Agent-drafted findings have `preparedBy = [started_by]`.**
- **New error codes:** `RUN_ACTIVE` (409), `AGENT_DISABLED` (503), `GATE_STALE` (409), `AGENT_FORBIDDEN` (403; logged as a step, never the result of a user request).
- **Immutable-record triggers** raise `insufficient_privilege` with a message containing `is locked: ` or `is append-only: `, so `http/errors.ts` answers 403 `RECORD_IMMUTABLE`.
- **Every new table is classified** in `tests/db-roles.test.ts` and granted to `audit_api` in its migration.
- **Requirement tags:** tests carry `[REQ-26]`…`[REQ-29]` in their `it(` titles. REQ-30 belongs to plan 2B.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; implementer subagents use their own model's name.
- **No Gartner material** anywhere in code, prompts, packs or the repo.
- **Commands** run from `backend/`.
  - `npm test` needs Docker (Testcontainers).
  - `npm run typecheck` must pass at the end of every task.

## Rulings on the spec (decided here, confirm at plan review)

1. **The offline QA reviewer ships in 2A, not 2B.** Spec §10 places the QA agent in 2B, but the chain opens no gate without QA (§4.2, §5.3). 2A therefore includes the deterministic reviewer that §5.5 already defines for offline mode. 2B adds model review, challenge mode and REQ-30.
2. **A specialist redraft never discards decisions a person made:**
   - A scope redraft keeps each control's existing in/out decision.
   - A findings redraft (Gap Writer) replaces only the rows it targets; every other finding stays as it is.
   - The graph never redrafts the same subject twice from the same basis.
3. **Waits wake on any human change.** Any human change to the engagement (any `mutate`), and any gate signature, moves a `waiting` run (except `paused_by_user`) to `runnable`. The worker re-derives the state and waits again if nothing it needs has changed. This replaces "wake only when the wait condition is met" (§6.2) with something simpler that is just as correct.
4. **Test-plan edits are per row:** `PUT /api/engagements/:id/test-plans/:rowId`.
5. **Rejecting a workpaper gate needs a comment.** The comment is the rework instruction.
6. **Starting a run returns a warning for an audit manager.** `POST …/runs` answers `{ run, warnings }`; when an audit manager starts the run, `warnings` explains that they cannot sign its scope or RCM gates and counts the other active audit managers (§4.3). The UI is plan 2C.
7. **Run policy.** Runs record `policy: 'rules'`. The `'llm'` value and challenge-mode QA are reserved for 2B. Token and cost counts are 0 offline; 2B attributes model usage to steps.
8. **IDs.** Agent run IDs use the prefix `AR-`, gate IDs `GATE-`, agent trail bundles `AGT-`. `RUN-` is already used for module trail bundles.

## Review Focus

- **A rejected scope redraft wiping people's in/out decisions.** Expected: the redraft keeps them. Pinned in Task 6 (`keeps people's scope decisions when the agent redrafts the scope`).
- **Redrafting one finding regenerating every draft finding**, losing human edits and new IDs for findings under signature. Expected: only the targeted row changes. Pinned in Task 6 (`redrafts only the targeted findings`).
- **A person editing a workpaper while its gate is open or mid-signature.** Expected: the signature is refused (`GATE_STALE` or `CONTENT_CHANGED`) and the agent re-reviews. Pinned in Task 7 and Task 11.
- **Cancel or pause arriving while the worker is inside an iteration.** Expected: honoured on the next tick, no further steps, and open gates superseded on cancel. Pinned in Task 5 (repo) and Task 9 (worker).
- **`AGENT_ENABLED=false` while runs are runnable.** Expected: the worker leases nothing and the API refuses new runs with 503. Pinned in Task 9 and Task 10.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `backend/migrations/010_agents.sql` | agent tables, gates, workpaper revisions, test plans column, signature generalisation, grants | 1 |
| `backend/src/agents/types.ts` | shared agent types; T1 core, T3 actions/decisions/graph types | 1, 3 |
| `backend/src/db/schema.ts` | Kysely types for the new tables and columns | 1, 2 |
| `backend/src/db/signature-repo.ts`, `src/signing/intent-repo.ts`, `src/signing/flow.ts`, `src/signing/pages.ts` | signatures and intents that cover a finding or a workpaper | 1, 7 |
| `backend/src/engine/types.ts` | `TestPlan`, `Engagement.testPlans` | 2 |
| `backend/src/signing/content-hash.ts` | `workpaperContentHash` | 2 |
| `backend/src/db/revision-repo.ts`, `src/db/engagement-repo.ts` | workpaper revisions, test plans persisted | 2 |
| `backend/src/agents/subjects.ts` | subject keys, hashes and bases | 3 |
| `backend/src/agents/graph.ts` | `allowedActions`, `redraftBasis`, `latestGateId`, `untestedRows` | 3 |
| `backend/src/agents/policy/rules.ts` | the offline rules policy | 4 |
| `backend/src/agents/qa/deterministic.ts` | offline QA reviewer | 4 |
| `backend/src/agents/specialists/test-plan.ts` | deterministic test-plan drafter | 4 |
| `backend/src/agents/run-repo.ts` | runs, leases, steps, wake | 5 |
| `backend/src/agents/gate-repo.ts` | gates | 5 |
| `backend/src/observability/context.ts` | `runWithRequestId` | 5 |
| `backend/src/agents/rails.ts` | redraft merging and the forbidden-effect checks | 6 |
| `backend/src/agents/port.ts` | `AgentPort`: the only service surface the runtime gets | 6 |
| `backend/src/service.ts` | wake hook, `agentBundle`, agent module path, test plans, gate signing, finding-gate closure | 5, 6, 7 |
| `backend/src/ops/verify.ts` | workpaper signatures and gates | 7 |
| `backend/src/agents/config.ts`, `budget.ts`, `state.ts`, `executor.ts` | config, budget, graph input and reconciliation, decision execution | 8 |
| `backend/src/agents/worker.ts`, `worker-cli.ts` | worker loop and process entry point | 9 |
| `backend/src/agents/runs.ts`, `routes.ts`, `src/http-util.ts`, `src/app.ts`, `src/server.ts` | run lifecycle and HTTP | 10 |
| `backend/validation/requirements.json`, `tests/agents-e2e.test.ts`, `tests/db-roles.test.ts` | requirements and end-to-end evidence | 11 |

---

### Task 1: Migration 010 and signatures that cover workpapers

**Files:**
- Create: `backend/migrations/010_agents.sql`
- Create: `backend/src/agents/types.ts`
- Modify: `backend/src/db/schema.ts`
- Modify: `backend/src/db/signature-repo.ts`
- Modify: `backend/src/signing/intent-repo.ts`
- Modify: `backend/src/signing/flow.ts`
- Modify: `backend/src/signing/pages.ts`
- Modify: `backend/src/service.ts` (the `insertSignature` call in `signOff`)
- Modify: `backend/src/errors.ts`
- Modify: `backend/tests/db-roles.test.ts`
- Test: `backend/tests/agents-db.test.ts`

**Interfaces:**
- Produces (in `src/agents/types.ts`): `RunStatus`, `TERMINAL_STATUSES`, `StepKind`, `GateKind`, `GateState`, `WorkpaperKind`, `SignableWorkpaper`, `Budget`, `Spent`, `NO_SPEND`, `QaIssue`, `QaReport`.
- Produces (schema):
  - tables `agent_runs`, `agent_steps`, `gates`, `workpaper_revisions`;
  - `SignaturesTable` and `SignIntentsTable` gain `subject_kind`, `workpaper` and `gate_id`, and `finding_id` becomes nullable.
- Produces (signature rows): `SignatureRow` gains `subjectKind`, `workpaper` and `gateId`; `findingId` becomes `string | null`.
- Produces (sign intents):
  - `SignIntent` gains `subjectKind`, `workpaper` and `gateId`; `findingId` becomes `string | null`.
  - `createIntent` accepts `{ findingId }` or `{ gateId, workpaper }`.
- Produces (errors): `ErrorCode` gains `RUN_ACTIVE`, `AGENT_DISABLED`, `GATE_STALE`, `AGENT_FORBIDDEN`.

- [ ] **Step 1: Write the failing database tests**

Create `backend/tests/agents-db.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import type { Db } from '../src/db';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

// The database's own rules for the agent tables (migration 010), exercised with plain SQL.

async function setup() {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  return { db: svc.db, e };
}

const insertRun = (db: Db, engagementId: string, id: string, status = 'runnable') =>
  db.execScript(`INSERT INTO agent_runs (id, engagement_id, status, policy, policy_version, budget, started_by)
    VALUES ('${id}', '${engagementId}', '${status}', 'rules', 'rules-1', '{"maxSteps":5,"maxTokens":10,"maxCostUsd":1}', 'auditor')`);

const insertGate = (db: Db, engagementId: string, runId: string, id: string, key = 'scope') =>
  db.execScript(`INSERT INTO gates (id, engagement_id, run_id, kind, subject_key, subject_id, subject_hash, basis_hash, qa_report, attempt)
    VALUES ('${id}', '${engagementId}', '${runId}', 'scope', '${key}', 'scope', 'h1', 'b1', 'null', 1)`);

const insertSignature = (db: Db, engagementId: string, id: string, columns: string, values: string) =>
  db.execScript(`INSERT INTO signatures (id, engagement_id, user_id, user_name, role, meaning, content_hash, reauth_method, trail_bundle_id, signed_at${columns})
    VALUES ('${id}', '${engagementId}', 'reviewer', 'Ravi Reviewer', 'audit_manager', 'Approved', 'h1', 'none', 'HUM-x', now()${values})`);

describe('agent tables (migration 010)', () => {
  it('allows one active run per engagement [REQ-26]', async () => {
    const { db, e } = await setup();
    await insertRun(db, e.id, 'AR-a');
    await expect(insertRun(db, e.id, 'AR-b')).rejects.toThrow(/agent_runs_one_active/);
    await db.execScript(`UPDATE agent_runs SET status = 'completed', ended_at = now() WHERE id = 'AR-a'`);
    await insertRun(db, e.id, 'AR-b');
  });

  it('locks a run once it has ended, and never deletes one [REQ-28]', async () => {
    const { db, e } = await setup();
    await insertRun(db, e.id, 'AR-a', 'completed');
    await expect(db.execScript(`UPDATE agent_runs SET status_reason = 'x' WHERE id = 'AR-a'`)).rejects.toThrow(/is locked: /);
    await insertRun(db, e.id, 'AR-b');
    await expect(db.execScript(`DELETE FROM agent_runs WHERE id = 'AR-b'`)).rejects.toThrow(/is locked: /);
  });

  it('keeps agent steps append-only [REQ-28]', async () => {
    const { db, e } = await setup();
    await insertRun(db, e.id, 'AR-a');
    await db.execScript(`INSERT INTO agent_steps (run_id, seq, kind, agent, decision) VALUES ('AR-a', 1, 'decision', 'supervisor', '{}')`);
    await expect(db.execScript(`UPDATE agent_steps SET agent = 'x'`)).rejects.toThrow(/is append-only: /);
    await expect(db.execScript(`DELETE FROM agent_steps`)).rejects.toThrow(/is append-only: /);
  });

  it('closes a gate only with a signature, and never reopens or rewrites it [REQ-27]', async () => {
    const { db, e } = await setup();
    await insertRun(db, e.id, 'AR-a');
    await insertGate(db, e.id, 'AR-a', 'GATE-1');
    await expect(insertGate(db, e.id, 'AR-a', 'GATE-2')).rejects.toThrow(/gates_one_open/);
    await expect(db.execScript(`UPDATE gates SET state = 'approved' WHERE id = 'GATE-1'`)).rejects.toThrow(/needs a signature/);
    await expect(db.execScript(`UPDATE gates SET subject_hash = 'h2' WHERE id = 'GATE-1'`)).rejects.toThrow(/is locked: /);
    await db.execScript(`UPDATE gates SET state = 'approved', signature_id = 'SIG-1', closed_at = now() WHERE id = 'GATE-1'`);
    await expect(db.execScript(`UPDATE gates SET state = 'open' WHERE id = 'GATE-1'`)).rejects.toThrow(/is locked: /);
    await expect(db.execScript(`DELETE FROM gates WHERE id = 'GATE-1'`)).rejects.toThrow(/is locked: /);
    // An open gate whose subject changed is superseded; that needs no signature.
    await insertGate(db, e.id, 'AR-a', 'GATE-2');
    await db.execScript(`UPDATE gates SET state = 'superseded', closed_at = now() WHERE id = 'GATE-2'`);
  });

  it('keeps workpaper revisions append-only [REQ-19]', async () => {
    const { db, e } = await setup();
    await db.execScript(`INSERT INTO workpaper_revisions (engagement_id, kind, revision, content_hash) VALUES ('${e.id}', 'scope', 1, 'h1')`);
    await expect(db.execScript(`UPDATE workpaper_revisions SET content_hash = 'h2'`)).rejects.toThrow(/is append-only: /);
  });

  it('keeps existing signatures finding signatures, and binds a workpaper signature to its gate [REQ-19]', async () => {
    const { db, e } = await setup();
    await insertSignature(db, e.id, 'SIG-f', ', finding_id', `, 'F-1'`);
    const row = await db.kysely.selectFrom('signatures').select(['subject_kind', 'workpaper', 'gate_id']).where('id', '=', 'SIG-f').executeTakeFirstOrThrow();
    expect(row).toEqual({ subject_kind: 'finding', workpaper: null, gate_id: null });
    await expect(insertSignature(db, e.id, 'SIG-a', ', subject_kind, workpaper', `, 'workpaper', 'scope'`)).rejects.toThrow(/signatures_subject/);
    await expect(insertSignature(db, e.id, 'SIG-b', ', subject_kind, workpaper, gate_id, finding_id', `, 'workpaper', 'scope', 'GATE-1', 'F-1'`)).rejects.toThrow(/signatures_subject/);
    await insertSignature(db, e.id, 'SIG-c', ', subject_kind, workpaper, gate_id', `, 'workpaper', 'scope', 'GATE-1'`);
    await expect(db.execScript(`INSERT INTO signatures (id, engagement_id, user_id, user_name, role, meaning, content_hash, reauth_method, trail_bundle_id, signed_at, subject_kind, workpaper, gate_id)
      VALUES ('SIG-d', '${e.id}', 'reviewer', 'R', 'audit_manager', 'Reviewed', 'h1', 'none', 'HUM-x', now(), 'workpaper', 'rcm', 'GATE-2')`)).rejects.toThrow(/signatures_subject/);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- tests/agents-db.test.ts`
Expected: FAIL. `relation "agent_runs" does not exist` (and similar).

- [ ] **Step 3: Write the migration**

Create `backend/migrations/010_agents.sql`:

```sql
-- Agent orchestration, plan 2A (spec docs/superpowers/specs/2026-10-12-agent-orchestration-design.md §3).

-- Test plans drafted for each RCM row (spec §3.1). Auditors edit them; the agent drafts them.
ALTER TABLE engagement_work ADD COLUMN test_plans jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Every version of a workpaper that a gate or a signature can refer to. Append-only, like finding_revisions.
CREATE TABLE workpaper_revisions (
  engagement_id text NOT NULL REFERENCES engagements (id),
  kind          text NOT NULL CHECK (kind IN ('scope', 'rcm', 'test_plans', 'report')),
  revision      integer NOT NULL CHECK (revision > 0),
  content_hash  text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engagement_id, kind, revision)
);
CREATE TRIGGER workpaper_revisions_append_only BEFORE UPDATE OR DELETE ON workpaper_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER workpaper_revisions_no_truncate BEFORE TRUNCATE ON workpaper_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- One supervisor run of an engagement. The worker that holds the lease is the only writer while it runs.
CREATE TABLE agent_runs (
  id               text PRIMARY KEY,
  engagement_id    text NOT NULL REFERENCES engagements (id),
  goal             text NOT NULL DEFAULT 'engagement' CHECK (goal IN ('engagement')),
  status           text NOT NULL CHECK (status IN ('running', 'runnable', 'waiting', 'needs_human', 'completed', 'cancelled', 'failed')),
  status_reason    text NOT NULL DEFAULT '',
  policy           text NOT NULL CHECK (policy IN ('llm', 'rules')),
  policy_version   text NOT NULL,
  budget           jsonb NOT NULL,
  spent            jsonb NOT NULL DEFAULT '{"steps":0,"tokensIn":0,"tokensOut":0,"costUsd":0}'::jsonb,
  started_by       text NOT NULL REFERENCES users (id),
  cancel_requested boolean NOT NULL DEFAULT false,
  pause_requested  boolean NOT NULL DEFAULT false,
  failure_streak   integer NOT NULL DEFAULT 0,
  conflict_streak  integer NOT NULL DEFAULT 0,
  wake_at          timestamptz,
  lease_owner      text,
  lease_until      timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz
);
CREATE UNIQUE INDEX agent_runs_one_active ON agent_runs (engagement_id) WHERE status NOT IN ('completed', 'cancelled', 'failed');
CREATE INDEX agent_runs_due ON agent_runs (status, updated_at);

CREATE FUNCTION lock_ended_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Agent run % is locked: DELETE rejected', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('completed', 'cancelled', 'failed') THEN
    RAISE EXCEPTION 'Agent run % is locked: it has %', OLD.id, OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agent_runs_lock_ended BEFORE UPDATE OR DELETE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION lock_ended_run();
CREATE TRIGGER agent_runs_no_truncate BEFORE TRUNCATE ON agent_runs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- What the run did, step by step: decisions, delegations, tool calls and QA reviews. Append-only.
CREATE TABLE agent_steps (
  run_id          text NOT NULL REFERENCES agent_runs (id),
  seq             integer NOT NULL CHECK (seq > 0),
  kind            text NOT NULL CHECK (kind IN ('decision', 'delegate', 'tool_call', 'qa')),
  agent           text NOT NULL,
  decision        jsonb NOT NULL,
  model           text,
  tokens_in       integer NOT NULL DEFAULT 0,
  tokens_out      integer NOT NULL DEFAULT 0,
  cost_usd        double precision NOT NULL DEFAULT 0,
  duration_ms     integer NOT NULL DEFAULT 0,
  trail_bundle_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
CREATE TRIGGER agent_steps_append_only BEFORE UPDATE OR DELETE ON agent_steps
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER agent_steps_no_truncate BEFORE TRUNCATE ON agent_steps
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- A human gate (spec §4.3): bound to the exact content and basis it was opened on, closed only by a signature.
CREATE TABLE gates (
  id            text PRIMARY KEY,
  seq           bigserial NOT NULL,
  engagement_id text NOT NULL REFERENCES engagements (id),
  run_id        text NOT NULL REFERENCES agent_runs (id),
  kind          text NOT NULL CHECK (kind IN ('scope', 'rcm', 'finding', 'report')),
  subject_key   text NOT NULL,
  subject_id    text NOT NULL,
  subject_hash  text NOT NULL,
  basis_hash    text NOT NULL,
  qa_report     jsonb NOT NULL,
  attempt       integer NOT NULL CHECK (attempt > 0),
  state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'approved', 'rejected', 'superseded')),
  signature_id  text,
  comment       text NOT NULL DEFAULT '',
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz
);
CREATE UNIQUE INDEX gates_one_open ON gates (engagement_id, subject_key) WHERE state = 'open';
CREATE INDEX gates_by_engagement ON gates (engagement_id, seq);

CREATE FUNCTION guard_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Gate % is locked: DELETE rejected', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.state <> 'open' THEN
    RAISE EXCEPTION 'Gate % is locked: it is already %', OLD.id, OLD.state USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.seq, NEW.engagement_id, NEW.run_id, NEW.kind, NEW.subject_key, NEW.subject_id, NEW.subject_hash,
      NEW.basis_hash, NEW.qa_report, NEW.attempt, NEW.opened_at)
     IS DISTINCT FROM (OLD.id, OLD.seq, OLD.engagement_id, OLD.run_id, OLD.kind, OLD.subject_key, OLD.subject_id, OLD.subject_hash,
      OLD.basis_hash, OLD.qa_report, OLD.attempt, OLD.opened_at) THEN
    RAISE EXCEPTION 'Gate % is locked: only its state, signature, comment and closing time change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.state IN ('approved', 'rejected') AND NEW.signature_id IS NULL THEN
    RAISE EXCEPTION 'Gate % is locked: closing it needs a signature', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER gates_guard BEFORE UPDATE OR DELETE ON gates
  FOR EACH ROW EXECUTE FUNCTION guard_gate();
CREATE TRIGGER gates_no_truncate BEFORE TRUNCATE ON gates
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Signatures and signing requests cover a finding (as before) or a workpaper gate (scope, RCM, report; spec §3.2).
-- Existing rows keep their meaning: the defaults describe them.
ALTER TABLE signatures
  ADD COLUMN subject_kind text NOT NULL DEFAULT 'finding' CHECK (subject_kind IN ('finding', 'workpaper')),
  ADD COLUMN workpaper text CHECK (workpaper IN ('scope', 'rcm', 'report')),
  ADD COLUMN gate_id text,
  ALTER COLUMN finding_id DROP NOT NULL;
ALTER TABLE signatures ADD CONSTRAINT signatures_subject CHECK (
  (subject_kind = 'finding' AND finding_id IS NOT NULL AND workpaper IS NULL AND gate_id IS NULL)
  OR (subject_kind = 'workpaper' AND finding_id IS NULL AND workpaper IS NOT NULL AND gate_id IS NOT NULL AND meaning IN ('Approved', 'Rejected')));

ALTER TABLE sign_intents
  ADD COLUMN subject_kind text NOT NULL DEFAULT 'finding' CHECK (subject_kind IN ('finding', 'workpaper')),
  ADD COLUMN workpaper text CHECK (workpaper IN ('scope', 'rcm', 'report')),
  ADD COLUMN gate_id text,
  ALTER COLUMN finding_id DROP NOT NULL;
ALTER TABLE sign_intents ADD CONSTRAINT sign_intents_subject CHECK (
  (subject_kind = 'finding' AND finding_id IS NOT NULL AND workpaper IS NULL AND gate_id IS NULL)
  OR (subject_kind = 'workpaper' AND finding_id IS NULL AND workpaper IS NOT NULL AND gate_id IS NOT NULL AND action IN ('approve', 'reject')));

-- The API role (009): runs and gates change state in place; steps and revisions are written once.
GRANT SELECT, INSERT, UPDATE ON agent_runs, gates TO audit_api;
GRANT SELECT, INSERT ON agent_steps, workpaper_revisions TO audit_api;
GRANT USAGE ON SEQUENCE gates_seq_seq TO audit_api;
```

- [ ] **Step 4: Add the core agent types**

Create `backend/src/agents/types.ts`:

```ts
// Shared types for agent orchestration (spec docs/superpowers/specs/2026-10-12-agent-orchestration-design.md).

export type RunStatus = 'running' | 'runnable' | 'waiting' | 'needs_human' | 'completed' | 'cancelled' | 'failed';
export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'cancelled', 'failed'];

export type StepKind = 'decision' | 'delegate' | 'tool_call' | 'qa';
export type GateKind = 'scope' | 'rcm' | 'finding' | 'report';
export type GateState = 'open' | 'approved' | 'rejected' | 'superseded';
export type WorkpaperKind = 'scope' | 'rcm' | 'test_plans' | 'report';
/** Workpapers a gate signature can cover. Test plans have no gate. */
export type SignableWorkpaper = 'scope' | 'rcm' | 'report';

export interface Budget {
  maxSteps: number;
  maxTokens: number;
  maxCostUsd: number;
}

export interface Spent {
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export const NO_SPEND: Spent = { steps: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };

export interface QaIssue {
  criterion: string;
  severity: 'blocking' | 'advisory';
  detail: string;
}

/** A QA review of one subject at one content hash (spec §5.5). */
export interface QaReport {
  subjectKey: string;
  subjectHash: string;
  mode: 'review' | 'challenge';
  reviewer: string;
  /** 0–100 */
  score: number;
  issues: QaIssue[];
}
```

- [ ] **Step 5: Type the new tables and the generalised signature columns**

In `backend/src/db/schema.ts`:
- Add this import beside the existing ones:

```ts
import type { Budget, GateKind, GateState, QaReport, RunStatus, SignableWorkpaper, Spent, StepKind, WorkpaperKind } from '../agents/types';
```

- Replace `SignaturesTable` and `SignIntentsTable` with:

```ts
export interface SignaturesTable {
  id: string;
  engagement_id: string;
  /** null for a workpaper signature. */
  finding_id: string | null;
  subject_kind: ColumnType<'finding' | 'workpaper', 'finding' | 'workpaper' | undefined, never>;
  workpaper: ColumnType<SignableWorkpaper | null, SignableWorkpaper | null | undefined, never>;
  gate_id: NullableText;
  user_id: string;
  user_name: string;
  role: string;
  meaning: 'Reviewed' | 'Approved' | 'Rejected';
  comment: string;
  content_hash: string;
  reauth_method: 'oidc' | 'dev' | 'none';
  reauth_at: NullableTimestamp;
  intent_id: NullableText;
  trail_bundle_id: string;
  signed_at: Timestamp;
}

export interface SignIntentsTable {
  id: string;
  user_id: string;
  engagement_id: string;
  finding_id: string | null;
  subject_kind: ColumnType<'finding' | 'workpaper', 'finding' | 'workpaper' | undefined, never>;
  workpaper: ColumnType<SignableWorkpaper | null, SignableWorkpaper | null | undefined, never>;
  gate_id: NullableText;
  action: 'review' | 'approve' | 'reject';
  comment: string;
  content_hash: string;
  state: string;
  nonce: string;
  code_verifier: string;
  created_at: Generated<Date>;
  expires_at: Timestamp;
  status: ColumnType<'pending' | 'claimed' | 'signed' | 'failed', 'pending' | undefined, 'claimed' | 'signed' | 'failed'>;
  failure_code: NullableText;
  failure_message: NullableText;
  completed_at: NullableTimestamp;
}
```

- Add the new tables before `export interface DB`:

```ts
export interface WorkpaperRevisionsTable {
  engagement_id: string;
  kind: WorkpaperKind;
  revision: number;
  content_hash: string;
  recorded_at: Generated<Date>;
}

type Flag = ColumnType<boolean, boolean | undefined, boolean>;
type Count = ColumnType<number, number | undefined, number>;

export interface AgentRunsTable {
  id: string;
  engagement_id: string;
  goal: ColumnType<'engagement', 'engagement' | undefined, never>;
  status: RunStatus;
  status_reason: ColumnType<string, string | undefined, string>;
  policy: 'llm' | 'rules';
  policy_version: string;
  budget: Json<Budget>;
  spent: ColumnType<Spent, string | undefined, string>;
  started_by: string;
  cancel_requested: Flag;
  pause_requested: Flag;
  failure_streak: Count;
  conflict_streak: Count;
  wake_at: NullableTimestamp;
  lease_owner: NullableText;
  lease_until: NullableTimestamp;
  version: Count;
  created_at: Generated<Date>;
  updated_at: DefaultedTimestamp;
  ended_at: NullableTimestamp;
}

export interface AgentStepsTable {
  run_id: string;
  seq: number;
  kind: StepKind;
  agent: string;
  decision: ColumnType<unknown, string, never>;
  model: ColumnType<string | null, string | null | undefined, never>;
  tokens_in: ColumnType<number, number | undefined, never>;
  tokens_out: ColumnType<number, number | undefined, never>;
  cost_usd: ColumnType<number, number | undefined, never>;
  duration_ms: ColumnType<number, number | undefined, never>;
  trail_bundle_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: Generated<Date>;
}

export interface GatesTable {
  id: string;
  seq: Generated<number>;
  engagement_id: string;
  run_id: string;
  kind: GateKind;
  subject_key: string;
  subject_id: string;
  subject_hash: string;
  basis_hash: string;
  qa_report: ColumnType<QaReport | null, string, never>;
  attempt: number;
  state: ColumnType<GateState, GateState | undefined, GateState>;
  signature_id: NullableText;
  comment: ColumnType<string, string | undefined, string>;
  opened_at: Generated<Date>;
  closed_at: NullableTimestamp;
}
```

- Add `workpaper_revisions: WorkpaperRevisionsTable; agent_runs: AgentRunsTable; agent_steps: AgentStepsTable; gates: GatesTable;` to `DB`.

- [ ] **Step 6: Carry the subject through signature rows and signing requests**

In `backend/src/db/signature-repo.ts`, replace `SignatureRow`, `insertSignature` and the mapping in `listSignatures`:

```ts
import type { SignableWorkpaper } from '../agents/types';
import type { Executor } from './trail-repo';

export interface SignatureRow {
  id: string;
  engagementId: string;
  /** The finding signed; null for a workpaper gate signature. */
  findingId: string | null;
  subjectKind: 'finding' | 'workpaper';
  workpaper: SignableWorkpaper | null;
  gateId: string | null;
  userId: string;
  userName: string;
  role: string;
  meaning: 'Reviewed' | 'Approved' | 'Rejected';
  comment: string;
  contentHash: string;
  reauthMethod: 'oidc' | 'dev' | 'none';
  reauthAt: string | null;
  intentId: string | null;
  trailBundleId: string;
  signedAt: string;
}

const iso = (d: Date | string) => new Date(d).toISOString();

export async function insertSignature(db: Executor, s: SignatureRow): Promise<void> {
  await db
    .insertInto('signatures')
    .values({
      id: s.id, engagement_id: s.engagementId, finding_id: s.findingId, subject_kind: s.subjectKind, workpaper: s.workpaper, gate_id: s.gateId,
      user_id: s.userId, user_name: s.userName, role: s.role, meaning: s.meaning, comment: s.comment, content_hash: s.contentHash,
      reauth_method: s.reauthMethod, reauth_at: s.reauthAt, intent_id: s.intentId, trail_bundle_id: s.trailBundleId, signed_at: s.signedAt,
    })
    .execute();
}

export async function listSignatures(db: Executor, engagementId: string): Promise<SignatureRow[]> {
  const rows = await db.selectFrom('signatures').selectAll().where('engagement_id', '=', engagementId).orderBy('signed_at').orderBy('id').execute();
  return rows.map((r) => ({
    id: r.id, engagementId: r.engagement_id, findingId: r.finding_id, subjectKind: r.subject_kind, workpaper: r.workpaper, gateId: r.gate_id,
    userId: r.user_id, userName: r.user_name, role: r.role, meaning: r.meaning, comment: r.comment, contentHash: r.content_hash,
    reauthMethod: r.reauth_method, reauthAt: r.reauth_at ? iso(r.reauth_at) : null, intentId: r.intent_id, trailBundleId: r.trail_bundle_id,
    signedAt: iso(r.signed_at),
  }));
}
```

In `backend/src/service.ts` `signOff`, the `insertSignature(trx, { … })` call gains `findingId, subjectKind: 'finding', workpaper: null, gateId: null,` (the `findingId` key is already there; add the other three).

In `backend/src/signing/intent-repo.ts`:
- Add `import type { SignableWorkpaper } from '../agents/types';`.
- Replace `SignIntent`, `toIntent` and `createIntent`:

```ts
export interface SignIntent {
  id: string;
  userId: string;
  engagementId: string;
  /** What is being signed: a finding, or the workpaper of a scope, RCM or report gate. */
  subjectKind: 'finding' | 'workpaper';
  findingId: string | null;
  workpaper: SignableWorkpaper | null;
  gateId: string | null;
  action: SignAction;
  comment: string;
  contentHash: string;
  /** One-time OIDC values for this request's re-authentication. */
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'claimed' | 'signed' | 'failed';
  failureCode: string | null;
  failureMessage: string | null;
}

function toIntent(r: Selectable<SignIntentsTable>): SignIntent {
  return {
    id: r.id, userId: r.user_id, engagementId: r.engagement_id, subjectKind: r.subject_kind, findingId: r.finding_id, workpaper: r.workpaper,
    gateId: r.gate_id, action: r.action, comment: r.comment, contentHash: r.content_hash, state: r.state, nonce: r.nonce,
    codeVerifier: r.code_verifier, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), status: r.status,
    failureCode: r.failure_code, failureMessage: r.failure_message,
  };
}

export type IntentSubject = { findingId: string } | { gateId: string; workpaper: SignableWorkpaper };

export async function createIntent(
  db: Executor,
  p: { userId: string; engagementId: string; action: SignAction; comment: string; contentHash: string } & IntentSubject,
  now = new Date(),
): Promise<SignIntent> {
  const subject = 'gateId' in p
    ? { subject_kind: 'workpaper' as const, finding_id: null, workpaper: p.workpaper, gate_id: p.gateId }
    : { subject_kind: 'finding' as const, finding_id: p.findingId, workpaper: null, gate_id: null };
  const row = await db
    .insertInto('sign_intents')
    .values({
      id: `INT-${crypto.randomBytes(8).toString('hex')}`, user_id: p.userId, engagement_id: p.engagementId, ...subject,
      action: p.action, comment: p.comment, content_hash: p.contentHash, state: token(), nonce: token(), code_verifier: token(),
      expires_at: new Date(now.getTime() + INTENT_TTL_MS).toISOString(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toIntent(row);
}
```

In `backend/src/signing/flow.ts`:
- `inputsOf` becomes:

```ts
const inputsOf = (intent: SignIntent) => ({ intentId: intent.id, engagementId: intent.engagementId, findingId: intent.findingId, gateId: intent.gateId, action: intent.action });
```

- In `completeSigning`, put this just before the `try { await svc.signOff(…` block. Task 7 replaces it with the gate-signing branch.

```ts
  if (intent.subjectKind !== 'finding' || !intent.findingId) {
    return failIntent(svc, intent, actor, 'INTERNAL', 'This signing request is not for a finding.', CLAIMED);
  }
```

- Change `svc.signOff(intent.engagementId, intent.findingId, …` to keep using `intent.findingId`. It is now narrowed to `string`.

In `backend/src/signing/pages.ts`:
- Add above `devConfirmPage`:

```ts
const WORKPAPER = { scope: 'scope', rcm: 'RCM', report: 'report' } as const;

/** What the signer is signing, as HTML. */
const subjectOf = (intent: SignIntent) =>
  intent.subjectKind === 'workpaper' && intent.workpaper
    ? `the <b>${WORKPAPER[intent.workpaper]}</b> workpaper`
    : `finding <b>${escapeHtml(intent.findingId ?? '')}</b>`;
```

- Change the sentence to:

```ts
        `<p>${escapeHtml(userName)}, you are signing ${subjectOf(intent)} as <b>${MEANING[intent.action]}</b>.</p>` +
```

In `backend/src/errors.ts`, add to `ErrorCode` (after `'RATE_LIMITED'`):

```ts
  | 'RUN_ACTIVE'
  | 'AGENT_DISABLED'
  | 'GATE_STALE'
  | 'AGENT_FORBIDDEN'
```

In `backend/tests/db-roles.test.ts`, extend `PRIVILEGES`:
- `agent_runs: 'write', gates: 'write'`
- `agent_steps: 'append', workpaper_revisions: 'append'`

Next to the existing `findings_seq_seq` assertion, add:

```ts
    expect((await sql<{ ok: boolean }>`SELECT has_sequence_privilege('audit_api', 'public.gates_seq_seq', 'USAGE') AS ok`.execute(owner.kysely)).rows[0].ok).toBe(true);
```

- [ ] **Step 7: Run the new tests, the signing tests and the type check**

Run: `npm test -- tests/agents-db.test.ts tests/db-roles.test.ts tests/signing-service.test.ts tests/signing-http.test.ts tests/signing-oidc.test.ts tests/signing-store.test.ts tests/verify.test.ts && npm run typecheck`
Expected: PASS. Every existing signing test stays green; that is the spec §11 condition for starting gate work.

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add backend/migrations/010_agents.sql backend/src/agents/types.ts backend/src/db/schema.ts backend/src/db/signature-repo.ts \
  backend/src/signing/intent-repo.ts backend/src/signing/flow.ts backend/src/signing/pages.ts backend/src/service.ts backend/src/errors.ts \
  backend/tests/agents-db.test.ts backend/tests/db-roles.test.ts
git commit -m "feat(agents): migration 010 for runs, steps, gates and workpaper signatures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Test plans and workpaper revisions

**Files:**
- Modify: `backend/src/engine/types.ts`
- Modify: `backend/src/db/schema.ts` (`EngagementWorkTable`)
- Modify: `backend/src/signing/content-hash.ts`
- Modify: `backend/src/db/revision-repo.ts`
- Modify: `backend/src/db/engagement-repo.ts`
- Modify: `backend/src/service.ts` (`createEngagement`)
- Modify: `backend/tests/engagement-repo.test.ts` (engagement literal gains `testPlans: {}`)
- Test: `backend/tests/workpapers.test.ts`

**Interfaces:**
- Consumes: `WorkpaperKind` (Task 1).
- Produces (types):
  - `TestPlan` in `engine/types.ts`;
  - `Engagement.testPlans: Record<string, TestPlan>`, required, `{}` when there are none.
- Produces (functions):
  - `workpaperContentHash(kind: WorkpaperKind, e: Engagement): string` in `signing/content-hash.ts`;
  - `recordWorkpaperRevisions(db: Executor, e: Engagement): Promise<void>` and `WORKPAPER_KINDS` in `db/revision-repo.ts`.
- `saveEngagement` and `insertEngagement` now persist `testPlans` and record workpaper revisions.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/workpapers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { insertEngagement, loadEngagement, saveEngagement } from '../src/db/engagement-repo';
import type { Engagement, TestPlan } from '../src/engine/types';
import type { AuditService } from '../src/service';
import { workpaperContentHash } from '../src/signing/content-hash';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

const revisions = (svc: AuditService, id: string) =>
  svc.db.kysely.selectFrom('workpaper_revisions').select(['kind', 'revision']).where('engagement_id', '=', id).orderBy('kind').orderBy('revision').execute();

const plan: TestPlan = {
  rowId: 'FD-HACCP-03', rowHash: 'h', attribute: 'CCP logs are signed', population: 'All CCP logs in the period', sampleSize: 5,
  selectionMethod: 'random', evidenceToRequest: ['CCP log'], procedure: 'Inspect signatures',
};

describe('workpapers', () => {
  it('binds each workpaper to a hash of its content [REQ-19]', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    const scoped = await svc.engagement(e.id);
    const hash = workpaperContentHash('scope', scoped);
    expect(workpaperContentHash('scope', structuredClone(scoped))).toBe(hash);
    const toggled = structuredClone(scoped);
    toggled.scope[0].included = !toggled.scope[0].included;
    expect(workpaperContentHash('scope', toggled)).not.toBe(hash);
    // An empty RCM and a missing report never collide: the kind is part of the hash.
    expect(workpaperContentHash('rcm', { ...scoped, rcm: [] })).not.toBe(workpaperContentHash('scope', { ...scoped, scope: [] }));
  });

  it('records a workpaper revision whenever its content changes, and only then [REQ-19]', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    expect(await revisions(svc, e.id)).toEqual([]);
    await svc.runModule(e.id, 'scope', auditor);
    expect(await revisions(svc, e.id)).toEqual([{ kind: 'scope', revision: 1 }]);
    const first = (await svc.engagement(e.id)).scope[0];
    await svc.setScope(e.id, [{ controlId: first.controlId, included: !first.included }], auditor);
    await svc.setScope(e.id, [{ controlId: first.controlId, included: !first.included }], auditor);
    expect(await revisions(svc, e.id)).toEqual([{ kind: 'scope', revision: 1 }, { kind: 'scope', revision: 2 }]);
  });

  it('stores test plans with the engagement and records their revisions', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    expect(e.testPlans).toEqual({});
    await svc.db.kysely.transaction().execute(async (trx) => {
      const loaded = (await loadEngagement(trx, e.id, { forUpdate: true }))!;
      loaded.engagement.testPlans = { [plan.rowId]: plan };
      await saveEngagement(trx, loaded);
    });
    expect((await svc.engagement(e.id)).testPlans).toEqual({ [plan.rowId]: plan });
    expect(await revisions(svc, e.id)).toEqual([{ kind: 'test_plans', revision: 1 }]);
  });

  it('loads an engagement saved without test plans (an MVP import) with none', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const legacy = { ...structuredClone(e), id: 'ENG-LEGACY' } as Partial<Engagement>;
    delete legacy.testPlans;
    await svc.db.kysely.transaction().execute((trx) => insertEngagement(trx, legacy as Engagement));
    expect((await svc.engagement('ENG-LEGACY')).testPlans).toEqual({});
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/workpapers.test.ts`
Expected: FAIL. `workpaperContentHash` is not exported, and `testPlans` is undefined.

- [ ] **Step 3: Add `TestPlan` and `Engagement.testPlans`**

In `backend/src/engine/types.ts`:
- Add after `TestResult`:

```ts
/** A drafted test plan for one RCM row (agent spec §3.1). Auditors may edit it; only an auditor sets notTestedJustification. */
export interface TestPlan {
  rowId: string;
  /** SHA-256 of the RCM row the plan was drafted from; a changed row gets a fresh draft. */
  rowHash: string;
  attribute: string;
  population: string;
  sampleSize: number;
  selectionMethod: 'random' | 'all' | 'judgemental';
  evidenceToRequest: string[];
  procedure: string;
  /** Set by an auditor only: why this row will not be tested. The agent never sets or clears it. */
  notTestedJustification?: string;
  editedBy?: string;
  editedAt?: string;
}
```

- Add to `Engagement` after `testResults`:

```ts
  /** Test plans by RCM row id. */
  testPlans: Record<string, TestPlan>;
```

In `backend/src/db/schema.ts`:
- Add `TestPlan` to the engine-types import.
- Add to `EngagementWorkTable`:

```ts
  test_plans: ColumnType<Record<string, TestPlan>, string | undefined, string>;
```

In `backend/tests/engagement-repo.test.ts`, the literal engagement on line 17 gains `testPlans: {},` after `testResults: {},`.

In `backend/src/service.ts` `createEngagement`, the new engagement literal gains `testPlans: {},` after `testResults: {},`.

- [ ] **Step 4: Hash workpapers and record their revisions**

Append to `backend/src/signing/content-hash.ts`, and add `import type { WorkpaperKind } from '../agents/types';` at the top:

```ts
/** SHA-256 of a workpaper's content: what a gate and its signature are bound to (agent spec §4.4). */
export function workpaperContentHash(kind: WorkpaperKind, e: Engagement): string {
  const content =
    kind === 'scope' ? e.scope
    : kind === 'rcm' ? e.rcm
    : kind === 'test_plans' ? e.testPlans ?? {}
    : e.report ? { markdown: e.report.markdown, includedFindingIds: e.report.includedFindingIds, excludedFindingIds: e.report.excludedFindingIds } : null;
  return sha256(canonicalJson({ kind, content }));
}
```

Append to `backend/src/db/revision-repo.ts`:
- Extend the imports to `import type { Engagement, Finding } from '../engine/types';`.
- Add `import { findingContentHash, workpaperContentHash } from '../signing/content-hash';`.
- Add `import type { WorkpaperKind } from '../agents/types';`.

```ts
export const WORKPAPER_KINDS: readonly WorkpaperKind[] = ['scope', 'rcm', 'test_plans', 'report'];

const isEmpty = (kind: WorkpaperKind, e: Engagement) =>
  kind === 'scope' ? !e.scope.length : kind === 'rcm' ? !e.rcm.length : kind === 'test_plans' ? !Object.keys(e.testPlans ?? {}).length : !e.report;

/** Appends a revision for each workpaper whose content differs from its latest recorded revision. Empty workpapers are skipped. */
export async function recordWorkpaperRevisions(db: Executor, e: Engagement): Promise<void> {
  for (const kind of WORKPAPER_KINDS) {
    if (isEmpty(kind, e)) continue;
    const hash = workpaperContentHash(kind, e);
    const last = await db
      .selectFrom('workpaper_revisions')
      .select(['revision', 'content_hash'])
      .where('engagement_id', '=', e.id)
      .where('kind', '=', kind)
      .orderBy('revision', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (last?.content_hash === hash) continue;
    await db
      .insertInto('workpaper_revisions')
      .values({ engagement_id: e.id, kind, revision: (last?.revision ?? 0) + 1, content_hash: hash })
      .execute();
  }
}
```

In `backend/src/db/engagement-repo.ts`:
- Import `recordWorkpaperRevisions` from `./revision-repo` alongside `recordRevision`.
- `insertEngagement`: the `engagement_work` values gain `test_plans: json(e.testPlans ?? {}),`. After the findings loop, add `await recordWorkpaperRevisions(db, e);`.
- `loadEngagement`: the engagement literal gains `testPlans: w.test_plans ?? {},` after `testResults: w.test_results,`.
- `saveEngagement`: the `engagement_work` `.set({ … })` gains `test_plans: json(e.testPlans ?? {}),`. As the last statement before `e.version = loaded.version + 1;`, add `await recordWorkpaperRevisions(db, e);`.

- [ ] **Step 5: Run the tests**

Run: `npm test -- tests/workpapers.test.ts tests/engagement-repo.test.ts tests/persistence.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add backend/src/engine/types.ts backend/src/db/schema.ts backend/src/signing/content-hash.ts backend/src/db/revision-repo.ts \
  backend/src/db/engagement-repo.ts backend/src/service.ts backend/tests/engagement-repo.test.ts backend/tests/workpapers.test.ts
git commit -m "feat(agents): test plans on engagements and workpaper revisions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The engagement graph

**Files:**
- Modify: `backend/src/agents/types.ts` (append)
- Create: `backend/src/agents/subjects.ts`
- Create: `backend/src/agents/graph.ts`
- Test: `backend/tests/graph.test.ts`

**Interfaces:**
- Consumes: `workpaperContentHash`, `findingContentHash`, `TestPlan` (Task 2); `canonicalJson` and `sha256` (`engine/trail.ts`).
- Produces (`types.ts`):
  - `SPECIALISTS`, `Specialist`;
  - `ActionSchema`, `Action`, `DecisionSchema`, `Decision`;
  - `Stage`, `GateRecord`, `RedraftRecord`, `GraphInput`, `Menu`, `Policy`;
  - `MAX_SELF_REWORKS`, `MAX_REJECTIONS`, `sameAction`.
- Produces (`subjects.ts`): `findingKey(rowId)`, `rowOfKey(key)`, `rootBasis(e)`, `rowBasis(e, rowId)`, `approvedFindingsBasis(e)`, `rcmRowHash(row)`, `plansCurrent(e)`, `SubjectInfo`, `subjectInfo(e, key)`.
- Produces (`graph.ts`): `allowedActions(input: GraphInput): Menu`, `redraftBasis(e, subjectKey, rows?)`, `latestGateId(gates, key)`, `untestedRows(e)`.

**Subject keys:**

| Key | Gate |
|---|---|
| `scope`, `rcm`, `report` | its own gate |
| `test_plans` | none |
| `finding:<rowId>` | one per RCM row; the finding ID changes when it is redrafted, the key does not |
| `testing`, `gaps` | never gated (used only as redraft keys) |

**Basis table** (what a subject is built from; a gate records it when it opens):

| Subject | Basis |
|---|---|
| scope | `rootBasis(e)`: scope statement and packs |
| rcm | `workpaperContentHash('scope', e)` |
| test_plans | `workpaperContentHash('rcm', e)` |
| finding:<row> | `rowBasis(e, row)`: that row's test input and result |
| report | `approvedFindingsBasis(e)` |

A gated subject is passed when its latest non-superseded gate is `approved` and both its `subjectHash` and `basisHash` match now.

- [ ] **Step 1: Write the failing graph tests**

Create `backend/tests/graph.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { allowedActions } from '../src/agents/graph';
import { findingKey, rcmRowHash, subjectInfo } from '../src/agents/subjects';
import type { Action, GateRecord, GateState, GraphInput, Menu, QaIssue, QaReport, RedraftRecord } from '../src/agents/types';
import type { Citation, Engagement, Finding, RcmRow, ScopeItem, TestInput, TestPlan, TestResult } from '../src/engine/types';

// The graph is a pure function: these tests build engagements in memory and read the menu it offers.

const cite: Citation = { clauseId: 'C1', regulation: 'Reg', ref: '§1', label: 'Reg §1' };
const scopeItem = (id: string, included = true): ScopeItem => ({
  controlId: id, packId: 'p', processArea: 'a', risk: 'r', inherentRisk: 'Medium', relevance: 1, rationale: 'x', citations: [cite], included,
});
const row = (id: string): RcmRow => ({
  id, controlId: id, packId: 'p', processArea: 'a', risk: 'r', riskRating: 'Medium', control: `Control ${id}`, objective: 'o', type: 'Preventive',
  nature: 'Manual', frequency: 'Monthly', sampleSize: 2, testOfDesign: ['d'], testOfEffectiveness: ['t'], evidenceExpected: ['ev'], checklist: [], citations: [cite],
});
const plan = (r: RcmRow, over: Partial<TestPlan> = {}): TestPlan => ({
  rowId: r.id, rowHash: rcmRowHash(r), attribute: 'a', population: 'p', sampleSize: 2, selectionMethod: 'random', evidenceToRequest: ['ev'], procedure: 't', ...over,
});
const input = (exceptions = 1): TestInput => ({ designAdequate: true, observation: 'o', evidenceRefs: ['E1'], sampleTested: 2, exceptions, updatedBy: 'auditor', updatedAt: 't' });
const result = (rowId: string, conclusion: TestResult['conclusion'] = 'Ineffective'): TestResult => ({ rowId, conclusion, rationale: 'x', exceptionRate: 0.5, qaFlags: [] });
const finding = (rowId: string, status: Finding['status'] = 'draft'): Finding => ({
  id: `F-${rowId}`, rowId, controlId: rowId, title: 't', rating: 'Medium', condition: 'c', criteria: 'k', cause: 'u', effect: 'f', recommendation: 'r',
  citations: [cite], evidenceRefs: ['E1'], status, blockedReasons: [], signOffs: [], bundleId: 'RUN-1',
});

function engagement(over: Partial<Engagement> = {}): Engagement {
  return {
    id: 'ENG-1', name: 'n', entity: 'e', site: 's', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 't', scopeStatement: 'stmt',
    packIds: ['p'], createdBy: 'auditor', createdAt: '2026-01-01T00:00:00.000Z', stage: 'planning', scope: [], rcm: [], testInputs: {},
    testResults: {}, testPlans: {}, findings: [], report: null, ...over,
  };
}

let gateSeq = 0;
function gate(e: Engagement, key: string, state: GateState, over: Partial<GateRecord> = {}): GateRecord {
  const s = subjectInfo(e, key)!;
  const signed = state === 'approved' || state === 'rejected';
  return {
    id: `GATE-${++gateSeq}`, kind: s.gateKind!, subjectKey: key, subjectId: s.subjectId, subjectHash: s.hash, basisHash: s.basis, state,
    attempt: 1, comment: '', signatureId: signed ? 'SIG-1' : null, ...over,
  };
}
const qa = (e: Engagement, key: string, issues: QaIssue[] = [], score = 100): QaReport => ({
  subjectKey: key, subjectHash: subjectInfo(e, key)!.hash, mode: 'review', reviewer: 'test', score, issues,
});
const blocking: QaIssue = { criterion: 'x', severity: 'blocking', detail: 'broken' };
const advisory: QaIssue = { criterion: 'y', severity: 'advisory', detail: 'odd' };

function menu(e: Engagement, over: Partial<GraphInput> = {}): Menu {
  const m = allowedActions({ engagement: e, gates: [], qa: [], redrafts: [], qaThreshold: 70, ...over });
  // Every state the graph can be asked about offers at least one action.
  expect(m.actions.length).toBeGreaterThan(0);
  return m;
}
const types = (m: Menu) => m.actions.map((a) => a.type);

/** Scope and RCM approved and current. */
function throughRcm() {
  const e = engagement({ scope: [scopeItem('A')], rcm: [row('A')] });
  return { e, gates: [gate(e, 'scope', 'approved'), gate(e, 'rcm', 'approved')] };
}
/** Plus test plans drafted and reviewed. */
function planned() {
  const { e, gates } = throughRcm();
  e.testPlans = { A: plan(e.rcm[0]) };
  return { e, gates, qa: [qa(e, 'test_plans')] };
}

describe('the engagement graph', () => {
  it('delegates the scope first on a new engagement [REQ-26]', () => {
    const m = menu(engagement());
    expect(m.stage).toBe('scope');
    expect(m.actions).toEqual([{ type: 'delegate', specialist: 'scope', subjectKey: 'scope' }]);
  });

  it('asks for QA before any gate, and offers only the gate when QA is clean [REQ-26]', () => {
    const e = engagement({ scope: [scopeItem('A')] });
    expect(menu(e).actions).toEqual([{ type: 'request_qa', subjectKey: 'scope', mode: 'review' }]);
    expect(menu(e, { qa: [qa(e, 'scope')] }).actions).toEqual([{ type: 'open_gate', subjectKey: 'scope' }]);
  });

  it('never offers an action past an unapproved gate [REQ-26]', () => {
    const e = engagement({ scope: [scopeItem('A')], rcm: [row('A')] });
    // The RCM was approved once, but the scope gate is open again: the run waits on the scope.
    const m = menu(e, { gates: [gate(e, 'rcm', 'approved'), gate(e, 'scope', 'open')] });
    expect(m.stage).toBe('scope');
    expect(m.actions).toEqual([{ type: 'wait', reason: 'awaiting scope gate signature' }]);
  });

  it('offers the gate, a redraft and escalation after QA issues, within the caps [REQ-26]', () => {
    const e = engagement({ scope: [scopeItem('A')] });
    expect(types(menu(e, { qa: [qa(e, 'scope', [advisory], 60)] }))).toEqual(['open_gate', 'rework', 'escalate']);
    expect(types(menu(e, { qa: [qa(e, 'scope', [blocking], 75)] }))).toEqual(['rework', 'escalate']);
    const twice: RedraftRecord[] = [
      { subjectKey: 'scope', kind: 'rework', basis: 'b', sinceGateId: null },
      { subjectKey: 'scope', kind: 'rework', basis: 'b', sinceGateId: null },
    ];
    expect(types(menu(e, { qa: [qa(e, 'scope', [blocking], 75)], redrafts: twice }))).toEqual(['escalate']);
    expect(types(menu(e, { qa: [qa(e, 'scope', [advisory], 60)], redrafts: twice }))).toEqual(['open_gate', 'escalate']);
  });

  it("redrafts a rejected workpaper from the signer's comment, then escalates when nothing changed or after two rejections [REQ-26]", () => {
    const e = engagement({ scope: [scopeItem('A')] });
    const rejected = gate(e, 'scope', 'rejected', { comment: 'Add the segregation-of-duties controls' });
    expect(menu(e, { gates: [rejected] }).actions).toEqual([
      { type: 'rework', specialist: 'scope', subjectKey: 'scope', instruction: 'Add the segregation-of-duties controls' },
    ]);
    const redrafted: RedraftRecord = { subjectKey: 'scope', kind: 'rework', basis: subjectInfo(e, 'scope')!.basis, sinceGateId: rejected.id };
    expect(menu(e, { gates: [rejected], redrafts: [redrafted] }).actions[0]).toMatchObject({ type: 'escalate', reason: expect.stringMatching(/^rework produced no change: scope/) });
    const twice = [gate(e, 'scope', 'rejected', { attempt: 1 }), gate(e, 'scope', 'rejected', { attempt: 2 })];
    expect(menu(e, { gates: twice }).actions).toEqual([{ type: 'escalate', reason: 'gate_rejected_twice: scope' }]);
  });

  it('sends an approved workpaper edited by hand back through QA, and rebuilds one whose basis changed, once [REQ-26]', () => {
    const e = engagement({ scope: [scopeItem('A'), scopeItem('B', false)], rcm: [row('A')] });
    const approvedScope = gate(e, 'scope', 'approved');
    const approvedRcm = gate(e, 'rcm', 'approved');
    const edited = structuredClone(e);
    edited.scope[1].included = true;
    expect(menu(edited, { gates: [approvedScope, approvedRcm] }).actions).toEqual([{ type: 'request_qa', subjectKey: 'scope', mode: 'review' }]);

    // The scope was re-approved after the edit, so the RCM was built from an older scope: rebuild it, then review the rebuilt RCM.
    const reapproved = gate(edited, 'scope', 'approved');
    const gates = [approvedScope, approvedRcm, reapproved];
    expect(menu(edited, { gates }).actions).toEqual([{ type: 'delegate', specialist: 'rcm', subjectKey: 'rcm' }]);
    const rebuilt: RedraftRecord = { subjectKey: 'rcm', kind: 'delegate', basis: subjectInfo(edited, 'rcm')!.basis, sinceGateId: approvedRcm.id };
    expect(menu(edited, { gates, redrafts: [rebuilt] }).actions).toEqual([{ type: 'request_qa', subjectKey: 'rcm', mode: 'review' }]);
  });

  it('drafts test plans after the RCM gate, reviews them without a gate, and waits for field work [REQ-26]', () => {
    const { e, gates } = throughRcm();
    expect(menu(e, { gates }).actions).toEqual([{ type: 'delegate', specialist: 'test-plan', subjectKey: 'test_plans' }]);
    e.testPlans = { A: plan(e.rcm[0]) };
    expect(menu(e, { gates }).actions).toEqual([{ type: 'request_qa', subjectKey: 'test_plans', mode: 'review' }]);
    const m = menu(e, { gates, qa: [qa(e, 'test_plans')] });
    expect(m.stage).toBe('awaiting_tests');
    expect(m.actions).toEqual([{ type: 'wait', reason: 'awaiting test results for 1 control(s)' }]);
  });

  it("does not wait for a row a person decided not to test", () => {
    const { e, gates } = throughRcm();
    e.testPlans = { A: plan(e.rcm[0], { notTestedJustification: 'Control retired in Q1' }) };
    const m = menu(e, { gates, qa: [qa(e, 'test_plans')] });
    expect(m.stage).toBe('report');
    expect(m.actions).toEqual([{ type: 'delegate', specialist: 'report', subjectKey: 'report' }]);
  });

  it('concludes tests, then drafts findings only for the rows that need them [REQ-26]', () => {
    const { e, gates, qa: reviews } = planned();
    e.testInputs = { A: input() };
    expect(menu(e, { gates, qa: reviews }).actions).toEqual([{ type: 'delegate', specialist: 'testing', subjectKey: 'testing' }]);
    e.testResults = { A: result('A') };
    expect(menu(e, { gates, qa: reviews }).actions).toEqual([{ type: 'delegate', specialist: 'gaps', subjectKey: 'gaps', rows: ['A'] }]);
  });

  it('waits rather than redraft a finding that is already reviewed [REQ-27]', () => {
    const { e, gates, qa: reviews } = planned();
    e.testInputs = { A: input(0) };
    e.testResults = { A: result('A', 'Effective') };
    e.findings = [finding('A', 'reviewed')];
    const m = menu(e, { gates, qa: reviews });
    expect(m.actions).toEqual([{ type: 'wait', reason: 'awaiting signatures on reviewed findings before they can be redrafted' }]);
  });

  it('gates each finding, then the report, then completes [REQ-26]', () => {
    const { e, gates, qa: reviews } = planned();
    e.testInputs = { A: input() };
    e.testResults = { A: result('A') };
    e.findings = [finding('A')];
    const key = findingKey('A');
    expect(menu(e, { gates, qa: [...reviews, qa(e, key)] }).actions).toEqual([{ type: 'open_gate', subjectKey: key }]);
    const open = gate(e, key, 'open');
    expect(menu(e, { gates: [...gates, open], qa: reviews }).actions).toEqual([{ type: 'wait', reason: 'awaiting finding gate signature (F-A)' }]);

    e.findings = [finding('A', 'approved')];
    expect(menu(e, { gates, qa: reviews }).actions).toEqual([{ type: 'delegate', specialist: 'report', subjectKey: 'report' }]);
    e.report = { generatedAt: 't', bundleId: 'RUN-9', markdown: '# Report', includedFindingIds: ['F-A'], excludedFindingIds: [] };
    expect(menu(e, { gates: [...gates, gate(e, 'report', 'approved')], qa: reviews }).actions).toEqual([{ type: 'complete' }]);
  });

  it('never repeats a redraft from the same basis [REQ-26]', () => {
    const e = engagement();
    const ran: RedraftRecord = { subjectKey: 'scope', kind: 'delegate', basis: subjectInfo(e, 'scope')!.basis, sinceGateId: null };
    expect(menu(e, { redrafts: [ran] }).actions[0]).toMatchObject({ type: 'escalate' });
  });

  it('is a pure function of its input', () => {
    const { e, gates, qa: reviews } = planned();
    const given: GraphInput = { engagement: e, gates, qa: reviews, redrafts: [], qaThreshold: 70 };
    const copy = structuredClone(given);
    const a: Action[] = allowedActions(given).actions;
    expect(allowedActions(given).actions).toEqual(a);
    expect(given).toEqual(copy);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/graph.test.ts`
Expected: FAIL. `Cannot find module '../src/agents/graph'`.

- [ ] **Step 3: Append the action, decision and graph types**

Append to `backend/src/agents/types.ts`, and add `import { z } from 'zod';`, `import { canonicalJson } from '../engine/trail';` and `import type { Engagement } from '../engine/types';` at the top:

```ts
/** The specialists the supervisor can delegate to. Each wraps one existing module (or, for test plans, the drafter). */
export const SPECIALISTS = ['scope', 'rcm', 'test-plan', 'testing', 'gaps', 'report'] as const;
export type Specialist = (typeof SPECIALISTS)[number];

const SpecialistSchema = z.enum(SPECIALISTS);
const Rows = z.array(z.string()).optional();

/** Everything a run can do (spec §5.2). A closed union: a decision naming anything else is refused. */
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delegate'), specialist: SpecialistSchema, subjectKey: z.string(), rows: Rows }),
  z.object({ type: z.literal('request_qa'), subjectKey: z.string(), mode: z.enum(['review', 'challenge']) }),
  z.object({ type: z.literal('rework'), specialist: SpecialistSchema, subjectKey: z.string(), instruction: z.string().max(2000), rows: Rows }),
  z.object({ type: z.literal('open_gate'), subjectKey: z.string() }),
  z.object({ type: z.literal('wait'), reason: z.string() }),
  z.object({ type: z.literal('escalate'), reason: z.string() }),
  z.object({ type: z.literal('complete') }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const DecisionSchema = z.object({
  action: ActionSchema,
  rationale: z.string().max(500),
  /** 'forced' when the menu had one entry and no policy was asked. */
  policy: z.enum(['llm', 'rules', 'forced']),
  policyVersion: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export type Stage = 'scope' | 'rcm' | 'test_plans' | 'awaiting_tests' | 'testing' | 'gaps' | 'findings' | 'report' | 'done';

/** What the graph needs to know about a gate. */
export interface GateRecord {
  id: string;
  kind: GateKind;
  subjectKey: string;
  subjectId: string;
  subjectHash: string;
  basisHash: string;
  state: GateState;
  attempt: number;
  comment: string;
  signatureId: string | null;
}

/** A specialist run on a subject, from the run's delegate steps. */
export interface RedraftRecord {
  subjectKey: string;
  kind: 'delegate' | 'rework';
  /** redraftBasis() when it ran. */
  basis: string;
  /** The subject's latest gate when it ran (null before any gate). */
  sinceGateId: string | null;
}

export interface GraphInput {
  engagement: Engagement;
  /** Every gate on the engagement, oldest first. */
  gates: GateRecord[];
  /** This run's QA reports, oldest first. */
  qa: QaReport[];
  redrafts: RedraftRecord[];
  qaThreshold: number;
}

/** The legal next actions, and the QA report they were derived from (if any). */
export interface Menu {
  stage: Stage;
  actions: Action[];
  qa: QaReport | null;
  qaThreshold: number;
}

export interface Policy {
  readonly kind: 'llm' | 'rules';
  readonly version: string;
  decide(menu: Menu): Promise<Decision>;
}

/** Redrafts a subject may get from QA feedback before its gate (spec §5.3). */
export const MAX_SELF_REWORKS = 2;
/** Rejected gates on one subject before the run hands it to a person (spec §4.5). */
export const MAX_REJECTIONS = 2;

export const sameAction = (a: Action, b: Action) => canonicalJson(a) === canonicalJson(b);
```

- [ ] **Step 4: Write `subjects.ts`**

Create `backend/src/agents/subjects.ts`:

```ts
import { canonicalJson, sha256 } from '../engine/trail';
import type { Engagement, RcmRow } from '../engine/types';
import { findingContentHash, workpaperContentHash } from '../signing/content-hash';
import type { GateKind } from './types';

// What the supervisor works on. Each subject has a key, a content hash and a basis: the hash of what it was built from.
// A gate records both when it opens, so the graph can tell an approved subject that is still current from one that
// was edited (hash) or whose upstream changed (basis).

const FINDING_PREFIX = 'finding:';
export const findingKey = (rowId: string) => `${FINDING_PREFIX}${rowId}`;
export const rowOfKey = (key: string): string | null => (key.startsWith(FINDING_PREFIX) ? key.slice(FINDING_PREFIX.length) : null);

/** The scope is built from the scope statement and the packs. */
export const rootBasis = (e: Engagement) => sha256(canonicalJson({ scopeStatement: e.scopeStatement, packIds: e.packIds }));

/** A finding is built from its row's recorded test and conclusion. */
export const rowBasis = (e: Engagement, rowId: string) => sha256(canonicalJson({ input: e.testInputs[rowId] ?? null, result: e.testResults[rowId] ?? null }));

/** The report is built from the approved findings. */
export function approvedFindingsBasis(e: Engagement): string {
  const approved = e.findings
    .filter((f) => f.status === 'approved')
    .map((f) => ({ id: f.id, hash: findingContentHash(f) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256(canonicalJson(approved));
}

export const rcmRowHash = (row: RcmRow) => sha256(canonicalJson(row));

/** Every RCM row has a plan drafted from its current version, and there are no plans for rows that are gone. */
export function plansCurrent(e: Engagement): boolean {
  const ids = new Set(e.rcm.map((r) => r.id));
  if (Object.keys(e.testPlans).some((id) => !ids.has(id))) return false;
  return e.rcm.every((r) => e.testPlans[r.id]?.rowHash === rcmRowHash(r));
}

export interface SubjectInfo {
  key: string;
  /** null for test plans, which have no gate. */
  gateKind: GateKind | null;
  subjectId: string;
  hash: string;
  basis: string;
  /** False when the specialist has not produced it (or, for test plans, they are out of date). */
  present: boolean;
}

/** The subject behind a key, or null when there is none (an unknown key, or a row without a finding). */
export function subjectInfo(e: Engagement, key: string): SubjectInfo | null {
  switch (key) {
    case 'scope':
      return { key, gateKind: 'scope', subjectId: 'scope', hash: workpaperContentHash('scope', e), basis: rootBasis(e), present: e.scope.length > 0 };
    case 'rcm':
      return { key, gateKind: 'rcm', subjectId: 'rcm', hash: workpaperContentHash('rcm', e), basis: workpaperContentHash('scope', e), present: e.rcm.length > 0 };
    case 'test_plans':
      return { key, gateKind: null, subjectId: 'test_plans', hash: workpaperContentHash('test_plans', e), basis: workpaperContentHash('rcm', e), present: plansCurrent(e) };
    case 'report':
      return { key, gateKind: 'report', subjectId: 'report', hash: workpaperContentHash('report', e), basis: approvedFindingsBasis(e), present: e.report !== null };
  }
  const rowId = rowOfKey(key);
  const f = rowId ? e.findings.find((x) => x.rowId === rowId) : undefined;
  if (!rowId || !f) return null;
  return { key, gateKind: 'finding', subjectId: f.id, hash: findingContentHash(f), basis: rowBasis(e, rowId), present: true };
}
```

- [ ] **Step 5: Write `graph.ts`**

Create `backend/src/agents/graph.ts`:

```ts
import { canonicalJson, sha256 } from '../engine/trail';
import type { Engagement } from '../engine/types';
import { findingKey, rowBasis, subjectInfo } from './subjects';
import { MAX_REJECTIONS, MAX_SELF_REWORKS, type Action, type GateRecord, type GraphInput, type Menu, type QaReport, type Specialist, type Stage } from './types';

// The engagement graph (spec §4): a pure function from the engagement, its gates and this run's QA and redraft
// history to the actions the supervisor may take next. Nothing here reads or writes the database.
//
// Chain: scope ─QA─▶ [scope gate] ─▶ rcm ─QA─▶ [rcm gate] ─▶ test plans ─QA─▶ (wait for field work) ─▶ testing
//        ─▶ gaps ─▶ each finding ─QA─▶ [finding gate] ─▶ report ─QA─▶ [report gate] ─▶ complete

const FAILED = new Set(['Ineffective', 'Design deficient']);

type Step = { passed: true } | { passed: false; actions: Action[]; qa: QaReport | null };
const act = (actions: Action[], qa: QaReport | null = null): Step => ({ passed: false, actions, qa });

function findLast<T>(xs: readonly T[], match: (x: T) => boolean): T | undefined {
  for (let i = xs.length - 1; i >= 0; i--) if (match(xs[i])) return xs[i];
  return undefined;
}

/** The latest gate for a subject that still counts: a superseded gate was overtaken by a change before anyone signed it. */
const latestGate = (gates: readonly GateRecord[], key: string) => findLast(gates, (g) => g.subjectKey === key && g.state !== 'superseded');
export const latestGateId = (gates: readonly GateRecord[], key: string): string | null => latestGate(gates, key)?.id ?? null;

/** Rows whose field work is recorded but not yet concluded by the Testing module. */
export const untestedRows = (e: Engagement) => e.rcm.filter((r) => e.testInputs[r.id] && !e.testResults[r.id]).map((r) => r.id);

/** What a redraft of this subject is built from. The graph never repeats a redraft from the same basis. */
export function redraftBasis(e: Engagement, subjectKey: string, rows?: string[]): string {
  const s = subjectInfo(e, subjectKey);
  if (s) return s.basis;
  if (subjectKey === 'testing') return sha256(canonicalJson(untestedRows(e).map((id) => [id, e.testInputs[id]])));
  return sha256(canonicalJson({ subjectKey, rows: (rows ?? []).map((id) => [id, rowBasis(e, id)]) }));
}

function delegate(input: GraphInput, specialist: Specialist, subjectKey: string, rows?: string[]): Action {
  const basis = redraftBasis(input.engagement, subjectKey, rows);
  const since = latestGateId(input.gates, subjectKey);
  const repeated = input.redrafts.some((r) => r.kind === 'delegate' && r.subjectKey === subjectKey && r.basis === basis && r.sinceGateId === since);
  if (repeated) return { type: 'escalate', reason: `The ${specialist} specialist already ran for ${subjectKey} and it is still not ready; check it by hand, then resume` };
  return { type: 'delegate', specialist, subjectKey, ...(rows ? { rows } : {}) };
}

interface StepOptions {
  specialist: Specialist;
  rows?: string[];
  /** False while the subject may not be redrafted (a reviewed finding). */
  canRework: boolean;
  blockedReason?: string;
}

function rework(o: StepOptions, subjectKey: string, instruction: string): Action {
  if (!o.canRework) return { type: 'wait', reason: o.blockedReason ?? `${subjectKey} cannot be redrafted now` };
  return { type: 'rework', specialist: o.specialist, subjectKey, instruction: instruction.slice(0, 2000), ...(o.rows ? { rows: o.rows } : {}) };
}

const summarise = (r: QaReport) => r.issues.map((i) => `${i.criterion}: ${i.detail}`).join('; ');

/** One subject: produce it, review it, gate it, and react to the gate. `passed` once its gate is approved and current. */
function subjectStep(input: GraphInput, key: string, o: StepOptions): Step {
  const s = subjectInfo(input.engagement, key);
  if (!s || !s.present) return act([delegate(input, o.specialist, key, o.rows)]);
  const g = latestGate(input.gates, key);
  const mine = input.redrafts.filter((r) => r.subjectKey === key && r.sinceGateId === (g?.id ?? null));
  const label = s.gateKind ?? 'test plans';

  if (g?.state === 'approved') {
    if (g.subjectHash === s.hash && g.basisHash === s.basis) return { passed: true };
    // What it was built from changed: rebuild it once, then review the rebuilt version. (Edited by hand: review it.)
    if (g.basisHash !== s.basis && !mine.some((r) => r.basis === s.basis)) return act([delegate(input, o.specialist, key, o.rows)]);
  }
  if (g?.state === 'open') {
    return act([{ type: 'wait', reason: `awaiting ${s.gateKind} gate signature${s.gateKind === 'finding' ? ` (${s.subjectId})` : ''}` }]);
  }
  if (g?.state === 'rejected' && g.subjectHash === s.hash) {
    const rejections = input.gates.filter((x) => x.subjectKey === key && x.state === 'rejected').length;
    if (rejections >= MAX_REJECTIONS) return act([{ type: 'escalate', reason: `gate_rejected_twice: ${key}` }]);
    if (mine.some((r) => r.kind === 'rework')) return act([{ type: 'escalate', reason: `rework produced no change: ${key}; edit it by hand, then resume` }]);
    return act([rework(o, key, g.comment.trim() || `Address the reasons the ${label} gate was rejected`)]);
  }

  // No gate yet, the last one was superseded, or a person edited it after a rejection or approval: QA, then a gate.
  const report = findLast(input.qa, (q) => q.subjectKey === key && q.subjectHash === s.hash) ?? null;
  if (!report) return act([{ type: 'request_qa', subjectKey: key, mode: 'review' }]);
  const blocking = report.issues.some((i) => i.severity === 'blocking');
  if (!s.gateKind) return blocking ? act([{ type: 'escalate', reason: `QA found blocking issues in the ${label}` }], report) : { passed: true };
  if (!report.issues.length) return act([{ type: 'open_gate', subjectKey: key }], report);
  const actions: Action[] = [];
  if (!blocking) actions.push({ type: 'open_gate', subjectKey: key });
  if (o.canRework && mine.filter((r) => r.kind === 'rework').length < MAX_SELF_REWORKS) actions.push(rework(o, key, summarise(report)));
  actions.push({ type: 'escalate', reason: `QA found ${report.issues.length} issue(s) in the ${label}${blocking ? ', some blocking' : ''}` });
  return act(actions, report);
}

/** The actions the supervisor may take next. Every reachable state offers at least one. */
export function allowedActions(input: GraphInput): Menu {
  const e = input.engagement;
  const menu = (stage: Stage, step: Exclude<Step, { passed: true }>): Menu => ({ stage, actions: step.actions, qa: step.qa, qaThreshold: input.qaThreshold });
  const only = (stage: Stage, action: Action): Menu => ({ stage, actions: [action], qa: null, qaThreshold: input.qaThreshold });

  const workpapers: [Stage, string, Specialist][] = [['scope', 'scope', 'scope'], ['rcm', 'rcm', 'rcm'], ['test_plans', 'test_plans', 'test-plan']];
  for (const [stage, key, specialist] of workpapers) {
    const step = subjectStep(input, key, { specialist, canRework: true });
    if (!step.passed) return menu(stage, step);
  }

  // Field work is done by people: wait until every row has a recorded test, or a person's reason for not testing it.
  const awaiting = e.rcm.filter((r) => !e.testInputs[r.id] && !e.testPlans[r.id]?.notTestedJustification?.trim());
  if (awaiting.length) return only('awaiting_tests', { type: 'wait', reason: `awaiting test results for ${awaiting.length} control(s)` });
  if (untestedRows(e).length) return only('testing', delegate(input, 'testing', 'testing'));

  // A failed row needs a finding; a finding on a row that no longer fails must go, unless it is approved (locked).
  const failed = new Set(e.rcm.filter((r) => FAILED.has(e.testResults[r.id]?.conclusion ?? '')).map((r) => r.id));
  const byRow = new Map(e.findings.map((f) => [f.rowId, f]));
  const stale = e.rcm
    .map((r) => r.id)
    .filter((id) => (failed.has(id) && !byRow.has(id)) || (!failed.has(id) && byRow.has(id) && byRow.get(id)!.status !== 'approved'));
  const redraftable = stale.filter((id) => byRow.get(id)?.status !== 'reviewed');
  if (redraftable.length) return only('gaps', delegate(input, 'gaps', 'gaps', redraftable));
  if (stale.length) return only('gaps', { type: 'wait', reason: 'awaiting signatures on reviewed findings before they can be redrafted' });

  const waits: string[] = [];
  for (const r of e.rcm) {
    const f = byRow.get(r.id);
    if (!f || f.status === 'approved') continue;
    const step = subjectStep(input, findingKey(r.id), {
      specialist: 'gaps', rows: [r.id], canRework: f.status !== 'reviewed',
      blockedReason: `finding ${f.id} is reviewed; it can only be approved or rejected now`,
    });
    if (step.passed) continue;
    if (step.actions.every((a) => a.type === 'wait')) {
      waits.push(...step.actions.flatMap((a) => (a.type === 'wait' ? [a.reason] : [])));
      continue;
    }
    return menu('findings', step);
  }
  if (waits.length) return only('findings', { type: 'wait', reason: waits.join('; ') });

  const report = subjectStep(input, 'report', { specialist: 'report', canRework: true });
  if (!report.passed) return menu('report', report);
  return only('done', { type: 'complete' });
}
```

- [ ] **Step 6: Run the graph tests and the type check**

Run: `npm test -- tests/graph.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/agents/types.ts backend/src/agents/subjects.ts backend/src/agents/graph.ts backend/tests/graph.test.ts
git commit -m "feat(agents): engagement graph computing the legal next actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Rules policy, offline QA reviewer and test-plan drafter

**Files:**
- Create: `backend/src/agents/policy/rules.ts`
- Create: `backend/src/agents/qa/deterministic.ts`
- Create: `backend/src/agents/specialists/test-plan.ts`
- Create: `backend/tests/agent-fixtures.ts` (builders moved out of `tests/graph.test.ts`)
- Modify: `backend/tests/graph.test.ts` (import the builders instead of defining them)
- Test: `backend/tests/agent-qa.test.ts`

**Interfaces:**
- Consumes: `Menu`, `Action`, `Decision`, `Policy`, `QaReport`, `QaIssue` (Tasks 1 and 3); `subjectInfo`, `rowOfKey`, `rcmRowHash` (Task 3); `TestPlan` (Task 2).
- Produces:
  - `RULES_VERSION = 'rules-1'`, `rulesChoice(menu: Menu): { action: Action; rationale: string }`, `class RulesPolicy implements Policy`;
  - `DETERMINISTIC_REVIEWER = 'deterministic-1'`, `reviewSubject(e: Engagement, subjectKey: string): QaReport`;
  - `draftTestPlans(e: Engagement): Record<string, TestPlan>`.

**Scoring** (offline): `score = max(0, 100 − 25 × blocking − 10 × min(advisory, 3))`. Advisory issues alone never take a subject below the default threshold of 70, so they go to the signer with the gate instead of forcing redrafts.

- [ ] **Step 1: Move the builders into a fixtures file**

Create `backend/tests/agent-fixtures.ts`. It holds the builders that `tests/graph.test.ts` defined, with one change: `scopeItem` takes overrides.

```ts
import { rcmRowHash } from '../src/agents/subjects';
import type { Citation, Engagement, Finding, RcmRow, ScopeItem, TestInput, TestPlan, TestResult } from '../src/engine/types';

// In-memory engagements for the pure agent tests (graph, QA, drafter).

export const cite: Citation = { clauseId: 'C1', regulation: 'Reg', ref: '§1', label: 'Reg §1' };

export const scopeItem = (id: string, included = true, over: Partial<ScopeItem> = {}): ScopeItem => ({
  controlId: id, packId: 'p', processArea: 'a', risk: 'r', inherentRisk: 'Medium', relevance: 1, rationale: 'x', citations: [cite], included, ...over,
});

export const row = (id: string, over: Partial<RcmRow> = {}): RcmRow => ({
  id, controlId: id, packId: 'p', processArea: 'a', risk: 'r', riskRating: 'Medium', control: `Control ${id}`, objective: `Objective ${id}`, type: 'Preventive',
  nature: 'Manual', frequency: 'Monthly', sampleSize: 2, testOfDesign: ['d'], testOfEffectiveness: ['t'], evidenceExpected: ['ev'], checklist: [], citations: [cite], ...over,
});

export const plan = (r: RcmRow, over: Partial<TestPlan> = {}): TestPlan => ({
  rowId: r.id, rowHash: rcmRowHash(r), attribute: 'a', population: 'p', sampleSize: r.sampleSize, selectionMethod: 'random', evidenceToRequest: ['ev'], procedure: 't', ...over,
});

export const input = (exceptions = 1): TestInput => ({ designAdequate: true, observation: 'o', evidenceRefs: ['E1'], sampleTested: 2, exceptions, updatedBy: 'auditor', updatedAt: 't' });

export const result = (rowId: string, conclusion: TestResult['conclusion'] = 'Ineffective'): TestResult => ({ rowId, conclusion, rationale: 'x', exceptionRate: 0.5, qaFlags: [] });

export const finding = (rowId: string, status: Finding['status'] = 'draft', over: Partial<Finding> = {}): Finding => ({
  id: `F-${rowId}`, rowId, controlId: rowId, title: 't', rating: 'Medium', condition: 'c', criteria: 'k', cause: 'u', effect: 'f', recommendation: 'r',
  citations: [cite], evidenceRefs: ['E1'], status, blockedReasons: [], signOffs: [], bundleId: 'RUN-1', ...over,
});

export function engagement(over: Partial<Engagement> = {}): Engagement {
  return {
    id: 'ENG-1', name: 'n', entity: 'e', site: 's', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 't', scopeStatement: 'stmt',
    packIds: ['p'], createdBy: 'auditor', createdAt: '2026-01-01T00:00:00.000Z', stage: 'planning', scope: [], rcm: [], testInputs: {},
    testResults: {}, testPlans: {}, findings: [], report: null, ...over,
  };
}
```

In `backend/tests/graph.test.ts`:
- Delete the local `cite`, `scopeItem`, `row`, `plan`, `input`, `result`, `finding` and `engagement` definitions.
- Replace the engine-types import with `import { engagement, finding, input, plan, result, row, scopeItem } from './agent-fixtures';`.
- Keep `rcmRowHash` out of the graph test's imports; it is no longer used there.

Run: `npm test -- tests/graph.test.ts`
Expected: PASS (unchanged behaviour).

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/agent-qa.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RULES_VERSION, RulesPolicy, rulesChoice } from '../src/agents/policy/rules';
import { reviewSubject } from '../src/agents/qa/deterministic';
import { draftTestPlans } from '../src/agents/specialists/test-plan';
import { findingKey, rcmRowHash, subjectInfo } from '../src/agents/subjects';
import type { Action, Menu, QaIssue, QaReport } from '../src/agents/types';
import { engagement, finding, plan, row, scopeItem } from './agent-fixtures';

const issues = (r: QaReport) => r.issues.map((i) => [i.severity, i.criterion]);

describe('the offline QA reviewer', () => {
  it('blocks a scope with nothing in it, and flags high-risk controls left out', () => {
    const r = reviewSubject(engagement({ scope: [scopeItem('A', false, { inherentRisk: 'High' }), scopeItem('B', false)] }), 'scope');
    expect(issues(r)).toEqual([['blocking', 'scope.included'], ['advisory', 'scope.high-risk-excluded']]);
    expect(r.score).toBe(65);
  });

  it('blocks RCM rows that cite no clause', () => {
    const r = reviewSubject(engagement({ rcm: [row('A'), row('B', { citations: [] })] }), 'rcm');
    expect(issues(r)).toEqual([['blocking', 'rcm.citations']]);
  });

  it('blocks a missing test plan and flags thin ones', () => {
    const a = row('A', { sampleSize: 5 });
    const e = engagement({ rcm: [a, row('B')], testPlans: { A: plan(a, { sampleSize: 2, evidenceToRequest: [] }) } });
    expect(issues(reviewSubject(e, 'test_plans'))).toEqual([['advisory', 'plans.evidence'], ['advisory', 'plans.sample'], ['blocking', 'plans.coverage']]);
  });

  it('blocks a finding the QA gates blocked, or one missing a C, a citation or evidence', () => {
    const f = finding('A', 'blocked', { blockedReasons: ['Cites a clause outside the grounding set'], cause: ' ', evidenceRefs: [] });
    const r = reviewSubject(engagement({ rcm: [row('A')], findings: [f] }), findingKey('A'));
    expect(issues(r)).toEqual([['blocking', 'finding.blocked'], ['blocking', 'finding.five-cs'], ['blocking', 'finding.evidence']]);
    expect(r.score).toBe(25);
  });

  it('blocks a report that leaves out an approved finding', () => {
    const e = engagement({
      findings: [finding('A', 'approved')],
      report: { generatedAt: 't', bundleId: 'RUN-1', markdown: '# R', includedFindingIds: [], excludedFindingIds: ['F-B'] },
    });
    expect(issues(reviewSubject(e, 'report'))).toEqual([['blocking', 'report.coverage'], ['advisory', 'report.excluded']]);
    expect(issues(reviewSubject(engagement(), 'report'))).toEqual([['blocking', 'report.missing']]);
  });

  it('caps what advisory issues cost, so on their own they never force a redraft', () => {
    const scope = ['A', 'B', 'C', 'D', 'E'].map((id) => scopeItem(id, false, { inherentRisk: 'High' }));
    const r = reviewSubject(engagement({ scope: [scopeItem('Z'), ...scope] }), 'scope');
    expect(r.issues).toHaveLength(5);
    expect(r.score).toBe(70);
  });

  it('reviews exactly the content the graph sees', () => {
    const e = engagement({ scope: [scopeItem('A')] });
    expect(reviewSubject(e, 'scope')).toMatchObject({ subjectKey: 'scope', subjectHash: subjectInfo(e, 'scope')!.hash, mode: 'review', reviewer: 'deterministic-1' });
    expect(() => reviewSubject(e, 'finding:NOPE')).toThrow(/Nothing to review/);
  });
});

describe('the rules policy', () => {
  const gate: Action = { type: 'open_gate', subjectKey: 'scope' };
  const redo: Action = { type: 'rework', specialist: 'scope', subjectKey: 'scope', instruction: 'fix it' };
  const escalate: Action = { type: 'escalate', reason: 'QA found issues' };
  const qa = (score: number, list: QaIssue[]): QaReport => ({ subjectKey: 'scope', subjectHash: 'h', mode: 'review', reviewer: 't', score, issues: list });
  const menu = (actions: Action[], report: QaReport | null): Menu => ({ stage: 'scope', actions, qa: report, qaThreshold: 70 });
  const block: QaIssue = { criterion: 'x', severity: 'blocking', detail: 'd' };
  const note: QaIssue = { criterion: 'y', severity: 'advisory', detail: 'd' };

  it('redrafts blocking issues while it can, then escalates [REQ-26]', () => {
    expect(rulesChoice(menu([redo, escalate], qa(75, [block]))).action).toEqual(redo);
    expect(rulesChoice(menu([escalate], qa(75, [block]))).action).toEqual(escalate);
  });

  it('redrafts a low score while it can, then lets the signer decide [REQ-26]', () => {
    expect(rulesChoice(menu([gate, redo, escalate], qa(60, [note]))).action).toEqual(redo);
    expect(rulesChoice(menu([gate, escalate], qa(60, [note]))).action).toEqual(gate);
    expect(rulesChoice(menu([gate, redo, escalate], qa(80, [note]))).action).toEqual(gate);
  });

  it('takes the first action when there is no QA to weigh', () => {
    expect(rulesChoice(menu([escalate, gate], null)).action).toEqual(escalate);
  });

  it('returns a typed decision under its own version', async () => {
    const d = await new RulesPolicy().decide(menu([gate, redo, escalate], qa(80, [note])));
    expect(d).toMatchObject({ action: gate, policy: 'rules', policyVersion: RULES_VERSION });
    expect(d.rationale.length).toBeLessThanOrEqual(500);
  });
});

describe('the test-plan drafter', () => {
  it('drafts a plan for each RCM row from what the RCM says', () => {
    const a = row('A', { sampleSize: 25, evidenceExpected: ['Batch record', 'Line clearance log'], testOfEffectiveness: ['Select batches', 'Inspect sign-off'] });
    const yearly = row('B', { frequency: 'Annual', sampleSize: 1 });
    const plans = draftTestPlans(engagement({ rcm: [a, yearly] }));
    expect(plans.A).toEqual({
      rowId: 'A', rowHash: rcmRowHash(a), attribute: 'Objective A',
      population: 'Every performance of "Control A" (monthly) from 2026-01-01 to 2026-06-30',
      sampleSize: 25, selectionMethod: 'random', evidenceToRequest: ['Batch record', 'Line clearance log'], procedure: 'Select batches\nInspect sign-off',
    });
    expect(plans.B.selectionMethod).toBe('all');
  });

  it("keeps a plan whose row is unchanged, keeps a person's reason not to test, and drops plans for rows that are gone [REQ-27]", () => {
    const a = row('A');
    const edited = plan(a, { attribute: 'Edited by the auditor', editedBy: 'auditor', editedAt: 't' });
    const b = row('B');
    const skipped = plan(b, { rowHash: 'old', notTestedJustification: 'Retired in March', editedBy: 'auditor', editedAt: 't' });
    const plans = draftTestPlans(engagement({ rcm: [a, b], testPlans: { A: edited, B: skipped, GONE: plan(row('GONE')) } }));
    expect(plans.A).toBe(edited);
    expect(plans.B).toMatchObject({ rowHash: rcmRowHash(b), notTestedJustification: 'Retired in March', editedBy: 'auditor' });
    expect(Object.keys(plans)).toEqual(['A', 'B']);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -- tests/agent-qa.test.ts`
Expected: FAIL. The modules do not exist.

- [ ] **Step 4: Write the rules policy**

Create `backend/src/agents/policy/rules.ts`:

```ts
import type { Action, Decision, Menu, Policy } from '../types';

// The offline policy (spec §5.3). Deterministic and complete on its own: with no model configured, runs use it,
// and a model policy that answers off the menu falls back to it.

export const RULES_VERSION = 'rules-1';

export function rulesChoice(menu: Menu): { action: Action; rationale: string } {
  const find = <T extends Action['type']>(type: T) => menu.actions.find((a): a is Extract<Action, { type: T }> => a.type === type);
  const qa = menu.qa;
  if (qa) {
    const blocking = qa.issues.filter((i) => i.severity === 'blocking').length;
    const rework = find('rework');
    if (blocking) {
      if (rework) return { action: rework, rationale: `QA found ${blocking} blocking issue(s); redrafting` };
      const escalate = find('escalate');
      if (escalate) return { action: escalate, rationale: `QA found ${blocking} blocking issue(s) and no redraft is left; a person must decide` };
    }
    if (qa.score < menu.qaThreshold && rework) return { action: rework, rationale: `QA scored ${qa.score}, below ${menu.qaThreshold}; redrafting` };
    const gate = find('open_gate');
    if (gate) return { action: gate, rationale: `QA scored ${qa.score}; ${qa.issues.length} issue(s) go to the signer with the gate` };
  }
  return { action: menu.actions[0], rationale: 'The first allowed action' };
}

export class RulesPolicy implements Policy {
  readonly kind = 'rules' as const;
  readonly version = RULES_VERSION;

  async decide(menu: Menu): Promise<Decision> {
    const { action, rationale } = rulesChoice(menu);
    return { action, rationale, policy: 'rules', policyVersion: this.version };
  }
}
```

- [ ] **Step 5: Write the offline QA reviewer**

Create `backend/src/agents/qa/deterministic.ts`:

```ts
import type { Engagement } from '../../engine/types';
import { rowOfKey, subjectInfo } from '../subjects';
import type { QaIssue, QaReport } from '../types';

// The offline QA review (spec §5.5): the checks that need no model. Blocking issues stop a gate from opening;
// advisory ones travel with the gate to the signer.

export const DETERMINISTIC_REVIEWER = 'deterministic-1';

const blocking = (criterion: string, detail: string): QaIssue => ({ criterion, severity: 'blocking', detail });
const advisory = (criterion: string, detail: string): QaIssue => ({ criterion, severity: 'advisory', detail });

function scopeIssues(e: Engagement): QaIssue[] {
  const included = e.scope.filter((s) => s.included);
  return [
    ...(included.length ? [] : [blocking('scope.included', 'No control is in scope')]),
    ...included.filter((s) => !s.citations.length).map((s) => advisory('scope.citations', `${s.controlId} is in scope without a regulatory citation`)),
    ...e.scope.filter((s) => !s.included && s.inherentRisk === 'High').map((s) => advisory('scope.high-risk-excluded', `High inherent-risk control ${s.controlId} is out of scope`)),
  ];
}

function rcmIssues(e: Engagement): QaIssue[] {
  return [
    ...(e.rcm.length ? [] : [blocking('rcm.rows', 'The RCM has no rows')]),
    ...e.rcm.filter((r) => !r.citations.length).map((r) => blocking('rcm.citations', `${r.id} cites no regulatory clause`)),
    ...e.rcm.filter((r) => r.sampleSize < 1).map((r) => advisory('rcm.sample', `${r.id} has no sample size`)),
    ...e.rcm.filter((r) => !r.testOfEffectiveness.length).map((r) => advisory('rcm.procedure', `${r.id} has no test of operating effectiveness`)),
  ];
}

function planIssues(e: Engagement): QaIssue[] {
  return e.rcm.flatMap((r) => {
    const p = e.testPlans[r.id];
    if (!p) return [blocking('plans.coverage', `${r.id} has no test plan`)];
    return [
      ...(p.evidenceToRequest.length ? [] : [advisory('plans.evidence', `${r.id}: the plan requests no evidence`)]),
      ...(p.selectionMethod !== 'all' && p.sampleSize < r.sampleSize ? [advisory('plans.sample', `${r.id}: a sample of ${p.sampleSize} is below the RCM's ${r.sampleSize}`)] : []),
    ];
  });
}

function findingIssues(e: Engagement, rowId: string): QaIssue[] {
  const f = e.findings.find((x) => x.rowId === rowId)!;
  const empty = (['condition', 'criteria', 'cause', 'effect', 'recommendation'] as const).filter((k) => !f[k].trim());
  return [
    ...(f.status === 'blocked' ? [blocking('finding.blocked', f.blockedReasons.join('; ') || 'Blocked by the QA gates')] : []),
    ...empty.map((k) => blocking('finding.five-cs', `${f.id} has no ${k}`)),
    ...(f.citations.length ? [] : [blocking('finding.citations', `${f.id} cites no regulatory clause`)]),
    ...(f.evidenceRefs.length ? [] : [blocking('finding.evidence', `${f.id} cites no evidence`)]),
  ];
}

function reportIssues(e: Engagement): QaIssue[] {
  const report = e.report;
  if (!report) return [blocking('report.missing', 'No report has been generated')];
  const missing = e.findings.filter((f) => f.status === 'approved' && !report.includedFindingIds.includes(f.id));
  return [
    ...missing.map((f) => blocking('report.coverage', `Approved finding ${f.id} is not in the report`)),
    ...(report.excludedFindingIds.length ? [advisory('report.excluded', `${report.excludedFindingIds.length} finding(s) are listed as excluded`)] : []),
  ];
}

/** Reviews one subject as it stands now. The report is tied to the content hash it reviewed. */
export function reviewSubject(e: Engagement, subjectKey: string): QaReport {
  const s = subjectInfo(e, subjectKey);
  if (!s) throw new Error(`Nothing to review for ${subjectKey}`);
  const rowId = rowOfKey(subjectKey);
  const issues =
    subjectKey === 'scope' ? scopeIssues(e)
    : subjectKey === 'rcm' ? rcmIssues(e)
    : subjectKey === 'test_plans' ? planIssues(e)
    : subjectKey === 'report' ? reportIssues(e)
    : findingIssues(e, rowId!);
  const b = issues.filter((i) => i.severity === 'blocking').length;
  const a = issues.length - b;
  return { subjectKey, subjectHash: s.hash, mode: 'review', reviewer: DETERMINISTIC_REVIEWER, score: Math.max(0, 100 - 25 * b - 10 * Math.min(a, 3)), issues };
}
```

- [ ] **Step 6: Write the test-plan drafter**

Create `backend/src/agents/specialists/test-plan.ts`:

```ts
import type { Engagement, TestPlan } from '../../engine/types';
import { rcmRowHash } from '../subjects';

/**
 * Drafts a test plan for each RCM row (spec §3.1) from what the RCM already says: the control objective is the
 * attribute tested, and the RCM's sample size, evidence and procedure carry over. A plan whose row has not changed
 * is kept exactly as it is, including a person's edits. A person's reason for not testing a row is carried over even
 * when the row changed: the agent never sets or clears it. Plans for rows that are gone are dropped.
 */
export function draftTestPlans(e: Engagement): Record<string, TestPlan> {
  const plans: Record<string, TestPlan> = {};
  for (const row of e.rcm) {
    const existing = e.testPlans[row.id];
    const rowHash = rcmRowHash(row);
    if (existing?.rowHash === rowHash) {
      plans[row.id] = existing;
      continue;
    }
    const draft: TestPlan = {
      rowId: row.id,
      rowHash,
      attribute: row.objective,
      population: `Every performance of "${row.control}" (${row.frequency.toLowerCase()}) from ${e.periodFrom} to ${e.periodTo}`,
      sampleSize: row.sampleSize,
      selectionMethod: row.frequency === 'Annual' ? 'all' : 'random',
      evidenceToRequest: [...row.evidenceExpected],
      procedure: row.testOfEffectiveness.join('\n'),
    };
    if (existing?.notTestedJustification) {
      draft.notTestedJustification = existing.notTestedJustification;
      if (existing.editedBy) draft.editedBy = existing.editedBy;
      if (existing.editedAt) draft.editedAt = existing.editedAt;
    }
    plans[row.id] = draft;
  }
  return plans;
}
```

- [ ] **Step 7: Run the tests and the type check**

Run: `npm test -- tests/agent-qa.test.ts tests/graph.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/agents/policy/rules.ts backend/src/agents/qa/deterministic.ts backend/src/agents/specialists/test-plan.ts \
  backend/tests/agent-fixtures.ts backend/tests/graph.test.ts backend/tests/agent-qa.test.ts
git commit -m "feat(agents): rules policy, offline QA reviewer and test-plan drafter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Run and gate storage, the wake hook and agent trail entries

**Files:**
- Create: `backend/src/agents/run-repo.ts`
- Create: `backend/src/agents/gate-repo.ts`
- Modify: `backend/src/observability/context.ts`
- Modify: `backend/src/service.ts` (wake in `mutate`, `humanBundle` public, `agentBundle`)
- Test: `backend/tests/agent-repo.test.ts`

**Interfaces:**
- Consumes: the Task 1 tables and types; `GateRecord`, `QaReport`, `Budget`, `Spent`, `RunStatus`, `StepKind`.
- Produces (`run-repo.ts`):
  - `AgentRun`, `isTerminal`;
  - `createRun(db, { engagementId, startedBy, policy, policyVersion, budget })`, `getRun(db, id, { forUpdate? })`, `listRuns(db, engagementId)`;
  - leases: `leaseNext(db, owner, leaseMs)`, `renewLease(db, id, owner, leaseMs)`, `RunUpdate`, `releaseRun(db, id, owner, update): Promise<boolean>`;
  - transitions: `requestCancel(db, id)`, `requestPause(db, id)`, `markRunnable(db, id)`, `setRunBudget(db, id, budget)`, `wakeWaitingRuns(db, engagementId)`;
  - steps: `StepDraft`, `AgentStep`, `appendStep(db, runId, draft)`, `listSteps(db, runId, { afterSeq?, limit? })`.
- Produces (`gate-repo.ts`): `Gate`, `NewGate`, `insertGate`, `listGates`, `getGate(db, id, { forUpdate? })`, `closeGate(db, id, state, signatureId, comment)`, `supersedeGate`, `supersedeOpenGates(db, runId)`, `closeFindingGate(db, engagementId, findingId, contentHash, state, signatureId, comment)`.
- Produces (`context.ts`): `runWithRequestId<T>(requestId, fn: () => Promise<T>): Promise<T>`.
- Produces (`service.ts`): `AuditService.humanBundle(…)` (now public), `AuditService.agentBundle(e, AgentEvent): UnsealedBundle`, `interface AgentEvent`.
- Behaviour: `mutate` wakes a waiting run (status `waiting`, reason not `paused_by_user`) in the same transaction.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/agent-repo.test.ts`:

```ts
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { closeGate, insertGate, listGates, supersedeOpenGates } from '../src/agents/gate-repo';
import { appendStep, createRun, getRun, leaseNext, listSteps, markRunnable, releaseRun, requestCancel, requestPause } from '../src/agents/run-repo';
import { ensureDevUsers } from '../src/auth/dev-users';
import { appendTrail } from '../src/db/trail-repo';
import { runWithRequestId } from '../src/observability/context';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

const BUDGET = { maxSteps: 50, maxTokens: 1000, maxCostUsd: 1 };

async function engagementWithRun() {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  const run = await createRun(svc.db.kysely, { engagementId: e.id, startedBy: 'auditor', policy: 'rules', policyVersion: 'rules-1', budget: BUDGET });
  return { svc, e, run, db: svc.db.kysely };
}

const newGate = (engagementId: string, runId: string) => ({
  engagementId, runId, kind: 'scope' as const, subjectKey: 'scope', subjectId: 'scope', subjectHash: 'h', basisHash: 'b', qaReport: null,
});

describe('agent runs', () => {
  it('start runnable, and an engagement has one active run at a time [REQ-26]', async () => {
    const { db, e, run } = await engagementWithRun();
    expect(run).toMatchObject({ status: 'runnable', startedBy: 'auditor', budget: BUDGET, spent: { steps: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 } });
    expect(run.id).toMatch(/^AR-[0-9a-f]{12}$/);
    await expect(createRun(db, { engagementId: e.id, startedBy: 'auditor', policy: 'rules', policyVersion: 'rules-1', budget: BUDGET }))
      .rejects.toMatchObject({ status: 409, code: 'RUN_ACTIVE' });
  });

  it('are leased to one worker, and to another once the lease has expired', async () => {
    const { db, run } = await engagementWithRun();
    expect(await leaseNext(db, 'w1', 60_000)).toMatchObject({ id: run.id, status: 'running', leaseOwner: 'w1' });
    expect(await leaseNext(db, 'w2', 60_000)).toBeNull();
    await sql`UPDATE agent_runs SET lease_until = now() - interval '1 second' WHERE id = ${run.id}`.execute(db);
    expect(await leaseNext(db, 'w2', 60_000)).toMatchObject({ id: run.id, leaseOwner: 'w2' });
    expect(await releaseRun(db, run.id, 'w1', { status: 'runnable' })).toBe(false);
    expect(await releaseRun(db, run.id, 'w2', { status: 'waiting', reason: 'awaiting scope gate signature' })).toBe(true);
    expect(await getRun(db, run.id)).toMatchObject({ status: 'waiting', statusReason: 'awaiting scope gate signature', leaseOwner: null });
  });

  it('wake when someone changes the engagement, unless paused', async () => {
    const { svc, db, e, run } = await engagementWithRun();
    await leaseNext(db, 'w1', 60_000);
    await releaseRun(db, run.id, 'w1', { status: 'waiting', reason: 'awaiting scope gate signature' });
    await svc.runModule(e.id, 'scope', auditor);
    expect((await getRun(db, run.id))!.status).toBe('runnable');
    await requestPause(db, run.id);
    await svc.runModule(e.id, 'scope', auditor);
    expect(await getRun(db, run.id)).toMatchObject({ status: 'waiting', statusReason: 'paused_by_user' });
    expect((await markRunnable(db, run.id)).status).toBe('runnable');
  });

  it('turn a cancel asked for mid-iteration into a runnable run, for the worker to act on', async () => {
    const { db, run } = await engagementWithRun();
    await leaseNext(db, 'w1', 60_000);
    expect((await requestCancel(db, run.id)).cancelRequested).toBe(true);
    await releaseRun(db, run.id, 'w1', { status: 'waiting', reason: 'awaiting scope gate signature' });
    expect(await getRun(db, run.id)).toMatchObject({ status: 'runnable', cancelRequested: true });
  });

  it('cancel at once when no worker holds them, superseding open gates, and refuse changes after [REQ-28]', async () => {
    const { db, e, run } = await engagementWithRun();
    await insertGate(db, newGate(e.id, run.id));
    expect(await requestCancel(db, run.id)).toMatchObject({ status: 'cancelled', statusReason: 'cancelled_by_user' });
    expect((await listGates(db, e.id))[0].state).toBe('superseded');
    await expect(requestCancel(db, run.id)).rejects.toMatchObject({ status: 409 });
    await expect(markRunnable(db, run.id)).rejects.toMatchObject({ status: 409 });
  });

  it('number their steps in order, and steps cannot be changed [REQ-28]', async () => {
    const { db, run } = await engagementWithRun();
    await appendStep(db, run.id, { kind: 'decision', agent: 'supervisor', decision: { a: 1 } });
    const second = await appendStep(db, run.id, { kind: 'qa', agent: 'qa', decision: { b: 2 }, trailBundleId: 'AGT-x' });
    expect(second).toMatchObject({ seq: 2, kind: 'qa', decision: { b: 2 }, trailBundleId: 'AGT-x', tokensIn: 0, costUsd: 0 });
    expect((await listSteps(db, run.id)).map((s) => s.seq)).toEqual([1, 2]);
    expect((await listSteps(db, run.id, { afterSeq: 1 })).map((s) => s.seq)).toEqual([2]);
    await expect(sql`UPDATE agent_steps SET agent = 'x'`.execute(db)).rejects.toThrow(/is append-only: /);
  });
});

describe('gates', () => {
  it('count attempts per subject, ignoring superseded gates [REQ-27]', async () => {
    const { db, e, run } = await engagementWithRun();
    const first = await insertGate(db, newGate(e.id, run.id));
    expect(first).toMatchObject({ attempt: 1, state: 'open', kind: 'scope' });
    await expect(insertGate(db, newGate(e.id, run.id))).rejects.toThrow(/gates_one_open/);
    await closeGate(db, first.id, 'rejected', 'SIG-1', 'Add the SoD controls');
    await expect(closeGate(db, first.id, 'approved', 'SIG-2', '')).rejects.toMatchObject({ status: 409 });
    await insertGate(db, newGate(e.id, run.id));
    await supersedeOpenGates(db, run.id);
    expect((await insertGate(db, newGate(e.id, run.id))).attempt).toBe(2);
    expect((await listGates(db, e.id)).map((g) => [g.attempt, g.state, g.comment])).toEqual([
      [1, 'rejected', 'Add the SoD controls'], [2, 'superseded', ''], [2, 'open', ''],
    ]);
  });
});

describe('agent trail entries', () => {
  it('name the agent as the actor, on behalf of the person who started the run, under the run id [REQ-28]', async () => {
    const { svc, e, run } = await engagementWithRun();
    const sealed = await runWithRequestId(run.id, () =>
      svc.db.kysely.transaction().execute((trx) =>
        appendTrail(trx, svc.agentBundle(e, { moduleId: 'agent:decision', agent: 'supervisor', runId: run.id, onBehalfOf: 'auditor', inputs: { stage: 'scope' }, output: { ok: true } }))));
    expect(sealed).toMatchObject({ actor: 'agent:supervisor', moduleId: 'agent:decision', requestId: run.id, inputs: { stage: 'scope', runId: run.id, onBehalfOf: 'auditor' } });
    expect(sealed.id).toMatch(/^AGT-[0-9a-f]{8}$/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/agent-repo.test.ts`
Expected: FAIL. The modules do not exist.

- [ ] **Step 3: Add `runWithRequestId`**

Append to `backend/src/observability/context.ts`:

```ts
/** Runs work outside an HTTP request (the agent worker) under a request id, so its logs and trail bundles carry it. */
export function runWithRequestId<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ requestId }, fn);
}
```

- [ ] **Step 4: Write `gate-repo.ts`**

Create `backend/src/agents/gate-repo.ts`:

```ts
import crypto from 'node:crypto';
import type { Selectable } from 'kysely';
import type { GatesTable } from '../db/schema';
import type { Executor } from '../db/trail-repo';
import { AppError } from '../errors';
import type { GateKind, GateRecord, QaReport } from './types';

// Human gates (spec §4.3, §4.4). A gate is bound to the content and basis it opened on; only a signature closes it,
// and a change to its subject before anyone signs supersedes it. The database refuses anything else (migration 010).

export interface Gate extends GateRecord {
  engagementId: string;
  runId: string;
  qaReport: QaReport | null;
  openedAt: string;
  closedAt: string | null;
}

export interface NewGate {
  engagementId: string;
  runId: string;
  kind: GateKind;
  subjectKey: string;
  subjectId: string;
  subjectHash: string;
  basisHash: string;
  qaReport: QaReport | null;
}

const iso = (d: Date | string) => new Date(d).toISOString();

const toGate = (r: Selectable<GatesTable>): Gate => ({
  id: r.id, engagementId: r.engagement_id, runId: r.run_id, kind: r.kind, subjectKey: r.subject_key, subjectId: r.subject_id,
  subjectHash: r.subject_hash, basisHash: r.basis_hash, qaReport: r.qa_report, attempt: r.attempt, state: r.state,
  signatureId: r.signature_id, comment: r.comment, openedAt: iso(r.opened_at), closedAt: r.closed_at ? iso(r.closed_at) : null,
});

/** Opens a gate. Its attempt counts the subject's earlier gates that were decided or are open; superseded ones do not count. */
export async function insertGate(db: Executor, g: NewGate): Promise<Gate> {
  const prior = await db
    .selectFrom('gates')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('engagement_id', '=', g.engagementId)
    .where('subject_key', '=', g.subjectKey)
    .where('state', '<>', 'superseded')
    .executeTakeFirstOrThrow();
  const row = await db
    .insertInto('gates')
    .values({
      id: `GATE-${crypto.randomBytes(6).toString('hex')}`, engagement_id: g.engagementId, run_id: g.runId, kind: g.kind, subject_key: g.subjectKey,
      subject_id: g.subjectId, subject_hash: g.subjectHash, basis_hash: g.basisHash, qa_report: JSON.stringify(g.qaReport), attempt: Number(prior.n) + 1,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toGate(row);
}

/** Every gate on the engagement, oldest first. */
export async function listGates(db: Executor, engagementId: string): Promise<Gate[]> {
  return (await db.selectFrom('gates').selectAll().where('engagement_id', '=', engagementId).orderBy('seq').execute()).map(toGate);
}

export async function getGate(db: Executor, id: string, opts: { forUpdate?: boolean } = {}): Promise<Gate | null> {
  let q = db.selectFrom('gates').selectAll().where('id', '=', id);
  if (opts.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  return row ? toGate(row) : null;
}

/** Closes an open gate with the signature that decided it. */
export async function closeGate(db: Executor, id: string, state: 'approved' | 'rejected', signatureId: string, comment: string): Promise<Gate> {
  const row = await db
    .updateTable('gates')
    .set({ state, signature_id: signatureId, comment, closed_at: new Date().toISOString() })
    .where('id', '=', id)
    .where('state', '=', 'open')
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new AppError(409, 'This gate is no longer open');
  return toGate(row);
}

export async function supersedeGate(db: Executor, id: string): Promise<void> {
  await db.updateTable('gates').set({ state: 'superseded', closed_at: new Date().toISOString() }).where('id', '=', id).where('state', '=', 'open').execute();
}

export async function supersedeOpenGates(db: Executor, runId: string): Promise<void> {
  await db.updateTable('gates').set({ state: 'superseded', closed_at: new Date().toISOString() }).where('run_id', '=', runId).where('state', '=', 'open').execute();
}

/**
 * A finding's open gate closes with the finding's approval or rejection. If the finding changed after the gate opened,
 * the signature is not about what the gate showed, so the gate is superseded instead and the agent reviews it again.
 */
export async function closeFindingGate(
  db: Executor, engagementId: string, findingId: string, contentHash: string, state: 'approved' | 'rejected', signatureId: string, comment: string,
): Promise<void> {
  const g = await db
    .selectFrom('gates')
    .selectAll()
    .where('engagement_id', '=', engagementId)
    .where('kind', '=', 'finding')
    .where('subject_id', '=', findingId)
    .where('state', '=', 'open')
    .executeTakeFirst();
  if (!g) return;
  if (g.subject_hash !== contentHash) return supersedeGate(db, g.id);
  await closeGate(db, g.id, state, signatureId, comment);
}
```

- [ ] **Step 5: Write `run-repo.ts`**

Create `backend/src/agents/run-repo.ts`:

```ts
import crypto from 'node:crypto';
import { sql, type Selectable, type Updateable } from 'kysely';
import type { AgentRunsTable, AgentStepsTable } from '../db/schema';
import type { Executor } from '../db/trail-repo';
import { AppError } from '../errors';
import { supersedeOpenGates } from './gate-repo';
import { TERMINAL_STATUSES, type Budget, type RunStatus, type Spent, type StepKind } from './types';

// Agent runs and their steps (spec §3.1, §6). While a worker holds a run's lease it is the run's only writer; people
// change a run only through the transitions below, each refused when the run is in the wrong state. An ended run is
// locked by the database (migration 010).

export interface AgentRun {
  id: string;
  engagementId: string;
  goal: 'engagement';
  status: RunStatus;
  statusReason: string;
  policy: 'llm' | 'rules';
  policyVersion: string;
  budget: Budget;
  spent: Spent;
  startedBy: string;
  cancelRequested: boolean;
  pauseRequested: boolean;
  failureStreak: number;
  conflictStreak: number;
  wakeAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

const iso = (d: Date | string) => new Date(d).toISOString();
const isoOrNull = (d: Date | string | null) => (d ? iso(d) : null);
const now = () => new Date().toISOString();

function toRun(r: Selectable<AgentRunsTable>): AgentRun {
  return {
    id: r.id, engagementId: r.engagement_id, goal: r.goal, status: r.status, statusReason: r.status_reason, policy: r.policy,
    policyVersion: r.policy_version, budget: r.budget, spent: r.spent, startedBy: r.started_by, cancelRequested: r.cancel_requested,
    pauseRequested: r.pause_requested, failureStreak: r.failure_streak, conflictStreak: r.conflict_streak, wakeAt: isoOrNull(r.wake_at),
    leaseOwner: r.lease_owner, leaseUntil: isoOrNull(r.lease_until), version: r.version, createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at), endedAt: isoOrNull(r.ended_at),
  };
}

export const isTerminal = (status: RunStatus) => TERMINAL_STATUSES.includes(status);

export async function createRun(
  db: Executor,
  p: { engagementId: string; startedBy: string; policy: 'llm' | 'rules'; policyVersion: string; budget: Budget },
): Promise<AgentRun> {
  try {
    const row = await db
      .insertInto('agent_runs')
      .values({
        id: `AR-${crypto.randomBytes(6).toString('hex')}`, engagement_id: p.engagementId, status: 'runnable', policy: p.policy,
        policy_version: p.policyVersion, budget: JSON.stringify(p.budget), started_by: p.startedBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRun(row);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AppError(409, `Engagement ${p.engagementId} already has an active agent run`, 'RUN_ACTIVE');
    throw err;
  }
}

export async function getRun(db: Executor, id: string, opts: { forUpdate?: boolean } = {}): Promise<AgentRun | null> {
  let q = db.selectFrom('agent_runs').selectAll().where('id', '=', id);
  if (opts.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  return row ? toRun(row) : null;
}

/** The engagement's runs, newest first. */
export async function listRuns(db: Executor, engagementId: string): Promise<AgentRun[]> {
  const rows = await db.selectFrom('agent_runs').selectAll().where('engagement_id', '=', engagementId).orderBy('created_at', 'desc').orderBy('id').execute();
  return rows.map(toRun);
}

/** Takes one due run: runnable, waiting past its wake time, or running with an expired lease (its worker died). */
export async function leaseNext(db: Executor, owner: string, leaseMs: number): Promise<AgentRun | null> {
  const { rows } = await sql<Selectable<AgentRunsTable>>`
    UPDATE agent_runs
    SET status = 'running', lease_owner = ${owner}, lease_until = now() + ${leaseMs}::int * interval '1 millisecond',
        wake_at = NULL, updated_at = now(), version = version + 1
    WHERE id = (
      SELECT id FROM agent_runs
      WHERE status = 'runnable'
         OR (status = 'waiting' AND wake_at IS NOT NULL AND wake_at <= now())
         OR (status = 'running' AND lease_until < now())
      ORDER BY updated_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
    RETURNING *`.execute(db);
  return rows[0] ? toRun(rows[0]) : null;
}

/** Extends the lease while an iteration is still working. False when another worker has taken the run. */
export async function renewLease(db: Executor, id: string, owner: string, leaseMs: number): Promise<boolean> {
  const res = await sql`
    UPDATE agent_runs SET lease_until = now() + ${leaseMs}::int * interval '1 millisecond'
    WHERE id = ${id} AND lease_owner = ${owner} AND status = 'running'`.execute(db);
  return Number(res.numAffectedRows ?? 0) === 1;
}

export interface RunUpdate {
  status: RunStatus;
  reason?: string;
  wakeAt?: Date | null;
  spent?: Spent;
  failureStreak?: number;
  conflictStreak?: number;
  /** The worker acted on a pause request, so the request is cleared. */
  pauseHandled?: boolean;
}

/**
 * The leasing worker's last word on an iteration: the run's next status, and the lease released. A cancel or pause asked
 * for while the iteration ran turns the run runnable instead, so the next tick acts on it. False when the lease was lost.
 */
export async function releaseRun(db: Executor, id: string, owner: string, u: RunUpdate): Promise<boolean> {
  const terminal = isTerminal(u.status);
  const pauseHandled = u.pauseHandled ?? false;
  const res = await sql`
    UPDATE agent_runs SET
      status = CASE WHEN NOT ${terminal}::boolean AND (cancel_requested OR (pause_requested AND NOT ${pauseHandled}::boolean))
               THEN 'runnable' ELSE ${u.status}::text END,
      status_reason = CASE WHEN NOT ${terminal}::boolean AND (cancel_requested OR (pause_requested AND NOT ${pauseHandled}::boolean))
               THEN '' ELSE ${u.reason ?? ''}::text END,
      pause_requested = CASE WHEN ${pauseHandled}::boolean THEN false ELSE pause_requested END,
      wake_at = ${u.wakeAt ? u.wakeAt.toISOString() : null}::timestamptz,
      spent = COALESCE(${u.spent ? JSON.stringify(u.spent) : null}::jsonb, spent),
      failure_streak = COALESCE(${u.failureStreak ?? null}::int, failure_streak),
      conflict_streak = COALESCE(${u.conflictStreak ?? null}::int, conflict_streak),
      lease_owner = NULL, lease_until = NULL, updated_at = now(), version = version + 1,
      ended_at = CASE WHEN ${terminal}::boolean THEN now() ELSE NULL END
    WHERE id = ${id} AND lease_owner = ${owner} AND status = 'running'`.execute(db);
  return Number(res.numAffectedRows ?? 0) === 1;
}

async function lockedLiveRun(db: Executor, id: string): Promise<AgentRun> {
  const run = await getRun(db, id, { forUpdate: true });
  if (!run) throw new AppError(404, `Agent run ${id} not found`);
  if (isTerminal(run.status)) throw new AppError(409, `Agent run ${id} has ended (${run.status})`);
  return run;
}

async function updateRun(db: Executor, id: string, set: Updateable<AgentRunsTable>): Promise<AgentRun> {
  const row = await db
    .updateTable('agent_runs')
    .set({ ...set, updated_at: now(), version: sql<number>`version + 1` })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRun(row);
}

/** Cancels at once when no worker holds the run (its open gates are superseded); otherwise on the worker's next look. */
export async function requestCancel(db: Executor, id: string): Promise<AgentRun> {
  const run = await lockedLiveRun(db, id);
  if (run.status === 'running') return updateRun(db, id, { cancel_requested: true });
  await supersedeOpenGates(db, id);
  return updateRun(db, id, { status: 'cancelled', status_reason: 'cancelled_by_user', wake_at: null, ended_at: now() });
}

/** Pauses at once when no worker holds the run; otherwise on the worker's next look. A paused run waits until resumed. */
export async function requestPause(db: Executor, id: string): Promise<AgentRun> {
  const run = await lockedLiveRun(db, id);
  if (run.status === 'running') return updateRun(db, id, { pause_requested: true });
  return updateRun(db, id, { status: 'waiting', status_reason: 'paused_by_user', wake_at: null });
}

/** Resumes a waiting or escalated run. */
export async function markRunnable(db: Executor, id: string): Promise<AgentRun> {
  const run = await lockedLiveRun(db, id);
  if (run.status === 'running' || run.status === 'runnable') throw new AppError(409, `Agent run ${id} is already ${run.status}`);
  return updateRun(db, id, { status: 'runnable', status_reason: '', pause_requested: false, failure_streak: 0, conflict_streak: 0, wake_at: null });
}

/** Sets a new budget. A run stopped by its budget resumes. */
export async function setRunBudget(db: Executor, id: string, budget: Budget): Promise<AgentRun> {
  const run = await lockedLiveRun(db, id);
  const resume = run.status === 'needs_human' && run.statusReason.startsWith('budget_exhausted');
  return updateRun(db, id, { budget: JSON.stringify(budget), ...(resume ? { status: 'runnable' as const, status_reason: '' } : {}) });
}

/** Any change to the engagement wakes its waiting run, which then re-derives where it stands. A paused run stays paused. */
export async function wakeWaitingRuns(db: Executor, engagementId: string): Promise<void> {
  await db
    .updateTable('agent_runs')
    .set({ status: 'runnable', status_reason: '', wake_at: null, updated_at: now(), version: sql<number>`version + 1` })
    .where('engagement_id', '=', engagementId)
    .where('status', '=', 'waiting')
    .where('status_reason', '<>', 'paused_by_user')
    .execute();
}

// ---------- Steps ----------

export interface StepDraft {
  kind: StepKind;
  agent: string;
  decision: unknown;
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
  trailBundleId?: string | null;
}

export interface AgentStep {
  runId: string;
  seq: number;
  kind: StepKind;
  agent: string;
  decision: unknown;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  trailBundleId: string | null;
  createdAt: string;
}

const toStep = (r: Selectable<AgentStepsTable>): AgentStep => ({
  runId: r.run_id, seq: r.seq, kind: r.kind, agent: r.agent, decision: r.decision, model: r.model, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
  costUsd: r.cost_usd, durationMs: r.duration_ms, trailBundleId: r.trail_bundle_id, createdAt: iso(r.created_at),
});

/** Appends the run's next step. Only the run's leaseholder appends, so seq does not race; the primary key backs that up. */
export async function appendStep(db: Executor, runId: string, d: StepDraft): Promise<AgentStep> {
  const last = await db.selectFrom('agent_steps').select((eb) => eb.fn.max('seq').as('seq')).where('run_id', '=', runId).executeTakeFirst();
  const row = await db
    .insertInto('agent_steps')
    .values({
      run_id: runId, seq: Number(last?.seq ?? 0) + 1, kind: d.kind, agent: d.agent, decision: JSON.stringify(d.decision), model: d.model ?? null,
      tokens_in: d.tokensIn ?? 0, tokens_out: d.tokensOut ?? 0, cost_usd: d.costUsd ?? 0, duration_ms: d.durationMs ?? 0, trail_bundle_id: d.trailBundleId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toStep(row);
}

export async function listSteps(db: Executor, runId: string, opts: { afterSeq?: number; limit?: number } = {}): Promise<AgentStep[]> {
  const rows = await db
    .selectFrom('agent_steps')
    .selectAll()
    .where('run_id', '=', runId)
    .where('seq', '>', opts.afterSeq ?? 0)
    .orderBy('seq')
    .limit(opts.limit ?? 10_000)
    .execute();
  return rows.map(toStep);
}
```

- [ ] **Step 6: Wake on every change, and add agent trail bundles to the service**

In `backend/src/service.ts`:
- Add `import { wakeWaitingRuns } from './agents/run-repo';`.
- In `mutate`, right after `await saveEngagement(trx, loaded);`, add:

```ts
      // Any change wakes the engagement's waiting agent run, in this same transaction (spec §6.2).
      await wakeWaitingRuns(trx, engagementId);
```

- Change `private humanBundle(` to a public method with this doc comment:

```ts
  /** A trail bundle for a person's action on the engagement. */
  humanBundle(e: Engagement, moduleId: string, actor: User, inputs: unknown, output: unknown, qaActions: QaAction[] = []): UnsealedBundle {
```

- Add after `humanBundle`:

```ts
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
```

- Add near `MutationOptions`:

```ts
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
```

- [ ] **Step 7: Run the tests and the type check**

Run: `npm test -- tests/agent-repo.test.ts tests/api.test.ts tests/persistence.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add backend/src/agents/run-repo.ts backend/src/agents/gate-repo.ts backend/src/observability/context.ts backend/src/service.ts backend/tests/agent-repo.test.ts
git commit -m "feat(agents): run, step and gate storage; wake on change; agent trail bundles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The agent's way into the service, and its rails

**Files:**
- Create: `backend/src/agents/rails.ts`
- Create: `backend/src/agents/port.ts`
- Modify: `backend/src/service.ts`: split `runModule` into `executeModule` and the transaction; add `runModuleAsAgent`, `saveTestPlansAsAgent`, `editTestPlan`.
- Test: `backend/tests/agent-service.test.ts`

**Interfaces:**
- Consumes: `agentBundle`, `AgentEvent` (Task 5); `TestPlan` (Task 2); `draftTestPlans` (Task 4).
- Produces (`service.ts`):
  - `interface AgentActing { runId: string; agent: string; startedBy: User }`;
  - `interface AgentWriteOptions { expectedVersion: number; rows?: string[] }`;
  - `runModuleAsAgent(engagementId, moduleId, acting, opts): Promise<{ bundle: TrailBundle; engagement: Engagement }>`;
  - `saveTestPlansAsAgent(engagementId, plans, acting, opts): Promise<{ bundle: TrailBundle; engagement: Engagement }>`;
  - `type TestPlanPatch`, `editTestPlan(engagementId, rowId, patch, actor, opts?): Promise<TestPlan>`.
- Produces (`rails.ts`): `keepScopeDecisions(previous, next)`, `mergeFindings(previous, drafted, rows, rowOrder)`, `assertWithinRails(before, after)`, `assertJustificationsUnchanged(before, after, rowIds)`.
- Produces (`port.ts`): `AgentPort`, `AGENT_PORT_METHODS`, `agentPort(svc)`.

**How the agent path differs from a person running a module:**
- The module, and any model call it makes, runs on an unlocked snapshot.
- The result is applied only if the engagement is still at the snapshot's version (`VERSION_CONFLICT` otherwise).
- The trail bundle's `actor` is `agent:<name>`, and its `inputs` carry `runId` and `onBehalfOf`.
- Drafted findings get `preparedBy = [startedBy.id]`.
- `assertWithinRails` runs inside the transaction before anything is saved.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/agent-service.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/agent-service.test.ts`
Expected: FAIL. `runModuleAsAgent` and the port do not exist.

- [ ] **Step 3: Write the rails**

Create `backend/src/agents/rails.ts`:

```ts
import { canonicalJson } from '../engine/trail';
import type { Engagement, Finding, ScopeItem, TestPlan } from '../engine/types';
import { AppError } from '../errors';

// What an agent may never do, however it was asked (spec §5.4). These checks run inside the transaction of every
// agent write, before it commits, whatever the graph or a model decided.

const forbidden = (message: string) => new AppError(403, message, 'AGENT_FORBIDDEN');

/** A redrafted scope keeps every in/out decision already made for a control it still proposes. */
export function keepScopeDecisions(previous: ScopeItem[], next: ScopeItem[]): void {
  const decided = new Map(previous.map((s) => [s.controlId, s.included]));
  for (const s of next) if (decided.has(s.controlId)) s.included = decided.get(s.controlId)!;
}

/** The findings after redrafting only `rows`: every other finding stays exactly as it was. */
export function mergeFindings(previous: Finding[], drafted: Finding[], rows: string[], rowOrder: string[]): Finding[] {
  const target = new Set(rows);
  const order = new Map(rowOrder.map((id, i) => [id, i]));
  const kept = previous.filter((f) => !target.has(f.rowId));
  const fresh = drafted.filter((f) => target.has(f.rowId) && !previous.some((p) => p.id === f.id));
  const at = (f: Finding) => order.get(f.rowId) ?? rowOrder.length;
  return [...kept, ...fresh].sort((x, y) => at(x) - at(y));
}

/** Only an auditor decides a row will not be tested. Plans for rows that left the RCM may go. */
export function assertJustificationsUnchanged(before: Record<string, TestPlan>, after: Record<string, TestPlan>, rowIds: string[]): void {
  const live = new Set(rowIds);
  const ids = new Set([...Object.keys(after), ...Object.keys(before).filter((id) => live.has(id))]);
  for (const id of ids) {
    if ((before[id]?.notTestedJustification ?? '') !== (after[id]?.notTestedJustification ?? '')) throw forbidden(`Only an auditor may decide not to test ${id}`);
  }
}

/** The engagement after an agent's change, checked against the engagement before it. */
export function assertWithinRails(before: Engagement, after: Engagement): void {
  if (canonicalJson(before.testInputs) !== canonicalJson(after.testInputs)) throw forbidden('An agent may not record or change test results');
  const now = new Map(after.findings.map((f) => [f.id, f]));
  for (const f of before.findings) {
    if (f.status !== 'reviewed' && f.status !== 'approved') continue;
    const g = now.get(f.id);
    if (!g || canonicalJson(g) !== canonicalJson(f)) throw forbidden(`An agent may not change finding ${f.id} after it has been reviewed`);
  }
  const signed = new Map(before.findings.map((f) => [f.id, f.signOffs.length]));
  for (const f of after.findings) if (f.signOffs.length > (signed.get(f.id) ?? 0)) throw forbidden('An agent may not sign');
  assertJustificationsUnchanged(before.testPlans, after.testPlans, after.rcm.map((r) => r.id));
}
```

- [ ] **Step 4: Add the agent path to the service**

In `backend/src/service.ts`:
- Add imports: `import type { AuditModule } from './engine/module';` (beside `ModuleContext`), `TestPlan` in the engine-types import, and `import { assertJustificationsUnchanged, assertWithinRails, keepScopeDecisions, mergeFindings } from './agents/rails';`.
- Add near `MutationOptions`:

```ts
/** An agent acting for a run: recorded as `agent:<agent>`, on behalf of the person who started the run. */
export interface AgentActing {
  runId: string;
  agent: string;
  startedBy: User;
}

/** Agent writes always state the version they were built on. `rows` limits a Gap Writer redraft to those RCM rows. */
export interface AgentWriteOptions {
  expectedVersion: number;
  rows?: string[];
}

export type TestPlanPatch = Partial<Pick<TestPlan, 'attribute' | 'population' | 'sampleSize' | 'selectionMethod' | 'evidenceToRequest' | 'procedure' | 'notTestedJustification'>>;
```

- Replace `runModule` with the version below, and add `moduleById`, `executeModule`, `runModuleAsAgent`, `saveTestPlansAsAgent` and `editTestPlan` after it:

```ts
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
  private async executeModule(mod: AuditModule<unknown>, view: Engagement, actor: User, input: Record<string, unknown>, acting?: AgentActing) {
    const startedAt = new Date().toISOString();
    const ctx = new ModuleContext(view, this.registry, this.grounding, this.llm, actor, input, this.citationPolicy);
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
      provider: this.llm ? { id: this.llm.id, model: ctx.servedModel ?? this.llm.model } : { ...OFFLINE },
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
    const input = opts.rows ? { rows: opts.rows } : {};
    const { output, bundle } = await this.executeModule(mod, view, acting.startedBy, input, acting);
    const { result: engagement, sealed } = await this.mutate(engagementId, { expectedVersion: loaded.version }, (e, emit) => {
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
  async saveTestPlansAsAgent(engagementId: string, plans: Record<string, TestPlan>, acting: AgentActing, opts: AgentWriteOptions) {
    const { result: engagement, sealed } = await this.mutate(engagementId, { expectedVersion: opts.expectedVersion }, (e, emit) => {
      assertJustificationsUnchanged(e.testPlans, plans, e.rcm.map((r) => r.id));
      e.testPlans = plans;
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
```

- [ ] **Step 5: Write the port**

Create `backend/src/agents/port.ts`:

```ts
import type { AuditService } from '../service';

/**
 * Everything the agent runtime may ask of the service (spec §5.4). Signing, recording test results and editing
 * findings, scope or test plans by hand are deliberately absent: the runtime is given this object, never the service.
 */
export interface AgentPort {
  engagement: AuditService['engagement'];
  runModule: AuditService['runModuleAsAgent'];
  saveTestPlans: AuditService['saveTestPlansAsAgent'];
  agentBundle: AuditService['agentBundle'];
}

export const AGENT_PORT_METHODS = ['agentBundle', 'engagement', 'runModule', 'saveTestPlans'] as const;

export function agentPort(svc: AuditService): AgentPort {
  return Object.freeze({
    engagement: (id) => svc.engagement(id),
    runModule: (...args) => svc.runModuleAsAgent(...args),
    saveTestPlans: (...args) => svc.saveTestPlansAsAgent(...args),
    agentBundle: (...args) => svc.agentBundle(...args),
  });
}
```

- [ ] **Step 6: Run the tests and the type check**

Run: `npm test -- tests/agent-service.test.ts tests/engine.test.ts tests/api.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add backend/src/agents/rails.ts backend/src/agents/port.ts backend/src/service.ts backend/tests/agent-service.test.ts
git commit -m "feat(agents): agent path into the service with rails, test plans and the agent port

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Gate signing

**Files:**
- Modify: `backend/src/service.ts`: `signatureProof`, `checkGateSignOff`, `gateGuard`, `signGate`; finding-gate closure in `signOff`
- Modify: `backend/src/signing/flow.ts` (dispatch to `signGate`)
- Modify: `backend/src/signing/routes.ts` (`POST /api/gates/:gateId/sign-intents`)
- Modify: `backend/src/app.ts` (signing rate limit on the new route)
- Modify: `backend/src/ops/verify.ts` (workpaper signatures and gates)
- Modify: `backend/tests/http.ts` (`devSignGate`)
- Test: `backend/tests/gates.test.ts`

**Interfaces:**
- Consumes: `getGate`, `closeGate`, `closeFindingGate`, `wakeWaitingRuns`, `getRun` (Task 5); `workpaperContentHash`, `recordWorkpaperRevisions` (Task 2); `createIntent` with `{ gateId, workpaper }` (Task 1).
- Produces:
  - `AuditService.checkGateSignOff(gateId, actor): Promise<{ engagementId: string; workpaper: SignableWorkpaper; contentHash: string }>`;
  - `AuditService.signGate(gateId, action: 'approve' | 'reject', comment, actor, signature): Promise<Gate>`.
- Produces (trail): module ID `human:gate-sign`, whose output is `{ signatureId, gateId, kind, meaning, contentHash, userId, userName, role, at, reauth, comment }`.
- Produces (tests): `tests/http.ts` `devSignGate(user, userId, gateId, action, comment?, confirm?)`.

**Rules** (spec §4.3, §4.4):

| Gate | Signer |
|---|---|
| scope, rcm | `audit_manager` (`REVIEWER_ROLES`) |
| report | `cae` (`APPROVER_ROLES`) |

- **Never the starter.** The run's `started_by` may not sign its gates (403 `SOD_VIOLATION`).
- **Stale content.** The signer must see the content the gate was opened on; otherwise 409 `GATE_STALE`.
- **Rejection.** Rejecting needs a comment.
- **Finding gates** close only through the existing finding signatures:
  - `Approved` closes the gate as `approved`; `Rejected` closes it as `rejected`; `Reviewed` leaves it open.
  - If the finding changed after the gate opened, the gate is superseded instead.

- [ ] **Step 1: Add the gate-signing helper for tests**

Append to `backend/tests/http.ts`:

```ts
/** The signing pop-up for a gate: start, read the form, confirm. */
export async function devSignGate(user: Session, userId: string, gateId: string, action: 'approve' | 'reject', comment = 'agreed', confirm = userId) {
  const intent = await user.post(`/api/gates/${gateId}/sign-intents`, { action, comment });
  if (intent.status !== 201) return { intent, popup: null, status: null as null | { status: string; code: string | null } };
  const popup = await user.get(intent.body.reauthUrl).expect(200);
  const nonce = /name="nonce" value="([^"]+)"/.exec(popup.text)![1];
  await user.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm });
  const status = (await user.get(`/api/sign-intents/${intent.body.intentId}`).expect(200)).body;
  return { intent, popup, status };
}
```

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/gates.test.ts`:

```ts
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { getGate, insertGate } from '../src/agents/gate-repo';
import { createRun, getRun, leaseNext, releaseRun } from '../src/agents/run-repo';
import { findingKey, subjectInfo } from '../src/agents/subjects';
import { listSignatures } from '../src/db/signature-repo';
import { readTrail } from '../src/db/trail-repo';
import { verifyIntegrity } from '../src/ops/verify';
import type { AuditService } from '../src/service';
import { approver, auditor, engagementWithFailedControl, NEW_ENGAGEMENT, reviewer, unattended } from './helpers';
import { appWithDevUsers, devSignGate, signIn } from './http';

const BUDGET = { maxSteps: 50, maxTokens: 1000, maxCostUsd: 1 };

/** The engagement's agent run waiting at an open gate on `key`, opened the way the executor opens one. */
async function waitingAtGate(svc: AuditService, engagementId: string, key: string, startedBy = 'auditor') {
  const e = await svc.engagement(engagementId);
  const run = await createRun(svc.db.kysely, { engagementId, startedBy, policy: 'rules', policyVersion: 'rules-1', budget: BUDGET });
  const s = subjectInfo(e, key)!;
  const gate = await insertGate(svc.db.kysely, {
    engagementId, runId: run.id, kind: s.gateKind!, subjectKey: key, subjectId: s.subjectId, subjectHash: s.hash, basisHash: s.basis, qaReport: null,
  });
  await leaseNext(svc.db.kysely, 'w', 60_000);
  await releaseRun(svc.db.kysely, run.id, 'w', { status: 'waiting', reason: `awaiting ${s.gateKind} gate signature` });
  return { run, gate };
}

async function scoped(svc: AuditService) {
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  await svc.runModule(e.id, 'scope', auditor);
  return e.id;
}

describe('workpaper gates', () => {
  it('are signed after re-authentication, bound to the workpaper, and wake the run [REQ-27, REQ-19]', async () => {
    const { app, svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { run, gate } = await waitingAtGate(svc, id, 'scope');
    const manager = await signIn(app, 'reviewer');
    const r = await devSignGate(manager, 'reviewer', gate.id, 'approve');
    expect(r.popup!.text).toContain('the <b>scope</b> workpaper');
    expect(r.status).toEqual({ status: 'signed', code: null, message: null });
    const closed = (await getGate(svc.db.kysely, gate.id))!;
    expect(closed).toMatchObject({ state: 'approved', signatureId: expect.stringMatching(/^SIG-/) });
    const [sig] = await listSignatures(svc.db.kysely, id);
    expect(sig).toMatchObject({
      id: closed.signatureId, subjectKind: 'workpaper', workpaper: 'scope', gateId: gate.id, findingId: null, meaning: 'Approved',
      contentHash: gate.subjectHash, reauthMethod: 'dev', userId: 'reviewer',
    });
    expect((await readTrail(svc.db.kysely, id)).at(-1)).toMatchObject({
      moduleId: 'human:gate-sign', actor: 'reviewer', output: { signatureId: sig.id, gateId: gate.id, meaning: 'Approved' },
    });
    expect((await getRun(svc.db.kysely, run.id))!.status).toBe('runnable');
  });

  it("are signed only by the right role, and never by the run's starter [REQ-17, REQ-27]", async () => {
    const { app, svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { gate } = await waitingAtGate(svc, id, 'scope', 'reviewer');
    for (const userId of ['auditor', 'approver']) {
      expect((await (await signIn(app, userId)).post(`/api/gates/${gate.id}/sign-intents`, { action: 'approve' })).status).toBe(403);
    }
    const starter = await (await signIn(app, 'reviewer')).post(`/api/gates/${gate.id}/sign-intents`, { action: 'approve' });
    expect(starter.status).toBe(403);
    expect(starter.body.code).toBe('SOD_VIOLATION');
  });

  it('ask the CAE, not an audit manager, to sign the report [REQ-27]', async () => {
    const { app, svc } = await appWithDevUsers();
    const e = await engagementWithFailedControl(svc);
    await svc.runModule(e.id, 'report', auditor);
    const { gate } = await waitingAtGate(svc, e.id, 'report');
    expect((await (await signIn(app, 'reviewer')).post(`/api/gates/${gate.id}/sign-intents`, { action: 'approve' })).status).toBe(403);
    expect((await devSignGate(await signIn(app, 'approver'), 'approver', gate.id, 'approve')).status!.status).toBe('signed');
  });

  it('refuse a signature on a workpaper that changed after the gate opened, or during signing', async () => {
    const { app, svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { gate } = await waitingAtGate(svc, id, 'scope');
    const manager = await signIn(app, 'reviewer');
    const intent = await manager.post(`/api/gates/${gate.id}/sign-intents`, { action: 'approve' }).expect(201);
    const nonce = /name="nonce" value="([^"]+)"/.exec((await manager.get(intent.body.reauthUrl)).text)![1];
    const first = (await svc.engagement(id)).scope[0];
    await svc.setScope(id, [{ controlId: first.controlId, included: !first.included }], auditor);
    await manager.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: 'reviewer' });
    expect((await manager.get(`/api/sign-intents/${intent.body.intentId}`)).body.code).toBe('GATE_STALE');
    const again = await manager.post(`/api/gates/${gate.id}/sign-intents`, { action: 'approve' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('GATE_STALE');
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
    expect((await getGate(svc.db.kysely, gate.id))!.state).toBe('open');
  });

  it('need a reason to reject, and keep it for the agent to redraft from', async () => {
    const { app, svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { gate } = await waitingAtGate(svc, id, 'scope');
    const manager = await signIn(app, 'reviewer');
    expect((await manager.post(`/api/gates/${gate.id}/sign-intents`, { action: 'reject', comment: ' ' })).status).toBe(400);
    expect((await devSignGate(manager, 'reviewer', gate.id, 'reject', 'Bring the allergen controls into scope')).status!.status).toBe('signed');
    expect(await getGate(svc.db.kysely, gate.id)).toMatchObject({ state: 'rejected', comment: 'Bring the allergen controls into scope' });
  });

  it('are checked by verify against the workpaper history, the trail and the gate [REQ-24]', async () => {
    const { svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { gate } = await waitingAtGate(svc, id, 'scope');
    await svc.signGate(gate.id, 'approve', 'In scope as proposed', reviewer, unattended);
    expect((await verifyIntegrity(svc.db.kysely, null)).signatures.problems).toEqual([]);
    await sql`ALTER TABLE workpaper_revisions DISABLE TRIGGER workpaper_revisions_append_only`.execute(svc.db.kysely);
    await sql`UPDATE workpaper_revisions SET content_hash = 'tampered' WHERE engagement_id = ${id}`.execute(svc.db.kysely);
    await sql`ALTER TABLE gates DISABLE TRIGGER gates_guard`.execute(svc.db.kysely);
    await sql`UPDATE gates SET signature_id = 'SIG-missing' WHERE id = ${gate.id}`.execute(svc.db.kysely);
    expect((await verifyIntegrity(svc.db.kysely, null)).signatures.problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/scope gate GATE-.*the signed content is not in the workpaper's history/),
      expect.stringMatching(/^Gate GATE-.* is approved, but its signature SIG-missing is missing/),
    ]));
  });
});

describe('finding gates', () => {
  it('close when the finding is approved, not when it is reviewed [REQ-27]', async () => {
    const { svc } = await appWithDevUsers();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const { gate } = await waitingAtGate(svc, e.id, findingKey(f.rowId));
    await svc.signOff(e.id, f.id, 'review', '', reviewer, {}, unattended);
    expect((await getGate(svc.db.kysely, gate.id))!.state).toBe('open');
    await svc.signOff(e.id, f.id, 'approve', '', approver, {}, unattended);
    expect(await getGate(svc.db.kysely, gate.id)).toMatchObject({ state: 'approved', signatureId: expect.stringMatching(/^SIG-/) });
  });

  it('are superseded, not closed, when the finding changed after the gate opened', async () => {
    const { svc } = await appWithDevUsers();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const { gate } = await waitingAtGate(svc, e.id, findingKey(f.rowId));
    await svc.editFinding(e.id, f.id, { title: 'Edited after the gate opened' }, auditor);
    await svc.signOff(e.id, f.id, 'review', '', reviewer, {}, unattended);
    await svc.signOff(e.id, f.id, 'approve', '', approver, {}, unattended);
    expect((await getGate(svc.db.kysely, gate.id))!.state).toBe('superseded');
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -- tests/gates.test.ts`
Expected: FAIL. The route answers 404 and `signGate` does not exist.

- [ ] **Step 4: Add gate signing to the service**

In `backend/src/service.ts`:
- Add imports: `import { closeFindingGate, closeGate, getGate, type Gate } from './agents/gate-repo';`, `getRun` added to the `./agents/run-repo` import, `import type { SignableWorkpaper } from './agents/types';`, `recordWorkpaperRevisions` from `./db/revision-repo` (beside `lastRevisionTimes`), `workpaperContentHash` added to the `./signing/content-hash` import, and `type Executor` from `./db/trail-repo` (beside `appendTrail`).
- Add `signatureProof`, and make `signOff` use it. Replace the first four lines of `signOff`'s body (the `unattended` / `reauthed` / `if (!unattended && !reauthed)` block) with `const { unattended, reauthed } = this.signatureProof(signature);`:

```ts
  /** The proof a signature needs: re-authentication for this exact content, or an explicit unattended marker. Anything else fails closed. */
  private signatureProof(signature: SignatureContext | UnattendedSigning) {
    const unattended = signature && 'unattended' in signature && (signature.unattended === 'seed' || signature.unattended === 'test') ? signature.unattended : null;
    const reauthed = signature && !unattended && 'contentHash' in signature && signature.intentId ? (signature as SignatureContext) : null;
    if (!unattended && !reauthed) {
      throw new AppError(428, 'Signing needs re-authentication: start a signing request instead', 'REAUTH_REQUIRED');
    }
    return { unattended, reauthed };
  }
```

- In `signOff`, right after the `await insertSignature(trx, { … });` call, add:

```ts
      // An approval or rejection decides the finding's gate, if the agent opened one; a review leaves it open.
      if (meaning !== 'Reviewed') {
        await closeFindingGate(trx, e.id, findingId, contentHash, meaning === 'Approved' ? 'approved' : 'rejected', sig.signatureId!, comment);
      }
```

- Add after `signOff`:

```ts
  /** Who may sign a scope, RCM or report gate, and whether its workpaper is still what the gate showed (agent spec §4.3, §4.4). */
  private async gateGuard(db: Executor, gate: Gate, e: Engagement, actor: User): Promise<{ workpaper: SignableWorkpaper; contentHash: string }> {
    if (gate.kind === 'finding') throw new AppError(409, "A finding gate closes with the finding's own review and approval signatures");
    if (gate.state !== 'open') throw new AppError(409, `This gate is already ${gate.state}`);
    const workpaper: SignableWorkpaper = gate.kind;
    this.require(actor, workpaper === 'report' ? APPROVER_ROLES : REVIEWER_ROLES, `sign ${workpaper} gates`);
    const run = await getRun(db, gate.runId);
    if (run?.startedBy === actor.id) throw new AppError(403, 'You started this agent run, so someone else must sign its gates', 'SOD_VIOLATION');
    const contentHash = workpaperContentHash(workpaper, e);
    if (contentHash !== gate.subjectHash) {
      throw new AppError(409, 'The workpaper changed after this gate opened; the agent will review it again before asking for a signature', 'GATE_STALE');
    }
    return { workpaper, contentHash };
  }

  /** Checks a gate could be signed by this person now, before they are asked to re-authenticate; returns the content to bind. */
  async checkGateSignOff(gateId: string, actor: User): Promise<{ engagementId: string; workpaper: SignableWorkpaper; contentHash: string }> {
    const gate = await getGate(this.db.kysely, gateId);
    if (!gate) throw new AppError(404, `Gate ${gateId} not found`);
    const e = await this.engagement(gate.engagementId);
    return { engagementId: e.id, ...(await this.gateGuard(this.db.kysely, gate, e, actor)) };
  }

  /**
   * Signs a scope, RCM or report gate (Part 11, like a finding signature): the signature is bound to the workpaper's
   * content hash, recorded in the signatures table and the trail, and closes the gate; the run waiting on it wakes.
   */
  async signGate(gateId: string, action: 'approve' | 'reject', comment: string, actor: User, signature: SignatureContext | UnattendedSigning): Promise<Gate> {
    const { unattended, reauthed } = this.signatureProof(signature);
    if (action === 'reject' && !comment.trim()) throw new AppError(400, 'Say why you are rejecting this workpaper: the agent redrafts it from your comment');
    return this.db.kysely.transaction().execute(async (trx) => {
      const gate = await getGate(trx, gateId, { forUpdate: true });
      if (!gate) throw new AppError(404, `Gate ${gateId} not found`);
      // Lock the engagement too, so its workpapers cannot change between the check and the signature.
      const loaded = await loadEngagement(trx, gate.engagementId, { forUpdate: true });
      if (!loaded) throw new AppError(404, `Engagement ${gate.engagementId} not found`);
      const e = loaded.engagement;
      const { workpaper, contentHash } = await this.gateGuard(trx, gate, e, actor);
      if (reauthed && reauthed.contentHash !== contentHash) {
        throw new AppError(409, 'The workpaper changed after you started signing; review it again, then sign', 'CONTENT_CHANGED');
      }
      // The signed content must be in the workpaper's history (verify checks it); this is a no-op when it already is.
      await recordWorkpaperRevisions(trx, e);
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
      const closed = await closeGate(trx, gateId, action === 'approve' ? 'approved' : 'rejected', signatureId, comment);
      await wakeWaitingRuns(trx, e.id);
      return closed;
    });
  }
```

- [ ] **Step 5: Send gate signing requests to `signGate`**

In `backend/src/signing/flow.ts` `completeSigning`, replace the Task 1 `if (intent.subjectKind !== 'finding' …)` guard and the `try { await svc.signOff(…) }` call with:

```ts
  const proof = { contentHash: intent.contentHash, reauthMethod: reauth.method, reauthAt: reauth.at, intentId: intent.id };
  try {
    if (intent.subjectKind === 'workpaper' && intent.gateId && intent.action !== 'review') {
      await svc.signGate(intent.gateId, intent.action, intent.comment, actor, proof);
    } else if (intent.subjectKind === 'finding' && intent.findingId) {
      await svc.signOff(intent.engagementId, intent.findingId, intent.action, intent.comment, actor, {}, proof);
    } else {
      return failIntent(svc, intent, actor, 'INTERNAL', 'This signing request names nothing to sign.', CLAIMED);
    }
  } catch (err) {
```

The existing `catch` body stays unchanged.

In `backend/src/signing/routes.ts`, add after the finding `sign-intents` route:

```ts
  // A scope, RCM or report gate the agent opened (agent spec §4.3). Rejecting needs a reason: the agent redrafts from it.
  r.post('/api/gates/:gateId/sign-intents', readers, wrap(async (req, res) => {
    const body = z.object({ action: z.enum(['approve', 'reject']), comment: z.string().max(2000).default('') }).parse(req.body);
    if (body.action === 'reject' && !body.comment.trim()) throw new AppError(400, 'Say why you are rejecting this workpaper: the agent redrafts it from your comment');
    const actor = actorOf(req);
    const gateId = String(req.params.gateId);
    const { engagementId, workpaper, contentHash } = await svc.checkGateSignOff(gateId, actor);
    const method = reauthMethodFor(req.auth!.user.issuer);
    if (!method) throw new AppError(409, 'No way to re-authenticate is configured for your account; ask your administrator', 'REAUTH_REQUIRED');
    const intent = await createIntent(db, { userId: actor.id, engagementId, gateId, workpaper, action: body.action, comment: body.comment, contentHash });
    res.status(201).json({ intentId: intent.id, reauthUrl: `/auth/sign/${intent.id}`, method, expiresAt: intent.expiresAt });
  }));
```

In `backend/src/app.ts`, after `app.post('/api/engagements/:id/findings/:fid/sign-intents', limits.signing);`, add:

```ts
  app.post('/api/gates/:gateId/sign-intents', limits.signing);
```

- [ ] **Step 6: Teach `verify` about workpaper signatures and gates**

In `backend/src/ops/verify.ts` `checkSignatures`:
- Add after `const bundles = …`:

```ts
  const workpaperHistory = new Set(
    (await db.selectFrom('workpaper_revisions').select(['engagement_id', 'kind', 'content_hash']).execute()).map((r) => `${r.engagement_id}|${r.kind}|${r.content_hash}`),
  );
```

- Make the first statement inside `for (const s of rows) {`:

```ts
    if (s.subject_kind === 'workpaper') {
      const label = `Signature ${s.id} (${s.workpaper} gate ${s.gate_id})`;
      if (!workpaperHistory.has(`${s.engagement_id}|${s.workpaper}|${s.content_hash}`)) problems.push(`${label}: the signed content is not in the workpaper's history`);
      const b = bundles.get(s.trail_bundle_id);
      const out = b?.output as { signatureId?: string; gateId?: string; contentHash?: string; userId?: string; meaning?: string } | undefined;
      if (!b) problems.push(`${label}: its trail entry ${s.trail_bundle_id} is missing`);
      else if (
        b.moduleId !== 'human:gate-sign' || b.engagementId !== s.engagement_id || out?.signatureId !== s.id || out?.gateId !== s.gate_id ||
        out?.contentHash !== s.content_hash || out?.userId !== s.user_id || out?.meaning !== s.meaning
      ) problems.push(`${label}: does not match its trail entry`);
      continue;
    }
```

- In the `for (const b of trail)` loop, add after the existing `human:sign-off` check:

```ts
    if (b.moduleId === 'human:gate-sign' && out?.signatureId && !rowIds.has(out.signatureId)) {
      problems.push(`Trail entry ${b.id} records gate signature ${out.signatureId}, but the signature row is missing`);
    }
```

- Add before the engagements loop:

```ts
  // Every decided gate names a signature that exists, made on the content the gate showed.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const decided = await db.selectFrom('gates').select(['id', 'state', 'signature_id', 'subject_hash']).where('state', 'in', ['approved', 'rejected']).orderBy('seq').execute();
  for (const g of decided) {
    const sig = g.signature_id ? byId.get(g.signature_id) : undefined;
    if (!sig) problems.push(`Gate ${g.id} is ${g.state}, but its signature ${g.signature_id ?? '(none)'} is missing`);
    else if (sig.content_hash !== g.subject_hash) problems.push(`Gate ${g.id}: signature ${sig.id} is for different content than the gate showed`);
  }
```

- [ ] **Step 7: Run the tests and the type check**

Run: `npm test -- tests/gates.test.ts tests/signing-http.test.ts tests/signing-service.test.ts tests/signing-oidc.test.ts tests/verify.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add backend/src/service.ts backend/src/signing/flow.ts backend/src/signing/routes.ts backend/src/app.ts backend/src/ops/verify.ts backend/tests/http.ts backend/tests/gates.test.ts
git commit -m "feat(agents): Part 11 gate signatures for scope, RCM and report; finding gates close with approval

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Agent config, budget, graph input and the executor

**Files:**
- Create: `backend/src/agents/config.ts`
- Create: `backend/src/agents/budget.ts`
- Create: `backend/src/agents/state.ts`
- Create: `backend/src/agents/executor.ts`
- Test: `backend/tests/executor.test.ts`

**Interfaces:**
- Consumes: `AgentPort` and `agentPort` (Task 6); `insertGate`, `listGates`, `supersedeGate` (Task 5); `appendStep`, `listSteps`, `AgentRun` (Task 5); `reviewSubject`, `draftTestPlans` (Task 4); `redraftBasis`, `latestGateId` (Task 3); `subjectInfo` (Task 3).
- Produces (`config.ts`): `AgentConfig { enabled; budget; qaThreshold; pollMs; concurrency; leaseMs; heartbeatMs }`, `loadAgentConfig(env?)`, `defaultAgentConfig()`, `LEASE_MS`, `HEARTBEAT_MS`.
- Produces (`budget.ts`): `budgetProblem(budget, spent, estimate?): string | null` (its reason starts with `budget_exhausted`), `addSpend(a, b)`, `lowerBudget(ceiling, requested?)`.
- Produces (`state.ts`): `DelegateRecord`, `reconcileGates(db, e): Promise<number>`, `loadGraphInput(db, run, e, gates, qaThreshold): Promise<GraphInput>`.
- Produces (`executor.ts`): `ExecutorContext`, `Outcome`, `applyDecision(ctx, decision): Promise<Outcome>`.

**Step records:**

| Action | Step kind | Step contents | Trail entry |
|---|---|---|---|
| delegate / rework | `delegate` (agent `specialist:<name>`) | `DelegateRecord { action, basis, sinceGateId, bundleId }` | the specialist's own module or `agent:test-plans` bundle |
| request_qa | `qa` (agent `qa`) | the `QaReport` | `agent:qa` |
| open_gate | `tool_call` (agent `supervisor`) | `{ tool: 'open_gate', gateId, kind, subjectId, subjectHash, attempt }` | `agent:gate-open` |

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/executor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addSpend, budgetProblem, lowerBudget } from '../src/agents/budget';
import { defaultAgentConfig, loadAgentConfig } from '../src/agents/config';
import { applyDecision, type ExecutorContext } from '../src/agents/executor';
import { listGates } from '../src/agents/gate-repo';
import { agentPort } from '../src/agents/port';
import { RULES_VERSION } from '../src/agents/policy/rules';
import { createRun, listSteps } from '../src/agents/run-repo';
import { loadGraphInput, reconcileGates } from '../src/agents/state';
import { rootBasis } from '../src/agents/subjects';
import type { Action, QaReport } from '../src/agents/types';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

async function setup() {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  const run = await createRun(svc.db.kysely, { engagementId: e.id, startedBy: 'auditor', policy: 'rules', policyVersion: RULES_VERSION, budget: defaultAgentConfig().budget });
  /** Applies one action the way the worker does, against the engagement as it is now. */
  const apply = async (action: Action, qa: QaReport | null = null) => {
    const ctx: ExecutorContext = {
      db: svc.db.kysely, port: agentPort(svc), run, starter: auditor, engagement: await svc.engagement(e.id),
      gates: await listGates(svc.db.kysely, e.id), menu: { stage: 'scope', actions: [action], qa, qaThreshold: 70 },
    };
    return applyDecision(ctx, { action, rationale: 'test', policy: 'rules', policyVersion: RULES_VERSION });
  };
  const steps = () => listSteps(svc.db.kysely, run.id);
  return { svc, e, run, apply, steps };
}

describe('the executor', () => {
  it('delegates through the agent port and records what the redraft was built from [REQ-28]', async () => {
    const { svc, e, run, apply, steps } = await setup();
    expect(await apply({ type: 'delegate', specialist: 'scope', subjectKey: 'scope' })).toEqual({ next: 'continue' });
    const [step] = await steps();
    expect(step).toMatchObject({ kind: 'delegate', agent: 'specialist:scope', decision: { action: { type: 'delegate', subjectKey: 'scope' }, basis: rootBasis(e), sinceGateId: null } });
    const bundle = (await readTrail(svc.db.kysely, e.id)).find((b) => b.id === step.trailBundleId)!;
    expect(bundle).toMatchObject({ moduleId: 'scope', actor: 'agent:scope', inputs: { runId: run.id, onBehalfOf: 'auditor' } });
  });

  it('records each QA review as a step and in the trail [REQ-28]', async () => {
    const { svc, e, apply, steps } = await setup();
    await apply({ type: 'delegate', specialist: 'scope', subjectKey: 'scope' });
    await apply({ type: 'request_qa', subjectKey: 'scope', mode: 'review' });
    const qa = (await steps()).at(-1)!;
    expect(qa).toMatchObject({ kind: 'qa', agent: 'qa', decision: { subjectKey: 'scope', reviewer: 'deterministic-1' } });
    expect((await readTrail(svc.db.kysely, e.id)).find((b) => b.id === qa.trailBundleId)).toMatchObject({ moduleId: 'agent:qa', actor: 'agent:qa', output: qa.decision });
  });

  it('opens a gate with its QA report attached, then waits for the signature [REQ-27]', async () => {
    const { svc, e, apply, steps } = await setup();
    await apply({ type: 'delegate', specialist: 'scope', subjectKey: 'scope' });
    await apply({ type: 'request_qa', subjectKey: 'scope', mode: 'review' });
    const report = (await steps()).at(-1)!.decision as QaReport;
    expect(await apply({ type: 'open_gate', subjectKey: 'scope' }, report)).toEqual({ next: 'waiting', reason: 'awaiting scope gate signature' });
    expect(await listGates(svc.db.kysely, e.id)).toMatchObject([{ kind: 'scope', state: 'open', attempt: 1, qaReport: report }]);
    const opened = (await steps()).at(-1)!;
    expect(opened).toMatchObject({ kind: 'tool_call', agent: 'supervisor', decision: { tool: 'open_gate', kind: 'scope' } });
    expect((await readTrail(svc.db.kysely, e.id)).find((b) => b.id === opened.trailBundleId)!.moduleId).toBe('agent:gate-open');
  });

  it('drafts test plans as the test-plan agent', async () => {
    const { svc, e, apply } = await setup();
    await svc.runModule(e.id, 'scope', auditor);
    await svc.runModule(e.id, 'rcm', auditor);
    await apply({ type: 'delegate', specialist: 'test-plan', subjectKey: 'test_plans' });
    const after = await svc.engagement(e.id);
    expect(Object.keys(after.testPlans).sort()).toEqual(after.rcm.map((r) => r.id).sort());
    expect((await readTrail(svc.db.kysely, e.id)).at(-1)).toMatchObject({ moduleId: 'agent:test-plans', actor: 'agent:test-plan' });
  });

  it("turns wait, escalate and complete into the run's next status", async () => {
    const { apply } = await setup();
    expect(await apply({ type: 'wait', reason: 'awaiting test results for 3 control(s)' })).toEqual({ next: 'waiting', reason: 'awaiting test results for 3 control(s)' });
    expect(await apply({ type: 'escalate', reason: 'gate_rejected_twice: scope' })).toEqual({ next: 'needs_human', reason: 'gate_rejected_twice: scope' });
    expect(await apply({ type: 'complete' })).toEqual({ next: 'completed' });
  });

  it('feeds QA reports and redrafts back to the graph, and supersedes a gate whose subject changed', async () => {
    const { svc, e, run, apply, steps } = await setup();
    await apply({ type: 'delegate', specialist: 'scope', subjectKey: 'scope' });
    await apply({ type: 'request_qa', subjectKey: 'scope', mode: 'review' });
    await apply({ type: 'open_gate', subjectKey: 'scope' }, (await steps()).at(-1)!.decision as QaReport);
    const now = await svc.engagement(e.id);
    const input = await loadGraphInput(svc.db.kysely, run, now, await listGates(svc.db.kysely, e.id), 70);
    expect(input.qa).toHaveLength(1);
    expect(input.redrafts).toEqual([{ subjectKey: 'scope', kind: 'delegate', basis: rootBasis(e), sinceGateId: null }]);
    expect(await reconcileGates(svc.db.kysely, now)).toBe(0);
    const first = now.scope[0];
    const edited = await svc.setScope(e.id, [{ controlId: first.controlId, included: !first.included }], auditor);
    expect(await reconcileGates(svc.db.kysely, edited)).toBe(1);
    expect((await listGates(svc.db.kysely, e.id))[0].state).toBe('superseded');
  });
});

describe('budgets [REQ-29]', () => {
  const budget = { maxSteps: 2, maxTokens: 100, maxCostUsd: 1 };
  const spent = { steps: 1, tokensIn: 40, tokensOut: 40, costUsd: 0.5 };

  it('stop a run before the step, tokens or cost it cannot afford', () => {
    expect(budgetProblem(budget, spent)).toBeNull();
    expect(budgetProblem(budget, { ...spent, steps: 2 })).toBe('budget_exhausted: 2 steps');
    expect(budgetProblem(budget, spent, { tokensIn: 30 })).toBe('budget_exhausted: 100 tokens');
    expect(budgetProblem(budget, spent, { costUsd: 0.6 })).toBe('budget_exhausted: $1');
    expect(addSpend(spent, { steps: 1, costUsd: 0.25 })).toEqual({ steps: 2, tokensIn: 40, tokensOut: 40, costUsd: 0.75 });
  });

  it('may be lowered by the starter, never raised', () => {
    const ceiling = defaultAgentConfig().budget;
    expect(lowerBudget(ceiling, { maxSteps: 20 })).toEqual({ ...ceiling, maxSteps: 20 });
    expect(() => lowerBudget(ceiling, { maxSteps: ceiling.maxSteps + 1 })).toThrow(/may not exceed/);
    expect(() => lowerBudget(ceiling, { maxCostUsd: 0 })).toThrow(/greater than 0/);
  });
});

describe('agent configuration [REQ-25]', () => {
  it('defaults to the spec’s values and validates overrides', () => {
    expect(defaultAgentConfig()).toEqual({
      enabled: true, budget: { maxSteps: 200, maxTokens: 2_000_000, maxCostUsd: 25 }, qaThreshold: 70, pollMs: 3000, concurrency: 2, leaseMs: 60_000, heartbeatMs: 15_000,
    });
    expect(loadAgentConfig({ AGENT_ENABLED: 'false' }).enabled).toBe(false);
    expect(() => loadAgentConfig({ AGENT_QA_THRESHOLD: '101' })).toThrow(/AGENT_QA_THRESHOLD/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/executor.test.ts`
Expected: FAIL. The modules do not exist.

- [ ] **Step 3: Write `config.ts` and `budget.ts`**

Create `backend/src/agents/config.ts`:

```ts
import { z } from 'zod';
import type { Budget } from './types';

// Agent settings (spec §6), from the environment and validated at start-up like every other setting (REQ-25).

export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;

export interface AgentConfig {
  /** AGENT_ENABLED=false is the kill switch: no new runs, and workers lease nothing. */
  enabled: boolean;
  /** A run's default budget, and the most its starter may ask for. */
  budget: Budget;
  qaThreshold: number;
  pollMs: number;
  concurrency: number;
  leaseMs: number;
  heartbeatMs: number;
}

const Env = z.object({
  AGENT_ENABLED: z.enum(['true', 'false']).default('true'),
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).default(200),
  AGENT_MAX_TOKENS: z.coerce.number().int().min(1).default(2_000_000),
  AGENT_MAX_COST_USD: z.coerce.number().positive().default(25),
  AGENT_QA_THRESHOLD: z.coerce.number().int().min(0).max(100).default(70),
  AGENT_POLL_MS: z.coerce.number().int().min(100).default(3000),
  AGENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
});

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const v = parsed.data;
  return {
    enabled: v.AGENT_ENABLED === 'true',
    budget: { maxSteps: v.AGENT_MAX_STEPS, maxTokens: v.AGENT_MAX_TOKENS, maxCostUsd: v.AGENT_MAX_COST_USD },
    qaThreshold: v.AGENT_QA_THRESHOLD,
    pollMs: v.AGENT_POLL_MS,
    concurrency: v.AGENT_WORKER_CONCURRENCY,
    leaseMs: LEASE_MS,
    heartbeatMs: HEARTBEAT_MS,
  };
}

export const defaultAgentConfig = (): AgentConfig => loadAgentConfig({});
```

Create `backend/src/agents/budget.ts`:

```ts
import { AppError } from '../errors';
import type { Budget, Spent } from './types';

// Run budgets (spec §6.1). Checked before every iteration and before every model call, so a run never starts a step
// it cannot pay for.

/** Why the run may not take another step, or null. */
export function budgetProblem(budget: Budget, spent: Spent, estimate: Partial<Spent> = {}): string | null {
  if (spent.steps + 1 > budget.maxSteps) return `budget_exhausted: ${budget.maxSteps} steps`;
  const tokens = spent.tokensIn + spent.tokensOut + (estimate.tokensIn ?? 0) + (estimate.tokensOut ?? 0);
  if (tokens > budget.maxTokens) return `budget_exhausted: ${budget.maxTokens} tokens`;
  if (spent.costUsd + (estimate.costUsd ?? 0) > budget.maxCostUsd) return `budget_exhausted: $${budget.maxCostUsd}`;
  return null;
}

export function addSpend(a: Spent, b: Partial<Spent>): Spent {
  return {
    steps: a.steps + (b.steps ?? 0),
    tokensIn: a.tokensIn + (b.tokensIn ?? 0),
    tokensOut: a.tokensOut + (b.tokensOut ?? 0),
    costUsd: Math.round((a.costUsd + (b.costUsd ?? 0)) * 1e6) / 1e6,
  };
}

/** A run's budget: the configured one, lowered where its starter asked. Raising it is an audit manager's call, later. */
export function lowerBudget(ceiling: Budget, requested: Partial<Budget> = {}): Budget {
  const out: Budget = {
    maxSteps: requested.maxSteps ?? ceiling.maxSteps,
    maxTokens: requested.maxTokens ?? ceiling.maxTokens,
    maxCostUsd: requested.maxCostUsd ?? ceiling.maxCostUsd,
  };
  for (const k of ['maxSteps', 'maxTokens', 'maxCostUsd'] as const) {
    if (!(out[k] > 0)) throw new AppError(400, `${k} must be greater than 0`);
    if (out[k] > ceiling[k]) throw new AppError(400, `${k} may not exceed ${ceiling[k]}; an audit manager can raise a run's budget once it has started`);
  }
  return out;
}
```

- [ ] **Step 4: Write `state.ts`**

Create `backend/src/agents/state.ts`:

```ts
import type { Executor } from '../db/trail-repo';
import type { Engagement } from '../engine/types';
import { listGates, supersedeGate, type Gate } from './gate-repo';
import { listSteps, type AgentRun } from './run-repo';
import { subjectInfo } from './subjects';
import type { Action, GraphInput, QaReport, RedraftRecord } from './types';

/** What a delegate step records, so later iterations know what was redrafted, from what, and since which gate. */
export interface DelegateRecord {
  action: Extract<Action, { type: 'delegate' | 'rework' }>;
  basis: string;
  sinceGateId: string | null;
  bundleId: string;
}

/** Supersedes each open gate whose subject changed, vanished or was rebuilt on a new basis since it opened. Returns how many. */
export async function reconcileGates(db: Executor, e: Engagement): Promise<number> {
  let superseded = 0;
  for (const g of await listGates(db, e.id)) {
    if (g.state !== 'open') continue;
    const s = subjectInfo(e, g.subjectKey);
    if (s && s.subjectId === g.subjectId && s.hash === g.subjectHash && s.basis === g.basisHash) continue;
    await supersedeGate(db, g.id);
    superseded++;
  }
  return superseded;
}

/** The graph's input for one iteration: the engagement, its gates, and this run's QA reports and redrafts. */
export async function loadGraphInput(db: Executor, run: AgentRun, e: Engagement, gates: Gate[], qaThreshold: number): Promise<GraphInput> {
  const steps = await listSteps(db, run.id);
  const qa = steps.filter((s) => s.kind === 'qa').map((s) => s.decision as QaReport);
  const redrafts: RedraftRecord[] = steps
    .filter((s) => s.kind === 'delegate')
    .map((s) => {
      const d = s.decision as DelegateRecord;
      return { subjectKey: d.action.subjectKey, kind: d.action.type, basis: d.basis, sinceGateId: d.sinceGateId };
    });
  return { engagement: e, gates, qa, redrafts, qaThreshold };
}
```

- [ ] **Step 5: Write `executor.ts`**

Create `backend/src/agents/executor.ts`:

```ts
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema';
import { appendTrail } from '../db/trail-repo';
import type { Engagement, User } from '../engine/types';
import { insertGate, type Gate } from './gate-repo';
import { latestGateId, redraftBasis } from './graph';
import type { AgentPort } from './port';
import { reviewSubject } from './qa/deterministic';
import { appendStep, type AgentRun } from './run-repo';
import { draftTestPlans } from './specialists/test-plan';
import type { DelegateRecord } from './state';
import { subjectInfo } from './subjects';
import type { Decision, Menu } from './types';

// Carries out one decision (spec §5.1, step 5). Specialists go through the AgentPort; QA reviews and gates are
// written here, each step together with its trail entry.

export interface ExecutorContext {
  db: Kysely<DB>;
  port: AgentPort;
  run: AgentRun;
  /** The person who started the run: the agent acts on their behalf. */
  starter: User;
  engagement: Engagement;
  gates: Gate[];
  menu: Menu;
}

export type Outcome =
  | { next: 'continue' }
  | { next: 'waiting'; reason: string }
  | { next: 'needs_human'; reason: string }
  | { next: 'completed' };

export async function applyDecision(ctx: ExecutorContext, decision: Decision): Promise<Outcome> {
  const { db, port, run, starter, engagement: e } = ctx;
  const a = decision.action;
  const event = (moduleId: string, agent: string, inputs: Record<string, unknown>, output: unknown) =>
    port.agentBundle(e, { moduleId, agent, runId: run.id, onBehalfOf: starter.id, inputs, output });

  switch (a.type) {
    case 'delegate':
    case 'rework': {
      const basis = redraftBasis(e, a.subjectKey, a.rows);
      const sinceGateId = latestGateId(ctx.gates, a.subjectKey);
      const acting = { runId: run.id, agent: a.specialist, startedBy: starter };
      const started = Date.now();
      const { bundle } = a.specialist === 'test-plan'
        ? await port.saveTestPlans(e.id, draftTestPlans(e), acting, { expectedVersion: e.version! })
        : await port.runModule(e.id, a.specialist, acting, { expectedVersion: e.version!, rows: a.rows });
      const record: DelegateRecord = { action: a, basis, sinceGateId, bundleId: bundle.id };
      await appendStep(db, run.id, {
        kind: 'delegate', agent: `specialist:${a.specialist}`, decision: record, model: bundle.provider.model,
        durationMs: Date.now() - started, trailBundleId: bundle.id,
      });
      return { next: 'continue' };
    }
    case 'request_qa': {
      const report = reviewSubject(e, a.subjectKey);
      await db.transaction().execute(async (trx) => {
        const sealed = await appendTrail(trx, event('agent:qa', 'qa', { subjectKey: a.subjectKey, mode: a.mode }, report));
        await appendStep(trx, run.id, { kind: 'qa', agent: 'qa', decision: report, model: report.reviewer, trailBundleId: sealed.id });
      });
      return { next: 'continue' };
    }
    case 'open_gate': {
      const s = subjectInfo(e, a.subjectKey);
      const kind = s?.gateKind;
      if (!s || !kind) throw new Error(`${a.subjectKey} has no gate`);
      const qa = ctx.menu.qa?.subjectKey === s.key && ctx.menu.qa.subjectHash === s.hash ? ctx.menu.qa : null;
      await db.transaction().execute(async (trx) => {
        const gate = await insertGate(trx, {
          engagementId: e.id, runId: run.id, kind, subjectKey: s.key, subjectId: s.subjectId, subjectHash: s.hash, basisHash: s.basis, qaReport: qa,
        });
        const opened = { gateId: gate.id, kind, subjectId: gate.subjectId, subjectHash: gate.subjectHash, attempt: gate.attempt };
        const sealed = await appendTrail(trx, event('agent:gate-open', 'supervisor', { subjectKey: s.key }, opened));
        await appendStep(trx, run.id, { kind: 'tool_call', agent: 'supervisor', decision: { tool: 'open_gate', ...opened }, trailBundleId: sealed.id });
      });
      return { next: 'waiting', reason: `awaiting ${kind} gate signature` };
    }
    case 'wait':
      return { next: 'waiting', reason: a.reason };
    case 'escalate':
      return { next: 'needs_human', reason: a.reason };
    case 'complete':
      return { next: 'completed' };
  }
}
```

- [ ] **Step 6: Run the tests and the type check**

Run: `npm test -- tests/executor.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/agents/config.ts backend/src/agents/budget.ts backend/src/agents/state.ts backend/src/agents/executor.ts backend/tests/executor.test.ts
git commit -m "feat(agents): config, budgets, graph input and the decision executor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The worker

**Files:**
- Create: `backend/src/agents/worker.ts`
- Create: `backend/src/agents/worker-cli.ts`
- Modify: `backend/package.json` (script `"worker": "tsx src/agents/worker-cli.ts"`)
- Test: `backend/tests/worker.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–8.
- Produces: `chooseDecision(policy: Policy, menu: Menu): Promise<Decision>`, and `class AgentWorker(svc, cfg, opts?: { id?: string; policy?: Policy })` with `id`, `tick(): Promise<'idle' | 'worked'>`, `drain(maxTicks?): Promise<number>`, `start()` and `stop()`.

**One tick** (spec §5.1, §6):
1. Lease one due run, with a heartbeat every 15 s.
2. Inside `runWithRequestId(run.id)`:
   - A requested cancel → supersede the open gates → `cancelled`.
   - A requested pause → `waiting` / `paused_by_user`.
   - Budget exceeded → `needs_human`.
   - The starter is no longer an active preparer → `needs_human`.
   - Otherwise:
     1. Load the engagement and reconcile gates.
     2. Build the graph input and compute the menu.
     3. Decide.
     4. Append the `decision` step and its `agent:decision` trail entry.
     5. Apply the decision and map the outcome to a status.
3. Release the run with its next status and spend.

**Failures:**
- `VERSION_CONFLICT` → `runnable`. On the 3rd in a row → `waiting`, reason `engagement being edited`, `wakeAt = now + 60 s`.
- `AGENT_FORBIDDEN` → a `tool_call` step from agent `rails` with `{ refused }`, then `needs_human`, reason `agent_forbidden: <message>`.
- Engagement gone → `failed`.
- Anything else → `runnable`. On the 3rd in a row → `needs_human`, reason `error: <message>`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/worker.test.ts`:

```ts
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { defaultAgentConfig, type AgentConfig } from '../src/agents/config';
import { listGates } from '../src/agents/gate-repo';
import { RULES_VERSION } from '../src/agents/policy/rules';
import { createRun, getRun, leaseNext, listSteps, markRunnable, requestCancel, requestPause } from '../src/agents/run-repo';
import type { Action, Menu, Policy } from '../src/agents/types';
import { AgentWorker, chooseDecision } from '../src/agents/worker';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { AppError } from '../src/errors';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig => ({ ...defaultAgentConfig(), ...over });

async function started(budget = defaultAgentConfig().budget) {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  const run = await createRun(svc.db.kysely, { engagementId: e.id, startedBy: 'auditor', policy: 'rules', policyVersion: RULES_VERSION, budget });
  return { svc, e, run, db: svc.db.kysely, worker: new AgentWorker(svc, cfg(), { id: 'w1' }) };
}

describe('the agent worker', () => {
  it('takes a new engagement offline to its scope gate, recording every decision in the trail [REQ-26, REQ-28]', async () => {
    const { e, run, db, worker } = await started();
    expect(await worker.drain()).toBeGreaterThan(2);
    const after = (await getRun(db, run.id))!;
    expect(after).toMatchObject({ status: 'waiting', statusReason: 'awaiting scope gate signature', leaseOwner: null });
    const steps = await listSteps(db, run.id);
    const decisions = steps.filter((s) => s.kind === 'decision');
    expect(decisions).toHaveLength(after.spent.steps);
    expect(steps.map((s) => s.kind)).toEqual(expect.arrayContaining(['decision', 'delegate', 'qa', 'tool_call']));
    const trail = await readTrail(db, e.id);
    for (const d of decisions) {
      expect(trail.find((b) => b.id === d.trailBundleId)).toMatchObject({ moduleId: 'agent:decision', actor: 'agent:supervisor', requestId: run.id });
    }
    expect(await listGates(db, e.id)).toMatchObject([{ kind: 'scope', state: 'open' }]);
  });

  it('does nothing while agents are switched off [REQ-29]', async () => {
    const { svc, db, run } = await started();
    expect(await new AgentWorker(svc, cfg({ enabled: false })).tick()).toBe('idle');
    expect((await getRun(db, run.id))!.status).toBe('runnable');
  });

  it('stops at its step budget and hands the run to a person [REQ-29]', async () => {
    const { db, run, worker } = await started({ maxSteps: 2, maxTokens: 1000, maxCostUsd: 1 });
    await worker.drain();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'needs_human', statusReason: 'budget_exhausted: 2 steps' });
    expect((await listSteps(db, run.id)).filter((s) => s.kind === 'decision')).toHaveLength(2);
  });

  it('lets another worker pick up a run whose worker died, without repeating a step', async () => {
    const { svc, db, run, worker } = await started();
    await worker.tick();
    expect(await leaseNext(db, 'dead-worker', 60_000)).toMatchObject({ id: run.id });
    const second = new AgentWorker(svc, cfg(), { id: 'w2' });
    expect(await second.tick()).toBe('idle');
    await sql`UPDATE agent_runs SET lease_until = now() - interval '1 second' WHERE id = ${run.id}`.execute(db);
    expect(await second.tick()).toBe('worked');
    const seqs = (await listSteps(db, run.id)).map((s) => s.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('backs off for a minute after three edit conflicts in a row', async () => {
    const { svc, db, run, worker } = await started();
    vi.spyOn(svc, 'runModuleAsAgent').mockRejectedValue(new AppError(409, 'changed meanwhile', 'VERSION_CONFLICT'));
    await worker.tick();
    await worker.tick();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'runnable', conflictStreak: 2 });
    await worker.tick();
    const r = (await getRun(db, run.id))!;
    expect(r).toMatchObject({ status: 'waiting', statusReason: 'engagement being edited', conflictStreak: 0 });
    expect(Date.parse(r.wakeAt!) - Date.now()).toBeGreaterThan(50_000);
    expect(await worker.tick()).toBe('idle');
  });

  it('hands the run to a person after three failed steps in a row', async () => {
    const { svc, db, run, worker } = await started();
    vi.spyOn(svc, 'runModuleAsAgent').mockRejectedValue(new Error('model endpoint unreachable'));
    await worker.drain();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'needs_human', statusReason: 'error: model endpoint unreachable' });
  });

  it('stops and asks a person when the rails refuse an action [REQ-27]', async () => {
    const { svc, db, run, worker } = await started();
    vi.spyOn(svc, 'runModuleAsAgent').mockRejectedValue(new AppError(403, 'An agent may not sign', 'AGENT_FORBIDDEN'));
    await worker.tick();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'needs_human', statusReason: 'agent_forbidden: An agent may not sign' });
    expect((await listSteps(db, run.id)).at(-1)).toMatchObject({ kind: 'tool_call', agent: 'rails', decision: { refused: 'An agent may not sign' } });
  });

  it('honours a cancel that arrives mid-step, and takes no further step', async () => {
    const { svc, db, run, worker } = await started();
    const original = svc.runModuleAsAgent.bind(svc);
    vi.spyOn(svc, 'runModuleAsAgent').mockImplementationOnce(async (...args) => {
      await requestCancel(db, run.id);
      return original(...args);
    });
    await worker.tick();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'runnable', cancelRequested: true });
    const before = (await listSteps(db, run.id)).length;
    await worker.tick();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'cancelled', statusReason: 'cancelled_by_user' });
    expect(await listSteps(db, run.id)).toHaveLength(before);
    expect(await worker.tick()).toBe('idle');
  });

  it('leaves a paused run alone until it is resumed', async () => {
    const { db, run, worker } = await started();
    await requestPause(db, run.id);
    expect(await worker.tick()).toBe('idle');
    await markRunnable(db, run.id);
    expect(await worker.tick()).toBe('worked');
  });

  it('hands the run to a person when its starter can no longer prepare audit work', async () => {
    const { db, run, worker } = await started();
    await sql`UPDATE users SET role = 'viewer' WHERE id = 'auditor'`.execute(db);
    await worker.tick();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'needs_human', statusReason: expect.stringMatching(/can no longer prepare/) });
  });
});

describe('choosing a decision', () => {
  const gate: Action = { type: 'open_gate', subjectKey: 'scope' };
  const escalate: Action = { type: 'escalate', reason: 'QA found issues' };
  const menu: Menu = {
    stage: 'scope', actions: [gate, escalate], qaThreshold: 70,
    qa: { subjectKey: 'scope', subjectHash: 'h', mode: 'review', reviewer: 't', score: 90, issues: [] },
  };
  const rogue: Policy = {
    kind: 'llm', version: 'rogue-1',
    decide: async () => ({ action: { type: 'complete' }, rationale: 'Skip the gates', policy: 'llm', policyVersion: 'rogue-1' }),
  };

  it('falls back to the rules when a policy picks an action the graph does not allow [REQ-26]', async () => {
    const d = await chooseDecision(rogue, menu);
    expect(d).toMatchObject({ action: gate, policy: 'rules' });
    expect(d.rationale).toMatch(/not allowed/);
  });

  it('asks no policy when only one action is allowed [REQ-26]', async () => {
    expect(await chooseDecision(rogue, { ...menu, actions: [escalate] })).toMatchObject({ action: escalate, policy: 'forced', policyVersion: 'rogue-1' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/worker.test.ts`
Expected: FAIL. `Cannot find module '../src/agents/worker'`.

- [ ] **Step 3: Write the worker**

Create `backend/src/agents/worker.ts`:

```ts
import crypto from 'node:crypto';
import os from 'node:os';
import { PREPARER_ROLES } from '../auth/roles';
import { getUser } from '../auth/user-repo';
import { appendTrail } from '../db/trail-repo';
import type { User } from '../engine/types';
import { AppError } from '../errors';
import { runWithRequestId } from '../observability/context';
import { logger } from '../observability/log';
import type { AuditService } from '../service';
import { addSpend, budgetProblem } from './budget';
import type { AgentConfig } from './config';
import { applyDecision, type Outcome } from './executor';
import { listGates, supersedeOpenGates } from './gate-repo';
import { allowedActions } from './graph';
import { RulesPolicy } from './policy/rules';
import { agentPort, type AgentPort } from './port';
import { appendStep, leaseNext, releaseRun, renewLease, type AgentRun, type RunUpdate } from './run-repo';
import { loadGraphInput, reconcileGates } from './state';
import { DecisionSchema, sameAction, type Decision, type Menu, type Policy } from './types';

// The agent worker (spec §2, §6). One tick leases one due run, takes one step of its loop, and hands the run back with
// its next status. Everything is derived again from the database each tick, so a worker that dies loses at most one
// uncommitted step, and another worker picks the run up once the lease runs out.

const CONFLICT_BACKOFF_MS = 60_000;
const MAX_STREAK = 3;

/** The decision for this menu: forced when one action is allowed, else the policy's, else (off the menu) the rules'. */
export async function chooseDecision(policy: Policy, menu: Menu): Promise<Decision> {
  if (menu.actions.length === 1) return { action: menu.actions[0], rationale: 'The only allowed action', policy: 'forced', policyVersion: policy.version };
  const parsed = DecisionSchema.safeParse(await policy.decide(menu));
  if (parsed.success && menu.actions.some((a) => sameAction(a, parsed.data.action))) return parsed.data;
  const fallback = await new RulesPolicy().decide(menu);
  return { ...fallback, rationale: `${fallback.rationale} (the ${policy.kind} policy chose an action that is not allowed)`.slice(0, 500) };
}

const statusOf = (o: Outcome): Pick<RunUpdate, 'status' | 'reason'> =>
  o.next === 'continue' ? { status: 'runnable' } : o.next === 'completed' ? { status: 'completed' } : { status: o.next, reason: o.reason };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface WorkerOptions {
  id?: string;
  policy?: Policy;
}

export class AgentWorker {
  readonly id: string;
  private readonly policy: Policy;
  private readonly port: AgentPort;
  private stopping = false;
  private loops: Promise<void>[] = [];

  constructor(private readonly svc: AuditService, private readonly cfg: AgentConfig, opts: WorkerOptions = {}) {
    this.id = opts.id ?? `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    this.policy = opts.policy ?? new RulesPolicy();
    this.port = agentPort(svc);
  }

  /** Leases one due run and takes one step of it. 'idle' when switched off or nothing is due. */
  async tick(): Promise<'idle' | 'worked'> {
    if (!this.cfg.enabled) return 'idle';
    const db = this.svc.db.kysely;
    const run = await leaseNext(db, this.id, this.cfg.leaseMs);
    if (!run) return 'idle';
    const heartbeat = setInterval(() => {
      renewLease(db, run.id, this.id, this.cfg.leaseMs).catch((err) => logger.warn({ err, runId: run.id }, 'agent lease renewal failed'));
    }, this.cfg.heartbeatMs);
    try {
      const update = await runWithRequestId(run.id, () => this.iterate(run));
      if (!(await releaseRun(db, run.id, this.id, update))) logger.warn({ runId: run.id }, 'agent run lease was lost before the step was handed back');
    } finally {
      clearInterval(heartbeat);
    }
    return 'worked';
  }

  /** Ticks until nothing is due (tests, and one-off runs from the command line). */
  async drain(maxTicks = 1000): Promise<number> {
    let ticks = 0;
    while (ticks < maxTicks && (await this.tick()) === 'worked') ticks++;
    return ticks;
  }

  /** Polls in the background with `concurrency` loops. */
  start(): void {
    this.stopping = false;
    for (let i = 0; i < this.cfg.concurrency; i++) {
      this.loops.push((async () => {
        while (!this.stopping) {
          const result = await this.tick().catch((err) => {
            logger.error({ err }, 'agent worker tick failed');
            return 'idle' as const;
          });
          if (result === 'idle' && !this.stopping) await sleep(this.cfg.pollMs);
        }
      })());
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.loops.splice(0));
  }

  private async iterate(run: AgentRun): Promise<RunUpdate> {
    const db = this.svc.db.kysely;
    if (run.cancelRequested) {
      await supersedeOpenGates(db, run.id);
      return { status: 'cancelled', reason: 'cancelled_by_user' };
    }
    if (run.pauseRequested) return { status: 'waiting', reason: 'paused_by_user', pauseHandled: true };
    const over = budgetProblem(run.budget, run.spent);
    if (over) return { status: 'needs_human', reason: over };
    try {
      const record = await getUser(db, run.startedBy);
      if (!record?.active || !record.role || !PREPARER_ROLES.includes(record.role)) {
        return { status: 'needs_human', reason: 'the person who started this run can no longer prepare audit work; start a new run' };
      }
      const starter: User = { id: record.id, name: record.name, role: record.role };
      const e = await this.svc.engagement(run.engagementId);
      await reconcileGates(db, e);
      const gates = await listGates(db, e.id);
      const menu = allowedActions(await loadGraphInput(db, run, e, gates, this.cfg.qaThreshold));
      const decision = await chooseDecision(this.policy, menu);
      const spent = addSpend(run.spent, { steps: 1 });
      await db.transaction().execute(async (trx) => {
        const sealed = await appendTrail(trx, this.port.agentBundle(e, {
          moduleId: 'agent:decision', agent: 'supervisor', runId: run.id, onBehalfOf: starter.id,
          provider: { id: decision.policy, model: decision.policyVersion }, inputs: { stage: menu.stage, menu: menu.actions }, output: decision,
        }));
        await appendStep(trx, run.id, { kind: 'decision', agent: 'supervisor', decision, model: decision.policyVersion, trailBundleId: sealed.id });
      });
      const outcome = await applyDecision({ db, port: this.port, run, starter, engagement: e, gates, menu }, decision);
      return { ...statusOf(outcome), spent, failureStreak: 0, conflictStreak: 0 };
    } catch (err) {
      return this.failed(run, err);
    }
  }

  private async failed(run: AgentRun, err: unknown): Promise<RunUpdate> {
    if (err instanceof AppError && err.code === 'VERSION_CONFLICT') {
      const streak = run.conflictStreak + 1;
      if (streak < MAX_STREAK) return { status: 'runnable', conflictStreak: streak };
      return { status: 'waiting', reason: 'engagement being edited', wakeAt: new Date(Date.now() + CONFLICT_BACKOFF_MS), conflictStreak: 0 };
    }
    if (err instanceof AppError && err.code === 'AGENT_FORBIDDEN') {
      logger.warn({ runId: run.id, refused: err.message }, 'agent action refused by the rails');
      await appendStep(this.svc.db.kysely, run.id, { kind: 'tool_call', agent: 'rails', decision: { refused: err.message } });
      return { status: 'needs_human', reason: `agent_forbidden: ${err.message}` };
    }
    if (err instanceof AppError && err.status === 404 && err.message.startsWith(`Engagement ${run.engagementId} `)) {
      return { status: 'failed', reason: `engagement ${run.engagementId} no longer exists` };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ runId: run.id, err }, 'agent run step failed');
    const streak = run.failureStreak + 1;
    if (streak < MAX_STREAK) return { status: 'runnable', failureStreak: streak };
    return { status: 'needs_human', reason: `error: ${message}`.slice(0, 500), failureStreak: streak };
  }
}
```

- [ ] **Step 4: Write the process entry point**

Create `backend/src/agents/worker-cli.ts`:

```ts
import { loadCitationPolicy, loadConfig, prepareEnv } from '../config';
import { connectPg } from '../db';
import { pendingMigrations } from '../db/migrate';
import { createProvider } from '../engine/llm/router';
import { loadBundles } from '../knowledge/okf/bundle';
import { prepareRegistry } from '../knowledge/packs';
import { instrumentProvider } from '../observability/llm';
import { logger, setLogLevel } from '../observability/log';
import { AuditService } from '../service';
import { loadAgentConfig } from './config';
import { AgentWorker } from './worker';

// The agent worker process: same image as the API, started with `node dist/agents/worker-cli.js` (npm run worker).
// It connects as the API's database role and never migrates.

async function main() {
  prepareEnv();
  const config = loadConfig();
  const citationPolicy = loadCitationPolicy();
  const agents = loadAgentConfig();
  setLogLevel(config.logLevel);
  const db = connectPg(config.databaseUrl, { ssl: config.databaseSsl, max: agents.concurrency + 2 });
  const pending = await pendingMigrations(db);
  if (pending.length) {
    await db.close();
    throw new Error(`Database has unapplied migrations (${pending.join(', ')}). Run "npm run migrate" first; the worker never migrates.`);
  }
  const registry = await prepareRegistry(db, loadBundles(config.packsDir), { production: process.env.NODE_ENV === 'production', log: (line) => logger.info(line) });
  const svc = new AuditService(db, registry, instrumentProvider(createProvider()), { citationPolicy });
  const worker = new AgentWorker(svc, agents);
  if (!agents.enabled) logger.warn('AGENT_ENABLED=false: this worker takes no agent runs');
  worker.start();
  logger.info(`Agent worker ${worker.id}: ${agents.concurrency} loop(s), polling every ${agents.pollMs} ms, provider ${svc.providerInfo.id}/${svc.providerInfo.model}`);
  const shutdown = async () => {
    logger.info('Agent worker stopping');
    await worker.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

In `backend/package.json` `scripts`, add after `"start"`:

```json
    "worker": "tsx src/agents/worker-cli.ts",
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npm test -- tests/worker.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add backend/src/agents/worker.ts backend/src/agents/worker-cli.ts backend/package.json backend/tests/worker.test.ts
git commit -m "feat(agents): leased worker that runs one step per tick, with backoff, escalation and cancel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Run lifecycle and HTTP API

**Files:**
- Create: `backend/src/agents/runs.ts`
- Create: `backend/src/agents/routes.ts`
- Modify: `backend/src/http-util.ts` (`ifMatch`)
- Modify: `backend/src/app.ts` (`OpsOptions.agents`, mount `agentRoutes`, use `ifMatch`)
- Modify: `backend/src/server.ts` (load the agent config and pass it to the app)
- Test: `backend/tests/agents-http.test.ts`

**Interfaces:**
- Consumes: the run-repo transitions (Task 5); `lowerBudget` and `AgentConfig` (Task 8); `editTestPlan` (Task 6); `listGates` (Task 5).
- Produces (`runs.ts`): `startRun(svc, cfg, engagementId, actor, budget?): Promise<{ run: AgentRun; warnings: string[] }>`, `pauseRun`, `resumeRun`, `cancelRun`, `raiseBudget`.
- Produces (`routes.ts`): `agentRoutes(svc, cfg)`.
- Produces (`http-util.ts`): `ifMatch(req): MutationOptions`.
- Produces (`app.ts`): `OpsOptions.agents?: AgentConfig`.

**Endpoints** (spec §7.1; trail module IDs `human:agent-run-{start,pause,resume,cancel,budget}`):

| Method and path | Role | Effect |
|---|---|---|
| `POST /api/engagements/:id/runs` | preparer | body `{ budget?: Partial<Budget> }` → 201 `{ run, warnings }` |
| `GET /api/engagements/:id/runs` | read roles | list runs |
| `GET /api/runs/:runId?afterSeq=&limit=` | read roles | `{ run, steps }`; `limit` ≤ 500, default 200 |
| `POST /api/runs/:runId/pause`, `/resume`, `/cancel` | preparer | change the run's state |
| `POST /api/runs/:runId/budget` | audit_manager | body: a full `Budget`, each value ≥ the current one |
| `GET /api/engagements/:id/gates` | read roles | list gates |
| `GET /api/engagements/:id/test-plans` | read roles | test plans |
| `PUT /api/engagements/:id/test-plans/:rowId` | preparer | `If-Match` honoured; unknown fields → 400 |

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/agents-http.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { defaultAgentConfig, type AgentConfig } from '../src/agents/config';
import { draftTestPlans } from '../src/agents/specialists/test-plan';
import { AgentWorker } from '../src/agents/worker';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { auditor as auditorUser, NEW_ENGAGEMENT, newService } from './helpers';
import { devAuthConfig, signIn } from './http';

async function setup(agents: AgentConfig = defaultAgentConfig()) {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const app = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { agents });
  const auditor = await signIn(app, 'auditor');
  const id = (await auditor.post('/api/engagements', NEW_ENGAGEMENT).expect(201)).body.id as string;
  return { svc, app, auditor, id, worker: new AgentWorker(svc, agents, { id: 'w-http' }) };
}

describe('agent runs over HTTP', () => {
  it('start one run per engagement, for preparers only, and record who started it [REQ-26]', async () => {
    const { svc, app, auditor, id } = await setup();
    const started = await auditor.post(`/api/engagements/${id}/runs`, {}).expect(201);
    expect(started.body).toMatchObject({ run: { status: 'runnable', startedBy: 'auditor', policy: 'rules' }, warnings: [] });
    const again = await auditor.post(`/api/engagements/${id}/runs`, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('RUN_ACTIVE');
    expect((await (await signIn(app, 'viewer')).post(`/api/engagements/${id}/runs`, {})).status).toBe(403);
    expect((await readTrail(svc.db.kysely, id)).at(-1)).toMatchObject({ moduleId: 'human:agent-run-start', actor: 'auditor', output: { runId: started.body.run.id } });
  });

  it('are refused while agents are switched off [REQ-29]', async () => {
    const { auditor, id } = await setup({ ...defaultAgentConfig(), enabled: false });
    const res = await auditor.post(`/api/engagements/${id}/runs`, {});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AGENT_DISABLED');
  });

  it('take a lower budget from their starter, never a higher one [REQ-29]', async () => {
    const { auditor, id } = await setup();
    expect((await auditor.post(`/api/engagements/${id}/runs`, { budget: { maxSteps: 100_000 } })).status).toBe(400);
    expect((await auditor.post(`/api/engagements/${id}/runs`, { budget: { maxSteps: 5 } }).expect(201)).body.run.budget.maxSteps).toBe(5);
  });

  it('warn an audit manager who starts one that they cannot sign its first gates', async () => {
    const { app, id } = await setup();
    const manager = await signIn(app, 'reviewer');
    const res = await manager.post(`/api/engagements/${id}/runs`, {}).expect(201);
    expect(res.body.warnings).toEqual(['You started this run, so you cannot sign its scope or RCM gates. 0 other active audit manager(s) can.']);
  });

  it('show their steps and gates, and can be paused, resumed and cancelled [REQ-28]', async () => {
    const { svc, app, auditor, id, worker } = await setup();
    const run = (await auditor.post(`/api/engagements/${id}/runs`, {}).expect(201)).body.run;
    await worker.drain();
    const shown = (await auditor.get(`/api/runs/${run.id}`).expect(200)).body;
    expect(shown.run).toMatchObject({ status: 'waiting', statusReason: 'awaiting scope gate signature' });
    expect(shown.steps.length).toBeGreaterThan(2);
    expect((await auditor.get(`/api/runs/${run.id}?afterSeq=2`).expect(200)).body.steps[0].seq).toBe(3);
    expect((await auditor.get(`/api/engagements/${id}/runs`).expect(200)).body.map((r: { id: string }) => r.id)).toEqual([run.id]);
    expect((await auditor.get(`/api/engagements/${id}/gates`).expect(200)).body).toMatchObject([{ kind: 'scope', state: 'open' }]);
    expect((await (await signIn(app, 'viewer')).post(`/api/runs/${run.id}/pause`)).status).toBe(403);
    expect((await auditor.post(`/api/runs/${run.id}/pause`).expect(200)).body).toMatchObject({ status: 'waiting', statusReason: 'paused_by_user' });
    expect((await auditor.post(`/api/runs/${run.id}/resume`).expect(200)).body.status).toBe('runnable');
    expect((await auditor.post(`/api/runs/${run.id}/cancel`).expect(200)).body.status).toBe('cancelled');
    expect((await auditor.post(`/api/runs/${run.id}/cancel`)).status).toBe(409);
    expect((await auditor.get(`/api/engagements/${id}/gates`)).body[0].state).toBe('superseded');
    expect((await readTrail(svc.db.kysely, id)).map((b) => b.moduleId)).toEqual(expect.arrayContaining([
      'human:agent-run-start', 'human:agent-run-pause', 'human:agent-run-resume', 'human:agent-run-cancel',
    ]));
  });

  it('let an audit manager raise the budget of a run that ran out, which then resumes [REQ-29]', async () => {
    const { app, auditor, id, worker } = await setup();
    const run = (await auditor.post(`/api/engagements/${id}/runs`, { budget: { maxSteps: 1 } }).expect(201)).body.run;
    await worker.drain();
    expect((await auditor.get(`/api/runs/${run.id}`)).body.run).toMatchObject({ status: 'needs_human', statusReason: 'budget_exhausted: 1 steps' });
    const raised = { maxSteps: 50, maxTokens: run.budget.maxTokens, maxCostUsd: run.budget.maxCostUsd };
    expect((await auditor.post(`/api/runs/${run.id}/budget`, raised)).status).toBe(403);
    const manager = await signIn(app, 'reviewer');
    expect((await manager.post(`/api/runs/${run.id}/budget`, { ...raised, maxSteps: 0 })).status).toBe(400);
    expect((await manager.post(`/api/runs/${run.id}/budget`, raised).expect(200)).body).toMatchObject({ status: 'runnable', budget: raised });
  });
});

describe('test plans over HTTP', () => {
  it('let an auditor record a reason not to test a row, with the usual version check', async () => {
    const { svc, app, auditor, id } = await setup();
    await auditor.post(`/api/engagements/${id}/modules/scope/run`).expect(200);
    await auditor.post(`/api/engagements/${id}/modules/rcm/run`).expect(200);
    const e = await svc.engagement(id);
    await svc.saveTestPlansAsAgent(id, draftTestPlans(e), { runId: 'AR-http', agent: 'test-plan', startedBy: auditorUser }, { expectedVersion: e.version! });
    const rowId = e.rcm[0].id;
    expect((await auditor.get(`/api/engagements/${id}/test-plans`).expect(200)).body[rowId].rowId).toBe(rowId);
    expect((await (await signIn(app, 'viewer')).put(`/api/engagements/${id}/test-plans/${rowId}`, { notTestedJustification: 'x' })).status).toBe(403);
    expect((await auditor.put(`/api/engagements/${id}/test-plans/${rowId}`, { rowHash: 'forged' })).status).toBe(400);
    const stale = await auditor.agent.put(`/api/engagements/${id}/test-plans/${rowId}`).set('x-csrf-token', auditor.csrf).set('If-Match', '"1"').send({ notTestedJustification: 'Retired' });
    expect(stale.status).toBe(409);
    expect((await auditor.put(`/api/engagements/${id}/test-plans/${rowId}`, { notTestedJustification: 'Control retired in March' }).expect(200)).body)
      .toMatchObject({ notTestedJustification: 'Control retired in March', editedBy: 'auditor' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/agents-http.test.ts`
Expected: FAIL. `createApp` ignores `agents` and the routes answer 404.

- [ ] **Step 3: Move the `If-Match` helper into `http-util.ts`**

Replace `backend/src/http-util.ts` with:

```ts
import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errors';
import type { MutationOptions } from './service';

/** Forwards errors from async route handlers to the Express error middleware. */
export const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

/** `If-Match: "<version>"` opts a change into the optimistic-concurrency check. */
export function ifMatch(req: Request): MutationOptions {
  const header = req.header('if-match');
  if (header === undefined) return {};
  const version = Number(header.replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(version) || version < 1) throw new AppError(400, 'If-Match must be the engagement version number');
  return { expectedVersion: version };
}
```

In `backend/src/app.ts`:
- Delete the local `mutation` function and its doc comment.
- Change the `./http-util` import to `import { ifMatch, wrap } from './http-util';`.
- Replace each `mutation(req)` with `ifMatch(req)`.

- [ ] **Step 4: Write the run lifecycle**

Create `backend/src/agents/runs.ts`:

```ts
import { PREPARER_ROLES, REVIEWER_ROLES } from '../auth/roles';
import { appendTrail, type Executor } from '../db/trail-repo';
import type { User } from '../engine/types';
import { AppError } from '../errors';
import type { AuditService } from '../service';
import { lowerBudget } from './budget';
import type { AgentConfig } from './config';
import { RULES_VERSION } from './policy/rules';
import { createRun, getRun, markRunnable, requestCancel, requestPause, setRunBudget, type AgentRun } from './run-repo';
import type { Budget } from './types';

// What people do with agent runs (spec §4.6, §7.1). Each change is written to the trail with the run's new state.

function mayPrepare(actor: User) {
  if (!PREPARER_ROLES.includes(actor.role)) throw new AppError(403, `${actor.role} may not start or steer agent runs`);
}

/** An audit manager who starts a run cannot sign its scope or RCM gates (spec §4.3): say so, and say who can. */
async function starterWarnings(svc: AuditService, actor: User): Promise<string[]> {
  if (actor.role !== 'audit_manager') return [];
  const others = await svc.db.kysely
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('role', '=', 'audit_manager')
    .where('active', '=', true)
    .where('id', '<>', actor.id)
    .executeTakeFirstOrThrow();
  return [`You started this run, so you cannot sign its scope or RCM gates. ${Number(others.n)} other active audit manager(s) can.`];
}

export async function startRun(svc: AuditService, cfg: AgentConfig, engagementId: string, actor: User, requested?: Partial<Budget>) {
  mayPrepare(actor);
  if (!cfg.enabled) throw new AppError(503, 'Agent runs are switched off (AGENT_ENABLED=false)', 'AGENT_DISABLED');
  const e = await svc.engagement(engagementId);
  const budget = lowerBudget(cfg.budget, requested);
  const run = await svc.db.kysely.transaction().execute(async (trx) => {
    const created = await createRun(trx, { engagementId, startedBy: actor.id, policy: 'rules', policyVersion: RULES_VERSION, budget });
    await appendTrail(trx, svc.humanBundle(e, 'human:agent-run-start', actor, { budget }, { runId: created.id }));
    return created;
  });
  return { run, warnings: await starterWarnings(svc, actor) };
}

async function change(svc: AuditService, runId: string, actor: User, moduleId: string, fn: (db: Executor) => Promise<AgentRun>): Promise<AgentRun> {
  const run = await getRun(svc.db.kysely, runId);
  if (!run) throw new AppError(404, `Agent run ${runId} not found`);
  const e = await svc.engagement(run.engagementId);
  return svc.db.kysely.transaction().execute(async (trx) => {
    const updated = await fn(trx);
    await appendTrail(trx, svc.humanBundle(e, moduleId, actor, { runId }, { status: updated.status, statusReason: updated.statusReason, budget: updated.budget }));
    return updated;
  });
}

export async function pauseRun(svc: AuditService, runId: string, actor: User) {
  mayPrepare(actor);
  return change(svc, runId, actor, 'human:agent-run-pause', (db) => requestPause(db, runId));
}

export async function resumeRun(svc: AuditService, runId: string, actor: User) {
  mayPrepare(actor);
  return change(svc, runId, actor, 'human:agent-run-resume', (db) => markRunnable(db, runId));
}

export async function cancelRun(svc: AuditService, runId: string, actor: User) {
  mayPrepare(actor);
  return change(svc, runId, actor, 'human:agent-run-cancel', (db) => requestCancel(db, runId));
}

/** An audit manager raises a run's budget; a run stopped by its budget resumes. A budget is never lowered here. */
export async function raiseBudget(svc: AuditService, runId: string, actor: User, budget: Budget) {
  if (!REVIEWER_ROLES.includes(actor.role)) throw new AppError(403, `${actor.role} may not raise an agent run's budget`);
  return change(svc, runId, actor, 'human:agent-run-budget', async (db) => {
    const run = (await getRun(db, runId))!;
    for (const k of ['maxSteps', 'maxTokens', 'maxCostUsd'] as const) {
      if (budget[k] < run.budget[k]) throw new AppError(400, `A budget can only be raised: ${k} is already ${run.budget[k]}`);
    }
    return setRunBudget(db, runId, budget);
  });
}
```

- [ ] **Step 5: Write the routes, and mount them**

Create `backend/src/agents/routes.ts`:

```ts
import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorOf, requireRole } from '../auth/http';
import { READ_ROLES } from '../auth/roles';
import { AppError } from '../errors';
import { ifMatch, wrap } from '../http-util';
import type { AuditService } from '../service';
import type { AgentConfig } from './config';
import { listGates } from './gate-repo';
import { getRun, listRuns, listSteps } from './run-repo';
import { cancelRun, pauseRun, raiseBudget, resumeRun, startRun } from './runs';

const BudgetSchema = z.object({ maxSteps: z.number().int().positive(), maxTokens: z.number().int().positive(), maxCostUsd: z.number().positive() }).strict();

const TestPlanPatchSchema = z
  .object({
    attribute: z.string().min(1),
    population: z.string().min(1),
    sampleSize: z.number().int().min(0),
    selectionMethod: z.enum(['random', 'all', 'judgemental']),
    evidenceToRequest: z.array(z.string().min(1)),
    procedure: z.string().min(1),
    notTestedJustification: z.string().max(2000),
  })
  .partial()
  .strict();

/** Agent runs, gates and test plans (spec §7.1). Mounted under /api, so the session, CSRF and role gates in app.ts apply. */
export function agentRoutes(svc: AuditService, cfg: AgentConfig) {
  const r = Router();
  const readers = requireRole(READ_ROLES);
  const param = (req: Request, name: string) => String(req.params[name]);

  r.post('/api/engagements/:id/runs', readers, wrap(async (req, res) => {
    const body = z.object({ budget: BudgetSchema.partial().optional() }).strict().parse(req.body ?? {});
    res.status(201).json(await startRun(svc, cfg, param(req, 'id'), actorOf(req), body.budget));
  }));

  r.get('/api/engagements/:id/runs', readers, wrap(async (req, res) => {
    await svc.engagement(param(req, 'id'));
    res.json(await listRuns(svc.db.kysely, param(req, 'id')));
  }));

  r.get('/api/runs/:runId', readers, wrap(async (req, res) => {
    const run = await getRun(svc.db.kysely, param(req, 'runId'));
    if (!run) throw new AppError(404, 'Agent run not found');
    const page = z.object({ afterSeq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    res.json({ run, steps: await listSteps(svc.db.kysely, run.id, page) });
  }));

  r.post('/api/runs/:runId/pause', readers, wrap(async (req, res) => res.json(await pauseRun(svc, param(req, 'runId'), actorOf(req)))));
  r.post('/api/runs/:runId/resume', readers, wrap(async (req, res) => res.json(await resumeRun(svc, param(req, 'runId'), actorOf(req)))));
  r.post('/api/runs/:runId/cancel', readers, wrap(async (req, res) => res.json(await cancelRun(svc, param(req, 'runId'), actorOf(req)))));
  r.post('/api/runs/:runId/budget', readers, wrap(async (req, res) => {
    res.json(await raiseBudget(svc, param(req, 'runId'), actorOf(req), BudgetSchema.parse(req.body)));
  }));

  r.get('/api/engagements/:id/gates', readers, wrap(async (req, res) => {
    await svc.engagement(param(req, 'id'));
    res.json(await listGates(svc.db.kysely, param(req, 'id')));
  }));

  r.get('/api/engagements/:id/test-plans', readers, wrap(async (req, res) => res.json((await svc.engagement(param(req, 'id'))).testPlans)));
  r.put('/api/engagements/:id/test-plans/:rowId', readers, wrap(async (req, res) => {
    res.json(await svc.editTestPlan(param(req, 'id'), param(req, 'rowId'), TestPlanPatchSchema.parse(req.body), actorOf(req), ifMatch(req)));
  }));

  return r;
}
```

In `backend/src/app.ts`:
- Add `import { defaultAgentConfig, type AgentConfig } from './agents/config';` and `import { agentRoutes } from './agents/routes';`.
- Add to `OpsOptions`:

```ts
  /** Agent orchestration settings (AGENT_*); defaults when absent. */
  agents?: AgentConfig;
```

- After `app.use(documentRoutes(svc, storage));`, add:

```ts
  app.use(agentRoutes(svc, ops.agents ?? defaultAgentConfig()));
```

In `backend/src/server.ts`:
- Add `import { loadAgentConfig } from './agents/config';`.
- After `const { core: config, auth, storage, citationPolicy } = loadServerConfig();`, add `const agents = loadAgentConfig();`.
- Change the `createApp(…)` ops argument to `{ trustProxy: config.trustProxy, metricsToken: config.metricsToken, agents }`.
- Before `const svc = …`, add `if (!agents.enabled) logger.warn('AGENT_ENABLED=false: agent runs cannot be started');`.

- [ ] **Step 6: Run the tests and the type check**

Run: `npm test -- tests/agents-http.test.ts tests/api.test.ts tests/security.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add backend/src/agents/runs.ts backend/src/agents/routes.ts backend/src/http-util.ts backend/src/app.ts backend/src/server.ts backend/tests/agents-http.test.ts
git commit -m "feat(agents): HTTP API to start, inspect, pause, resume and cancel runs; gates and test plans

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: End-to-end evidence and the validation package

**Files:**
- Test: `backend/tests/agents-e2e.test.ts`
- Modify: `backend/tests/db-roles.test.ts` (agent work under the API role)
- Modify: `backend/validation/requirements.json` (REQ-26 to REQ-29)

**Interfaces:**
- Consumes: everything above; `devSign` and `devSignGate` (`tests/http.ts`).
- Produces: no new code. Evidence that the pieces work together, and the traceability rows.

- [ ] **Step 1: Write the end-to-end tests**

Create `backend/tests/agents-e2e.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { AgentWorker } from '../src/agents/worker';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { listSignatures } from '../src/db/signature-repo';
import { readTrail } from '../src/db/trail-repo';
import { verifyChain } from '../src/engine/trail';
import { verifyIntegrity } from '../src/ops/verify';
import { newService } from './helpers';
import { devAuthConfig, devSign, devSignGate, signIn } from './http';

type GateView = { id: string; kind: string; state: string; attempt: number };

/** A pharma engagement with an agent run started by the auditor, behind the real HTTP stack and an in-process worker. */
async function setup() {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const app = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { agents: defaultAgentConfig() });
  const worker = new AgentWorker(svc, defaultAgentConfig(), { id: 'w-e2e' });
  const auditor = await signIn(app, 'auditor');
  const manager = await signIn(app, 'reviewer');
  const cae = await signIn(app, 'approver');
  const id = (await auditor.post('/api/engagements', {
    name: 'Pharma self-inspection', entity: 'Demo Pharma', site: 'OSD plant', periodFrom: '2026-01-01', periodTo: '2026-06-30',
    auditType: 'GMP self-inspection', scopeStatement: 'Data integrity: HPLC audit trails and user access', packIds: ['pharma'],
  }).expect(201)).body.id as string;
  const run = (await auditor.post(`/api/engagements/${id}/runs`, {}).expect(201)).body.run as { id: string };
  const state = async () => (await auditor.get(`/api/runs/${run.id}`).expect(200)).body.run as { status: string; statusReason: string };
  const gates = async () => (await auditor.get(`/api/engagements/${id}/gates`).expect(200)).body as GateView[];
  const openGate = async (kind: string) => (await gates()).find((g) => g.kind === kind && g.state === 'open')!;
  return { svc, worker, auditor, manager, cae, id, run, state, gates, openGate };
}

describe('an agent run, end to end (offline)', () => {
  it('takes an engagement from scope to completion, stopping only for people [REQ-26, REQ-27, REQ-28]', async () => {
    const { svc, worker, auditor, manager, cae, id, run, state, openGate } = await setup();
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: 'awaiting scope gate signature' });
    expect((await devSignGate(manager, 'reviewer', (await openGate('scope')).id, 'approve')).status!.status).toBe('signed');
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: 'awaiting rcm gate signature' });
    expect((await devSignGate(manager, 'reviewer', (await openGate('rcm')).id, 'approve')).status!.status).toBe('signed');
    await worker.drain();
    const planned = (await auditor.get(`/api/engagements/${id}`).expect(200)).body;
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: `awaiting test results for ${planned.rcm.length} control(s)` });
    expect(Object.keys(planned.testPlans).sort()).toEqual(planned.rcm.map((r: { id: string }) => r.id).sort());

    // Field work is the auditor's: the HPLC audit-trail control (as in tests/http.ts draftFinding) fails, the others pass.
    expect(planned.rcm.map((r: { id: string }) => r.id)).toContain('PH-DI-01');
    for (const row of planned.rcm as { id: string }[]) {
      const failing = row.id === 'PH-DI-01';
      await auditor.put(`/api/engagements/${id}/tests/${row.id}`, {
        designAdequate: true, observation: failing ? 'Audit trail review missing for 5 of 20 sequences' : 'All 20 items reviewed',
        evidenceRefs: ['EV-1'], sampleTested: 20, exceptions: failing ? 5 : 0,
      }).expect(200);
    }
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: expect.stringMatching(/^awaiting finding gate signature/) });
    const finding = (await auditor.get(`/api/engagements/${id}`).expect(200)).body.findings[0];
    expect(finding.preparedBy).toEqual(['auditor']);
    expect((await devSign(manager, 'reviewer', id, finding.id, 'review')).status!.status).toBe('signed');
    expect((await devSign(cae, 'approver', id, finding.id, 'approve')).status!.status).toBe('signed');
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: 'awaiting report gate signature' });
    expect((await devSignGate(cae, 'approver', (await openGate('report')).id, 'approve')).status!.status).toBe('signed');
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'completed' });

    // Every agent action is in the chain as the agent's, on the starter's behalf; every signature is a person's.
    expect(verifyChain(await readTrail(svc.db.kysely)).valid).toBe(true);
    const agentEntries = (await readTrail(svc.db.kysely, id)).filter((b) => b.actor.startsWith('agent:'));
    expect(agentEntries.length).toBeGreaterThan(10);
    for (const b of agentEntries) expect(b.inputs).toMatchObject({ runId: run.id, onBehalfOf: 'auditor' });
    expect((await listSignatures(svc.db.kysely, id)).map((s) => s.userId).sort()).toEqual(['approver', 'approver', 'reviewer', 'reviewer', 'reviewer']);
    expect((await verifyIntegrity(svc.db.kysely, null)).signatures.problems).toEqual([]);
  });

  it('redrafts after a rejection, hands over when the redraft changes nothing, and again after a second rejection [REQ-26]', async () => {
    const { svc, worker, auditor, manager, id, run, state, openGate } = await setup();
    await worker.drain();
    await devSignGate(manager, 'reviewer', (await openGate('scope')).id, 'reject', 'Bring user-access reviews into scope');
    await worker.drain();
    // Offline, the scope specialist keeps every decision already made, so its redraft is the same scope: a person takes over.
    expect(await state()).toMatchObject({ status: 'needs_human', statusReason: expect.stringMatching(/^rework produced no change: scope/) });

    const last = (await svc.engagement(id)).scope.at(-1)!;
    await auditor.put(`/api/engagements/${id}/scope`, { items: [{ controlId: last.controlId, included: !last.included }] }).expect(200);
    await auditor.post(`/api/runs/${run.id}/resume`).expect(200);
    await worker.drain();
    expect(await openGate('scope')).toMatchObject({ attempt: 2 });
    await devSignGate(manager, 'reviewer', (await openGate('scope')).id, 'reject', 'Still missing user-access reviews');
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'needs_human', statusReason: 'gate_rejected_twice: scope' });
  });

  it('re-reviews a workpaper edited while a later gate is open, and supersedes that gate [REQ-26]', async () => {
    const { svc, worker, auditor, manager, id, state, gates, openGate } = await setup();
    await worker.drain();
    await devSignGate(manager, 'reviewer', (await openGate('scope')).id, 'approve');
    await worker.drain();
    const rcmGate = await openGate('rcm');
    const last = (await svc.engagement(id)).scope.at(-1)!;
    await auditor.put(`/api/engagements/${id}/scope`, { items: [{ controlId: last.controlId, included: !last.included }] }).expect(200);
    await worker.drain();
    expect((await gates()).find((g) => g.id === rcmGate.id)!.state).toBe('superseded');
    expect(await openGate('scope')).toMatchObject({ attempt: 2 });
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: 'awaiting scope gate signature' });
  });
});
```

- [ ] **Step 2: Run them**

Run: `npm test -- tests/agents-e2e.test.ts`
Expected: PASS. If the happy path stops elsewhere, read the failing run's steps (`GET /api/runs/:id`) before changing any code. A stop elsewhere is a defect in an earlier task: fix it there, with a test in that task's file.

- [ ] **Step 3: Run agent work under the API's database role**

In `backend/tests/db-roles.test.ts`:
- Extend the helpers import to `import { auditor, LENIENT, NEW_ENGAGEMENT, registry, reviewer, unattended } from './helpers';`.
- Add these imports:

```ts
import { defaultAgentConfig } from '../src/agents/config';
import { listGates } from '../src/agents/gate-repo';
import { RULES_VERSION } from '../src/agents/policy/rules';
import { createRun, getRun } from '../src/agents/run-repo';
import { AgentWorker } from '../src/agents/worker';
```

- Add inside the `describe` block:

```ts
  it('runs agent work as that role: runs, steps, gates and gate signatures [REQ-20, REQ-26]', async () => {
    const { api } = await asApiRole();
    const svc = new AuditService(api, registry, null, LENIENT);
    await ensureDevUsers(api.kysely);
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const run = await createRun(api.kysely, { engagementId: e.id, startedBy: 'auditor', policy: 'rules', policyVersion: RULES_VERSION, budget: defaultAgentConfig().budget });
    const worker = new AgentWorker(svc, defaultAgentConfig(), { id: 'w-api-role' });
    await worker.drain();
    const [gate] = await listGates(api.kysely, e.id);
    await svc.signGate(gate.id, 'approve', 'In scope as proposed', reviewer, unattended);
    await worker.drain();
    expect(await getRun(api.kysely, run.id)).toMatchObject({ status: 'waiting', statusReason: 'awaiting rcm gate signature' });
  }, 120_000);
```

Run: `npm test -- tests/db-roles.test.ts`
Expected: PASS.

- [ ] **Step 4: Add the requirements**

Append to the array in `backend/validation/requirements.json` (after REQ-25):

```json
  { "id": "REQ-26", "risk": "High", "text": "The agent can only take actions the engagement graph allows from the current state; no model output can skip a gate.", "evalKinds": [] },
  { "id": "REQ-27", "risk": "High", "text": "Gates are closed only by a human Part 11 signature bound to the subject's content; the agent never signs, records test results or edits reviewed findings.", "evalKinds": [] },
  { "id": "REQ-28", "risk": "High", "text": "Every agent decision is typed, attributed to the agent on behalf of its starter, and recorded in the hash-chained trail.", "evalKinds": [] },
  { "id": "REQ-29", "risk": "Medium", "text": "Runs stop at their budget, and the kill switch prevents new agent work.", "evalKinds": [] }
```

- [ ] **Step 5: Run everything CI runs**

Run: `npm run typecheck && npm test && npm run eval && npm run traceability`
Expected:
- type check: no errors;
- tests: all pass;
- eval: 25/25;
- traceability: 29/29 requirements covered, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add backend/tests/agents-e2e.test.ts backend/tests/db-roles.test.ts backend/validation/requirements.json
git commit -m "test(agents): end-to-end offline run, API-role run, and REQ-26 to REQ-29

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
