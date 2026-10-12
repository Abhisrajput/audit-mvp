# Reference deployment on Azure

This is the reference deployment for a client's own Azure tenant. It is documented, not scripted: use your
own infrastructure-as-code. Operating the result is covered in [operations.md](operations.md).

## 1. What you deploy

- Two images, built from the repository root:
  - `api`, from `backend/Dockerfile` (`docker build -t api ./backend`). Runs as the non-root `node` user and contains no npm, so every command inside it is `node dist/...`.
  - `web`, from `frontend/Dockerfile` (`docker build -f frontend/Dockerfile -t web .`). nginx 1.30.5 on Alpine, serving the UI and proxying `/api/` and `/auth/` to the API.
- Azure Database for PostgreSQL Flexible Server, version 16, with `vector` allow-listed in the `azure.extensions` server parameter (migration 005 runs `CREATE EXTENSION vector`).
- A storage account (evidence files) and an Entra ID app registration (sign-in).
- Key Vault for every secret.
- Log Analytics for logs.
- Optionally a model provider. `LLM_PROVIDER` accepts `offline` (default) or `anthropic` today. Azure OpenAI, or Claude through Microsoft Foundry, needs a new provider behind the `LlmProvider` interface in `backend/src/engine/llm/provider.ts`.

## 2. Identity (Entra ID)

1. Register the app in the client's tenant.
2. Add the redirect URI `https://<host>/auth/callback`.
3. Under *Token configuration*, add the `groups` claim and the optional claim `auth_time` to the ID token. Without `auth_time`, signing is refused.
4. Set:
   - `OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0`
   - `OIDC_CLIENT_ID`
   - `OIDC_CLIENT_SECRET` (from Key Vault)
   - `OIDC_REDIRECT_URI=https://<host>/auth/callback` (same origin as `PUBLIC_URL`)
   - `OIDC_GROUPS_CLAIM=groups`
   - `OIDC_ROLE_MAP`, a JSON object from group object id to role (`auditor`, `audit_manager`, `cae`, `admin`, `viewer`).

