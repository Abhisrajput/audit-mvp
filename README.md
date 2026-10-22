# Audit & Controls Agent Platform — MVP

A generic internal-audit and quality-audit platform for regulated manufacturing
(food, pharma, and any manufacturer through the common pack). This MVP follows the
KDI product thesis: **a thin, portable engine plus vertical content packs**, with
QA gates and an evidence trail built in from day one.

```
                 ┌──────────────────────── Engine (thin, portable) ────────────────────────┐
 Scope           │  Risk & Scope  →  Control & Risk  →  Testing   →  Gap Writer  →  Report   │
 statement  ───► │   Analysis         Writer (RCM)     (TOD/TOE)    (findings)     Writer    │ ──► Report (.md)
                 │      │                 │                │             │             │       │ ──► Findings CSV for
                 │      └──── QA gates on every output: citation · evidence · triple ───┘       │     QMS / GRC write-back
                 │            citation · release · library-only · consistency                │
                 │  Grounding index (BM25, clause-level)   Model router (offline | Claude)    │
                 │  Hash-chained audit trail: every module run and every human sign-off      │
                 └─────────────────────────────────────────────────────────────────────────┘
                       ▲ content packs (data, not code)                    ▲ evaluation harness
             common · food · pharma  (clauses, controls, eval cases)        + validation package
```

Screenshots: [scope](docs/screenshots/scope.png) · [findings & sign-off](docs/screenshots/findings.png) · [audit trail](docs/screenshots/audit-trail.png) · [evaluation & validation](docs/screenshots/validation.png)

## What is in the MVP

| Thesis component | Where | Status |
|---|---|---|
| Module orchestration (daisy-chaining) | `backend/src/engine/modules/*`, `service.ts` | 5 modules, chain order enforced |
| Supervised autopilot | `backend/src/agents/*`, Run panel | A supervisor agent runs the chain within code-enforced rails, QA-reviews each workpaper, and stops at human gates signed under Part 11; offline rules or Claude |
| Runtime QA gates | `backend/src/engine/qa.ts` | Citation, evidence, triple-citation, release, consistency, library-only |
| Audit-trail bundle per execution | `backend/src/engine/trail.ts` | Inputs, retrieval set, log, QA actions, output, versions, actor; SHA-256 chained; append-only in Postgres (UPDATE/DELETE/TRUNCATE rejected by trigger) |
| Grounding index with clause metadata | `backend/src/engine/grounding.ts` | BM25 keyword index; swap for vector search later |
| Model routing, model-agnostic | `backend/src/engine/llm/*` | `offline` deterministic rules (default) or `anthropic` (Claude) |
| Common pack (RCM, TOD/TOE, gap writer) | `backend/packs/common` | COSO-based P2P, ITGC, **treasury & commodity hedging**, governance |
| Food pack | `backend/packs/food` | HACCP verification, supplier/co-man, traceability & recall, allergens, PRPs |
| Pharma pack | `backend/packs/pharma` | GMP self-inspection: QU, training, deviations/CAPA, batch release, data integrity, lab, change control, suppliers |
| Human-in-the-loop sign-off | `service.ts#signOff` | Auditor → Reviewer → Approver, separate people; Part 11 e-signatures with re-authentication, content binding and manifestation in report and CSV |
| Evaluation harness | `backend/src/eval` | 25 expert-labelled cases across packs, used as release gate |
| Validation package skeleton | `backend/validation` | URS, risk ratings, generated traceability matrix, change-control procedure |
| Integration posture | `GET /api/engagements/:id/findings.csv` | Flat export for write-back; no system-of-record ambitions |

All demo data is fictitious. **Clause summaries are paraphrased and marked `draft`.**
They have not had domain-expert review yet, and they are not the authoritative
regulatory text. That review is a workstream in the thesis and must happen before
any client use.

## Quick start

Requires Node 20+ (tested on 22) and Docker.

