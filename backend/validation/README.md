# Validation package (skeleton)

The platform is designed to be qualified as a GxP computerised system. This folder
holds the skeleton of the validation package; the items marked *generated* are
produced from the code on every run so they cannot drift from the system.

| Deliverable | Status | Where |
|---|---|---|
| User requirements (URS) | Draft | `requirements.json` |
| Risk assessment | Draft | Risk column of `requirements.json`; see below |
| Requirements traceability matrix | *Generated* | `npm run traceability` -> `validation-output/traceability.md`, or `GET /api/validation/traceability` |
| OQ-style test evidence | *Generated* | `npm test` (tests tagged `[REQ-xx]`) |
| Performance / accuracy evidence | *Generated* | `npm run eval` -> `validation-output/eval-latest.md` |
| Audit trail integrity | *Generated* | `node dist/db/cli.js verify` (trail, signatures, stored documents; REQ-24), nightly and after restore; `GET /api/trail/verify` for the chain alone |
| Configuration qualification | *Generated* | start-up refuses insecure configuration (REQ-25); `tests/config.test.ts` |
| Change control procedure | Draft | below |
| IQ (installation) | To do | per client tenant deployment, following `docs/deploy/azure.md` |
| Operations runbook | Draft | `docs/deploy/operations.md` |
| PQ (on real client data) | To do | first reference client |

## Client responsibilities

The platform does not control the following. The client must operate it and keep the evidence.

- **Identity provider:** password and MFA policy, and conditional access.
- **Account lifecycle:** joiners, movers and leavers; reviews of the group-to-role mapping (the Admin page shows role overrides).
- **Hosting:** physical and network security of the tenant.
- **Backups:** the schedule and restore testing (point-in-time restore of at least 30 days; quarterly restore tests that end with a passing `verify`).
- **Storage:** retention configuration (versioning, immutability policy, and a retention period matching the record-retention schedule).
- **Monitoring:** watching the alerts in `docs/deploy/operations.md`.
- **Content:** expert review of the content packs before the pilot (`ALLOW_UNVERIFIED_CITATIONS` is refused in production).

## Risk assessment approach

Requirements are rated by impact on the integrity of an audit conclusion:
**High** where a failure could release an incorrect, uncited or unauthorised
finding; **Medium** where a failure degrades control but another gate or a human
still catches it. Every High requirement must have automated test coverage and,
where relevant, evaluation-harness evidence.

## Change control for prompts, models and content

Prompts, model versions and content packs are configuration items:

1. Any change to a module prompt, the model ID (`ANTHROPIC_MODEL`), a QA gate, or a
   content pack bumps the relevant version (module `version`, `ENGINE_VERSION`, pack `version`).
2. `npm test` and `npm run eval -- --provider <provider>` must pass with no regression
   against the previous evaluation report before release.
3. Content-pack changes (clauses, citation maps, controls) go through a pull request on
   `backend/packs/`, with a pack version bump. A concept becomes citable only once `verified`
   is recorded in its frontmatter after domain-expert review (REQ-22).
4. Every audit-trail bundle records the engine, module, pack and served-model
   versions, so any output can be traced to the configuration that produced it.
