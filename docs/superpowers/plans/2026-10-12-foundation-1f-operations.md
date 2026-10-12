# Foundation 1F — Operations: Configuration, Observability, Security, Verify, Database Roles and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the platform operable in a client's tenant. It refuses insecure configuration, logs and measures every request, carries a request id from the browser to the audit trail, and protects its HTTP surface. It can prove after a restore that the trail, the signatures and the stored files are intact. The API's own database login cannot rewrite the record. CI checks all of this on every push.

**Architecture:**
- **Configuration (REQ-25).**
  - Every entry point calls `prepareEnv()`. It loads `backend/.env` outside production, then resolves `<NAME>_FILE` secrets.
  - `loadServerConfig()` runs every loader (core, auth, storage, citation policy) and reports all problems at once.
  - New settings: `DATABASE_SSL`, `DATABASE_SSL_CA_FILE`, `LOG_LEVEL`, `TRUST_PROXY` and `METRICS_TOKEN`.
  - Production refuses insecure combinations.
- **Request context and logs.**
  - An `AsyncLocalStorage` request context carries a `requestId` for each request.
  - pino writes JSON logs, redacts secrets, and adds `requestId` to every line written inside a request.
  - Every error body carries `requestId`. Unexpected errors return only `{ code: 'INTERNAL', requestId }`.
  - `appendTrail` stamps the current `requestId` into each trail bundle before sealing it.
  - Postgres constraint and trigger errors become 4xx responses with stable codes.
- **HTTP security.**
  - helmet sets a strict CSP on the API. The sign-in and signing pages get a per-response script nonce.
  - nginx sets the SPA's CSP and security headers, and forwards `X-Forwarded-For` and `X-Request-Id`.
  - `TRUST_PROXY` tells Express how many proxies to trust.
  - express-rate-limit protects `/auth/*` and the signing routes.
- **Probes and metrics.**
  - `/healthz` is liveness. `/readyz` checks the database and the blob store.
  - `/metrics` serves prom-client metrics, behind a bearer token when `METRICS_TOKEN` is set:
    - HTTP latency and errors
    - LLM calls, fallbacks and tokens, through a provider wrapper
    - trail append latency
    - signature failures
  - All three are mounted at the root, outside sessions. nginx doesn't proxy them.
- **Integrity verification (REQ-24).**
  - `node dist/db/cli.js verify` (`npm run verify`) runs `verifyIntegrity()`.
  - `GET /api/trail/verify` keeps its chain-only answer for the trail tab.
  - It recomputes the trail chain and checks every signature against its finding history, its trail bundle and the finding's sign-offs.
  - It re-hashes every stored document's bytes.
  - It prints one JSON report and exits 1 on any failure.
- **Database roles (REQ-20 against the API's own login).**
  - Migration `009` creates a `NOLOGIN` role `audit_api` with only the table privileges the API uses.
  - The record tables get `SELECT, INSERT` and no `UPDATE` or `DELETE`. The knowledge graph and migration bookkeeping are read-only. Nothing gets `TRUNCATE` or `TRIGGER`.
  - `cli create-api-login <name>` creates or updates a login that is a member of `audit_api`.
  - The migrate and compile steps keep the owner login.
- **Trail visibility.** A reader who may not read a document's classification sees its `document:register` trail entries redacted, not removed.
- **CI and image.**
  - GitHub Actions runs typecheck, the test suite (Testcontainers), eval, traceability, `npm audit`, both image builds and Trivy.
  - Compose runs the API with a read-only root filesystem and container health checks.
- **Docs.**
  - Azure reference deployment guide.
  - Operations runbook (backup, restore, verify, monitoring).
  - Validation package additions: REQ-24, REQ-25 and Client responsibilities.

**Tech Stack:**
- Node 22, TypeScript, Express 5, Kysely + Postgres 16 (+ pgvector), zod 4.
- New runtime dependencies, all at least two weeks old: `pino` 10.3.1, `helmet` 8.3.0, `express-rate-limit` 8.7.0 and `prom-client` 15.1.3.
- PGlite for eval.
- vitest + Testcontainers + supertest.
- React 18 + MUI 5, nginx 1.27.
- GitHub Actions: `actions/checkout@v7.0.1`, `actions/setup-node@v7.0.0`, `aquasecurity/trivy-action@v0.36.0`.

**Spec:** `docs/superpowers/specs/2026-10-11-production-foundation-design.md`:
- §7 deployment and operations
- §8 error handling
- §10 CI
- §11 REQ-24, REQ-25 and Client responsibilities

Items carried into 1F:
- From plan 1A:
  - (a) separate Postgres roles
  - (b) `request_id` in trail bundles and error bodies
  - (d) map pg constraint and trigger errors to 4xx
- From plan 1C: rate limiting of signing attempts.
- From plan 1D: trail visibility by classification.

This plan builds on 1A–1E. Its branch is `design/foundation-1f-operations`, stacked on `design/foundation-1e-knowledge` (PR #6).

## Global Constraints

- **Database.**
  - Kysely for queries. Plain SQL migrations in `backend/migrations/`, never applied on start-up.
  - Add `009_api_role.sql`; never edit `001`–`008`.
  - PGlite (eval) runs every migration. A one-off probe confirmed PGlite accepts `CREATE ROLE`, `GRANT`, `SET ROLE` and denies a non-granted `UPDATE`.
- **Engine changes allowed in 1F, and nothing else in `src/engine`:**
  - `engine/types.ts`: `TrailBundle` gains optional `requestId?: string`.
  - `engine/llm/provider.ts`: `GenerateResult` gains optional `usage?: { inputTokens: number; outputTokens: number }`.
  - `engine/llm/anthropic.ts`: fills `usage` from the response.
- **Error bodies.**
  - Every JSON error body is `{ error, code, requestId }`. The 400 validation body also keeps `issues`.
  - An unexpected error (anything that isn't an `AppError`, `ZodError`, oversized body or mapped Postgres error) returns `500 { code: 'INTERNAL', requestId }` and nothing else. It is logged with the request id.
- **Postgres error mapping.** The client message is fixed per code, because Postgres details can contain key values. The detail is logged.

  | SQLSTATE | Status | Code | Message |
  |---|---|---|---|
  | `23505` | 409 | `CONFLICT` | `This record already exists` |
  | `23503` | 400 | `VALIDATION` | `This refers to a record that does not exist` |
  | `23514` | 400 | `VALIDATION` | `This value is not allowed` |
  | `22P05` | 400 | `VALIDATION` | `This text contains characters that cannot be stored` |
  | `42501` | 403 | `RECORD_IMMUTABLE` | `This record cannot be changed` |
- **Request ids.**
  - The format is `^[A-Za-z0-9._-]{8,128}$`.
  - An incoming `X-Request-Id` is used only when `TRUST_PROXY > 0` and the value matches. Otherwise the API generates `crypto.randomUUID()`.
  - Every response carries `X-Request-Id`.
  - nginx sets `proxy_set_header X-Request-Id $request_id`, so a browser can't choose the id written into the trail.
- **`requestId` in the trail.**
  - `appendTrail` sets `requestId` on the bundle before sealing, only when a request context exists and the bundle has none.
  - Bundles written outside a request (CLI, seed, import, eval) have no `requestId`.
  - The hash covers the field like any other.
- **Logs.**
  - pino JSON goes to stdout, at the level set by `LOG_LEVEL` (default `info`).
  - Redacted paths: `req.headers.cookie`, `req.headers.authorization`, `req.headers["x-csrf-token"]`, `res.headers["set-cookie"]`, `*.password`, `*.clientSecret`, `*.token`, `*.secret`.
  - Never log a session token, CSRF token, OIDC client secret, storage key or API key.
  - One access-log line per request: `{ method, route, status, ms, user }`. It is at `info`, except `/healthz`, `/readyz` and `/metrics`, which are at `debug`.
- **Settings (new).**

  | Variable | Values | Default | Production rule |
  |---|---|---|---|
  | `DATABASE_SSL` | `disable \| require \| verify-full` | `verify-full` in production, else `disable` | `disable` is refused |
  | `DATABASE_SSL_CA_FILE` | path to a PEM file | unset | optional |
  | `LOG_LEVEL` | `fatal \| error \| warn \| info \| debug \| trace \| silent` | `info` | — |
  | `TRUST_PROXY` | integer 0–5 | `0` | — |
  | `METRICS_TOKEN` | at least 24 characters | unset | required |

  - A `DATABASE_URL` containing `sslmode=` is refused, because node-postgres lets the URL override the TLS settings. Use `DATABASE_SSL` instead.
- **Secret files.**
  - These names may also be given as `<NAME>_FILE`:
    - `DATABASE_URL`
    - `OIDC_CLIENT_SECRET`
    - `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
    - `AZURE_STORAGE_CONNECTION_STRING`
    - `ANTHROPIC_API_KEY`
    - `METRICS_TOKEN`
    - `API_DB_PASSWORD`
  - The file's content, with trailing whitespace trimmed, becomes the value.
  - Setting both `<NAME>` and `<NAME>_FILE` is an error.
- **Rate limits.** In-memory, per client IP after `TRUST_PROXY`, standard `RateLimit` headers. Over the limit, the response is `429 { error, code: 'RATE_LIMITED', requestId }`.
  - `/auth/*` (sign-in, callback, dev login, signing pages): 60 requests per minute.
  - Signing: 20 per minute on `POST /api/engagements/:id/findings/:fid/sign-intents`, and on everything under `/auth/sign/`. `/auth/sign/` traffic counts toward both limits.
  - `createApp` takes the limits as options, so tests can lower them.
- **CSP.**
  - The API sends helmet's headers with this policy: `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.
  - The HTML pages (`auth/page.ts`, `signing/pages.ts`) use their own policy: `default-src 'none'; script-src 'nonce-<n>'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`. The nonce is 16 random bytes in base64, new for each response.
  - Document downloads keep their own `sandbox; default-src 'none'`.
  - nginx sends the SPA's policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. MUI/emotion injects style tags, so `style-src` needs `'unsafe-inline'`.
  - helmet's `Cross-Origin-Opener-Policy: same-origin` is safe here: the signing window is never read through `window.opener`, and the app polls the request status instead (`frontend/src/signing.ts`).
- **CORS stays off.**
  - The UI is same-origin behind nginx, so the API sends no CORS headers. That is stricter than "limited to the web origin" in §7.6.
- **Metrics names** (prom-client; default process metrics prefixed `audit_`):
  - `audit_http_request_duration_seconds{method,route,status}` (histogram)
  - `audit_http_errors_total{code}`
  - `audit_llm_calls_total{provider,outcome}`
  - `audit_llm_fallbacks_total{provider,kind}`
    - `kind="model"` is a server-side switch to another model (the served model differs from the configured one).
    - `kind="deterministic"` is a failed call, after which the module uses its offline rules (`engine/modules/llm-step.ts`).
  - `audit_llm_tokens_total{provider,kind}`
  - `audit_trail_append_seconds` (histogram)
  - `audit_signature_failures_total{code}`
  - `route` is the matched Express route pattern, never the raw URL. Unmatched requests are `unmatched`.
- **Readiness.**
  - The database check is `select 1`.
  - The blob store check is `blobs.head('0'.repeat(64))`: `null` means reachable, a throw means not ready.
  - Each check has a 2-second timeout. The response is `200 { ok: true, checks }` or `503 { ok: false, checks }`, where `checks` maps each check to `'ok'` or a short reason.
  - With no blob store configured, the blob check is `'not configured'` and doesn't fail readiness.
- **`audit_api` privileges.**

  | Privilege | Tables |
  |---|---|
  | `SELECT` | every table in `public` |
  | `INSERT, UPDATE` | `engagements`, `engagement_work`, `findings`, `users`, `sessions`, `sign_intents` |
  | `INSERT` only | `trail`, `signatures`, `finding_revisions`, `documents`, `document_text`, `chunks`, `blob_uploads`, `eval_runs` |
  | read-only | `kg_nodes`, `kg_node_versions`, `kg_edges`, `schema_migrations` |
  | `USAGE` | every sequence in `public` (`findings.seq` is a `bigserial`) |

  - Nothing gets `DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER`.
  - `audit_api` owns nothing, so it can't alter or drop a table or its triggers.
  - No default privileges are granted. A table added later gets no privileges until its migration grants them, and a test fails until it is classified.
- **Verify.**
  - It writes one JSON object to stdout:
    ```
    { ok, trail: { valid, length, brokenAt, reason },
      signatures: { checked, problems: string[] },
      documents: { checked, problems: string[], skipped: string | null } }
    ```
  - Exit code: 0 when `ok`, 1 otherwise.
  - Every document's bytes are streamed from storage and re-hashed, and the size is compared.
  - The storage check is skipped, with the reason in `skipped`, only when the storage configuration fails to load. A skipped check makes `ok` false, because a verify that couldn't look at the files proves nothing about them.
- **Tests, eval and requirements.**
  - Tests keep their `[REQ-xx]` tags.
  - `npm run eval` stays 25/25 with `ALLOW_UNVERIFIED_CITATIONS=true`.
  - `validation/requirements.json` changes only by adding REQ-24 and REQ-25, with the spec's text. `npm run traceability` reaches 25/25.
- **Commits and content.**
  - No secrets are committed.
  - Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote it.
  - Gartner material never enters code, packs, prompts or the repo.

**Deliberate refinements of the spec (1F):**
- **Lint.** CI runs `tsc --noEmit` (strict) for the backend and frontend as the lint gate. ESLint is deferred, because adding a linter to an established codebase produces churn unrelated to production readiness. The type checker already enforces the rules that matter here. A follow-up issue records this.
- **End-to-end tests.** The Playwright set (§10) is deferred. It needs the full Compose stack plus the re-authentication pop-up in CI. The flow is covered end to end through supertest: sign-in, run the chain, review and approval signatures with re-authentication, report. The follow-up is recorded.
- **`npm audit` in CI fails on `high` and above** (`--audit-level=high`). The frontend has two moderate advisories in `react-router-dom` 6, and the fix is a breaking upgrade to 7. That upgrade is a separate change.
- **The image keeps `tests/`.** `GET /api/validation/traceability` builds the traceability matrix from test titles at run time (`src/validation/traceability.ts`). The tests are source code with no secrets.
- **Compose keeps one database login.** Its `migrate` service and its development API both use the owner, because the development API compiles packs at start-up, which needs write access. The separate login is for production and is documented in the Azure guide. A test proves the API works end to end as `audit_api`.
- **Read-only root filesystem.** Compose sets `read_only: true` with a `tmpfs` at `/tmp`. Azure Container Apps doesn't expose this setting; the guide says so.
- **Search is not recorded in the trail** (§6.5). This stays deferred from 1E.

## Review Focus

1. **A production deployment that forgets `DATABASE_SSL`, `METRICS_TOKEN` or sets `TRUST_PROXY` wrong.** Start-up must refuse with every problem listed at once, not one per restart. Pinned in Task 1 (`loadServerConfig` reports several problems in one message).
2. **Secrets in logs.** A sign-in, a failed OIDC callback and an unexpected 500 must never print the session cookie, the CSRF token or the OIDC client secret, even at `trace`. Pinned in Task 2 (capture logs at `trace` during sign-in and a forced error, then search them for the secrets).
3. **Everyone behind nginx sharing one IP.** With `TRUST_PROXY=1`, two clients with different `X-Forwarded-For` values are counted separately. Without it, the socket address is used and a forged header can't reset the limit. Pinned in Task 3.
4. **The API's own database login.** A full happy path runs connected as an `audit_api` member: create engagement, run the chain, sign, register a document, search. The same login can't update or delete the trail or signatures, disable their triggers, or truncate anything. Pinned in Task 6.
5. **A restore that silently lost a stored file or had a signature row rewritten.** `verify` must report it and exit 1, while a clean database reports `ok: true`. Pinned in Task 5.

## File structure

| File | Responsibility |
|---|---|
| `backend/src/config.ts` | `prepareEnv()`, `resolveSecretFiles()`, extended `loadConfig()`, `loadServerConfig()` |
| `backend/src/db/index.ts` | `connectPg` takes `ssl` |
| `backend/src/observability/context.ts` | Request context (`AsyncLocalStorage`), `currentRequestId()`, `requestContext()` middleware |
| `backend/src/observability/log.ts` | pino `logger`, redaction, `captureLogs()` for tests, `accessLog()` middleware |
| `backend/src/observability/metrics.ts` | prom-client registry and metrics, `httpMetrics()` middleware, `metricsRoute()` |
| `backend/src/observability/probes.ts` | `/healthz`, `/readyz`, `/metrics` router |
| `backend/src/observability/llm.ts` | `instrumentProvider()` |
| `backend/src/http/security.ts` | helmet, rate limiters, `trust proxy` |
| `backend/src/http/errors.ts` | The error middleware, including Postgres error mapping |
| `backend/src/ops/verify.ts` | `verifyIntegrity()` |
| `backend/migrations/009_api_role.sql` | `audit_api` role and grants |
| `backend/src/db/cli.ts` | `verify` (full), `create-api-login` |
| `backend/src/knowledge/trail-visibility.ts` | `visibleTrail()` |
| `frontend/nginx.conf`, `frontend/src/api.ts` | Proxy headers and CSP; showing the error reference |
| `.github/workflows/ci.yml` | CI |
| `docs/deploy/azure.md`, `docs/deploy/operations.md`, `backend/validation/README.md`, `README.md` | Docs |

---
### Task 1: Configuration hardening: secret files, database TLS and one start-up check (REQ-25)

**Files:**
- Modify: `backend/src/config.ts` (secret files, new settings, `loadServerConfig`)
- Modify: `backend/src/db/index.ts` (`connectPg` takes `ssl`)
- Modify: `backend/src/server.ts`, `backend/src/db/cli.ts`, `backend/src/knowledge/packs-cli.ts`, `backend/src/seed.ts`, `backend/src/eval/cli.ts` (call `prepareEnv()`, pass `databaseSsl`)
- Modify: `backend/tests/persistence.test.ts` (the `loadConfig` shape test)
- Modify: `backend/validation/requirements.json` (add REQ-25)
- Modify: `backend/.env.example`
- Test: `backend/tests/config.test.ts` (new)

**Interfaces:**
- Consumes:
  - `loadAuthConfig(env)` (`auth/config.ts`)
  - `loadStorageConfig(env)` (`storage/config.ts`)
  - `loadCitationPolicy(env)` (`config.ts`)
  - each throws `Error('Invalid configuration:\n  - KEY: message…')`
- Produces:
  - `prepareEnv(env?: NodeJS.ProcessEnv): void`: loads `backend/.env` (outside production), then `resolveSecretFiles(env)`.
  - `resolveSecretFiles(env: NodeJS.ProcessEnv): void`: mutates `env`.
  - `export const SECRET_NAMES: readonly string[]`
  - `interface Config`:
    ```ts
    {
      port: number; databaseUrl: string; packsDir?: string;
      production: boolean;
      databaseSsl: DatabaseSsl;
      logLevel: LogLevel;
      trustProxy: number;
      metricsToken: string | null;
    }
    ```
  - `type DatabaseSsl = false | { rejectUnauthorized: boolean; ca?: string }`
  - `type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'`
  - `loadServerConfig(env?)`, returning `{ core: Config; auth: AuthConfig; storage: StorageConfig; citationPolicy: CitationPolicy }`. On failure it throws one `Error` whose message starts `Invalid configuration:` and lists every problem from every loader.
  - `connectPg(url, { …, ssl?: DatabaseSsl })`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/config.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadServerConfig, resolveSecretFiles } from '../src/config';

const URL = 'postgres://u:p@db.example.com:5432/audit';
const TOKEN = 'm'.repeat(32);

/** A production environment that passes every check; each test breaks one thing. */
function prod(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'production', DATABASE_URL: URL, METRICS_TOKEN: TOKEN, DEV_AUTH: 'false',
    PUBLIC_URL: 'https://audit.example.com', OIDC_ISSUER: 'https://login.example.com/t/v2.0', OIDC_CLIENT_ID: 'app',
    OIDC_REDIRECT_URI: 'https://audit.example.com/auth/callback', BLOB_DRIVER: 's3', S3_BUCKET: 'evidence',
    ALLOW_UNVERIFIED_CITATIONS: 'false', ...over,
  };
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv;
}

function tmpFile(content: string) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'secret');
  fs.writeFileSync(file, content);
  return file;
}