```bash
# Database (Postgres 16 + pgvector) on localhost:5432
cp .env.example .env   # then set POSTGRES_PASSWORD (and S3_ROOT_* if you run the full Compose stack)
docker compose up -d postgres

# API (port 3002)
cd backend
cp .env.example .env   # then set DATABASE_URL to use your POSTGRES_PASSWORD
npm install
npm run migrate     # apply SQL migrations; the API never migrates by itself
npm run packs:compile  # compile the content packs into the knowledge graph (dev also compiles at API start-up)
npm run seed        # two demo engagements (empty database only): food+treasury, and pharma GMP
npm run dev

# UI (port 5174), in a second terminal
cd frontend
npm install
npm run dev         # open http://localhost:5174

# Agent worker (runs agent runs between gates), in a third terminal
cd backend
npm run worker
```

Or run everything with Docker: `cp .env.example .env` (then set `POSTGRES_PASSWORD`, `S3_ROOT_ACCESS_KEY` and `S3_ROOT_SECRET_KEY`), then `docker compose up --build` from the repo root.
Compose starts Postgres and the object store (SeaweedFS, S3-compatible), runs migrations and compiles the content packs into the knowledge graph (`migrate`), and creates the storage bucket once
(`objectstore-init`), then starts the API, the agent worker and the UI on
http://localhost:8080. To seed it: `docker compose exec backend node dist/seed.js`.
To reset the local database and stored files: `docker compose down -v`.

Using your own Postgres instead of Compose's: it needs the **pgvector** extension (migration 005 runs `CREATE EXTENSION vector`).
On Azure Database for PostgreSQL Flexible Server, first allow-list it: add `vector` to the `azure.extensions` server parameter.
Compose binds the UI and API to localhost only; demo sign-in must be off (`DEV_AUTH=false`) on any machine others can reach.

