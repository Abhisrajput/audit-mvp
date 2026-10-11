# Production Foundation — Design Spec

- **Status:** Draft for review
- **Date:** 2026-10-11
- **Sub-project:** 1 of 7 (see [Roadmap](#roadmap))
- **Supersedes:** the MVP's JSON file store, demo user switcher and JSON content packs

## 1. Purpose and context

The MVP proves the engine pattern: chained modules, runtime QA gates, a hash-chained
audit trail, content packs and an evaluation harness. It is not usable on a live
client audit. Data is one JSON file with no transactions or concurrency control,
identity is a hard-coded user switcher, evidence is a text reference, and there is
no deployment, backup or monitoring story.

This sub-project makes the platform production-grade so that every later
sub-project (agent orchestration, evidence, issues, planning, reporting, knowledge
graph expansion) builds on real persistence, real identity and a governed
knowledge store.

### 1.1 Agreed intent

| | |
|---|---|
| **Milestone** | Pilot with one real client on a live audit |
| **Client industry** | Unknown, so design to pharma-grade rigor (21 CFR Part 11, EU Annex 11, ALCOA+) so any vertical fits |
| **Hosting** | Reference target is the client's Azure tenant. Must stay cloud-neutral: Docker, Postgres, S3-compatible or Azure Blob storage, any OIDC identity provider |
| **Stack** | Keep this TypeScript engine as the product (Express API, React UI). Teams or Copilot Studio can later be a thin front door calling this API |
| **Lifecycle scope (whole programme)** | Audit universe, annual plan, engagements, issue follow-up, committee reporting, run by a supervised agent layer |
| **Agent direction** | Supervised autopilot. A supervisor agent runs the engagement chain within code-enforced rails and stops at fixed human gates. Designed in sub-project 2; this spec provides its persistence |
| **Knowledge** | Agents cite a governed source of truth, never model memory. Content is authored as Open Knowledge Format (OKF) bundles and compiled into a Postgres knowledge graph |

**Assumptions.** Single client per deployment, not multi-tenant SaaS. 5–30 users in the
pilot. The platform remains an audit execution layer. It may track issues itself but
still writes findings back to a client QMS/GRC on request.

### 1.2 Success criteria

1. Users sign in with the client's identity provider. No shared or demo accounts exist in production.
2. All state lives in Postgres. Every write is transactional. Concurrent edits are detected (409), never silently overwritten.
3. The trail and signatures are append-only, enforced by the database, and the trail hash chain verifies after any restore.
4. Finding sign-off meets Part 11 §11.50, §11.70 and §11.200: re-authentication at signing, a signature linked to the signed content, and the meaning manifested.
5. Segregation of duties: preparer, reviewer and approver of a finding are three different people.
6. Content packs are OKF bundles in git. Only human-verified, non-stale concepts are citable.
7. Knowledge retrieval is filtered by the requesting user's access inside the query.
8. The stack deploys from container images with config from the environment, health and readiness probes, metrics, and documented backup and restore.
9. All existing tests and 25/25 eval cases still pass. New requirements are traced to tests in the generated traceability matrix.

### 1.3 Out of scope

Evidence upload UI and text extraction (sub-project 3), issues (4), universe and
planning (5), committee reporting (6), embeddings, SOP extraction and expert review UI
(7), the supervisor agent and its tools (2), multi-tenancy, cloud-specific
infrastructure-as-code, and IQ/OQ execution scripts.

## 2. Architecture

```
 React UI (OIDC session cookie + CSRF) ──► Express API (thin routes, zod-validated)
                                              │
                                              ▼
                                     AuditService (async)
                       one transaction per mutating request:
              lock row → load → engine logic → write state + trail → commit
                     │                 │                     │
                     ▼                 ▼                     ▼
              Engine (unchanged:   Retriever interface   BlobStore interface
              modules, QA gates,   ├ pack BM25 (memory)  ├ S3-compatible
              trail hashing,       ├ Postgres FTS        ├ Azure Blob
              LLM router)          └ vector (later)      └ local FS (dev)
                     │                 │
                     ▼                 ▼
               Postgres 16 + pgvector  (Kysely, plain SQL migrations)
```

- `src/engine/*` is unchanged apart from the trail's append moving to the database
  and the citation gate learning the knowledge-graph trust rules (§6.4).
- `Store` is replaced by a `Db` module: a Kysely instance plus repositories for
  engagements, findings, signatures, trail, users, documents and the knowledge graph.
- `AuditService` methods become async and take a transaction handle. Behaviour,
  error semantics and role checks are preserved. Segregation of duties is tightened (§4.3).

## 3. Data model

Postgres 16 with the `pgvector` extension. Kysely for typed queries. Migrations are
plain, reviewed `.sql` files in `backend/migrations/`, applied by `api migrate`,
never at server start-up.

### 3.1 Hybrid model

Real tables for whatever later sub-projects query across engagements or must protect
with constraints. Engine working output stays as JSONB.

| Table | Holds | Integrity |
|---|---|---|
| `users` | `id`, `issuer`, `subject`, `name`, `email`, `role` (nullable until assigned), `active`, timestamps | Unique (`issuer`, `subject`). Never deleted, only deactivated |
| `sessions` | Server-side session, user, CSRF secret, created, last-seen, revoked | Idle timeout 30 min, absolute 12 h |
| `engagements` | Header fields (name, entity, site, period, audit type, scope statement, pack IDs), `stage`, `created_by`, `created_at`, `version` | Optimistic version checked on every write; mismatch → `VERSION_CONFLICT` (409) |
| `engagement_work` | 1:1 with engagement. JSONB `scope`, `rcm`, `test_inputs`, `test_results`, `report` | Written in the same transaction as `engagements` |
| `findings` | 5 C's, `rating`, `status`, `control_id`, `citations` (JSONB), `evidence_refs`, `blocked_reasons`, `bundle_id`, `prepared_by`, `version` | Status transitions enforced in the service. Trigger rejects UPDATE of `approved` rows |
| `signatures` | `finding_id`, `user_id`, `role`, `meaning`, `comment`, `signed_at`, `content_hash`, `reauth_method`, `reauth_at` | Append-only: trigger rejects UPDATE and DELETE |
| `trail` | All current `TrailBundle` fields as columns or JSONB, `seq` (unique), `prev_hash`, `hash`, `request_id` | Append-only trigger. Appends serialised by a transaction-scoped advisory lock so the chain cannot fork |
| `agent_runs` | Supervisor run per engagement goal: `engagement_id`, `goal`, `status`, `policy_version`, `budget` (JSONB), `started_by`, timestamps | Append-only for terminal states. Shape fixed now; populated by sub-project 2 |
| `agent_steps` | `run_id`, `seq`, `kind` (`delegate` / `decision` / `tool_call` / `qa`), `agent`, typed `decision` (JSONB: decision, rationale, inputs, alternatives), `model`, `tokens_in`, `tokens_out`, `cost`, `trail_bundle_id` | Append-only |
| `gates` | `engagement_id`, `run_id`, `kind` (`scope` / `rcm` / `finding` / `report`), `subject_id`, `state` (`open` / `approved` / `rejected`), `signature_id` | State moves only `open` → terminal, with a signature |
| `documents` | §5.2 | §5.2 |
| `document_text`, `chunks` | §5.2 | §5.2 |
| `kg_nodes`, `kg_edges` | §6 | §6 |

### 3.2 Signatures bind content

`content_hash` = SHA-256 of the canonical JSON (existing `canonicalJson`) of the
finding's signable fields at signing time. On read, a signature whose hash no longer
matches is shown as **broken**. Editing a finding still resets it to draft (existing
behaviour), so a broken signature can never count towards approval. This meets §11.70.

### 3.3 Transactions and concurrency

Each mutating request:

1. `BEGIN`
2. `SELECT … FOR UPDATE` the engagement row and check `version`
3. Load the working state
4. Run engine logic
5. Write the state, bump `version`, append the trail under the advisory lock
6. `COMMIT`

Any failure rolls back everything, including the trail entry. Read-only requests do
not lock.

### 3.4 Migration from the MVP

`npm run import-json -- <db.json>` imports an existing MVP file. It verifies the
source chain first, keeps the original `seq` and hashes, and refuses to import a
broken chain. Demo users become `DEV_AUTH` users. `npm run seed` writes to Postgres.

## 4. Identity, roles and e-signatures

### 4.1 Authentication

- OIDC authorization-code flow with PKCE via `openid-client`. The backend exchanges
  the code, so tokens never reach the browser.
- The browser holds an httpOnly, `Secure`, `SameSite=Strict` session cookie. Every
  mutating request also needs a CSRF token (double-submit).
- Any OIDC provider works: Entra ID (reference), Okta, Cognito, Keycloak, Google.
  SAML-only clients connect through their provider's OIDC bridge.
- `DEV_AUTH=true` enables a login picker for development and tests. The server
  refuses to start with `DEV_AUTH=true` and `NODE_ENV=production`.
- `docker compose --profile sso` adds Keycloak to test the real flow locally.

### 4.2 Roles

One role per user, mapped from a configurable identity-provider group claim and
overridable by an admin.

| Role | May |
|---|---|
| `auditor` | Create engagements, run modules, edit scope, tests and findings (preparer) |
| `audit_manager` | Everything `auditor` may, plus sign findings as **Reviewed** |
| `cae` | Sign findings as **Approved** or **Rejected**; release reports |
| `admin` | Users, role overrides, sessions, group mapping. No audit content |
| `viewer` | Read-only |

New users are provisioned on first login with no role and see a "pending access"
page. `auditee` and `action_owner` are added in sub-project 4. The current
`reviewer` maps to `audit_manager` and `approver` maps to `cae`.

### 4.3 Segregation of duties

Enforced by user identity on each finding:

- The preparer (`prepared_by`, and anyone who edited it since the last reset) cannot review or approve it.
- The reviewer cannot approve it.

Violations return `SOD_VIOLATION`. This closes the MVP gap where only
approver ≠ reviewer was checked.

### 4.4 Part 11 signing flow

1. User clicks **Sign** and chooses a meaning. The UI calls `POST /api/sign/intents`
   with `{findingId, meaning, comment}`. The server stores a one-time intent
   `{nonce, userId, findingId, contentHash, meaning, expiresAt (+5 min)}`.
2. A popup starts an OIDC request with `prompt=login`, `max_age=0`, and the intent
   nonce as `nonce`/`state`.
3. The callback verifies:
   - the ID token's `nonce` matches the intent
   - `sub` is the same user
   - `auth_time` is no more than 120 s ago
   - the intent is unexpired and unused
   - the finding's current content hash still equals the intent's `contentHash`
4. On success, in one transaction: write the `signatures` row, update the finding
   status, resolve any `gates` row, append the trail.
5. The signature manifestation (full name, meaning, UTC time) appears in the UI, the
   report and the CSV export (§11.50).

Failures (`REAUTH_REQUIRED`, `REAUTH_STALE`, `REAUTH_USER_MISMATCH`,
`INTENT_EXPIRED`, `CONTENT_CHANGED`) are trailed and rate-limited. Password policy,
lockout and MFA are the identity provider's responsibility and are recorded as client
controls in the validation package.

### 4.5 Session and identity events

Login, logout, session revocation, role change, deactivation and failed signing
attempts are appended to the trail with `engagement_id = null`.

## 5. Storage and documents

### 5.1 BlobStore

```ts
interface BlobStore {
  put(bytes: Buffer | Readable, meta: { mime: string }): Promise<{ sha256: string; size: number }>;
  get(sha256: string): Promise<Readable>;
  head(sha256: string): Promise<{ size: number } | null>;
  presignedGet(sha256: string, ttlSeconds: number): Promise<string>;
}
```

- Objects are content-addressed: `sha256/<first 2 hex>/<sha256>`. `put` hashes while
  streaming and is idempotent.
- Implementations:
  - `S3BlobStore` (AWS S3, MinIO, GCS interop) with S3 Object Lock where enabled
  - `AzureBlobStore` (`@azure/storage-blob`) with container time-based retention
  - `LocalBlobStore` for dev and tests only
- Chosen by `BLOB_DRIVER`.

### 5.2 Document registry

| Table | Columns |
|---|---|
| `documents` | `id`, `sha256`, `filename`, `mime`, `size`, `kind` (`evidence` / `sop` / `policy` / `prior_report` / `regulation` / `okf_concept` / `other`), `classification` (`internal` / `confidential` / `restricted`), `engagement_id` (nullable), `uploaded_by`, `uploaded_at`, `retain_until`, `retention_expired` (bool), `metadata` (JSONB). Rows are never deleted |
| `document_text` | `document_id`, `extractor`, `extractor_version`, `text`, `pages` (JSONB page offsets) |
| `chunks` | `id`, `document_id` or `kg_node_id`, `ordinal`, `page`, `text`, `tsv` (generated `tsvector`), `embedding vector` (nullable, dimension fixed when an embedding model is chosen), and copies of `classification` and `engagement_id` for filtering |

The foundation creates these tables and the APIs to register a stored blob as a
document. Upload UI and text extraction belong to sub-project 3.

## 6. Knowledge: OKF bundles compiled into a Postgres knowledge graph

### 6.1 Principle

Agents and modules cite a governed source of truth, never model memory. Knowledge
lives in three layers:

| Layer | What | Role |
|---|---|---|
| Authoring and interchange | **OKF v0.2 bundles** in git, one per content pack | Domain experts review Markdown. Pull requests are change control. Portable to other agent platforms |
| Runtime source of truth | **Postgres knowledge graph** (`kg_nodes`, `kg_edges`) plus `chunks` | Bundles are compiled at load. Queries are permission-filtered |
| Access | `Retriever` and graph queries | Agents only see what these return; the citation gate checks it |

Graphify is a development-time tool only, for exploring this repo or a client's
document dump during discovery. It is not part of the runtime.

### 6.2 Bundle layout

```
backend/packs/<pack-id>/
  pack.md                         # type: pack — id, name, version, vertical, disclaimer
  regulations/<slug>.md           # type: regulation
  clauses/<clause-id>.md          # type: clause
  controls/<control-id>.md        # type: control
  risks/<slug>.md                 # type: risk (optional; MVP risks stay inline on controls)
  eval/<case-id>.md               # type: eval_case
```

Concept frontmatter uses OKF fields (`type`, `title`, `description`, `tags`,
`sources`, `generated`, `verified`, `status`, `stale_after`) plus audit extensions:

```yaml
---
type: control
title: Quality unit authority and responsibilities are defined and exercised
tags: [quality unit, QA, independence]
sources: [{ ref: "/clauses/21cfr211-22.md" }, { ref: "/clauses/schm-pqs.md" }]
generated: { by: "mvp-pack-migration", at: "2026-10-11" }
verified: null                    # { by: "<reviewer>", at: "<date>", role: "Pharma QA SME" }
status: active                    # active | deprecated
stale_after: 2027-10-11
x_audit:
  id: PH-QU-01
  process_area: Quality system
  risk: Product released without independent quality oversight.
  risk_rating: High
  type: Preventive
  nature: Manual
  frequency: Annual
  clause_refs: [21CFR211.22, SCHM-PQS]
  evidence_expected: [Quality manual, Organisation chart, Release records]
---
## Objective
…
## Test of design
- …
## Test of effectiveness
- …
## Checklist
- …
## Recommendation
…
```

Markdown links between concepts become edges. Audit extensions live under one
`x_audit` key so OKF readers ignore them cleanly.

### 6.3 Graph tables and compilation

- `kg_nodes`: `id` (`<pack>/<type>/<name>`), `type`, `pack_id`, `pack_version`,
  `title`, `body`, `attrs` (JSONB, from `x_audit`), `generated`, `verified_by`,
  `verified_at`, `status`, `stale_after`, `source_path`, `source_sha256`, `classification`.
- `kg_edges`: `from_id`, `to_id`, `rel` (`cites` / `mitigates` / `tests` /
  `evidences` / `relates_to` / …), `origin` (`curated` / `engagement` / `proposed`),
  `created_by`, `source_ref` (document, page, clause), `approved_by`, `approved_at`.
- `npm run packs:compile` (and API start-up in dev) does the following:
  - parses the bundles
  - validates them against a zod schema (same rules as today's `PackSchema`, plus OKF fields)
  - rejects links to unknown concepts
  - upserts nodes and edges inside one transaction, versioned by `pack_version`
  - writes a chunk per node for search

  Production loads only bundles at a pinned pack version.
- `npm run packs:migrate` converts the three MVP `pack.json` files to OKF bundles once.
  Every concept gets `verified: null` (honest: the README states these are unreviewed
  drafts), and `stale_after` is migration date + 12 months.
- `PackRegistry` keeps its public shape and is built from `kg_nodes`, so modules and
  the BM25 index are unaffected.

### 6.4 Trust rules (enforced by the citation gate)

A knowledge node is **citable** in a finding, RCM row or report only if all of these hold:

- `verified_by` is set (a human reviewer)
- `status = 'active'`
- `stale_after` is in the future, or null

Otherwise:

- Generated-but-unverified nodes may be **retrieved** to guide work, but citing one
  makes the gate emit `UNVERIFIED_SOURCE`. The output is **blocked** in production,
  or **warned** when `ALLOW_UNVERIFIED_CITATIONS=true`. That flag is allowed only
  outside production, so the demo works before expert review.
- Stale nodes produce `STALE_SOURCE` warnings and appear in an admin "due for
  re-review" list.
- `proposed` edges are never citable until approved.

The gate also checks that each cited node or chunk ID appears in that run's recorded
retrieval set. This extends the existing REQ-03 rule from clauses to every knowledge node.

### 6.5 Retriever

```ts
interface Retriever {
  search(q: string, opts: { user: User; engagementId?: string; kinds?: string[]; limit?: number }): Promise<Hit[]>;
}
interface Hit { id: string; kind: 'kg_node' | 'chunk'; title: string; snippet: string; score: number; citation: Citation; citable: boolean }
```

Implementations:

- `PackBm25Retriever`: in-memory, today's behaviour, used by the eval harness
- `PgFtsRetriever`: `tsvector` over `chunks`
- `PgVectorRetriever`: sub-project 7

Permission filtering runs in SQL: a chunk is visible only if its classification is
allowed for the user's role and its `engagement_id` is null or one the user may
access. Every search is recorded in the trail's retrieval set.

## 7. Deployment and operations

### 7.1 Artefacts

- `api` image: Node 22, non-root, read-only root filesystem. Commands: `serve`, `migrate`, `packs:compile`, `verify`.
- `web` image: nginx serving the built UI and proxying `/api`.
- Docker Compose: `postgres` (pgvector image), `minio`, `api`, `web`; profile `sso` adds `keycloak`.

### 7.2 Reference Azure deployment (documented, not scripted)

- Entra ID app registration (OIDC)
- Azure Container Apps for `api` and `web`
- Azure Database for PostgreSQL Flexible Server with the `vector` extension allow-listed
- Storage account with container immutability (time-based retention) and versioning
- Azure OpenAI, or Claude via Microsoft Foundry, behind the existing `LlmProvider`
- Key Vault-backed secrets as environment variables
- Log Analytics for logs and metrics

The same `.env` contract maps to AWS ECS or Kubernetes.

### 7.3 Configuration

All configuration comes from environment variables, validated by zod at start-up; on
failure the server exits. Secrets come from the environment or a mounted file. The
database connection requires TLS when `NODE_ENV=production`.

### 7.4 Backup, restore, verification

The deployment guide requires:

- Postgres point-in-time recovery for 30 days
- storage versioning and retention locks

`api verify`:

- recomputes the trail hash chain
- checks every signature's content hash against its finding history
- checks every `documents.sha256` against the stored object

It runs nightly and after any restore. Failures alert.

### 7.5 Observability

- pino JSON logs with a per-request `request_id`, also written to trail bundles
- `/healthz` (liveness) and `/readyz` (database and blob store reachable)
- Prometheus `/metrics`: HTTP latency and errors, LLM calls, fallbacks and tokens, trail append latency, signature failures

### 7.6 Security

- helmet with a strict CSP
- CORS limited to the web origin
- rate limits on `/auth/*` and `/api/sign/*`
- body size limits
- zod validation on every route
- parameterised SQL only (Kysely)
- no secrets in logs
- `npm audit` and Trivy image scans in CI

`ANTHROPIC_API_KEY` stays optional, and `LLM_PROVIDER=offline` stays the default.

## 8. Error handling

- One `AppError` with an HTTP status and a stable `code`:
  - `VERSION_CONFLICT`
  - `SOD_VIOLATION`
  - `REAUTH_REQUIRED`, `REAUTH_STALE`, `REAUTH_USER_MISMATCH`
  - `INTENT_EXPIRED`
  - `CONTENT_CHANGED`
  - `FINDING_BLOCKED`, `FINDING_LOCKED`
  - `UNVERIFIED_SOURCE`
  - `FORBIDDEN`, `NOT_FOUND`, `VALIDATION`
- Unexpected errors are logged with the `request_id`. The client receives
  `{ code: "INTERNAL", requestId }` only.
- Transactions guarantee no partial state and no orphan trail entries.
- LLM failure keeps the existing deterministic fallback and QA flag.

## 9. Frontend changes

- Sign-in redirect replaces the user switcher. "Pending access" page. Header shows name, role and logout.
- `api.ts` sends credentials and the CSRF header, and maps error codes to messages.
  `VERSION_CONFLICT` shows "Someone else changed this — reload".
- Sign button runs the intent → popup → result flow (§4.4). Signatures show full
  name, meaning and time, and a broken signature is visibly flagged.
- Library page shows each concept's verification status, stale date and source path.
- Admin page (role `admin`): users, role overrides, deactivation, session revocation,
  group mapping, and the "due for re-review" knowledge list.
- No new audit features.

## 10. Testing

| Layer | Tooling | Covers |
|---|---|---|
| Unit | vitest | Engine, QA gates incl. trust rules, trail hashing, signature content hash, SoD rules, config validation, OKF parser and compiler |
| Integration | vitest + Testcontainers (Postgres+pgvector, MinIO; Azurite for `AzureBlobStore`) | See list below |
| Auth | In-process mock OIDC provider | Login, stale `auth_time`, wrong user, replayed or mismatched nonce, content changed between intent and callback |
| End-to-end | Playwright (small set) | Log in → run chain → reviewer and CAE sign with re-auth → export report |
| Regression | Existing suite | All current tests ported. Tests stay tagged `[REQ-xx]`. Eval 25/25 offline |

Integration tests cover:

- transaction rollback
- optimistic locking (409)
- append-only triggers reject UPDATE and DELETE on `trail` and `signatures`
- trail appends serialise under parallel load with no fork
- permission-filtered retrieval (restricted chunk never returned to an unauthorised user)
- BlobStore round-trip and hash verification
- JSON import, including refusing a broken chain
- `packs:compile` rejects a dangling link

CI (GitHub Actions) runs typecheck, lint, unit, integration, eval, traceability, image build and Trivy.

## 11. Validation package additions

New entries in `backend/validation/requirements.json`, each traced to tests:

| ID | Risk | Requirement |
|---|---|---|
| REQ-16 | High | Users authenticate through the configured OIDC provider; demo login is impossible in production (Part 11 §11.10(d)) |
| REQ-17 | High | Actions are authorised by role, and the preparer, reviewer and approver of a finding are distinct people (§11.10(g)) |
| REQ-18 | High | Signing requires re-authentication within 120 s, bound to a one-time intent for that finding, meaning and content (§11.200(a)) |
| REQ-19 | High | Each signature records full name, meaning and time, is displayed with the record, and is bound to the signed content by hash (§11.50, §11.70) |
| REQ-20 | High | Trail and signature records cannot be updated or deleted at the database level (§11.10(e), ALCOA+) |
| REQ-21 | High | Concurrent conflicting edits are rejected, never silently overwritten |
| REQ-22 | High | Only human-verified, active, non-stale knowledge nodes are citable in released outputs |
| REQ-23 | High | Knowledge retrieval never returns content the requesting user may not access |
| REQ-24 | Medium | `verify` detects trail, signature or stored-document tampering after restore |
| REQ-25 | Medium | Configuration is validated at start-up; insecure combinations are refused |

The README for the validation package gains a **Client responsibilities** section:
identity provider password and MFA policy, account lifecycle, hosting physical
security, backup schedule and restore testing, and storage retention configuration.

## 12. Roadmap

| # | Sub-project | Depends on |
|---|---|---|
| 1 | **Production foundation** (this spec) | — |
| 2 | **Agent orchestration**: supervisor agent with code-enforced rails (engagement graph, allowed transitions, four human gates: scope, RCM, finding, report; budgets; tool allow-lists) and an LLM supervisor deciding within them; typed, trailed decisions; offline rules policy; specialist agents wrapping today's modules; QA agent (scored workpaper review and adversarial challenge mode) before every gate; knowledge-graph tools | 1 |
| 3 | Evidence management: upload, extraction, chunking, evidence ↔ test/finding links, retention | 1 |
| 4 | Issue and action tracking: owners, action plans, due dates, extensions, closure verification; `auditee` and `action_owner` roles | 1, 2 |
| 5 | Audit universe and annual plan | 1 |
| 6 | Committee and management reporting | 4, 5 |
| 7 | Knowledge graph expansion: expert review workflow, SOP extraction into *proposed* OKF concepts with human approval, embeddings and hybrid search, bundle export | 1, 3 |

## 13. Risks

| Risk | Mitigation |
|---|---|
| OKF is v0.2, early and steered by Google | OKF is the import and export format only. The internal graph model is ours. The compiler pins a spec version |
| Unverified content blocks the pilot | Expert review of the target pack is a pilot prerequisite. `ALLOW_UNVERIFIED_CITATIONS` keeps non-production demos working |
| Identity provider without `auth_time` or `prompt=login` support | Verify during discovery. Fallback: a provider step-up policy (Entra authentication context) checked through the `acrs` claim |
| Async rewrite of the service introduces regressions | Port existing tests first and keep them green at every step. The engine stays untouched |
| Gartner source material licensing | Case studies informed design discussion only. No Gartner text, figures or tables enter code, packs, prompts or the repo |