describe('configuration', () => {
  it('accepts a complete production configuration with verified database TLS [REQ-25]', () => {
    const cfg = loadServerConfig(prod());
    expect(cfg.core).toMatchObject({ production: true, databaseSsl: { rejectUnauthorized: true }, trustProxy: 0, logLevel: 'info', metricsToken: TOKEN });
    expect(cfg.auth.devAuth).toBe(false);
    expect(cfg.storage.driver).toBe('s3');
    expect(cfg.citationPolicy).toEqual({ allowUnverified: false });
  });

  it.each([
    ['DATABASE_SSL=disable', { DATABASE_SSL: 'disable' }, /DATABASE_SSL: must not be disable in production/],
    ['no METRICS_TOKEN', { METRICS_TOKEN: undefined }, /METRICS_TOKEN: required in production/],
    ['a short METRICS_TOKEN', { METRICS_TOKEN: 'short' }, /METRICS_TOKEN: .*24/],
    ['sslmode in DATABASE_URL', { DATABASE_URL: `${URL}?sslmode=disable` }, /DATABASE_URL: .*sslmode.*DATABASE_SSL/],
    ['DEV_AUTH=true', { DEV_AUTH: 'true' }, /DEV_AUTH must not be true in production/],
    ['ALLOW_UNVERIFIED_CITATIONS=true', { ALLOW_UNVERIFIED_CITATIONS: 'true' }, /ALLOW_UNVERIFIED_CITATIONS: must not be true in production/],
    ['local file storage', { BLOB_DRIVER: 'local' }, /BLOB_DRIVER=local is for development only/],
    ['plain-http PUBLIC_URL', { PUBLIC_URL: 'http://audit.example.com', OIDC_REDIRECT_URI: 'http://audit.example.com/auth/callback' }, /PUBLIC_URL must use https in production/],
    ['TRUST_PROXY out of range', { TRUST_PROXY: '9' }, /TRUST_PROXY/],
    ['an unknown LOG_LEVEL', { LOG_LEVEL: 'verbose' }, /LOG_LEVEL/],
  ])('refuses %s in production [REQ-25]', (_name, over, message) => {
    expect(() => loadServerConfig(prod(over))).toThrow(message);
  });

  it('lists every problem at once, so an operator fixes them in one go [REQ-25]', () => {
    let message = '';
    try {
      loadServerConfig(prod({ DATABASE_SSL: 'disable', METRICS_TOKEN: undefined, DEV_AUTH: 'true', BLOB_DRIVER: 'local' }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.startsWith('Invalid configuration:')).toBe(true);
    for (const key of ['DATABASE_SSL', 'METRICS_TOKEN', 'DEV_AUTH', 'BLOB_DRIVER']) expect(message).toContain(`- ${key}`);
    expect(message.match(/Invalid configuration:/g)).toHaveLength(1);
  });

  it('reads database TLS settings and keeps development defaults simple', () => {
    expect(loadConfig({ DATABASE_URL: URL })).toEqual({
      port: 3002, databaseUrl: URL, packsDir: undefined, production: false, databaseSsl: false, logLevel: 'info', trustProxy: 0, metricsToken: null,
    });
    expect(loadConfig({ DATABASE_URL: URL, DATABASE_SSL: 'require' }).databaseSsl).toEqual({ rejectUnauthorized: false });
    const ca = tmpFile('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    expect(loadConfig({ DATABASE_URL: URL, DATABASE_SSL: 'verify-full', DATABASE_SSL_CA_FILE: ca }).databaseSsl).toEqual({
      rejectUnauthorized: true, ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    });
    expect(() => loadConfig({ DATABASE_URL: URL, DATABASE_SSL_CA_FILE: '/nonexistent/ca.pem' })).toThrow(/DATABASE_SSL_CA_FILE: cannot read/);
  });

  it('reads secrets from <NAME>_FILE and refuses both forms at once [REQ-25]', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL_FILE: tmpFile(`${URL}\n`), OIDC_CLIENT_SECRET_FILE: tmpFile('s3cr3t  \n') };
    resolveSecretFiles(env);
    expect(env.DATABASE_URL).toBe(URL);
    expect(env.OIDC_CLIENT_SECRET).toBe('s3cr3t');
    expect(() => resolveSecretFiles({ METRICS_TOKEN: TOKEN, METRICS_TOKEN_FILE: tmpFile(TOKEN) })).toThrow(/METRICS_TOKEN and METRICS_TOKEN_FILE/);
    expect(() => resolveSecretFiles({ ANTHROPIC_API_KEY_FILE: '/nonexistent/key' })).toThrow(/ANTHROPIC_API_KEY_FILE: cannot read/);
    // Only known secret names are read from files.
    const other: NodeJS.ProcessEnv = { PORT_FILE: tmpFile('1') };
    resolveSecretFiles(other);
    expect(other.PORT).toBeUndefined();
  });
});
```

In `backend/tests/persistence.test.ts`, test "refuses to start without a valid DATABASE_URL", replace the last assertion with:

```ts
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', PORT: '4000' })).toMatchObject({ port: 4000, databaseUrl: 'postgres://u:p@h:5432/d', packsDir: undefined });
```

- [ ] **Step 2: Run the test and make sure it fails**

Run: `cd backend && npx vitest run tests/config.test.ts`
Expected: FAIL, because `loadServerConfig` and `resolveSecretFiles` are not exported.

- [ ] **Step 3: Implement the configuration**

Replace `backend/src/config.ts` with:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadAuthConfig, type AuthConfig } from './auth/config';
import type { CitationPolicy } from './engine/trust';
import { loadStorageConfig, type StorageConfig } from './storage/config';

// Configuration comes from the environment only, validated once at start-up (spec §7.3, REQ-25).
// Each area has its own loader; loadServerConfig runs them all and reports every problem at once.

export type DatabaseSsl = false | { rejectUnauthorized: boolean; ca?: string };
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface Config {
  port: number;
  databaseUrl: string;
  packsDir?: string;
  production: boolean;
  databaseSsl: DatabaseSsl;
  logLevel: LogLevel;
  /** How many proxies in front of the API to trust for the client address and X-Request-Id (0 = none). */
  trustProxy: number;
  /** Bearer token for /metrics; null = open (development only). */
  metricsToken: string | null;
}

/** Settings that may instead be read from a mounted file named by <NAME>_FILE (Kubernetes / Container Apps secrets). */
export const SECRET_NAMES = [
  'DATABASE_URL', 'OIDC_CLIENT_SECRET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'AZURE_STORAGE_CONNECTION_STRING',
  'ANTHROPIC_API_KEY', 'METRICS_TOKEN', 'API_DB_PASSWORD',
] as const;

const invalid = (lines: string[]) => new Error(`Invalid configuration:\n${lines.join('\n')}`);

/** Replaces each <NAME>_FILE with the file's content (trailing whitespace trimmed) as <NAME>. */
export function resolveSecretFiles(env: NodeJS.ProcessEnv): void {
  const problems: string[] = [];
  for (const name of SECRET_NAMES) {
    const file = env[`${name}_FILE`];
    if (!file) continue;
    if (env[name]) {
      problems.push(`  - ${name}: set ${name} and ${name}_FILE, not both`);
      continue;
    }
    try {
      env[name] = fs.readFileSync(file, 'utf8').trimEnd();
    } catch {
      problems.push(`  - ${name}_FILE: cannot read ${file}`);
    }
  }
  if (problems.length) throw invalid(problems);
}

/** Loads backend/.env for local development. Never used in production. */
export function loadDotEnv(file = path.resolve(__dirname, '../.env')) {
  if (process.env.NODE_ENV === 'production') return;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    // No .env file: rely on the real environment. Anything else (permissions, parse errors) is a real problem.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Every entry point calls this first: the local .env (development), then secret files. */
export function prepareEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env === process.env) loadDotEnv();
  resolveSecretFiles(env);
}

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL'),
    DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).optional(),
    DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
    PACKS_DIR: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    METRICS_TOKEN: z.string().min(24, 'must be at least 24 characters').optional(),
  })
  .superRefine((e, ctx) => {
    const production = e.NODE_ENV === 'production';
    if (/[?&]sslmode=/i.test(e.DATABASE_URL)) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'remove sslmode from the URL and set DATABASE_SSL instead (the URL would override it)' });
    }
    if (production && e.DATABASE_SSL === 'disable') {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_SSL'], message: 'must not be disable in production; the database connection must use TLS' });
    }
    if (production && !e.METRICS_TOKEN) {
      ctx.addIssue({ code: 'custom', path: ['METRICS_TOKEN'], message: 'required in production (Prometheus sends it as a bearer token)' });
    }
  });

/** Problem lines ("  - KEY: message") for the core settings, plus the parsed config when there are none. */
function parseCore(env: NodeJS.ProcessEnv): { config: Config | null; problems: string[] } {
  // Compose passes unset optional settings as empty strings; treat them as absent.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) return { config: null, problems: parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`) };
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const mode = e.DATABASE_SSL ?? (production ? 'verify-full' : 'disable');
  let ca: string | undefined;
  if (e.DATABASE_SSL_CA_FILE) {
    try {
      ca = fs.readFileSync(e.DATABASE_SSL_CA_FILE, 'utf8');
    } catch {
      return { config: null, problems: [`  - DATABASE_SSL_CA_FILE: cannot read ${e.DATABASE_SSL_CA_FILE}`] };
    }
  }
  const databaseSsl: DatabaseSsl = mode === 'disable' ? false : { rejectUnauthorized: mode === 'verify-full', ...(ca ? { ca } : {}) };
  return {
    problems: [],
    config: {
      port: e.PORT, databaseUrl: e.DATABASE_URL, packsDir: e.PACKS_DIR, production, databaseSsl,
      logLevel: e.LOG_LEVEL, trustProxy: e.TRUST_PROXY, metricsToken: e.METRICS_TOKEN ?? null,
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { config, problems } = parseCore(env);
  if (!config) throw invalid(problems);
  return config;
}

/**
 * ALLOW_UNVERIFIED_CITATIONS (spec §6.4): until a domain expert has verified the content packs,
 * demos may cite unverified knowledge with a warning. Never in production.
 */
export function loadCitationPolicy(env: NodeJS.ProcessEnv = process.env): CitationPolicy {
  const raw = env.ALLOW_UNVERIFIED_CITATIONS ?? 'false';
  if (raw !== 'true' && raw !== 'false') {
    throw new Error('Invalid configuration:\n  - ALLOW_UNVERIFIED_CITATIONS: must be "true" or "false"');
  }
  if (raw === 'true' && env.NODE_ENV === 'production') {
    throw new Error('Invalid configuration:\n  - ALLOW_UNVERIFIED_CITATIONS: must not be true in production; released work may cite only verified knowledge');
  }
  return { allowUnverified: raw === 'true' };
}

export interface ServerConfig {
  core: Config;
  auth: AuthConfig;
  storage: StorageConfig;
  citationPolicy: CitationPolicy;
}

/** Runs every loader and throws once, listing every problem, so a deployment is fixed in one pass (REQ-25). */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = [];
  const attempt = <T>(load: () => T): T | null => {
    try {
      return load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      problems.push(...message.replace(/^Invalid configuration:\n/, '').split('\n').filter(Boolean));
      return null;
    }
  };
  const core = attempt(() => loadConfig(env));
  const auth = attempt(() => loadAuthConfig(env));
  const storage = attempt(() => loadStorageConfig(env));
  const citationPolicy = attempt(() => loadCitationPolicy(env));
  if (problems.length) throw invalid(problems);
  return { core: core!, auth: auth!, storage: storage!, citationPolicy: citationPolicy! };
}
```

The existing loaders emit `DEV_AUTH must not be true in production` with the key in the path, so their lines already read `  - DEV_AUTH: …`. The multi-problem test relies on this.

In `backend/src/db/index.ts`, add `ssl` to `ConnectOptions` and pass it to the pool:

```ts
import type { DatabaseSsl } from '../config';
// …
export interface ConnectOptions {
  max?: number;
  connectionTimeoutMillis?: number;
  idle_in_transaction_session_timeout?: number;
  statement_timeout?: number;
  /** TLS for the connection (DATABASE_SSL); false = plain TCP (development and tests only). */
  ssl?: DatabaseSsl;
}
// in connectPg, add to the pg.Pool options:
    ssl: opts.ssl ?? false,