**Operations settings** (all optional locally; see `backend/.env.example`):
- `DATABASE_SSL`: `disable`, `require` or `verify-full`. Defaults to `verify-full` in production, `disable` otherwise; `disable` is refused in production. Never put TLS parameters (`sslmode`, `ssl`, `sslcert`, `sslkey`, `sslrootcert`, `sslnegotiation`, `uselibpqcompat`) in `DATABASE_URL`; start-up refuses them.
- `DATABASE_SSL_CA_FILE`: path to a PEM file, for a private certificate authority.
- `LOG_LEVEL`: `fatal`, `error`, `warn`, `info` (default), `debug`, `trace` or `silent`.
- `TRUST_PROXY`: how many proxies sit in front of the API (0 to 5, default 0). It sets the client address used for rate limits and whether an incoming `X-Request-Id` is trusted.
- `METRICS_TOKEN`: bearer token for `/metrics`, at least 24 characters. Required by the API server in production.
- `<NAME>_FILE`: the secrets `DATABASE_URL`, `OIDC_CLIENT_SECRET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `AZURE_STORAGE_CONNECTION_STRING`, `ANTHROPIC_API_KEY`, `METRICS_TOKEN` and `API_DB_PASSWORD` can instead be read from a file named by `<NAME>_FILE`.

**Coming from the JSON-file MVP?** Import your old data once into an empty
database: `npm run import-json -- data/db.json`. The trail's hash chain is
verified before and after import. A broken chain or a non-empty database is
refused and nothing is written.

### Signing in

Locally, demo sign-in is on (`DEV_AUTH=true`). The sign-in page lists five demo users, one per role:

| Role | May |
|---|---|
| Auditor | Create engagements, run modules, record tests, edit findings |
| Audit manager | Everything an auditor may, plus sign findings as **Reviewed** |
| Chief Audit Executive | Sign findings as **Approved** or **Rejected** |
| Administrator | Manage users, roles and sessions; sees no audit content |
| Viewer | Read only |

**Segregation of duties** is enforced per finding by person:
- Whoever ran Gap Writer for a finding, or edited it, cannot sign it.
- The reviewer cannot approve it.

**Real sign-in** uses OpenID Connect against your identity provider (Entra ID, Okta, Keycloak, …):
- Set `DEV_AUTH=false`, `NODE_ENV=production` and the `OIDC_*` settings (see `backend/.env.example`).
- Map identity-provider groups to roles with `OIDC_ROLE_MAP`.
- `OIDC_REDIRECT_URI` must be on the same origin as `PUBLIC_URL` (both https in production), or the sign-in cookies are not sent back.
- `OIDC_SCOPES` (default `openid profile email`) sets the scopes requested at sign-in. Getting groups into the ID token, per provider:
  - **Keycloak:** add a *Group Membership* mapper (claim `groups`, full path off) to the client.
  - **Okta:** add a `groups` claim to the authorization server and request it, e.g. `OIDC_SCOPES=openid profile email groups`.
  - **Entra ID:** enable the groups claim under *Token configuration*. Groups arrive as object IDs, so map those IDs in `OIDC_ROLE_MAP`.
    Users in more than 200 groups get an overage claim instead of a list; they land in pending access until an admin assigns a role.
- New people with no mapped group see "waiting for access" until an administrator assigns a role.

To try real sign-in locally with Keycloak:

```bash
docker compose --profile sso up -d keycloak   # http://localhost:8081, realm "audit"
# in backend/.env: DEV_AUTH=false and the commented OIDC_* lines
cd backend && npm run dev                     # then cd frontend && npm run dev
```

Sign in as `asha`, `ravi`, `priya` or `arun` with the password `demo`. `nina` has no group, so she shows the pending-access page.

### Electronic signatures (21 CFR Part 11)

Signing a finding as **Reviewed**, **Approved** or **Rejected** is an electronic signature:

- **Confirm it's you, again, at the moment of signing.** A window opens, so **allow pop-ups for this site**. While it is open the finding shows "Waiting for you to confirm your identity in the sign-in window…" with a **Cancel** button.
  - With your organisation's sign-in, the identity provider asks for your password again. The signature only counts if the identity provider reports (`auth_time`) that you entered it after you clicked sign and within the last **2 minutes**.
  - With demo sign-in, you type your user id.
- **Bound to exactly what you saw.** The signature records the SHA-256 of the finding's content. If someone changes the finding while you are signing, the signature is refused ("the finding changed after you started signing").
- **Shown with the finding, in the report and in the findings CSV.** The finding card and the report show each signature as meaning, full name, role, time in UTC, how you re-authenticated and the signature id, e.g. `Approved by Priya QA Head (cae) at 2026-10-11 09:30 UTC, re-authenticated by demo confirmation [SIG-…]`. The CSV's `signatures` column lists every sign-off as `meaning|name|role|ISO time|method|signature id|status`, separated by `; `; the `signature_issues` column lists any problems found against the signature records.
- **Checked against an append-only record.** Every signature is also written to an append-only `signatures` table in the same transaction. The status of each signature comes from that table: **valid**, **broken** (no matching record, or the finding's content, signer or meaning no longer match what was signed — even if someone rewrote the recorded hash too), or **legacy** (a sign-off from before Part 11 signing, e.g. imported MVP data, with no signature record at all; never shown as re-authenticated). A sign-off whose signature id was removed but whose record exists is broken, not legacy. Name, role, meaning, time and re-authentication are shown from the record, not from the editable finding. A recorded signature on the finding's current content that is missing from the finding is reported as a signature issue on the finding card, in the report and in the CSV; signatures on content that was edited since (even if later changed back) are history, not issues. Saving a finding without changing its content is not an edit: its status and signatures stay.
- **Single-use requests.** Each signing request lasts 5 minutes and works once. Failed and cancelled attempts (code `CANCELLED`; the app giving up when a request runs out is recorded as `INTENT_EXPIRED`), and requests used after they expired, are recorded in the audit trail; reusing a finished request is simply refused. A failure that arrives after another attempt has started completing the request never fails it; it is trailed as a replay.

Seeded demo data is signed by the seed script without re-authentication and shows "not re-authenticated". Signing in code without a signing request is refused.

**Identity-provider settings for signing:**
- The ID token must carry the `auth_time` claim. On **Entra ID**, add `auth_time` as an optional claim to the ID token (*Token configuration → Add optional claim*). Without it, signing is refused with "did not report when you signed in (auth_time)".
- Signing asks for a fresh password with `prompt=login` and `max_age=0`. Identity providers that ignore these and reuse an existing session (e.g. Google) are refused at signing, because their `auth_time` is earlier than the signing request.

### Documents and evidence files

Files are stored **content-addressed**: each object's key is its own SHA-256, so a file can't change unnoticed and duplicates are stored once.

**Where files are stored** (`BLOB_DRIVER`):
- `local`: a folder; development only.
- `s3`: AWS S3, or any S3-compatible store. Compose runs SeaweedFS (S3-compatible) for you; its keys come from `S3_ROOT_ACCESS_KEY` / `S3_ROOT_SECRET_KEY` in `.env`.
- `azure`: Azure Blob Storage.

For write-once retention, turn on S3 Object Lock, or time-based retention (immutability) on the Azure container.
The local SeaweedFS in Compose has **no Object Lock / WORM**: it is for development only. Production should use a bucket
with Object Lock (or an Azure container with immutable storage).

**Storage permissions.** On S3 the API needs `s3:GetObject`, `s3:PutObject` and `s3:ListBucket` on the bucket.
`s3:ListBucket` lets S3 answer "no such object" (404) instead of "access denied" (403); without it, every missing
object reads as a storage failure. Uploads are conditional writes (`If-None-Match: *`), so an existing object is never
rewritten. SeaweedFS 3.80 ignores that condition, so Compose sets `S3_CONDITIONAL_WRITES=false` (the API checks for the
object first); leave it at the default `true` on AWS. On Azure, the identity needs read and create on blobs in the container.

**Storage failures are not "not found".** A missing bucket or container, or denied credentials, answers
`503 STORAGE_UNAVAILABLE`. A registered document whose bytes are gone answers `500 STORAGE_INTEGRITY` and is logged with its
id and SHA-256.

**Presigned downloads** (`BLOB_PRESIGN_DOWNLOADS=true`) redirect the browser to the storage service, so the storage
endpoint must be reachable from users' browsers (Compose's `objectstore:8333` is not). Links last 60 seconds and always
download as an attachment.

**Downloads are inert.** Every file is stored as `application/octet-stream`. HTML, XML, SVG and script types are served as
`application/octet-stream`, always as an attachment, with `Content-Security-Policy: sandbox`.

**Retention.** Documents past retention stay in listings and metadata with `retentionExpired: true`; search skips them and
their content answers `410 RETENTION_EXPIRED`.

**Who can read what.** Each document is registered with a kind (evidence, SOP, policy, ...), a classification, and optionally an engagement:

| Role | May read |
|---|---|
| Viewer | internal |
| Auditor | internal, confidential |
| Audit manager, CAE | internal, confidential, restricted |
| Administrator | nothing (no audit content) |

**Search** (`GET /api/knowledge/search?q=...&engagementId=...&kinds=sop,policy&limit=10`) returns global documents plus that engagement's own, and never another engagement's. `q` is required (up to 500 characters); `limit` is 1–50. Listing (`GET /api/documents?engagementId=...`) is scoped the same way.
- Filtering by classification and engagement happens inside the database query, so text you may not read never leaves the database.
- A document you may not read answers "not found".

**API, for now** (the upload screen arrives with the evidence work):
1. `PUT /api/blobs` with the file as the body returns its `sha256`.
2. `POST /api/documents` registers it, optionally with its text.

Registrations are recorded in the audit trail. Documents are never deleted; retention is flagged.

### Demo script (≈10 minutes)

1. **Engagements**: open *H1 2026 Food Safety & Commodity Risk Audit*.
2. **Risk & scope**: the control library is ranked against the scope statement.
   Each control has a rationale and clause citations. Untick a row and save; the
   decision lands in the audit trail.
3. **RCM**: each control comes with risk, sample size by frequency and risk,
   TOD/TOE steps, a checklist and citations.
4. **Fieldwork & testing**: record a test with exceptions but no evidence reference,
   then run Testing and see the evidence gate downgrade it.
5. **Findings**: findings are drafted with the 5 C's and a triple citation
   (clause + control + evidence). Sign out, sign in as *Ravi Reviewer* (audit
   manager) and sign as reviewed. Then sign in as *Priya QA Head* (CAE) and approve.
   A finding with no evidence reference is **blocked** and cannot be signed.
   Whoever drafted or edited a finding is not offered the sign buttons.
6. **Report**: only approved findings are included, each with its signatures. Download
   the `.md` report or the CSV (one `signatures` column) for QMS/GRC write-back.
7. **Audit trail**: open any bundle to see exactly what the module saw and decided.
   *Verify hash chain* proves nothing was altered.
8. **Content library**: browse packs and try the grounding search, e.g. "audit trail
   not reviewed".
9. **Evaluation & validation**: run the harness and review the requirements
   traceability matrix.

## Using Claude for drafting

By default every module runs on deterministic rules (`LLM_PROVIDER=offline`). That
needs no key and gives reproducible output. To have Claude draft scope rationales,
tailored test steps, findings and the executive summary:

```bash
export ANTHROPIC_API_KEY=...
LLM_PROVIDER=anthropic npm run dev                  # model defaults to claude-opus-5-5; override with ANTHROPIC_MODEL
npm run eval -- --provider anthropic                # qualify the model against the eval set before use
npm run eval -- --provider anthropic --agent-llm    # also run each agent scenario on the model (informational, $2 budget each)
```

The model only drafts. Every model output passes through the same QA gates as the
offline rules:

- It can only pick controls that exist in the library.
- It can only cite clauses from the grounding set it was given.
- It cannot call a control effective when exceptions were recorded.
- Its output cannot be released without human sign-off.

If a call fails or is declined, the module falls back to the deterministic rules
and records a QA flag. Server-side refusal fallback (`fallbacks: "default"`) is
enabled, and the trail records the model that actually served each request. For
Microsoft-first clients, add a provider for Azure OpenAI, or for Claude on
Microsoft Foundry, behind the same `LlmProvider` interface in
`backend/src/engine/llm/provider.ts`.

## Agent runs (supervised autopilot)

An auditor can hand an engagement to the agent: **Start agent run** on the engagement page. The agent drafts the scope, then the RCM, then a test plan for every control. QA reviews each workpaper, and the run stops at a gate for a person to sign:

- The scope and RCM gates are signed by an audit manager, and the report gate by the Chief Audit Executive, through the same Part 11 re-authentication window as findings. Whoever started the run cannot sign its gates.
- A rejection's comment goes back to the agent as its instruction. A second rejection of the same workpaper hands the run to a person.
- Testing stays human. The run waits until every control has a recorded test or a person's reason not to test it (the **Test plans** tab), then moves on by itself.
- Findings are drafted, QA-reviewed and gated one by one. They are signed as before in the Findings tab, which shows the agent's QA review.

The agent never signs, records a test result, or edits a reviewed finding: those are code checks, whatever a model says. With `LLM_PROVIDER=offline` it decides by deterministic rules. With `anthropic` the model chooses from the same menu of allowed actions and drafts with Claude, and every call is charged to the run's budget (`AGENT_MAX_STEPS`, `AGENT_MAX_TOKENS`, `AGENT_MAX_COST_USD`) before it is made. The worker is its own process (`npm run worker`; in production `node dist/agents/worker-cli.js`), and `AGENT_ENABLED=false` switches agent runs off.

The auditor records the engagement context on the Scope tab: process or system changes, incidents, deviations or complaints, regulatory actions or inspections, prior audit findings, and complexity or volume, each naming the process areas it touches or the whole engagement. Only people write it; the agent never does. From it the agent assesses risk per process area (a named area's controls step up one rating above the library, never down), writes a coverage statement, and explains its scope in a judgment memo that cites the IIA standards clause it rests on. The signer reads the memo on the scope gate above the QA review, and the gate signature covers it. A change to the context after the scope gate is approved reopens that gate. Once the RCM gate is approved the context is locked (`CONTEXT_LOCKED`, HTTP 409): record late matters in the relevant finding or start a new engagement.

Sampling follows the assessed risk, not the library rating: the sample size comes from the assessed risk and the control's frequency, and each control's test plan picks a selection method (annual and quarterly controls are tested in full, a judgemental sample is used where an incident or prior finding touches the area, otherwise random) and carries a one-sentence rationale, which the signer reads in the memo. The plan also recommends a tolerance, and a person may set one per control on the Test plans tab (`PUT /api/engagements/:id/tolerances/:controlId`, trailed as `human:set-tolerance`); a test accepts exceptions only within it, the agent never sets one, and it is stored outside the signed workpapers. Because the test-plans QA review is keyed by the test-plans hash, which excludes tolerances, a tolerance set after that review does not re-run it. A person can set it only until the control has a recorded test (`TOLERANCE_LOCKED`, HTTP 409). Every test result carries a severity (none, isolated, systemic or pervasive); a model may only worsen it. A finding is rated from likelihood and impact by a fixed matrix, with a root cause (marked confirmed only when the record supports it) and a recommendation tailored to the cause. People edit the likelihood and impact of a finding, never the rating itself: sending `rating` in the body is a 400, and the rating is recomputed. Management responses sit outside the signed finding: `POST` and `GET /api/engagements/:id/findings/:fid/responses`, trailed as `human:management-response`. A response is refused before the finding is approved (`FINDING_NOT_APPROVED`, HTTP 409) and once the report gate is approved (`RESPONSE_LOCKED`, HTTP 409). Recording one reopens the report gate without touching the finding's signature, and `verify` checks the tolerances and responses against the trail.

## Content packs and the knowledge graph

A pack is an OKF Markdown bundle under `backend/packs/<id>/`: `pack.md`, `clauses/`,
`controls/`, `eval/` (and optionally `regulations/`, `risks/`). Each file starts with YAML
frontmatter; the audit-specific fields sit under one `x_audit` key. No engine code changes
are needed to add a sector or regulation. A trimmed control:

```markdown
---
type: control
title: Audit and control deficiencies tracked to closure
sources:
  - ref: /clauses/coso-p17.md
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: CMN-GOV-01
  risk_rating: Medium
  frequency: Quarterly
  clause_refs: [COSO-P17]