Signing re-authenticates with `prompt=login` and `max_age=0`. If the tenant does not honour `prompt=login`
(the ID token's `auth_time` is then earlier than the signing request and signing is refused), use the Entra
authentication-context fallback described in spec section 13.

## 3. Database

1. Create the server with TLS enforced (`require_secure_transport` on) and point-in-time restore retention of 30 days.
2. Create the database `audit`.
3. The owner login (the server administrator, or a dedicated owner) runs `migrate` and `packs:compile`. Migration 009 creates the `audit_api` role if it is missing.
4. If the owner may not create roles, an administrator creates the role first: `CREATE ROLE audit_api NOLOGIN;`.
5. Create the API's own login, as a login with `CREATEROLE` (an administrator), for example as a Container Apps job:

   ```bash
   API_DB_PASSWORD=<16+ characters> node dist/db/cli.js create-api-login audit_app
   ```

   - On Postgres 16, a non-superuser `CREATEROLE` login also needs `ADMIN OPTION` on `audit_api` if an administrator pre-created it: `GRANT audit_api TO <that login> WITH ADMIN OPTION;`.
   - The login is a member of `audit_api`, which can read everything and append to the record but never change, delete or unprotect it.
   - Run again with the same name, it only changes the password. It does so only for a login this tool made: no privileged attributes, owning nothing, and `audit_api` as its only membership. Otherwise it refuses; choose a new name.
   - `API_DB_PASSWORD_FILE` works in place of `API_DB_PASSWORD`.
   - Before sending any role statement it checks that the login running it can succeed (superuser, or `CREATEROLE` plus, on Postgres 16, `ADMIN OPTION` on `audit_api` to create the login, or on the login itself to change its password), and otherwise refuses naming what is missing. A failed statement would be written to the server log with the password in it.
   - The statement contains the password. If the server logs DDL (`log_statement=ddl` or `all`, or pgAudit's `ddl` class), the successful statement is logged too: turn that off for the run, or keep those logs out of wide-access workspaces.
6. The API's `DATABASE_URL` uses `audit_app` and the server's host name, with `DATABASE_SSL=verify-full` (the default in production). Azure's server certificate chains to a public CA; set `DATABASE_SSL_CA_FILE` only for a private CA.
7. Never put TLS parameters in the URL (`sslmode`, `ssl`, `sslcert`, `sslkey`, `sslrootcert`, `sslnegotiation`, `uselibpqcompat`). Start-up refuses them, because node-postgres would let the URL override `DATABASE_SSL`; the API also strips them before connecting.

The API login cannot run `migrate` or `packs:compile`; those keep the owner login.

## 4. Storage

1. Create a storage account with blob versioning on.
2. Create a container `evidence` with a time-based immutability policy (retention lock) sized to the client's record-retention period.
3. Set `BLOB_DRIVER=azure`, `AZURE_STORAGE_CONNECTION_STRING` (from Key Vault) and `AZURE_STORAGE_CONTAINER=evidence`.
4. Keep `BLOB_PRESIGN_DOWNLOADS=false` unless users' browsers can reach the storage endpoint.

## 5. Container Apps

The `api` app:
- Internal ingress on port 3002. Min replicas 1, max replicas 1 for the pilot, because rate limits are held in memory per replica.
- Liveness probe `GET /healthz`, readiness probe `GET /readyz`.
- Secrets from Key Vault as environment variables, or as mounted files with `<NAME>_FILE`. These names accept `_FILE`: `DATABASE_URL`, `OIDC_CLIENT_SECRET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `AZURE_STORAGE_CONNECTION_STRING`, `ANTHROPIC_API_KEY`, `METRICS_TOKEN`, `API_DB_PASSWORD`. Setting both `<NAME>` and `<NAME>_FILE` is an error.

The `web` app: external ingress on port 80. nginx proxies only `/api/` and `/auth/`, so the probes and `/metrics` are not reachable from outside.

Set `TRUST_PROXY=2`: the request passes the Container Apps ingress and then nginx. The setting decides which client address the rate limits count and whether the incoming `X-Request-Id` is reused.
Too low and every client shares one address; too high and a client can forge it.

Container Apps has no read-only root filesystem setting. The image runs as the non-root `node` user, and the API writes nothing to disk.

## 6. Release steps

In order, as Container Apps jobs using the new `api` image and the owner login:

1. `node dist/db/cli.js migrate`
2. `node dist/knowledge/packs-cli.js compile`
3. Deploy the new `api` revision.

The API never migrates or compiles at start-up in production, and refuses to start if the knowledge graph does not match the image's packs.

## 7. Required production settings

`loadServerConfig` runs every loader and lists every problem at once, so a bad deployment is fixed in one pass.

| Setting | Production rule |
|---|---|
| `NODE_ENV` | `production` |
| `DEV_AUTH` | `false` (true is refused) |
| `ALLOW_UNVERIFIED_CITATIONS` | `false` or unset (true is refused) |
| `PUBLIC_URL` | `https://` |
| `OIDC_ISSUER`, `OIDC_REDIRECT_URI` | set, `https://`; the redirect on the same origin as `PUBLIC_URL`; `OIDC_CLIENT_ID` also required |
| `DATABASE_URL` | no TLS parameters (`sslmode`, `ssl`, `sslcert`, ...) |
| `DATABASE_SSL` | `verify-full` (default), or `require`; `disable` is refused |
| `METRICS_TOKEN` | required for the API server, at least 24 characters. The `migrate`, `compile`, `verify` and `create-api-login` commands do not need it |
| `BLOB_DRIVER` | `s3` or `azure` (`local` is refused); the S3 endpoint, if set, is `https://`; the Azurite emulator account is refused |
| `BLOB_MAX_BYTES` | at most 104857600 (100 MiB) |

Other settings: `LOG_LEVEL` (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`; default `info`), `TRUST_PROXY` (0 to 5; default 0), `DATABASE_SSL_CA_FILE`.

## 8. Monitoring

- **Logs.** Log Analytics collects the API's JSON stdout. Query by `requestId`: the same id is in the response header `X-Request-Id`, in every error body, and in each audit-trail bundle the request wrote. Secrets, cookies and tokens are redacted from logs.
- **Metrics.** Prometheus (Azure Monitor managed Prometheus) scrapes `/metrics` on the API's internal address with `Authorization: Bearer <METRICS_TOKEN>`.
- **Alerts.** Set up the alert rules listed under *Metrics* in [operations.md](operations.md): 5xx rate, `INTERNAL` errors, signature failures, deterministic LLM fallbacks, slow trail appends, and failing readiness.
- **Nightly check.** Schedule `node dist/db/cli.js verify` as a Container Apps job with the API's environment (see operations.md).