```

Make the entry points read the environment the same way:
- `src/server.ts`: replace `loadDotEnv(); const config = loadConfig(); const citationPolicy = loadCitationPolicy(); const auth = loadAuthConfig(); const storage = loadStorageConfig();` with:
  ```ts
  prepareEnv();
  const { core: config, auth, storage, citationPolicy } = loadServerConfig();
  ```
  Then use `connectPg(config.databaseUrl, { ssl: config.databaseSsl })`. Remove the now-unused imports.
- `src/db/cli.ts`, `src/knowledge/packs-cli.ts` and `src/seed.ts`: replace `loadDotEnv()` with `prepareEnv()`. Pass `ssl: config.databaseSsl` to `connectPg`, keeping the existing `max`.
- `src/eval/cli.ts`: replace `loadDotEnv()` with `prepareEnv()`.

In `backend/.env.example`, add after `PORT=3002`:

```
# Database TLS: disable | require | verify-full (default verify-full in production, where disable is refused).
# Put TLS in DATABASE_SSL, never in the URL (sslmode= is refused). Optional CA bundle: DATABASE_SSL_CA_FILE=/path/ca.pem
# DATABASE_SSL=disable
# fatal | error | warn | info (default) | debug | trace | silent
# LOG_LEVEL=info
# Proxies in front of the API whose X-Forwarded-For / X-Request-Id are trusted (Compose's nginx = 1)
# TRUST_PROXY=0
# Bearer token Prometheus sends to /metrics (at least 24 characters; required in production)
# METRICS_TOKEN=
# Any secret may instead be read from a file: DATABASE_URL_FILE, OIDC_CLIENT_SECRET_FILE, S3_ACCESS_KEY_ID_FILE,
# S3_SECRET_ACCESS_KEY_FILE, AZURE_STORAGE_CONNECTION_STRING_FILE, ANTHROPIC_API_KEY_FILE, METRICS_TOKEN_FILE, API_DB_PASSWORD_FILE
```

In `backend/validation/requirements.json`, append:

```json
  { "id": "REQ-25", "risk": "Medium", "text": "Configuration is validated at start-up; insecure combinations are refused.", "evalKinds": [] }
```

Put it on one line, as the file's other entries are, and add a comma after the entry before it.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd backend && npx vitest run tests/config.test.ts tests/persistence.test.ts tests/auth.test.ts tests/trust.test.ts && npm run typecheck`
Expected: PASS.

Then run `npm test && ALLOW_UNVERIFIED_CITATIONS=true npm run eval && npm run traceability`. Expected: everything passes, eval is 25/25 and traceability is 24/24.

- [ ] **Step 5: Commit**

```bash
git add backend/src/config.ts backend/src/db/index.ts backend/src/server.ts backend/src/db/cli.ts backend/src/knowledge/packs-cli.ts backend/src/seed.ts backend/src/eval/cli.ts backend/tests/config.test.ts backend/tests/persistence.test.ts backend/validation/requirements.json backend/.env.example
git commit -m "Validate all configuration at start-up, read secrets from files and require database TLS in production (REQ-25)

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
### Task 2: Request ids, structured logs and error responses

**Files:**
- Create: `backend/src/observability/context.ts`, `backend/src/observability/log.ts`, `backend/src/http/errors.ts`
- Modify:
  - `backend/src/engine/types.ts`: optional `requestId` on `TrailBundle`
  - `backend/src/errors.ts`: `RECORD_IMMUTABLE` code
  - `backend/src/db/trail-repo.ts`: stamp `requestId`
  - `backend/src/app.ts`: request context, access log, error handler and an `OpsOptions` parameter
  - `backend/src/server.ts`, `backend/src/db/index.ts`, `backend/src/auth/routes.ts`, `backend/src/signing/routes.ts`, `backend/src/knowledge/routes.ts`: `console.*` becomes `logger`
  - `backend/package.json`: `pino`
  - `frontend/src/api.ts`, `frontend/src/api.test.ts`: show the error reference
- Test: `backend/tests/observability.test.ts` (new)

**Interfaces:**
- Consumes: `Config.logLevel` and `Config.trustProxy` (Task 1); `appendTrail` (`db/trail-repo.ts`); `createApp(svc, auth, storage)`.
- Produces:
  - `currentRequestId(): string | undefined`
  - `requestContext(opts: { trustProxy: number }): RequestHandler`, which sets `req.requestId` and the `X-Request-Id` header
  - `REQUEST_ID_PATTERN`
  - `logger: pino.Logger`
  - `setLogLevel(level: LogLevel): void`
  - `captureLogs(level?: LogLevel): { text(): string; restore(): void }`
  - `accessLog(): RequestHandler`
  - `errorHandler(): ErrorRequestHandler`
  - `pgErrorResponse(err: unknown): { status: number; code: ErrorCode; message: string } | null`
  - `export interface OpsOptions { trustProxy?: number }`. This is `createApp`'s fourth parameter, defaulting to `{}`; Tasks 3 and 4 add fields.
  - `TrailBundle.requestId?: string`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/observability.test.ts`:

```ts
import express from 'express';
import { sql } from 'kysely';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { readTrail } from '../src/db/trail-repo';
import { verifyChain } from '../src/engine/trail';
import { errorHandler, pgErrorResponse } from '../src/http/errors';
import { requestContext } from '../src/observability/context';
import { captureLogs, logger } from '../src/observability/log';
import { auditor, NEW_ENGAGEMENT } from './helpers';
import { appWithDevUsers, devAuthConfig, signIn } from './http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('request ids and error responses', () => {
  it('answers unexpected errors with only a code and the request id, and logs the detail under that id', async () => {
    const { svc, app } = await appWithDevUsers();
    const user = await signIn(app, 'auditor');
    await sql`ALTER TABLE engagements RENAME TO engagements_gone`.execute(svc.db.kysely);
    const logs = captureLogs('info');
    const res = await user.get('/api/engagements').expect(500);
    logs.restore();
    expect(res.body).toEqual({ code: 'INTERNAL', requestId: res.headers['x-request-id'] });
    expect(res.headers['x-request-id']).toMatch(UUID);
    const line = logs.text().split('\n').find((l) => l.includes('"unexpected error"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ level: 50, requestId: res.headers['x-request-id'] });
    expect(line).toContain('engagements');
  });

  it('maps database constraint and trigger errors to 4xx without echoing Postgres details', async () => {
    const pgError = (code: string) => Object.assign(new Error(`duplicate key value violates "x" Key (id)=(SECRET-${code})`), { code, severity: 'ERROR', detail: `Key (id)=(SECRET-${code})` });
    expect(pgErrorResponse(pgError('23505'))).toEqual({ status: 409, code: 'CONFLICT', message: 'This record already exists' });
    expect(pgErrorResponse(pgError('23503'))).toEqual({ status: 400, code: 'VALIDATION', message: 'This refers to a record that does not exist' });
    expect(pgErrorResponse(pgError('23514'))).toEqual({ status: 400, code: 'VALIDATION', message: 'This value is not allowed' });
    expect(pgErrorResponse(pgError('22P05'))).toEqual({ status: 400, code: 'VALIDATION', message: 'This text contains characters that cannot be stored' });
    expect(pgErrorResponse(pgError('42501'))).toEqual({ status: 403, code: 'RECORD_IMMUTABLE', message: 'This record cannot be changed' });
    expect(pgErrorResponse(pgError('42P01'))).toBeNull();
    expect(pgErrorResponse(new Error('plain'))).toBeNull();

    const app = express();
    app.use(requestContext({ trustProxy: 0 }));
    app.get('/dup', () => { throw pgError('23505'); });
    app.use(errorHandler());
    const logs = captureLogs('warn');
    const res = await request(app).get('/dup').expect(409);
    logs.restore();
    expect(res.body).toEqual({ error: 'This record already exists', code: 'CONFLICT', requestId: res.headers['x-request-id'] });
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(logs.text()).toContain('SECRET-23505');
  });

  it('stamps the request id into the trail bundles a request writes', async () => {
    const { svc, app } = await appWithDevUsers();
    const user = await signIn(app, 'auditor');
    const res = await user.post('/api/engagements', NEW_ENGAGEMENT).expect(201);
    await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const trail = await readTrail(svc.db.kysely);
    const created = trail.filter((b) => b.moduleId === 'human:create-engagement');
    expect(created.map((b) => b.requestId)).toEqual([res.headers['x-request-id'], undefined]);
    expect(verifyChain(trail).valid).toBe(true);
  });

  it('uses a forwarded X-Request-Id only from a trusted proxy', async () => {
    const { svc } = await appWithDevUsers();
    const direct = createApp(svc, { config: devAuthConfig(), oidc: null });
    const proxied = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { trustProxy: 1 });
    expect((await request(direct).get('/api/health').set('X-Request-Id', 'chosen-by-client-1')).headers['x-request-id']).toMatch(UUID);
    expect((await request(proxied).get('/api/health').set('X-Request-Id', 'nginx-0123456789abcdef')).headers['x-request-id']).toBe('nginx-0123456789abcdef');
    expect((await request(proxied).get('/api/health').set('X-Request-Id', 'bad id with spaces')).headers['x-request-id']).toMatch(UUID);
  });

  it('never logs session tokens, CSRF tokens or secrets, even at trace', async () => {
    const { svc, app } = await appWithDevUsers();
    const logs = captureLogs('trace');
    const login = await request(app).post('/auth/dev-login').send({ userId: 'auditor' }).expect(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const token = cookie.split('=')[1];
    const me = await request(app).get('/api/me').set('Cookie', cookie).expect(200);
    const csrf = me.body.csrfToken as string;
    await request(app).post('/api/engagements').set('Cookie', cookie).set('x-csrf-token', csrf).send(NEW_ENGAGEMENT).expect(201);
    await sql`ALTER TABLE engagements RENAME TO engagements_gone`.execute(svc.db.kysely);
    await request(app).get('/api/engagements').set('Cookie', cookie).expect(500);
    logger.info({ oidc: { clientSecret: 'oidc-client-secret-value' }, headers: { authorization: 'Bearer abc' } }, 'config snapshot');
    logs.restore();
    const text = logs.text();
    expect(text).toContain('"route":"/api/engagements"');
    expect(text).toContain('[redacted]');
    for (const secret of [token, csrf, 'oidc-client-secret-value']) expect(text).not.toContain(secret);
  });
});
```

`backend/tests/http.ts` needs no change.

Add to `frontend/src/api.test.ts`, inside `describe('api errors', …)`:

```ts
  it('shows the request id of an unexpected server error so it can be reported', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(500, { code: 'INTERNAL', requestId: 'req-12345678' })));
    await expect(api('/x')).rejects.toMatchObject({
      status: 500, code: 'INTERNAL', requestId: 'req-12345678', message: expect.stringContaining('req-12345678'),
    });
  });
```

- [ ] **Step 2: Run the tests and make sure they fail**

Run: `cd backend && npx vitest run tests/observability.test.ts` and `cd frontend && npx vitest run src/api.test.ts`
Expected: FAIL. The backend tests can't find `../src/http/errors`, and the frontend error has no `requestId`.

- [ ] **Step 3: Implement**

Install pino: `cd backend && npm install pino@10.3.1 --save-exact=false`. Check that `package.json` shows `"pino": "^10.3.1"`.

Create `backend/src/observability/context.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

// Per-request context that follows async work, so logs and trail bundles written while serving a request
// carry its id without threading it through every call.

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** What an incoming X-Request-Id must look like to be reused (nginx's $request_id is 32 hex characters). */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export const currentRequestId = (): string | undefined => storage.getStore()?.requestId;

/**
 * Gives each request an id: a trusted proxy's X-Request-Id when there is one (TRUST_PROXY > 0), otherwise a new UUID.
 * A client talking to the API directly can't choose the id that is written into the audit trail.
 */
export function requestContext(opts: { trustProxy: number }): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    const requestId = opts.trustProxy > 0 && incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    storage.run({ requestId }, () => next());
  };
}
```

Create `backend/src/observability/log.ts`:

```ts
import type { RequestHandler } from 'express';
import pino from 'pino';
import type { LogLevel } from '../config';
import { currentRequestId } from './context';

// JSON logs on stdout. Secrets are redacted wherever they appear in a logged object (spec §7.6).
// Tests run silent unless they capture logs (captureLogs), so test output stays clean.

export const REDACTED_PATHS = [
  'req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]',
  'headers.cookie', 'headers.authorization', 'headers["x-csrf-token"]',
  '*.password', '*.clientSecret', '*.token', '*.secret', '*.csrfToken', '*.secretAccessKey', '*.connectionString',
];

let sink: (line: string) => void = (line) => process.stdout.write(line);

const defaultLevel = (): LogLevel => (process.env.LOG_LEVEL as LogLevel | undefined) ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

export const logger = pino(
  {
    level: defaultLevel(),
    base: { service: 'audit-api' },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    mixin: () => {
      const requestId = currentRequestId();
      return requestId ? { requestId } : {};
    },
  },
  { write: (line: string) => sink(line) },
);

export function setLogLevel(level: LogLevel) {
  logger.level = level;
}

/** Test helper: collects log lines at `level` until restore(). */
export function captureLogs(level: LogLevel = 'trace') {
  const lines: string[] = [];
  const previous = { sink, level: logger.level };
  sink = (line) => lines.push(line);
  logger.level = level;
  return {
    text: () => lines.join(''),
    restore() {
      sink = previous.sink;
      logger.level = previous.level;
    },
  };
}

const QUIET = new Set(['/healthz', '/readyz', '/metrics']);

/** One line per request: method, matched route (never the raw URL), status, duration and user. */
export function accessLog(): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      const entry = { method: req.method, route, status: res.statusCode, ms: Math.round(ms * 10) / 10, user: req.auth?.user.id ?? null };
      // finish fires outside the request's async context, so the id is passed explicitly.
      const child = logger.child({ requestId: req.requestId });
      if (QUIET.has(req.path)) child.debug(entry, 'request');
      else child.info(entry, 'request');
    });
    next();
  };
}
```

Create `backend/src/http/errors.ts`:

```ts
import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { AppError, type ErrorCode } from '../errors';
import { UPLOAD_PATH } from '../knowledge/routes';
import { logger } from '../observability/log';

/** Postgres errors a request can legitimately cause, answered without echoing Postgres's own text (it can hold key values). */
const PG_ERRORS: Record<string, { status: number; code: ErrorCode; message: string }> = {
  '23505': { status: 409, code: 'CONFLICT', message: 'This record already exists' },
  '23503': { status: 400, code: 'VALIDATION', message: 'This refers to a record that does not exist' },
  '23514': { status: 400, code: 'VALIDATION', message: 'This value is not allowed' },
  '22P05': { status: 400, code: 'VALIDATION', message: 'This text contains characters that cannot be stored' },
  // The append-only and immutability triggers raise insufficient_privilege, as does a privilege the API role lacks.
  '42501': { status: 403, code: 'RECORD_IMMUTABLE', message: 'This record cannot be changed' },
};

export function pgErrorResponse(err: unknown): { status: number; code: ErrorCode; message: string } | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !(err instanceof Error)) return null;
  return PG_ERRORS[code] ?? null;
}

/** Every error body is { error, code, requestId }; an unexpected error reveals nothing but its code and request id. */
export function errorHandler(): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = req.requestId;
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code, requestId });
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION', requestId, issues: err.issues });
    if ((err as { type?: string }).type === 'entity.too.large') {
      const upload = req.path.toLowerCase().startsWith(UPLOAD_PATH);
      return res.status(413).json({ error: upload ? 'The file is larger than the upload limit' : 'The request body is larger than the limit', code: 'VALIDATION', requestId });
    }
    const pg = pgErrorResponse(err);
    if (pg) {
      const e = err as { code: string; detail?: string; constraint?: string; table?: string; message: string };
      logger.warn({ pg: { code: e.code, message: e.message, detail: e.detail, constraint: e.constraint, table: e.table } }, 'database refused the request');
      return res.status(pg.status).json({ error: pg.message, code: pg.code, requestId });
    }
    logger.error({ err }, 'unexpected error');
    res.status(500).json({ code: 'INTERNAL', requestId });
  };
}
```