---
## Objective
Agreed management actions are tracked, validated and closed on time.
```

- **Ids and file names.** The concept id is `x_audit.id`, and the file is `<slug>.md` where
  the slug is the lower-cased id with other characters as hyphens (`CMN-GOV-01` is
  `cmn-gov-01.md`). Links between concepts are pack-relative (`/clauses/<slug>.md`) and must
  resolve inside the same pack. A control's `x_audit.clause_refs` must match its `sources`.
- **Change control.** Edit the Markdown in a pull request and bump `x_audit.version` in
  `pack.md` with every change; compile refuses changed content under an old version.
  `npm run packs:compile` (in the container: `node dist/knowledge/packs-cli.js compile`) is a
  release step like `migrate`. Production never compiles at start-up, and refuses to start
  when the graph doesn't match the bundles in the release.
- **Verification.** A reviewer sets `verified: { by, role, at }` and a `stale_after` date.
  Only verified, active and current concepts are citable: an unverified source blocks a
  finding, a stale one is flagged. `ALLOW_UNVERIFIED_CITATIONS=true` flags instead of
  blocking, outside production only (start-up refuses it in production). It is on in Compose
  and `backend/.env.example`, because the MVP packs are unreviewed drafts; expert review of the
  target pack is a pilot prerequisite. The admin page lists what is due for re-review, and
  the library shows each concept's verification, re-review date and bundle file.
- **History.** Every compile is written to the audit trail (`knowledge:compile`), and every
  compiled version of every concept is kept in `kg_node_versions`.
- **Legacy packs.** `npm run packs:migrate` converted the MVP `pack.json` files once, and is
  kept for anyone holding packs in that format.
- **Search.** `GET /api/knowledge/search` returns documents and library concepts together.
  Each concept hit carries its bundle file and whether it is citable. Recording each search
  in the audit trail (spec §6.5) is deferred to a later sub-project.
- **Methodology pack.** The `iia` pack (`backend/packs/iia/`) holds draft paraphrases of 16 clauses of the IIA Global Internal Audit Standards (2024). Memos and QA criteria cite it. It is a methodology pack, never an engagement pack: it is hidden from `/api/packs` and the default search, and creating an engagement with it is refused (400). Like the other packs it is an unreviewed draft until an expert verifies it.

## Running in production

- **Deployment guide:** [docs/deploy/azure.md](docs/deploy/azure.md) (reference deployment on Azure).
- **Runbook:** [docs/deploy/operations.md](docs/deploy/operations.md) (health, metrics and alerts, backups, restore, secret rotation).
- **Release order:** `migrate`, then `packs:compile`, then deploy the new API, then the worker. In the container: `node dist/db/cli.js migrate`, then `node dist/knowledge/packs-cli.js compile`.
- **Separate API login:** run the API as a member of `audit_api`, which can append to the record but never change or delete it. Create it with `API_DB_PASSWORD=... node dist/db/cli.js create-api-login <name>`.
- **Probes and metrics:** `/healthz` (liveness), `/readyz` (database and storage) and `/metrics` (bearer token). nginx does not expose them. The agent worker serves the same three on `WORKER_PORT` (3003).
- **Agent worker:** run the API image a second time as `node dist/agents/worker-cli.js`, after the API (see azure.md §5). `AGENT_ENABLED=false` on both is the kill switch. `AGENT_ENABLED`, `AGENT_MAX_*` and `AGENT_QA_THRESHOLD` must match on the API and the worker.
- **Logs** are JSON on stdout. Every request has a `requestId`, also returned as `X-Request-Id`, in error bodies and in the audit trail.
- **Integrity check:** `npm run verify` (in the container, `node dist/db/cli.js verify`) checks the trail, the signatures and gates, every agent step's trail entry and every stored file. Run it nightly and after any restore.

## Checks

```bash
cd backend
npm test              # needs Docker: tests run against a real Postgres (Testcontainers)
npm run eval          # 39/39 eval cases (offline), on a throwaway in-process database;
                      # needs ALLOW_UNVERIFIED_CITATIONS=true until the packs are verified (the report header records it)
