# Agent Orchestration 2C: UI and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent is ready for a pilot. People see each run, its steps and spend, and its gates with their QA reviews. They sign gates through the existing Part 11 pop-up and edit test plans next to the field work. Operators run the worker as its own container, with probes, metrics and run-tagged logs. `verify` covers agent work, and two pre-pilot spend fixes from the 2B review are in.

**Architecture:**
- **Spend fixes (carry-over).** The Anthropic provider sorts connection failures into two kinds. `ModelNotSentError` means nothing reached the API, and it is refunded. Any other failure is a `ModelTimeoutError`, which keeps its estimate charged. A `model_context_window_exceeded` stop is charged and not retried.
- **Metrics.** The worker counts each committed step once, after its iteration, while it still holds the lease. It counts step duration by kind, tokens and cost by agent and model, policy fallbacks, and guard refusals. The API reports runs by status from the database at each scrape.
- **Worker process.** `worker-cli.ts` serves `/healthz`, `/readyz` and `/metrics` on `WORKER_PORT` through the existing `probeRoutes`. Its log lines carry `runId` and `service: audit-worker`. Its settings are validated together, and production requires `METRICS_TOKEN`.
- **Verify.** A new `agents` section checks each agent step's trail entry: it must exist, lie inside the verified chain, and belong to the same run. The gate checks gain a cross-check that each signature belongs to its gate.
- **UI.** The engagement page gets a Run panel (status, spend, controls, step timeline, gates) and a Test plans tab, and the Findings tab shows each finding's open-gate QA report. All decision logic lives in pure modules (`agents.ts`, `signing.ts`), which are tested under node. Components only lay that logic out. Gate signing reuses the finding signing loop.
- **Operations.** Compose gets a `worker` service, CI checks the Compose file and the worker entry point, and the docs cover the worker Container App, the metrics, the alerts and the run-handling runbook.

**Tech Stack:** Node 22, TypeScript, Express 5, Kysely + Postgres 16, prom-client 15, pino 10, `@anthropic-ai/sdk` 0.131 (backend). React 18, MUI 5, react-router 6, Vite, vitest 5 in a node environment (frontend). Docker Compose, GitHub Actions. **No new dependencies** in either package.

**Spec:** `docs/superpowers/specs/2026-10-12-agent-orchestration-design.md`. 2C scope is in §10; this plan also implements §6.4, §7.1 (gaps only), §7.2 and §9 (`verify`). It builds on plans `2026-10-13-agents-2a-rails-runtime.md` and `2026-10-13-agents-2b-intelligence.md`, which are implemented in `backend/src/agents/`.

## Global Constraints

- **No new npm dependencies**, backend or frontend: no DOM testing library and no jsdom (Ruling 8). Code style follows the surrounding files: comment density, naming, plain-language comments, MUI `variant="outlined"` cards and `size="small"` chips as on the existing tabs.
- **Tests never call a real model.** Use `FakeProvider` and `noWait` from `backend/tests/helpers.ts` and a stubbed SDK client (`tests/anthropic-provider.test.ts`). Never use fake timers: they mix badly with Testcontainers.
- **Values copied from the spec:**
  - §6.4: "`/metrics` gains: runs by status, step duration histogram by kind, tokens and cost counters by agent and model, policy fallbacks, and executor guard refusals. Worker logs carry `runId`. `/healthz` and `/readyz` are added to the worker for its container."
  - §7.2: "status and reason; spent against budget; a step timeline with each decision's rationale, its policy, and any fallback; the open gate, with its QA score and issues, and Approve/Reject buttons that open the existing signing pop-up." "The **Test plans** tab shows the drafted plans and lets the auditor edit them next to the existing field-work form."
  - §9: "each agent step's trail bundle exists and is in the chain; each closed gate's signature matches the gate's subject hash; and no gate is `approved` without a signature."
  - §4.3 signers: scope and RCM gates `audit_manager`; report gate `cae`; finding gates through the existing finding signatures. The signer of a scope, RCM or report gate is never the run's `started_by`.
  - §6.3: lease 60 s, heartbeat 15 s. §6.2: `AGENT_POLL_MS` 3000.
  - §7.1 error codes: `RUN_ACTIVE` (409), `AGENT_DISABLED` (503), `GATE_STALE` (409). `AGENT_FORBIDDEN` is never returned to a user request.
- **Fixed values decided here** (see Rulings):

  | Setting | Value |
  |---|---|
  | `WORKER_PORT` (worker probes and metrics) | 3003 |
  | UI polling | 3 s while `running` or `runnable`; 15 s while `waiting` or `needs_human`; none once ended |
  | Steps per `GET /api/runs/:id` page | 500 (the server's maximum) |
  | Steps shown before "show all" | the last 50 |
  | Step duration buckets (s) | 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300 |
  | Compose `stop_grace_period` for the worker | 75 s (one lease, plus margin) |

- **Carried from 2A and 2B, unchanged:**
  - Lock order is engagement → run → gate, with the trail advisory lock last.
  - Every agent write is lease-fenced: `assertLease` runs inside the writing transaction.
  - The rails (§5.4) hold whatever a model says.
  - Agent trail bundles have actor `agent:<name>`, with `runId` and `onBehalfOf` in their inputs.
- **Signing is reused, never reimplemented.**
  - Gates are signed through `POST /api/gates/:id/sign-intents` and the same pop-up, polling and cancel loop as findings (`frontend/src/signing.ts`).
  - Finding gates close through the existing finding buttons.
- **Metric label values are bounded:** step kinds, agent names, model ids, fixed reason words. Never a run, engagement, gate or user id, and never a tool name a model supplied.
- **Requirement tags:** tests carry existing ids in their `it(` titles where one applies (`[REQ-24]` verify, `[REQ-25]` configuration, `[REQ-28]` agent records). No new requirement ids.
- **Commands:**
  - Backend, from `backend/`: `npm test -- <files>` needs Docker (Testcontainers). `npm run typecheck` covers only `src/`, so every backend task also runs the test files it touches.
  - Frontend, from `frontend/`: `npm run typecheck && npm test && npm run build`. The type check also compiles the backend types the UI imports.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Implementer subagents use their own model's name.
- **No Gartner material** anywhere in code, copy, docs or the repo.

## Rulings on the spec (decided here, confirm at plan review)

1. **What 2A already built for §7.1 and §9, and what this plan adds.**
   - Every §7.1 endpoint exists (`backend/src/agents/routes.ts`, `backend/src/signing/routes.ts`). Test plans are edited per row (`PUT /api/engagements/:id/test-plans/:rowId`), not as one `PUT`; the UI uses that route as it is.
   - The only new endpoint is `GET /api/agents/settings` (readers). The UI needs to know whether runs can start (`enabled`), the budget ceiling a starter may lower (`budget`), the QA threshold for the below-threshold cue (`qaThreshold`), and the policy (`llm` or `rules`). These do not go on the public `/api/health`.
   - Two of the three §9 checks exist: decided gates are checked for a signature on the gate's subject hash, and an approved gate with no signature is reported. This plan adds the agent-step check and folds in 2A review M7 (each signature belongs to its gate) as the third.
2. **The worker serves its own probes and metrics.**
   - prom-client keeps one registry per process, and every §6.4 metric except runs by status happens in the worker. So the worker serves `/healthz`, `/readyz` and `/metrics` on `WORKER_PORT` (default 3003, so it can share a host with the API on 3002), through the same `probeRoutes`.
   - Readiness checks the database and whether the worker is stopping: it fails once shutdown starts. Storage reads `not configured`, which does not fail readiness.
   - `loadWorkerConfig` validates the core, citation and agent settings together with `WORKER_PORT`, and requires `METRICS_TOKEN` in production as the API does. It does not ask for sign-in or file-storage settings.
3. **Runs by status come from the API only.** The `audit_agent_runs{status}` gauge is set from `agent_runs` at each scrape of the API's `/metrics`, and is never set by the worker, so the two scrape targets never report it twice. Each status always has a value; a status with no runs reads 0.
4. **Step metrics are counted from committed steps, in one place.**
   - After each tick, and while it still holds the lease, the worker lists the steps its iteration committed. It observes them only if it then hands the run back successfully, so a rolled-back write, or a step another worker wrote after a takeover, is never counted.
   - From those steps it counts duration by `kind`, tokens and cost by `agent` and `model`, policy fallbacks, and refusals. A fallback is a decision with `policy: 'rules'` that has model attempts, labelled by the last attempt's outcome. A refusal is labelled `source="rails"` for the executor guards (§5.4) or `source="model_request"` for a lookup a model asked for and was refused.
   - Decision, QA and tool steps now record `durationMs`; before this plan, only delegate steps did.
   - Spend charged in an iteration that then failed is in the run's `spent`, and in the existing `audit_llm_tokens_total` (the worker's provider is instrumented), but not in the per-agent counters.
5. **Worker logs carry `runId`.**
   - The worker runs each iteration under `runForAgentRun(runId)`. Every log line inside it carries `runId`, and `requestId` set to the same value, as trail bundles already do.
   - Log lines name their process with `service: audit-api` or `service: audit-worker`, set by `setLogService`.
6. **`verify` on agent work.**
   - A `decision`, `delegate` or `qa` step must name a trail entry. Bookkeeping `tool_call` steps (a worker's takeover note, a refusal by the rails) may name none.
   - Any entry a step names must exist, lie before any break in the chain, and be an agent's entry (`actor` `agent:*`) for the same run (`inputs.runId`) and engagement.
   - On gates: a decided gate's signature must carry the decision's meaning and belong to that gate (`gate_id` and `workpaper` for a workpaper gate, `finding_id` for a finding gate). A gate nobody decided may not name a signature.
   - The report gains `agents: { checked, problems }`, and `ok` requires it to be clean.
7. **2A review M5 is folded in.** `startRun` never fails a run that was already created because counting the other signers failed: it logs, and returns no warning.
8. **No DOM testing dependency.**
   - The frontend's tests are pure TypeScript under `environment: 'node'` (`vite.config.ts`). This plan keeps it that way.
   - Every judgement goes into tested pure functions: poll cadence, status wording and next action, spend rows, step descriptions and fallbacks, gate signer eligibility, budget and test-plan validation, step paging, and when to reload the engagement.
   - Components only lay those out, and are covered by `tsc`, `vite build` and the manual check in Task 11.
9. **Gate signing reuses the finding signing loop.**
   - `signWithReauth`'s request, pop-up, poll and cancel loop becomes one internal `followSigning`. `signGateWithReauth` calls it with `POST /gates/:id/sign-intents`.
   - The `CONTENT_CHANGED` message names what changed ("The finding…" or "The workpaper…"), and `api.ts` gets plain-language messages for `AGENT_DISABLED`, `RUN_ACTIVE`, `GATE_STALE` and `RUN_NOT_ACTIVE`.
   - Reject needs a comment, because the agent redrafts from it. The button stays disabled until there is one.
10. **Finding gates are signed where findings are.**
    - The Run panel lists an open finding gate with its QA report and a button to the Findings tab.
    - The finding's card shows that gate's QA report as it is. The browser cannot compute the finding hash; the server checks it at sign-intent time, and `reconcileGates` supersedes a gate whose finding changed.
11. **Test plans: a tab, and the plan beside each field-work form.**
    - A **Test plans** tab between RCM and Fieldwork shows and edits every plan.
    - Each Fieldwork row shows its plan read-only above the existing form.
    - The tab reloads the engagement after each save, because the route returns the plan, not the engagement.
    - The copy says that only a person can decide a control will not be tested, and that this lets a waiting run move on.
12. **Polling, since there is no push channel.**
    - The panel polls at the cadence in Global Constraints and fetches only steps after the last one seen, page by page.
    - New `delegate` steps mean the agent changed the engagement, so the page reloads it. Otherwise the person's next save would be refused as stale.
    - Refreshes are serialised, so a poll and a button press never append the same steps twice.
13. **Presentation of 2A and 2B deferred minors.**
    - Budget copy says an iteration usually writes two or more steps (2A M4).
    - Superseded gates are counted, not listed (2B T10).
    - A gate whose QA score is below the threshold, opened because no issue was blocking, is flagged to the signer (2B minor 3).
14. **Connection failures (2B re-review carry-over).**
    - The SDK puts the socket error under fetch's `TypeError` as `cause`, and an `AggregateError` can hold several.
    - The provider walks the cause chain. Only when every code says the request never got through is the failure a `ModelNotSentError`, which is refunded and retried. Those codes are `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, and the TLS and certificate codes (`ERR_TLS_*`, `ERR_SSL_*`, `CERT_*`, `UNABLE_TO_*`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`).
    - Every other connection error, including one with no cause, becomes a `ModelTimeoutError`, which is charged at its estimate and retried. That is an over-count at most.
    - `model_context_window_exceeded` is a `ModelStoppedError`: charged at its usage, not retried.
15. **The worker container.**
    - The worker uses the same image, run as `node dist/agents/worker-cli.js`. It has its own Compose service and Azure Container App, and connects as the API's login (`audit_api`).
    - It gets the same `ALLOW_UNVERIFIED_CITATIONS`, `LLM_PROVIDER` and `AGENT_*` settings as the API.
    - Compose overrides the image's healthcheck to port 3003.
    - CI validates the Compose file and checks that the worker entry point is in the image.
16. **Not folded in** (no 2C code touches them):
    - 2A M2 (an RCM rebuild clears test results), M3 (steps for supersessions and escalations), M6 (an error code for a deleted engagement).
    - 2B T1 minor 8 (a pause hides the takeover note), the `asData` whitespace variants, and the pricing of malformed answers by the model asked for.

## Review Focus

- **A run with more than 500 steps.** Expected: the timeline loads every page, not just the first 500, and later polls fetch only what is new. Pinned in Task 6 (`loads every step after the last one seen, page by page`).
- **A worker that loses its run mid-iteration.** Expected: it counts none of that iteration's steps in the metrics, so a step the next worker writes is never counted twice. Pinned in Task 2 (`counts nothing from an iteration whose worker lost the run before handing it back`).
- **A model that names an absurd tool in a lookup.** Expected: the refusal is counted under `source="model_request"`, and the tool name never becomes a metric label. Pinned in Task 2 (`count refusals by the rails apart from refused model lookups`).
- **Junk in the budget dialog: empty, negative, fractional iterations, above the ceiling, or below the current budget when raising.** Expected: a plain message, and the submit button disabled. Pinned in Task 6 (`checks a budget a person typed`).
- **A "reason not to test" that is only spaces.** Expected: it is saved as no reason, and the control still counts as awaiting field work. Pinned in Task 6 (`turns a test-plan form into the changes to send`).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `backend/src/engine/llm/provider.ts` | `ModelNotSentError`; `ModelStoppedError` reason `model_context_window_exceeded` | 1 |
| `backend/src/engine/llm/anthropic.ts` | connection-error classification, context-window stop | 1 |
| `backend/src/agents/llm/models.ts` | comment on what is refunded | 1 |
| `backend/src/observability/metrics.ts` | agent metric definitions | 2 |
| `backend/src/agents/metrics.ts` | `observeSteps`, `fallbackReason`, `refreshRunGauge` | 2 |
| `backend/src/agents/run-repo.ts` | `lastStepSeq` | 2 |
| `backend/src/agents/worker.ts` | step metrics after each tick, decision duration; run context for logs | 2, 3 |
| `backend/src/agents/executor.ts` | QA and gate-opening durations | 2 |
| `backend/src/agents/tools/toolbox.ts` | tool-call durations | 2 |
| `backend/src/observability/probes.ts` | `agentRuns` gauge refresh; `extraChecks` | 2, 3 |
| `backend/src/app.ts` | API reports runs by status | 2 |
| `backend/src/observability/context.ts` | `runForAgentRun`, `currentContext` | 3 |
| `backend/src/observability/log.ts` | `service` and `runId` on every line; `setLogService` | 3 |
| `backend/src/config.ts` | `loadWorkerConfig` | 3 |
| `backend/src/agents/worker-server.ts` | worker probe and metrics app | 3 |
| `backend/src/agents/worker-cli.ts` | worker settings, probe server, shutdown | 3 |
| `backend/src/ops/verify.ts`, `backend/src/db/cli.ts` | agent-step and gate cross-checks | 4 |
| `backend/src/agents/routes.ts`, `backend/src/agents/runs.ts` | `GET /api/agents/settings`; M5 | 5 |
| `frontend/src/types.ts`, `frontend/src/api.ts` | agent types; plain-language agent errors | 6 |
| `frontend/src/agents.ts` | agent API client and every UI judgement, pure | 6 |
| `frontend/src/signing.ts` | shared signing loop; `signGateWithReauth` | 7 |
| `frontend/src/components/engagement/useAgentRun.ts` | polling hook | 8 |
| `frontend/src/components/engagement/RunPanel.tsx`, `StepTimeline.tsx` | Run panel, budget dialogs, timeline | 8, 9 |
| `frontend/src/pages/EngagementPage.tsx` | panel, tab props, Test plans tab | 8, 9, 10 |
| `frontend/src/components/engagement/QaReportView.tsx`, `GateList.tsx` | QA report and gate signing | 9 |
| `frontend/src/components/engagement/FindingsTab.tsx` | open-gate QA on each finding | 9 |
| `frontend/src/components/engagement/TestPlansTab.tsx`, `FieldworkTab.tsx` | plan editing; plan beside each test form | 10 |
| `docker-compose.yml`, `backend/Dockerfile`, `.github/workflows/ci.yml` | worker service; CI checks | 11 |
| `docs/deploy/azure.md`, `docs/deploy/operations.md`, `README.md`, `backend/.env.example` | worker app, metrics, alerts, runbook, agent section | 12 |

---
### Task 1: Charge a dropped connection, refund one that never got through, and stop on a full context window

The 2B re-review left two items for before the first paid pilot. First, any connection error that is not a timeout is refunded today, although a connection reset after the request was sent may still be billed. Second, a `model_context_window_exceeded` stop is read as a malformed answer instead of a stop. This task fixes both in the provider, so `AgentModels` charges each case correctly with almost no change.

**Files:**
- Modify: `backend/src/engine/llm/provider.ts` (`ModelNotSentError`; `ModelTimeoutError` doc; `ModelStoppedError.reason`)
- Modify: `backend/src/engine/llm/anthropic.ts` (`causeCodes`, `neverSent`, catch block, stop reasons)
- Modify: `backend/src/agents/llm/models.ts` (the refund comment only)
- Test: `backend/tests/anthropic-provider.test.ts`, `backend/tests/agent-models.test.ts`

**Interfaces:**
- Consumes: `APIConnectionError`, `APIConnectionTimeoutError`, `APIUserAbortError` from `@anthropic-ai/sdk`. `AgentModels.generate` (2B) already refunds any error it does not recognise, keeps a `ModelTimeoutError` charged, and settles a `ModelStoppedError` at its usage without retrying.
- Produces:
  - `class ModelNotSentError extends ProviderError` (provider.ts).
  - `ModelStoppedError.reason: 'refusal' | 'max_tokens' | 'model_context_window_exceeded'`.
  - `causeCodes(err: unknown): string[]` and `neverSent(err: unknown): boolean`, both exported from anthropic.ts.

- [ ] **Step 1: Write the failing provider tests**

In `backend/tests/anthropic-provider.test.ts`:
- Change the first import line to `import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError, InternalServerError } from '@anthropic-ai/sdk';`.
- Change the provider import to `import { MalformedOutputError, ModelNotSentError, ModelStoppedError, ModelTimeoutError } from '../src/engine/llm/provider';`.
- After `failure()`, add:

```ts
/** A connection error as the SDK raises one: fetch's TypeError, with the socket error (and its code) as its cause. */
const connectionError = (code: string) =>
  new APIConnectionError({ cause: new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) }) });
```

- Inside `describe('AnthropicProvider.generate (stubbed SDK client)', …)`, append:

```ts
  it('throws ModelStoppedError with the usage when the context window ran out, without parsing', async () => {
    const { client } = stub(() => answer('{"choice": 1, "rat', 'model_context_window_exceeded'));
    const err = await failure(new AnthropicProvider('claude-opus-5-5', client).generate(ASK));
    expect(err).toBeInstanceOf(ModelStoppedError);
    expect(err).toMatchObject({ reason: 'model_context_window_exceeded', usage: USED });
  });

  it('keeps a connection that dropped after sending charged, like a timeout: the server may still bill it', async () => {
    const { client } = stub(() => { throw connectionError('ECONNRESET'); });
    const err = await failure(new AnthropicProvider('claude-opus-5-5', client).generate(ASK));
    expect(err).toBeInstanceOf(ModelTimeoutError);
    expect((err as Error).message).toMatch(/may have been sent/);
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN'])(
    'refunds a call that never got through (%s)',
    async (code) => {
      const { client } = stub(() => { throw connectionError(code); });
      const err = await failure(new AnthropicProvider('claude-opus-5-5', client).generate(ASK));
      expect(err).toBeInstanceOf(ModelNotSentError);
      expect((err as Error).message).toContain(code);
    },
  );

  it('treats a connection error with no cause, or with one cause that may have been sent, as possibly billed', async () => {
    const bare = stub(() => { throw new APIConnectionError({ message: 'Connection error.' }); });
    expect(await failure(new AnthropicProvider('claude-opus-5-5', bare.client).generate(ASK))).toBeInstanceOf(ModelTimeoutError);
    // Happy eyeballs: IPv6 was refused, but IPv4 connected and was then reset.
    const mixed = new APIConnectionError({
      cause: new TypeError('fetch failed', {
        cause: new AggregateError([
          Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED' }),
          Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        ]),
      }),
    });
    const both = stub(() => { throw mixed; });
    expect(await failure(new AnthropicProvider('claude-opus-5-5', both.client).generate(ASK))).toBeInstanceOf(ModelTimeoutError);
  });
```

- [ ] **Step 2: Write the failing meter tests**

In `backend/tests/agent-models.test.ts`:
- Change the provider import to `import { MalformedOutputError, ModelNotSentError, ModelStoppedError, ModelTimeoutError, type GenerateRequest } from '../src/engine/llm/provider';`.
- Change `it.each(['max_tokens', 'refusal'] as const)` to `it.each(['max_tokens', 'refusal', 'model_context_window_exceeded'] as const)`.
- After the test `keeps a timed-out or aborted call charged at its estimate…`, add:

```ts
  it('refunds a call that was never sent, and retries it', async () => {
    const { fake, models, written, waits } = setup(() => { throw new ModelNotSentError('connect ECONNREFUSED'); });
    await expect(models.generate('qa', ASK)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(fake.requests).toHaveLength(4);
    expect(waits).toEqual(RETRY_DELAYS_MS);
    // Each attempt is reserved, then refunded in full.
    expect(written.at(-1)).toEqual(NO_SPEND);
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -- tests/anthropic-provider.test.ts tests/agent-models.test.ts`
Expected: FAIL. `ModelNotSentError` is not exported, so both files fail to load.

- [ ] **Step 4: Add the error class and the stop reason**

In `backend/src/engine/llm/provider.ts`, replace the `ModelTimeoutError` block and the `ModelStoppedError` block with:

```ts
/**
 * The call ran out of time, was aborted, or lost its connection after it may have been sent. The server may still
 * finish it and bill it, so it is charged like a call that ran (agent spec §6.1), though it is retried like any other
 * model error (§6.3).
 */
export class ModelTimeoutError extends ProviderError {}

/**
 * The call never reached the API: the host name did not resolve, the connection was refused, or TLS failed before the
 * request was written. Nothing can have been billed, so it is refunded, and retried like any other model error.
 */
export class ModelNotSentError extends ProviderError {}

/**
 * The model ran but stopped without an answer: it declined, ran out of output tokens, or ran out of context window.
 * The call is billed, so the usage it reports travels with the error.
 */
export class ModelStoppedError extends ProviderError {
  constructor(
    message: string,
    readonly reason: 'refusal' | 'max_tokens' | 'model_context_window_exceeded',
    readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(message);
  }
}
```