`errors.ts` imports `UPLOAD_PATH` from `knowledge/routes.ts`, which does not import `http/errors.ts`, so there is no cycle.

In `backend/src/errors.ts`, add `| 'RECORD_IMMUTABLE'` to `ErrorCode`.

In `backend/src/engine/types.ts`, add to `TrailBundle` after `output: unknown;`:

```ts
  /** The API request that wrote this bundle (absent for CLI, seed, import and eval bundles). Covered by the hash. */
  requestId?: string;
```

In `backend/src/db/trail-repo.ts`, import `currentRequestId` from `../observability/context`. In `appendTrail`, replace the `seal(…)` line with:

```ts
  const requestId = bundle.requestId ?? currentRequestId();
  const sealed = seal(tip ? { seq: Number(tip.seq), hash: tip.hash } : null, requestId ? { ...bundle, requestId } : bundle);
```

In `backend/src/app.ts`:
- Add `export interface OpsOptions { trustProxy?: number }`. Change the signature to:
  ```ts
  createApp(svc, auth, storage = { blobs: null, maxUploadBytes: 25 * 1024 * 1024, presignDownloads: false }, ops: OpsOptions = {})
  ```
- First lines after `const app = express();`:
  ```ts
  app.disable('x-powered-by');
  app.use(requestContext({ trustProxy: ops.trustProxy ?? 0 }));
  app.use(accessLog());
  ```
- Replace the final `app.use((err, req, res, _next) => { … })` block with `app.use(errorHandler());`, and drop the now-unused `NextFunction` and `UPLOAD_PATH` imports if nothing else uses them.

Replace `console.*` with `logger` (keep each message's wording; put the error object under `err`):
- `src/db/index.ts`: `logger.error({ err: err.message }, 'Postgres pool error (idle client)')`
- `src/auth/routes.ts:97`: `logger.warn({ err }, 'OIDC callback rejected')`
- `src/signing/routes.ts:150`: `logger.warn({ err }, 'Signing re-authentication rejected')`
- `src/signing/routes.ts:162`: `logger.warn('Signing re-authentication refused: the identity provider sent no auth_time claim. Enable the auth_time claim in the ID token.')`
- `src/knowledge/routes.ts:86, 173, 182`: `logger.error({ err, what }, 'File storage failed')`, `logger.error({ documentId: doc.id, sha256: doc.sha256 }, 'Stored bytes missing for document')` and `logger.error({ err, documentId: doc.id }, 'Download failed')`
- `src/server.ts`:
  - After loading the config, call `setLogLevel(config.logLevel)`.
  - Change the start-up `console.log`/`console.warn` lines to `logger.info`/`logger.warn` with the same text.
  - Pass `log: (line) => logger.info(line)` to `prepareRegistry`.
  - Pass `{ trustProxy: config.trustProxy }` as `createApp`'s fourth argument.
  - Keep `console.error` in `main().catch`, because the logger may not be configured when configuration fails.

In `frontend/src/api.ts`:

```ts
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly requestId: string | null = null) {
    super(message);
    this.name = 'ApiError';
  }
}
```

In `errorFrom`, read the request id and give unexpected errors a reportable message:

```ts
export function errorFrom(status: number, data: unknown): ApiError {
  const body = (data && typeof data === 'object' ? data : {}) as { error?: string; code?: string; requestId?: string };
  const code = body.code ?? null;
  const requestId = body.requestId ?? null;
  const message =
    code === 'INTERNAL'
      ? `Something went wrong on the server.${requestId ? ` If you report it, quote reference ${requestId}.` : ''}`
      : (code && FRIENDLY[code]) || body.error || `HTTP ${status}`;
  return new ApiError(message, status, code, requestId);
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd backend && npx vitest run tests/observability.test.ts && npm run typecheck` and `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS.

Then run `cd backend && npm test && ALLOW_UNVERIFIED_CITATIONS=true npm run eval`. Expected: the whole suite passes with no log lines in the test output, and eval is 25/25. Existing tests that assert error bodies with `toEqual` must now include `requestId`. Update each such assertion to `toMatchObject` (or add `requestId: expect.any(String)`) and list them in the report.

- [ ] **Step 5: Commit**

```bash
git add backend/src backend/tests backend/package.json backend/package-lock.json frontend/src/api.ts frontend/src/api.test.ts
git commit -m "Give every request an id, log as JSON with secrets redacted, and answer errors with stable codes and the request id

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
### Task 3: HTTP security: helmet, per-page script nonces, trusted proxies and rate limits

**Files:**
- Create: `backend/src/http/security.ts`
- Modify:
  - `backend/src/app.ts`: helmet, `trust proxy`, limiters; `OpsOptions` gains `rateLimits`
  - `backend/src/auth/page.ts`: `popupHeaders` returns a nonce
  - `backend/src/signing/pages.ts`: the script carries the nonce
  - `backend/src/errors.ts`: `RATE_LIMITED`
  - `backend/src/server.ts`
  - `backend/package.json`: `helmet`, `express-rate-limit`
- Modify: `frontend/nginx.conf`, `docker-compose.yml` (`TRUST_PROXY: '1'`)
- Test: `backend/tests/security.test.ts` (new)

**Interfaces:**
- Consumes: `OpsOptions.trustProxy`, `requestContext`, `errorHandler` (Task 2); `Config.trustProxy` (Task 1).
- Produces:
  - `securityHeaders(): RequestHandler`
  - `rateLimiters(limits: RateLimits): { auth: RequestHandler; signing: RequestHandler }`
  - `interface RateLimits { authPerMinute: number; signingPerMinute: number }`
  - `DEFAULT_RATE_LIMITS = { authPerMinute: 60, signingPerMinute: 20 }`
  - `OpsOptions` becomes `{ trustProxy?: number; rateLimits?: RateLimits }`
  - `popupHeaders(res): string`, returning the nonce

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/security.test.ts`:

```ts
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resultPage } from '../src/signing/pages';
import { appWithDevUsers, devAuthConfig, signIn } from './http';

const LOW = { authPerMinute: 2, signingPerMinute: 2 };

describe('HTTP security', () => {
  it('sends strict security headers on API responses and no framework banner', async () => {
    const { app } = await appWithDevUsers();
    const res = await request(app).get('/api/health').expect(200);
    expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets a sign-in or signing page run only its own script, through a fresh nonce', async () => {
    const app = express();
    app.get('/done', (_req, res) => resultPage(res, { ok: true }));
    const nonces: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await request(app).get('/done').expect(200);
      const header = res.headers['content-security-policy'] as string;
      const fromHeader = /script-src 'nonce-([^']+)'/.exec(header)?.[1];
      const fromBody = /<script nonce="([^"]+)">/.exec(res.text)?.[1];
      expect(fromHeader).toBeDefined();
      expect(fromBody).toBe(fromHeader);
      expect(header).toContain("default-src 'none'");
      expect(header).toContain("frame-ancestors 'none'");
      nonces.push(fromHeader!);
    }
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('counts each client behind a trusted proxy separately, and ignores forged forwarding headers otherwise', async () => {
    const { svc } = await appWithDevUsers();
    const behindNginx = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { trustProxy: 1, rateLimits: LOW });
    const a = () => request(behindNginx).get('/auth/config').set('X-Forwarded-For', '203.0.113.1');
    await a().expect(200);
    await a().expect(200);
    const limited = await a().expect(429);
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED', requestId: limited.headers['x-request-id'] });
    expect(limited.headers['ratelimit']).toBeDefined();
    await request(behindNginx).get('/auth/config').set('X-Forwarded-For', '203.0.113.2').expect(200);

    const direct = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { rateLimits: LOW });
    await request(direct).get('/auth/config').set('X-Forwarded-For', '203.0.113.1').expect(200);
    await request(direct).get('/auth/config').set('X-Forwarded-For', '203.0.113.2').expect(200);
    // A new forged address does not buy a fresh allowance: without a trusted proxy the socket address is the client.
    await request(direct).get('/auth/config').set('X-Forwarded-For', '203.0.113.3').expect(429);
  });

  it('limits signing requests per client [REQ-18]', async () => {
    const { svc } = await appWithDevUsers();
    const app = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { rateLimits: { authPerMinute: 100, signingPerMinute: 2 } });
    const reviewer = await signIn(app, 'reviewer');
    const start = () => reviewer.post('/api/engagements/ENG-NONE/findings/F-NONE/sign-intents', { action: 'review' });
    expect((await start()).status).toBe(404);
    expect((await start()).status).toBe(404);
    const limited = await start();
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });
});
```

If `signIn`'s demo sign-in uses up the auth allowance in the last test, raise `authPerMinute` there. It must not affect the signing assertions.

- [ ] **Step 2: Run the tests and make sure they fail**

Run: `cd backend && npx vitest run tests/security.test.ts`
Expected: FAIL. CSP headers are missing, the result page has no nonce, and nothing is rate limited.

- [ ] **Step 3: Implement**

Install: `cd backend && npm install helmet@8.3.0 express-rate-limit@8.7.0`. `package.json` should show `^8.3.0` and `^8.7.0`.

Create `backend/src/http/security.ts`:

```ts
import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

// Spec §7.6. The API answers JSON and a few tiny HTML pages (sign-in and signing pop-ups), so its policy
// allows nothing by default; those pages replace it with a per-response script nonce (auth/page.ts).
// The browser app itself is served by nginx, which sends the SPA's own policy (frontend/nginx.conf).

export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"] },
    },
    // same-origin is safe: the app never reads the signing window through window.opener; it polls the request status.
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  });
}

export interface RateLimits {
  authPerMinute: number;
  signingPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { authPerMinute: 60, signingPerMinute: 20 };

/**
 * Per-client limits, keyed by the client address Express derives under `trust proxy` (TRUST_PROXY).
 * In memory: the pilot runs one API replica; more replicas need a shared store.
 */
export function rateLimiters(limits: RateLimits) {
  const make = (limit: number): RequestHandler =>
    rateLimit({
      windowMs: 60_000,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      // A forwarded header without a trusted proxy is ignored on purpose (the socket address is used); don't warn about it.
      validate: { xForwardedForHeader: false },
      handler: (req, res) => {
        res.status(429).json({ error: 'Too many requests; wait a minute and try again', code: 'RATE_LIMITED', requestId: req.requestId });
      },
    });
  return { auth: make(limits.authPerMinute), signing: make(limits.signingPerMinute) };
}
```

In `backend/src/errors.ts`, add `| 'RATE_LIMITED'` to `ErrorCode`.

In `backend/src/app.ts`:
- `OpsOptions` becomes `{ trustProxy?: number; rateLimits?: RateLimits }`.
- After `app.disable('x-powered-by');`, add `app.set('trust proxy', ops.trustProxy ?? 0);` before `requestContext`.
- After `app.use(accessLog());`:

```ts
  app.use(securityHeaders());
  const limits = rateLimiters(ops.rateLimits ?? DEFAULT_RATE_LIMITS);
  app.use('/auth', limits.auth);
  app.use('/auth/sign', limits.signing);
  app.post('/api/engagements/:id/findings/:fid/sign-intents', limits.signing);
```

These run before the session middleware, the routes and the CSRF check, so refused requests cost nothing.

In `backend/src/auth/page.ts`, `popupHeaders` returns the nonce it allows:

```ts
import crypto from 'node:crypto';
// …
/**
 * Sign-in and signing pages: never cached, never framed (no clickjacking of the signing window), and only the
 * page's own inline script may run, through a nonce that is new for every response.
 */
export function popupHeaders(res: Response): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'X-Frame-Options': 'DENY',
  });
  return nonce;
}
```

In `backend/src/signing/pages.ts`, `resultPage` uses `const nonce = popupHeaders(res);` and writes `<script nonce="${nonce}">setTimeout(function () { window.close(); }, 1500);</script>`. The base64 nonce has no characters that need escaping in an attribute. The other callers of `popupHeaders` ignore the return value.

In `backend/src/server.ts`, pass `{ trustProxy: config.trustProxy }`; the rate limits use their defaults.

Replace `frontend/nginx.conf` with:

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  server_tokens off;

  # API and sign-in pages: the API sends its own security headers. One trusted hop (TRUST_PROXY=1 in Compose):
  # nginx appends the client address it saw and sets the request id, so a browser can choose neither.
  location /api/ {
    proxy_pass http://backend:3002;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id $request_id;
    proxy_read_timeout 300s;
    # Uploads: a little above the API's 25 MiB default BLOB_MAX_BYTES, streamed to the API rather than buffered here.
    client_max_body_size 26m;
    proxy_request_buffering off;
  }

  location /auth/ {
    proxy_pass http://backend:3002;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id $request_id;
  }

  # The browser app (spec §7.6). MUI/emotion injects <style> tags at run time, hence style-src 'unsafe-inline'.
  # Kept to this location: a second CSP on API responses would be combined with theirs.
  location / {
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy no-referrer always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    try_files $uri /index.html;
  }
}
```

In `docker-compose.yml`, add to the backend's `environment`: `TRUST_PROXY: '1'  # nginx (frontend) is the one proxy in front of the API`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run:
- `cd backend && npx vitest run tests/security.test.ts tests/signing-http.test.ts tests/auth.test.ts && npm run typecheck`
- `docker run --rm --add-host backend:127.0.0.1 -v "$PWD/../frontend/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine nginx -t`

Expected: PASS, and nginx prints `syntax is ok` and `test is successful`.

Then run `npm test`. Expected: the whole suite passes. A test that drives many demo sign-ins through one app must stay under 60 requests per minute to `/auth/*`. If one doesn't, give that test's app a higher `authPerMinute` through `OpsOptions`, rather than raising the default, and list it in the report.

A browser check of the SPA's and the pop-up's CSP can't be done from this task: sign in at :8080, run a module, open the signing pop-up, and watch for console CSP violations. It goes into the pull request's test plan as a reviewer checkbox.

- [ ] **Step 5: Commit**

```bash
git add backend/src backend/tests backend/package.json backend/package-lock.json frontend/nginx.conf docker-compose.yml
git commit -m "Send strict security headers, allow pop-up scripts only by nonce, trust only configured proxies and rate-limit sign-in and signing

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
### Task 4: Liveness, readiness and Prometheus metrics

**Files:**
- Create: `backend/src/observability/metrics.ts`, `backend/src/observability/probes.ts`, `backend/src/observability/llm.ts`
- Modify:
  - `backend/src/engine/llm/provider.ts`: `usage` on `GenerateResult`
  - `backend/src/engine/llm/anthropic.ts`: fill `usage`
  - `backend/src/db/trail-repo.ts`: append timer
  - `backend/src/signing/flow.ts`: failure counter
  - `backend/src/http/errors.ts` and `backend/src/http/security.ts`: error counter
  - `backend/src/app.ts`: probes and HTTP metrics; `OpsOptions.metricsToken`
  - `backend/src/server.ts`: `instrumentProvider`, metrics token
  - `backend/package.json`: `prom-client`
- Modify: `backend/Dockerfile` (`HEALTHCHECK`), `docker-compose.yml` (backend health check, frontend waits for it)
- Modify: `backend/tests/http.ts`. Move `draftFinding` and `devSign` here from `tests/signing-http.test.ts`, unchanged, and export them. `signing-http.test.ts` then imports them. Move them; don't copy.
- Test: `backend/tests/probes.test.ts` (new)

**Interfaces:**
- Consumes: `errorHandler`, `OpsOptions`, `rateLimiters` (Tasks 2 and 3); `Config.metricsToken` (Task 1); `BlobStore.head` (`storage/blob-store.ts`); `failIntent` (`signing/flow.ts`).
- Produces:
  - `registry: client.Registry`
  - `httpErrors`, `llmCalls`, `llmFallbacks`, `llmTokens`, `trailAppendSeconds`, `signatureFailures`
  - `httpMetrics(): RequestHandler`
  - `probeRoutes(deps: { db: Db; blobs: BlobStore | null; metricsToken: string | null; timeoutMs?: number }): Router`
  - `instrumentProvider(p: LlmProvider | null): LlmProvider | null`
  - `OpsOptions` gains `metricsToken?: string | null`
  - `GenerateResult.usage?: { inputTokens: number; outputTokens: number }`
  - Test helpers in `tests/http.ts`: `draftFinding(app)` and `devSign(user, userId, id, fid, action, confirm?)`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/probes.test.ts`:

```ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { LlmProvider } from '../src/engine/llm/provider';
import { instrumentProvider } from '../src/observability/llm';
import { registry } from '../src/observability/metrics';
import type { BlobStore } from '../src/storage/blob-store';
import { appWithDevUsers, devAuthConfig, devSign, draftFinding, signIn } from './http';

const TOKEN = 't'.repeat(32);

async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = await registry.getSingleMetric(name)!.get();
  const match = metric.values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return match?.value ?? 0;
}

const storeWith = (head: BlobStore['head']): BlobStore => ({
  driver: 's3', head, put: async () => ({ sha256: '', size: 0 }), get: async () => { throw new Error('unused'); }, presignedGet: async () => null,
});

describe('probes and metrics', () => {
  it('answers liveness without touching dependencies, and readiness from the database and file storage', async () => {
    const { svc, app } = await appWithDevUsers();
    expect((await request(app).get('/healthz').expect(200)).body).toEqual({ ok: true });
    expect((await request(app).get('/readyz').expect(200)).body).toEqual({ ok: true, checks: { database: 'ok', storage: 'not configured' } });

    const reachable = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs: storeWith(async () => null), maxUploadBytes: 1024, presignDownloads: false });
    expect((await request(reachable).get('/readyz').expect(200)).body.checks.storage).toBe('ok');

    const down = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs: storeWith(async () => { throw new Error('AccessDenied for key …'); }), maxUploadBytes: 1024, presignDownloads: false });
    expect((await request(down).get('/readyz').expect(503)).body).toEqual({ ok: false, checks: { database: 'ok', storage: 'error' } });

    const hanging = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs: storeWith(() => new Promise(() => undefined)), maxUploadBytes: 1024, presignDownloads: false }, { probeTimeoutMs: 50 });
    expect((await request(hanging).get('/readyz').expect(503)).body.checks.storage).toBe('timeout');
  });

  it('serves metrics only with the bearer token, labelled by route pattern rather than raw URL', async () => {
    const { svc } = await appWithDevUsers();
    const app = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { metricsToken: TOKEN });
    const user = await signIn(app, 'auditor');
    await user.get('/api/engagements/ENG-NOPE123').expect(404);
    await request(app).get('/metrics').expect(401);
    await request(app).get('/metrics').set('Authorization', 'Bearer wrong').expect(401);
    const res = await request(app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toMatch(/audit_http_request_duration_seconds_count\{method="GET",route="\/api\/engagements\/:id",status="404"\} [1-9]/);
    expect(res.text).toMatch(/audit_http_errors_total\{code="NOT_FOUND"\} [1-9]/);
    expect(res.text).toContain('audit_trail_append_seconds_count');
    expect(res.text).toContain('audit_process_cpu_seconds_total');
    expect(res.text).not.toContain('ENG-NOPE123');
  });

  it('counts model calls, fallbacks and tokens', async () => {
    const ok: LlmProvider = { id: 'probe', model: 'm1', generate: async () => ({ output: {} as never, servedModel: 'm1', usage: { inputTokens: 120, outputTokens: 30 } }) };
    const switched: LlmProvider = { id: 'probe', model: 'm1', generate: async () => ({ output: {} as never, servedModel: 'm1-fallback' }) };
    const failing: LlmProvider = { id: 'probe', model: 'm1', generate: async () => { throw new Error('overloaded'); } };
    const before = {
      ok: await metricValue('audit_llm_calls_total', { provider: 'probe', outcome: 'ok' }),
      error: await metricValue('audit_llm_calls_total', { provider: 'probe', outcome: 'error' }),
      input: await metricValue('audit_llm_tokens_total', { provider: 'probe', kind: 'input' }),
      model: await metricValue('audit_llm_fallbacks_total', { provider: 'probe', kind: 'model' }),
      deterministic: await metricValue('audit_llm_fallbacks_total', { provider: 'probe', kind: 'deterministic' }),
    };
    const req = { system: 's', user: 'u', schema: {} as never };
    await instrumentProvider(ok)!.generate(req);
    await instrumentProvider(switched)!.generate(req);
    await expect(instrumentProvider(failing)!.generate(req)).rejects.toThrow('overloaded');
    expect(instrumentProvider(null)).toBeNull();
    expect(await metricValue('audit_llm_calls_total', { provider: 'probe', outcome: 'ok' })).toBe(before.ok + 2);
    expect(await metricValue('audit_llm_calls_total', { provider: 'probe', outcome: 'error' })).toBe(before.error + 1);
    expect(await metricValue('audit_llm_tokens_total', { provider: 'probe', kind: 'input' })).toBe(before.input + 120);
    expect(await metricValue('audit_llm_fallbacks_total', { provider: 'probe', kind: 'model' })).toBe(before.model + 1);
    expect(await metricValue('audit_llm_fallbacks_total', { provider: 'probe', kind: 'deterministic' })).toBe(before.deterministic + 1);
  });

  it('counts failed signatures by reason', async () => {
    const { app } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const before = await metricValue('audit_signature_failures_total', { code: 'REAUTH_USER_MISMATCH' });
    const r = await devSign(reviewer, 'reviewer', id, fid, 'review', 'someone-else');
    expect(r.status!.status).toBe('failed');
    expect(await metricValue('audit_signature_failures_total', { code: 'REAUTH_USER_MISMATCH' })).toBe(before + 1);
  });
});
```

- [ ] **Step 2: Run the tests and make sure they fail**

Run: `cd backend && npx vitest run tests/probes.test.ts`
Expected: FAIL, because the observability modules don't exist.

- [ ] **Step 3: Implement**

Install: `cd backend && npm install prom-client@15.1.3`.

Create `backend/src/observability/metrics.ts`:

```ts
import type { RequestHandler } from 'express';
import client from 'prom-client';

// Prometheus metrics (spec §7.5). One registry for the process; label values are bounded (route patterns,
// error codes, provider ids), never raw URLs or user input.

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'audit_' });

const registers = [registry];

export const httpDuration = new client.Histogram({
  name: 'audit_http_request_duration_seconds', help: 'HTTP request duration by matched route',
  labelNames: ['method', 'route', 'status'] as const, buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30], registers,
});
export const httpErrors = new client.Counter({ name: 'audit_http_errors_total', help: 'Error responses by error code', labelNames: ['code'] as const, registers });
export const llmCalls = new client.Counter({ name: 'audit_llm_calls_total', help: 'Model calls by outcome', labelNames: ['provider', 'outcome'] as const, registers });
export const llmFallbacks = new client.Counter({
  name: 'audit_llm_fallbacks_total', help: 'Model fallbacks: kind=model (served by another model) or deterministic (offline rules used)',
  labelNames: ['provider', 'kind'] as const, registers,
});
export const llmTokens = new client.Counter({ name: 'audit_llm_tokens_total', help: 'Model tokens by kind', labelNames: ['provider', 'kind'] as const, registers });
export const trailAppendSeconds = new client.Histogram({
  name: 'audit_trail_append_seconds', help: 'Time to seal and append one trail bundle, including the chain lock wait',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1], registers,
});
export const signatureFailures = new client.Counter({ name: 'audit_signature_failures_total', help: 'Failed signing attempts by reason', labelNames: ['code'] as const, registers });

/** Observes every request's duration under its matched route pattern ("unmatched" when no route handled it). */
export function httpMetrics(): RequestHandler {
  return (req, res, next) => {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      end({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  };
}
```

Create `backend/src/observability/probes.ts`:

```ts
import crypto from 'node:crypto';
import { Router } from 'express';
import { sql } from 'kysely';
import type { Db } from '../db';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import type { BlobStore } from '../storage/blob-store';
import { logger } from './log';
import { registry } from './metrics';

// Mounted at the root, outside sessions. nginx proxies only /api/ and /auth/, so these stay on the internal network.

export interface ProbeDeps {
  db: Db;
  blobs: BlobStore | null;
  metricsToken: string | null;
  timeoutMs?: number;
}

/** A key no upload can have: head() answers null when the store is reachable and throws when it is not. */
const PROBE_KEY = '0'.repeat(64);

async function check(name: string, fn: () => Promise<unknown>, timeoutMs: number): Promise<'ok' | 'timeout' | 'error'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs)));
  try {
    const result = await Promise.race([fn().then(() => 'ok' as const), timeout]);
    if (result === 'timeout') logger.warn({ check: name, timeoutMs }, 'readiness check timed out');
    return result;
  } catch (err) {
    logger.warn({ check: name, err }, 'readiness check failed');
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

function sameToken(sent: string, expected: string) {
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function probeRoutes(deps: ProbeDeps): Router {
  const r = Router();
  const timeoutMs = deps.timeoutMs ?? 2000;

  r.get('/healthz', (_req, res) => res.json({ ok: true }));

  r.get('/readyz', wrap(async (_req, res) => {
    const checks: Record<string, string> = {
      database: await check('database', () => sql`select 1`.execute(deps.db.kysely), timeoutMs),
      storage: deps.blobs ? await check('storage', () => deps.blobs!.head(PROBE_KEY), timeoutMs) : 'not configured',
    };
    const ok = Object.values(checks).every((v) => v === 'ok' || v === 'not configured');
    res.status(ok ? 200 : 503).set('Cache-Control', 'no-store').json({ ok, checks });
  }));

  r.get('/metrics', wrap(async (req, res) => {
    if (deps.metricsToken && !sameToken(req.header('authorization') ?? '', `Bearer ${deps.metricsToken}`)) {
      throw new AppError(401, 'Metrics need the bearer token', 'UNAUTHENTICATED');
    }
    res.set('Content-Type', registry.contentType).send(await registry.metrics());
  }));

  return r;
}
```

Create `backend/src/observability/llm.ts`:

```ts
import type { LlmProvider } from '../engine/llm/provider';
import { llmCalls, llmFallbacks, llmTokens } from './metrics';

/**
 * Counts a provider's calls, fallbacks and tokens without changing what it returns or throws. A failed call is a
 * deterministic fallback: the module then drafts with its offline rules (engine/modules/llm-step.ts).
 */
export function instrumentProvider(p: LlmProvider | null): LlmProvider | null {
  if (!p) return null;
  const provider = p.id;
  return {
    id: p.id,
    model: p.model,
    async generate(req) {
      try {
        const res = await p.generate(req);
        llmCalls.inc({ provider, outcome: 'ok' });
        if (res.servedModel !== p.model) llmFallbacks.inc({ provider, kind: 'model' });
        if (res.usage) {
          llmTokens.inc({ provider, kind: 'input' }, res.usage.inputTokens);
          llmTokens.inc({ provider, kind: 'output' }, res.usage.outputTokens);
        }
        return res;
      } catch (err) {
        llmCalls.inc({ provider, outcome: 'error' });
        llmFallbacks.inc({ provider, kind: 'deterministic' });
        throw err;
      }
    },
  };
}
```

In `backend/src/engine/llm/provider.ts`, add to `GenerateResult<T>`:

```ts
  /** Tokens the call used, when the provider reports them (metrics only). */
  usage?: { inputTokens: number; outputTokens: number };
```

In `backend/src/engine/llm/anthropic.ts`, change the return to:

```ts
    return {
      output: response.parsed_output as T,
      servedModel: response.model,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
```

In `backend/src/db/trail-repo.ts` `appendTrail`, add `const done = trailAppendSeconds.startTimer();` as the first line and `done();` just before `return sealed;`.

In `backend/src/signing/flow.ts` `failIntent`, add `signatureFailures.inc({ code });` before `return { ok: false, code, message };`.

In `backend/src/http/errors.ts`, count every error response:
- Call `httpErrors.inc({ code })` in each branch, with the code that branch sends.
- Mapped Postgres errors use the mapped code.
- Unexpected errors use `INTERNAL`.
- An oversized body uses `VALIDATION`.

In `backend/src/http/security.ts`, the limiter handler also calls `httpErrors.inc({ code: 'RATE_LIMITED' })`.

In `backend/src/app.ts`:
- `OpsOptions` becomes `{ trustProxy?: number; rateLimits?: RateLimits; metricsToken?: string | null; probeTimeoutMs?: number }`.
- After `app.use(accessLog());`, add `app.use(httpMetrics());`.
- After `app.use(securityHeaders());`, add:
  ```ts
  app.use(probeRoutes({ db: svc.db, blobs: storage.blobs, metricsToken: ops.metricsToken ?? null, timeoutMs: ops.probeTimeoutMs }));
  ```
- Keep `/api/health` as it is, for existing clients.

In `backend/src/server.ts`:
- Use `const llm = instrumentProvider(createProvider());` and pass `llm` to `AuditService`.
- Pass `{ trustProxy: config.trustProxy, metricsToken: config.metricsToken }` to `createApp`.
- If `config.metricsToken` is null, log `logger.warn('METRICS_TOKEN is not set: /metrics is open. Set it outside local development.')`.

In `backend/Dockerfile`, before `CMD`, add:

```dockerfile
# Liveness only: readiness (/readyz) also checks the database and file storage.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -qO /dev/null http://127.0.0.1:3002/healthz || exit 1
```

In `docker-compose.yml`:
- Give the backend:
  ```yaml
  healthcheck:
    test: ['CMD', 'wget', '-qO', '/dev/null', 'http://127.0.0.1:3002/readyz']
    interval: 5s
    retries: 30
  ```
- Change the frontend's `depends_on` to:
  ```yaml
  depends_on:
    backend:
      condition: service_healthy
  ```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd backend && npx vitest run tests/probes.test.ts tests/signing-http.test.ts tests/engine.test.ts && npm run typecheck`
Expected: PASS.

Then run `npm test && ALLOW_UNVERIFIED_CITATIONS=true npm run eval`. Expected: everything passes, and eval is 25/25.

- [ ] **Step 5: Commit**

```bash
git add backend/src backend/tests backend/package.json backend/package-lock.json backend/Dockerfile docker-compose.yml
git commit -m "Add liveness and readiness probes and Prometheus metrics for requests, model calls, trail appends and failed signatures

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
### Task 5: Full integrity verification after a restore (REQ-24)

**Files:**
- Create: `backend/src/ops/verify.ts`
- Modify: `backend/src/db/cli.ts` (`verify` runs the full check)
- Modify: `backend/tests/db.ts` (add `testDbWithUrl()`)
- Modify: `backend/validation/requirements.json` (add REQ-24)
- Test: `backend/tests/verify.test.ts` (new)

**Interfaces:**
- Consumes:
  - `readTrail` (`db/trail-repo.ts`)
  - `verifyChain` (`engine/trail.ts`), which returns `{ valid, length, brokenAt, reason }`
  - `listSignatures` (`db/signature-repo.ts`)
  - `lastRevisionTimes` (`db/revision-repo.ts`)
  - `loadEngagement` (`db/engagement-repo.ts`)
  - `withSignatureStatus` (`signing/content-hash.ts`)
  - `BlobStore.get`, `BlobNotFound` (`storage/blob-store.ts`)
  - `createBlobStore`, `loadStorageConfig` (`storage/config.ts`)
  - `prepareEnv`, `loadConfig` (Task 1)
