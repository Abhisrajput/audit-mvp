# Operations runbook

For the deployment itself, see [azure.md](azure.md). Inside containers, run `node dist/...`; the images contain no npm.

## 1. Health

- `GET /healthz` is liveness. It touches nothing and answers `{ ok: true }`.
- `GET /readyz` checks the database (`select 1`) and file storage (a lookup of a key no upload can have), each with a 2-second timeout. It answers `200 { ok: true, checks }`, or `503 { ok: false, checks }`, where `checks` maps `database` and `storage` to `ok`, `timeout` or `error` (`not configured` for storage when no store is set, which does not fail readiness). The logs carry the detail under `readiness check failed` (or `readiness check timed out`).
- An S3 bucket policy without `s3:ListBucket` makes the storage check fail, because a missing object reads as access denied. Grant it.
- The probes and `/metrics` are on the API's own port; nginx does not proxy them.

## 2. Metrics

`GET /metrics` needs `Authorization: Bearer <METRICS_TOKEN>`. Default process metrics are prefixed `audit_`. `route` is the matched route pattern, never the raw URL (`unmatched` for no match).

| Metric | Meaning |
|---|---|
| `audit_http_request_duration_seconds{method,route,status}` | Histogram of request duration. |
| `audit_http_errors_total{code}` | Error responses by error code (`INTERNAL`, `VALIDATION`, `RATE_LIMITED`, ...). |
| `audit_llm_calls_total{provider,outcome}` | Model calls by outcome. |
| `audit_llm_fallbacks_total{provider,kind}` | `kind="model"`: the server switched to another model. `kind="deterministic"`: a call failed and the module used its offline rules. |
| `audit_llm_tokens_total{provider,kind}` | Model tokens used, by kind. |
| `audit_trail_append_seconds` | Histogram of the time to seal and append one trail bundle, including the wait for the chain lock. |
| `audit_signature_failures_total{code}` | Failed signing attempts by reason. |

Suggested alerts:

- 5xx rate above 1% for 5 minutes: `audit_http_request_duration_seconds_count{status=~"5.."}` against all requests.
- Any increase of `audit_http_errors_total{code="INTERNAL"}`. A missing database grant also shows here: Postgres `42501` "permission denied" returns `500 INTERNAL` and is logged at error, as opposed to a trigger refusing a change to the record, which returns `403 RECORD_IMMUTABLE`.
- `audit_signature_failures_total` rising faster than 5 per 10 minutes.
- `audit_llm_fallbacks_total{kind="deterministic"}` increasing: drafts are falling back to offline rules.
- p95 of `audit_trail_append_seconds` above 0.5 s.
- Readiness failing (`/readyz` answering 503).

Every error body is `{ error, code, requestId }`; an unexpected error is `{ code: 'INTERNAL', requestId }` and its detail is only in the logs, under that `requestId`.

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
- **Documents.**
  - "stored file <sha256> is missing": the stored file is gone.
  - "stored bytes hash to <hash>, not <sha256>": the file changed.
  - "stored size <n> bytes, registered <m>": the size differs from the registration.
  - "storage error: ...": storage could not be read; check readiness first.
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

- **API database password.** Run `API_DB_PASSWORD=<new, 16+ characters> node dist/db/cli.js create-api-login audit_app` again, as a login with `CREATEROLE`. For an existing login made by this tool, it only changes the password; otherwise it refuses and you choose a new name. Update `DATABASE_URL` in Key Vault, then roll the `api` revision.
- **`METRICS_TOKEN`.** Update Prometheus's scrape credential first, then Key Vault, then roll the revision. Metrics gaps are expected between the steps.
- **OIDC client secret.** Create the new secret in Entra, update it in Key Vault, then roll the revision. Remove the old secret afterwards.
