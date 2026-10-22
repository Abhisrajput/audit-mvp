# Operations runbook

For the deployment itself, see [azure.md](azure.md). Inside containers, run `node dist/...`; the images contain no npm.

## 1. Health

- `GET /healthz` is liveness. It touches nothing and answers `{ ok: true }`.
- `GET /readyz` checks the database (`select 1`) and file storage (a lookup of a key no upload can have), each with a 2-second timeout. It answers `200 { ok: true, checks }`, or `503 { ok: false, checks }`, where `checks` maps `database` and `storage` to `ok`, `timeout` or `error` (`not configured` for storage when no store is set, which does not fail readiness). The logs carry the detail under `readiness check failed` (or `readiness check timed out`).
- The agent worker serves the same `GET /healthz` and `GET /readyz` on `WORKER_PORT` (default 3003). Its readiness has `database` and `worker` checks (`worker: stopping` once shutdown has begun, which answers 503); `storage` reads `not configured`.
- An S3 bucket policy without `s3:ListBucket` makes the storage check fail, because a missing object reads as access denied. Grant it.
- The probes and `/metrics` are on the API's own port; nginx does not proxy them.
- Each request writes one access-log line (`"msg":"request"`) with `requestId`, `method`, `route`, `status`, `ms`, `user` and `ip`. `ip` is the client address the API derived under `TRUST_PROXY`, which the rate limits count; check it after any change in front of the API (see azure.md §5). If it is the same proxy address for everyone, `TRUST_PROXY` is too low.

## 2. Metrics

`GET /metrics` needs `Authorization: Bearer <METRICS_TOKEN>`. Default process metrics are prefixed `audit_`. `route` is the matched route pattern, never the raw URL (`unmatched` for no match). The worker serves its own `/metrics` on its port, with the same token.

| Metric | Meaning |
|---|---|
| `audit_http_request_duration_seconds{method,route,status}` | Histogram of request duration. |
| `audit_http_errors_total{code}` | Error responses by error code (`INTERNAL`, `VALIDATION`, `RATE_LIMITED`, ...). |
| `audit_llm_calls_total{provider,outcome}` | Model calls by outcome. |
| `audit_llm_fallbacks_total{provider,kind}` | `kind="model"`: the server switched to another model. `kind="deterministic"`: a call failed and the module used its offline rules. |
| `audit_llm_tokens_total{provider,kind}` | Model tokens used, by kind. |
| `audit_trail_append_seconds` | Histogram of the time to seal and append one trail bundle, including the wait for the chain lock. |
| `audit_signature_failures_total{code}` | Failed signing attempts by reason. |
| `audit_agent_runs{status}` | Agent runs in each status (`running`, `runnable`, `waiting`, `needs_human`, `completed`, `cancelled`, `failed`). From the API, read from the database at each scrape. |
| `audit_agent_step_duration_seconds{kind}` | Histogram of committed agent steps by kind (`decision`, `delegate`, `tool_call`, `qa`). Worker. |
| `audit_agent_tokens_total{agent,model,kind}` | Model tokens charged to committed agent steps. Worker. A step that failed after a paid call is in the run's spend and in `audit_llm_tokens_total`, not here. |
| `audit_agent_cost_usd_total{agent,model}` | Model cost in USD charged to committed agent steps, at the configured prices. Worker. |
| `audit_agent_policy_fallbacks_total{reason}` | Decisions the rules took over from the model policy, by the last model attempt: `off_menu`, `malformed`, `model_error`. Worker. |
| `audit_agent_guard_refusals_total{source}` | `source="rails"`: the executor guards refused an agent action (spec §5.4); the run is handed to a person. `source="model_request"`: a lookup a model asked for was off its allow-list or malformed, and was skipped. Worker. |

Suggested alerts:

- 5xx rate above 1% for 5 minutes: `audit_http_request_duration_seconds_count{status=~"5.."}` against all requests.
- Any increase of `audit_http_errors_total{code="INTERNAL"}`. A missing database grant also shows here: Postgres `42501` "permission denied" returns `500 INTERNAL` and is logged at error, as opposed to a trigger refusing a change to the record, which returns `403 RECORD_IMMUTABLE`.
- `audit_signature_failures_total` rising faster than 5 per 10 minutes.
- `audit_llm_fallbacks_total{kind="deterministic"}` increasing: drafts are falling back to offline rules.
- p95 of `audit_trail_append_seconds` above 0.5 s.
- Readiness failing (`/readyz` answering 503).
- Any increase of `audit_agent_guard_refusals_total{source="rails"}`: the rails stopped an agent action. That is a bug or a hostile input; read the run's steps.
- `audit_agent_runs{status="needs_human"}` above 0 for more than a working day: a run is waiting for a person (see §7).
- `audit_agent_policy_fallbacks_total` rising faster than 10 per hour, or `audit_llm_fallbacks_total{kind="deterministic"}` rising while runs are working: the model is failing or answering off the menu.
- `increase(audit_agent_cost_usd_total[1d])` above the client's daily agent budget.
- The worker's readiness failing, or no worker scrape target up while `audit_agent_runs{status="runnable"}` is above 0.

Every error body is `{ error, code, requestId }`; an unexpected error is `{ code: 'INTERNAL', requestId }` and its detail is only in the logs, under that `requestId`. A request body the API cannot read (an unsupported `Content-Encoding` or charset, an aborted upload) is the client's doing: it answers with that 4xx status and `code: 'VALIDATION'`, counts under `VALIDATION`, and logs `request body rejected` at warn, so it never raises the `INTERNAL` alert.

## 3. Backups

- Postgres point-in-time restore, 30 days.
- Storage blob versioning, and a retention lock on the `evidence` container.
- Test a restore at least quarterly, into a separate server, ending with a passing `verify`.

## 4. Verify (REQ-24)

```bash
node dist/db/cli.js verify      # locally: npm run verify
```

Run it nightly as a scheduled job with the API's environment (it needs the storage settings to read the files), and after every restore. It reads everything and changes nothing. It prints one JSON object and exits 0 when `ok`, 1 otherwise:

```json
{
  "ok": true,
  "trail": { "valid": true, "length": 128, "brokenAt": null, "reason": null },
  "signatures": { "checked": 9, "problems": [] },
  "agents": { "checked": 64, "problems": [] },
  "documents": { "checked": 14, "problems": [], "skipped": null }
}
```

What the problems mean:

- **Trail.** `brokenAt` is the `seq` of the first bundle that fails the hash chain, with the reason: a bundle changed after it was sealed. Investigate from that `seq`.
- **Signatures** (each line starts with the signature or finding it concerns):
  - "the signed content is not in the finding's history": the signature row or the finding history was edited outside the application.
  - "its trail entry <id> is missing": the sign-off bundle is gone.
  - "does not match its trail entry": the row and the sealed sign-off bundle disagree.
  - "Trail entry <id> records signature <sigId> (finding <fid>), but the signature row is missing": a signature row was deleted.
  - "sign-off <id> (<meaning> by <name>) is broken": the finding's recorded sign-off no longer matches its signature row.
  - "Signature <id> (...) is recorded but missing from the finding": a valid signature on the finding's current content has been removed from the finding.
  - "Gate <id> is approved|rejected, but its signature … is missing", "Gate <id>: signature … is for different content than the gate showed", "… carries <meaning>, not <expected>", "… was made in a different engagement", "… was made for a different gate|finding": a gate and the signature that closed it disagree. One of them was edited outside the application.
  - "Signature <id> (<workpaper> gate <gateId>): its gate is missing", "… its gate is a <kind> gate in <engagement>, not …", "… its gate names signature <other>, not it": the link back from a gate signature to its gate is broken. The gate was edited or removed outside the application, or a signature row was added for a gate that was closed by another.
  - "Gate <id> is open|superseded, but names signature <sig>": a gate nobody decided names a signature.
- **Agents** (each line starts `Step <runId>#<seq> (<kind>)`):
  - "has no trail entry": an agent step (a decision, delegation, QA review, lookup, takeover note or rails refusal) is not in the audit trail. No step is exempt.
  - "its trail entry <id> is missing": the bundle the step names is gone.
  - "is at or after the break in the chain": the step's bundle is not vouched for by the hash chain; investigate the trail break first.
  - "is not an agent's entry for this run": the step points at a bundle written by someone else, or for another run.
  - Takeover notes and rails refusals written before these steps got trail entries of their own are reported as having none. Such rows exist only in databases that ran agents before the change.