- Produces:
  - `verifyIntegrity(db: Kysely<DB>, blobs: BlobStore | null, storageSkipped?: string | null): Promise<IntegrityReport>`
  - `IntegrityReport`, with exactly the shape in Global Constraints
  - `testDbWithUrl(): Promise<{ db: Db; url: string }>` in `tests/db.ts`. `testDb()` becomes `(await testDbWithUrl()).db`.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/db.ts`, split `testDb()` so that tests can also get the database's URL:

```ts
/** A fresh, migrated database cloned from the template, with its connection URL. */
export async function testDbWithUrl(): Promise<{ db: Db; url: string }> {
  const adminUrl = inject('pgAdminUrl');
  const name = `t_${process.pid}_${Date.now()}_${counter++}`;
  const admin = connectPg(adminUrl, { max: 1 });
  try {
    await admin.execScript(`CREATE DATABASE ${name} TEMPLATE audit_template`);
  } finally {
    await admin.close();
  }
  const url = withDatabase(adminUrl, name);
  const db = connectPg(url);
  open.push(db);
  return { db, url };
}

/** A fresh, migrated database cloned from the template. */
export async function testDb(): Promise<Db> {
  return (await testDbWithUrl()).db;
}
```

Create `backend/tests/verify.test.ts`:

```ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { insertDocument } from '../src/knowledge/document-repo';
import { verifyIntegrity } from '../src/ops/verify';
import { AuditService } from '../src/service';
import { blobKey } from '../src/storage/blob-store';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { ensureDevUsers } from '../src/auth/dev-users';
import { testDbWithUrl } from './db';
import { approver, auditor, engagementWithFailedControl, LENIENT, registry, reviewer, unattended } from './helpers';

/** A database with an approved, signed finding and two stored documents, and the local store holding their bytes. */
async function restoredSystem() {
  const { db, url } = await testDbWithUrl();
  const svc = new AuditService(db, registry, null, LENIENT);
  await ensureDevUsers(db.kysely);
  const e = await engagementWithFailedControl(svc);
  const fid = e.findings[0].id;
  await svc.signOff(e.id, fid, 'review', 'ok', reviewer, {}, unattended);
  await svc.signOff(e.id, fid, 'approve', 'ok', approver, {}, unattended);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-blobs-'));
  const blobs = new LocalBlobStore(dir);
  const docs = [];
  for (const text of ['SOP-001 cleaning procedure', 'Batch record template']) {
    const stored = await blobs.put(Buffer.from(text));
    docs.push(await insertDocument(db.kysely, {
      sha256: stored.sha256, filename: `${text}.txt`, mime: 'text/plain', size: stored.size, kind: 'sop',
      classification: 'internal', engagementId: null, uploadedBy: auditor.id,
    }));
  }
  return { db, url, dir, blobs, engagementId: e.id, fid, docs };
}

describe('verify', () => {
  it('passes a database whose trail, signatures and stored files are intact [REQ-24]', async () => {
    const s = await restoredSystem();
    const report = await verifyIntegrity(s.db.kysely, s.blobs);
    expect(report.ok).toBe(true);
    expect(report.trail.valid).toBe(true);
    expect(report.signatures).toEqual({ checked: 2, problems: [] });
    expect(report.documents).toEqual({ checked: 2, problems: [], skipped: null });
  });

  it('reports a stored file that is missing or whose bytes changed [REQ-24]', async () => {
    const s = await restoredSystem();
    fs.rmSync(path.join(s.dir, blobKey(s.docs[0].sha256)));
    fs.writeFileSync(path.join(s.dir, blobKey(s.docs[1].sha256)), 'tampered bytes');
    const report = await verifyIntegrity(s.db.kysely, s.blobs);
    expect(report.ok).toBe(false);
    expect(report.documents.problems).toEqual([
      `Document ${s.docs[0].id}: stored file ${s.docs[0].sha256} is missing`,
      expect.stringMatching(new RegExp(`^Document ${s.docs[1].id}: stored bytes hash to [a-f0-9]{64}, not ${s.docs[1].sha256}`)),
    ]);
  });

  it('reports a signature rewritten behind the application, and a trail entry edited after the fact [REQ-24]', async () => {
    const s = await restoredSystem();
    const k = s.db.kysely;
    const sig = await k.selectFrom('signatures').select('id').where('meaning', '=', 'Approved').executeTakeFirstOrThrow();
    await sql`ALTER TABLE signatures DISABLE TRIGGER signatures_append_only`.execute(k);
    await sql`UPDATE signatures SET content_hash = ${'f'.repeat(64)} WHERE id = ${sig.id}`.execute(k);
    await sql`ALTER TABLE trail DISABLE TRIGGER trail_append_only`.execute(k);
    await sql`UPDATE trail SET body = replace(body, 'Plant 1', 'Plant 9') WHERE module_id = 'human:create-engagement'`.execute(k);

    const report = await verifyIntegrity(k, s.blobs);
    expect(report.ok).toBe(false);
    expect(report.trail).toMatchObject({ valid: false, brokenAt: 1 });
    expect(report.signatures.problems).toEqual(expect.arrayContaining([
      `Signature ${sig.id} (finding ${s.fid}): the signed content is not in the finding's history`,
      `Signature ${sig.id} (finding ${s.fid}): does not match its trail entry`,
      expect.stringMatching(new RegExp(`^Finding ${s.fid} in ${s.engagementId}: sign-off ${sig.id} \\(Approved by .+\\) is broken`)),
    ]));
  });

  it('prints one JSON report and exits 1 when anything is wrong [REQ-24]', async () => {
    const s = await restoredSystem();
    const run = () => spawnSync('npx', ['tsx', 'src/db/cli.ts', 'verify'], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: s.url, BLOB_DRIVER: 'local', BLOB_LOCAL_DIR: s.dir, LOG_LEVEL: 'silent' },
    });
    const clean = run();
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ ok: true, documents: { checked: 2 } });

    fs.rmSync(path.join(s.dir, blobKey(s.docs[0].sha256)));
    const broken = run();
    expect(broken.status).toBe(1);
    expect(JSON.parse(broken.stdout).documents.problems).toHaveLength(1);
  }, 60_000);

  it('fails rather than passes when it cannot look at the stored files [REQ-24]', async () => {
    const s = await restoredSystem();
    const report = await verifyIntegrity(s.db.kysely, null, 'file storage is not configured: S3_BUCKET is required when BLOB_DRIVER=s3');
    expect(report.ok).toBe(false);
    expect(report.documents).toEqual({ checked: 0, problems: [], skipped: 'file storage is not configured: S3_BUCKET is required when BLOB_DRIVER=s3' });
  });
});
```

If `engagementWithFailedControl`'s sign-off needs a reviewed finding whose clause is citable, the `LENIENT` policy already allows it, as other tests show. If the trail tamper breaks a different bundle than `seq 1`, assert `brokenAt` equals that bundle's `seq`, read from the database before the update.

- [ ] **Step 2: Run the tests and make sure they fail**

Run: `cd backend && npx vitest run tests/verify.test.ts`
Expected: FAIL, because `../src/ops/verify` does not exist.

- [ ] **Step 3: Implement**

Create `backend/src/ops/verify.ts`:

```ts
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Kysely } from 'kysely';
import { loadEngagement } from '../db/engagement-repo';
import { lastRevisionTimes } from '../db/revision-repo';
import type { DB } from '../db/schema';
import { listSignatures } from '../db/signature-repo';
import { readTrail } from '../db/trail-repo';
import { verifyChain, type ChainVerification } from '../engine/trail';
import type { SignOff } from '../engine/types';
import { withSignatureStatus } from '../signing/content-hash';
import { BlobNotFound, type BlobStore } from '../storage/blob-store';

// `verify` (spec §7.4, REQ-24): run nightly and after any restore. It reads everything and changes nothing.

export interface IntegrityReport {
  ok: boolean;
  trail: ChainVerification;
  signatures: { checked: number; problems: string[] };
  documents: { checked: number; problems: string[]; skipped: string | null };
}

async function hashStream(stream: Readable): Promise<{ sha256: string; size: number }> {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
}

/**
 * Each signature row must:
 * - match content the finding actually had (finding_revisions);
 * - match the sign-off bundle sealed with it in the trail.
 * Each live finding's sign-offs must check out against the rows (withSignatureStatus: no broken sign-off, no missing one).
 */
async function checkSignatures(db: Kysely<DB>, trail: Awaited<ReturnType<typeof readTrail>>) {
  const problems: string[] = [];
  const rows = await db.selectFrom('signatures').selectAll().orderBy('signed_at').orderBy('id').execute();
  const history = new Set(
    (await db.selectFrom('finding_revisions').select(['engagement_id', 'finding_id', 'content_hash']).execute()).map((r) => `${r.engagement_id}|${r.finding_id}|${r.content_hash}`),
  );
  const bundles = new Map(trail.map((b) => [b.id, b]));
  for (const s of rows) {
    const label = `Signature ${s.id} (finding ${s.finding_id})`;
    if (!history.has(`${s.engagement_id}|${s.finding_id}|${s.content_hash}`)) problems.push(`${label}: the signed content is not in the finding's history`);
    const b = bundles.get(s.trail_bundle_id);
    const out = b?.output as Partial<SignOff> | undefined;
    if (!b) problems.push(`${label}: its trail entry ${s.trail_bundle_id} is missing`);
    else if (
      b.moduleId !== 'human:sign-off' || b.engagementId !== s.engagement_id || out?.signatureId !== s.id ||
      out?.contentHash !== s.content_hash || out?.userId !== s.user_id || out?.meaning !== s.meaning
    ) problems.push(`${label}: does not match its trail entry`);
  }
  for (const engagementId of new Set(rows.map((r) => r.engagement_id))) {
    const loaded = await loadEngagement(db, engagementId);
    if (!loaded) {
      problems.push(`Engagement ${engagementId} has signatures but no longer exists`);
      continue;
    }
    const shown = withSignatureStatus(loaded.engagement, await listSignatures(db, engagementId), await lastRevisionTimes(db, engagementId));
    for (const f of shown.findings) {
      for (const so of f.signOffs) {
        if (so.broken) problems.push(`Finding ${f.id} in ${engagementId}: sign-off ${so.signatureId ?? '(no id)'} (${so.meaning} by ${so.userName}) is broken`);
      }
      for (const issue of f.signatureIssues ?? []) problems.push(`Finding ${f.id} in ${engagementId}: ${issue}`);
    }
  }
  return { checked: rows.length, problems };
}