- [ ] **Step 5: Classify connection errors and the context-window stop in the provider**

In `backend/src/engine/llm/anthropic.ts`:
- Change the first import to `import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from '@anthropic-ai/sdk';`.
- Change the provider import to `import { DEFAULT_MAX_TOKENS, MalformedOutputError, ModelNotSentError, ModelStoppedError, ModelTimeoutError } from './provider';`.
- After `SERVER_FALLBACK_BETA`, add:

```ts
/**
 * Socket and TLS error codes that mean the request never reached the API, so nothing can have been billed: the name did
 * not resolve, the connection was refused, or the TLS handshake failed before any of the request was written.
 */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN']);
const notSent = (code: string) => NOT_SENT.has(code) || /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_)/.test(code);

/** Every `code` along an error's causes. fetch puts the socket error under its TypeError; an AggregateError holds several. */
export function causeCodes(err: unknown, depth = 0): string[] {
  if (!err || typeof err !== 'object' || depth > 8) return [];
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  return [
    ...(typeof e.code === 'string' ? [e.code] : []),
    ...(Array.isArray(e.errors) ? e.errors.flatMap((x) => causeCodes(x, depth + 1)) : []),
    ...causeCodes(e.cause, depth + 1),
  ];
}

/** True only when every cause says the request never got through. Anything else may have been sent, and billed. */
export function neverSent(err: unknown): boolean {
  const codes = causeCodes(err);
  return codes.length > 0 && codes.every(notSent);
}
```

- In the doc comment on `generate`, replace the last two sentences ("…a timeout or abort throws ModelTimeoutError, each carrying what the caller needs to charge it. Any other error (the API's own, or a connection that never got through) is passed on unchanged.") with:

```ts
   * MalformedOutputError, a timeout, an abort or a connection lost after sending throws ModelTimeoutError, and a
   * connection that never got through throws ModelNotSentError, each carrying what the caller needs to charge it. The
   * API's own errors are passed on unchanged.
```

- Replace the `catch (err) { … }` block after `messages.create` with:

```ts
    } catch (err) {
      // Sent but not answered in time: the server may still run the request and bill it.
      if (err instanceof APIConnectionTimeoutError || err instanceof APIUserAbortError) {
        throw new ModelTimeoutError(`Model call timed out or was aborted: ${err.message}`);
      }
      if (err instanceof APIConnectionError) {
        // A connection that failed before the request reached the API is not billed. One that failed later (reset,
        // closed mid-answer) may have been, so it is charged like a timeout: an over-count at most.
        if (neverSent(err)) throw new ModelNotSentError(`Model call could not be sent (${causeCodes(err).join(', ')}): ${err.message}`);
        throw new ModelTimeoutError(`Connection to the model failed after the request may have been sent: ${err.message}`);
      }
      throw err;
    }
```

- After the `max_tokens` check, add:

```ts
    if (response.stop_reason === 'model_context_window_exceeded') {
      throw new ModelStoppedError('Model ran out of context window; no draft produced.', 'model_context_window_exceeded', usage);
    }
```

- [ ] **Step 6: Say what is refunded in the meter**

In `backend/src/agents/llm/models.ts`, replace the comment `// An error the API returned, or a connection that never got through, is not billed.` with:

```ts
        // An error the API returned, or a call that never got through (ModelNotSentError), is not billed.
```

- [ ] **Step 7: Run the tests and the type check**

Run: `npm test -- tests/anthropic-provider.test.ts tests/agent-models.test.ts tests/agents-llm-e2e.test.ts && npm run typecheck`
Expected: PASS.

Then run `grep -rn "\.reason\b" src/ tests/ | grep -i stop` to confirm nothing compares `ModelStoppedError.reason` against a fixed list. The type check catches an exhaustive switch, but not a string comparison. Expected: only `models.ts`'s `${err.reason}` and the tests.

- [ ] **Step 8: Commit**

```bash
git add backend/src/engine/llm/provider.ts backend/src/engine/llm/anthropic.ts backend/src/agents/llm/models.ts backend/tests/anthropic-provider.test.ts backend/tests/agent-models.test.ts
git commit -m "fix(agents): charge a connection dropped after sending, refund one never sent, stop on a full context window

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Agent metrics: step durations, tokens and cost, fallbacks, refusals, and runs by status

**Files:**
- Modify: `backend/src/observability/metrics.ts` (six metrics)
- Create: `backend/src/agents/metrics.ts`
- Modify: `backend/src/agents/run-repo.ts` (`lastStepSeq`; `appendStep` uses it)
- Modify: `backend/src/agents/worker.ts` (`tick`, decision `durationMs`)
- Modify: `backend/src/agents/executor.ts` (`durationMs` on qa and gate-opening steps)
- Modify: `backend/src/agents/tools/toolbox.ts` (`durationMs` on tool calls)
- Modify: `backend/src/observability/probes.ts` (`agentRuns` option)
- Modify: `backend/src/app.ts` (the API reports runs by status)
- Test: `backend/tests/agent-metrics.test.ts` (new), `backend/tests/probes.test.ts`

**Interfaces:**
- Consumes: `AgentStep`, `listSteps`, `releaseRun` (run-repo); `Decision`, `RunStatus` (types); `registry` and prom-client from observability/metrics.
- Produces:
  - `lastStepSeq(db: Executor, runId: string): Promise<number>` (run-repo).
  - `observeSteps(steps: AgentStep[]): void`, `fallbackReason(d: Decision): string | null`, `refreshRunGauge(db: Kysely<DB>): Promise<void>` (agents/metrics.ts).
  - `ProbeDeps.agentRuns?: boolean`.
  - Metric names: `audit_agent_runs{status}`, `audit_agent_step_duration_seconds{kind}`, `audit_agent_tokens_total{agent,model,kind}`, `audit_agent_cost_usd_total{agent,model}`, `audit_agent_policy_fallbacks_total{reason}`, `audit_agent_guard_refusals_total{source}`.

- [ ] **Step 1: Write the failing metric tests**

Create `backend/tests/agent-metrics.test.ts`:

```ts
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { observeSteps } from '../src/agents/metrics';
import { listSteps, type AgentStep } from '../src/agents/run-repo';
import { startRun } from '../src/agents/runs';
import { AgentWorker } from '../src/agents/worker';
import { ensureDevUsers } from '../src/auth/dev-users';
import { AppError } from '../src/errors';
import { registry } from '../src/observability/metrics';
import { auditor, FakeProvider, NEW_ENGAGEMENT, newService, noWait, TEST_LLM } from './helpers';

/** A metric's current value for the given labels; for a histogram, how many observations it has. */
async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = await registry.getSingleMetric(name)!.get();
  const wanted = String(metric.type) === 'histogram' ? `${name}_count` : name;
  const match = metric.values.find((v) => (v.metricName ?? name) === wanted && Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return match?.value ?? 0;
}

const step = (over: Partial<AgentStep>): AgentStep => ({
  runId: 'AR-test', seq: 1, kind: 'decision', agent: 'supervisor', decision: {}, model: null, tokensIn: 0, tokensOut: 0, costUsd: 0,
  durationMs: 0, trailBundleId: null, createdAt: new Date(0).toISOString(), ...over,
});

async function startedRun(llm: FakeProvider | null = null) {
  const svc = await newService(llm);
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  const cfg = llm ? { ...defaultAgentConfig(), llm: TEST_LLM } : defaultAgentConfig();
  const { run } = await startRun(svc, cfg, e.id, auditor);
  return { svc, db: svc.db.kysely, run, cfg };
}

