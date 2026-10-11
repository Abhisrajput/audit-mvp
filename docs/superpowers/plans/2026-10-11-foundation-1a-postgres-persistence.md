# Foundation 1A — Postgres Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MVP's JSON-file `Store` with Postgres so every write is transactional, concurrent edits are detected, and the audit trail is append-only at the database level. Behaviour stays identical: 21 existing tests green and the eval at 25/25.

**Architecture:** `AuditService` becomes async and runs each mutating request in one Kysely transaction:

1. `SELECT … FOR UPDATE` the engagement row
2. Assemble the unchanged `Engagement` object from `engagements`, `engagement_work` (JSONB) and `findings`
3. Run the untouched engine logic
4. Save with an optimistic `version` check, append trail bundles under a transaction-scoped advisory lock
5. Commit

The eval harness runs against an in-process PGlite database, so evaluation never writes to the operational database or its trail.

**Tech Stack:** Node 22, TypeScript, Express 5, Kysely, `pg`, Postgres 16 + pgvector (`pgvector/pgvector:pg16`), `@electric-sql/pglite` (eval only), vitest + `@testcontainers/postgresql`.

**Spec:** `docs/superpowers/specs/2026-10-11-production-foundation-design.md` (§2, §3.1, §3.3, §3.4, §8 partially, §10 partially, §11 REQ-20/REQ-21)

## Foundation plan index

The spec covers six subsystems, so it is split into plans that each ship working, tested software:

| Plan | Scope | Spec sections |
|---|---|---|
| **1A (this plan)** | Postgres persistence: migrations, transactions, optimistic locking, append-only trail, import-json, eval isolation | §2, §3.1 (core tables), §3.3, §3.4 |
| 1B | Identity: OIDC login, sessions, CSRF, `DEV_AUTH`, roles, segregation of duties, admin page | §4.1–4.3, §4.5, §9 (auth parts) |
| 1C | Part 11 signing: `signatures` and `finding_revisions` tables, sign intents, re-auth popup, `gates`/`agent_*` tables | §3.1–3.2, §4.4, §9 (sign flow) |
| 1D | Storage: `BlobStore` (S3, Azure, local), `documents`/`document_text`/`chunks`, `Retriever` with permission filtering | §5, §6.5 |
| 1E | Knowledge: OKF bundles, `packs:migrate`/`packs:compile`, `kg_nodes`/`kg_edges`, trust rules in the citation gate | §6.1–6.4 |
| 1F | Operations: config hardening, pino, helmet, rate limits, `/healthz` `/readyz` `/metrics`, full `verify`, CI, Azure deployment guide, client responsibilities | §7, §8, §10 (CI), §11 |

## Global Constraints

- Node 20+ (tested on 22). Postgres 16 with pgvector, image `pgvector/pgvector:pg16`.
- Kysely for queries. Migrations are plain, reviewed `.sql` files in `backend/migrations/`, applied by the `migrate` command, **never at server start-up**.
- `LLM_PROVIDER=offline` stays the default; no API key is needed for anything in this plan.
- The engine in `backend/src/engine/*` is unchanged except:
  - `trail.ts`: `seal` takes the chain tip instead of the whole chain
  - `types.ts`: `Engagement` gains an optional `version`
- The `Engagement` object shape is preserved. `frontend/src/types.ts` re-exports backend types, and every module's `apply()` mutates that object.
- Tests keep `[REQ-xx]` tags in their titles; `src/validation/traceability.ts` reads them.
- `npm run eval` stays at 25/25 offline.
- Only REQ-20 and REQ-21 are added to `validation/requirements.json` in this plan. The other new requirements are added by the plans that implement them, so the traceability test (`every High requirement covered`) stays green.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `design/production-foundation` (already checked out), or a worktree from it.

**Deliberate refinements of the spec (1A):**
- `findings` stores key columns (`id`, `row_id`, `control_id`, `status`, `rating`) plus the full finding as `data jsonb` rather than one column per 5 C's. That keeps the engine's `Finding` shape intact; reporting plans can add generated columns later.
- Findings that `gaps` regenerates are **superseded** (`superseded_at` set), not deleted.
- `users`, `sessions`, `signatures`, `agent_*`, `gates`, `documents` and `kg_*` tables come with the plans that use them.
- The spec omits `eval_runs`, but `app.ts` needs it, so it is added here.

## Review Focus

1. **Two people mutating one engagement at once with no `If-Match`.** Both succeed in sequence, the version goes up by two, and the trail stays contiguous with nothing lost. Pinned in Task 4.
2. **Re-running Gap Writer after a finding is approved.** The approved row is byte-identical afterwards (same `data`, same `updated_at`), and the save never trips the approved-row trigger. Pinned in Task 3.
3. **`import-json` of a tampered `db.json`, or into a database that already has data.** It refuses and writes nothing. Pinned in Task 5.
4. **Many engagements created in parallel.** Trail `seq` is exactly 1..N with no gaps, duplicates or fork, and the chain verifies. Pinned in Task 2.
5. **API started with no `DATABASE_URL`, or against a database with unapplied migrations.** It exits non-zero with a clear message and never migrates by itself. Pinned in Task 5.

## File structure

| File | Responsibility |
|---|---|
| `backend/migrations/001_core.sql` | Core tables and append-only and approved-lock triggers |
| `backend/src/db/schema.ts` | Kysely table types |
| `backend/src/db/index.ts` | `Db` interface and `connectPg()` |
| `backend/src/db/pglite.ts` | `createMemoryDb()`: in-process Postgres for eval |
| `backend/src/db/migrate.ts` | `migrate()`, `pendingMigrations()`, `migrationFiles()` |
| `backend/src/db/trail-repo.ts` | `appendTrail()`, `insertSealed()`, `readTrail()` |
| `backend/src/db/engagement-repo.ts` | `insertEngagement()`, `loadEngagement()`, `saveEngagement()`, `listEngagements()`, `insertFinding()` |
| `backend/src/db/eval-repo.ts` | `saveEvalRun()`, `listEvalRuns()`, `getEvalRun()`, `latestEvalRun()` |
| `backend/src/db/import-json.ts` | `importJson()`: one-off MVP migration |
| `backend/src/db/cli.ts` | `migrate`, `import-json <file>`, `verify` commands |
| `backend/src/errors.ts` | `AppError` with stable `code` |
| `backend/src/config.ts` | `loadDotEnv()`, `loadConfig()` |
| `backend/src/service.ts` | Async `AuditService` over `Db` (rewritten) |
| `backend/src/app.ts` | Async routes, `If-Match`, error codes (rewritten) |
| `backend/src/server.ts`, `src/seed.ts`, `src/eval/harness.ts` | Use Postgres / PGlite |
| `backend/src/store.ts` | **Deleted** |
| `backend/tests/global-setup.ts`, `tests/setup.ts`, `tests/db.ts`, `tests/db-url.ts`, `tests/vitest.d.ts` | Testcontainers Postgres, one fresh database per service |
| `backend/tests/db.test.ts`, `trail.test.ts`, `engagement-repo.test.ts`, `persistence.test.ts` | New tests |
| `backend/tests/engine.test.ts`, `api.test.ts`, `helpers.ts` | Ported to async |
| `docker-compose.yml`, `backend/Dockerfile`, `backend/.env.example`, `README.md` | Packaging and docs |

---
### Task 0: Baseline

**Files:** none changed.

- [ ] **Step 1: Install dependencies**

```bash
cd backend && npm install && cd ../frontend && npm install && cd ..
```

- [ ] **Step 2: Record the baseline. All four must pass before any change.**

```bash
cd backend && npm test && npm run eval && npm run typecheck && cd ../frontend && npm run typecheck && cd ..
```

Expected:
- vitest reports 21 passed
- eval prints `Result: **25/25 passed**`
- both typechecks exit 0

If anything fails here, stop and report. Don't start Task 1 on a red baseline.

- [ ] **Step 3: Check Docker is running.** Testcontainers needs it from Task 1 on.

Run: `docker info --format '{{.ServerVersion}}'`
Expected: a version number, not an error.

---

### Task 1: Database layer, core migration and test harness

**Files:**
- Create: `backend/migrations/001_core.sql`
- Create: `backend/src/db/schema.ts`, `backend/src/db/index.ts`, `backend/src/db/pglite.ts`, `backend/src/db/migrate.ts`
- Create: `backend/tests/global-setup.ts`, `backend/tests/setup.ts`, `backend/tests/db.ts`, `backend/tests/db-url.ts`, `backend/tests/vitest.d.ts`
- Create: `backend/tests/db.test.ts`
- Modify: `backend/vitest.config.ts`, `backend/package.json`, `backend/src/engine/types.ts` (add `version?`)

**Interfaces:**
- Produces:
  - `interface Db { kysely: Kysely<DB>; execScript(script: string): Promise<void>; close(): Promise<void> }`
  - `connectPg(url: string, opts?: { max?: number }): Db`
  - `createMemoryDb(): Promise<Db>` (migrated)
  - `migrate(db: Db, dir?: string): Promise<string[]>`
  - `pendingMigrations(db: Db, dir?: string): Promise<string[]>`
  - `MIGRATIONS_DIR`
  - `type DB` (Kysely schema)
  - test helper `testDb(): Promise<Db>`
  - `Engagement.version?: number`

- [ ] **Step 1: Add dependencies**

```bash
cd backend
npm install kysely pg @electric-sql/pglite
npm install -D @types/pg @testcontainers/postgresql
```

- [ ] **Step 2: Write the migration** `backend/migrations/001_core.sql`

```sql
-- Core persistence for engagements, findings, the audit trail and eval runs.
-- The engine's working output stays JSONB; anything later sub-projects query
-- across engagements or must protect with constraints gets real columns.

CREATE TABLE engagements (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  entity          text NOT NULL,
  site            text NOT NULL,
  period_from     text NOT NULL,
  period_to       text NOT NULL,
  audit_type      text NOT NULL,
  scope_statement text NOT NULL,
  pack_ids        jsonb NOT NULL,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  stage           text NOT NULL CHECK (stage IN ('planning', 'rcm', 'fieldwork', 'findings', 'reporting')),
  version         integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE engagement_work (
  engagement_id text PRIMARY KEY REFERENCES engagements (id),
  scope         jsonb NOT NULL DEFAULT '[]',
  rcm           jsonb NOT NULL DEFAULT '[]',
  test_inputs   jsonb NOT NULL DEFAULT '{}',
  test_results  jsonb NOT NULL DEFAULT '{}',
  report        jsonb
);

CREATE TABLE findings (
  seq           bigserial NOT NULL UNIQUE,
  engagement_id text NOT NULL REFERENCES engagements (id),
  id            text NOT NULL,
  row_id        text NOT NULL,
  control_id    text NOT NULL,
  status        text NOT NULL CHECK (status IN ('draft', 'blocked', 'reviewed', 'approved', 'rejected')),
  rating        text NOT NULL CHECK (rating IN ('High', 'Medium', 'Low')),
  data          jsonb NOT NULL,
  superseded_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engagement_id, id)
);
CREATE INDEX findings_live_idx ON findings (engagement_id, seq) WHERE superseded_at IS NULL;

-- body is the exact JSON of the sealed bundle; hashes are recomputed from it.
CREATE TABLE trail (
  seq           bigint PRIMARY KEY CHECK (seq > 0),
  id            text NOT NULL UNIQUE,
  engagement_id text,
  module_id     text NOT NULL,
  actor         text NOT NULL,
  prev_hash     text NOT NULL,
  hash          text NOT NULL UNIQUE,
  body          text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trail_engagement_idx ON trail (engagement_id, seq);

CREATE TABLE eval_runs (
  id   text PRIMARY KEY,
  at   timestamptz NOT NULL,
  body jsonb NOT NULL
);

CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER trail_append_only BEFORE UPDATE OR DELETE ON trail
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER trail_no_truncate BEFORE TRUNCATE ON trail
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE FUNCTION lock_approved_finding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'Approved finding % is locked: % rejected', OLD.id, TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER findings_lock_approved BEFORE UPDATE OR DELETE ON findings
  FOR EACH ROW EXECUTE FUNCTION lock_approved_finding();
```

- [ ] **Step 3: Add the optional version to the engagement type.** In `backend/src/engine/types.ts`, inside `interface Engagement`, add after `report: AuditReport | null;`:

```ts
  /** Optimistic-concurrency version from the database; absent on objects not yet saved. */
  version?: number;
```

- [ ] **Step 4: Write the Kysely schema** `backend/src/db/schema.ts`

```ts
import type { ColumnType, Generated } from 'kysely';
import type { EvalReport } from '../eval/harness';
import type { AuditReport, EngagementStage, Finding, FindingStatus, RcmRow, RiskRating, ScopeItem, TestInput, TestResult } from '../engine/types';

// JSONB columns are read as parsed values and written as JSON strings.
type Json<T> = ColumnType<T, string, string>;
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type DefaultedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface EngagementsTable {
  id: string;
  name: string;
  entity: string;
  site: string;
  period_from: string;
  period_to: string;
  audit_type: string;
  scope_statement: string;
  pack_ids: Json<string[]>;
  created_by: string;
  created_at: Timestamp;
  updated_at: DefaultedTimestamp;
  stage: EngagementStage;
  version: ColumnType<number, number | undefined, number>;
}

export interface EngagementWorkTable {
  engagement_id: string;
  scope: Json<ScopeItem[]>;
  rcm: Json<RcmRow[]>;
  test_inputs: Json<Record<string, TestInput>>;
  test_results: Json<Record<string, TestResult>>;
  report: ColumnType<AuditReport | null, string | null, string | null>;
}

export interface FindingsTable {
  seq: Generated<number>;
  engagement_id: string;
  id: string;
  row_id: string;
  control_id: string;
  status: FindingStatus;
  rating: RiskRating;
  data: Json<Finding>;
  superseded_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Generated<Date>;
  updated_at: DefaultedTimestamp;
}

export interface TrailTable {
  seq: number;
  id: string;
  engagement_id: string | null;
  module_id: string;
  actor: string;
  prev_hash: string;
  hash: string;
  body: string;
  recorded_at: Generated<Date>;
}

export interface EvalRunsTable {
  id: string;
  at: Timestamp;
  body: Json<EvalReport>;
}

export interface SchemaMigrationsTable {
  name: string;
  applied_at: Generated<Date>;
}

export interface DB {
  engagements: EngagementsTable;
  engagement_work: EngagementWorkTable;
  findings: FindingsTable;
  trail: TrailTable;
  eval_runs: EvalRunsTable;
  schema_migrations: SchemaMigrationsTable;
}
```

