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
cp .env.example .env   # then set POSTGRES_PASSWORD
docker compose up -d postgres

# API (port 3002)
cd backend
cp .env.example .env   # then set DATABASE_URL to use your POSTGRES_PASSWORD
npm install
npm run migrate     # apply SQL migrations; the API never migrates by itself
npm run seed        # two demo engagements (empty database only): food+treasury, and pharma GMP
npm run dev

# UI (port 5174), in a second terminal
cd frontend
npm install
npm run dev         # open http://localhost:5174
```

Or run everything with Docker: `cp .env.example .env` (then set `POSTGRES_PASSWORD`), then `docker compose up --build` from the repo root.
Compose starts Postgres, runs migrations once, then starts the API and the UI on
http://localhost:8080. To seed it: `docker compose exec backend node dist/seed.js`.
To reset the local database: `docker compose down -v`.
Compose binds the UI and API to localhost only; demo sign-in must be off (`DEV_AUTH=false`) on any machine others can reach.

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
- **Shown with the finding, in the report and in the findings CSV.** The finding card and the report show each signature as meaning, full name, role, time in UTC, how you re-authenticated and the signature id, e.g. `Approved by Priya QA Head (cae) at 2026-10-11 09:30 UTC, re-authenticated by demo confirmation [SIG-…]`. The CSV's `signatures` column lists every sign-off as `meaning|name|role|ISO time|method|signature id|status`, separated by `; `.
- **Checked against an append-only record.** Every signature is also written to an append-only `signatures` table in the same transaction. The status of each signature comes from that table: **valid**, **broken** (no matching record, or the finding's content, signer or meaning no longer match what was signed — even if someone rewrote the recorded hash too), or **legacy** (a sign-off from before Part 11 signing, e.g. imported MVP data; never shown as re-authenticated).
- **Single-use requests.** Each signing request lasts 5 minutes and works once. Failed, expired and cancelled attempts are recorded in the audit trail; reusing a finished request is simply refused.

Seeded demo data is signed by the seed script without re-authentication and shows "not re-authenticated". Signing in code without a signing request is refused.

**Identity-provider settings for signing:**
- The ID token must carry the `auth_time` claim. On **Entra ID**, add `auth_time` as an optional claim to the ID token (*Token configuration → Add optional claim*). Without it, signing is refused with "did not report when you signed in (auth_time)".
- Signing asks for a fresh password with `prompt=login` and `max_age=0`. Identity providers that ignore these and reuse an existing session (e.g. Google) are refused at signing, because their `auth_time` is earlier than the signing request.

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

## Adding a sector or regulation

Create `backend/packs/<id>/pack.json` with:

- `clauses`: id, regulation, ref, title, paraphrased summary, tags and `reviewStatus`.
- `controls`: risk, objective, frequency, `clauseRefs`, TOD/TOE steps, evidence,
  checklist and recommendation.
- `evalCases`: expected retrieval hits, test conclusions and finding citations.
- `sources`: short citation prefixes.

The pack is schema-validated on load, and a control that cites an unknown clause is
rejected. No engine code changes are needed.

## Checks

```bash
cd backend
npm test              # needs Docker: tests run against a real Postgres (Testcontainers)
npm run eval          # 25/25 eval cases (offline), on a throwaway in-process database
npm run traceability  # requirements traceability matrix -> validation-output/traceability.md
npm run verify        # recompute the audit-trail hash chain in the configured database
npm run typecheck
```

## Not in the MVP (next steps)

- **Expert review of the content:** clause summaries and citation maps (especially
  the Schedule M section numbering, and the FSSAI and BRCGS mappings) need an ex-QA
  head or food-safety lead to sign them off.
- **Real evidence ingestion:** evidence is recorded as references today. Next is
  reading SOPs, deviations and CAPAs from an eQMS (Veeva, MasterControl, TrackWise)
  and attaching documents.
- **Deployment:** deploy into the client's tenant (e.g. Azure App Service +
  Azure AI Search).
- **Further modules:** pharma deviation/CAPA effectiveness review, ALCOA+
  data-integrity audit, food supplier audit modules, Audit Committee pack.
- **Validation:** IQ/PQ in a client environment, and full change control over
  prompts and models.