/** Every registered document's stored bytes, streamed and re-hashed. */
async function checkDocuments(db: Kysely<DB>, blobs: BlobStore) {
  const problems: string[] = [];
  const docs = await db.selectFrom('documents').select(['id', 'sha256', 'size']).orderBy('uploaded_at').orderBy('id').execute();
  for (const d of docs) {
    try {
      const { sha256, size } = await hashStream(await blobs.get(d.sha256));
      if (sha256 !== d.sha256) problems.push(`Document ${d.id}: stored bytes hash to ${sha256}, not ${d.sha256}`);
      else if (size !== Number(d.size)) problems.push(`Document ${d.id}: stored size ${size} bytes, registered ${d.size}`);
    } catch (err) {
      if (err instanceof BlobNotFound) problems.push(`Document ${d.id}: stored file ${d.sha256} is missing`);
      else problems.push(`Document ${d.id}: storage error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { checked: docs.length, problems };
}

export async function verifyIntegrity(db: Kysely<DB>, blobs: BlobStore | null, storageSkipped: string | null = null): Promise<IntegrityReport> {
  const chain = await readTrail(db);
  const trail = verifyChain(chain);
  const signatures = await checkSignatures(db, chain);
  const documents = blobs
    ? { ...(await checkDocuments(db, blobs)), skipped: null }
    : { checked: 0, problems: [], skipped: storageSkipped ?? 'file storage is not configured' };
  const ok = trail.valid && !signatures.problems.length && !documents.problems.length && documents.skipped === null;
  return { ok, trail, signatures, documents };
}
```

In `backend/src/db/cli.ts`, replace the `verify` branch and update the usage comment:

```ts
    } else {
      // verify: trail chain, signatures and stored documents (exit 1 on any problem)
      let blobs: BlobStore | null = null;
      let skipped: string | null = null;
      try {
        blobs = createBlobStore(loadStorageConfig());
      } catch (err) {
        skipped = `file storage is not configured: ${(err instanceof Error ? err.message : String(err)).replace(/^Invalid configuration:\n\s*-\s*/, '').split('\n')[0]}`;
      }
      const report = await verifyIntegrity(db.kysely, blobs, skipped);
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
    }
```

In `backend/validation/requirements.json`, append REQ-24 before REQ-25:

```json
  { "id": "REQ-24", "risk": "Medium", "text": "verify detects trail, signature or stored-document tampering after restore.", "evalKinds": [] },
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd backend && npx vitest run tests/verify.test.ts && npm run typecheck`
Expected: PASS.

Then run `npm test && npm run traceability`. Expected: everything passes, and traceability is 25/25.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ops/verify.ts backend/src/db/cli.ts backend/tests/db.ts backend/tests/verify.test.ts backend/validation/requirements.json
git commit -m "Verify the trail, every signature and every stored file after a restore, exiting 1 on any problem (REQ-24)

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
### Task 6: A database role for the API that cannot rewrite the record (REQ-20)

**Files:**
- Create: `backend/migrations/009_api_role.sql`, `backend/src/db/api-login.ts`
- Modify: `backend/src/db/cli.ts` (`create-api-login <name>` command)
- Test: `backend/tests/db-roles.test.ts` (new)

**Interfaces:**
- Consumes:
  - `testDbWithUrl()` (Task 5)
  - `draftFinding`, `devSign`, `devAuthConfig`, `signIn` (`tests/http.ts`, Task 4)
  - `LocalBlobStore`, `connectPg`, `AuditService`, `createApp`
- Produces:
  - The cluster role `audit_api` (NOLOGIN) with exactly the privileges in Global Constraints.
  - `createApiLogin(db: Db, name: string, password: string): Promise<'created' | 'updated'>`
  - `node dist/db/cli.js create-api-login <name>`, which reads `API_DB_PASSWORD` (or `API_DB_PASSWORD_FILE`).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/db-roles.test.ts`:

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { connectPg, type Db } from '../src/db';
import { createApiLogin } from '../src/db/api-login';
import { AuditService } from '../src/service';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { testDbWithUrl } from './db';
import { LENIENT, registry } from './helpers';
import { devAuthConfig, devSign, draftFinding, signIn } from './http';

/** What the API's role may do with each table. A table missing here fails the inventory test until it is classified. */
const PRIVILEGES: Record<string, 'read' | 'append' | 'write'> = {
  engagements: 'write', engagement_work: 'write', findings: 'write', users: 'write', sessions: 'write', sign_intents: 'write',
  trail: 'append', signatures: 'append', finding_revisions: 'append', documents: 'append', document_text: 'append', chunks: 'append',
  blob_uploads: 'append', eval_runs: 'append',
  kg_nodes: 'read', kg_node_versions: 'read', kg_edges: 'read', schema_migrations: 'read',
};

const opened: Db[] = [];
afterAll(async () => Promise.all(opened.splice(0).map((d) => d.close())));

/** A fresh database, plus a connection to it as a new login that is a member of audit_api. */
async function asApiRole() {
  const { db: owner, url } = await testDbWithUrl();
  const name = `api_${crypto.randomBytes(4).toString('hex')}`;
  const password = crypto.randomBytes(16).toString('hex');
  expect(await createApiLogin(owner, name, password)).toBe('created');
  const u = new URL(url);
  u.username = name;
  u.password = password;
  const api = connectPg(u.toString());
  opened.push(api);
  return { owner, api, name, password };
}

describe('the API database role', () => {
  it('classifies every table, and grants nothing beyond that [REQ-20]', async () => {
    const { owner } = await asApiRole();
    const tables = (await sql<{ t: string }>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`.execute(owner.kysely)).rows.map((r) => r.t).sort();
    expect(tables).toEqual(Object.keys(PRIVILEGES).sort());
    for (const [table, kind] of Object.entries(PRIVILEGES)) {
      const can = async (p: string) => (await sql<{ ok: boolean }>`SELECT has_table_privilege('audit_api', ${`public.${table}`}, ${p}) AS ok`.execute(owner.kysely)).rows[0].ok;
      expect({ table, select: await can('SELECT'), insert: await can('INSERT'), update: await can('UPDATE') }).toEqual({
        table, select: true, insert: kind !== 'read', update: kind === 'write',
      });
      for (const p of ['DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) expect({ table, p, ok: await can(p) }).toEqual({ table, p, ok: false });
    }
    // Inserting a finding draws its seq from a sequence (001: findings.seq bigserial).
    expect((await sql<{ ok: boolean }>`SELECT has_sequence_privilege('audit_api', 'public.findings_seq_seq', 'USAGE') AS ok`.execute(owner.kysely)).rows[0].ok).toBe(true);
  });

  it('cannot change, delete or unprotect the trail and signatures, even bypassing the application [REQ-20]', async () => {
    const { api } = await asApiRole();
    for (const statement of [
      'UPDATE trail SET actor = actor', 'DELETE FROM trail', 'TRUNCATE trail', 'UPDATE signatures SET comment = comment', 'DELETE FROM signatures',
      'UPDATE finding_revisions SET revision = revision', 'UPDATE kg_nodes SET title = title', 'DELETE FROM sessions',
      'ALTER TABLE trail DISABLE TRIGGER trail_append_only', 'DROP TRIGGER signatures_append_only ON signatures', 'CREATE TABLE scratch (a int)',
    ]) {
      await expect(api.execScript(statement), statement).rejects.toThrow(/permission denied|must be (the )?owner/);
    }
  });

  it('runs the whole application as that role: sign-in, the chain, signatures, documents, search and eval [REQ-20]', async () => {
    const { api } = await asApiRole();
    const svc = new AuditService(api, registry, null, LENIENT);
    await ensureDevUsers(api.kysely);
    const blobs = new LocalBlobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'api-role-')));
    const app = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs, maxUploadBytes: 1024 * 1024, presignDownloads: false });

    const { id, fid, auditor } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    expect((await devSign(reviewer, 'reviewer', id, fid, 'review')).status!.status).toBe('signed');
    const approver = await signIn(app, 'approver');
    expect((await devSign(approver, 'approver', id, fid, 'approve')).status!.status).toBe('signed');

    const up = await auditor.agent.put('/api/blobs').set('x-csrf-token', auditor.csrf).set('Content-Type', 'text/plain').send(Buffer.from('Cleaning SOP: wipe down every shift.')).expect(201);
    await auditor.post('/api/documents', { sha256: up.body.sha256, filename: 'sop.txt', mime: 'text/plain', kind: 'sop', classification: 'internal', text: { content: 'Cleaning SOP: wipe down every shift.' } }).expect(201);
    expect((await auditor.get('/api/knowledge/search?q=cleaning').expect(200)).body.length).toBeGreaterThan(0);
    await auditor.get(`/api/engagements/${id}/report.md`).expect(404);
    await auditor.post(`/api/engagements/${id}/modules/report/run`).expect(200);
    await auditor.post('/api/eval/run').expect(200);
    expect((await auditor.get('/api/trail/verify').expect(200)).body.valid).toBe(true);
  }, 120_000);

  it('creates the login once and only changes its password afterwards; never touches other roles [REQ-20]', async () => {
    const { owner, name } = await asApiRole();
    expect(await createApiLogin(owner, name, crypto.randomBytes(16).toString('hex'))).toBe('updated');
    await expect(createApiLogin(owner, 'Bad Name;', 'x'.repeat(20))).rejects.toThrow(/name/);
    await expect(createApiLogin(owner, `api_${crypto.randomBytes(4).toString('hex')}`, 'short')).rejects.toThrow(/at least 16/);
    const ownerName = (await sql<{ u: string }>`SELECT current_user AS u`.execute(owner.kysely)).rows[0].u;
    await expect(createApiLogin(owner, ownerName, 'x'.repeat(20))).rejects.toThrow(/owns database objects or has administrative rights/);
  });
});
```

`draftFinding` must return the auditor's session as `auditor`. It already does in `signing-http.test.ts`, and Task 4 moved it to `tests/http.ts` unchanged.

- [ ] **Step 2: Run the test and make sure it fails**

Run: `cd backend && npx vitest run tests/db-roles.test.ts`
Expected: FAIL. `../src/db/api-login` is missing, and the role `audit_api` doesn't exist.

- [ ] **Step 3: Write the migration and the login command**

Create `backend/migrations/009_api_role.sql`:

```sql
-- The API's database role (plan 1A carry-over (a), REQ-20). The API logs in as a member of audit_api;
-- migrations and pack compiles keep the owner login. audit_api owns nothing, so it can neither alter nor drop a
-- table or its append-only triggers, and it holds no DELETE, TRUNCATE or TRIGGER privilege anywhere.
-- Nothing is granted by default: a table added later is unreachable to the API until its migration grants it
-- (tests/db-roles.test.ts fails until the table is classified there). Append-only tables get SELECT, INSERT only.
--
-- Roles are cluster-wide. If the migrating login may not create roles, create audit_api (NOLOGIN) once beforehand.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_api') THEN
    CREATE ROLE audit_api NOLOGIN;
  END IF;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM audit_api;
GRANT USAGE ON SCHEMA public TO audit_api;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO audit_api;

-- Working state the API changes in place (never deletes: users, findings and documents have their own guards).
GRANT INSERT, UPDATE ON engagements, engagement_work, findings, users, sessions, sign_intents TO audit_api;

-- The record: written once, never changed by the API.
GRANT INSERT ON trail, signatures, finding_revisions, documents, document_text, chunks, blob_uploads, eval_runs TO audit_api;

-- findings.seq is a bigserial: inserting a finding draws from its sequence.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO audit_api;

-- kg_nodes, kg_node_versions, kg_edges and schema_migrations stay read-only: packs:compile and migrate run as the owner.
```

Create `backend/src/db/api-login.ts`:

```ts
import { escapeIdentifier, escapeLiteral } from 'pg';
import { sql } from 'kysely';
import type { Db } from './index';

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Creates (or re-passwords) a login role that is a member of audit_api: the identity the API connects as in production.
 * Refuses names that are not plain identifiers, short passwords, and any existing role that owns database objects or
 * has administrative rights (so it can never demote or re-password the owner by mistake).
 */