describe('agent metrics', () => {
  it('count step durations by kind, and tokens and cost by agent and model', async () => {
    const before = {
      qa: await metricValue('audit_agent_step_duration_seconds', { kind: 'qa' }),
      tokensIn: await metricValue('audit_agent_tokens_total', { agent: 'qa', model: 'm-metrics', kind: 'input' }),
      tokensOut: await metricValue('audit_agent_tokens_total', { agent: 'qa', model: 'm-metrics', kind: 'output' }),
      cost: await metricValue('audit_agent_cost_usd_total', { agent: 'qa', model: 'm-metrics' }),
    };
    observeSteps([
      step({ kind: 'qa', agent: 'qa', model: 'm-metrics', tokensIn: 1200, tokensOut: 300, costUsd: 0.25, durationMs: 4200 }),
      step({ kind: 'qa', agent: 'qa', model: 'm-metrics', tokensIn: 800, tokensOut: 100, costUsd: 0.05, durationMs: 900 }),
    ]);
    expect(await metricValue('audit_agent_step_duration_seconds', { kind: 'qa' })).toBe(before.qa + 2);
    expect(await metricValue('audit_agent_tokens_total', { agent: 'qa', model: 'm-metrics', kind: 'input' })).toBe(before.tokensIn + 2000);
    expect(await metricValue('audit_agent_tokens_total', { agent: 'qa', model: 'm-metrics', kind: 'output' })).toBe(before.tokensOut + 400);
    expect(await metricValue('audit_agent_cost_usd_total', { agent: 'qa', model: 'm-metrics' })).toBeCloseTo(before.cost + 0.3, 6);
  });

  it('count a decision the rules took over from the model, by the model attempt that failed', async () => {
    const malformed = await metricValue('audit_agent_policy_fallbacks_total', { reason: 'malformed' });
    const offMenu = await metricValue('audit_agent_policy_fallbacks_total', { reason: 'off_menu' });
    const complete = { type: 'complete' };
    observeSteps([
      step({ decision: { action: complete, rationale: 'r', policy: 'rules', policyVersion: 'rules-1', attempts: [
        { outcome: 'malformed', model: null, detail: 'x' }, { outcome: 'malformed', model: null, detail: 'y' },
      ] } }),
      // The worker's last line of defence: the model chose, but off the menu.
      step({ decision: { action: complete, rationale: 'r', policy: 'rules', policyVersion: 'rules-1', attempts: [
        { outcome: 'chosen', model: 'm', detail: 'chose 3' }, { outcome: 'off_menu', model: null, detail: 'not on the menu' },
      ] } }),
      // Rules on an offline run, and the model's own choice, are not fallbacks.
      step({ decision: { action: complete, rationale: 'r', policy: 'rules', policyVersion: 'rules-1' } }),
      step({ decision: { action: complete, rationale: 'r', policy: 'llm', policyVersion: 'llm-1', attempts: [{ outcome: 'chosen', model: 'm', detail: 'chose 0' }] } }),
    ]);
    expect(await metricValue('audit_agent_policy_fallbacks_total', { reason: 'malformed' })).toBe(malformed + 1);
    expect(await metricValue('audit_agent_policy_fallbacks_total', { reason: 'off_menu' })).toBe(offMenu + 1);
  });

  it('count refusals by the rails apart from refused model lookups', async () => {
    const rails = await metricValue('audit_agent_guard_refusals_total', { source: 'rails' });
    const lookups = await metricValue('audit_agent_guard_refusals_total', { source: 'model_request' });
    const absurd = 'x'.repeat(100);
    observeSteps([
      step({ kind: 'tool_call', agent: 'rails', decision: { refused: 'An agent may not sign' } }),
      step({ kind: 'tool_call', agent: 'qa', decision: { tool: absurd, args: '{}', resultIds: [], refused: `${absurd} is not on the qa agent's allow-list` } }),
      step({ kind: 'tool_call', agent: 'qa', decision: { tool: 'search_knowledge', args: { query: 'allergen' }, resultIds: ['n1'] } }),
    ]);
    expect(await metricValue('audit_agent_guard_refusals_total', { source: 'rails' })).toBe(rails + 1);
    expect(await metricValue('audit_agent_guard_refusals_total', { source: 'model_request' })).toBe(lookups + 1);
    // A name a model made up never becomes a label.
    expect(await registry.metrics()).not.toContain(absurd);
  });

  it('are counted by the worker for each step it commits', async () => {
    const { svc, db, run, cfg } = await startedRun(new FakeProvider(() => ({ items: [] })));
    const before = {
      decisions: await metricValue('audit_agent_step_duration_seconds', { kind: 'decision' }),
      delegates: await metricValue('audit_agent_step_duration_seconds', { kind: 'delegate' }),
      tokens: await metricValue('audit_agent_tokens_total', { agent: 'specialist:scope', model: 'fake-1', kind: 'input' }),
    };
    await new AgentWorker(svc, cfg, { id: 'w-metrics', wait: noWait }).tick();
    const [, delegate] = await listSteps(db, run.id);
    expect(delegate).toMatchObject({ kind: 'delegate', agent: 'specialist:scope', model: 'fake-1' });
    expect(await metricValue('audit_agent_step_duration_seconds', { kind: 'decision' })).toBe(before.decisions + 1);
    expect(await metricValue('audit_agent_step_duration_seconds', { kind: 'delegate' })).toBe(before.delegates + 1);
    expect(await metricValue('audit_agent_tokens_total', { agent: 'specialist:scope', model: 'fake-1', kind: 'input' })).toBe(before.tokens + delegate.tokensIn);
  });

  it('counts nothing from an iteration whose worker lost the run before handing it back', async () => {
    const { svc, db, run, cfg } = await startedRun();
    vi.spyOn(svc, 'runModuleAsAgent').mockImplementation(async () => {
      // Another worker takes the run while the specialist works.
      await sql`UPDATE agent_runs SET lease_owner = 'w-other' WHERE id = ${run.id}`.execute(db);
      throw new AppError(409, `Agent run ${run.id} is no longer held by this worker`, 'LEASE_LOST');
    });
    const before = await metricValue('audit_agent_step_duration_seconds', { kind: 'decision' });
    await new AgentWorker(svc, cfg, { id: 'w-lost' }).tick();
    // The decision step was committed, but the run was handed back by nobody: it is the next holder's to report.
    expect((await listSteps(db, run.id)).map((s) => s.kind)).toEqual(['decision']);
    expect(await metricValue('audit_agent_step_duration_seconds', { kind: 'decision' })).toBe(before);
  });
});
```

- [ ] **Step 2: Write the failing runs-by-status test**

In `backend/tests/probes.test.ts`:
- Add `import { createRun } from '../src/agents/run-repo';`.
- Add `import { auditor, NEW_ENGAGEMENT } from './helpers';`.
- Append inside `describe('probes and metrics', …)`:

```ts
  it('reports agent runs by status, read from the database at each scrape', async () => {
    const { svc, app } = await appWithDevUsers();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    await createRun(svc.db.kysely, { engagementId: e.id, startedBy: 'auditor', policy: 'rules', policyVersion: 'rules-1', budget: { maxSteps: 5, maxTokens: 1000, maxCostUsd: 1 } });
    const text = (await request(app).get('/metrics').expect(200)).text;
    expect(text).toMatch(/audit_agent_runs\{status="runnable"\} 1\b/);
    // Every status has a value, so a series never goes missing when its last run moves on.
    expect(text).toMatch(/audit_agent_runs\{status="needs_human"\} 0\b/);
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -- tests/agent-metrics.test.ts tests/probes.test.ts`
Expected: FAIL. `../src/agents/metrics` does not exist, and `/metrics` has no `audit_agent_runs`.

- [ ] **Step 4: Define the metrics**

In `backend/src/observability/metrics.ts`, after `signatureFailures`, add:

```ts
// Agent runs (agent spec §6.4). The worker counts each step once it is committed (agents/metrics.ts); the API reports
// how many runs are in each status, read from the database at each scrape.
export const agentRuns = new client.Gauge({
  name: 'audit_agent_runs', help: 'Agent runs by status (reported by the API, read from the database at scrape time)', labelNames: ['status'] as const, registers,
});
export const agentStepSeconds = new client.Histogram({
  name: 'audit_agent_step_duration_seconds', help: 'Duration of committed agent steps by kind (decision, delegate, tool_call, qa)',
  labelNames: ['kind'] as const, buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300], registers,
});
export const agentTokens = new client.Counter({
  name: 'audit_agent_tokens_total', help: 'Model tokens charged to committed agent steps, by agent, model and kind (input, output)',
  labelNames: ['agent', 'model', 'kind'] as const, registers,
});
export const agentCostUsd = new client.Counter({
  name: 'audit_agent_cost_usd_total', help: 'Model cost in USD charged to committed agent steps, by agent and model', labelNames: ['agent', 'model'] as const, registers,
});
export const agentPolicyFallbacks = new client.Counter({
  name: 'audit_agent_policy_fallbacks_total', help: 'Decisions the rules took over from the model policy, by the last model attempt (off_menu, malformed, model_error)',
  labelNames: ['reason'] as const, registers,
});
export const agentGuardRefusals = new client.Counter({
  name: 'audit_agent_guard_refusals_total', help: 'Agent actions refused: source=rails (executor guards) or model_request (a lookup a model asked for)',
  labelNames: ['source'] as const, registers,
});
```

- [ ] **Step 5: Count steps and runs**

Create `backend/src/agents/metrics.ts`:

```ts
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema';
import { agentCostUsd, agentGuardRefusals, agentPolicyFallbacks, agentRuns, agentStepSeconds, agentTokens } from '../observability/metrics';
import type { AgentStep } from './run-repo';
import type { Decision, RunStatus } from './types';

// Agent metrics (spec §6.4), counted from steps once they are committed, so a rolled-back or fenced-off write is never
// counted. Label values are bounded: step kinds, agent names, model ids and fixed reasons. A run, engagement or user id,
// or a tool name a model made up, never becomes a label.

const STATUSES: readonly RunStatus[] = ['running', 'runnable', 'waiting', 'needs_human', 'completed', 'cancelled', 'failed'];

/** Why the rules decided for a model policy, or null when they did not take over (spec §6.3). */
export function fallbackReason(d: Decision): string | null {
  if (d.policy !== 'rules' || !d.attempts?.length) return null;
  return d.attempts[d.attempts.length - 1].outcome;
}

/** Counts one iteration's committed steps. */
export function observeSteps(steps: AgentStep[]): void {
  for (const s of steps) {
    agentStepSeconds.observe({ kind: s.kind }, s.durationMs / 1000);
    const model = s.model ?? 'none';
    if (s.tokensIn) agentTokens.inc({ agent: s.agent, model, kind: 'input' }, s.tokensIn);
    if (s.tokensOut) agentTokens.inc({ agent: s.agent, model, kind: 'output' }, s.tokensOut);
    if (s.costUsd) agentCostUsd.inc({ agent: s.agent, model }, s.costUsd);
    if (s.kind === 'decision') {
      const reason = fallbackReason(s.decision as Decision);
      if (reason) agentPolicyFallbacks.inc({ reason });
    }
    if (s.kind === 'tool_call' && (s.decision as { refused?: unknown } | null)?.refused) {
      agentGuardRefusals.inc({ source: s.agent === 'rails' ? 'rails' : 'model_request' });
    }
  }
}

/** Sets runs by status from the database. A status with no runs reads 0, so its series never goes missing. */
export async function refreshRunGauge(db: Kysely<DB>): Promise<void> {
  const rows = await db
    .selectFrom('agent_runs')
    .select((eb) => ['status', eb.fn.countAll<string>().as('n')])
    .groupBy('status')
    .execute();
  const counts = new Map(rows.map((r) => [r.status, Number(r.n)]));
  for (const status of STATUSES) agentRuns.set({ status }, counts.get(status) ?? 0);
}
```

- [ ] **Step 6: Number steps with `lastStepSeq`**

In `backend/src/agents/run-repo.ts`, add before `appendStep`:

```ts
/** The run's last step number (0 before any step). */
export async function lastStepSeq(db: Executor, runId: string): Promise<number> {
  const row = await db.selectFrom('agent_steps').select((eb) => eb.fn.max('seq').as('seq')).where('run_id', '=', runId).executeTakeFirst();
  return Number(row?.seq ?? 0);
}
```

In `appendStep`, replace the `const last = …` line and `seq: Number(last?.seq ?? 0) + 1,` with a single lookup:
- Replace `const last = await db.selectFrom('agent_steps').select((eb) => eb.fn.max('seq').as('seq')).where('run_id', '=', runId).executeTakeFirst();` with `const seq = (await lastStepSeq(db, runId)) + 1;`.
- Replace `run_id: runId, seq: Number(last?.seq ?? 0) + 1, kind: d.kind,` with `run_id: runId, seq, kind: d.kind,`.

- [ ] **Step 7: Count each tick's steps in the worker, and time decisions**

In `backend/src/agents/worker.ts`:
- Import `observeSteps` from `./metrics`.
- Add `lastStepSeq` and `listSteps` to the `./run-repo` import.
- Replace the `try { … } finally { clearInterval(heartbeat); }` block in `tick()` with:

```ts
    try {
      // Steps are counted once committed and only by the worker that hands the run back (spec §6.4). They are listed
      // while this worker still holds the run, so no step written after a takeover is counted here as well.
      const fromSeq = await lastStepSeq(db, run.id).catch(() => null);
      const update = await runWithRequestId(run.id, () => this.iterate(run));
      const committed = fromSeq === null ? [] : await listSteps(db, run.id, { afterSeq: fromSeq }).catch(() => []);
      if (await releaseRun(db, run.id, this.id, update)) observeSteps(committed);
      else logger.warn({ runId: run.id }, 'agent run lease was lost before the step was handed back');
    } finally {
      clearInterval(heartbeat);
    }
```

- In `iterate`, replace `const decision = await chooseDecision(this.policy, menu, models);` with:

```ts
      const deciding = Date.now();
      const decision = await chooseDecision(this.policy, menu, models);
      const decidedMs = Date.now() - deciding;
```

- In the decision step's `appendStep` call, change `tokensIn: used.tokensIn, tokensOut: used.tokensOut, costUsd: used.costUsd, trailBundleId: sealed.id,` to `tokensIn: used.tokensIn, tokensOut: used.tokensOut, costUsd: used.costUsd, durationMs: decidedMs, trailBundleId: sealed.id,`.

- [ ] **Step 8: Time QA reviews, gate openings and tool calls**

In `backend/src/agents/executor.ts`:
- In `case 'request_qa'`, add `const started = Date.now();` as the first line of the case, before `const steps = await listSteps(db, run.id);`.
- In its `appendStep`, change `tokensIn: used?.tokensIn ?? 0, tokensOut: used?.tokensOut ?? 0, costUsd: used?.costUsd ?? 0, trailBundleId: sealed.id,` to `tokensIn: used?.tokensIn ?? 0, tokensOut: used?.tokensOut ?? 0, costUsd: used?.costUsd ?? 0, durationMs: Date.now() - started, trailBundleId: sealed.id,`.
- In `case 'open_gate'`, add `const started = Date.now();` as the first line of the case.
- Change its `appendStep` call to `await appendStep(trx, run.id, { kind: 'tool_call', agent: 'supervisor', decision: { tool: 'open_gate', ...opened }, durationMs: Date.now() - started, trailBundleId: sealed.id });`.

In `backend/src/agents/tools/toolbox.ts`:
- In `call()`, add `const started = Date.now();` after the `mayUse` check.
- Replace `await this.record({ tool, args: parsed, resultIds: idsOf(result) });` with `await this.record({ tool, args: parsed, resultIds: idsOf(result) }, Date.now() - started);`.
- Change `private async record(output: { tool: string; args: unknown; resultIds: string[]; refused?: string }) {` to `private async record(output: { tool: string; args: unknown; resultIds: string[]; refused?: string }, durationMs = 0) {`.
- In `record`, change its `appendStep` call to `await appendStep(trx, run.id, { kind: 'tool_call', agent: this.agent, decision: output, durationMs, trailBundleId: sealed.id });`.

- [ ] **Step 9: Report runs by status from the API**

In `backend/src/observability/probes.ts`:
- Add `import { refreshRunGauge } from '../agents/metrics';`.
- Add to `ProbeDeps`:

```ts
  /** Report agent runs by status at each scrape. The API does; the worker leaves it to the API so it is never reported twice. */
  agentRuns?: boolean;
```

- In the `/metrics` handler, after the token check and before `res.set(…)`, add:

```ts
    if (deps.agentRuns) {
      // A failed count leaves the last values in place rather than failing the whole scrape.
      await refreshRunGauge(deps.db.kysely).catch((err) => logger.warn({ err }, 'could not count agent runs for /metrics'));
    }
```

In `backend/src/app.ts`, change the `probeRoutes` call to:

```ts
  app.use(probeRoutes({ db: svc.db, blobs: storage.blobs, metricsToken: ops.metricsToken ?? null, timeoutMs: ops.probeTimeoutMs, agentRuns: true }));
```

- [ ] **Step 10: Run the tests and the type check**

Run: `npm test -- tests/agent-metrics.test.ts tests/probes.test.ts tests/worker.test.ts tests/agent-tools.test.ts tests/agents-e2e.test.ts tests/agent-repo.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add backend/src/observability/metrics.ts backend/src/agents/metrics.ts backend/src/agents/run-repo.ts backend/src/agents/worker.ts backend/src/agents/executor.ts backend/src/agents/tools/toolbox.ts backend/src/observability/probes.ts backend/src/app.ts backend/tests/agent-metrics.test.ts backend/tests/probes.test.ts
git commit -m "feat(agents): metrics for step durations, tokens and cost, fallbacks, refusals and runs by status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: The worker process: probes and metrics on its own port, run-tagged logs, validated settings

**Files:**
- Modify: `backend/src/observability/context.ts` (`runId` in the context; `runForAgentRun`, `currentContext`)
- Modify: `backend/src/observability/log.ts` (`service` and `runId` on each line; `setLogService`)
- Modify: `backend/src/observability/probes.ts` (`extraChecks`)
- Modify: `backend/src/config.ts` (`loadWorkerConfig`; a shared `tryLoad`)
- Create: `backend/src/agents/worker-server.ts`
- Modify: `backend/src/agents/worker.ts` (one line: `runForAgentRun`)
- Modify: `backend/src/agents/worker-cli.ts`
- Test: `backend/tests/worker-process.test.ts` (new), `backend/tests/config.test.ts`

**Interfaces:**
- Consumes:
  - `probeRoutes`, `ProbeDeps` (observability/probes, with `agentRuns` from Task 2).
  - `loadConfig`, `loadCitationPolicy` (config); `loadAgentConfig` (agents/config); `errorHandler` (http/errors).
  - `AgentWorker` (worker).
- Produces:
  - `runForAgentRun<T>(runId: string, fn: () => Promise<T>): Promise<T>`.
  - `currentContext(): { requestId: string; runId?: string } | undefined`.
  - `setLogService(name: string): void`.
  - `ProbeDeps.extraChecks?: () => Record<string, string>`.
  - `interface WorkerConfig { core: Config; citationPolicy: CitationPolicy; agents: AgentConfig; port: number }` and `loadWorkerConfig(env?: NodeJS.ProcessEnv): WorkerConfig`.
  - `workerProbeApp(deps: WorkerProbeDeps): express.Express`, where `WorkerProbeDeps = { db: Db; metricsToken: string | null; stopping: () => boolean; timeoutMs?: number }`.

- [ ] **Step 1: Write the failing process tests**

Create `backend/tests/worker-process.test.ts`:

```ts
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { startRun } from '../src/agents/runs';
import { AgentWorker } from '../src/agents/worker';
import { workerProbeApp } from '../src/agents/worker-server';
import { ensureDevUsers } from '../src/auth/dev-users';
import { captureLogs, logger, setLogService } from '../src/observability/log';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

const TOKEN = 'w'.repeat(32);

describe('the worker process', () => {
  it('logs every line of a run step with its runId, as the worker service', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const { run } = await startRun(svc, defaultAgentConfig(), e.id, auditor);
    vi.spyOn(svc, 'runModuleAsAgent').mockImplementation(async () => {
      // A line from deep inside the step, which knows nothing about the run.
      logger.info('deep inside the step');
      throw new Error('specialist failed');
    });
    setLogService('audit-worker');
    const logs = captureLogs('info');
    try {
      await new AgentWorker(svc, defaultAgentConfig(), { id: 'w-logs' }).tick();
    } finally {
      logs.restore();
      setLogService('audit-api');
    }
    const lines = logs.text().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.find((l) => l.msg === 'deep inside the step')).toMatchObject({ runId: run.id, requestId: run.id, service: 'audit-worker' });
    expect(lines.find((l) => l.msg === 'agent run step failed')).toMatchObject({ runId: run.id, service: 'audit-worker' });
  });

  it('serves liveness, readiness from the database and the worker loop, and metrics behind the token', async () => {
    const svc = await newService();
    let stopping = false;
    const app = workerProbeApp({ db: svc.db, metricsToken: TOKEN, stopping: () => stopping });
    expect((await request(app).get('/healthz').expect(200)).body).toEqual({ ok: true });
    expect((await request(app).get('/readyz').expect(200)).body).toEqual({ ok: true, checks: { database: 'ok', storage: 'not configured', worker: 'ok' } });
    await request(app).get('/metrics').expect(401);
    const metrics = await request(app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(metrics.text).toContain('audit_agent_step_duration_seconds');
    // Runs by status are the API's to report.
    expect(metrics.text).not.toMatch(/audit_agent_runs\{/);
    stopping = true;
    expect((await request(app).get('/readyz').expect(503)).body).toMatchObject({ ok: false, checks: { worker: 'stopping' } });
  });
});
```

- [ ] **Step 2: Write the failing settings tests**

In `backend/tests/config.test.ts`, add `loadWorkerConfig` to the `../src/config` import, and append:

```ts
describe('worker configuration', () => {
  const base = { DATABASE_URL: 'postgres://u:p@db:5432/audit' };

  it('serves its probes on WORKER_PORT, 3003 by default [REQ-25]', () => {
    expect(loadWorkerConfig(base).port).toBe(3003);
    expect(loadWorkerConfig({ ...base, WORKER_PORT: '' }).port).toBe(3003);
    expect(loadWorkerConfig({ ...base, WORKER_PORT: '9464' }).port).toBe(9464);
    expect(loadWorkerConfig(base).agents.enabled).toBe(true);
  });

  it('lists every problem at once, and needs the metrics token in production [REQ-25]', () => {
    expect(() => loadWorkerConfig({ ...base, NODE_ENV: 'production', WORKER_PORT: 'x', AGENT_MAX_STEPS: '0', ALLOW_UNVERIFIED_CITATIONS: 'true' })).toThrow(
      /METRICS_TOKEN: required in production[\s\S]*ALLOW_UNVERIFIED_CITATIONS[\s\S]*AGENT_MAX_STEPS[\s\S]*WORKER_PORT/,
    );
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -- tests/worker-process.test.ts tests/config.test.ts`
Expected: FAIL. `worker-server`, `setLogService` and `loadWorkerConfig` do not exist.

- [ ] **Step 4: Carry the run id in the context**

In `backend/src/observability/context.ts`:
- Change `interface RequestContext { requestId: string; }` to:

```ts
interface RequestContext {
  requestId: string;
  /** Set while the agent worker runs one step of a run: its log lines carry it as runId. */
  runId?: string;
}
```

- After `currentRequestId`, add:

```ts
export const currentContext = (): RequestContext | undefined => storage.getStore();
```

- After `runWithRequestId`, add:

```ts
/**
 * Runs one step of an agent run (spec §6.4): its log lines carry runId, and trail bundles it writes carry the run id
 * as their request id, as they always have.
 */
export function runForAgentRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ requestId: runId, runId }, fn);
}
```

- [ ] **Step 5: Put the service and the run id on every log line**

In `backend/src/observability/log.ts`:
- Change `import { currentRequestId } from './context';` to `import { currentContext } from './context';`.
- Before `export const logger = pino(`, add:

```ts
let service = 'audit-api';

/** Names the process on every log line: 'audit-api' (the default) or 'audit-worker'. */
export function setLogService(name: string) {
  service = name;
}
```

- Replace `base: { service: 'audit-api' },` with `base: null,`.
- Replace the whole `mixin: (obj) => { … },` entry and the comment above it with:

```ts
    // Every line names its process. Lines logged while a request is served carry its id; lines logged while the worker
    // runs a step carry the run's id too. A line that names its own requestId or runId (the access log, written after
    // the request's async context has ended) keeps it.
    mixin: (obj) => {
      const ctx = currentContext();
      return {
        service,
        ...(ctx && !('requestId' in obj) ? { requestId: ctx.requestId } : {}),
        ...(ctx?.runId && !('runId' in obj) ? { runId: ctx.runId } : {}),
      };
    },
```

- [ ] **Step 6: Let readiness take extra checks**

In `backend/src/observability/probes.ts`:
- Add to `ProbeDeps`:

```ts
  /** More readiness checks, already decided: name → 'ok', or why not (the worker reports 'stopping' during shutdown). */
  extraChecks?: () => Record<string, string>;
```

- In `/readyz`, after the `storage:` entry of `checks`, add `...(deps.extraChecks?.() ?? {}),`.

- [ ] **Step 7: Validate the worker's settings together**

In `backend/src/config.ts`:
- Add `import { loadAgentConfig, type AgentConfig } from './agents/config';`.
- After `invalid`, add:

```ts
/** Runs one loader, adding its problems to `problems` instead of throwing, so every problem is listed at once. */
function tryLoad<T>(problems: string[], load: () => T): T | null {
  try {
    return load();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    problems.push(...message.replace(/^Invalid configuration:\n/, '').split('\n').filter(Boolean));
    return null;
  }
}

const METRICS_TOKEN_REQUIRED = '  - METRICS_TOKEN: required in production (Prometheus sends it as a bearer token)';
```

- Replace `loadServerConfig` with:

```ts
/** Runs every loader and throws once, listing every problem, so a deployment is fixed in one pass (REQ-25). */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = [];
  const core = tryLoad(problems, () => loadConfig(env));
  // Only the API server and the agent worker need the metrics token; CLIs (migrate, verify, ...) use loadConfig and don't.
  if (env.NODE_ENV === 'production' && !env.METRICS_TOKEN) problems.push(METRICS_TOKEN_REQUIRED);
  const auth = tryLoad(problems, () => loadAuthConfig(env));
  const storage = tryLoad(problems, () => loadStorageConfig(env));
  const citationPolicy = tryLoad(problems, () => loadCitationPolicy(env));
  if (problems.length) throw invalid(problems);
  return { core: core!, auth: auth!, storage: storage!, citationPolicy: citationPolicy! };
}
```

- After `loadServerConfig`, add:

```ts
export interface WorkerConfig {
  core: Config;
  citationPolicy: CitationPolicy;
  agents: AgentConfig;
  /** WORKER_PORT: where the worker serves /healthz, /readyz and /metrics (agent spec §6.4). */
  port: number;
}

/**
 * The agent worker's settings, every problem listed at once (REQ-25). It needs no sign-in or file-storage settings, but
 * like the API it needs the metrics token in production, because it serves /metrics too.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const problems: string[] = [];
  const core = tryLoad(problems, () => loadConfig(env));
  if (env.NODE_ENV === 'production' && !env.METRICS_TOKEN) problems.push(METRICS_TOKEN_REQUIRED);
  const citationPolicy = tryLoad(problems, () => loadCitationPolicy(env));
  const agents = tryLoad(problems, () => loadAgentConfig(env));
  const port = Number(env.WORKER_PORT || '3003');
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('  - WORKER_PORT: must be a port number (1-65535)');
  if (problems.length) throw invalid(problems);
  return { core: core!, citationPolicy: citationPolicy!, agents: agents!, port };
}
```

- [ ] **Step 8: Add the worker's probe server**

Create `backend/src/agents/worker-server.ts`:

```ts
import express from 'express';
import type { Db } from '../db';
import { errorHandler } from '../http/errors';
import { probeRoutes } from '../observability/probes';

// The worker's own small HTTP server (spec §6.4): liveness and readiness for its container, and the metrics the worker
// counts. It serves nothing else, has no sessions, and is never exposed outside the deployment's network.

export interface WorkerProbeDeps {
  db: Db;
  metricsToken: string | null;
  /** True once the worker is shutting down: readiness then fails, so nothing waits on it. */
  stopping: () => boolean;
  timeoutMs?: number;
}

export function workerProbeApp(deps: WorkerProbeDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(probeRoutes({
    db: deps.db, blobs: null, metricsToken: deps.metricsToken, timeoutMs: deps.timeoutMs,
    extraChecks: () => ({ worker: deps.stopping() ? 'stopping' : 'ok' }),
  }));
  app.use(errorHandler());
  return app;
}
```

- [ ] **Step 9: Run iterations under the run's context**

In `backend/src/agents/worker.ts`:
- Change `import { runWithRequestId } from '../observability/context';` to `import { runForAgentRun } from '../observability/context';`.
- In `tick()`, change `const update = await runWithRequestId(run.id, () => this.iterate(run));` to `const update = await runForAgentRun(run.id, () => this.iterate(run));`.

- [ ] **Step 10: Start the probe server with the worker**

Replace `backend/src/agents/worker-cli.ts` with:

```ts
import { loadWorkerConfig, prepareEnv } from '../config';
import { connectPg } from '../db';
import { pendingMigrations } from '../db/migrate';
import { createProvider } from '../engine/llm/router';
import { loadBundles } from '../knowledge/okf/bundle';
import { prepareRegistry } from '../knowledge/packs';
import { instrumentProvider } from '../observability/llm';
import { logger, setLogLevel, setLogService } from '../observability/log';
import { AuditService } from '../service';
import { AgentWorker } from './worker';
import { workerProbeApp } from './worker-server';

// The agent worker process: same image as the API, started with `node dist/agents/worker-cli.js` (npm run worker).
// It connects as the API's database role and never migrates. Its probes and metrics are on WORKER_PORT (default 3003).

async function main() {
  prepareEnv();
  setLogService('audit-worker');
  const { core: config, citationPolicy, agents, port } = loadWorkerConfig();
  setLogLevel(config.logLevel);
  if (!config.metricsToken) logger.warn("METRICS_TOKEN is not set: the worker's /metrics is open. Set it outside local development.");
  const db = connectPg(config.databaseUrl, { ssl: config.databaseSsl, max: agents.concurrency * 2 + 2 });
  const pending = await pendingMigrations(db);
  if (pending.length) {
    await db.close();
    throw new Error(`Database has unapplied migrations (${pending.join(', ')}). Run "npm run migrate" first; the worker never migrates.`);
  }
  const registry = await prepareRegistry(db, loadBundles(config.packsDir), { production: process.env.NODE_ENV === 'production', log: (line) => logger.info(line) });
  const svc = new AuditService(db, registry, instrumentProvider(createProvider()), { citationPolicy });
  const worker = new AgentWorker(svc, agents);
  let stopping = false;
  const server = workerProbeApp({ db, metricsToken: config.metricsToken, stopping: () => stopping }).listen(port);
  if (!agents.enabled) logger.warn('AGENT_ENABLED=false: this worker takes no agent runs');
  worker.start();
  logger.info(`Agent worker ${worker.id}: ${agents.concurrency} loop(s), polling every ${agents.pollMs} ms, provider ${svc.providerInfo.id}/${svc.providerInfo.model}, probes and metrics on :${port}`);
  const shutdown = async () => {
    if (stopping) return;
    // Readiness fails from here on, so no orchestrator waits on this worker.
    stopping = true;
    logger.info('Agent worker stopping');
    // Give an iteration in flight one lease to finish; after that its lease expires and another worker takes the run.
    const bound = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), agents.leaseMs).unref());
    const result = await Promise.race([worker.stop().then(() => 'stopped' as const), bound]);
    if (result === 'timeout') {
      logger.error('Agent worker did not stop within its lease; exiting');
      process.exit(1);
    }
    server.close();
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

The pool gets one more connection than before (`+ 2`), for readiness checks while every loop is busy.

- [ ] **Step 11: Run the tests and the type check**

Run: `npm test -- tests/worker-process.test.ts tests/config.test.ts tests/observability.test.ts tests/probes.test.ts tests/worker.test.ts && npm run typecheck`
Expected: PASS. The observability tests still find `requestId` on request lines, and they now also carry `service: audit-api`.

- [ ] **Step 12: Check the worker starts and answers its probes**

Run (with the local Postgres from the README running, and `backend/.env` set):

```bash
(WORKER_PORT=3013 npm run worker > /tmp/worker-smoke.log 2>&1 &) ; sleep 8
curl -s localhost:3013/healthz; echo; curl -s localhost:3013/readyz; echo
curl -s localhost:3013/metrics | grep -c '^audit_agent_'
pkill -f 'agents/worker-cli.ts'; sleep 1; grep -c '"service":"audit-worker"' /tmp/worker-smoke.log
```

Expected: `{"ok":true}`; `{"ok":true,"checks":{"database":"ok","storage":"not configured","worker":"ok"}}`; a non-zero count of `audit_agent_` lines; and a non-zero count of worker log lines.

- [ ] **Step 13: Commit**

```bash
git add backend/src/observability/context.ts backend/src/observability/log.ts backend/src/observability/probes.ts backend/src/config.ts backend/src/agents/worker-server.ts backend/src/agents/worker.ts backend/src/agents/worker-cli.ts backend/tests/worker-process.test.ts backend/tests/config.test.ts
git commit -m "feat(agents): worker probes and metrics on WORKER_PORT, run-tagged logs, validated worker settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: `verify` checks agent steps against the trail, and each gate signature against its gate

**Files:**
- Modify: `backend/src/ops/verify.ts` (`IntegrityReport.agents`, `checkAgentSteps`, the gate loop in `checkSignatures`)
- Modify: `backend/src/db/cli.ts` (two comments)
- Test: `backend/tests/verify.test.ts`, `backend/tests/gates.test.ts`

**Interfaces:**
- Consumes: `readTrail`, `verifyChain`, `ChainVerification`, `TrailBundle` (`seq`, `actor`, `engagementId`, `inputs`); the `agent_steps`, `agent_runs`, `gates` and `signatures` tables (migration 010).
- Produces: `IntegrityReport.agents: { checked: number; problems: string[] }`. `ok` is false when it has any problem.
  - Problem lines start `Step <runId>#<seq> (<kind>): …`: `has no trail entry`, `its trail entry <id> is missing`, `its trail entry <id> is at or after the break in the chain (seq <n>)`, `its trail entry <id> is not an agent's entry for this run`.
  - New gate lines under `signatures.problems`: `Gate <id>: signature <sig> carries <meaning>, not <expected>`, `Gate <id>: signature <sig> was made for a different gate|finding`, `Gate <id> is <state>, but names signature <sig>`.

- [ ] **Step 1: Write the failing agent-step tests**

In `backend/tests/verify.test.ts`:
- Add imports:

```ts
import { defaultAgentConfig } from '../src/agents/config';
import { listSteps } from '../src/agents/run-repo';
import { startRun } from '../src/agents/runs';
import { AgentWorker } from '../src/agents/worker';
import { readTrail } from '../src/db/trail-repo';
```

- Add `NEW_ENGAGEMENT` and `newService` to the `./helpers` import.
- Append:

```ts
/** An offline agent run that has reached its scope gate: decision, delegate, QA and gate-opening steps, all in the trail. */
async function runAtScopeGate() {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  const { run } = await startRun(svc, defaultAgentConfig(), e.id, auditor);
  await new AgentWorker(svc, defaultAgentConfig(), { id: 'w-verify' }).drain();
  return { k: svc.db.kysely, run, steps: await listSteps(svc.db.kysely, run.id) };
}

describe('verify on agent work', () => {
  it("passes when every agent step's trail entry is in the chain [REQ-24, REQ-28]", async () => {
    const { k, steps } = await runAtScopeGate();
    expect(steps.map((s) => s.kind)).toEqual(expect.arrayContaining(['decision', 'delegate', 'qa', 'tool_call']));
    expect((await verifyIntegrity(k, null)).agents).toEqual({ checked: steps.length, problems: [] });
  });

  it('reports a step whose trail entry is missing, absent, not the run\'s own, or after a break in the chain [REQ-24, REQ-28]', async () => {
    const { k, run, steps } = await runAtScopeGate();
    const decision = steps.find((s) => s.kind === 'decision')!;
    const delegate = steps.find((s) => s.kind === 'delegate')!;
    const qa = steps.find((s) => s.kind === 'qa')!;
    const humanEntry = (await readTrail(k)).find((b) => b.moduleId === 'human:agent-run-start')!;
    await sql`ALTER TABLE agent_steps DISABLE TRIGGER agent_steps_append_only`.execute(k);
    await sql`UPDATE agent_steps SET trail_bundle_id = 'AGT-gone' WHERE run_id = ${run.id} AND seq = ${decision.seq}`.execute(k);
    await sql`UPDATE agent_steps SET trail_bundle_id = NULL WHERE run_id = ${run.id} AND seq = ${delegate.seq}`.execute(k);
    await sql`UPDATE agent_steps SET trail_bundle_id = ${humanEntry.id} WHERE run_id = ${run.id} AND seq = ${qa.seq}`.execute(k);
    const report = await verifyIntegrity(k, null);
    expect(report.agents.problems).toEqual(expect.arrayContaining([
      `Step ${run.id}#${decision.seq} (decision): its trail entry AGT-gone is missing`,
      `Step ${run.id}#${delegate.seq} (delegate): has no trail entry`,
      `Step ${run.id}#${qa.seq} (qa): its trail entry ${humanEntry.id} is not an agent's entry for this run`,
    ]));

    // An edit to the first bundle breaks the chain from seq 1: no agent entry after it is vouched for any more.
    await sql`ALTER TABLE trail DISABLE TRIGGER trail_append_only`.execute(k);
    await sql`UPDATE trail SET body = replace(body, 'Plant 1', 'Plant 9') WHERE module_id = 'human:create-engagement'`.execute(k);
    expect((await verifyIntegrity(k, null)).agents.problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Step AR-\w+#\d+ \(tool_call\): its trail entry AGT-\w+ is at or after the break in the chain \(seq 1\)$/),
    ]));
  });
});
```

- [ ] **Step 2: Write the failing gate cross-check test**

In `backend/tests/gates.test.ts`, inside `describe('workpaper gates', …)`, after the test `are checked by verify against the workpaper history, the trail and the gate [REQ-24]`, add:

```ts
  it('are checked by verify for a signature made for another gate, and an undecided gate naming one [REQ-24, REQ-27]', async () => {
    const { svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { gate } = await waitingAtGate(svc, id, 'scope');
    await svc.signGate(gate.id, 'approve', 'In scope as proposed', reviewer, unattended);
    const k = svc.db.kysely;
    const [sig] = await listSignatures(k, id);
    await sql`ALTER TABLE signatures DISABLE TRIGGER signatures_append_only`.execute(k);
    await sql`UPDATE signatures SET gate_id = 'GATE-other' WHERE id = ${sig.id}`.execute(k);
    expect((await verifyIntegrity(k, null)).signatures.problems).toEqual(expect.arrayContaining([
      `Gate ${gate.id}: signature ${sig.id} was made for a different gate`,
    ]));
    await sql`ALTER TABLE gates DISABLE TRIGGER gates_guard`.execute(k);
    await sql`UPDATE gates SET state = 'superseded' WHERE id = ${gate.id}`.execute(k);
    expect((await verifyIntegrity(k, null)).signatures.problems).toEqual(expect.arrayContaining([
      `Gate ${gate.id} is superseded, but names signature ${sig.id}`,
    ]));
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -- tests/verify.test.ts tests/gates.test.ts`
Expected: FAIL. `report.agents` is undefined, and neither gate line is reported.

- [ ] **Step 4: Check agent steps against the trail**

In `backend/src/ops/verify.ts`:
- Change `import type { SignOff } from '../engine/types';` to `import type { SignOff, TrailBundle } from '../engine/types';`.
- Add to `IntegrityReport`, after `signatures`:

```ts
  /** Each agent step's trail entry (agent spec §9). */
  agents: { checked: number; problems: string[] };
```

- Before `checkRegistrations`, add:

```ts
/** Steps that always carry a trail entry. Bookkeeping tool_call steps (a worker's takeover note, a refusal by the rails) may not. */
const TRAILED_KINDS = new Set(['decision', 'delegate', 'qa']);

/**
 * Each agent step's trail entry (agent spec §9). A decision, delegation or QA review must name one, and any entry a step
 * names must exist, sit in the verified part of the chain, and be an agent's entry for that same run and engagement.
 */
async function checkAgentSteps(db: Kysely<DB>, chain: TrailBundle[], verified: ChainVerification) {
  const problems: string[] = [];
  const bundles = new Map(chain.map((b) => [b.id, b]));
  const engagementOf = new Map((await db.selectFrom('agent_runs').select(['id', 'engagement_id']).execute()).map((r) => [r.id, r.engagement_id]));
  const steps = await db.selectFrom('agent_steps').select(['run_id', 'seq', 'kind', 'trail_bundle_id']).orderBy('run_id').orderBy('seq').execute();
  for (const s of steps) {
    const label = `Step ${s.run_id}#${s.seq} (${s.kind})`;
    if (!s.trail_bundle_id) {
      if (TRAILED_KINDS.has(s.kind)) problems.push(`${label}: has no trail entry`);
      continue;
    }
    const b = bundles.get(s.trail_bundle_id);
    if (!b) {
      problems.push(`${label}: its trail entry ${s.trail_bundle_id} is missing`);
      continue;
    }
    if (verified.brokenAt !== null && b.seq >= verified.brokenAt) {
      problems.push(`${label}: its trail entry ${b.id} is at or after the break in the chain (seq ${verified.brokenAt})`);
    }
    const runId = (b.inputs as { runId?: string } | null)?.runId;
    if (!b.actor.startsWith('agent:') || runId !== s.run_id || b.engagementId !== engagementOf.get(s.run_id)) {
      problems.push(`${label}: its trail entry ${b.id} is not an agent's entry for this run`);
    }
  }
  return { checked: steps.length, problems };
}
```

- Replace the block from `// Every decided gate names a signature that exists, made on the content the gate showed.` to the end of its `for` loop with:

```ts
  // Every decided gate names a signature that exists, made on the content the gate showed, with the decision's meaning,
  // for that gate (agent spec §9). A gate nobody decided names none.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const gates = await db.selectFrom('gates').select(['id', 'kind', 'state', 'signature_id', 'subject_id', 'subject_hash']).orderBy('seq').execute();
  for (const g of gates) {
    if (g.state !== 'approved' && g.state !== 'rejected') {
      if (g.signature_id) problems.push(`Gate ${g.id} is ${g.state}, but names signature ${g.signature_id}`);
      continue;
    }
    const sig = g.signature_id ? byId.get(g.signature_id) : undefined;
    const meaning = g.state === 'approved' ? 'Approved' : 'Rejected';
    if (!sig) problems.push(`Gate ${g.id} is ${g.state}, but its signature ${g.signature_id ?? '(none)'} is missing`);
    else if (sig.content_hash !== g.subject_hash) problems.push(`Gate ${g.id}: signature ${sig.id} is for different content than the gate showed`);
    else if (sig.meaning !== meaning) problems.push(`Gate ${g.id}: signature ${sig.id} carries ${sig.meaning}, not ${meaning}`);
    else if (g.kind === 'finding' ? sig.finding_id !== g.subject_id : sig.gate_id !== g.id || sig.workpaper !== g.kind) {
      problems.push(`Gate ${g.id}: signature ${sig.id} was made for a different ${g.kind === 'finding' ? 'finding' : 'gate'}`);
    }
  }
```

- In `verifyIntegrity`, after `const signatures = await checkSignatures(db, chain);`, add `const agents = await checkAgentSteps(db, chain, trail);`. Then change the last two lines to:

```ts
  const ok = trail.valid && !signatures.problems.length && !agents.problems.length && !documents.problems.length && documents.skipped === null;
  return { ok, trail, signatures, agents, documents };
```

- [ ] **Step 5: Say what `verify` checks**

In `backend/src/db/cli.ts`, change both comments `verify: trail chain, signatures and stored documents (exit 1 on any problem)` and `verify               check the trail chain, signatures and stored documents (exit 1 on any problem)` to say `trail chain, signatures, gates, agent steps and stored documents`.

- [ ] **Step 6: Run the tests and the type check**

Run: `npm test -- tests/verify.test.ts tests/gates.test.ts tests/agents-e2e.test.ts tests/agents-llm-e2e.test.ts && npm run typecheck`
Expected: PASS. The e2e runs' `verifyIntegrity(...).signatures.problems` stay empty after finding and report gates close.

- [ ] **Step 7: Commit**

```bash
git add backend/src/ops/verify.ts backend/src/db/cli.ts backend/tests/verify.test.ts backend/tests/gates.test.ts
git commit -m "feat(verify): agent steps against the trail chain, and each gate signature against its gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: What the UI needs from the API: agent settings, and a run start that never fails after the run exists

**Files:**
- Modify: `backend/src/agents/routes.ts` (`GET /api/agents/settings`)
- Modify: `backend/src/agents/runs.ts` (`startRun` tolerates a failed signer count)
- Test: `backend/tests/agents-http.test.ts`

**Interfaces:**
- Consumes: `AgentConfig` (`enabled`, `budget`, `qaThreshold`), `svc.llm`.
- Produces: `GET /api/agents/settings` → `{ enabled: boolean; budget: Budget; qaThreshold: number; policy: 'llm' | 'rules' }`, for any reader role.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/agents-http.test.ts`:
- Change the vitest import to `import { describe, expect, it, vi } from 'vitest';`.
- Add `import { startRun } from '../src/agents/runs';`.
- Add `reviewer` to the `./helpers` import.
- Append inside `describe('agent runs over HTTP', …)`:

```ts
  it('tell the app whether runs can start, the budget ceiling, the QA threshold and the policy', async () => {
    const { app } = await setup({ ...defaultAgentConfig(), enabled: false, qaThreshold: 80 });
    const viewer = await signIn(app, 'viewer');
    expect((await viewer.get('/api/agents/settings').expect(200)).body).toEqual({
      enabled: false, budget: { maxSteps: 200, maxTokens: 2_000_000, maxCostUsd: 25 }, qaThreshold: 80, policy: 'rules',
    });
  });

  it('start even when counting the other signers fails, with no warning', async () => {
    const { svc, id } = await setup();
    const k = svc.db.kysely;
    const select = k.selectFrom.bind(k);
    // Only the signer count reads users here: make that read fail after the run is created.
    vi.spyOn(k, 'selectFrom').mockImplementation(((table: string) => {
      if (table === 'users') throw new Error('users unreadable');
      return select(table as never);
    }) as typeof k.selectFrom);
    expect(await startRun(svc, defaultAgentConfig(), id, reviewer)).toMatchObject({ run: { status: 'runnable', startedBy: 'reviewer' }, warnings: [] });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/agents-http.test.ts`
Expected: FAIL. `/api/agents/settings` answers 404, and `startRun` rejects with `users unreadable`.

- [ ] **Step 3: Add the settings route**

In `backend/src/agents/routes.ts`, after `const param = …`, add:

```ts
  // What the UI needs before it offers a run (agent spec §7.2): whether runs can start, the budget a starter may lower,
  // the QA threshold it shows signers, and how the worker decides.
  r.get('/api/agents/settings', readers, (_req, res) => {
    res.json({ enabled: cfg.enabled, budget: cfg.budget, qaThreshold: cfg.qaThreshold, policy: svc.llm ? 'llm' : 'rules' });
  });
```

- [ ] **Step 4: Never fail a started run over its warnings**

In `backend/src/agents/runs.ts`:
- Add `import { logger } from '../observability/log';`.
- In `startRun`, replace `return { run, warnings: await starterWarnings(svc, actor) };` with:

```ts
  // The run exists by now: failing to count who else can sign must not turn its creation into an error.
  const warnings = await starterWarnings(svc, actor).catch((err) => {
    logger.warn({ err, runId: run.id }, "could not count who else can sign this run's gates");
    return [] as string[];
  });
  return { run, warnings };
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npm test -- tests/agents-http.test.ts tests/agent-service.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/agents/routes.ts backend/src/agents/runs.ts backend/tests/agents-http.test.ts
git commit -m "feat(agents): agent settings for the UI; a started run never fails over its warnings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: The agent run in the browser: types, API client, and every judgement as a tested pure function

**Files:**
- Modify: `frontend/src/types.ts` (agent types)
- Modify: `frontend/src/api.ts` (plain-language agent errors)
- Create: `frontend/src/agents.ts`
- Test: `frontend/src/agents.test.ts` (new), `frontend/src/api.test.ts`

**Interfaces:**
- Consumes: the backend types `AgentRun`, `AgentStep` (run-repo), `Gate` (gate-repo), `Action`, `Budget`, `Decision`, `GateKind`, `QaReport`, `RunStatus` (agents/types) and `DelegateRecord` (state); `TestPlan`, `Engagement`, `Role`, `User` (engine/types). Also `api()` (api.ts), and the endpoints of §7.1 plus `GET /api/agents/settings` (Task 5).
- Produces, from `frontend/src/agents.ts`:
  - `interface AgentSettings { enabled: boolean; budget: Budget; qaThreshold: number; policy: 'llm' | 'rules' }`, `interface RunPage { run: AgentRun; steps: AgentStep[] }`, `interface StartedRun { run: AgentRun; warnings: string[] }`, `type TestPlanPatch`.
  - `const STEP_PAGE = 500`, and `agentApi` with `settings`, `runs`, `steps`, `gates`, `start`, `pause`, `resume`, `cancel`, `raiseBudget` and `editTestPlan` (exact signatures in Step 4).
  - `hasEnded(run)`, `currentRun(runs)`, `pollDelayMs(run)`, `STATUS_CHIP`, `explainStatus(run)`, `spendRows(run)`, `subjectLabel(key)`, `actionLabel(action)`, `fallbackOf(decision)`, `describeStep(step): StepView`, `sortGates(gates)`, `GATE_SIGNER`, `gateSigning(gate, user, runs): GateSigning`, `openFindingGate(gates, findingId)` and `belowThreshold(report, threshold)`.
  - `BUDGET_LABEL`, `budgetProblem(next, bounds)`, `rowsAwaitingTests(e)`, `changedEngagement(steps)`, `loadStepsSince(page, afterSeq)`, `PlanDraft`, `planDraft(plan)`, `planPatch(before, draft)` and `formatUtc(iso)`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/agents.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  actionLabel, belowThreshold, budgetProblem, changedEngagement, currentRun, describeStep, explainStatus, fallbackOf, gateSigning, loadStepsSince,
  openFindingGate, planDraft, planPatch, pollDelayMs, rowsAwaitingTests, sortGates, spendRows, STEP_PAGE, subjectLabel,
} from './agents';
import type { AgentRun, AgentStep, Decision, Engagement, Gate, QaReport, TestPlan, User } from './types';

const RUN: AgentRun = {
  id: 'AR-1', engagementId: 'ENG-1', goal: 'engagement', status: 'running', statusReason: '', policy: 'rules', policyVersion: 'rules-1',
  budget: { maxSteps: 200, maxTokens: 2_000_000, maxCostUsd: 25 }, spent: { steps: 50, tokensIn: 150_000, tokensOut: 50_000, costUsd: 24 },
  startedBy: 'auditor', cancelRequested: false, pauseRequested: false, wakeRequested: false, failureStreak: 0, conflictStreak: 0, wakeAt: null,
  leaseOwner: null, leaseUntil: null, version: 3, createdAt: '2026-10-14T09:00:00.000Z', updatedAt: '2026-10-14T09:05:00.000Z', endedAt: null,
};
const run = (over: Partial<AgentRun> = {}): AgentRun => ({ ...RUN, ...over });
const step = (over: Partial<AgentStep> = {}): AgentStep => ({
  runId: 'AR-1', seq: 1, kind: 'decision', agent: 'supervisor', decision: {}, model: null, tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 0,
  trailBundleId: null, createdAt: '2026-10-14T09:00:00.000Z', ...over,
});
const REPORT: QaReport = { subjectKey: 'scope', subjectHash: 'h', mode: 'review', reviewer: 'deterministic-2', score: 62, issues: [{ criterion: 'coverage', severity: 'advisory', detail: 'Two risks lack a control' }] };
const gate = (over: Partial<Gate> = {}): Gate => ({
  id: 'GATE-1', engagementId: 'ENG-1', runId: 'AR-1', kind: 'scope', subjectKey: 'scope', subjectId: 'scope', subjectHash: 'h', basisHash: 'b',
  state: 'open', attempt: 1, comment: '', signatureId: null, qaReport: REPORT, openedAt: '2026-10-14T09:10:00.000Z', closedAt: null, ...over,
});
const manager: User = { id: 'reviewer', name: 'Rita Reviewer', role: 'audit_manager' };
const cae: User = { id: 'approver', name: 'Ann Approver', role: 'cae' };
const decision = (over: Partial<Decision>): Decision => ({ action: { type: 'complete' }, rationale: '', policy: 'rules', policyVersion: 'rules-1', ...over });
const PLAN: TestPlan = {
  rowId: 'FD-HACCP-03', rowHash: 'rh', attribute: 'CCP log signed', population: 'CCP logs, Jan-Jun', sampleSize: 25, selectionMethod: 'random',
  evidenceToRequest: ['CCP log', 'Calibration record'], procedure: 'Inspect each log for a signature.',
};

describe('which run to show, and how often to look again', () => {
  it('shows the live run, else the latest, and polls by status', () => {
    expect(currentRun([run({ id: 'AR-3', status: 'completed' }), run({ id: 'AR-2', status: 'waiting' })])?.id).toBe('AR-2');
    expect(currentRun([run({ id: 'AR-3', status: 'completed' }), run({ id: 'AR-1', status: 'cancelled' })])?.id).toBe('AR-3');
    expect(currentRun([])).toBeNull();
    expect(pollDelayMs(run({ status: 'running' }))).toBe(3000);
    expect(pollDelayMs(run({ status: 'runnable' }))).toBe(3000);
    expect(pollDelayMs(run({ status: 'waiting' }))).toBe(15000);
    expect(pollDelayMs(run({ status: 'needs_human' }))).toBe(15000);
    expect(pollDelayMs(run({ status: 'completed' }))).toBeNull();
    expect(pollDelayMs(null)).toBeNull();
  });
});

describe('the run status in plain words', () => {
  it('says why the run stopped and what a person can do', () => {
    expect(explainStatus(run({ status: 'waiting', statusReason: 'awaiting test results for 3 control(s)' }))).toEqual({
      text: 'Waiting for field work: test results for 3 control(s).',
      next: 'Record each test in Fieldwork & testing, or give a reason not to test it in Test plans. The run moves on by itself.',
    });
    expect(explainStatus(run({ status: 'waiting', statusReason: 'awaiting scope gate signature' })).next).toMatch(/approves or rejects the open gate/);
    expect(explainStatus(run({ status: 'needs_human', statusReason: 'budget_exhausted: $25' }))).toEqual({
      text: 'The run used its budget ($25).', next: 'An audit manager can raise the budget; the run then resumes.',
    });
    expect(explainStatus(run({ status: 'needs_human', statusReason: 'gate_rejected_twice: finding:FD-HACCP-03' })).text).toBe('A gate was rejected twice (finding for FD-HACCP-03).');
    expect(explainStatus(run({ status: 'needs_human', statusReason: 'agent_forbidden: An agent may not sign' })).text).toBe('The rails refused an action: An agent may not sign');
    expect(explainStatus(run({ status: 'waiting', statusReason: 'paused_by_user' }))).toEqual({ text: 'Paused.', next: 'Resume the run when you are ready.' });
    expect(explainStatus(run({ status: 'needs_human', statusReason: 'something new' }))).toEqual({ text: 'something new', next: 'Fix what it asks for, then resume.' });
  });
});

describe('spend against budget', () => {
  it('shows iterations, tokens and cost with how full each is', () => {
    expect(spendRows(RUN)).toEqual([
      { label: 'Iterations', used: '50', limit: '200', pct: 25 },
      { label: 'Model tokens', used: '200,000', limit: '2,000,000', pct: 10 },
      { label: 'Model cost', used: '$24.00', limit: '$25.00', pct: 96 },
    ]);
    expect(spendRows(run({ spent: { steps: 300, tokensIn: 0, tokensOut: 0, costUsd: 0 } }))[0].pct).toBe(100);
  });
});

describe('the step timeline', () => {
  it('names subjects and actions in words', () => {
    expect(subjectLabel('rcm')).toBe('RCM');
    expect(subjectLabel('finding:FD-HACCP-03')).toBe('finding for FD-HACCP-03');
    expect(actionLabel({ type: 'delegate', specialist: 'gaps', subjectKey: 'gaps', rows: ['R1', 'R2'] })).toBe('Draft the findings (R1, R2)');
    expect(actionLabel({ type: 'request_qa', subjectKey: 'scope', mode: 'challenge' })).toBe('Challenge the scope');
    expect(actionLabel({ type: 'escalate', reason: 'QA found 2 issue(s)' })).toBe('Hand over to a person: QA found 2 issue(s)');
  });

  it('shows who chose each decision, and when the rules took over from the model', () => {
    const fallback = decision({ attempts: [{ outcome: 'chosen', model: 'm', detail: 'chose 3' }, { outcome: 'off_menu', model: null, detail: 'not on the menu' }] });
    expect(fallbackOf(fallback)).toBe('the model chose an action that is not allowed');
    expect(fallbackOf(decision({ attempts: [{ outcome: 'model_error', model: null, detail: 'overloaded' }] }))).toBe('the model was unavailable');
    expect(fallbackOf(decision({}))).toBeNull();
    expect(fallbackOf(decision({ policy: 'llm', attempts: [{ outcome: 'chosen', model: 'm', detail: 'chose 0' }] }))).toBeNull();
    expect(describeStep(step({ decision: decision({ action: { type: 'open_gate', subjectKey: 'scope' }, rationale: 'QA passed', policy: 'llm' }) }))).toMatchObject({
      title: 'Open the scope gate', detail: 'QA passed', policy: 'llm', fallback: null,
    });
  });

  it('describes delegations, QA reviews and tool calls from their records', () => {
    expect(describeStep(step({ kind: 'delegate', agent: 'specialist:scope', decision: {
      action: { type: 'rework', specialist: 'scope', subjectKey: 'scope', instruction: 'Add the allergen controls' }, basis: 'b', sinceGateId: null, bundleId: 'RUN-1', withoutModel: true,
    } }))).toMatchObject({ title: 'Redrafted the scope (scope specialist)', detail: 'Instruction: Add the allergen controls', withoutModel: true });
    expect(describeStep(step({ kind: 'qa', agent: 'qa', decision: { ...REPORT, issues: [...REPORT.issues, { criterion: 'citations', severity: 'blocking', detail: 'x' }] } }))).toMatchObject({
      title: 'QA review of the scope: 62/100', detail: '2 issue(s), 1 blocking',
    });
    expect(describeStep(step({ kind: 'tool_call', decision: { tool: 'open_gate', gateId: 'GATE-2', kind: 'rcm', attempt: 2 } })).title).toBe('Opened the rcm gate (attempt 2)');
    expect(describeStep(step({ kind: 'tool_call', agent: 'rails', decision: { refused: 'An agent may not sign' } }))).toMatchObject({ title: 'Refused by the rails', detail: 'An agent may not sign', refused: true });
    expect(describeStep(step({ kind: 'tool_call', agent: 'qa', decision: { tool: 'search_knowledge', args: {}, resultIds: ['a', 'b'] } }))).toMatchObject({
      title: 'Looked up the knowledge base (search_knowledge)', detail: '2 result(s)', refused: false,
    });
    expect(describeStep(step({ kind: 'tool_call', agent: 'worker', decision: { recovered: 'The worker stopped mid-step.' } })).title).toBe('Took over from a worker that stopped mid-step');
  });

  it('loads every step after the last one seen, page by page', async () => {
    const all = Array.from({ length: 1203 }, (_, i) => step({ seq: i + 1 }));
    const asked: number[] = [];
    const page = async (after: number) => {
      asked.push(after);
      return all.filter((s) => s.seq > after).slice(0, STEP_PAGE);
    };
    expect((await loadStepsSince(page, 0)).map((s) => s.seq)).toEqual(all.map((s) => s.seq));
    expect(asked).toEqual([0, 500, 1000]);
    expect(await loadStepsSince(page, 1203)).toEqual([]);
  });

  it('reloads the engagement only when the agent drafted something', () => {
    expect(changedEngagement([step({ kind: 'decision' }), step({ kind: 'qa' })])).toBe(false);
    expect(changedEngagement([step({ kind: 'decision' }), step({ kind: 'delegate' })])).toBe(true);
  });
});

describe('gates', () => {
  it('lists open gates first, decided ones newest first, and only counts superseded ones', () => {
    const sorted = sortGates([gate({ id: 'G1', state: 'superseded' }), gate({ id: 'G2', state: 'rejected' }), gate({ id: 'G3', state: 'approved' }), gate({ id: 'G4' })]);
    expect(sorted).toMatchObject({ open: [{ id: 'G4' }], decided: [{ id: 'G3' }, { id: 'G2' }], superseded: 1 });
  });

  it('lets only the right signer, who did not start the run, sign a workpaper gate', () => {
    expect(gateSigning(gate(), manager, [RUN])).toMatchObject({ canSign: true });
    expect(gateSigning(gate(), cae, [RUN])).toEqual({ canSign: false, note: 'Awaiting signature by an audit manager.' });
    expect(gateSigning(gate({ kind: 'report', subjectKey: 'report' }), cae, [RUN])).toMatchObject({ canSign: true });
    expect(gateSigning(gate(), manager, [run({ startedBy: 'reviewer' })])).toEqual({ canSign: false, note: 'You started this run, so someone else must sign its gates.' });
    expect(gateSigning(gate(), manager, [run({ status: 'cancelled' })]).canSign).toBe(false);
    expect(gateSigning(gate({ kind: 'finding', subjectKey: 'finding:R1', subjectId: 'F-1' }), cae, [RUN])).toMatchObject({ canSign: false, note: expect.stringMatching(/Findings tab/) });
    expect(gateSigning(gate({ state: 'approved' }), manager, [RUN])).toEqual({ canSign: false, note: 'This gate is approved.' });
  });

  it("finds a finding's open gate, and flags a report scored below the threshold", () => {
    const gates = [gate({ id: 'G1', kind: 'finding', subjectId: 'F-1', state: 'superseded' }), gate({ id: 'G2', kind: 'finding', subjectId: 'F-1' })];
    expect(openFindingGate(gates, 'F-1')?.id).toBe('G2');
    expect(openFindingGate(gates, 'F-2')).toBeNull();
    expect(belowThreshold(REPORT, 70)).toBe(true);
    expect(belowThreshold(REPORT, 60)).toBe(false);
    expect(belowThreshold(null, 70)).toBe(false);
  });
});

describe('forms', () => {
  it('checks a budget a person typed', () => {
    const ceiling = RUN.budget;
    expect(budgetProblem({ maxSteps: 100, maxTokens: 500_000, maxCostUsd: 5 }, { max: ceiling })).toBeNull();
    expect(budgetProblem({ maxSteps: Number(''), maxTokens: 1, maxCostUsd: 1 }, { max: ceiling })).toBe('Iterations must be a positive whole number');
    expect(budgetProblem({ maxSteps: 2.5, maxTokens: 1, maxCostUsd: 1 }, { max: ceiling })).toBe('Iterations must be a positive whole number');
    expect(budgetProblem({ maxSteps: 10, maxTokens: 1, maxCostUsd: -1 }, { max: ceiling })).toBe('Model cost (USD) must be a positive number');
    expect(budgetProblem({ maxSteps: 201, maxTokens: 1, maxCostUsd: 1 }, { max: ceiling })).toBe('Iterations may not exceed 200');
    expect(budgetProblem({ maxSteps: 200, maxTokens: 2_000_000, maxCostUsd: 20 }, { min: ceiling })).toBe('Model cost (USD) can only be raised (it is 25)');
  });

  it('turns a test-plan form into the changes to send', () => {
    expect(planPatch(PLAN, planDraft(PLAN))).toEqual({ patch: {} });
    expect(planPatch(PLAN, { ...planDraft(PLAN), sampleSize: '30', evidenceToRequest: 'CCP log\n\n  Thermometer log  ' })).toEqual({
      patch: { sampleSize: 30, evidenceToRequest: ['CCP log', 'Thermometer log'] },
    });
    expect(planPatch(PLAN, { ...planDraft(PLAN), notTestedJustification: '   ' })).toEqual({ patch: {} });
    expect(planPatch({ ...PLAN, notTestedJustification: 'Retired' }, { ...planDraft(PLAN), notTestedJustification: ' ' })).toEqual({ patch: { notTestedJustification: '' } });
    expect(planPatch(PLAN, { ...planDraft(PLAN), sampleSize: '-1' })).toEqual({ problem: 'Sample size must be a whole number, 0 or more' });
    expect(planPatch(PLAN, { ...planDraft(PLAN), procedure: ' ' })).toEqual({ problem: 'Procedure cannot be empty' });
  });

  it('counts the controls a run still waits on, as the run does', () => {
    const e = {
      rcm: [{ id: 'R1' }, { id: 'R2' }, { id: 'R3' }],
      testInputs: { R1: {} },
      testPlans: { R2: { notTestedJustification: '   ' }, R3: { notTestedJustification: 'Control retired in March' } },
    } as unknown as Engagement;
    expect(rowsAwaitingTests(e)).toEqual(['R2']);
  });
});
```

In `frontend/src/api.test.ts`, append inside `describe('api errors', …)`:

```ts
  it('explains agent and gate errors in plain words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { error: 'The workpaper changed after this gate opened', code: 'GATE_STALE' })));
    await expect(api('/gates/G-1/sign-intents', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'GATE_STALE', message: expect.stringMatching(/opens a new gate/) });
    vi.stubGlobal('fetch', vi.fn(async () => json(503, { error: 'Agent runs are switched off (AGENT_ENABLED=false)', code: 'AGENT_DISABLED' })));
    await expect(api('/engagements/E-1/runs', { method: 'POST', body: {} })).rejects.toMatchObject({ message: expect.stringMatching(/switched off on this server/) });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run (from `frontend/`): `npm test`
Expected: FAIL. `./agents` does not exist, and `GATE_STALE` has no plain message.

- [ ] **Step 3: Export the agent types**

Append to `frontend/src/types.ts`:

```ts
export type { AgentRun, AgentStep } from '../../backend/src/agents/run-repo';
export type { Gate } from '../../backend/src/agents/gate-repo';
export type { Action, Budget, Decision, GateKind, PolicyAttempt, QaIssue, QaReport, RunStatus, Spent, StepKind } from '../../backend/src/agents/types';
export type { DelegateRecord } from '../../backend/src/agents/state';
```

- [ ] **Step 4: Add the client and the judgements**

In `frontend/src/api.ts`, replace the `CONTENT_CHANGED` entry of `FRIENDLY` and add four entries after it:

```ts
  CONTENT_CHANGED: 'This changed after you started signing. Review it again, then sign.',
  AGENT_DISABLED: 'Agent runs are switched off on this server. Ask your administrator.',
  RUN_ACTIVE: 'This engagement already has an agent run. Reload the page to see it.',
  GATE_STALE: 'The workpaper changed after this gate opened. The agent reviews it again and opens a new gate.',
  RUN_NOT_ACTIVE: 'The agent run behind this gate has ended, so the gate can no longer be signed.',
```

Create `frontend/src/agents.ts`:

```ts
import { api } from './api';
import type { Action, AgentRun, AgentStep, Budget, Decision, DelegateRecord, Engagement, Gate, GateKind, QaReport, Role, RunStatus, TestPlan, User } from './types';

// The agent run as the UI shows it (agent spec §7.2). Everything here is plain functions over the API's types, so it is
// tested without a browser; the components only lay it out.

export interface AgentSettings {
  enabled: boolean;
  /** The most a run may have; a starter may ask for less. */
  budget: Budget;
  qaThreshold: number;
  policy: 'llm' | 'rules';
}

export interface RunPage {
  run: AgentRun;
  steps: AgentStep[];
}

export interface StartedRun {
  run: AgentRun;
  warnings: string[];
}

export type TestPlanPatch = Partial<Pick<TestPlan, 'attribute' | 'population' | 'sampleSize' | 'selectionMethod' | 'evidenceToRequest' | 'procedure' | 'notTestedJustification'>>;

/** The most steps one GET /api/runs/:id returns (the server's limit). */
export const STEP_PAGE = 500;

export const agentApi = {
  settings: () => api<AgentSettings>('/agents/settings'),
  runs: (engagementId: string) => api<AgentRun[]>(`/engagements/${engagementId}/runs`),
  steps: (runId: string, afterSeq: number) => api<RunPage>(`/runs/${runId}?afterSeq=${afterSeq}&limit=${STEP_PAGE}`),
  gates: (engagementId: string) => api<Gate[]>(`/engagements/${engagementId}/gates`),
  start: (engagementId: string, budget: Partial<Budget>) => api<StartedRun>(`/engagements/${engagementId}/runs`, { method: 'POST', body: { budget } }),
  pause: (runId: string) => api<AgentRun>(`/runs/${runId}/pause`, { method: 'POST', body: {} }),
  resume: (runId: string) => api<AgentRun>(`/runs/${runId}/resume`, { method: 'POST', body: {} }),
  cancel: (runId: string) => api<AgentRun>(`/runs/${runId}/cancel`, { method: 'POST', body: {} }),
  raiseBudget: (runId: string, budget: Budget) => api<AgentRun>(`/runs/${runId}/budget`, { method: 'POST', body: budget }),
  editTestPlan: (engagementId: string, rowId: string, patch: TestPlanPatch, version: number | undefined) =>
    api<TestPlan>(`/engagements/${engagementId}/test-plans/${rowId}`, { method: 'PUT', body: patch, ifMatch: version }),
};

/** 'YYYY-MM-DD HH:MM UTC', as elsewhere in the app. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

// ---------- The run ----------

const ENDED: readonly RunStatus[] = ['completed', 'cancelled', 'failed'];
export const hasEnded = (run: AgentRun) => ENDED.includes(run.status);

/** The run to show: the engagement's live run, else its latest (runs come newest first). */
export function currentRun(runs: AgentRun[]): AgentRun | null {
  return runs.find((r) => !hasEnded(r)) ?? runs[0] ?? null;
}

/** How soon to look again: often while the agent works, slowly while it waits for people, never once it has ended. */
export function pollDelayMs(run: AgentRun | null): number | null {
  if (!run || hasEnded(run)) return null;
  return run.status === 'running' || run.status === 'runnable' ? 3000 : 15000;
}

export const STATUS_CHIP: Record<RunStatus, { label: string; color: 'default' | 'primary' | 'info' | 'warning' | 'success' | 'error' }> = {
  running: { label: 'Working', color: 'primary' },
  runnable: { label: 'Queued', color: 'info' },
  waiting: { label: 'Waiting', color: 'default' },
  needs_human: { label: 'Needs a person', color: 'warning' },
  completed: { label: 'Completed', color: 'success' },
  cancelled: { label: 'Cancelled', color: 'default' },
  failed: { label: 'Failed', color: 'error' },
};

/** The run's reason in plain words, and what a person can do about it (null when nothing is needed). */
export function explainStatus(run: AgentRun): { text: string; next: string | null } {
  const r = run.statusReason;
  if (run.status === 'running') return { text: 'The agent is working on the engagement.', next: null };
  if (run.status === 'runnable') return { text: 'Queued: a worker picks the run up within a few seconds.', next: null };
  if (run.status === 'completed') return { text: 'The run reached the end of the chain: the report gate was approved.', next: null };
  if (run.status === 'cancelled') return { text: 'The run was cancelled.', next: 'Start a new run to continue with the agent.' };
  if (run.status === 'failed') return { text: `The run failed: ${r || 'no reason recorded'}.`, next: 'Start a new run once the cause is fixed.' };
  if (r === 'paused_by_user') return { text: 'Paused.', next: 'Resume the run when you are ready.' };
  if (r.startsWith('awaiting test results')) {
    return {
      text: `Waiting for field work: ${r.replace(/^awaiting /, '')}.`,
      next: 'Record each test in Fieldwork & testing, or give a reason not to test it in Test plans. The run moves on by itself.',
    };
  }
  if (/^awaiting .* gate signature/.test(r)) return { text: `Waiting for a signature: ${r.replace(/^awaiting /, '')}.`, next: 'The signer approves or rejects the open gate below.' };
  if (r.startsWith('awaiting signatures on reviewed findings')) {
    return { text: 'Waiting for reviewed findings to be approved or rejected before they can be redrafted.', next: 'The Chief Audit Executive approves or rejects them in Findings.' };
  }
  if (r === 'engagement being edited') return { text: 'Someone is editing the engagement, so the agent is backing off.', next: 'It tries again within a minute.' };
  if (r.startsWith('budget_exhausted')) return { text: `The run used its budget (${r.replace(/^budget_exhausted: /, '')}).`, next: 'An audit manager can raise the budget; the run then resumes.' };
  if (r.startsWith('gate_rejected_twice')) {
    return { text: `A gate was rejected twice (${subjectLabel(r.replace(/^gate_rejected_twice: /, ''))}).`, next: 'Edit the workpaper by hand, then resume: it goes through QA and a fresh gate.' };
  }
  if (r.startsWith('agent_forbidden')) return { text: `The rails refused an action: ${r.replace(/^agent_forbidden: /, '')}`, next: 'Check the steps below, then resume or cancel.' };
  if (r.startsWith('error:')) return { text: `The run stopped after repeated errors: ${r.replace(/^error: /, '')}`, next: 'Resume to try again; if it keeps failing, give the run id to your administrator.' };
  if (run.status === 'needs_human') return { text: r || 'The agent needs a person to decide.', next: 'Fix what it asks for, then resume.' };
  return { text: r ? `Waiting: ${r}.` : 'Waiting.', next: null };
}

export interface SpendRow {
  label: string;
  used: string;
  limit: string;
  /** 0–100, capped. */
  pct: number;
}

const whole = (n: number) => n.toLocaleString('en-US');
const usd = (n: number) => `$${n.toFixed(2)}`;

/** Spent against budget. An iteration is one decision and what it led to, so it usually writes two or more steps. */
export function spendRows(run: AgentRun): SpendRow[] {
  const pct = (used: number, max: number) => (max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 100);
  const tokens = run.spent.tokensIn + run.spent.tokensOut;
  return [
    { label: 'Iterations', used: whole(run.spent.steps), limit: whole(run.budget.maxSteps), pct: pct(run.spent.steps, run.budget.maxSteps) },
    { label: 'Model tokens', used: whole(tokens), limit: whole(run.budget.maxTokens), pct: pct(tokens, run.budget.maxTokens) },
    { label: 'Model cost', used: usd(run.spent.costUsd), limit: usd(run.budget.maxCostUsd), pct: pct(run.spent.costUsd, run.budget.maxCostUsd) },
  ];
}

// ---------- Steps ----------

const SUBJECTS: Record<string, string> = { scope: 'scope', rcm: 'RCM', test_plans: 'test plans', testing: 'test conclusions', gaps: 'findings', report: 'report' };

/** A subject key in words: 'scope', 'RCM', 'finding for FD-HACCP-03', … */
export function subjectLabel(key: string): string {
  if (key.startsWith('finding:')) return `finding for ${key.slice('finding:'.length)}`;
  return SUBJECTS[key] ?? key;
}

/** What an action does, in words. */
export function actionLabel(a: Action): string {
  switch (a.type) {
    case 'delegate':
      return `Draft the ${subjectLabel(a.subjectKey)}${a.rows?.length ? ` (${a.rows.join(', ')})` : ''}`;
    case 'rework':
      return `Redraft the ${subjectLabel(a.subjectKey)} from feedback`;
    case 'request_qa':
      return a.mode === 'challenge' ? `Challenge the ${subjectLabel(a.subjectKey)}` : `QA review of the ${subjectLabel(a.subjectKey)}`;
    case 'open_gate':
      return `Open the ${subjectLabel(a.subjectKey)} gate`;
    case 'wait':
      return `Wait: ${a.reason}`;
    case 'escalate':
      return `Hand over to a person: ${a.reason}`;
    case 'complete':
      return 'Complete the run';
  }
}

const FALLBACK_WHY: Record<string, string> = {
  off_menu: 'the model chose an action that is not allowed',
  malformed: 'the model answered in the wrong shape',
  model_error: 'the model was unavailable',
  chosen: "the model's choice was refused",
};

/** Why the rules decided instead of the model, or null (an offline run's rules, and the model's own choices, are not fallbacks). */
export function fallbackOf(d: Decision): string | null {
  if (d.policy !== 'rules' || !d.attempts?.length) return null;
  return FALLBACK_WHY[d.attempts[d.attempts.length - 1].outcome];
}

export interface StepView {
  title: string;
  detail: string | null;
  /** Who chose a decision: the model, the rules, or nobody (one allowed action). Null for other steps. */
  policy: Decision['policy'] | null;
  fallback: string | null;
  /** Drafted or reviewed without the model, which was configured but unavailable. */
  withoutModel: boolean;
  /** A refusal by the rails, or of a lookup a model asked for. */
  refused: boolean;
}

/** One step of the run as the timeline shows it, from the step's typed record. */
export function describeStep(step: AgentStep): StepView {
  const plain = { detail: null, policy: null, fallback: null, withoutModel: false, refused: false };
  switch (step.kind) {
    case 'decision': {
      const d = step.decision as Decision;
      return { ...plain, title: actionLabel(d.action), detail: d.rationale || null, policy: d.policy, fallback: fallbackOf(d) };
    }
    case 'delegate': {
      const d = step.decision as DelegateRecord;
      const what = d.action.type === 'rework' ? 'Redrafted' : 'Drafted';
      return {
        ...plain,
        title: `${what} the ${subjectLabel(d.action.subjectKey)} (${d.action.specialist} specialist)`,
        detail: d.action.type === 'rework' ? `Instruction: ${d.action.instruction}` : null,
        withoutModel: !!d.withoutModel,
      };
    }
    case 'qa': {
      const q = step.decision as QaReport;
      const blocking = q.issues.filter((i) => i.severity === 'blocking').length;
      return {
        ...plain,
        title: `QA ${q.mode === 'challenge' ? 'challenge' : 'review'} of the ${subjectLabel(q.subjectKey)}: ${q.score}/100`,
        detail: q.issues.length ? `${q.issues.length} issue(s), ${blocking} blocking` : 'No issues',
        withoutModel: !!q.withoutModel,
      };
    }
    case 'tool_call': {
      const t = step.decision as { tool?: string; kind?: GateKind; attempt?: number; resultIds?: string[]; refused?: string; recovered?: string };
      if (t.recovered) return { ...plain, title: 'Took over from a worker that stopped mid-step', detail: t.recovered };
      if (t.tool === 'open_gate') return { ...plain, title: `Opened the ${t.kind} gate${t.attempt && t.attempt > 1 ? ` (attempt ${t.attempt})` : ''}` };
      if (t.refused) return { ...plain, title: step.agent === 'rails' ? 'Refused by the rails' : 'Refused a lookup the model asked for', detail: t.refused, refused: true };
      return { ...plain, title: `Looked up the knowledge base (${t.tool})`, detail: `${t.resultIds?.length ?? 0} result(s)` };
    }
  }
}

/** Every step after `afterSeq`, page by page (a page holds at most STEP_PAGE steps). */
export async function loadStepsSince(page: (afterSeq: number) => Promise<AgentStep[]>, afterSeq: number): Promise<AgentStep[]> {
  const out: AgentStep[] = [];
  let after = afterSeq;
  for (;;) {
    const steps = await page(after);
    out.push(...steps);
    if (steps.length < STEP_PAGE) return out;
    after = steps[steps.length - 1].seq;
  }
}

/** New steps that changed the engagement itself: the page reloads it, or a person's next save is refused as stale. */
export const changedEngagement = (steps: AgentStep[]) => steps.some((s) => s.kind === 'delegate');

// ---------- Gates ----------

/** Open gates first, then decided ones newest first. Superseded gates (changed before anyone signed) are only counted. */
export function sortGates(gates: Gate[]): { open: Gate[]; decided: Gate[]; superseded: number } {
  return {
    open: gates.filter((g) => g.state === 'open'),
    decided: gates.filter((g) => g.state === 'approved' || g.state === 'rejected').reverse(),
    superseded: gates.filter((g) => g.state === 'superseded').length,
  };
}

/** Who signs each workpaper gate (spec §4.3). Finding gates close through the finding's own review and approval. */
export const GATE_SIGNER: Record<Exclude<GateKind, 'finding'>, Role> = { scope: 'audit_manager', rcm: 'audit_manager', report: 'cae' };

export interface GateSigning {
  /** This person may approve or reject the gate here. */
  canSign: boolean;
  /** Why not; or, when they can, how signing works. */
  note: string;
}

/** Whether this person can sign this gate now, and if not, why. The server checks all of it again. */
export function gateSigning(gate: Gate, user: User | null, runs: AgentRun[]): GateSigning {
  if (gate.state !== 'open') return { canSign: false, note: `This gate is ${gate.state}.` };
  if (gate.kind === 'finding') {
    return { canSign: false, note: 'Review and approve this finding in the Findings tab: an audit manager reviews it, then the Chief Audit Executive approves or rejects it.' };
  }
  const signer = GATE_SIGNER[gate.kind];
  const run = runs.find((r) => r.id === gate.runId);
  if (run && hasEnded(run)) return { canSign: false, note: `The run behind this gate has ended (${run.status}), so it can no longer be signed.` };
  if (!user || user.role !== signer) return { canSign: false, note: `Awaiting signature by ${signer === 'cae' ? 'the Chief Audit Executive' : 'an audit manager'}.` };
  if (run?.startedBy === user.id) return { canSign: false, note: 'You started this run, so someone else must sign its gates.' };
  return { canSign: true, note: 'Signing opens a window where you confirm your identity again.' };
}

/** The open gate on a finding, if the agent opened one. */
export const openFindingGate = (gates: Gate[], findingId: string): Gate | null =>
  gates.find((g) => g.kind === 'finding' && g.state === 'open' && g.subjectId === findingId) ?? null;

/** QA scored the subject below the threshold. The gate still opened because no issue was blocking, so the signer is told. */
export const belowThreshold = (report: QaReport | null, threshold: number) => !!report && report.score < threshold;

// ---------- Forms ----------

export const BUDGET_LABEL: Record<keyof Budget, string> = { maxSteps: 'Iterations', maxTokens: 'Model tokens', maxCostUsd: 'Model cost (USD)' };

/** What is wrong with a budget a person typed, or null. `max` is the ceiling when starting; `min` the current budget when raising. */
export function budgetProblem(next: Budget, bounds: { min?: Budget; max?: Budget }): string | null {
  for (const k of ['maxSteps', 'maxTokens', 'maxCostUsd'] as const) {
    const v = next[k];
    const money = k === 'maxCostUsd';
    if (!Number.isFinite(v) || v <= 0 || (!money && !Number.isInteger(v))) return `${BUDGET_LABEL[k]} must be a positive ${money ? 'number' : 'whole number'}`;
    if (bounds.max && v > bounds.max[k]) return `${BUDGET_LABEL[k]} may not exceed ${bounds.max[k]}`;
    if (bounds.min && v < bounds.min[k]) return `${BUDGET_LABEL[k]} can only be raised (it is ${bounds.min[k]})`;
  }
  return null;
}

/** RCM rows still waiting for a recorded test or a person's reason not to test, counted as the run's wait condition counts them. */
export function rowsAwaitingTests(e: Engagement): string[] {
  return e.rcm.filter((r) => !e.testInputs[r.id] && !e.testPlans[r.id]?.notTestedJustification?.trim()).map((r) => r.id);
}

/** A test plan as its form holds it: numbers and lists as text. */
export interface PlanDraft {
  attribute: string;
  population: string;
  sampleSize: string;
  selectionMethod: TestPlan['selectionMethod'];
  /** One item per line. */
  evidenceToRequest: string;
  procedure: string;
  notTestedJustification: string;
}

export const planDraft = (p: TestPlan): PlanDraft => ({
  attribute: p.attribute, population: p.population, sampleSize: String(p.sampleSize), selectionMethod: p.selectionMethod,
  evidenceToRequest: p.evidenceToRequest.join('\n'), procedure: p.procedure, notTestedJustification: p.notTestedJustification ?? '',
});

/** The fields a person changed, as the API takes them, or what is wrong with the form. An empty reason clears it. */
export function planPatch(before: TestPlan, d: PlanDraft): { patch: TestPlanPatch } | { problem: string } {
  const sampleSize = Number(d.sampleSize);
  if (d.sampleSize.trim() === '' || !Number.isInteger(sampleSize) || sampleSize < 0) return { problem: 'Sample size must be a whole number, 0 or more' };
  for (const [k, label] of [['attribute', 'Attribute'], ['population', 'Population'], ['procedure', 'Procedure']] as const) {
    if (!d[k].trim()) return { problem: `${label} cannot be empty` };
  }
  const next: Required<TestPlanPatch> = {
    attribute: d.attribute.trim(), population: d.population.trim(), sampleSize, selectionMethod: d.selectionMethod,
    evidenceToRequest: d.evidenceToRequest.split('\n').map((s) => s.trim()).filter(Boolean), procedure: d.procedure.trim(),
    notTestedJustification: d.notTestedJustification.trim(),
  };
  const patch: TestPlanPatch = {};
  for (const k of Object.keys(next) as (keyof TestPlanPatch)[]) {
    const old = k === 'notTestedJustification' ? before.notTestedJustification ?? '' : before[k];
    if (JSON.stringify(old) !== JSON.stringify(next[k])) Object.assign(patch, { [k]: next[k] });
  }
  return { patch };
}
```

- [ ] **Step 5: Run the checks**

Run (from `frontend/`): `npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types.ts frontend/src/api.ts frontend/src/api.test.ts frontend/src/agents.ts frontend/src/agents.test.ts
git commit -m "feat(ui): agent run client and view logic: status, spend, steps, gates, budgets and test plans

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Sign gates through the same Part 11 pop-up as findings

**Files:**
- Modify: `frontend/src/signing.ts` (one shared loop, `followSigning`; `signGateWithReauth`; subject-aware `CONTENT_CHANGED`)
- Test: `frontend/src/signing.test.ts`

**Interfaces:**
- Consumes: `POST /api/gates/:gateId/sign-intents` with `{ action: 'approve' | 'reject', comment }`, which answers like the finding route (`intentId`, `reauthUrl`, `method`, `expiresAt`, `qa`). Also `GET /api/sign-intents/:id` and `POST /api/sign-intents/:id/cancel`.
- Produces:
  - `signGateWithReauth(gateId: string, action: 'approve' | 'reject', comment: string, popup: SigningWindow | null, opts?: { signal?: AbortSignal; deps?: SigningDeps }): Promise<void>`.
  - `signWithReauth` keeps its signature and behaviour.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/signing.test.ts`:
- Change the import to `import { signGateWithReauth, signWithReauth, type SigningDeps, type SigningWindow } from './signing';`.
- In the test `explains a finding that changed while signing`, change `message: expect.stringMatching(/changed after you started signing/)` to `message: expect.stringMatching(/^The finding changed after you started signing/)`.
- Append:

```ts
describe('signGateWithReauth', () => {
  it('signs a gate through the same window, request and polling as a finding', async () => {
    const { deps, calls, bodies, navigated } = fakeDeps([{ status: 'pending' }, { status: 'signed' }]);
    await expect(signGateWithReauth('GATE-1', 'reject', 'Bring the allergen controls into scope', { closed: false }, { deps })).resolves.toBeUndefined();
    expect(calls[0]).toBe('POST /gates/GATE-1/sign-intents');
    expect(bodies[0]).toEqual(['/gates/GATE-1/sign-intents', { action: 'reject', comment: 'Bring the allergen controls into scope' }]);
    expect(navigated).toEqual(['/auth/sign/INT-1']);
    expect(polls(calls)).toBe(2);
  });

  it('says the workpaper changed, not a finding, when its content moved while signing', async () => {
    const { deps } = fakeDeps([{ status: 'failed', code: 'CONTENT_CHANGED', message: 'server text' }]);
    await expect(signGateWithReauth('GATE-1', 'approve', '', { closed: false }, { deps })).rejects.toMatchObject({
      code: 'CONTENT_CHANGED', message: expect.stringMatching(/^The workpaper changed after you started signing/),
    });
  });

  it('asks for pop-ups to be allowed before creating a gate signing request, and closes the window if the request is refused', async () => {
    const blocked = fakeDeps([]);
    await expect(signGateWithReauth('GATE-1', 'approve', '', null, { deps: blocked.deps })).rejects.toMatchObject({ code: 'POPUP_BLOCKED' });
    expect(blocked.calls).toEqual([]);
    const popup = { closed: false };
    const refused = fakeDeps([], { intentError: new Error('You started this agent run, so someone else must sign its gates') });
    await expect(signGateWithReauth('GATE-1', 'approve', '', popup, { deps: refused.deps })).rejects.toThrow(/someone else must sign/);
    expect(refused.closed).toEqual([popup]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run (from `frontend/`): `npm test`
Expected: FAIL. `signGateWithReauth` is not exported, and the finding message has no leading "The finding".

- [ ] **Step 3: Share the loop between findings and gates**

In `frontend/src/signing.ts`:
- Delete the `CONTENT_CHANGED` entry from `MESSAGES`.
- After `const MAX_RETRIES = 3;`, add:

```ts
/** What is being signed, so a message can name it. */
type Subject = 'finding' | 'workpaper';
```

- Replace `explain` with:

```ts
/** REAUTH_STALE and REAUTH_REQUIRED have several causes, and the server names the one that happened. */
function explain(s: IntentStatus, subject: Subject): SigningError {
  if (s.code === 'CONTENT_CHANGED') return new SigningError(`The ${subject} changed after you started signing. Review it again, then sign.`, s.code);
  const text = s.code && SERVER_EXPLAINS.has(s.code) ? s.message || MESSAGES[s.code] : (s.code && MESSAGES[s.code]) || s.message || 'Signing failed.';
  return new SigningError(text, s.code);
}
```

- Replace the whole `signWithReauth` function, with its doc comment, by:

```ts
/**
 * The Part 11 signing loop, whatever is being signed. The caller has already opened `popup` (synchronously, from the
 * click). `start` asks the server for a signing request; the window is sent to re-authenticate; then the request is
 * followed until it is signed or fails.
 *
 * The window's `closed` flag is not used: identity-provider pages with Cross-Origin-Opener-Policy report the window
 * closed while the signer is still typing their password. Waiting ends when the server says signed or failed, when the
 * request runs out, or when `signal` aborts (the Cancel button). On giving up, the request is cancelled on the server
 * and its final state read back, so a signature that landed at the last moment is still reported as signed.
 */
async function followSigning(
  start: () => Promise<Intent>,
  subject: Subject,
  popup: SigningWindow | null,
  { signal, deps }: { signal?: AbortSignal; deps: SigningDeps },
): Promise<void> {
  if (!popup) throw new SigningError('Your browser blocked the sign-in window. Allow pop-ups for this site, then sign again.', 'POPUP_BLOCKED');
  let intent: Intent;
  try {
    intent = await start();
    deps.navigate(popup, intent.reauthUrl);
  } catch (err) {
    deps.closePopup(popup);
    throw err;
  }

  const status = () => deps.api<IntentStatus>(`/sign-intents/${intent.intentId}`);
  const deadline = Date.parse(intent.expiresAt);
  let failures = 0;
  while (!signal?.aborted && deps.now() <= deadline) {
    await deps.sleep(failures ? POLL_MS * 2 ** failures : POLL_MS);
    if (signal?.aborted) break;
    let s: IntentStatus;
    try {
      s = await status();
      failures = 0;
    } catch {
      if (++failures > MAX_RETRIES) throw new SigningError(LOST_CONTACT, 'LOST_CONTACT');
      continue;
    }
    if (s.status === 'signed') return;
    if (s.status === 'failed') throw explain(s, subject);
  }

  // Cancelled or out of time: cancel on the server, then believe only what it says.
  const cancelled = !!signal?.aborted;
  try {
    await deps.api(`/sign-intents/${intent.intentId}/cancel`, { method: 'POST', body: cancelled ? {} : { reason: 'expired' } });
  } catch {
    // The status read below decides.
  }
  let final: IntentStatus;
  try {
    final = await status();
  } catch {
    throw new SigningError(LOST_CONTACT, 'LOST_CONTACT');
  }
  if (final.status === 'signed') return;
  if (!popup.closed) deps.closePopup(popup);
  if (final.status === 'failed') {
    if (final.code === 'CANCELLED') throw new SigningError('Signing cancelled. Nothing was signed.', 'CANCELLED');
    if (final.code === 'INTENT_EXPIRED') throw new SigningError('The signing request expired. Nothing was signed. Start signing again.', 'INTENT_EXPIRED');
    throw explain(final, subject);
  }
  // Still being completed on the server: we cannot say either way.
  throw new SigningError('Your signature is still being processed. Reload to see whether it was recorded.', 'UNCONFIRMED');
}

/** Signs a finding as a Part 11 electronic signature (review, approve or reject). */
export function signWithReauth(
  engagementId: string,
  findingId: string,
  action: 'review' | 'approve' | 'reject',
  comment: string,
  popup: SigningWindow | null,
  { signal, deps = browserSigning }: { signal?: AbortSignal; deps?: SigningDeps } = {},
): Promise<void> {
  const start = () => deps.api<Intent>(`/engagements/${engagementId}/findings/${findingId}/sign-intents`, { method: 'POST', body: { action, comment } });
  return followSigning(start, 'finding', popup, { signal, deps });
}

/**
 * Signs a scope, RCM or report gate the agent opened (agent spec §4.3), through the same window and request. A rejection
 * needs a comment: the agent redrafts the workpaper from it.
 */
export function signGateWithReauth(
  gateId: string,
  action: 'approve' | 'reject',
  comment: string,
  popup: SigningWindow | null,
  { signal, deps = browserSigning }: { signal?: AbortSignal; deps?: SigningDeps } = {},
): Promise<void> {
  const start = () => deps.api<Intent>(`/gates/${gateId}/sign-intents`, { method: 'POST', body: { action, comment } });
  return followSigning(start, 'workpaper', popup, { signal, deps });
}
```

- [ ] **Step 4: Run the checks**

Run (from `frontend/`): `npm run typecheck && npm test && npm run build`
Expected: PASS. All 13 existing `signWithReauth` tests pass unchanged, apart from the one message pinned more tightly in Step 1.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/signing.ts frontend/src/signing.test.ts
git commit -m "feat(ui): sign agent gates through the existing Part 11 signing window

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: The Run panel: status, spend, controls and the step timeline

**Files:**
- Create: `frontend/src/components/engagement/useAgentRun.ts`
- Create: `frontend/src/components/engagement/StepTimeline.tsx`
- Create: `frontend/src/components/engagement/RunPanel.tsx`
- Modify: `frontend/src/pages/EngagementPage.tsx` (mount the panel; keep the engagement in step with the agent)

**Interfaces:**
- Consumes (Task 6): `agentApi`, `currentRun`, `pollDelayMs`, `loadStepsSince`, `changedEngagement`, `hasEnded`, `STATUS_CHIP`, `explainStatus`, `spendRows`, `BUDGET_LABEL`, `budgetProblem`, `describeStep`, `formatUtc` and `AgentSettings`. Also `canPrepare` (roles), `useSession` (session) and `ActionButton` (common).
- Produces:
  - `useAgentRun(engagementId: string, onEngagementChanged: () => void): AgentRunState`, where `AgentRunState = { settings: AgentSettings | null; runs: AgentRun[]; run: AgentRun | null; steps: AgentStep[]; gates: Gate[]; error: string | null; refresh: () => Promise<void> }`.
  - `<RunPanel engagementId agent onSigned showFindings />`, with props `{ engagementId: string; agent: AgentRunState; onSigned: () => Promise<void>; showFindings: () => void }`. `onSigned` and `showFindings` are used by the gate list in Task 9.
  - `<StepTimeline steps />`.

No unit test is added here: every judgement the panel shows comes from Task 6's tested functions (Ruling 8). The panel is checked by the type check, the build and the manual check in Step 6.

- [ ] **Step 1: Add the polling hook**

Create `frontend/src/components/engagement/useAgentRun.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { agentApi, changedEngagement, currentRun, loadStepsSince, pollDelayMs, type AgentSettings } from '../../agents';
import type { AgentRun, AgentStep, Gate } from '../../types';

export interface AgentRunState {
  settings: AgentSettings | null;
  runs: AgentRun[];
  /** The run the panel shows: the live one, else the latest. */
  run: AgentRun | null;
  steps: AgentStep[];
  gates: Gate[];
  /** The last error loading agent state. The panel shows it and keeps polling. */
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Keeps the engagement's agent run, its steps and its gates current by polling (there is no push channel): often while
 * the agent works, slowly while it waits for people, not at all once it has ended. Only steps after the last one seen
 * are fetched. When the agent drafted something, `onEngagementChanged` reloads the engagement, so a person's next save
 * is not refused as stale. Refreshes run one at a time, so a poll and a button press never add the same steps twice.
 */
export function useAgentRun(engagementId: string, onEngagementChanged: () => void): AgentRunState {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<{ runId: string | null; lastSeq: number }>({ runId: null, lastSeq: 0 });
  const queue = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(async () => {
    try {
      const [rs, gs] = await Promise.all([agentApi.runs(engagementId), agentApi.gates(engagementId)]);
      setRuns(rs);
      setGates(gs);
      const run = currentRun(rs);
      if (!run) {
        seen.current = { runId: null, lastSeq: 0 };
        setSteps([]);
      } else {
        const fresh = seen.current.runId !== run.id;
        const fetched = await loadStepsSince((after) => agentApi.steps(run.id, after).then((p) => p.steps), fresh ? 0 : seen.current.lastSeq);
        const lastSeq = fetched.length ? fetched[fetched.length - 1].seq : fresh ? 0 : seen.current.lastSeq;
        seen.current = { runId: run.id, lastSeq };
        if (fresh) setSteps(fetched);
        else if (fetched.length) setSteps((prev) => [...prev, ...fetched]);
        if (!fresh && changedEngagement(fetched)) onEngagementChanged();
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [engagementId, onEngagementChanged]);

  const refresh = useCallback(() => (queue.current = queue.current.then(load)), [load]);

  useEffect(() => {
    agentApi.settings().then(setSettings, () => setSettings(null));
  }, []);

  useEffect(() => {
    seen.current = { runId: null, lastSeq: 0 };
    void refresh();
  }, [refresh]);

  const run = currentRun(runs);
  const delay = pollDelayMs(run);
  useEffect(() => {
    if (delay === null) return;
    const timer = setInterval(() => {
      // A hidden tab skips its turn; the next one looks again.
      if (document.visibilityState === 'visible') void refresh();
    }, delay);
    return () => clearInterval(timer);
  }, [delay, refresh]);

  return { settings, runs, run, steps, gates, error, refresh };
}
```

- [ ] **Step 2: Add the step timeline**

Create `frontend/src/components/engagement/StepTimeline.tsx`:

```tsx
import { Box, Chip, Link, Stack, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import { describeStep, formatUtc } from '../../agents';
import type { AgentStep } from '../../types';

const SHOWN = 50;
const POLICY_LABEL = { llm: 'model', rules: 'rules', forced: 'only option' } as const;

/** Every step of the run, oldest first: what was decided and why, who chose it, and what it cost. */
export default function StepTimeline({ steps }: { steps: AgentStep[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? steps : steps.slice(-SHOWN);
  if (!steps.length) return <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>No steps yet.</Typography>;
  return (
    <Stack sx={{ mt: 1, borderLeft: 2, borderColor: 'divider', pl: 2 }}>
      {steps.length > shown.length && (
        <Link component="button" variant="body2" onClick={() => setAll(true)} sx={{ alignSelf: 'flex-start', mb: 1 }}>
          Show all {steps.length} steps
        </Link>
      )}
      {shown.map((s) => {
        const v = describeStep(s);
        const tokens = s.tokensIn + s.tokensOut;
        return (
          <Box key={s.seq} sx={{ py: 0.75 }}>
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
              <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary', minWidth: 36 }}>
                #{s.seq}
              </Typography>
              <Chip size="small" variant="outlined" label={s.kind.replace('_', ' ')} />
              <Typography variant="body2" fontWeight={500}>
                {v.title}
              </Typography>
              {v.policy && <Chip size="small" label={POLICY_LABEL[v.policy]} color={v.policy === 'llm' ? 'primary' : 'default'} variant={v.policy === 'forced' ? 'outlined' : 'filled'} />}
              {v.fallback && (
                <Tooltip title={`The rules decided because ${v.fallback}.`}>
                  <Chip size="small" color="warning" label="fallback to rules" />
                </Tooltip>
              )}
              {v.withoutModel && <Chip size="small" color="warning" variant="outlined" label="without model" />}
              {v.refused && <Chip size="small" color="error" label="refused" />}
            </Stack>
            {v.detail && (
              <Typography variant="body2" color="text.secondary" sx={{ ml: 5.5 }}>
                {v.detail}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ ml: 5.5, display: 'block' }}>
              {formatUtc(s.createdAt)} · {s.agent}
              {s.model ? ` · ${s.model}` : ''}
              {tokens ? ` · ${tokens.toLocaleString('en-US')} tokens, $${s.costUsd.toFixed(4)}` : ''}
              {s.durationMs ? ` · ${(s.durationMs / 1000).toFixed(1)} s` : ''}
            </Typography>
          </Box>
        );
      })}
    </Stack>
  );
}
```

- [ ] **Step 3: Add the Run panel**

Create `frontend/src/components/engagement/RunPanel.tsx`:

```tsx
import { Pause as PauseIcon, PlayArrow as PlayArrowIcon, SmartToyOutlined as AgentIcon, StopCircleOutlined as StopIcon, TrendingUp as RaiseIcon } from '@mui/icons-material';
import { Alert, Box, Button, Card, CardContent, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, Grid, LinearProgress, Link, Stack, TextField, Typography } from '@mui/material';
import { useState, type ReactNode } from 'react';
import { agentApi, BUDGET_LABEL, budgetProblem, explainStatus, hasEnded, spendRows, STATUS_CHIP } from '../../agents';
import { canPrepare } from '../../roles';
import { useSession } from '../../session';
import type { Budget } from '../../types';
import { ActionButton } from '../common';
import StepTimeline from './StepTimeline';
import type { AgentRunState } from './useAgentRun';

const FIELDS = Object.keys(BUDGET_LABEL) as (keyof Budget)[];

/** Starts a run with a budget at or below the server's ceiling, or raises a live run's budget. */
function BudgetDialog(props: {
  title: string;
  intro: ReactNode;
  initial: Budget;
  bounds: { min?: Budget; max?: Budget };
  submitLabel: string;
  onSubmit: (budget: Budget) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState<Record<keyof Budget, string>>({
    maxSteps: String(props.initial.maxSteps), maxTokens: String(props.initial.maxTokens), maxCostUsd: String(props.initial.maxCostUsd),
  });
  const next: Budget = { maxSteps: Number(text.maxSteps), maxTokens: Number(text.maxTokens), maxCostUsd: Number(text.maxCostUsd) };
  const problem = budgetProblem(next, props.bounds);
  return (
    <Dialog open onClose={props.onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{props.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {props.intro}
          {FIELDS.map((k) => (
            <TextField
              key={k}
              type="number"
              label={BUDGET_LABEL[k]}
              value={text[k]}
              onChange={(e) => setText({ ...text, [k]: e.target.value })}
              inputProps={{ min: 0, step: k === 'maxCostUsd' ? 0.5 : 1 }}
            />
          ))}
          <Typography variant="caption" color="text.secondary">
            An iteration is one decision and what it led to, so it usually adds two or more steps to the run.
          </Typography>
          {problem && <Alert severity="warning">{problem}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose}>Cancel</Button>
        <ActionButton
          disabled={!!problem}
          action={async () => {
            await props.onSubmit(next);
            props.onClose();
          }}
        >
          {props.submitLabel}
        </ActionButton>
      </DialogActions>
    </Dialog>
  );
}

export interface RunPanelProps {
  engagementId: string;
  agent: AgentRunState;
  /** Reloads the engagement after a signature, so the page shows what the server recorded. */
  onSigned: () => Promise<void>;
  /** Opens the Findings tab, where finding gates are signed. */
  showFindings: () => void;
}

/** The engagement's agent run (agent spec §7.2): status and reason, spend against budget, controls, steps. */
export default function RunPanel({ engagementId, agent }: RunPanelProps) {
  const { user } = useSession();
  const [dialog, setDialog] = useState<'start' | 'budget' | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showSteps, setShowSteps] = useState(false);
  const { settings, run, steps, error, refresh } = agent;
  const liveRun = run && !hasEnded(run) ? run : null;
  const preparer = canPrepare(user?.role);
  const paused = liveRun?.statusReason === 'paused_by_user';
  const act = (call: (runId: string) => Promise<unknown>) => async () => {
    if (!liveRun) return;
    await call(liveRun.id);
    await refresh();
  };
  const status = run ? explainStatus(run) : null;
  const chip = run ? STATUS_CHIP[run.status] : null;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
          <AgentIcon color="primary" />
          <Typography variant="h6" sx={{ fontSize: 17 }}>
            Agent run
          </Typography>
          {chip && <Chip size="small" color={chip.color} label={chip.label} />}
          {run && <Chip size="small" variant="outlined" label={run.id} sx={{ fontFamily: 'monospace' }} />}
          {run && (
            <Typography variant="caption" color="text.secondary">
              {run.policy === 'llm' ? 'decides with the model, within the rails' : 'decides by the offline rules'} · started by {run.startedBy}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {preparer && !liveRun && (
            <Button size="small" variant="contained" startIcon={<PlayArrowIcon />} disabled={!settings?.enabled} onClick={() => setDialog('start')}>
              Start agent run
            </Button>
          )}
          {preparer && liveRun && !paused && liveRun.status !== 'needs_human' && (
            <ActionButton size="small" variant="outlined" startIcon={<PauseIcon />} action={act(agentApi.pause)}>
              Pause
            </ActionButton>
          )}
          {preparer && liveRun && (paused || liveRun.status === 'needs_human') && (
            <ActionButton size="small" startIcon={<PlayArrowIcon />} action={act(agentApi.resume)}>
              Resume
            </ActionButton>
          )}
          {user?.role === 'audit_manager' && liveRun && (
            <Button size="small" startIcon={<RaiseIcon />} onClick={() => setDialog('budget')}>
              Raise budget
            </Button>
          )}
          {preparer && liveRun && (
            <ActionButton
              size="small"
              variant="outlined"
              color="warning"
              startIcon={<StopIcon />}
              action={act(async (runId) => {
                if (!window.confirm('Cancel this run? Its open gates close unsigned. Work it has already drafted stays.')) return;
                await agentApi.cancel(runId);
              })}
            >
              Cancel run
            </ActionButton>
          )}
        </Stack>

        {settings && !settings.enabled && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            Agent runs are switched off on this server (AGENT_ENABLED=false). Existing runs stay as they are.
          </Alert>
        )}
        {!run && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            No agent run yet. A run drafts each stage in turn, has QA review it, and stops at each gate for a person to sign. It never signs, records test results or edits a reviewed finding.
          </Typography>
        )}
        {warnings.map((w) => (
          <Alert key={w} severity="warning" sx={{ mt: 1.5 }} onClose={() => setWarnings(warnings.filter((x) => x !== w))}>
            {w}
          </Alert>
        ))}
        {run && status && (
          <Alert severity={run.status === 'needs_human' || run.status === 'failed' ? 'warning' : 'info'} sx={{ mt: 1.5 }}>
            <Typography variant="body2">{status.text}</Typography>
            {status.next && (
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                <b>Next:</b> {status.next}
              </Typography>
            )}
          </Alert>
        )}
        {run && (
          <Grid container spacing={2} sx={{ mt: 0.5 }}>
            {spendRows(run).map((r) => (
              <Grid item xs={12} md={4} key={r.label}>
                <Typography variant="caption" color="text.secondary">
                  {r.label}
                </Typography>
                <LinearProgress variant="determinate" value={r.pct} color={r.pct >= 90 ? 'warning' : 'primary'} sx={{ my: 0.5 }} />
                <Typography variant="body2">
                  {r.used} of {r.limit}
                </Typography>
              </Grid>
            ))}
          </Grid>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            Could not refresh the agent run: {error}
          </Alert>
        )}
        {run && (
          <Box sx={{ mt: 1.5 }}>
            <Link component="button" variant="body2" onClick={() => setShowSteps(!showSteps)}>
              {showSteps ? 'Hide' : 'Show'} the run's {steps.length} steps
            </Link>
            <Collapse in={showSteps} unmountOnExit>
              <StepTimeline steps={steps} />
            </Collapse>
          </Box>
        )}
      </CardContent>

      {dialog === 'start' && settings && (
        <BudgetDialog
          title="Start an agent run"
          submitLabel="Start"
          initial={settings.budget}
          bounds={{ max: settings.budget }}
          intro={
            <>
              <Typography variant="body2">
                The agent drafts the scope, the RCM, test plans, findings and the report in turn. QA reviews each one, and the run stops at each gate for a person to sign. Its work is recorded as done on your behalf, so you cannot sign its gates yourself.
              </Typography>
              {user?.role === 'audit_manager' && (
                <Alert severity="warning">As the run's starter you cannot sign its scope or RCM gates: another audit manager must.</Alert>
              )}
              <Typography variant="body2" color="text.secondary">
                You may set a budget below the server's limits. Only an audit manager can raise it later.
              </Typography>
            </>
          }
          onSubmit={async (budget) => {
            const started = await agentApi.start(engagementId, budget);
            setWarnings(started.warnings);
            await refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'budget' && liveRun && (
        <BudgetDialog
          title="Raise the run's budget"
          submitLabel="Raise budget"
          initial={liveRun.budget}
          bounds={{ min: liveRun.budget }}
          intro={<Typography variant="body2">A run stopped by its budget resumes at once. The change is recorded in the audit trail.</Typography>}
          onSubmit={async (budget) => {
            await agentApi.raiseBudget(liveRun.id, budget);
            await refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Mount the panel on the engagement page**

In `frontend/src/pages/EngagementPage.tsx`:
- Add `import RunPanel from '../components/engagement/RunPanel';` and `import { useAgentRun } from '../components/engagement/useAgentRun';`.
- After `const STEPS = [...]`, add `const FINDINGS_TAB = 3;`.
- In `EngagementPage`, after the `useEffect` that calls `load()`, add:

```tsx
  // The agent run, its steps and gates; when the agent drafts something, the engagement is reloaded.
  const agent = useAgentRun(id!, load);
```

- Between the header `</Box>` and the stepper `<Card variant="outlined" sx={{ p: 2 }}>`, add:

```tsx
      <RunPanel engagementId={e.id} agent={agent} onSigned={load} showFindings={() => setTab(FINDINGS_TAB)} />
```

`useAgentRun` is called before the `if (!engagement) return null;` line, so hooks keep their order on every render.

- [ ] **Step 5: Run the checks**

Run (from `frontend/`): `npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: Check the panel in the app**

With the API (`npm run dev` in `backend/`), the worker (`npm run worker` in `backend/`) and the UI (`npm run dev` in `frontend/`) running, seed if needed. Then:
1. Sign in as the demo auditor, open an engagement with no scope, and press **Start agent run**. The panel shows Queued, then Working, then Waiting with "Waiting for a signature: scope gate signature".
2. The spend bars move, and **Show the run's steps** lists decision, delegate, QA and gate steps with their policy chips.
3. Press **Pause**: the status reads Paused, with Resume offered. Press **Resume**.
4. Sign in as the demo audit manager. The Start button is not shown for a live run, **Raise budget** opens a dialog, and lowering a value disables the button with "can only be raised".

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/engagement/useAgentRun.ts frontend/src/components/engagement/StepTimeline.tsx frontend/src/components/engagement/RunPanel.tsx frontend/src/pages/EngagementPage.tsx
git commit -m "feat(ui): Run panel with status, spend, controls and the step timeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Gates: the QA review for the signer, and Approve or Reject through the signing pop-up

**Files:**
- Create: `frontend/src/components/engagement/QaReportView.tsx`
- Create: `frontend/src/components/engagement/GateList.tsx`
- Modify: `frontend/src/components/engagement/RunPanel.tsx` (show the gates)
- Modify: `frontend/src/pages/EngagementPage.tsx` (`TabProps` gains `gates` and `qaThreshold`)
- Modify: `frontend/src/components/engagement/FindingsTab.tsx` (the open gate's QA report on each finding)

**Interfaces:**
- Consumes:
  - Task 6: `sortGates`, `gateSigning`, `openFindingGate`, `belowThreshold`, `subjectLabel`, `formatUtc`.
  - Task 7: `signGateWithReauth`, `openSigningWindow`.
  - Task 8: `AgentRunState`, `RunPanelProps` (`onSigned`, `showFindings`).
- Produces:
  - `<QaReportView report threshold />`, with props `{ report: QaReport; threshold: number | null }`.
  - `<GateList agent onSigned showFindings />`.
  - `TabProps.gates: Gate[]` and `TabProps.qaThreshold: number | null`.

- [ ] **Step 1: Show a QA report the way a signer reads it**

Create `frontend/src/components/engagement/QaReportView.tsx`:

```tsx
import { Alert, Box, Chip, Collapse, Link, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useState } from 'react';
import { belowThreshold } from '../../agents';
import type { QaReport } from '../../types';

/** A QA review as its signer sees it (REQ-30): the score, every issue (blocking first), and the rubric when a model scored one. */
export default function QaReportView({ report, threshold }: { report: QaReport; threshold: number | null }) {
  const [rubric, setRubric] = useState(false);
  const blocking = report.issues.filter((i) => i.severity === 'blocking');
  const advisory = report.issues.filter((i) => i.severity === 'advisory');
  const low = threshold !== null && belowThreshold(report, threshold);
  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
        <Typography variant="subtitle2">QA {report.mode === 'challenge' ? 'challenge' : 'review'}</Typography>
        <Chip size="small" color={blocking.length ? 'error' : low ? 'warning' : 'success'} label={`${report.score}/100`} />
        <Typography variant="caption" color="text.secondary">
          by {report.reviewer}
          {threshold !== null ? ` · threshold ${threshold}` : ''}
        </Typography>
        {report.withoutModel && <Chip size="small" variant="outlined" color="warning" label="automatic checks only: the model was unavailable" />}
      </Stack>
      {low && !blocking.length && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          QA scored this below the threshold of {threshold}. The gate opened because no issue is blocking. Read the issues before you sign.
        </Alert>
      )}
      {report.issues.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          No issues found.
        </Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
          {[...blocking, ...advisory].map((i, n) => (
            <li key={n}>
              <Typography variant="body2">
                <Chip size="small" variant="outlined" color={i.severity === 'blocking' ? 'error' : 'default'} label={i.severity} sx={{ mr: 1 }} />
                <b>{i.criterion}</b>: {i.detail}
              </Typography>
            </li>
          ))}
        </Box>
      )}
      {!!report.criteria?.length && (
        <>
          <Link component="button" variant="body2" onClick={() => setRubric(!rubric)} sx={{ mt: 0.5 }}>
            {rubric ? 'Hide' : 'Show'} the rubric ({report.criteria.length} criteria)
          </Link>
          <Collapse in={rubric} unmountOnExit>
            <Table size="small" sx={{ mt: 0.5 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Criterion</TableCell>
                  <TableCell width={80}>Score</TableCell>
                  <TableCell>Note</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {report.criteria.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{c.id}</TableCell>
                    <TableCell>{c.score} / 4</TableCell>
                    <TableCell>{c.note}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Collapse>
        </>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: List the gates, and sign the open ones**

Create `frontend/src/components/engagement/GateList.tsx`:

```tsx
import { Gavel as GavelIcon } from '@mui/icons-material';
import { Alert, Box, Button, Card, CardContent, Chip, Collapse, Divider, Link, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import { formatUtc, gateSigning, sortGates, subjectLabel } from '../../agents';
import { useSession } from '../../session';
import { openSigningWindow, signGateWithReauth } from '../../signing';
import type { Gate } from '../../types';
import { ActionButton } from '../common';
import QaReportView from './QaReportView';
import type { AgentRunState } from './useAgentRun';

const title = (g: Gate) => (g.kind === 'finding' ? `Finding ${g.subjectId}` : `${subjectLabel(g.subjectKey).replace(/^./, (c) => c.toUpperCase())} gate`);

function GateCard({ gate, agent, onSigned, showFindings }: { gate: Gate; agent: AgentRunState; onSigned: () => Promise<void>; showFindings: () => void }) {
  const { user } = useSession();
  const [comment, setComment] = useState('');
  const [waiting, setWaiting] = useState<AbortController | null>(null);
  const signing = gateSigning(gate, user, agent.runs);
  const sign = (action: 'approve' | 'reject') => async () => {
    // Open the window first, synchronously in the click, or the browser blocks it as a pop-up.
    const popup = openSigningWindow();
    const controller = new AbortController();
    setWaiting(controller);
    try {
      await signGateWithReauth(gate.id, action, comment, popup, { signal: controller.signal });
      setComment('');
    } finally {
      setWaiting(null);
      // Show what the server recorded, whatever happened here.
      await Promise.all([agent.refresh(), onSigned()]).catch(() => undefined);
    }
  };
  return (
    <Card variant="outlined" sx={{ borderLeft: 4, borderLeftColor: 'warning.main' }}>
      <CardContent>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          <GavelIcon fontSize="small" color="warning" />
          <Typography fontWeight={600}>{title(gate)}</Typography>
          <Chip size="small" variant="outlined" label={`attempt ${gate.attempt}`} />
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
            {gate.id} · opened {formatUtc(gate.openedAt)}
          </Typography>
        </Stack>
        {gate.qaReport && (
          <Box sx={{ mt: 1 }}>
            <QaReportView report={gate.qaReport} threshold={agent.settings?.qaThreshold ?? null} />
          </Box>
        )}
        <Divider sx={{ my: 1.5 }} />
        {waiting && (
          <Alert
            severity="info"
            sx={{ mb: 1.5 }}
            action={
              <Button color="inherit" size="small" onClick={() => waiting.abort()}>
                Cancel
              </Button>
            }
          >
            Waiting for you to confirm your identity in the sign-in window…
          </Alert>
        )}
        {gate.kind === 'finding' ? (
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
            <Typography variant="body2" color="text.secondary">
              {signing.note}
            </Typography>
            <Button size="small" onClick={showFindings}>
              Open Findings
            </Button>
          </Stack>
        ) : signing.canSign ? (
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
            <TextField size="small" placeholder="Comment (needed to reject)" value={comment} onChange={(e) => setComment(e.target.value)} sx={{ minWidth: 320 }} />
            <ActionButton size="small" color="success" disabled={!!waiting} action={sign('approve')}>
              Approve
            </ActionButton>
            <ActionButton size="small" color="warning" variant="outlined" disabled={!!waiting || !comment.trim()} action={sign('reject')}>
              Reject
            </ActionButton>
            <Typography variant="caption" color="text.secondary">
              {signing.note} A rejection goes back to the agent as its instruction.
            </Typography>
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {signing.note}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

/** The engagement's gates (agent spec §7.2): each open one with its QA review and signing; decided ones on request. */
export default function GateList({ agent, onSigned, showFindings }: { agent: AgentRunState; onSigned: () => Promise<void>; showFindings: () => void }) {
  const [history, setHistory] = useState(false);
  if (!agent.gates.length) return null;
  const { open, decided, superseded } = sortGates(agent.gates);
  return (
    <Stack spacing={1.5} sx={{ mt: 2 }}>
      <Typography variant="subtitle1" fontWeight={600}>
        Gates
      </Typography>
      {open.map((g) => (
        <GateCard key={g.id} gate={g} agent={agent} onSigned={onSigned} showFindings={showFindings} />
      ))}
      {!open.length && (
        <Typography variant="body2" color="text.secondary">
          No gate is open.
        </Typography>
      )}
      {(decided.length > 0 || superseded > 0) && (
        <Link component="button" variant="body2" onClick={() => setHistory(!history)} sx={{ alignSelf: 'flex-start' }}>
          {history ? 'Hide' : 'Show'} {decided.length} decided gate(s){superseded ? `; ${superseded} superseded (changed before anyone signed) not listed` : ''}
        </Link>
      )}
      <Collapse in={history} unmountOnExit>
        <Stack spacing={0.5}>
          {decided.map((g) => (
            <Typography key={g.id} variant="body2" color="text.secondary">
              {title(g)}, attempt {g.attempt}: <b>{g.state}</b>
              {g.closedAt ? ` ${formatUtc(g.closedAt)}` : ''}
              {g.comment ? ` — "${g.comment}"` : ''}
            </Typography>
          ))}
        </Stack>
      </Collapse>
    </Stack>
  );
}
```

- [ ] **Step 3: Show the gates in the Run panel**

In `frontend/src/components/engagement/RunPanel.tsx`:
- Add `import GateList from './GateList';`.
- Change `export default function RunPanel({ engagementId, agent }: RunPanelProps) {` to `export default function RunPanel({ engagementId, agent, onSigned, showFindings }: RunPanelProps) {`.
- Before the `{run && (` block that holds the steps link, add:

```tsx
        <GateList agent={agent} onSigned={onSigned} showFindings={showFindings} />
```

- [ ] **Step 4: Give the tabs the gates and the threshold**

In `frontend/src/pages/EngagementPage.tsx`:
- Change the types import to `import type { Engagement, Gate, TrailBundle } from '../types';`.
- Change `TabProps` to:

```tsx
export interface TabProps {
  engagement: Engagement;
  setEngagement: (e: Engagement) => void;
  run: (moduleId: string) => Promise<void>;
  /** The engagement's agent gates, for the QA review a finding's signer reads. */
  gates: Gate[];
  /** The QA score a gate's review should reach (agent settings); null until loaded. */
  qaThreshold: number | null;
}
```

- Change `const props: TabProps = { engagement: e, setEngagement, run };` to `const props: TabProps = { engagement: e, setEngagement, run, gates: agent.gates, qaThreshold: agent.settings?.qaThreshold ?? null };`.

- [ ] **Step 5: Show the open gate's QA review on each finding**

In `frontend/src/components/engagement/FindingsTab.tsx`:
- Add `import { openFindingGate } from '../../agents';` and `import QaReportView from './QaReportView';`.
- Change the types import to `import type { Engagement, Finding, Gate, SignOff } from '../../types';`.
- Change `function FindingCard({ f, ctx }: { f: Finding; ctx: CardContext }) {` to `function FindingCard({ f, ctx, gate, qaThreshold }: { f: Finding; ctx: CardContext; gate: Gate | null; qaThreshold: number | null }) {`.
- After the `{f.status === 'blocked' && ( … )}` block, add:

```tsx
        {gate?.qaReport && (
          <Alert severity="info" icon={false} sx={{ mt: 1.5 }}>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              The agent drafted this finding and opened a gate on it (attempt {gate.attempt}). Its QA review, for whoever signs:
            </Typography>
            <QaReportView report={gate.qaReport} threshold={qaThreshold} />
          </Alert>
        )}
```

- Change `export default function FindingsTab({ engagement: e, setEngagement, run }: TabProps) {` to `export default function FindingsTab({ engagement: e, setEngagement, run, gates, qaThreshold }: TabProps) {`.
- Change `<FindingCard key={f.id} f={f} ctx={ctx} />` to `<FindingCard key={f.id} f={f} ctx={ctx} gate={openFindingGate(gates, f.id)} qaThreshold={qaThreshold} />`.

- [ ] **Step 6: Run the checks**

Run (from `frontend/`): `npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 7: Check gate signing in the app**

With the API, the worker and the UI running as in Task 8 Step 6:
1. As the demo auditor, start a run and wait for "Waiting for a signature: scope gate signature". The Gates section shows the scope gate with its QA score, issues and `attempt 1`; the auditor sees "Awaiting signature by an audit manager."
2. Sign in as the demo audit manager. **Reject** stays disabled until a comment is typed. Type one and press **Reject**: the demo confirmation window opens. Confirm. The run redrafts the scope, and a new scope gate opens with `attempt 2`. The rejected one is listed under the decided gates with its comment.
3. **Approve** the new gate. The run moves on to the RCM.
4. Sign in as the demo audit manager again on an engagement whose run that manager started. The gate reads "You started this run, so someone else must sign its gates."
5. Once a finding gate opens, its card in the panel shows **Open Findings**, and the finding's card in the Findings tab shows the same QA review above the sign buttons.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/engagement/QaReportView.tsx frontend/src/components/engagement/GateList.tsx frontend/src/components/engagement/RunPanel.tsx frontend/src/pages/EngagementPage.tsx frontend/src/components/engagement/FindingsTab.tsx
git commit -m "feat(ui): gates with their QA review, signed through the Part 11 window; QA review on agent-drafted findings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: The Test plans tab, and each plan beside its field-work form

**Files:**
- Create: `frontend/src/components/engagement/TestPlansTab.tsx`
- Modify: `frontend/src/components/engagement/FieldworkTab.tsx` (the row's plan, read-only, above its form)
- Modify: `frontend/src/pages/EngagementPage.tsx` (the tab, between RCM and Fieldwork)

**Interfaces:**
- Consumes (Task 6): `agentApi.editTestPlan`, `planDraft`, `planPatch`, `PlanDraft`, `rowsAwaitingTests` and `formatUtc`. Also `TabProps` (Task 9), `canPrepare`, `useSession`, `ActionButton` and `RiskChip`.
- Produces: `<TestPlansTab {...TabProps} />`. `EngagementPage` tab order becomes Risk & scope, RCM, Test plans, Fieldwork & testing, Findings, Report, Audit trail, with `FINDINGS_TAB = 4`.

- [ ] **Step 1: Add the tab**

Create `frontend/src/components/engagement/TestPlansTab.tsx`:

```tsx
import { Alert, Card, CardContent, Chip, Grid, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import { api } from '../../api';
import { agentApi, formatUtc, planDraft, planPatch, rowsAwaitingTests, type PlanDraft } from '../../agents';
import type { TabProps } from '../../pages/EngagementPage';
import { canPrepare } from '../../roles';
import { useSession } from '../../session';
import type { Engagement, RcmRow, TestPlan } from '../../types';
import { ActionButton, RiskChip } from '../common';

const METHODS: TestPlan['selectionMethod'][] = ['random', 'all', 'judgemental'];

function PlanCard({ row, plan, engagementId, version, canEdit, onSaved }: {
  row: RcmRow;
  plan?: TestPlan;
  engagementId: string;
  version?: number;
  canEdit: boolean;
  onSaved: () => Promise<void>;
}) {
  const [d, setD] = useState<PlanDraft | null>(plan ? planDraft(plan) : null);
  const set = (k: keyof PlanDraft) => (ev: React.ChangeEvent<HTMLInputElement>) => d && setD({ ...d, [k]: ev.target.value });
  const result = plan && d ? planPatch(plan, d) : null;
  const problem = result && 'problem' in result ? result.problem : null;
  const patch = result && 'patch' in result ? result.patch : null;
  const dirty = !!patch && Object.keys(patch).length > 0;

  return (
    <Card variant="outlined" sx={{ borderLeft: 4, borderLeftColor: plan?.notTestedJustification ? 'warning.main' : 'grey.400' }}>
      <CardContent>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }} useFlexGap flexWrap="wrap">
          <Typography sx={{ fontFamily: 'monospace' }}>{row.controlId}</Typography>
          <Typography fontWeight={600} sx={{ flex: 1 }}>
            {row.control}
          </Typography>
          <RiskChip rating={row.riskRating} />
          <Chip size="small" variant="outlined" label={`RCM sample ${row.sampleSize}`} />
          {plan?.notTestedJustification && <Chip size="small" color="warning" label="Not to be tested" />}
        </Stack>
        {!plan || !d ? (
          <Typography variant="body2" color="text.secondary">
            No plan yet. An agent run drafts one for every RCM row, starting from the row's sample size and test steps.
          </Typography>
        ) : (
          <>
            <Grid container spacing={2}>
              <Grid item xs={12} md={6}>
                <TextField fullWidth size="small" label="Attribute tested" value={d.attribute} onChange={set('attribute')} disabled={!canEdit} />
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField fullWidth size="small" label="Population" value={d.population} onChange={set('population')} disabled={!canEdit} />
              </Grid>
              <Grid item xs={6} md={2}>
                <TextField fullWidth size="small" type="number" label="Sample size" value={d.sampleSize} onChange={set('sampleSize')} disabled={!canEdit} />
              </Grid>
              <Grid item xs={6} md={3}>
                <TextField select fullWidth size="small" label="Selection" value={d.selectionMethod} onChange={set('selectionMethod')} disabled={!canEdit}>
                  {METHODS.map((m) => (
                    <MenuItem key={m} value={m}>
                      {m}
                    </MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid item xs={12} md={7}>
                <TextField fullWidth size="small" multiline minRows={2} label="Evidence to request (one per line)" value={d.evidenceToRequest} onChange={set('evidenceToRequest')} disabled={!canEdit} />
              </Grid>
              <Grid item xs={12}>
                <TextField fullWidth size="small" multiline minRows={2} label="Procedure" value={d.procedure} onChange={set('procedure')} disabled={!canEdit} />
              </Grid>
              <Grid item xs={12}>
                <TextField
                  fullWidth
                  size="small"
                  multiline
                  label="Reason not to test this control"
                  helperText="Only a person can decide this, never the agent. A run waiting for field work then counts this control as done."
                  value={d.notTestedJustification}
                  onChange={set('notTestedJustification')}
                  disabled={!canEdit}
                />
              </Grid>
            </Grid>
            <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1.5 }} useFlexGap flexWrap="wrap">
              {canEdit && (
                <ActionButton
                  size="small"
                  variant="outlined"
                  disabled={!dirty}
                  action={async () => {
                    if (!patch) return;
                    await agentApi.editTestPlan(engagementId, row.id, patch, version);
                    await onSaved();
                  }}
                >
                  Save plan
                </ActionButton>
              )}
              {problem && <Typography variant="body2" color="warning.main">{problem}</Typography>}
              <Typography variant="caption" color="text.secondary">
                {plan.editedBy ? `Edited by ${plan.editedBy}${plan.editedAt ? ` at ${formatUtc(plan.editedAt)}` : ''}` : 'Drafted by the agent'}
              </Typography>
            </Stack>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Test plans for each RCM row (agent spec §7.2): drafted by the agent, edited by auditors. */
export default function TestPlansTab({ engagement: e, setEngagement }: TabProps) {
  const { user } = useSession();
  // The route returns the plan, not the engagement: reload it, or the next save would be refused as stale.
  const reload = async () => setEngagement(await api<Engagement>(`/engagements/${e.id}`));
  const awaiting = rowsAwaitingTests(e);
  const planned = e.rcm.filter((r) => e.testPlans[r.id]).length;
  return (
    <Stack spacing={2}>
      <Typography color="text.secondary">
        {planned} of {e.rcm.length} controls have a test plan. The agent drafts each plan from its RCM row, and you can change any of it. A plan you edited is kept as it is until its RCM row changes.
      </Typography>
      {!e.rcm.length && <Typography color="text.secondary">Generate the risk & control matrix first.</Typography>}
      {e.rcm.length > 0 && awaiting.length > 0 && (
        <Alert severity="info">
          {awaiting.length} control(s) still need a recorded test (in Fieldwork & testing) or a reason not to test them: {awaiting.join(', ')}.
        </Alert>
      )}
      {e.rcm.map((r) => {
        const plan = e.testPlans[r.id];
        return (
          <PlanCard
            key={`${r.id}-${plan?.rowHash ?? ''}-${plan?.editedAt ?? ''}`}
            row={r}
            plan={plan}
            engagementId={e.id}
            version={e.version}
            canEdit={canPrepare(user?.role)}
            onSaved={reload}
          />
        );
      })}
    </Stack>
  );
}
```

- [ ] **Step 2: Show each row's plan above its field-work form**

In `frontend/src/components/engagement/FieldworkTab.tsx`:
- Change the types import to `import type { Engagement, RcmRow, TestInput, TestPlan, TestResult } from '../../types';`.
- Change the `RowCard` signature to:

```tsx
function RowCard({ row, plan, input, result, engagementId, version, onSaved }: { row: RcmRow; plan?: TestPlan; input?: TestInput; result?: TestResult; engagementId: string; version?: number; onSaved: (e: Engagement) => void }) {
```

- After the header `</Stack>` (the one with `sx={{ mb: 1.5 }}`) and before `<Grid container spacing={2}>`, add:

```tsx
        {plan && (
          <Alert severity={plan.notTestedJustification ? 'warning' : 'info'} icon={false} sx={{ mb: 1.5 }}>
            <Typography variant="body2">
              <b>Test plan:</b> {plan.attribute} · sample {plan.sampleSize} ({plan.selectionMethod}) from {plan.population}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {plan.procedure}
            </Typography>
            {plan.evidenceToRequest.length > 0 && (
              <Typography variant="body2" color="text.secondary">
                Request: {plan.evidenceToRequest.join('; ')}
              </Typography>
            )}
            {plan.notTestedJustification && (
              <Typography variant="body2">
                <b>Not to be tested:</b> {plan.notTestedJustification}
              </Typography>
            )}
          </Alert>
        )}
```

- In `FieldworkTab`, add `plan={e.testPlans[r.id]}` to the `<RowCard … />` props.

- [ ] **Step 3: Put the tab between RCM and Fieldwork**

In `frontend/src/pages/EngagementPage.tsx`:
- Add `import TestPlansTab from '../components/engagement/TestPlansTab';`.
- Replace `const STEPS = ['Risk & scope', 'RCM', 'Fieldwork & testing', 'Findings', 'Report'];` and `const FINDINGS_TAB = 3;` with:

```tsx
const STEPS = ['Risk & scope', 'RCM', 'Test plans', 'Fieldwork & testing', 'Findings', 'Report'];
const FINDINGS_TAB = 4;
const TRAIL_TAB = STEPS.length;
```

- Replace the `done` line with:

```tsx
  const done = [e.scope.length > 0, e.rcm.length > 0, Object.keys(e.testPlans).length > 0, Object.keys(e.testResults).length > 0, e.findings.length > 0, !!e.report];
```

- Replace `{lastRun && tab < 5 && <GateSummary bundle={lastRun} />}` with `{lastRun && tab < TRAIL_TAB && <GateSummary bundle={lastRun} />}`.
- Replace the six `{tab === n && …}` lines with:

```tsx
      {tab === 0 && <ScopeTab {...props} />}
      {tab === 1 && <RcmTab {...props} />}
      {tab === 2 && <TestPlansTab {...props} />}
      {tab === 3 && <FieldworkTab {...props} />}
      {tab === FINDINGS_TAB && <FindingsTab {...props} />}
      {tab === 5 && <ReportTab {...props} />}
      {tab === TRAIL_TAB && <TrailTab {...props} />}
```

- [ ] **Step 4: Run the checks**

Run (from `frontend/`): `npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: Check the tab in the app**

With the API, the worker and the UI running as in Task 8 Step 6, take a run past the RCM gate:
1. The run waits with "Waiting for field work". **Test plans** lists a plan per control, each marked "Drafted by the agent".
2. Change a sample size and press **Save plan**. The card shows "Edited by auditor", and editing the plan again works without a version error.
3. Type spaces only as a reason not to test: **Save plan** stays disabled.
4. Give a real reason for one control and save. It moves out of the "still need" list. Once every other control has a recorded test in **Fieldwork & testing** (each row shows its plan above the form), the run moves on by itself.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/engagement/TestPlansTab.tsx frontend/src/components/engagement/FieldworkTab.tsx frontend/src/pages/EngagementPage.tsx
git commit -m "feat(ui): Test plans tab, and each plan beside its field-work form

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: The worker in Compose and in CI

**Files:**
- Modify: `docker-compose.yml` (a `worker` service; agent settings passed to the API)
- Modify: `backend/Dockerfile` (expose 3003; a comment on the healthcheck)
- Modify: `.github/workflows/ci.yml` (`images` job: check the Compose file and the worker entry point)

**Interfaces:**
- Consumes: `node dist/agents/worker-cli.js` and `WORKER_PORT` (Task 3); `/readyz` on the worker (Task 3).
- Produces: a Compose service `worker`, healthy when `http://127.0.0.1:3003/readyz` answers 200 inside its container. Plus two CI steps.

- [ ] **Step 1: Show the check fails today**

Run (from the repo root): `docker compose --env-file .env.example config --services | grep -x worker`
Expected: no output, exit 1: there is no `worker` service yet.

- [ ] **Step 2: Add the worker service, and pass agent settings to the API**

In `docker-compose.yml`, in the `backend` service's `environment`, after `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}`, add:

```yaml
      # Agent runs (docs/deploy/operations.md §7): the API starts them and shows them; the worker service runs them.
      AGENT_ENABLED: ${AGENT_ENABLED:-true}
      AGENT_MAX_STEPS: ${AGENT_MAX_STEPS:-}
      AGENT_MAX_TOKENS: ${AGENT_MAX_TOKENS:-}
      AGENT_MAX_COST_USD: ${AGENT_MAX_COST_USD:-}
      AGENT_QA_THRESHOLD: ${AGENT_QA_THRESHOLD:-}
```

After the `backend` service, add:

```yaml
  # The agent worker (agent spec §2): same image, its own process. It leases runs from Postgres, so more than one is
  # safe (docker compose up -d --scale worker=2). Probes and metrics on WORKER_PORT, inside the Compose network only.
  worker:
    image: audit-platform-backend:local
    build: ./backend
    restart: unless-stopped
    command: ['node', 'dist/agents/worker-cli.js']
    environment:
      WORKER_PORT: '3003'
      DATABASE_URL: postgres://audit:${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env - copy .env.example to .env first}@postgres:5432/audit
      NODE_ENV: ${NODE_ENV:-development}
      # Must match the API's: agent QA applies the same citation rules as the modules.
      ALLOW_UNVERIFIED_CITATIONS: ${ALLOW_UNVERIFIED_CITATIONS:-true}
      LLM_PROVIDER: ${LLM_PROVIDER:-offline}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      ANTHROPIC_MODEL: ${ANTHROPIC_MODEL:-}
      AGENT_ENABLED: ${AGENT_ENABLED:-true}
      AGENT_MAX_STEPS: ${AGENT_MAX_STEPS:-}
      AGENT_MAX_TOKENS: ${AGENT_MAX_TOKENS:-}
      AGENT_MAX_COST_USD: ${AGENT_MAX_COST_USD:-}
      AGENT_QA_THRESHOLD: ${AGENT_QA_THRESHOLD:-}
      AGENT_POLL_MS: ${AGENT_POLL_MS:-}
      AGENT_WORKER_CONCURRENCY: ${AGENT_WORKER_CONCURRENCY:-}
      AGENT_POLICY_MODEL: ${AGENT_POLICY_MODEL:-}
      AGENT_QA_MODEL: ${AGENT_QA_MODEL:-}
      AGENT_TEST_PLAN_MODEL: ${AGENT_TEST_PLAN_MODEL:-}
      AGENT_MODEL_TIMEOUT_MS: ${AGENT_MODEL_TIMEOUT_MS:-}
      AGENT_MODEL_PRICES: ${AGENT_MODEL_PRICES:-}
      METRICS_TOKEN: ${METRICS_TOKEN:-}
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    # An iteration in flight gets one lease (60 s) to finish before the container is killed.
    stop_grace_period: 75s
    # The image's own healthcheck is the API's port; the worker answers on 3003.
    healthcheck:
      test: ['CMD', 'wget', '-qO', '/dev/null', 'http://127.0.0.1:3003/readyz']
      interval: 5s
      retries: 30
    depends_on:
      migrate:
        condition: service_completed_successfully
```

- [ ] **Step 3: Note the worker in the image**

In `backend/Dockerfile`:
- Change `EXPOSE 3002` to `EXPOSE 3002 3003`.
- Change the healthcheck comment to:

```dockerfile
# Liveness only: readiness (/readyz) also checks the database and file storage. The agent worker
# (node dist/agents/worker-cli.js) answers on WORKER_PORT (3003) instead; Compose and Container Apps set its probes.
```

- [ ] **Step 4: Check both in CI**

In `.github/workflows/ci.yml`, in the `images` job, after the step `Build the web image`, add:

```yaml
      - name: Check the Compose file, the worker service included
        run: docker compose --env-file .env.example config --quiet
      - name: Check the agent worker's entry point is in the API image
        run: docker run --rm --entrypoint node audit-platform-backend:ci -e "require.resolve('/app/dist/agents/worker-cli.js')"
```

- [ ] **Step 5: Run the checks**

Run (from the repo root):

```bash
docker compose --env-file .env.example config --quiet && docker compose --env-file .env.example config --services | grep -x worker
docker build -t audit-platform-backend:ci backend
docker run --rm --entrypoint node audit-platform-backend:ci -e "require.resolve('/app/dist/agents/worker-cli.js')" && echo entry-ok
```

Expected: `worker`, then a successful build, then `entry-ok`.

- [ ] **Step 6: Check the worker comes up healthy in Compose**

Run (from the repo root, with a `.env` copied from `.env.example`):

```bash
docker compose up -d --build worker
for i in $(seq 1 30); do s=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q worker)"); [ "$s" = healthy ] && break; sleep 2; done; echo "$s"
docker compose exec worker wget -qO- http://127.0.0.1:3003/readyz; echo
docker compose logs worker | grep -m1 '"service":"audit-worker"'
docker compose stop worker
```

Expected: `healthy`; `{"ok":true,"checks":{"database":"ok","storage":"not configured","worker":"ok"}}`; one worker log line. `stop` returns within the grace period.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml backend/Dockerfile .github/workflows/ci.yml
git commit -m "feat(ops): agent worker Compose service, and CI checks for it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: Docs for operators and users, and everything CI runs

**Files:**
- Modify: `docs/deploy/azure.md` (§1, §5, §6, §7, §8)
- Modify: `docs/deploy/operations.md` (§1, §2, §4; new §7)
- Modify: `README.md` (feature table, quick start, a new agent section, running in production)
- Modify: `backend/.env.example` (agent and worker settings)

**Interfaces:**
- Consumes: everything above. Metric names (Task 2), `WORKER_PORT` and `service` (Task 3), the `verify` lines (Task 4), `/api/agents/settings` (Task 5), the Compose `worker` service (Task 11).
- Produces: documentation only.

- [ ] **Step 1: The worker Container App**

In `docs/deploy/azure.md`:
- In §1, after the `web` image bullet's sub-list, add a bullet:

```markdown
  - `worker` is the `api` image run as `node dist/agents/worker-cli.js`: the agent worker. It runs agent runs between gates and needs no image of its own.
```

- At the end of §5, add:

```markdown
The `worker` app (agent runs, agent spec §2):
- Same image as `api`, command `node dist/agents/worker-cli.js`. No external ingress. Add internal ingress on port 3003 only if Prometheus scrapes it through the ingress.
- Liveness probe `GET /healthz` and readiness probe `GET /readyz`, both on port 3003 (`WORKER_PORT`). Readiness fails once the worker starts shutting down.
- The same database login as the `api` app (`DATABASE_URL` for `audit_app`, a member of `audit_api`) and the same `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `ALLOW_UNVERIFIED_CITATIONS` and `AGENT_*` settings. The worker's QA applies the same citation rules as the API.
- `METRICS_TOKEN` is required in production, as for the API.
- Min replicas 1. More replicas are safe: each run is leased in Postgres (60-second lease, 15-second heartbeat), so two workers never work on one run. Each replica runs `AGENT_WORKER_CONCURRENCY` loops (default 2).
- Set the termination grace period to 90 seconds. On SIGTERM the worker finishes its current step within one lease, then exits; a step cut short is redone by another worker.
- Kill switch: `AGENT_ENABLED=false` on both apps. The API then refuses to start runs and the worker leases nothing. Existing runs stay as they are.
```

- In §6, replace the list with:

```markdown
1. `node dist/db/cli.js migrate`
2. `node dist/knowledge/packs-cli.js compile`
3. Deploy the new `api` revision.
4. Deploy the new `worker` revision, from the same image. It refuses to start while migrations are pending.
```

- In §7's table, change the `METRICS_TOKEN` row's rule to `required for the API server and the agent worker, at least 24 characters. The \`migrate\`, \`compile\`, \`verify\` and \`create-api-login\` commands do not need it`.
- Change the "Other settings" line to:

```markdown
Other settings: `LOG_LEVEL` (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`; default `info`), `TRUST_PROXY` (0 to 5; default 0), `DATABASE_SSL_CA_FILE`. Agent settings (both apps unless noted): `AGENT_ENABLED` (default `true`), `AGENT_MAX_STEPS` (200), `AGENT_MAX_TOKENS` (2000000), `AGENT_MAX_COST_USD` (25), `AGENT_QA_THRESHOLD` (70); worker only: `WORKER_PORT` (3003), `AGENT_POLL_MS` (3000), `AGENT_WORKER_CONCURRENCY` (2), `AGENT_POLICY_MODEL`, `AGENT_QA_MODEL`, `AGENT_TEST_PLAN_MODEL`, `AGENT_MODEL_TIMEOUT_MS` (120000), `AGENT_MODEL_PRICES`.
```

- In §8, change the **Logs** bullet's first sentence to "Log Analytics collects the API's and the worker's JSON stdout. Each line names its process in `service` (`audit-api` or `audit-worker`)." Then add a sentence: "Worker lines carry the agent run's id as `runId`." Change the **Metrics** bullet to:

```markdown
- **Metrics.** Prometheus (Azure Monitor managed Prometheus) scrapes `/metrics` on the API's internal address and on the worker's port 3003, both with `Authorization: Bearer <METRICS_TOKEN>`. Runs by status come from the API; step, token, cost, fallback and refusal counters come from the worker.
```

- [ ] **Step 2: The runbook**

In `docs/deploy/operations.md`:
- In §1, after the `/readyz` bullet, add:

```markdown
- The agent worker serves the same `GET /healthz` and `GET /readyz` on `WORKER_PORT` (default 3003). Its readiness has `database` and `worker` checks (`worker: stopping` once shutdown has begun, which answers 503); `storage` reads `not configured`.
```

- In §2, after the first paragraph, add "The worker serves its own `/metrics` on its port, with the same token." Then append these rows to the table:

```markdown
| `audit_agent_runs{status}` | Agent runs in each status (`running`, `runnable`, `waiting`, `needs_human`, `completed`, `cancelled`, `failed`). From the API, read from the database at each scrape. |
| `audit_agent_step_duration_seconds{kind}` | Histogram of committed agent steps by kind (`decision`, `delegate`, `tool_call`, `qa`). Worker. |
| `audit_agent_tokens_total{agent,model,kind}` | Model tokens charged to committed agent steps. Worker. A step that failed after a paid call is in the run's spend and in `audit_llm_tokens_total`, not here. |
| `audit_agent_cost_usd_total{agent,model}` | Model cost in USD charged to committed agent steps, at the configured prices. Worker. |
| `audit_agent_policy_fallbacks_total{reason}` | Decisions the rules took over from the model policy: `off_menu`, `malformed`, `model_error`. Worker. |
| `audit_agent_guard_refusals_total{source}` | `source="rails"`: the executor guards refused an agent action (spec §5.4); the run is handed to a person. `source="model_request"`: a lookup a model asked for was off its allow-list or malformed, and was skipped. Worker. |
```

- Append to the suggested alerts:

```markdown
- Any increase of `audit_agent_guard_refusals_total{source="rails"}`: the rails stopped an agent action. That is a bug or a hostile input; read the run's steps.
- `audit_agent_runs{status="needs_human"}` above 0 for more than a working day: a run is waiting for a person (see §7).
- `audit_agent_policy_fallbacks_total` rising faster than 10 per hour, or `audit_llm_fallbacks_total{kind="deterministic"}` rising while runs are working: the model is failing or answering off the menu.
- `increase(audit_agent_cost_usd_total[1d])` above the client's daily agent budget.
- The worker's readiness failing, or no worker scrape target up while `audit_agent_runs{status="runnable"}` is above 0.
```

- In §4, replace the JSON example with:

```json
{
  "ok": true,
  "trail": { "valid": true, "length": 128, "brokenAt": null, "reason": null },
  "signatures": { "checked": 9, "problems": [] },
  "agents": { "checked": 64, "problems": [] },
  "documents": { "checked": 14, "problems": [], "skipped": null }
}
```

- In §4, append to the **Signatures** list:

```markdown
  - "Gate <id> is approved|rejected, but its signature … is missing", "… is for different content than the gate showed", "… carries <meaning>, not <expected>", "… was made for a different gate|finding": a gate and the signature that closed it disagree. One of them was edited outside the application.
  - "Gate <id> is open|superseded, but names signature <sig>": a gate nobody decided names a signature.
```

- In §4, after the **Signatures** list, add:

```markdown
- **Agents** (each line starts `Step <runId>#<seq> (<kind>)`):
  - "has no trail entry": a decision, delegation or QA review is not in the audit trail.
  - "its trail entry <id> is missing": the bundle the step names is gone.
  - "is at or after the break in the chain": the step's bundle is not vouched for by the hash chain; investigate the trail break first.
  - "is not an agent's entry for this run": the step points at a bundle written by someone else, or for another run.
```

- Append a new section:

```markdown
## 7. Agent runs

- **Where.** The Run panel on each engagement shows a run's status and reason, spend against budget, every step (with who decided it and any fallback to the rules), and its gates. `GET /api/runs/<id>` returns the same data.
- **Logs.** Every line the worker writes while working on a run carries `runId`. In Log Analytics: `ContainerAppConsoleLogs_CL | where Log_s has '"runId":"AR-…"'`.
- **Kill switch.** Set `AGENT_ENABLED=false` on both apps and roll them. No run can start and no worker leases a run; runs keep their status and resume when it is turned back on.
- **A run that needs a person** (`needs_human`; the panel says why and what to do):
  - `budget_exhausted: …`: an audit manager raises the budget in the panel, and the run resumes.
  - `gate_rejected_twice: …`: edit the workpaper or finding by hand, then press Resume. It goes through QA and a fresh gate.
  - `agent_forbidden: …`: the rails refused an action. Read the run's last steps, then resume or cancel, and report it: the rails should never need to.
  - `error: …`: three iterations in a row failed. Find the cause in the worker's logs by `runId`, fix it, then resume.
- **A run that waits** for test results or a gate signature moves on by itself when the test is recorded, when a reason not to test is given in Test plans, or when the gate is signed.
- **A worker that stops mid-step.** Another worker takes the run once its 60-second lease expires. The abandoned step counts as a failed one, and three in a row hand the run to a person.
- **Scaling.** Run more worker replicas, or raise `AGENT_WORKER_CONCURRENCY`. Each worker needs `AGENT_WORKER_CONCURRENCY × 2 + 2` database connections.
```

- [ ] **Step 3: The README**

In `README.md`:
- In the "What is in the MVP" table, after the "Module orchestration" row, add:

```markdown
| Supervised autopilot | `backend/src/agents/*`, Run panel | A supervisor agent runs the chain within code-enforced rails, QA-reviews each workpaper, and stops at human gates signed under Part 11; offline rules or Claude |
```

- In the quick start, after the UI block's `npm run dev         # open http://localhost:5174` line and before the closing fence, add:

```bash

# Agent worker (runs agent runs between gates), in a third terminal
cd backend
npm run worker
```

- In the Compose paragraph, change "then starts the API and the UI on" to "then starts the API, the agent worker and the UI on".
- After the "Using Claude for drafting" section, add:

```markdown
## Agent runs (supervised autopilot)

An auditor can hand an engagement to the agent: **Start agent run** on the engagement page. The agent drafts the scope, then the RCM, then a test plan for every control. QA reviews each workpaper, and the run stops at a gate for a person to sign:

- The scope and RCM gates are signed by an audit manager, and the report gate by the Chief Audit Executive, through the same Part 11 re-authentication window as findings. Whoever started the run cannot sign its gates.
- A rejection's comment goes back to the agent as its instruction. A second rejection of the same workpaper hands the run to a person.
- Testing stays human. The run waits until every control has a recorded test or a person's reason not to test it (the **Test plans** tab), then moves on by itself.
- Findings are drafted, QA-reviewed and gated one by one. They are signed as before in the Findings tab, which shows the agent's QA review.

The agent never signs, records a test result, or edits a reviewed finding: those are code checks, whatever a model says. With `LLM_PROVIDER=offline` it decides by deterministic rules. With `anthropic` the model chooses from the same menu of allowed actions and drafts with Claude, and every call is charged to the run's budget (`AGENT_MAX_STEPS`, `AGENT_MAX_TOKENS`, `AGENT_MAX_COST_USD`) before it is made. The worker is its own process (`npm run worker`; in production `node dist/agents/worker-cli.js`), and `AGENT_ENABLED=false` switches agent runs off.
```

- In "Running in production", add a bullet after the release-order bullet:

```markdown
- **Agent worker:** run the API image a second time as `node dist/agents/worker-cli.js`, after the API (see azure.md §5). Its probes and metrics are on `WORKER_PORT` (3003). `AGENT_ENABLED=false` on both is the kill switch.
```

- In "Running in production", change the integrity-check bullet's "checks the trail, the signatures and every stored file" to "checks the trail, the signatures and gates, every agent step's trail entry and every stored file".

- [ ] **Step 4: The settings file**

In `backend/.env.example`, after `# ANTHROPIC_API_KEY=`, add:

```bash

# ---- Agent runs (npm run worker runs them) ----
# Kill switch: false refuses new runs, and the worker leases nothing
# AGENT_ENABLED=true
# A run's budget ceiling (a starter may lower it; an audit manager may raise it later)
# AGENT_MAX_STEPS=200
# AGENT_MAX_TOKENS=2000000
# AGENT_MAX_COST_USD=25
# QA score a workpaper should reach before its gate (0-100)
# AGENT_QA_THRESHOLD=70
# Worker: probes and metrics port, polling interval, loops per worker
# WORKER_PORT=3003
# AGENT_POLL_MS=3000
# AGENT_WORKER_CONCURRENCY=2
# Models per agent role, and price overrides (JSON, USD per million tokens)
# AGENT_POLICY_MODEL=claude-sonnet-5-5
# AGENT_QA_MODEL=claude-opus-5-5
# AGENT_TEST_PLAN_MODEL=claude-sonnet-5-5
# AGENT_MODEL_TIMEOUT_MS=120000
# AGENT_MODEL_PRICES={"claude-opus-5-5":{"inputPerMTok":4,"outputPerMTok":20}}
```

- [ ] **Step 5: Run everything CI runs**

Run (each block from the directory named):

```bash
# backend/
npm ci
npm run typecheck
npm test
ALLOW_UNVERIFIED_CITATIONS=true npm run eval
npm run traceability
npm audit --omit=dev --audit-level=high

# frontend/  (CI installs backend first: the UI imports the backend's types)
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high

# repo root
docker build -t audit-platform-backend:ci backend
docker build -f frontend/Dockerfile -t audit-platform-frontend:ci .
docker run --rm --add-host backend:127.0.0.1 audit-platform-frontend:ci sh -c '/docker-entrypoint.sh nginx -t && grep -q "proxy_pass http://backend:3002;" /etc/nginx/conf.d/default.conf && grep -q "X-Request-Id \$request_id;" /etc/nginx/conf.d/default.conf'
docker compose --env-file .env.example config --quiet
docker run --rm --entrypoint node audit-platform-backend:ci -e "require.resolve('/app/dist/agents/worker-cli.js')"
```

Expected:
- Every command exits 0.
- `npm test` (backend) reports all files passing, including the new `agent-metrics`, `worker-process` and the extended `verify`, `gates`, `probes`, `config`, `agents-http`, `anthropic-provider` and `agent-models` files.
- The eval passes every case, and the traceability matrix has no uncovered requirement.
- If `trivy` is installed, also run `trivy image --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1` on both images.

- [ ] **Step 6: Commit**

```bash
git add docs/deploy/azure.md docs/deploy/operations.md README.md backend/.env.example
git commit -m "docs: agent worker Container App, agent metrics and alerts, the agent runbook, and agent runs in the README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