- [ ] **Step 5: Write the Postgres connection** `backend/src/db/index.ts`

```ts
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './schema';

// int8 (counts, bigserial) as numbers; values in this application stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export interface Db {
  kysely: Kysely<DB>;
  /** Runs a multi-statement SQL script on one connection; rolls back on failure. */
  execScript(script: string): Promise<void>;
  close(): Promise<void>;
}

export function connectPg(connectionString: string, opts: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  const kysely = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    kysely,
    async execScript(script) {
      const client = await pool.connect();
      try {
        await client.query(script);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => kysely.destroy(),
  };
}
```

- [ ] **Step 6: Write the migration runner** `backend/src/db/migrate.ts`

```ts
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'kysely';
import type { Db } from './index';

// Plain, reviewed SQL files applied in name order, each in its own transaction.
// Run by the `migrate` command only; the API never migrates on start-up.

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const NAME = /^\d{3}_[a-z0-9_]+\.sql$/;

export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return fs.readdirSync(dir).filter((f) => NAME.test(f)).sort();
}

async function appliedNames(db: Db): Promise<Set<string>> {
  const { rows } = await sql<{ t: string | null }>`select to_regclass('schema_migrations')::text as t`.execute(db.kysely);
  if (!rows[0]?.t) return new Set();
  const done = await db.kysely.selectFrom('schema_migrations').select('name').execute();
  return new Set(done.map((r) => r.name));
}

export async function pendingMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const done = await appliedNames(db);
  return migrationFiles(dir).filter((f) => !done.has(f));
}

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.execScript('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied: string[] = [];
  for (const file of await pendingMigrations(db, dir)) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    // file matches NAME, so it is safe to inline.
    await db.execScript(`BEGIN;\n${body}\n;\nINSERT INTO schema_migrations (name) VALUES ('${file}');\nCOMMIT;`);
    applied.push(file);
  }
  return applied;
}
```

- [ ] **Step 7: Write the in-process database** `backend/src/db/pglite.ts`

```ts
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import type { Db } from './index';
import { migrate } from './migrate';
import type { DB } from './schema';

// An in-process Postgres (PGlite) used by the evaluation harness, so eval runs
// never write to the operational database or its audit trail. PGlite is a
// single connection, so connections are handed out one at a time.

const commandOf = (text: string) => text.trimStart().split(/\s/, 1)[0].toUpperCase();

export async function createMemoryDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite();
  await pglite.waitReady;

  let queue: Promise<void> = Promise.resolve();
  const pool = {
    async connect() {
      let release!: () => void;
      const turn = new Promise<void>((resolve) => (release = resolve));
      const previous = queue;
      queue = previous.then(() => turn);
      await previous;
      return {
        async query(text: string, params: unknown[] = []) {
          const r = await pglite.query<Record<string, unknown>>(text, params as never[]);
          return { command: commandOf(text), rowCount: r.affectedRows ?? r.rows.length, rows: r.rows };
        },
        release,
      };
    },
    async end() {
      await pglite.close();
    },
  };

  const db: Db = {
    kysely: new Kysely<DB>({ dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }) }),
    async execScript(script) {
      try {
        await pglite.exec(script);
      } catch (err) {
        await pglite.exec('ROLLBACK').catch(() => undefined);
        throw err;
      }
    },
    close: () => db.kysely.destroy(),
  };
  await migrate(db);
  return db;
}
```

- [ ] **Step 8: Write the test harness**

`backend/tests/db-url.ts`:

```ts
export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
```

`backend/tests/global-setup.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { connectPg } from '../src/db';
import { migrate } from '../src/db/migrate';
import { withDatabase } from './db-url';

// One Postgres container per test run. Migrations are applied once to a
// template database; every test service gets a fresh copy of it.

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const adminUrl = container.getConnectionUri();
  const admin = connectPg(adminUrl, { max: 1 });
  await admin.execScript('CREATE DATABASE audit_template');
  await admin.close();
  const template = connectPg(withDatabase(adminUrl, 'audit_template'), { max: 1 });
  await migrate(template);
  await template.close();
  project.provide('pgAdminUrl', adminUrl);
}

export async function teardown() {
  await container?.stop();
}
```

`backend/tests/db.ts`:

```ts
import { inject } from 'vitest';
import { connectPg, type Db } from '../src/db';
import { withDatabase } from './db-url';

const open: Db[] = [];
let counter = 0;

/** A fresh, migrated database cloned from the template. */
export async function testDb(): Promise<Db> {
  const adminUrl = inject('pgAdminUrl');
  const name = `t_${process.pid}_${Date.now()}_${counter++}`;
  const admin = connectPg(adminUrl, { max: 1 });
  try {
    await admin.execScript(`CREATE DATABASE ${name} TEMPLATE audit_template`);
  } finally {
    await admin.close();
  }
  const db = connectPg(withDatabase(adminUrl, name));
  open.push(db);
  return db;
}

/** A database with no migrations applied. */
export async function emptyDb(): Promise<Db> {
  const adminUrl = inject('pgAdminUrl');
  const name = `e_${process.pid}_${Date.now()}_${counter++}`;
  const admin = connectPg(adminUrl, { max: 1 });
  try {
    await admin.execScript(`CREATE DATABASE ${name}`);
  } finally {
    await admin.close();
  }
  const db = connectPg(withDatabase(adminUrl, name));
  open.push(db);
  return db;
}

export async function closeTestDbs() {
  await Promise.all(open.splice(0).map((d) => d.close()));
}
```

`backend/tests/setup.ts`:

```ts
import { afterAll } from 'vitest';
import { closeTestDbs } from './db';

afterAll(closeTestDbs);
```

`backend/tests/vitest.d.ts`:

```ts
import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}
```

Replace `backend/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
    // Files share one Postgres container; run them one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
```

- [ ] **Step 9: Write the failing tests** `backend/tests/db.test.ts`

```ts
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../src/db/pglite';
import { migrate, migrationFiles, pendingMigrations } from '../src/db/migrate';
import { emptyDb, testDb } from './db';

const trailRow = (seq: number) => ({
  seq, id: `B-${seq}`, engagement_id: 'ENG-1', module_id: 'scope', actor: 'auditor',
  prev_hash: '0'.repeat(64), hash: String(seq).padStart(64, 'a'), body: '{}',
});

describe('migrations', () => {
  it('applies every migration once and reports none pending afterwards', async () => {
    const db = await emptyDb();
    expect(await pendingMigrations(db)).toEqual(migrationFiles());
    expect(await migrate(db)).toEqual(migrationFiles());
    expect(await migrate(db)).toEqual([]);
    expect(await pendingMigrations(db)).toEqual([]);
  });

  it('runs the same migrations on the in-process database used by eval', async () => {
    const mem = await createMemoryDb();
    try {
      expect(await pendingMigrations(mem)).toEqual([]);
      await mem.kysely.insertInto('trail').values(trailRow(1)).execute();
      await expect(mem.kysely.deleteFrom('trail').execute()).rejects.toThrow(/append-only/);
    } finally {
      await mem.close();
    }
  });
});

describe('database-enforced integrity', () => {
  it('rejects UPDATE, DELETE and TRUNCATE on the audit trail [REQ-20]', async () => {
    const db = (await testDb()).kysely;
    await db.insertInto('trail').values(trailRow(1)).execute();
    await expect(db.updateTable('trail').set({ actor: 'mallory' }).where('seq', '=', 1).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.deleteFrom('trail').where('seq', '=', 1).execute()).rejects.toThrow(/append-only: DELETE/);
    await expect(sql`TRUNCATE trail`.execute(db)).rejects.toThrow(/append-only: TRUNCATE/);
    expect((await db.selectFrom('trail').select('actor').executeTakeFirstOrThrow()).actor).toBe('auditor');
  });

  it('rejects any change to an approved finding at the database level [REQ-09, REQ-20]', async () => {
    const db = (await testDb()).kysely;
    await db.insertInto('engagements').values({
      id: 'ENG-1', name: 'n', entity: 'e', site: 's', period_from: 'a', period_to: 'b', audit_type: 't',
      scope_statement: 's', pack_ids: '["common"]', created_by: 'auditor', created_at: new Date().toISOString(), stage: 'findings',
    }).execute();
    const base = { engagement_id: 'ENG-1', row_id: 'R', control_id: 'C', rating: 'High' as const, data: '{}' };
    await db.insertInto('findings').values([{ ...base, id: 'F-1', status: 'reviewed' }, { ...base, id: 'F-2', status: 'approved' }]).execute();
    await db.updateTable('findings').set({ status: 'approved' }).where('id', '=', 'F-1').execute();
    await expect(db.updateTable('findings').set({ rating: 'Low' }).where('id', '=', 'F-2').execute()).rejects.toThrow(/locked/);
    await expect(db.deleteFrom('findings').where('id', '=', 'F-2').execute()).rejects.toThrow(/locked/);
  });
});
```

- [ ] **Step 10: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/db.test.ts`
Expected: FAIL. Before Steps 2–8 are saved, the imports fail to resolve. After them, these tests should pass. If you wrote the files first, temporarily rename `migrations/001_core.sql` to see the migration tests fail, then rename it back.

- [ ] **Step 11: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/db.test.ts`
Expected: PASS, 4 tests. The first run pulls `pgvector/pgvector:pg16`, which can take a minute.

- [ ] **Step 12: Commit**

```bash
git add backend/migrations backend/src/db backend/src/engine/types.ts backend/tests/global-setup.ts backend/tests/setup.ts backend/tests/db.ts backend/tests/db-url.ts backend/tests/vitest.d.ts backend/tests/db.test.ts backend/vitest.config.ts backend/package.json backend/package-lock.json
git commit -m "Add Postgres schema, migration runner and test database harness

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Note: the existing `engine.test.ts` and `api.test.ts` still use the old `Store` and pass unchanged. They are ported in Task 4.

---
### Task 2: Append-only trail in Postgres

**Files:**
- Modify: `backend/src/engine/trail.ts` (`seal` signature)
- Modify: `backend/src/service.ts:206-211` (one call site, so the old suite keeps compiling)
- Create: `backend/src/db/trail-repo.ts`
- Test: `backend/tests/trail.test.ts`

**Interfaces:**
- Consumes: `Db`, `DB`, `testDb()` (Task 1)
- Produces:
  - `interface ChainTip { seq: number; hash: string }`
  - `seal(prev: ChainTip | null, bundle: Omit<TrailBundle, 'hash' | 'prevHash' | 'seq'>): TrailBundle`
  - `type Executor = Kysely<DB> | Transaction<DB>`
  - `type UnsealedBundle = Omit<TrailBundle, 'hash' | 'prevHash' | 'seq'>`
  - `appendTrail(trx: Transaction<DB>, bundle: UnsealedBundle): Promise<TrailBundle>`
  - `insertSealed(db: Executor, bundle: TrailBundle): Promise<void>`
  - `readTrail(db: Executor, engagementId?: string): Promise<TrailBundle[]>`
  - `TRAIL_LOCK_KEY`

- [ ] **Step 1: Write the failing tests** `backend/tests/trail.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { appendTrail, readTrail, type UnsealedBundle } from '../src/db/trail-repo';
import { GENESIS_HASH, seal, verifyChain } from '../src/engine/trail';
import { testDb } from './db';

const bundle = (i: number, engagementId = 'ENG-1'): UnsealedBundle => ({
  id: `HUM-${i}`, engagementId, moduleId: 'human:test', moduleVersion: '0.1.0', engineVersion: '0.1.0',
  packVersions: { common: '0.1.0' }, provider: { id: 'human', model: 'auditor' }, promptHash: null, actor: 'auditor',
  startedAt: '2026-10-11T00:00:00.000Z', finishedAt: '2026-10-11T00:00:00.000Z', inputs: { i, score: 0.1 + 0.2 },
  retrievalSet: [{ clauseId: 'X', score: 1 / 3 }], executionLog: [], qaActions: [], output: { ok: true },
});

describe('trail sealing', () => {
  it('links each bundle to the chain tip', () => {
    const first = seal(null, bundle(1));
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    const second = seal({ seq: first.seq, hash: first.hash }, bundle(2));
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(verifyChain([first, second]).valid).toBe(true);
  });
});