- **Documents.**
  - "Trail entry <id> registers document <documentId>, but the document row is missing": a document row was deleted outside the application.
  - "Document <id>: registered as <sha256> in the trail, but the row says <sha256>": the row's SHA-256 was rewritten after registration, so it points at other bytes.
  - "stored file <sha256> is missing": the stored file is gone.
  - "stored bytes hash to <hash>, not <sha256>": the file changed.
  - "stored size <n> bytes, registered <m>": the size differs from the registration.
  - "storage error: ...": storage could not be read; check readiness first.
- The two registration checks compare the trail with the `documents` table and need no storage, so they run even when the storage check is skipped.
- `documents.skipped` set to a reason means the storage settings did not load in the job. That also fails the report, because a verify that could not look at the files proves nothing about them. Fix the job's environment.

Exit 1 means escalate as a data-integrity incident. Do not edit data to make it pass.

`GET /api/trail/verify` checks the hash chain alone.

## 5. Restore procedure

1. Stop the API (scale to 0).
2. Restore Postgres to a point in time.
3. Restore storage versions to the same point, if needed.
4. Run `node dist/db/cli.js migrate` (a no-op if the schema is current).
5. Run `node dist/db/cli.js verify`.
6. Start the API only when the report says `ok: true`.
7. Record the restore and the verify report in the client's change log.

## 6. Rotating secrets

- **API database password.** Run `API_DB_PASSWORD=<new, 16+ characters> node dist/db/cli.js create-api-login audit_app` again, as the login that created it (it holds `ADMIN OPTION` on it) or a superuser; the tool refuses before sending anything if the login lacks that. For an existing login made by this tool, it only changes the password; otherwise it refuses and you choose a new name. Update `DATABASE_URL` in Key Vault, then roll the `api` revision.
- **`METRICS_TOKEN`.** Update Prometheus's scrape credential first, then Key Vault, then roll the revision. Metrics gaps are expected between the steps.
- **OIDC client secret.** Create the new secret in Entra, update it in Key Vault, then roll the revision. Remove the old secret afterwards.

## 7. Agent runs

- **Where.** The Run panel on each engagement shows a run's status and reason, spend against budget, every step (with who decided it and any fallback to the rules), and its gates. `GET /api/runs/<id>` returns the same data.
- **Logs.** Every line the worker writes while working on a run carries `runId`. In Log Analytics: `ContainerAppConsoleLogs_CL | where Log_s has '"runId":"AR-…"'`.
- **Kill switch.** Set `AGENT_ENABLED=false` on both apps and roll them. No run can start and no worker leases a run; runs keep their status and resume when it is turned back on.
- **A run that needs a person** (`needs_human`; the panel says why and what to do):
  - `budget_exhausted: …`: an audit manager raises the budget in the panel, and the run resumes.
  - `gate_rejected_twice: …`: edit the workpaper or finding by hand, then press Resume. It goes through QA and a fresh gate.
  - `agent_forbidden: …`: the rails refused an action. Read the run's last steps, then resume or cancel, and report it: the rails should never need to.
  - `rework produced no change: …`: the agent redrafted and nothing changed. Edit the subject by hand, then press Resume.
  - `QA found … issue(s)` / `QA found blocking issues …` / `QA scored …`: the draft failed QA. Fix what QA lists by hand, then press Resume; it goes through QA again.
  - `finding … was approved on test results that have since changed`: decide in Findings what to do with the finding (reject it, or have it redrafted), then press Resume.
  - `The … specialist already ran for … and it is still not ready`: the specialist's one pass did not fix it. Check and edit it by hand, then press Resume.
  - `the person who started this run can no longer prepare audit work`: Resume cannot help, because the run acts as that person. Start a new run.
  - `error: …`: three iterations in a row failed. Find the cause in the worker's logs by `runId`, fix it, then resume.
- **A run that waits** for test results or a gate signature moves on by itself when the test is recorded, when a reason not to test is given in Test plans, or when the gate is signed.
- **A worker that stops mid-step.** Another worker takes the run once its 60-second lease expires. The abandoned step counts as a failed one, and three in a row hand the run to a person.
- **Scaling.** Run more worker replicas, or raise `AGENT_WORKER_CONCURRENCY`. Each worker needs `AGENT_WORKER_CONCURRENCY × 2 + 2` database connections.
- **Engagement context.** A change to the context after the scope gate is approved reopens the scope gate for a new signature. After the RCM gate is approved the API refuses the change with `CONTEXT_LOCKED` (HTTP 409); there is nothing to fix, as late matters go in the relevant finding or a new engagement.