npm run packs:compile # compile the OKF bundles into the knowledge graph (a release step)
npm run traceability  # requirements traceability matrix -> validation-output/traceability.md
npm run verify        # check the trail chain, signatures, gates, agent steps and stored documents in the configured database (exit 1 on any problem)
npm run typecheck
```

The eval also runs the `judgment` cases in `backend/eval/judgment/cases.json`: the risk-assessment step-ups, the rating matrix and the engagement opinion, checked against the rules with no model call. They are drafts, so they gate a release of the rules but are not an expert benchmark.

## Not in the MVP (next steps)

- **Expert review of the content:** clause summaries and citation maps (especially
  the Schedule M section numbering, and the FSSAI and BRCGS mappings) need an ex-QA
  head or food-safety lead to sign them off.
- **Real evidence ingestion:** evidence is recorded as references today. Next is
  reading SOPs, deviations and CAPAs from an eQMS (Veeva, MasterControl, TrackWise)
  and attaching documents.
- **Deployment:** the reference Azure deployment is documented, not scripted
  (`docs/deploy/azure.md`); infrastructure-as-code for it is next.
- **Further modules:** pharma deviation/CAPA effectiveness review, ALCOA+
  data-integrity audit, food supplier audit modules, Audit Committee pack.
- **Validation:** IQ/PQ in a client environment, and full change control over
  prompts and models.
- **Deferred from the operations work:**
  - ESLint. CI runs `tsc --noEmit` (strict) as the lint gate for now.
  - Playwright end-to-end tests. The flow is covered end to end through supertest.
  - The `react-router-dom` 7 upgrade, which clears two moderate advisories in version 6.
  - Recording searches in the audit trail (spec section 6.5).
  - A shared rate-limit store, needed before running more than one API replica.
  - Moving off `prom-client` 15.1.3, which is marked deprecated upstream (replaced by `@prometheus-io/client`).