describe('trail repository', () => {
  it('round-trips bundles exactly, so hashes still verify after storage [REQ-07]', async () => {
    const db = (await testDb()).kysely;
    await db.transaction().execute(async (trx) => {
      await appendTrail(trx, bundle(1));
      await appendTrail(trx, bundle(2, 'ENG-2'));
      await appendTrail(trx, bundle(3));
    });
    const all = await readTrail(db);
    expect(all.map((b) => b.seq)).toEqual([1, 2, 3]);
    expect(verifyChain(all).valid).toBe(true);
    expect((await readTrail(db, 'ENG-1')).map((b) => b.id)).toEqual(['HUM-1', 'HUM-3']);
  });

  it('serialises parallel appends into one contiguous chain with no fork', async () => {
    const db = (await testDb()).kysely;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => db.transaction().execute((trx) => appendTrail(trx, bundle(i, `ENG-${i}`)))),
    );
    const all = await readTrail(db);
    expect(all.map((b) => b.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(verifyChain(all).valid).toBe(true);
  });

  it('leaves no trail entry when the surrounding transaction rolls back', async () => {
    const db = (await testDb()).kysely;
    await expect(
      db.transaction().execute(async (trx) => {
        await appendTrail(trx, bundle(1));
        throw new Error('module failed after sealing');
      }),
    ).rejects.toThrow(/module failed/);
    expect(await readTrail(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/trail.test.ts`
Expected: FAIL with `Cannot find module '../src/db/trail-repo'`.

- [ ] **Step 3: Change `seal` to take the chain tip.** In `backend/src/engine/trail.ts`, replace the `seal` function with:

```ts
export interface ChainTip {
  seq: number;
  hash: string;
}

/** Seals a bundle onto the chain whose last entry is `prev` (null for the first bundle). */
export function seal(prev: ChainTip | null, bundle: Omit<TrailBundle, 'hash' | 'prevHash' | 'seq'>): TrailBundle {
  // Deep copy: the sealed record must not share objects with live working state.
  const unsealed = { ...structuredClone(bundle), seq: prev ? prev.seq + 1 : 1, prevHash: prev ? prev.hash : GENESIS_HASH };
  return { ...unsealed, hash: hashBundle(unsealed) };
}
```

Then update the only caller so the old suite still compiles. In `backend/src/service.ts`, replace the body of `private append(...)` with:

```ts
    const tip = this.store.trail.at(-1);
    const sealed = seal(tip ? { seq: tip.seq, hash: tip.hash } : null, bundle);
    this.store.trail.push(sealed);
    return sealed;
```

- [ ] **Step 4: Write the repository** `backend/src/db/trail-repo.ts`

```ts
import { sql, type Kysely, type Transaction } from 'kysely';
import { seal } from '../engine/trail';
import type { TrailBundle } from '../engine/types';
import type { DB } from './schema';

export type Executor = Kysely<DB> | Transaction<DB>;
export type UnsealedBundle = Omit<TrailBundle, 'hash' | 'prevHash' | 'seq'>;

/** Transaction-scoped advisory lock key ("AUDT") that serialises trail appends. */
export const TRAIL_LOCK_KEY = 0x41554454;

/**
 * Seals and appends one bundle. It must run inside the transaction that writes
 * the state the bundle describes, so the trail and the state commit or roll
 * back together. The advisory lock is released at commit.
 */
export async function appendTrail(trx: Transaction<DB>, bundle: UnsealedBundle): Promise<TrailBundle> {
  await sql`select pg_advisory_xact_lock(${TRAIL_LOCK_KEY})`.execute(trx);
  const tip = await trx.selectFrom('trail').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  const sealed = seal(tip ? { seq: Number(tip.seq), hash: tip.hash } : null, bundle);
  await insertSealed(trx, sealed);
  return sealed;
}

/** Inserts an already-sealed bundle as-is (used by append and by the MVP import). */
export async function insertSealed(db: Executor, b: TrailBundle): Promise<void> {
  await db
    .insertInto('trail')
    .values({
      seq: b.seq,
      id: b.id,
      engagement_id: b.engagementId ?? null,
      module_id: b.moduleId,
      actor: b.actor,
      prev_hash: b.prevHash,
      hash: b.hash,
      body: JSON.stringify(b),
    })
    .execute();
}

export async function readTrail(db: Executor, engagementId?: string): Promise<TrailBundle[]> {
  let q = db.selectFrom('trail').select('body').orderBy('seq');
  if (engagementId) q = q.where('engagement_id', '=', engagementId);
  return (await q.execute()).map((r) => JSON.parse(r.body) as TrailBundle);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/trail.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the whole suite.** It must stay green: the old `Store`-based tests still run through `seal`.

Run: `cd backend && npm test && npm run typecheck`
Expected: all tests pass, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add backend/src/engine/trail.ts backend/src/service.ts backend/src/db/trail-repo.ts backend/tests/trail.test.ts
git commit -m "Store the hash-chained trail in Postgres under an advisory lock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Engagement and eval-run repositories with optimistic locking

**Files:**
- Create: `backend/src/errors.ts`
- Create: `backend/src/db/engagement-repo.ts`, `backend/src/db/eval-repo.ts`
- Modify: `backend/src/service.ts` (move `AppError` out, re-export it)
- Test: `backend/tests/engagement-repo.test.ts`

**Interfaces:**
- Consumes: `Executor` (Task 2), `canonicalJson` from `src/engine/trail.ts`, `testDb()` (Task 1)
- Produces:
  - `class AppError extends Error { status: number; code: ErrorCode }`, constructed as `new AppError(status, message, code?)`
  - `type ErrorCode = 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VERSION_CONFLICT' | 'FINDING_BLOCKED' | 'FINDING_LOCKED' | 'INTERNAL'`
  - `interface LoadedEngagement { engagement: Engagement; version: number; findingSnapshots: Map<string, string> }`
  - `insertEngagement(db: Executor, e: Engagement): Promise<void>` (sets `e.version = 1`)
  - `insertFinding(db: Executor, engagementId: string, f: Finding): Promise<void>`
  - `loadEngagement(db: Executor, id: string, opts?: { forUpdate?: boolean }): Promise<LoadedEngagement | null>`
  - `saveEngagement(db: Executor, loaded: LoadedEngagement): Promise<void>` (sets `engagement.version`)
  - `listEngagements(db: Executor): Promise<EngagementSummary[]>`
  - `interface EngagementSummary { id; name; entity; site; auditType; packIds; stage; createdAt; findings: number; rcm: number; version: number }`
  - `saveEvalRun(db: Executor, r: EvalReport): Promise<void>`
  - `listEvalRuns(db: Executor): Promise<Omit<EvalReport, 'cases'>[]>` (newest first)
  - `getEvalRun(db: Executor, id: string): Promise<EvalReport | null>`
  - `latestEvalRun(db: Executor): Promise<EvalReport | null>`

- [ ] **Step 1: Write the failing tests** `backend/tests/engagement-repo.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { insertEngagement, listEngagements, loadEngagement, saveEngagement } from '../src/db/engagement-repo';
import { latestEvalRun, listEvalRuns, saveEvalRun } from '../src/db/eval-repo';
import type { EvalReport } from '../src/eval/harness';
import type { Engagement, Finding } from '../src/engine/types';
import { testDb } from './db';

const finding = (id: string, status: Finding['status'] = 'draft'): Finding => ({
  id, rowId: 'FD-HACCP-03', controlId: 'FD-HACCP-03', title: `Finding ${id}`, rating: 'High', condition: 'c', criteria: '§117.145',
  cause: 'c', effect: 'e', recommendation: 'r', citations: [{ clauseId: '21CFR117.145', regulation: '21 CFR Part 117', ref: '§117.145', label: '§117.145' }],
  evidenceRefs: ['CCP-LOG'], status, blockedReasons: [], signOffs: [], bundleId: 'RUN-1',
});

const engagement = (id = 'ENG-1'): Engagement => ({
  id, name: 'Test', entity: 'Demo', site: 'Plant', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 'Food safety',
  scopeStatement: 'HACCP', packIds: ['food', 'common'], createdBy: 'auditor', createdAt: '2026-10-11T08:00:00.123Z',
  stage: 'findings', scope: [], rcm: [], testInputs: {}, testResults: {}, findings: [finding('F-1'), finding('F-2', 'approved')], report: null,
});

describe('engagement repository', () => {
  it('round-trips an engagement exactly, in finding order', async () => {
    const db = (await testDb()).kysely;
    const e = engagement();
    await insertEngagement(db, e);
    const loaded = (await loadEngagement(db, 'ENG-1'))!;
    expect(loaded.version).toBe(1);
    expect(loaded.engagement).toEqual({ ...e, version: 1 });
    expect(await loadEngagement(db, 'NOPE')).toBeNull();
  });

  it('rejects a save from a stale copy instead of overwriting [REQ-21]', async () => {
    const db = (await testDb()).kysely;
    await insertEngagement(db, engagement());
    const a = (await loadEngagement(db, 'ENG-1'))!;
    const b = (await loadEngagement(db, 'ENG-1'))!;
    a.engagement.stage = 'reporting';
    await saveEngagement(db, a);
    expect(a.engagement.version).toBe(2);
    b.engagement.stage = 'rcm';
    await expect(saveEngagement(db, b)).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect((await loadEngagement(db, 'ENG-1'))!.engagement.stage).toBe('reporting');
  });

  it('writes only changed findings, supersedes dropped drafts and never touches approved rows', async () => {
    const db = (await testDb()).kysely;
    await insertEngagement(db, engagement());
    const approvedBefore = await db.selectFrom('findings').selectAll().where('id', '=', 'F-2').executeTakeFirstOrThrow();

    const l = (await loadEngagement(db, 'ENG-1'))!;
    // Same shape as a Gap Writer re-run: approved finding kept as-is, draft replaced by a new one.
    l.engagement.findings = [l.engagement.findings[1], finding('F-3')];
    await saveEngagement(db, l);

    const after = (await loadEngagement(db, 'ENG-1'))!;
    expect(after.engagement.findings.map((f) => f.id)).toEqual(['F-2', 'F-3']);
    const approvedAfter = await db.selectFrom('findings').selectAll().where('id', '=', 'F-2').executeTakeFirstOrThrow();
    expect(approvedAfter).toEqual(approvedBefore);
    const dropped = await db.selectFrom('findings').select('superseded_at').where('id', '=', 'F-1').executeTakeFirstOrThrow();
    expect(dropped.superseded_at).not.toBeNull();
  });

  it('treats a re-ordered but identical finding object as unchanged', async () => {
    const db = (await testDb()).kysely;
    await insertEngagement(db, engagement());
    const l = (await loadEngagement(db, 'ENG-1'))!;
    const approved = l.engagement.findings[1];
    l.engagement.findings[1] = Object.fromEntries(Object.entries(approved).reverse()) as Finding;
    await expect(saveEngagement(db, l)).resolves.toBeUndefined();
  });

  it('lists engagement summaries with live finding counts', async () => {
    const db = (await testDb()).kysely;
    await insertEngagement(db, engagement('ENG-1'));
    await insertEngagement(db, { ...engagement('ENG-2'), createdAt: '2026-10-12T08:00:00.000Z', findings: [] });
    const list = await listEngagements(db);
    expect(list.map((s) => [s.id, s.findings, s.rcm, s.version])).toEqual([['ENG-1', 2, 0, 1], ['ENG-2', 0, 0, 1]]);
    expect(list[0]).toMatchObject({ auditType: 'Food safety', packIds: ['food', 'common'], createdAt: '2026-10-11T08:00:00.123Z' });
  });
});

describe('eval run repository', () => {
  it('stores runs and lists them newest first without case detail', async () => {
    const db = (await testDb()).kysely;
    const run = (id: string, at: string): EvalReport => ({
      id, at, provider: { id: 'offline', model: 'rules' }, engineVersion: '0.1.0', packVersions: {}, total: 1, passed: 1, byKind: {}, cases: [],
    });
    await saveEvalRun(db, run('EVAL-1', '2026-10-11T00:00:00.000Z'));
    await saveEvalRun(db, run('EVAL-2', '2026-10-12T00:00:00.000Z'));
    expect((await listEvalRuns(db)).map((r) => r.id)).toEqual(['EVAL-2', 'EVAL-1']);
    expect('cases' in (await listEvalRuns(db))[0]).toBe(false);
    expect((await latestEvalRun(db))?.id).toBe('EVAL-2');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/engagement-repo.test.ts`
Expected: FAIL with `Cannot find module '../src/db/engagement-repo'`.

- [ ] **Step 3: Move `AppError` into its own module** `backend/src/errors.ts`

```ts
export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VERSION_CONFLICT'
  | 'FINDING_BLOCKED'
  | 'FINDING_LOCKED'
  | 'INTERNAL';

const DEFAULT_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
};

/** An error the API returns to the client with a stable, machine-readable code. */
export class AppError extends Error {
  readonly code: ErrorCode;
  constructor(public status: number, message: string, code?: ErrorCode) {
    super(message);
    this.code = code ?? DEFAULT_CODES[status] ?? 'INTERNAL';
  }
}
```

In `backend/src/service.ts`, delete the `AppError` class and add near the other imports:

```ts
import { AppError } from './errors';
export { AppError } from './errors';
```

- [ ] **Step 4: Write the engagement repository** `backend/src/db/engagement-repo.ts`

```ts
import { sql } from 'kysely';
import { canonicalJson } from '../engine/trail';
import type { Engagement, Finding } from '../engine/types';
import { AppError } from '../errors';
import type { Executor } from './trail-repo';

// Engagements are stored as a header row (with an optimistic version), one
// JSONB row of engine working output, and one row per finding. The service
// works on the assembled Engagement object exactly as the engine expects.

export interface LoadedEngagement {
  engagement: Engagement;
  version: number;
  /** canonicalJson of each live finding as loaded, to write only what changed. */
  findingSnapshots: Map<string, string>;
}

export interface EngagementSummary {
  id: string;
  name: string;
  entity: string;
  site: string;
  auditType: string;
  packIds: string[];
  stage: Engagement['stage'];
  createdAt: string;
  findings: number;
  rcm: number;
  version: number;
}

const json = (v: unknown) => JSON.stringify(v);
const iso = (d: Date | string) => new Date(d).toISOString();

export async function insertFinding(db: Executor, engagementId: string, f: Finding): Promise<void> {
  await db
    .insertInto('findings')
    .values({ engagement_id: engagementId, id: f.id, row_id: f.rowId, control_id: f.controlId, status: f.status, rating: f.rating, data: json(f) })
    .execute();
}

export async function insertEngagement(db: Executor, e: Engagement): Promise<void> {
  await db
    .insertInto('engagements')
    .values({
      id: e.id, name: e.name, entity: e.entity, site: e.site, period_from: e.periodFrom, period_to: e.periodTo,
      audit_type: e.auditType, scope_statement: e.scopeStatement, pack_ids: json(e.packIds), created_by: e.createdBy,
      created_at: e.createdAt, stage: e.stage, version: 1,
    })
    .execute();
  await db
    .insertInto('engagement_work')
    .values({
      engagement_id: e.id, scope: json(e.scope), rcm: json(e.rcm), test_inputs: json(e.testInputs),
      test_results: json(e.testResults), report: e.report ? json(e.report) : null,
    })
    .execute();
  for (const f of e.findings) await insertFinding(db, e.id, f);
  e.version = 1;
}

export async function loadEngagement(db: Executor, id: string, opts: { forUpdate?: boolean } = {}): Promise<LoadedEngagement | null> {
  let header = db.selectFrom('engagements').selectAll().where('id', '=', id);
  if (opts.forUpdate) header = header.forUpdate();
  const h = await header.executeTakeFirst();
  if (!h) return null;
  const w = await db.selectFrom('engagement_work').selectAll().where('engagement_id', '=', id).executeTakeFirstOrThrow();
  const rows = await db
    .selectFrom('findings')
    .select('data')
    .where('engagement_id', '=', id)
    .where('superseded_at', 'is', null)
    .orderBy('seq')
    .execute();
  const findings = rows.map((r) => r.data);
  const engagement: Engagement = {
    id: h.id, name: h.name, entity: h.entity, site: h.site, periodFrom: h.period_from, periodTo: h.period_to,
    auditType: h.audit_type, scopeStatement: h.scope_statement, packIds: h.pack_ids, createdBy: h.created_by,
    createdAt: iso(h.created_at), stage: h.stage, scope: w.scope, rcm: w.rcm, testInputs: w.test_inputs,
    testResults: w.test_results, findings, report: w.report, version: h.version,
  };
  return { engagement, version: h.version, findingSnapshots: new Map(findings.map((f) => [f.id, canonicalJson(f)])) };
}

/**
 * Writes the engagement back if nobody else saved since it was loaded.
 * Findings are diffed against their load-time snapshot: new ones are inserted,
 * changed ones updated, dropped ones superseded. Unchanged rows (including
 * every approved finding) are never written, so the approved-row trigger only
 * fires on a real attempt to change an approved finding.
 */
export async function saveEngagement(db: Executor, loaded: LoadedEngagement): Promise<void> {
  const e = loaded.engagement;
  const now = new Date().toISOString();
  const res = await db
    .updateTable('engagements')
    .set({ stage: e.stage, version: loaded.version + 1, updated_at: now })
    .where('id', '=', e.id)
    .where('version', '=', loaded.version)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) !== 1) {
    throw new AppError(409, `Engagement ${e.id} was changed by someone else; reload and try again`, 'VERSION_CONFLICT');
  }
  await db
    .updateTable('engagement_work')
    .set({
      scope: json(e.scope), rcm: json(e.rcm), test_inputs: json(e.testInputs),
      test_results: json(e.testResults), report: e.report ? json(e.report) : null,
    })
    .where('engagement_id', '=', e.id)
    .execute();

  const live = new Set<string>();
  for (const f of e.findings) {
    live.add(f.id);
    const before = loaded.findingSnapshots.get(f.id);
    if (before === undefined) {
      await insertFinding(db, e.id, f);
    } else if (before !== canonicalJson(f)) {
      await db
        .updateTable('findings')
        .set({ status: f.status, rating: f.rating, data: json(f), updated_at: now })
        .where('engagement_id', '=', e.id)
        .where('id', '=', f.id)
        .execute();
    }
  }
  for (const id of loaded.findingSnapshots.keys()) {
    if (!live.has(id)) {
      await db.updateTable('findings').set({ superseded_at: now }).where('engagement_id', '=', e.id).where('id', '=', id).execute();
    }
  }
  e.version = loaded.version + 1;
}

export async function listEngagements(db: Executor): Promise<EngagementSummary[]> {
  const rows = await db
    .selectFrom('engagements as e')
    .innerJoin('engagement_work as w', 'w.engagement_id', 'e.id')
    .select((eb) => [
      'e.id', 'e.name', 'e.entity', 'e.site', 'e.audit_type', 'e.pack_ids', 'e.stage', 'e.created_at', 'e.version',
      sql<number>`jsonb_array_length(w.rcm)`.as('rcm_count'),
      eb
        .selectFrom('findings as f')
        .select((sub) => sub.fn.countAll<number>().as('n'))
        .whereRef('f.engagement_id', '=', 'e.id')
        .where('f.superseded_at', 'is', null)
        .as('finding_count'),
    ])
    .orderBy('e.created_at')
    .orderBy('e.id')
    .execute();
  return rows.map((r) => ({
    id: r.id, name: r.name, entity: r.entity, site: r.site, auditType: r.audit_type, packIds: r.pack_ids,
    stage: r.stage, createdAt: iso(r.created_at), findings: Number(r.finding_count ?? 0), rcm: Number(r.rcm_count), version: r.version,
  }));
}
```

- [ ] **Step 5: Write the eval-run repository** `backend/src/db/eval-repo.ts`

```ts
import type { EvalReport } from '../eval/harness';
import type { Executor } from './trail-repo';

export async function saveEvalRun(db: Executor, r: EvalReport): Promise<void> {
  await db.insertInto('eval_runs').values({ id: r.id, at: r.at, body: JSON.stringify(r) }).execute();
}

export async function listEvalRuns(db: Executor): Promise<Omit<EvalReport, 'cases'>[]> {
  const rows = await db.selectFrom('eval_runs').select('body').orderBy('at', 'desc').execute();
  return rows.map(({ body: { cases: _cases, ...summary } }) => summary);
}

export async function getEvalRun(db: Executor, id: string): Promise<EvalReport | null> {
  const row = await db.selectFrom('eval_runs').select('body').where('id', '=', id).executeTakeFirst();
  return row?.body ?? null;
}

export async function latestEvalRun(db: Executor): Promise<EvalReport | null> {
  const row = await db.selectFrom('eval_runs').select('body').orderBy('at', 'desc').limit(1).executeTakeFirst();
  return row?.body ?? null;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/engagement-repo.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `cd backend && npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add backend/src/errors.ts backend/src/service.ts backend/src/db/engagement-repo.ts backend/src/db/eval-repo.ts backend/tests/engagement-repo.test.ts
git commit -m "Add engagement and eval-run repositories with optimistic locking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Async `AuditService` on Postgres, engine tests ported

This is the core change. Engine logic, role checks, error messages and trail content stay the same. Only *where state lives* and *when it commits* change.

**Files:**
- Rewrite: `backend/src/service.ts`
- Rewrite: `backend/tests/helpers.ts`, `backend/tests/engine.test.ts`
- Modify: `backend/src/eval/harness.ts` (uses PGlite; one shared service per run)
- Rewrite: `backend/src/app.ts` (async routes, `If-Match`, error codes)
- Create: `backend/src/config.ts`
- Rewrite: `backend/src/server.ts`; Modify: `backend/src/seed.ts`
- Rewrite: `backend/tests/api.test.ts`
- Delete: `backend/src/store.ts`

**Interfaces:**
- Consumes:
  - `Db` (Task 1)
  - `appendTrail`, `readTrail`, `UnsealedBundle` (Task 2)
  - `insertEngagement`, `loadEngagement`, `saveEngagement`, `listEngagements`, the eval repo, `AppError` (Task 3)
  - `createMemoryDb` (Task 1)
- Produces (Task 5 relies on these exact signatures):
  - `new AuditService(db: Db, registry: PackRegistry, llm: LlmProvider | null)`
  - `interface MutationOptions { expectedVersion?: number }`
  - `engagement(id: string): Promise<Engagement>`
  - `listEngagements(): Promise<EngagementSummary[]>`
  - `createEngagement(input: NewEngagement, actor: User): Promise<Engagement>`
  - `runModule(id: string, moduleId: string, actor: User, input?: Record<string, unknown>, opts?: MutationOptions): Promise<{ bundle: TrailBundle; engagement: Engagement }>`
  - `setScope(id, items, actor, opts?): Promise<Engagement>`
  - `recordTest(id, rowId, input, actor, opts?): Promise<Engagement>`
  - `editFinding(id, findingId, patch, actor, opts?): Promise<Finding>`
  - `signOff(id, findingId, action, comment, actor, opts?): Promise<Finding>`
  - `trailFor(id): Promise<TrailBundle[]>`
  - `verifyTrail(): Promise<ChainVerification>`
  - `findingsCsv(id): Promise<string>`
  - `saveEvalRun(r): Promise<void>`
  - `listEvalRuns()`, `getEvalRun(id)`, `latestEvalRun()`
  - Test helper: `newService(llm?): Promise<AuditService>`
- Unchanged synchronous members: `user(id)`, `modules()`, `providerInfo`, `registry`, `grounding`, `llm`.

- [ ] **Step 1: Rewrite the test helpers** `backend/tests/helpers.ts`

```ts
import type { GenerateRequest, GenerateResult, LlmProvider } from '../src/engine/llm/provider';
import { PackRegistry } from '../src/engine/packs';
import { AuditService, USERS } from '../src/service';
import { testDb } from './db';

export const registry = PackRegistry.loadFromDir();
export const [auditor, reviewer, approver] = USERS;

/** A service on its own fresh database. */
export async function newService(llm: LlmProvider | null = null) {
  return new AuditService(await testDb(), registry, llm);
}

/** A scripted model: returns whatever the handler builds for the request. */
export class FakeProvider implements LlmProvider {
  readonly id = 'fake';
  readonly model = 'fake-1';
  constructor(private handler: (req: GenerateRequest<any>) => unknown) {}
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    return { output: req.schema.parse(this.handler(req)), servedModel: this.model };
  }
}

export const NEW_ENGAGEMENT = {
  name: 'Test audit', entity: 'Demo Foods', site: 'Plant 1', periodFrom: '2026-01-01', periodTo: '2026-06-30',
  auditType: 'Food safety', scopeStatement: 'HACCP CCP monitoring, supplier approval, traceability and allergen controls', packIds: ['food', 'common'],
};

export async function engagementWithFailedControl(svc: AuditService, controlId = 'FD-HACCP-03', evidenceRefs = ['CCP-LOG-MAR']) {
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  await svc.runModule(e.id, 'scope', auditor);
  await svc.setScope(e.id, [{ controlId, included: true }], auditor);
  await svc.runModule(e.id, 'rcm', auditor);
  await svc.recordTest(e.id, controlId, { designAdequate: true, observation: '3 of 20 CCP logs unsigned.', evidenceRefs, sampleTested: 20, exceptions: 3 }, auditor);
  await svc.runModule(e.id, 'testing', auditor);
  await svc.runModule(e.id, 'gaps', auditor);
  return svc.engagement(e.id);
}
```

- [ ] **Step 2: Port the engine tests** by replacing `backend/tests/engine.test.ts`. Every assertion from the old suite is kept. Calls are awaited, synchronous `toThrow` becomes `rejects.toThrow`, the tamper test reads the trail from the database, and three new tests are added at the end.

```ts
import { describe, expect, it } from 'vitest';
import { PackRegistry } from '../src/engine/packs';
import { verifyChain } from '../src/engine/trail';
import type { ContentPack } from '../src/engine/types';
import { auditor, approver, engagementWithFailedControl, FakeProvider, newService, registry, reviewer } from './helpers';

const META = { name: 'x', entity: 'x', site: 'x', periodFrom: 'a', periodTo: 'b', auditType: 'x', packIds: ['common'] };

describe('content packs', () => {
  it('loads all packs with valid cross-references [REQ-12]', () => {
    expect(registry.list().map((p) => p.id).sort()).toEqual(['common', 'food', 'pharma']);
    for (const c of registry.controls.values()) expect(c.clauseRefs.every((r) => registry.clauses.has(r))).toBe(true);
  });

  it('rejects a pack whose control cites an unknown clause [REQ-12]', () => {
    const bad = JSON.parse(JSON.stringify(registry.get('common'))) as ContentPack;
    bad.controls[0].clauseRefs = ['NOPE-1'];
    expect(() => new PackRegistry([bad])).toThrow(/unknown clause NOPE-1/);
  });
});

describe('module chain', () => {
  it('enforces chain order [REQ-11]', async () => {
    const svc = await newService();
    const e = await svc.createEngagement({ ...META, scopeStatement: 'hedging limits' }, auditor);
    await expect(svc.runModule(e.id, 'rcm', auditor)).rejects.toThrow(/Risk & Scope/);
    await expect(svc.runModule(e.id, 'testing', auditor)).rejects.toThrow(/field work/);
  });

  it('scope ranks treasury controls for a hedging scope', async () => {
    const svc = await newService();
    const e = await svc.createEngagement({ ...META, auditType: 'Treasury', scopeStatement: 'Commodity hedging: positions against limits, trade confirmations and hedge documentation' }, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    const included = (await svc.engagement(e.id)).scope.filter((s) => s.included).map((s) => s.controlId);
    expect(included).toEqual(expect.arrayContaining(['CMN-TRS-02', 'CMN-TRS-03', 'CMN-TRS-04']));
  });

  it('every RCM row carries verified citations [REQ-01]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    expect(e.rcm.length).toBeGreaterThan(0);
    for (const row of e.rcm) {
      expect(row.citations.length).toBeGreaterThan(0);
      expect(row.citations.every((c) => registry.clauses.has(c.clauseId))).toBe(true);
    }
    const rcmRun = (await svc.trailFor(e.id)).find((b) => b.moduleId === 'rcm')!;
    expect(rcmRun.qaActions.every((a) => a.gate === 'citation' && a.outcome === 'pass')).toBe(true);
  });
});

describe('QA gates', () => {
  it('overrides an Effective conclusion when exceptions exist [REQ-04]', async () => {
    const lying = new FakeProvider((req) =>
      req.system && req.user.includes('Conclude on each control test')
        ? { results: [{ rowId: 'FD-HACCP-03', conclusion: 'Effective', rationale: 'Looks fine.' }] }
        : JSON.parse('{"items":[],"rows":[],"findings":[],"executiveSummary":"x"}'),
    );
    const svc = await newService(lying);
    const e = await engagementWithFailedControl(svc);
    expect(e.testResults['FD-HACCP-03'].conclusion).toBe('Ineffective');
    const run = (await svc.trailFor(e.id)).find((b) => b.moduleId === 'testing')!;
    expect(run.qaActions).toContainEqual(expect.objectContaining({ gate: 'evidence', outcome: 'fail', action: 'downgraded' }));
  });

  it('downgrades Effective without evidence to Not tested [REQ-05]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    await svc.recordTest(e.id, 'FD-HACCP-03', { designAdequate: true, observation: 'All logs signed.', evidenceRefs: [], sampleTested: 20, exceptions: 0 }, auditor);
    await svc.runModule(e.id, 'testing', auditor);
    expect((await svc.engagement(e.id)).testResults['FD-HACCP-03'].conclusion).toBe('Not tested');
  });

  it('blocks a finding without an evidence reference [REQ-02]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc, 'FD-HACCP-03', []);
    const f = e.findings[0];
    expect(f.status).toBe('blocked');
    expect(f.blockedReasons.join()).toMatch(/evidence/);
    await expect(svc.signOff(e.id, f.id, 'review', '', reviewer)).rejects.toThrow(/blocked/);
  });

  it('releases a finding with clause, control and evidence citations [REQ-02]', async () => {
    const e = await engagementWithFailedControl(await newService());
    const f = e.findings[0];
    expect(f.status).toBe('draft');
    expect(f.citations.map((c) => c.clauseId)).toContain('21CFR117.145');
    expect(f.controlId).toBe('FD-HACCP-03');
    expect(f.evidenceRefs).toEqual(['CCP-LOG-MAR']);
  });

  it('blocks a model-drafted finding that cites a clause outside its grounding set [REQ-03]', async () => {
    const llm = new FakeProvider((req) => {
      if (req.user.includes('Draft one audit finding')) {
        return { findings: [{ rowId: 'FD-HACCP-03', title: 't', rating: 'High', condition: 'c', criteria: '§211.192', cause: 'c', effect: 'e', recommendation: 'r', clauseIds: ['21CFR211.192'] }] };
      }
      if (req.user.includes('Conclude on each')) return { results: [] };
      if (req.user.includes('Tailor these')) return { rows: [] };
      return { items: [] };
    });
    const e = await engagementWithFailedControl(await newService(llm));
    expect(e.findings[0].status).toBe('blocked');
    expect(e.findings[0].blockedReasons.join()).toMatch(/outside the grounding set/);
  });

  it('rejects model-proposed controls not in the library [REQ-14]', async () => {
    const llm = new FakeProvider((req) => (req.user.includes('Candidate controls') ? { items: [{ controlId: 'MADE-UP-1', included: true, rationale: 'x' }] } : { rows: [], results: [], findings: [] }));
    const svc = await newService(llm);
    const e = await svc.createEngagement({ ...META, scopeStatement: 'hedging' }, auditor);
    const { bundle } = await svc.runModule(e.id, 'scope', auditor);
    expect((await svc.engagement(e.id)).scope.some((s) => s.controlId === 'MADE-UP-1')).toBe(false);
    expect(bundle.qaActions).toContainEqual(expect.objectContaining({ gate: 'library-only', outcome: 'fail' }));
    expect(bundle.provider).toEqual({ id: 'fake', model: 'fake-1' });
    expect(bundle.promptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('falls back to deterministic rules with a QA flag when the model fails [REQ-14]', async () => {
    const broken = { id: 'broken', model: 'b', generate: async () => { throw new Error('upstream 529'); } };
    const svc = await newService(broken);
    const e = await svc.createEngagement({ ...META, scopeStatement: 'hedging limits' }, auditor);
    const { bundle } = await svc.runModule(e.id, 'scope', auditor);
    expect((await svc.engagement(e.id)).scope.length).toBeGreaterThan(0);
    expect(bundle.qaActions).toContainEqual(expect.objectContaining({ gate: 'model-availability', outcome: 'warn' }));
  });
});

describe('sign-off and release', () => {
  it('requires review then approval by a different person, with signature manifestation [REQ-08, REQ-15]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await expect(svc.signOff(e.id, f.id, 'approve', '', approver)).rejects.toThrow(/reviewed before/);
    await expect(svc.signOff(e.id, f.id, 'review', '', auditor)).rejects.toThrow(/may not/);
    await svc.signOff(e.id, f.id, 'review', 'ok', reviewer);
    await expect(svc.signOff(e.id, f.id, 'approve', '', reviewer)).rejects.toThrow(/may not/);
    const done = await svc.signOff(e.id, f.id, 'approve', 'agreed', approver);
    expect(done.status).toBe('approved');
    expect(done.signOffs.map((s) => [s.userId, s.role, s.meaning])).toEqual([
      ['reviewer', 'reviewer', 'Reviewed'],
      ['approver', 'approver', 'Approved'],
    ]);
    expect(done.signOffs.every((s) => !Number.isNaN(Date.parse(s.at)))).toBe(true);
  });

  it('locks approved findings against edit and regeneration [REQ-09]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.signOff(e.id, f.id, 'review', '', reviewer);
    await svc.signOff(e.id, f.id, 'approve', '', approver);
    await expect(svc.editFinding(e.id, f.id, { title: 'changed' }, auditor)).rejects.toThrow(/locked/);
    await svc.runModule(e.id, 'gaps', auditor);
    expect((await svc.engagement(e.id)).findings.find((x) => x.id === f.id)?.title).toBe(f.title);
  });

  it('editing a reviewed finding resets it to draft and re-runs the citation gate [REQ-08]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.signOff(e.id, f.id, 'review', '', reviewer);
    const edited = await svc.editFinding(e.id, f.id, { evidenceRefs: [] }, auditor);
    expect(edited.status).toBe('blocked');
    expect(edited.signOffs).toEqual([]);
  });

  it('report includes approved findings only [REQ-10]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.runModule(e.id, 'report', auditor);
    expect((await svc.engagement(e.id)).report!.includedFindingIds).toEqual([]);
    expect((await svc.engagement(e.id)).report!.excludedFindingIds).toEqual([f.id]);
    await svc.signOff(e.id, f.id, 'review', '', reviewer);
    await svc.signOff(e.id, f.id, 'approve', '', approver);
    await svc.runModule(e.id, 'report', auditor);
    const report = (await svc.engagement(e.id)).report!;
    expect(report.includedFindingIds).toEqual([f.id]);
    expect(report.markdown).toContain(f.title);
    expect(report.markdown).toContain('21 CFR Part 117');
  });
});

describe('audit trail', () => {
  it('records a complete bundle for module runs and human actions [REQ-06]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const trail = await svc.trailFor(e.id);
    expect(trail.map((b) => b.moduleId)).toEqual([
      'human:create-engagement', 'scope', 'human:scope-decision', 'rcm', 'human:test-record', 'testing', 'gaps',
    ]);
    const gaps = trail.find((b) => b.moduleId === 'gaps')!;
    expect(gaps.retrievalSet.length).toBeGreaterThan(0);
    expect(gaps.executionLog.length).toBeGreaterThan(0);
    expect(gaps.qaActions.length).toBeGreaterThan(0);
    expect(gaps.packVersions).toEqual({ food: '0.1.0', common: '0.1.0' });
    expect(gaps.provider.id).toBe('offline');
    expect(gaps.actor).toBe('auditor');
    expect(e.findings[0].bundleId).toBe(gaps.id);
  });

  it('detects tampering with any past bundle [REQ-07]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    await svc.signOff(e.id, e.findings[0].id, 'review', '', reviewer);
    await svc.setScope(e.id, e.scope.map((s) => ({ controlId: s.controlId, included: !s.included })), auditor);
    expect((await svc.verifyTrail()).valid).toBe(true);
    const chain = await svc.trailFor(e.id);
    (chain[2].output as any) = { tampered: true };
    const v = verifyChain(chain);
    expect(v.valid).toBe(false);
    expect(v.brokenAt).toBe(3);
  });
});

describe('transactions and concurrency', () => {
  it('rolls back state and trail together when a module is refused', async () => {
    const svc = await newService();
    const e = await svc.createEngagement({ ...META, scopeStatement: 'hedging limits' }, auditor);
    await expect(svc.runModule(e.id, 'testing', auditor)).rejects.toThrow();
    expect((await svc.trailFor(e.id)).map((b) => b.moduleId)).toEqual(['human:create-engagement']);
    expect((await svc.engagement(e.id)).version).toBe(1);
  });

  it('rejects a change made from a stale version and keeps the winner [REQ-21]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const v = e.version!;
    const record = (observation: string) =>
      svc.recordTest(e.id, 'FD-HACCP-03', { designAdequate: true, observation, evidenceRefs: ['X'], sampleTested: 20, exceptions: 1 }, auditor, { expectedVersion: v });
    const results = await Promise.allSettled([record('first'), record('second')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect((await svc.engagement(e.id)).version).toBe(v + 1);
    expect((await svc.verifyTrail()).valid).toBe(true);
  });

  it('serialises concurrent changes without a version check, losing nothing', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const v = e.version!;
    const before = (await svc.trailFor(e.id)).length;
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        svc.recordTest(e.id, 'FD-HACCP-03', { designAdequate: true, observation: `pass ${n}`, evidenceRefs: ['X'], sampleTested: 20, exceptions: 0 }, auditor),
      ),
    );
    const after = await svc.engagement(e.id);
    expect(after.version).toBe(v + 5);
    const trail = await svc.trailFor(e.id);
    expect(trail).toHaveLength(before + 5);
    const last = trail.at(-1)!.inputs as { observation: string };
    expect(after.testInputs['FD-HACCP-03'].observation).toBe(last.observation);
    expect((await svc.verifyTrail()).valid).toBe(true);
  });
});
```

- [ ] **Step 3: Run the engine tests to verify they fail**

Run: `cd backend && npx vitest run tests/engine.test.ts`
Expected: FAIL. `newService` now returns a Promise and the service still uses `Store`, so the tests fail on `svc.createEngagement is not a function`, unawaited sync results, or `svc.db` missing.

- [ ] **Step 4: Rewrite the service** `backend/src/service.ts`

```ts
import crypto from 'node:crypto';
import type { Db } from './db';
import {
  insertEngagement, listEngagements, loadEngagement, saveEngagement, type EngagementSummary,
} from './db/engagement-repo';
import { getEvalRun, latestEvalRun, listEvalRuns, saveEvalRun } from './db/eval-repo';
import { appendTrail, readTrail, type UnsealedBundle } from './db/trail-repo';
import { Bm25Index, clauseText, controlText } from './engine/grounding';
import type { LlmProvider } from './engine/llm/provider';
import { OFFLINE } from './engine/llm/router';
import { ModuleContext, type Grounding } from './engine/module';
import { getModule, MODULES } from './engine/modules';
import type { PackRegistry } from './engine/packs';
import { findingCitationGate } from './engine/qa';
import { verifyChain } from './engine/trail';
import type { Engagement, Finding, QaAction, SignOff, TestInput, TrailBundle, User } from './engine/types';
import { AppError } from './errors';
import type { EvalReport } from './eval/harness';

export { AppError } from './errors';

export const ENGINE_VERSION = '0.1.0';

export const USERS: User[] = [
  { id: 'auditor', name: 'Asha Auditor', role: 'auditor' },
  { id: 'reviewer', name: 'Ravi Reviewer', role: 'reviewer' },
  { id: 'approver', name: 'Priya QA Head', role: 'approver' },
];

export interface NewEngagement {
  name: string;
  entity: string;
  site: string;
  periodFrom: string;
  periodTo: string;
  auditType: string;
  scopeStatement: string;
  packIds: string[];
}

/** Optional optimistic-concurrency check: the engagement version the caller last saw. */
export interface MutationOptions {
  expectedVersion?: number;
}

type Emit = (bundle: UnsealedBundle) => void;

const PREPARERS = ['auditor', 'reviewer'];

export class AuditService {
  readonly grounding: Grounding;

  constructor(readonly db: Db, readonly registry: PackRegistry, readonly llm: LlmProvider | null) {
    this.grounding = {
      clauses: new Bm25Index([...registry.clauses.values()].map((c) => ({ id: c.id, text: clauseText(c) }))),
      controls: new Bm25Index([...registry.controls.values()].map((c) => ({ id: c.id, text: controlText(c) }))),
    };
  }

  get providerInfo() {
    return this.llm ? { id: this.llm.id, model: this.llm.model } : { ...OFFLINE };
  }

  user(id: string | undefined): User {
    const u = USERS.find((x) => x.id === id);
    if (!u) throw new AppError(401, 'Unknown user; send x-user-id header');
    return u;
  }

  private require(user: User, roles: string[], what: string) {
    if (!roles.includes(user.role)) throw new AppError(403, `${user.role} may not ${what}`);
  }

  async engagement(id: string): Promise<Engagement> {
    const loaded = await loadEngagement(this.db.kysely, id);
    if (!loaded) throw new AppError(404, `Engagement ${id} not found`);
    return loaded.engagement;
  }

  listEngagements(): Promise<EngagementSummary[]> {
    return listEngagements(this.db.kysely);
  }

  /**
   * One transaction per change: lock the engagement row, load it, apply `fn`,
   * save it with a version bump, then seal the trail bundles `fn` emitted.
   * Any failure rolls back the state and the trail together.
   */
  private async mutate<T>(
    engagementId: string,
    opts: MutationOptions,
    fn: (e: Engagement, emit: Emit) => Promise<T> | T,
  ): Promise<{ result: T; sealed: TrailBundle[] }> {
    return this.db.kysely.transaction().execute(async (trx) => {
      const loaded = await loadEngagement(trx, engagementId, { forUpdate: true });
      if (!loaded) throw new AppError(404, `Engagement ${engagementId} not found`);
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== loaded.version) {
        throw new AppError(
          409,
          `Engagement ${engagementId} is at version ${loaded.version}, not ${opts.expectedVersion}; reload and try again`,
          'VERSION_CONFLICT',
        );
      }
      const pending: UnsealedBundle[] = [];
      const result = await fn(loaded.engagement, (b) => pending.push(b));
      await saveEngagement(trx, loaded);
      const sealed: TrailBundle[] = [];
      for (const b of pending) sealed.push(await appendTrail(trx, b));
      return { result, sealed };
    });
  }

  async createEngagement(input: NewEngagement, actor: User): Promise<Engagement> {
    this.require(actor, PREPARERS, 'create engagements');
    if (!input.packIds.length) throw new AppError(400, 'Select at least one content pack');
    input.packIds.forEach((id) => {
      if (!this.registry.packs.has(id)) throw new AppError(400, `Unknown pack ${id}`);
    });
    const e: Engagement = {
      id: `ENG-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      ...input,
      createdBy: actor.id,
      createdAt: new Date().toISOString(),
      stage: 'planning',
      scope: [],
      rcm: [],
      testInputs: {},
      testResults: {},
      findings: [],
      report: null,
    };
    await this.db.kysely.transaction().execute(async (trx) => {
      await insertEngagement(trx, e);
      await appendTrail(trx, this.humanBundle(e, 'human:create-engagement', actor, input, { id: e.id }));
    });
    return e;
  }

  // ---------- Module orchestration ----------

  async runModule(engagementId: string, moduleId: string, actor: User, input: Record<string, unknown> = {}, opts: MutationOptions = {}) {
    this.require(actor, PREPARERS, 'run modules');
    const mod = (() => {
      try {
        return getModule(moduleId);
      } catch {
        throw new AppError(404, `Unknown module ${moduleId}`);
      }
    })();

    const { result: engagement, sealed } = await this.mutate(engagementId, opts, async (e, emit) => {
      const blocker = mod.precondition(e);
      if (blocker) throw new AppError(409, blocker);

      const startedAt = new Date().toISOString();
      const ctx = new ModuleContext(e, this.registry, this.grounding, this.llm, actor, input);
      ctx.step('start', `${mod.name} v${mod.version} on ${e.id}`);
      const output = await mod.run(ctx);
      ctx.step('end', `${ctx.qa.filter((q) => q.outcome === 'fail').length} gate failure(s), ${ctx.qa.filter((q) => q.outcome === 'warn').length} warning(s)`);

      const bundle: UnsealedBundle = {
        id: `RUN-${crypto.randomBytes(4).toString('hex')}`,
        engagementId: e.id,
        moduleId: mod.id,
        moduleVersion: mod.version,
        engineVersion: ENGINE_VERSION,
        packVersions: this.registry.versions(e.packIds),
        provider: this.llm ? { id: this.llm.id, model: ctx.servedModel ?? this.llm.model } : { ...OFFLINE },
        promptHash: ctx.promptHash,
        actor: actor.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        inputs: { moduleInput: input, stage: e.stage },
        retrievalSet: ctx.retrievalSet,
        executionLog: ctx.log,
        qaActions: ctx.qa,
        output,
      };
      emit(bundle);
      mod.apply(e, output, bundle.id);
      return e;
    });
    return { bundle: sealed[0], engagement };
  }

  // ---------- Human steps (also written to the trail) ----------

  async setScope(engagementId: string, items: { controlId: string; included: boolean }[], actor: User, opts: MutationOptions = {}) {
    this.require(actor, PREPARERS, 'change scope');
    const { result } = await this.mutate(engagementId, opts, (e, emit) => {
      for (const it of items) {
        const s = e.scope.find((x) => x.controlId === it.controlId);
        if (!s) throw new AppError(400, `Control ${it.controlId} is not a scope candidate`);
        s.included = it.included;
      }
      emit(this.humanBundle(e, 'human:scope-decision', actor, items, { included: e.scope.filter((s) => s.included).map((s) => s.controlId) }));
      return e;
    });
    return result;
  }

  async recordTest(engagementId: string, rowId: string, input: Omit<TestInput, 'updatedBy' | 'updatedAt'>, actor: User, opts: MutationOptions = {}) {
    this.require(actor, PREPARERS, 'record test work');
    if (input.exceptions > input.sampleTested) throw new AppError(400, 'Exceptions cannot exceed the sample tested');
    const { result } = await this.mutate(engagementId, opts, (e, emit) => {
      if (!e.rcm.some((r) => r.id === rowId)) throw new AppError(404, `RCM row ${rowId} not found`);
      const record: TestInput = { ...input, updatedBy: actor.id, updatedAt: new Date().toISOString() };
      e.testInputs[rowId] = record;
      delete e.testResults[rowId];
      emit(this.humanBundle(e, 'human:test-record', actor, { rowId, ...input }, record));
      return e;
    });
    return result;
  }

  async editFinding(
    engagementId: string,
    findingId: string,
    patch: Partial<Pick<Finding, 'title' | 'rating' | 'condition' | 'criteria' | 'cause' | 'effect' | 'recommendation' | 'evidenceRefs'>>,
    actor: User,
    opts: MutationOptions = {},
  ) {
    this.require(actor, PREPARERS, 'edit findings');
    const { result } = await this.mutate(engagementId, opts, (e, emit) => {
      const idx = e.findings.findIndex((f) => f.id === findingId);
      if (idx < 0) throw new AppError(404, `Finding ${findingId} not found`);
      if (e.findings[idx].status === 'approved') throw new AppError(409, 'Approved findings are locked', 'FINDING_LOCKED');

      const allowed = new Set(this.registry.clausesFor(e.packIds).map((c) => c.id));
      const edited: Finding = { ...e.findings[idx], ...patch, status: 'draft', signOffs: [] };
      const { finding, actions } = findingCitationGate(this.registry, edited, allowed);
      e.findings[idx] = finding;
      emit(this.humanBundle(e, 'human:finding-edit', actor, { findingId, patch }, { status: finding.status }, actions));
      return finding;
    });
    return result;
  }

  async signOff(engagementId: string, findingId: string, action: 'review' | 'approve' | 'reject', comment: string, actor: User, opts: MutationOptions = {}) {
    const { result } = await this.mutate(engagementId, opts, (e, emit) => {
      const f = e.findings.find((x) => x.id === findingId);
      if (!f) throw new AppError(404, `Finding ${findingId} not found`);
      if (f.status === 'blocked') throw new AppError(409, `Finding is blocked by QA gates: ${f.blockedReasons.join('; ')}`, 'FINDING_BLOCKED');

      let meaning: SignOff['meaning'];
      if (action === 'review') {
        this.require(actor, ['reviewer'], 'review findings');
        if (f.status !== 'draft') throw new AppError(409, `Only draft findings can be reviewed (status ${f.status})`);
        f.status = 'reviewed';
        meaning = 'Reviewed';
      } else {
        this.require(actor, ['approver'], `${action} findings`);
        if (f.status !== 'reviewed') throw new AppError(409, 'Finding must be reviewed before approval or rejection');
        if (f.signOffs.some((s) => s.userId === actor.id)) throw new AppError(409, 'Approver must differ from reviewer');
        f.status = action === 'approve' ? 'approved' : 'rejected';
        meaning = action === 'approve' ? 'Approved' : 'Rejected';
      }
      // Signature manifestation: who, in what role, what it means, and when.
      const sig: SignOff = { userId: actor.id, userName: actor.name, role: actor.role, meaning, comment, at: new Date().toISOString() };
      f.signOffs.push(sig);
      emit(this.humanBundle(e, 'human:sign-off', actor, { findingId, action, comment }, sig));
      return f;
    });
    return result;
  }

  // ---------- Trail ----------

  private humanBundle(e: Engagement, moduleId: string, actor: User, inputs: unknown, output: unknown, qaActions: QaAction[] = []): UnsealedBundle {
    const now = new Date().toISOString();
    return {
      id: `HUM-${crypto.randomBytes(4).toString('hex')}`,
      engagementId: e.id,
      moduleId,
      moduleVersion: ENGINE_VERSION,
      engineVersion: ENGINE_VERSION,
      packVersions: this.registry.versions(e.packIds),
      provider: { id: 'human', model: actor.id },
      promptHash: null,
      actor: actor.id,
      startedAt: now,
      finishedAt: now,
      inputs,
      retrievalSet: [],
      executionLog: [{ at: now, step: moduleId, detail: `${actor.name} (${actor.role})` }],
      qaActions,
      output,
    };
  }

  trailFor(engagementId: string): Promise<TrailBundle[]> {
    return readTrail(this.db.kysely, engagementId);
  }

  async verifyTrail() {
    return verifyChain(await readTrail(this.db.kysely));
  }

  modules() {
    return MODULES.map((m) => ({ id: m.id, name: m.name, version: m.version, description: m.description }));
  }

  // ---------- Evaluation runs ----------

  saveEvalRun(r: EvalReport) {
    return saveEvalRun(this.db.kysely, r);
  }
  listEvalRuns() {
    return listEvalRuns(this.db.kysely);
  }
  getEvalRun(id: string) {
    return getEvalRun(this.db.kysely, id);
  }
  latestEvalRun() {
    return latestEvalRun(this.db.kysely);
  }

  /** Flat export for write-back into the client's QMS / GRC system of record. */
  async findingsCsv(engagementId: string): Promise<string> {
    const e = await this.engagement(engagementId);
    const cols = ['id', 'status', 'rating', 'controlId', 'title', 'condition', 'criteria', 'cause', 'effect', 'recommendation', 'citations', 'evidenceRefs', 'approvedBy', 'bundleId'];
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = e.findings.map((f) =>
      [
        f.id, f.status, f.rating, f.controlId, f.title, f.condition, f.criteria, f.cause, f.effect, f.recommendation,
        f.citations.map((c) => `${c.regulation} ${c.ref}`).join('; '),
        f.evidenceRefs.join('; '),
        f.signOffs.filter((s) => s.meaning === 'Approved').map((s) => `${s.userName} ${s.at}`).join('; '),
        f.bundleId,
      ].map((v) => esc(String(v))).join(','),
    );
    return [cols.join(','), ...rows].join('\n');
  }
}
```

Three changes are intended in the rewrite:
- `recordTest` now checks `exceptions > sampleTested` *before* loading, so a bad request never takes the row lock.
- `editFinding` on an approved finding returns code `FINDING_LOCKED`.
- `signOff` on a blocked finding returns code `FINDING_BLOCKED`.

Messages and statuses are unchanged.

- [ ] **Step 5: Point the eval harness at an in-process database.** In `backend/src/eval/harness.ts`:

Replace the imports of `Store` and `USERS`:

```ts
import { createMemoryDb } from '../db/pglite';
import type { LlmProvider } from '../engine/llm/provider';
import type { PackRegistry } from '../engine/packs';
import type { ContentPack, EvalCase } from '../engine/types';
import { AuditService, ENGINE_VERSION, USERS } from '../service';
```

Replace `runFieldCase` with:

```ts
async function runFieldCase(svc: AuditService, registry: PackRegistry, input: TestCaseInput, withGaps: boolean) {
  const [auditor] = USERS;
  const control = registry.controls.get(input.controlId);
  if (!control) throw new Error(`Eval case references unknown control ${input.controlId}`);
  const e = await svc.createEngagement(
    { name: 'eval', entity: 'eval', site: 'eval', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 'eval', scopeStatement: control.title, packIds: [control.packId] },
    auditor,
  );
  await svc.runModule(e.id, 'scope', auditor);
  const scoped = await svc.engagement(e.id);
  await svc.setScope(e.id, scoped.scope.map((s) => ({ controlId: s.controlId, included: s.controlId === input.controlId })), auditor);
  await svc.runModule(e.id, 'rcm', auditor);
  await svc.recordTest(e.id, input.controlId, { designAdequate: input.designAdequate, observation: input.observation, evidenceRefs: input.evidenceRefs, sampleTested: input.sampleTested, exceptions: input.exceptions }, auditor);
  await svc.runModule(e.id, 'testing', auditor);
  if (withGaps) await svc.runModule(e.id, 'gaps', auditor);
  return svc.engagement(e.id);
}
```

In `runCase`, change the signature and the call:

```ts
async function runCase(registry: PackRegistry, svc: AuditService, pack: ContentPack, c: EvalCase): Promise<EvalCaseResult> {
```

Inside it:
- replace `svcForSearch.grounding` with `svc.grounding`
- replace `const e = await runFieldCase(registry, llm, pack, input, c.kind === 'gaps');` with `const e = await runFieldCase(svc, registry, input, c.kind === 'gaps');`

Replace the first lines of `runEval`, up to and including the `for` loop:

```ts
export async function runEval(registry: PackRegistry, llm: LlmProvider | null, packIds?: string[]): Promise<EvalReport> {
  // A throwaway in-process database: eval never touches operational data or the trail.
  const db = await createMemoryDb();
  try {
    const svc = new AuditService(db, registry, llm);
    const packs = registry.list().filter((p) => !packIds || packIds.includes(p.id));
    const cases: EvalCaseResult[] = [];
    for (const pack of packs) {
      for (const c of pack.evalCases) cases.push(await runCase(registry, svc, pack, c));
    }
```

Then wrap the rest of the existing body (the `byKind` loop and the `return { … }`) inside that `try`, and close it with:

```ts
  } finally {
    await db.close();
  }
}
```

The old `runFieldCase` reused the engagement object, which the in-memory store mutated in place. The new code reloads with `await svc.engagement(e.id)` before `setScope`. That reload is required.

- [ ] **Step 6: Add configuration loading** `backend/src/config.ts`

```ts
import path from 'node:path';
import { z } from 'zod';

// Configuration comes from the environment only, validated once at start-up.
// Plan 1F extends this schema (identity, storage, security settings).

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL'),
  PACKS_DIR: z.string().min(1).optional(),
});

export interface Config {
  port: number;
  databaseUrl: string;
  packsDir?: string;
}

/** Loads backend/.env for local development. Never used in production. */
export function loadDotEnv(file = path.resolve(__dirname, '../.env')) {
  if (process.env.NODE_ENV === 'production') return;
  try {
    process.loadEnvFile(file);
  } catch {
    // No .env file: rely on the real environment.
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return { port: parsed.data.PORT, databaseUrl: parsed.data.DATABASE_URL, packsDir: parsed.data.PACKS_DIR };
}
```

- [ ] **Step 7: Rewrite the HTTP layer** `backend/src/app.ts`

```ts
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { evalMarkdown, runEval } from './eval/harness';
import { AppError, AuditService, USERS, type MutationOptions } from './service';
import { buildTraceability } from './validation/traceability';

const NewEngagementSchema = z.object({
  name: z.string().min(1),
  entity: z.string().min(1),
  site: z.string().min(1),
  periodFrom: z.string().min(1),
  periodTo: z.string().min(1),
  auditType: z.string().min(1),
  scopeStatement: z.string().min(1),
  packIds: z.array(z.string()).min(1),
});

const TestInputSchema = z.object({
  designAdequate: z.boolean().nullable(),
  observation: z.string(),
  evidenceRefs: z.array(z.string().min(1)),
  sampleTested: z.number().int().min(0),
  exceptions: z.number().int().min(0),
});

const FindingPatchSchema = z
  .object({
    title: z.string().min(1),
    rating: z.enum(['High', 'Medium', 'Low']),
    condition: z.string().min(1),
    criteria: z.string().min(1),
    cause: z.string().min(1),
    effect: z.string().min(1),
    recommendation: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
  })
  .partial();

export function createApp(svc: AuditService) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  const actor = (req: Request) => svc.user(req.header('x-user-id'));
  const param = (req: Request, name: string) => String(req.params[name]);
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

  /** `If-Match: "<version>"` opts a change into the optimistic-concurrency check. */
  const mutation = (req: Request): MutationOptions => {
    const header = req.header('if-match');
    if (header === undefined) return {};
    const version = Number(header.replace(/^W\//, '').replace(/"/g, ''));
    if (!Number.isInteger(version) || version < 1) throw new AppError(400, 'If-Match must be the engagement version number');
    return { expectedVersion: version };
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true, provider: svc.providerInfo }));
  app.get('/api/users', (_req, res) => res.json(USERS));
  app.get('/api/modules', (_req, res) => res.json(svc.modules()));

  // ----- Content library -----
  app.get('/api/packs', (_req, res) =>
    res.json(svc.registry.list().map(({ clauses, controls, evalCases, ...p }) => ({ ...p, clauseCount: clauses.length, controlCount: controls.length, evalCaseCount: evalCases.length }))),
  );
  app.get('/api/packs/:id', wrap((req, res) => {
    const pack = svc.registry.packs.get(param(req, 'id'));
    if (!pack) throw new AppError(404, 'Pack not found');
    res.json(pack);
  }));
  app.get('/api/search', (req, res) => {
    const q = String(req.query.q ?? '');
    const packIds = req.query.packs ? String(req.query.packs).split(',') : svc.registry.list().map((p) => p.id);
    const allowed = new Set(svc.registry.clausesFor(packIds).map((c) => c.id));
    const hits = svc.grounding.clauses.search(q, 10, (id) => allowed.has(id));
    res.json(hits.map((h) => ({ ...h, clause: svc.registry.clauses.get(h.clauseId) })));
  });

  // ----- Engagements -----
  app.get('/api/engagements', wrap(async (_req, res) => res.json(await svc.listEngagements())));
  app.post('/api/engagements', wrap(async (req, res) => {
    const body = NewEngagementSchema.parse(req.body);
    res.status(201).json(await svc.createEngagement(body, actor(req)));
  }));
  app.get('/api/engagements/:id', wrap(async (req, res) => {
    const e = await svc.engagement(param(req, 'id'));
    res.set('ETag', `"${e.version}"`).json(e);
  }));

  app.post('/api/engagements/:id/modules/:moduleId/run', wrap(async (req, res) => {
    const { bundle, engagement } = await svc.runModule(param(req, 'id'), param(req, 'moduleId'), actor(req), req.body ?? {}, mutation(req));
    res.json({ bundle, engagement });
  }));

  app.put('/api/engagements/:id/scope', wrap(async (req, res) => {
    const items = z.array(z.object({ controlId: z.string(), included: z.boolean() })).parse(req.body.items);
    res.json(await svc.setScope(param(req, 'id'), items, actor(req), mutation(req)));
  }));

  app.put('/api/engagements/:id/tests/:rowId', wrap(async (req, res) => {
    res.json(await svc.recordTest(param(req, 'id'), param(req, 'rowId'), TestInputSchema.parse(req.body), actor(req), mutation(req)));
  }));

  app.put('/api/engagements/:id/findings/:fid', wrap(async (req, res) => {
    res.json(await svc.editFinding(param(req, 'id'), param(req, 'fid'), FindingPatchSchema.parse(req.body), actor(req), mutation(req)));
  }));

  app.post('/api/engagements/:id/findings/:fid/signoff', wrap(async (req, res) => {
    const body = z.object({ action: z.enum(['review', 'approve', 'reject']), comment: z.string().default('') }).parse(req.body);
    res.json(await svc.signOff(param(req, 'id'), param(req, 'fid'), body.action, body.comment, actor(req), mutation(req)));
  }));

  app.get('/api/engagements/:id/report.md', wrap(async (req, res) => {
    const e = await svc.engagement(param(req, 'id'));
    if (!e.report) throw new AppError(404, 'No report generated yet');
    res.type('text/markdown').attachment(`${e.id}-report.md`).send(e.report.markdown);
  }));

  app.get('/api/engagements/:id/findings.csv', wrap(async (req, res) => {
    res.type('text/csv').attachment(`${param(req, 'id')}-findings.csv`).send(await svc.findingsCsv(param(req, 'id')));
  }));

  // ----- Evidence & validation -----
  app.get('/api/engagements/:id/trail', wrap(async (req, res) => res.json(await svc.trailFor(param(req, 'id')))));
  app.get('/api/trail/verify', wrap(async (_req, res) => res.json(await svc.verifyTrail())));

  app.post('/api/eval/run', wrap(async (_req, res) => {
    const report = await runEval(svc.registry, svc.llm);
    await svc.saveEvalRun(report);
    res.json(report);
  }));
  app.get('/api/eval/runs', wrap(async (_req, res) => res.json(await svc.listEvalRuns())));
  app.get('/api/eval/runs/:id', wrap(async (req, res) => {
    const r = await svc.getEvalRun(param(req, 'id'));
    if (!r) throw new AppError(404, 'Eval run not found');
    res.json({ ...r, markdown: evalMarkdown(r) });
  }));
  app.get('/api/validation/traceability', wrap(async (_req, res) => res.json(buildTraceability(await svc.latestEvalRun()))));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION', issues: err.issues });
    console.error(err);
    res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
  });

  return app;
}
```

- [ ] **Step 8: Rewrite the server entry point** `backend/src/server.ts`

```ts
import { createApp } from './app';
import { loadConfig, loadDotEnv } from './config';
import { connectPg } from './db';
import { pendingMigrations } from './db/migrate';
import { createProvider } from './engine/llm/router';
import { PackRegistry } from './engine/packs';
import { AuditService } from './service';

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const db = connectPg(config.databaseUrl);
  const pending = await pendingMigrations(db);
  if (pending.length) {
    await db.close();
    throw new Error(
      `Database has unapplied migrations (${pending.join(', ')}). Run "npm run migrate" ` +
        '(in the container: node dist/db/cli.js migrate) first; the API never migrates on start-up.',
    );
  }
  const registry = PackRegistry.loadFromDir(config.packsDir);
  const svc = new AuditService(db, registry, createProvider());
  createApp(svc).listen(config.port, () => {
    console.log(`Audit platform API on :${config.port} — packs: ${registry.list().map((p) => `${p.id}@${p.version}`).join(', ')} — provider: ${svc.providerInfo.id}/${svc.providerInfo.model}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 9: Move the seed script to Postgres.** In `backend/src/seed.ts`, make these edits. Keep the two `build({...}, [...], n)` calls (all engagement metadata and field rows) exactly as they are.

Replace the imports and the `Field` type line with:

```ts
import { loadConfig, loadDotEnv } from './config';
import { connectPg } from './db';
import { listEngagements } from './db/engagement-repo';
import { createProvider } from './engine/llm/router';
import { PackRegistry } from './engine/packs';
import { AuditService, USERS } from './service';

// Seeds two fictitious demo engagements (food ingredients + pharma) that walk
// the whole chain, so the UI has something to show. Only seeds an empty
// database. Usage: npm run seed

type Field = [controlId: string, designAdequate: boolean, observation: string, evidence: string[], sample: number, exceptions: number];
```

Replace everything from `async function main() {` up to and including the closing `}` of the inner `build` function with:

```ts
async function main() {
  loadDotEnv();
  const db = connectPg(loadConfig().databaseUrl);
  try {
    if ((await listEngagements(db.kysely)).length) {
      throw new Error('Database already has engagements. Seed only an empty database (locally: docker compose down -v, then migrate).');
    }
    const svc = new AuditService(db, PackRegistry.loadFromDir(), createProvider());
    const [auditor, reviewer, approver] = USERS;

    async function build(meta: Parameters<AuditService['createEngagement']>[0], fields: Field[], approveFirst: number) {
      const e = await svc.createEngagement(meta, auditor);
      await svc.runModule(e.id, 'scope', auditor);
      const wanted = new Set(fields.map((f) => f[0]));
      const scoped = await svc.engagement(e.id);
      await svc.setScope(e.id, scoped.scope.map((s) => ({ controlId: s.controlId, included: s.included || wanted.has(s.controlId) })), auditor);
      await svc.runModule(e.id, 'rcm', auditor);
      for (const [id, design, obs, ev, n, x] of fields) {
        await svc.recordTest(e.id, id, { designAdequate: design, observation: obs, evidenceRefs: ev, sampleTested: n, exceptions: x }, auditor);
      }
      await svc.runModule(e.id, 'testing', auditor);
      await svc.runModule(e.id, 'gaps', auditor);
      const ready = (await svc.engagement(e.id)).findings.filter((f) => f.status === 'draft');
      for (const f of ready.slice(0, approveFirst + 1)) await svc.signOff(e.id, f.id, 'review', 'Condition and criteria agreed to workpapers.', reviewer);
      for (const f of ready.slice(0, approveFirst)) await svc.signOff(e.id, f.id, 'approve', 'Agreed with management at exit meeting.', approver);
      await svc.runModule(e.id, 'report', auditor);
      return svc.engagement(e.id);
    }
```

Indent the existing `const food = await build(…)` and `const pharma = await build(…)` blocks by two more spaces, since they now sit inside `try`. Then replace the two closing `console.log` lines and the end of `main` with:

```ts
    console.log(`Seeded ${food.id} (${food.findings.length} findings) and ${pharma.id} (${pharma.findings.length} findings)`);
    console.log('Trail:', await svc.verifyTrail());
  } finally {
    await db.close();
  }
}
```

Leave the final `main().catch(…)` block unchanged.

The old code used `ready.slice(...).forEach(f => svc.signOff(...))`. That cannot stay as `forEach` with async calls, because the sign-offs would race. The sequential `for … of` loops above are required.

- [ ] **Step 10: Port the API tests** by replacing `backend/tests/api.test.ts`

```ts
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { newService } from './helpers';

describe('HTTP API', () => {
  let app: ReturnType<typeof createApp>;
  const as = (user: string) => ({ 'x-user-id': user });

  beforeAll(async () => {
    app = createApp(await newService());
  });

  it('runs a full engagement end to end over HTTP [REQ-06, REQ-15]', async () => {
    expect((await request(app).post('/api/engagements').send({}).set(as('nobody'))).status).toBe(400);

    const created = await request(app).post('/api/engagements').set(as('auditor')).send({
      name: 'Pharma self-inspection', entity: 'Demo Pharma', site: 'OSD plant', periodFrom: '2026-01-01', periodTo: '2026-06-30',
      auditType: 'GMP self-inspection', scopeStatement: 'Data integrity: HPLC audit trails and user access; deviations and CAPA', packIds: ['pharma'],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    expect((await request(app).post(`/api/engagements/${id}/modules/scope/run`).set(as('approver'))).status).toBe(403);
    const scope = await request(app).post(`/api/engagements/${id}/modules/scope/run`).set(as('auditor'));
    expect(scope.status).toBe(200);
    expect(scope.body.engagement.scope.filter((s: any) => s.included).map((s: any) => s.controlId)).toContain('PH-DI-01');

    await request(app).post(`/api/engagements/${id}/modules/rcm/run`).set(as('auditor')).expect(200);
    await request(app).put(`/api/engagements/${id}/tests/PH-DI-01`).set(as('auditor'))
      .send({ designAdequate: true, observation: 'Audit trail review missing for 5 of 20 sequences', evidenceRefs: ['SEQ-Q2'], sampleTested: 20, exceptions: 5 }).expect(200);
    await request(app).post(`/api/engagements/${id}/modules/testing/run`).set(as('auditor')).expect(200);
    const gaps = await request(app).post(`/api/engagements/${id}/modules/gaps/run`).set(as('auditor')).expect(200);
    const fid = gaps.body.engagement.findings[0].id;

    await request(app).post(`/api/engagements/${id}/findings/${fid}/signoff`).set(as('reviewer')).send({ action: 'review' }).expect(200);
    await request(app).post(`/api/engagements/${id}/findings/${fid}/signoff`).set(as('approver')).send({ action: 'approve', comment: 'ok' }).expect(200);
    await request(app).post(`/api/engagements/${id}/modules/report/run`).set(as('auditor')).expect(200);

    const md = await request(app).get(`/api/engagements/${id}/report.md`).expect(200);
    expect(md.text).toContain('§11.10(e)');
    const csv = await request(app).get(`/api/engagements/${id}/findings.csv`).expect(200);
    expect(csv.text.split('\n')).toHaveLength(2);
    expect((await request(app).get('/api/trail/verify')).body.valid).toBe(true);
  });

  it('rejects exceptions greater than the sample', async () => {
    const res = await request(app).get('/api/engagements');
    const id = res.body[0].id;
    const r = await request(app).put(`/api/engagements/${id}/tests/PH-DI-01`).set(as('auditor'))
      .send({ designAdequate: true, observation: '', evidenceRefs: ['x'], sampleTested: 2, exceptions: 3 });
    expect(r.status).toBe(400);
  });

  it('rejects a change sent with a stale If-Match version [REQ-21]', async () => {
    const id = (await request(app).get('/api/engagements')).body[0].id;
    const current = await request(app).get(`/api/engagements/${id}`).expect(200);
    expect(current.headers.etag).toBe(`"${current.body.version}"`);
    const body = { designAdequate: true, observation: 'All sequences reviewed', evidenceRefs: ['SEQ-Q3'], sampleTested: 20, exceptions: 0 };
    const put = () => request(app).put(`/api/engagements/${id}/tests/PH-DI-01`).set(as('auditor'));
    await put().set('If-Match', `"${current.body.version}"`).send(body).expect(200);
    const stale = await put().set('If-Match', `"${current.body.version}"`).send(body);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect((await put().set('If-Match', 'not-a-version').send(body)).status).toBe(400);
  });

  it('runs the evaluation harness over all packs and serves the traceability matrix [REQ-13]', async () => {
    const before = (await request(app).get('/api/trail/verify')).body.length;
    const run = await request(app).post('/api/eval/run').expect(200);
    expect(run.body.passed).toBe(run.body.total);
    expect((await request(app).get('/api/trail/verify')).body.length).toBe(before);
    expect((await request(app).get('/api/eval/runs')).body.map((r: any) => r.id)).toEqual([run.body.id]);
    const tm = await request(app).get('/api/validation/traceability').expect(200);
    const high = tm.body.rows.filter((r: any) => r.risk === 'High');
    expect(high.every((r: any) => r.covered)).toBe(true);
  }, 120_000);
});
```

The eval test also checks that running the eval leaves the operational trail length unchanged.

- [ ] **Step 11: Run the whole suite, eval and typecheck**

Run: `cd backend && npm test && npm run eval && npm run typecheck`
Expected:
- all test files pass: 4 db + 4 trail + 6 repo + 21 engine + 4 api
- eval `25/25`
- typecheck exits 0

- [ ] **Step 12: Commit**

```bash
git add backend/src backend/tests/helpers.ts backend/tests/engine.test.ts backend/tests/api.test.ts
git rm backend/src/store.ts
git commit -m "Run AuditService on Postgres with one transaction per change

Every change locks the engagement row, saves with a version check and
seals its trail bundles in the same transaction. If-Match opts a request
into the version check. Eval runs on an in-process PGlite database so it
never writes to the operational database or its trail.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Operator commands — migrate, import-json, verify — and requirements

**Files:**
- Create: `backend/src/db/import-json.ts`, `backend/src/db/cli.ts`
- Modify: `backend/package.json` (scripts)
- Modify: `backend/validation/requirements.json` (add REQ-20, REQ-21)
- Test: `backend/tests/persistence.test.ts`

**Interfaces:**
- Consumes:
  - `connectPg`, `migrate`, `pendingMigrations` (Task 1)
  - `insertSealed`, `readTrail` (Task 2)
  - `insertEngagement`, `saveEvalRun` (Task 3)
  - `loadConfig`, `loadDotEnv`, `AuditService` (Task 4)
- Produces:
  - `importJson(db: Db, file: string): Promise<{ engagements: number; trail: number; evalRuns: number }>`
  - npm scripts `migrate`, `import-json`, `verify`
  - production commands `node dist/db/cli.js migrate | import-json <file> | verify`

- [ ] **Step 1: Write the failing tests** `backend/tests/persistence.test.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { importJson } from '../src/db/import-json';
import { migrate, pendingMigrations } from '../src/db/migrate';
import { readTrail } from '../src/db/trail-repo';
import { verifyChain } from '../src/engine/trail';
import { AuditService } from '../src/service';
import { emptyDb, testDb } from './db';
import { auditor, engagementWithFailedControl, newService, registry, reviewer } from './helpers';

/** Builds an MVP-format db.json (engagements + trail + evalRuns) from a real run. */
async function mvpExport() {
  const svc = await newService();
  const e = await engagementWithFailedControl(svc);
  await svc.signOff(e.id, e.findings[0].id, 'review', 'ok', reviewer);
  const engagement = await svc.engagement(e.id);
  delete engagement.version; // MVP files have no version field
  const data = { engagements: [engagement], trail: await readTrail(svc.db.kysely), evalRuns: [] };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-')), 'db.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { file, data };
}

describe('import-json', () => {
  it('imports an MVP data file with the original chain intact', async () => {
    const { file, data } = await mvpExport();
    const target = await testDb();
    const counts = await importJson(target, file);
    expect(counts).toEqual({ engagements: 1, trail: data.trail.length, evalRuns: 0 });
    const imported = await readTrail(target.kysely);
    expect(imported.map((b) => b.hash)).toEqual(data.trail.map((b) => b.hash));
    expect(verifyChain(imported).valid).toBe(true);

    // The imported engagement is live: work continues on top of the imported chain.
    const svc = new AuditService(target, registry, null);
    await svc.setScope(data.engagements[0].id, [{ controlId: 'FD-HACCP-03', included: true }], auditor);
    expect((await svc.verifyTrail()).valid).toBe(true);
  });

  it('refuses a tampered file and writes nothing', async () => {
    const { file, data } = await mvpExport();
    (data.trail[1].output as any) = { tampered: true };
    fs.writeFileSync(file, JSON.stringify(data));
    const target = await testDb();
    await expect(importJson(target, file)).rejects.toThrow(/broken at bundle 2/);
    expect(await target.kysely.selectFrom('engagements').select('id').execute()).toEqual([]);
    expect(await readTrail(target.kysely)).toEqual([]);
  });

  it('refuses to import into a database that already has data', async () => {
    const { file } = await mvpExport();
    const target = await testDb();
    await importJson(target, file);
    await expect(importJson(target, file)).rejects.toThrow(/already has/);
  });
});

describe('start-up safety', () => {
  it('refuses to start without a valid DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/postgres:\/\//);
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', PORT: '4000' })).toEqual({ port: 4000, databaseUrl: 'postgres://u:p@h:5432/d', packsDir: undefined });
  });

  it('reports unapplied migrations instead of applying them', async () => {
    const db = await emptyDb();
    expect((await pendingMigrations(db)).length).toBeGreaterThan(0);
    const tables = await db.kysely.introspection.getTables();
    expect(tables).toEqual([]);
    await migrate(db);
    expect(await pendingMigrations(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/persistence.test.ts`
Expected: FAIL with `Cannot find module '../src/db/import-json'`.

- [ ] **Step 3: Write the importer** `backend/src/db/import-json.ts`

```ts
import fs from 'node:fs';
import { verifyChain } from '../engine/trail';
import type { Engagement, TrailBundle } from '../engine/types';
import type { EvalReport } from '../eval/harness';
import { insertEngagement } from './engagement-repo';
import { saveEvalRun } from './eval-repo';
import type { Db } from './index';
import { insertSealed, readTrail } from './trail-repo';

interface MvpData {
  engagements?: Engagement[];
  trail?: TrailBundle[];
  evalRuns?: EvalReport[];
}

/**
 * One-off migration of an MVP data/db.json into an empty database. The source
 * chain is verified first and imported with its original seq and hashes, so
 * the evidence stays provably unaltered. All or nothing.
 */
export async function importJson(db: Db, file: string) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as MvpData;
  const trail = data.trail ?? [];
  const engagements = data.engagements ?? [];
  const evalRuns = data.evalRuns ?? [];

  const source = verifyChain(trail);
  if (!source.valid) {
    throw new Error(`Refusing to import: the source trail is broken at bundle ${source.brokenAt} (${source.reason})`);
  }

  await db.kysely.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('engagements').select('id').limit(1).execute();
    const existingTrail = await trx.selectFrom('trail').select('seq').limit(1).execute();
    if (existing.length || existingTrail.length) {
      throw new Error('Refusing to import: the target database already has engagements or trail entries');
    }
    for (const e of engagements) await insertEngagement(trx, e);
    for (const b of trail) await insertSealed(trx, b);
    for (const r of evalRuns) await saveEvalRun(trx, r);
  });

  const imported = verifyChain(await readTrail(db.kysely));
  if (!imported.valid) throw new Error(`Imported trail failed verification: ${imported.reason}`);
  return { engagements: engagements.length, trail: trail.length, evalRuns: evalRuns.length };
}
```

- [ ] **Step 4: Write the operator CLI** `backend/src/db/cli.ts`

```ts
import { loadConfig, loadDotEnv } from '../config';
import { verifyChain } from '../engine/trail';
import { importJson } from './import-json';
import { connectPg } from './index';
import { migrate } from './migrate';
import { readTrail } from './trail-repo';

// Operator commands. In the container: node dist/db/cli.js <command>
//   migrate              apply pending SQL migrations
//   import-json <file>   import an MVP data/db.json into an empty database
//   verify               recompute the audit-trail hash chain (exit 1 if broken)

const USAGE = 'Usage: cli <migrate | import-json <file> | verify>';

async function main() {
  loadDotEnv();
  const [command, arg] = process.argv.slice(2);
  if (!['migrate', 'import-json', 'verify'].includes(command)) throw new Error(USAGE);
  const db = connectPg(loadConfig().databaseUrl, { max: 2 });
  try {
    if (command === 'migrate') {
      const applied = await migrate(db);
      console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Database is up to date');
    } else if (command === 'import-json') {
      if (!arg) throw new Error(USAGE);
      const counts = await importJson(db, arg);
      console.log(`Imported ${counts.engagements} engagement(s), ${counts.trail} trail bundle(s), ${counts.evalRuns} eval run(s); chain verified`);
    } else {
      const result = verifyChain(await readTrail(db.kysely));
      console.log(JSON.stringify(result));
      if (!result.valid) process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Add the npm scripts.** In `backend/package.json` `"scripts"`, add after `"seed"`:

```json
    "migrate": "tsx src/db/cli.ts migrate",
    "import-json": "tsx src/db/cli.ts import-json",
    "verify": "tsx src/db/cli.ts verify",
```

- [ ] **Step 6: Register the two new requirements.** In `backend/validation/requirements.json`, add before the closing `]` (with a comma after the REQ-15 line):

```json
  { "id": "REQ-20", "risk": "High", "text": "Trail records cannot be updated, deleted or truncated, and approved findings cannot be changed, at the database level (21 CFR Part 11 §11.10(e), ALCOA+).", "evalKinds": [] },
  { "id": "REQ-21", "risk": "High", "text": "Concurrent conflicting edits are rejected, never silently overwritten; state and its trail entries commit or roll back together.", "evalKinds": [] }
```

REQ-20 is covered by the `[REQ-20]` tests in `db.test.ts`; REQ-21 by the `[REQ-21]` tests in `engagement-repo.test.ts`, `engine.test.ts` and `api.test.ts`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/persistence.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Run everything, including the traceability matrix**

Run: `cd backend && npm test && npm run eval && npm run traceability | head -5 && npm run typecheck`
Expected:
- all tests pass
- eval 25/25
- traceability header says `17/17 requirements have automated test or evaluation coverage`
- typecheck exits 0

- [ ] **Step 9: Commit**

```bash
git add backend/src/db/import-json.ts backend/src/db/cli.ts backend/package.json backend/validation/requirements.json backend/tests/persistence.test.ts
git commit -m "Add migrate, import-json and verify operator commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: Packaging — Docker, Compose, local setup and docs

**Files:**
- Modify: `backend/Dockerfile`, `docker-compose.yml`, `backend/.gitignore`, `README.md`
- Create: `backend/.env.example`

**Interfaces:**
- Consumes: `node dist/db/cli.js migrate`, `node dist/server.js` (Tasks 4–5)
- Produces: `docker compose up --build` brings up postgres → migrate (one-shot) → backend → frontend

- [ ] **Step 1: Update the backend image** by replacing `backend/Dockerfile`:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY packs ./packs
COPY validation ./validation
COPY tests ./tests
USER node
EXPOSE 3002
CMD ["node", "dist/server.js"]
```

`tests/` stays in the image because the traceability matrix reads test titles at runtime. `migrations/` must sit next to `dist/`, because `MIGRATIONS_DIR` resolves `../../migrations` from `dist/db/`.

- [ ] **Step 2: Replace `docker-compose.yml`**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: audit
      POSTGRES_USER: audit
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-audit-dev-only}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - '5432:5432'
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U audit -d audit']
      interval: 2s
      retries: 30

  # Migrations are a separate one-shot step; the API never migrates on start-up.
  migrate:
    build: ./backend
    command: ['node', 'dist/db/cli.js', 'migrate']
    environment:
      DATABASE_URL: postgres://audit:${POSTGRES_PASSWORD:-audit-dev-only}@postgres:5432/audit
    depends_on:
      postgres:
        condition: service_healthy

  backend:
    build: ./backend
    environment:
      PORT: '3002'
      DATABASE_URL: postgres://audit:${POSTGRES_PASSWORD:-audit-dev-only}@postgres:5432/audit
      # offline (default, no key needed) | anthropic
      LLM_PROVIDER: ${LLM_PROVIDER:-offline}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
    ports:
      - '3002:3002'
    depends_on:
      migrate:
        condition: service_completed_successfully

  frontend:
    build:
      context: .
      dockerfile: frontend/Dockerfile
    ports:
      - '8080:80'
    depends_on:
      - backend

volumes:
  pgdata:
```

- [ ] **Step 3: Add the local environment template** `backend/.env.example`

```bash
# Copy to backend/.env for local development (never used when NODE_ENV=production).
DATABASE_URL=postgres://audit:audit-dev-only@localhost:5432/audit
PORT=3002
# offline (default, no key needed) | anthropic
LLM_PROVIDER=offline
# ANTHROPIC_API_KEY=
```

Add `.env` to `backend/.gitignore`:

```
node_modules
dist
data/*.json
validation-output
.env
```

- [ ] **Step 4: Update the README.** In `README.md`, replace the whole `## Quick start` section, from its heading down to (not including) `### Demo script`, with:

````markdown
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
````

In the `## Checks` section, replace the code block with:

````markdown
```bash
cd backend
npm test              # needs Docker: tests run against a real Postgres (Testcontainers)
npm run eval          # 25/25 eval cases (offline), on a throwaway in-process database
npm run traceability  # requirements traceability matrix -> validation-output/traceability.md
npm run verify        # recompute the audit-trail hash chain in the configured database
npm run typecheck
```
````

In `## What is in the MVP`, change the Status cell of the `Audit-trail bundle per execution` row to:

```
Inputs, retrieval set, log, QA actions, output, versions, actor; SHA-256 chained; append-only in Postgres (UPDATE/DELETE/TRUNCATE rejected by trigger)
```

In `## Not in the MVP (next steps)`, replace the **Persistence and identity** bullet with:

```markdown
- **Identity:** the demo user switcher is a placeholder. Production needs OIDC
  SSO (Entra ID, Okta and others) with Part 11-grade e-signatures
  (re-authentication at signing). See
  `docs/superpowers/specs/2026-10-11-production-foundation-design.md`.
```

- [ ] **Step 5: Smoke-test the full stack**

```bash
docker compose up --build -d
docker compose ps migrate --format '{{.State}} {{.ExitCode}}'
curl -s localhost:3002/api/health
docker compose exec backend node dist/seed.js
curl -s localhost:3002/api/engagements | head -c 300; echo
curl -s localhost:3002/api/trail/verify
```

Expected:
- `migrate` shows `exited 0`
- health returns `{"ok":true,...}`
- seed prints two `ENG-…` ids and `Trail: { valid: true, … }`
- engagements lists 2
- verify returns `"valid":true`

Then check the API refuses to start against an unmigrated database:

```bash
docker compose exec postgres psql -U audit -d postgres -c 'CREATE DATABASE unmigrated'
docker compose run --rm --no-deps -e DATABASE_URL=postgres://audit:audit-dev-only@postgres:5432/unmigrated backend; echo "exit=$?"
```

Expected: the message `Database has unapplied migrations (001_core.sql)…` and `exit=1`.

Finally: `docker compose down -v`.

- [ ] **Step 6: Run the full checks one last time**

Run: `cd backend && npm test && npm run eval && npm run typecheck && cd ../frontend && npm run typecheck`
Expected: all green, and the frontend typecheck is unaffected.

- [ ] **Step 7: Commit**

```bash
git add backend/Dockerfile docker-compose.yml backend/.env.example backend/.gitignore README.md
git commit -m "Run the stack on Postgres with a one-shot migrate step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Done when

- `npm test` passes (Docker running): db, trail, repo, engine, api and persistence suites
- `npm run eval` is 25/25
- `npm run traceability` reports 17/17 covered
- both typechecks pass
- `docker compose up --build` serves the seeded demo, with a valid trail
- `backend/src/store.ts` no longer exists, and nothing reads or writes `data/db.json` except `import-json`

**Next plan:** 1B — Identity (OIDC login, sessions, CSRF, `DEV_AUTH`, roles `auditor` / `audit_manager` / `cae` / `admin` / `viewer`, segregation of duties, admin page).