export async function createApiLogin(db: Db, name: string, password: string): Promise<'created' | 'updated'> {
  if (!NAME.test(name) || name === 'audit_api') throw new Error('The login name must be a plain lowercase identifier (letters, digits, _) other than audit_api');
  if (password.length < 16) throw new Error('API_DB_PASSWORD must be at least 16 characters');
  const existing = (await sql<{ admin: boolean; owns: boolean }>`
    SELECT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls) AS admin,
           EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid) AS owns
    FROM pg_roles r WHERE r.rolname = ${name}`.execute(db.kysely)).rows[0];
  if (existing && (existing.admin || existing.owns)) {
    throw new Error(`Role ${name} owns database objects or has administrative rights; choose a new name for the API login`);
  }
  // Role names and passwords can't be bound as parameters in DDL; both are escaped by node-postgres.
  const role = escapeIdentifier(name);
  const secret = escapeLiteral(password);
  if (existing) await db.execScript(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${secret}; GRANT audit_api TO ${role};`);
  else await db.execScript(`CREATE ROLE ${role} LOGIN PASSWORD ${secret} IN ROLE audit_api;`);
  return existing ? 'updated' : 'created';
}
```

In `backend/src/db/cli.ts`, add the command:
- Update the usage comment and `USAGE` to include `create-api-login <name>`.
- Add `'create-api-login'` to the allowed commands.
- Add this branch:

```ts
    } else if (command === 'create-api-login') {
      const password = process.env.API_DB_PASSWORD;
      if (!arg || !password) throw new Error('Usage: cli create-api-login <name>, with API_DB_PASSWORD (or API_DB_PASSWORD_FILE) set');
      const result = await createApiLogin(db, arg, password);
      console.log(`${result === 'created' ? 'Created' : 'Updated'} login ${arg} (member of audit_api). Point the API's DATABASE_URL at it; keep the owner for migrate and packs:compile.`);
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd backend && npx vitest run tests/db-roles.test.ts && npm run typecheck`
Expected: PASS.

Then run `npm test && ALLOW_UNVERIFIED_CITATIONS=true npm run eval`. Expected: everything passes, and eval is 25/25, since PGlite runs 009. If the happy path finds a statement the role may not run, it is a genuine gap. Grant the narrowest privilege that fixes it in 009, update `PRIVILEGES` and the Global Constraints table to match, and list it in the report.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/009_api_role.sql backend/src/db/api-login.ts backend/src/db/cli.ts backend/tests/db-roles.test.ts
git commit -m "Run the API as a role that can append to the record but never change, delete or unprotect it (REQ-20)

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
### Task 7: Trail entries for documents a reader may not see are redacted

**Files:**
- Create: `backend/src/knowledge/trail-visibility.ts`
- Modify: `backend/src/app.ts` (the engagement trail route)
- Modify: `frontend/src/types.ts`, `frontend/src/components/engagement/TrailTab.tsx`
- Test: `backend/tests/documents-http.test.ts` (one new test)

**Interfaces:**
- Consumes: `mayRead(role, classification)`, `CLASSIFICATIONS` (`knowledge/access.ts`); the `document:register` bundle written by `recordDocumentEvent` (`knowledge/trail.ts`), whose `inputs` are `{ documentId, sha256, kind, classification }` and whose `output` is `{ chunks }`.
- Produces:
  - `type VisibleTrailBundle = TrailBundle & { redacted?: true }`
  - `visibleTrail(bundles: TrailBundle[], role: Role): VisibleTrailBundle[]`
  - `GET /api/engagements/:id/trail` returns `VisibleTrailBundle[]`.

A redacted bundle keeps `id`, `seq`, `moduleId`, `actor`, times, versions, `prevHash` and `hash`. That way the reader still sees that an event happened, and when and by whom, at its place in the chain. It replaces `inputs` with `{ classification }`, sets `output` to `null` and `executionLog` to `[]`, and adds `redacted: true`. An entry whose classification is missing or unknown is redacted, so the check fails closed. `/api/trail/verify` is unchanged, because it verifies on the server against the stored bodies.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/documents-http.test.ts`, inside its top-level `describe`, using that file's existing `setup()` and `upload()` helpers. Adjust names if the file calls them differently.

```ts
  it('redacts trail entries for documents the reader may not see, keeping their place in the chain [REQ-23]', async () => {
    const { app } = await setup();
    const manager = await signIn(app, 'reviewer');
    const created = await manager.post('/api/engagements', NEW_ENGAGEMENT).expect(201);
    const engagementId = created.body.id as string;
    const up = await upload(manager, Buffer.from('%PDF restricted incident'));
    await manager.post('/api/documents', {
      sha256: up.body.sha256, filename: 'incident.pdf', mime: 'application/pdf', kind: 'other', classification: 'restricted', engagementId,
    }).expect(201);

    const full = (await manager.get(`/api/engagements/${engagementId}/trail`).expect(200)).body;
    const shown = full.find((b: any) => b.moduleId === 'document:register');
    expect(shown.inputs).toMatchObject({ classification: 'restricted', sha256: up.body.sha256 });
    expect(shown.redacted).toBeUndefined();

    const viewer = await signIn(app, 'viewer');
    const limited = (await viewer.get(`/api/engagements/${engagementId}/trail`).expect(200)).body;
    const hidden = limited.find((b: any) => b.moduleId === 'document:register');
    expect(hidden).toMatchObject({ id: shown.id, seq: shown.seq, hash: shown.hash, prevHash: shown.prevHash, actor: shown.actor, redacted: true, inputs: { classification: 'restricted' }, output: null, executionLog: [] });
    expect(JSON.stringify(limited)).not.toContain(up.body.sha256);
    expect(limited.map((b: any) => b.seq)).toEqual(full.map((b: any) => b.seq));
  });
```

Import `NEW_ENGAGEMENT` from `./helpers` and `signIn` from `./http` if the file doesn't already. The demo user `reviewer` is an `audit_manager`: a preparer who may read `restricted`. `viewer` reads only `internal` (`auth/roles.ts`, `knowledge/access.ts`).

- [ ] **Step 2: Run the test and make sure it fails**

Run: `cd backend && npx vitest run tests/documents-http.test.ts -t "redacts trail entries"`
Expected: FAIL, because the viewer sees the restricted document's hash.

- [ ] **Step 3: Implement**

Create `backend/src/knowledge/trail-visibility.ts`:

```ts
import type { Role, TrailBundle } from '../engine/types';
import { CLASSIFICATIONS, mayRead, type Classification } from './access';

/** A trail bundle as one reader may see it. */
export type VisibleTrailBundle = TrailBundle & { redacted?: true };

const isClassification = (v: unknown): v is Classification => typeof v === 'string' && (CLASSIFICATIONS as readonly string[]).includes(v);

/**
 * Document registrations name a document's hash, kind and size of text, which a reader without access to its
 * classification must not see (plan 1D carry-over). The entry stays in place, so the chain's sequence is unbroken;
 * only its details are withheld. Unknown classifications are withheld too.
 */
export function visibleTrail(bundles: TrailBundle[], role: Role): VisibleTrailBundle[] {
  return bundles.map((b) => {
    if (b.moduleId !== 'document:register') return b;
    const classification = (b.inputs as { classification?: unknown } | null)?.classification;
    if (isClassification(classification) && mayRead(role, classification)) return b;
    return { ...b, inputs: { classification: isClassification(classification) ? classification : null }, output: null, executionLog: [], redacted: true };
  });
}
```

In `backend/src/app.ts`, change the trail route to:

```ts
  app.get('/api/engagements/:id/trail', readers, wrap(async (req, res) => res.json(visibleTrail(await svc.trailFor(param(req, 'id')), actorOf(req).role))));
```

`actorOf(req).role` is set for every reader, because `readers` requires a role.

In `frontend/src/types.ts`, add `export type { VisibleTrailBundle } from '../../backend/src/knowledge/trail-visibility';`.

In `frontend/src/components/engagement/TrailTab.tsx`:
- Use `VisibleTrailBundle` instead of `TrailBundle` for the state and the fetch.
- In the summary row, after the module chip, add:
  ```tsx
  {b.redacted && <Chip size="small" variant="outlined" label="details restricted" />}
  ```

- [ ] **Step 4: Run the tests and make sure they pass**

Run:
- `cd backend && npx vitest run tests/documents-http.test.ts tests/api.test.ts && npm run typecheck`
- `cd frontend && npx tsc --noEmit && npx vitest run && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/knowledge/trail-visibility.ts backend/src/app.ts backend/tests/documents-http.test.ts frontend/src/types.ts frontend/src/components/engagement/TrailTab.tsx
git commit -m "Withhold the details of document trail entries from readers who may not see the document's classification

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
### Task 8: CI on every push, and a hardened container

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `backend/src/validation/cli.ts` (exit 1 when a requirement is uncovered)
- Modify: `docker-compose.yml` (read-only API root filesystem, `tmpfs`, no new privileges, all capabilities dropped)
- Test: `backend/tests/api.test.ts` (one new test for the traceability exit code)

**Interfaces:**
- Consumes:
  - `npm run typecheck`, `npm test`, `npm run eval`, `npm run traceability` (backend)
  - `npm run typecheck`, `npm test`, `npm run build` (frontend; the build imports backend types, so CI installs the backend's dependencies too, as `frontend/Dockerfile` does)
  - `/readyz` (Task 4)
  - `cli verify` (Task 5)
- Produces: workflow `CI`, with jobs `backend`, `frontend` and `images`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/api.test.ts`. Reuse its imports; add `spawnSync` from `node:child_process` and `path` from `node:path` if they're missing.

```ts
  it('fails the traceability command when a requirement has no automated evidence', () => {
    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync('npx', ['tsx', 'src/validation/cli.ts'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ...env } });
    expect(run({}).status).toBe(0);
    const failing = run({ TRACEABILITY_REQUIREMENTS: path.resolve(__dirname, 'fixtures/requirements-uncovered.json') });
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain('**NOT COVERED**');
  }, 60_000);
```

Create `backend/tests/fixtures/requirements-uncovered.json`:

```json
[
  { "id": "REQ-99", "risk": "High", "text": "A requirement no test or evaluation covers." }
]
```

This test has no `[REQ-xx]` tag, because no requirement covers the validation tooling itself.

- [ ] **Step 2: Run the test and make sure it fails**

Run: `cd backend && npx vitest run tests/api.test.ts -t "fails the traceability command"`
Expected: FAIL. The command exits 0 and ignores `TRACEABILITY_REQUIREMENTS`.

- [ ] **Step 3: Implement**

In `backend/src/validation/traceability.ts`, let `loadRequirements` read an override path, so tests and CI can check the gate itself:

```ts
export function loadRequirements(file = process.env.TRACEABILITY_REQUIREMENTS ?? path.join(ROOT, 'validation/requirements.json')): Requirement[] {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
```

In `backend/src/validation/cli.ts`, take `rows` from `buildTraceability` as well, and finish with:

```ts
const uncovered = rows.filter((r) => !r.covered).map((r) => r.id);
if (uncovered.length) {
  console.error(`Requirements without automated evidence: ${uncovered.join(', ')}`);
  process.exitCode = 1;
}
```

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main, 'design/**']
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  backend:
    runs-on: ubuntu-24.04
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v7.0.1
      - uses: actions/setup-node@v7.0.0
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: backend/package-lock.json
      - run: npm ci
      - name: Typecheck (the lint gate; see plan 1F)
        run: npm run typecheck
      - name: Unit and integration tests (Testcontainers uses the runner's Docker)
        run: npm test
      - name: Evaluation harness (packs are unverified until expert review)
        run: npm run eval
        env:
          ALLOW_UNVERIFIED_CITATIONS: 'true'
      - name: Requirements traceability (fails on any uncovered requirement)
        run: npm run traceability
      - name: Dependency audit (high and critical)
        run: npm audit --omit=dev --audit-level=high
      - uses: actions/upload-artifact@v7.0.1
        if: always()
        with:
          name: validation-output
          path: backend/validation-output/
          if-no-files-found: ignore

  frontend:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7.0.1
      - uses: actions/setup-node@v7.0.0
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: |
            frontend/package-lock.json
            backend/package-lock.json
      - name: Install (the UI imports the backend's types)
        run: (cd backend && npm ci) && (cd frontend && npm ci)
      - run: npm run typecheck
        working-directory: frontend
      - run: npm test
        working-directory: frontend
      - run: npm run build
        working-directory: frontend
      - name: Dependency audit (high and critical)
        run: npm audit --omit=dev --audit-level=high
        working-directory: frontend

  images:
    needs: [backend, frontend]
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7.0.1
      - name: Build the API image
        run: docker build -t audit-platform-backend:ci backend
      - name: Build the web image
        run: docker build -f frontend/Dockerfile -t audit-platform-frontend:ci .
      - name: Check the nginx configuration
        run: docker run --rm --add-host backend:127.0.0.1 audit-platform-frontend:ci nginx -t
      - name: Scan the API image
        uses: aquasecurity/trivy-action@v0.36.0
        with:
          image-ref: audit-platform-backend:ci
          severity: CRITICAL,HIGH
          ignore-unfixed: true
          exit-code: '1'
      - name: Scan the web image
        uses: aquasecurity/trivy-action@v0.36.0
        with:
          image-ref: audit-platform-frontend:ci
          severity: CRITICAL,HIGH
          ignore-unfixed: true
          exit-code: '1'
```

In `docker-compose.yml`, add to the `backend` service:

```yaml
    # Spec §7.1: non-root (the image's USER node), read-only root filesystem, nothing to escalate to.
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

Add `security_opt: ['no-new-privileges:true']` to the `migrate` and `frontend` services. nginx writes its pid and cache files, so its root filesystem stays writable.

- [ ] **Step 4: Verify**

Run:
- `cd backend && npx vitest run tests/api.test.ts && npm run typecheck && npm run traceability; echo "exit=$?"`. Expected: PASS, and `exit=0` at 25/25.
- `docker run --rm -v "$PWD/..:/repo" -w /repo rhysd/actionlint:1.7.12 -color`. Expected: no findings.
- A local Trivy baseline, run on the images the smoke test below builds, so the CI scan isn't red on first push for reasons outside the code:
  ```bash
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.74.0 image --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 audit-platform-backend:local
  ```
  Run the same command on the web image, as tagged by `docker compose images frontend`. If a base image (`node:22-alpine`, `nginx:1.27-alpine`) has a fixable HIGH or CRITICAL finding, move it to the newest patch tag of the same line that is at least two weeks old, and say so in the report. If the finding is in an npm dependency, report it as a concern instead of changing dependencies.
- A smoke test of the hardened stack, from the repo root, with a `.env` copied from `.env.example`:
  ```bash
  docker compose up -d --build
  docker compose ps        # backend: healthy; frontend: running
  curl -fsS http://localhost:8080/api/health
  docker compose exec backend wget -qO- http://127.0.0.1:3002/readyz      # {"ok":true,"checks":{"database":"ok","storage":"ok"}}
  docker compose exec backend node dist/db/cli.js verify; echo "exit=$?"  # "ok": true, exit=0
  docker compose exec backend sh -c 'touch /app/x' ; echo "exit=$?"     # Read-only file system, exit=1
  docker compose down -v
  ```
  Delete the `.env` afterwards if you created it, and leave any other running containers alone.

Record each command's output in the report. CI itself runs when the branch is pushed. Pushing is the controller's call, not this task's.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml backend/src/validation backend/tests/api.test.ts backend/tests/fixtures/requirements-uncovered.json docker-compose.yml
git commit -m "Run typecheck, tests, eval, traceability, dependency audit, image builds and Trivy in CI; harden the API container

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
### Task 9: Deployment guide, operations runbook and validation package

**Files:**
- Create: `docs/deploy/azure.md`, `docs/deploy/operations.md`
- Modify: `backend/validation/README.md`, `README.md`

**Interfaces:**
- Consumes: every setting, command, endpoint and metric introduced in Tasks 1–8, with exactly the names defined there. Check each name against the code before you write it down.
- Produces: documentation only. No code changes.

The documents must be accurate rather than exhaustive. Every command in them must exist, with the arguments shown. Every setting must be one the loaders read.

- [ ] **Step 1: Write `docs/deploy/azure.md`, the reference Azure deployment (spec §7.2; documented, not scripted)**

Use these sections, in this order:
1. **What you deploy.**
   - Two images: `api` (built from `backend/Dockerfile`) and `web` (built from `frontend/Dockerfile`).
   - Postgres Flexible Server, 16, with `vector` allow-listed in `azure.extensions`.
   - A storage account and an Entra ID app registration.
   - Key Vault.
   - Log Analytics.
   - Optionally Azure OpenAI or Claude through Microsoft Foundry, behind `LLM_PROVIDER`.
2. **Identity (Entra ID).**
   - Register the app.
   - Redirect URI: `https://<host>/auth/callback`.
   - Enable the `groups` claim and the `auth_time` claim in the ID token.
   - Set `OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (from Key Vault), `OIDC_REDIRECT_URI`, `OIDC_GROUPS_CLAIM=groups`, and `OIDC_ROLE_MAP` with the group object ids.
   - Mention the Entra authentication-context fallback from spec §13 if `prompt=login` isn't honoured.
3. **Database.**
   - Create the server with TLS enforced and point-in-time restore set to 30 days.
   - Create the database `audit`.
   - The owner login runs `migrate` and `packs:compile`.
   - If the owner may not create roles, create `audit_api` first: `CREATE ROLE audit_api NOLOGIN;`.
   - Create the API login with `API_DB_PASSWORD=… node dist/db/cli.js create-api-login audit_app`, run as the owner (for example as a Container Apps job).
   - The API's `DATABASE_URL` uses `audit_app`, with `DATABASE_SSL=verify-full`. Azure's server certificate chains to a public CA; set `DATABASE_SSL_CA_FILE` only for a private CA.
   - Never put `sslmode` in the URL.
4. **Storage.**
   - A storage account with versioning on, and a container `evidence` with a time-based immutability policy (retention lock) sized to the client's record-retention period.
   - `BLOB_DRIVER=azure`, `AZURE_STORAGE_CONNECTION_STRING` from Key Vault, `AZURE_STORAGE_CONTAINER=evidence`.
   - Keep `BLOB_PRESIGN_DOWNLOADS=false` unless browsers can reach the storage endpoint.
5. **Container Apps.**
   - The `api` app:
     - internal ingress on port 3002, min replicas 1, max replicas 1 for the pilot (rate limits are per replica);
     - liveness probe `GET /healthz`, readiness probe `GET /readyz`;
     - secrets from Key Vault as environment variables, or mounted files with `<NAME>_FILE`.
   - The `web` app: external ingress on port 80.
   - `TRUST_PROXY=2`, because the request passes the Container Apps ingress and then nginx.
   - Container Apps has no read-only root filesystem setting. The image runs as the non-root `node` user, and the API writes nothing to disk.
6. **Release steps.** In order, as Container Apps jobs using the `api` image:
   - `node dist/db/cli.js migrate`
   - `node dist/knowledge/packs-cli.js compile` (as the owner)
   - then deploy the new `api` revision. Production refuses to start if the graph doesn't match the image's packs.
7. **Required production settings.** A table of every setting the API refuses to start without in production, or refuses a value of:
   - `NODE_ENV=production`
   - `DEV_AUTH=false`
   - `ALLOW_UNVERIFIED_CITATIONS=false` or unset
   - `PUBLIC_URL` and `OIDC_*` on `https://`
   - `DATABASE_SSL` not `disable`
   - `METRICS_TOKEN` (24+ characters)
   - `BLOB_DRIVER` `s3` or `azure`, with an `https://` endpoint and `BLOB_MAX_BYTES` ≤ 100 MiB
   - Say that `loadServerConfig` lists every problem at once.
8. **Monitoring.**
   - Log Analytics collects the JSON stdout. Query by `requestId`; the same id is in the API response header `X-Request-Id`, in error bodies, and in each audit-trail bundle the request wrote.
   - Prometheus (Azure Monitor managed Prometheus) scrapes `/metrics` with `Authorization: Bearer <METRICS_TOKEN>`.
   - Name the alert rules from `docs/deploy/operations.md`.

- [ ] **Step 2: Write `docs/deploy/operations.md`, the operations runbook (spec §7.4, §7.5)**

Use these sections:
1. **Health.**
   - `/healthz` is liveness and touches nothing.
   - `/readyz` checks the database and file storage with 2-second timeouts. It answers `503 { ok:false, checks }` naming the failed check. The logs carry the detail under `readiness check failed`.
   - An S3 bucket policy without `s3:ListBucket` makes the storage check fail, because a missing object reads as access denied. Grant it.
2. **Metrics.** Every metric name from Global Constraints with one line on what it means. Suggested alerts:
   - 5xx rate above 1% for 5 minutes: `audit_http_request_duration_seconds_count{status=~"5.."}`
   - any `audit_http_errors_total{code="INTERNAL"}` increase
   - `audit_signature_failures_total` rising faster than 5 per 10 minutes
   - `audit_llm_fallbacks_total{kind="deterministic"}` increasing (drafts are falling back to offline rules)
   - p95 `audit_trail_append_seconds` above 0.5 s
   - readiness failing
3. **Backups.**
   - Postgres point-in-time restore for 30 days.
   - Storage versioning, and a retention lock on the evidence container.
   - Test a restore at least quarterly, into a separate server.
4. **Verify (REQ-24).**
   - `node dist/db/cli.js verify` (`npm run verify` locally) runs nightly as a scheduled job with the API's environment (it needs the storage settings), and after every restore.
   - Show the JSON report shape and what each problem line means:
     - **Trail:** `brokenAt` means a bundle changed after it was sealed. Investigate from that `seq`.
     - **Signatures:**
       - "the signed content is not in the finding's history": the signature row or the finding history was edited outside the application.
       - "does not match its trail entry"
       - "sign-off … is broken"
       - "recorded but missing from the finding"
     - **Documents:** "is missing" means the stored file is gone. "stored bytes hash to …" means the file changed.
   - Exit 1 means escalate as a data-integrity incident. Don't edit data to make it pass.
   - A report with `documents.skipped` set also fails, because the storage settings were not available to the job.
5. **Restore procedure.** In order:
   - stop the API (scale to 0);
   - restore Postgres to a point in time;
   - restore storage versions to the same point if needed;
   - run `migrate` (no-op);
   - run `verify`;
   - start the API only when `ok: true`;
   - record the restore and the verify report in the client's change log.
6. **Rotating secrets.**
   - **API database password:** run `create-api-login` again with a new `API_DB_PASSWORD`; it only changes the password. Then roll the `api` revision.
   - **`METRICS_TOKEN`:** update Prometheus first.
   - **OIDC client secret:** update it in Key Vault, then roll the revision.

- [ ] **Step 3: Update `backend/validation/README.md` (spec §11)**

In the deliverables table:
- Change "Audit trail integrity" to `*Generated* | node dist/db/cli.js verify (trail, signatures, stored documents; REQ-24), nightly and after restore; GET /api/trail/verify for the chain alone`.
- Add a row "Configuration qualification | *Generated* | start-up refuses insecure configuration (REQ-25); tests/config.test.ts".
- Change IQ to point at `docs/deploy/azure.md`, and add the operations runbook `docs/deploy/operations.md`.

Then add a section `## Client responsibilities`. It lists what the platform doesn't control and the client must operate and evidence:
- **Identity provider:** password and MFA policy, and conditional access.
- **Account lifecycle:** joiners, movers, leavers; group-to-role mapping reviews (the Admin page shows role overrides).
- **Hosting:** physical and network security of the tenant.
- **Backups:** the schedule and restore testing (point-in-time restore of at least 30 days; quarterly restore tests that end with a passing `verify`).
- **Storage:** retention configuration (versioning, immutability policy and retention period matching the record-retention schedule).
- **Monitoring:** watching the alerts in `docs/deploy/operations.md`.
- **Content:** expert review of the content packs before the pilot (`ALLOW_UNVERIFIED_CITATIONS` is refused in production).

In "Change control", item 3, replace the stale `reviewStatus` sentence. Content-pack changes go through a pull request on `backend/packs/`, with a pack version bump, and become citable only once `verified` is recorded in the concept's frontmatter (REQ-22).

- [ ] **Step 4: Update `README.md`**

Add a section `## Running in production` after "Content packs and the knowledge graph". It holds a short pointer list:
- the deployment guide;
- the runbook;
- the release order (`migrate`, `packs:compile`, then deploy);
- the separate API login (`create-api-login`);
- the probes and metrics endpoints, and that nginx doesn't expose them;
- logs are JSON with `requestId`;
- `npm run verify`.

Under the quick start's settings, list the new settings from Task 1 with one line each.

In "Not in the MVP (next steps)", record the deferred items:
- ESLint
- Playwright end-to-end tests
- the `react-router-dom` 7 upgrade
- recording searches in the trail
- a shared rate-limit store for more than one API replica

- [ ] **Step 5: Check and commit**

Check every command, setting name and endpoint in the four documents against the code: `grep` each setting name in `backend/src` and each script in `backend/package.json`. Fix any mismatch in the docs, not the code, and list what you checked in the report.

```bash
git add docs/deploy README.md backend/validation/README.md
git commit -m "Document the Azure reference deployment, the operations runbook and the client's responsibilities

Co-Authored-By: <model> <noreply@anthropic.com>"
```
