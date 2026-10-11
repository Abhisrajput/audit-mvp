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
| Human-in-the-loop sign-off | `service.ts#signOff` | Auditor → Reviewer → Approver, separate people, signature manifestation |
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
docker compose up -d postgres

# API (port 3002)
cd backend
cp .env.example .env
npm install
npm run migrate     # apply SQL migrations; the API never migrates by itself
npm run seed        # two demo engagements (empty database only): food+treasury, and pharma GMP
npm run dev

# UI (port 5174), in a second terminal
cd frontend
npm install
npm run dev         # open http://localhost:5174
```

Or run everything with Docker: `docker compose up --build` from the repo root.
Compose starts Postgres, runs migrations once, then starts the API and the UI on
http://localhost:8080. To seed it: `docker compose exec backend node dist/seed.js`.
To reset the local database: `docker compose down -v`.

**Coming from the JSON-file MVP?** Import your old data once into an empty
database: `npm run import-json -- data/db.json`. The trail's hash chain is
verified before and after import. A broken chain or a non-empty database is
refused and nothing is written.

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
   (clause + control + evidence). Switch *Acting as* to Reviewer and sign, then to
   QA Head and approve. A finding with no evidence reference is **blocked** and
   cannot be signed.
6. **Report**: only approved findings are included. Download the `.md` report or the
   CSV for QMS/GRC write-back.
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
- **Identity:** the demo user switcher is a placeholder. Production needs OIDC
  SSO (Entra ID, Okta and others) with Part 11-grade e-signatures
  (re-authentication at signing). See
  `docs/superpowers/specs/2026-10-11-production-foundation-design.md`.
- **Deployment:** deploy into the client's tenant (e.g. Azure App Service +
  Azure AI Search).
- **Further modules:** pharma deviation/CAPA effectiveness review, ALCOA+
  data-integrity audit, food supplier audit modules, Audit Committee pack.
- **Validation:** IQ/PQ in a client environment, and full change control over
  prompts and models.
