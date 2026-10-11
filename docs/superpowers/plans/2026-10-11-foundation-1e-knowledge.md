# Foundation 1E — OKF Knowledge Bundles, Postgres Knowledge Graph and Trust Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the three MVP content packs into reviewable OKF Markdown bundles, compile them into a Postgres knowledge graph that the engine, the library and search all read from, and let a finding cite only knowledge a human has verified.

**Architecture:**
- **Bundles.** Each pack becomes a folder of Markdown files with YAML frontmatter (`backend/packs/<pack>/pack.md`, `clauses/`, `controls/`, `eval/`). They live in git, so pull requests are the change control.
  - A parser (`src/knowledge/okf/`) validates the bundles with zod and resolves links between concepts.
  - It turns each bundle into the engine's existing `ContentPack` shape.
- **Compiler.** `npm run packs:compile` writes the bundles into `kg_nodes`, `kg_edges` and knowledge-graph `chunks` in one trailed transaction.
  - An append-only `kg_node_versions` table records every concept at every pack version, and refuses content that changed without a version bump.
  - The API compiles at start-up in development. In production it refuses to start if the graph doesn't match the bundles shipped in the image.
- **Registry.** `PackRegistry` keeps its public shape but is built from the graph (`registryFromGraph`), so modules, the BM25 grounding index and the eval harness are unaffected.
- **Trust rules (REQ-22).** A clause or control is citable only if a person verified it, it is active, and it isn't past its re-review date.
  - The citation gates block unverified sources, or only flag them when `ALLOW_UNVERIFIED_CITATIONS=true`, which is refused in production.
  - Stale sources are always flagged.
- **Search.** `PgFtsRetriever` also returns knowledge-graph hits, with a `citable` flag computed from the trust rules.
- **UI.** The library shows each concept's verification, re-review date and source file. The admin page lists knowledge due for re-review.

**Tech Stack:**
- Node 22, TypeScript, Express 5, Kysely + Postgres 16 (+ pgvector), zod 4.
- `yaml` 2.9.1, used for frontmatter. It is already in the lockfile as a transitive dependency and becomes a direct one.
- PGlite for eval.
- vitest + Testcontainers.
- React 18 + MUI 5.

**Spec:** `docs/superpowers/specs/2026-10-11-production-foundation-design.md`:
- §6.1–§6.5 knowledge
- §3.1 `kg_nodes` and `kg_edges`
- §9 library and admin pages
- §10 "`packs:compile` rejects a dangling link"
- §11 REQ-22

This plan builds on 1A–1D. Its branch is `design/foundation-1e-knowledge`, stacked on `design/foundation-1d-storage` (PR #5).

## Global Constraints

- **Database.** Kysely for queries. Plain SQL migrations in `backend/migrations/`, never applied on start-up. Add `008_knowledge_graph.sql`; never edit `001`–`007`.
- **Bundle layout (spec §6.2).**
  - Files: `backend/packs/<pack-id>/pack.md`, `clauses/<slug>.md`, `controls/<slug>.md`, `eval/<slug>.md`, plus optional `regulations/<slug>.md` and `risks/<slug>.md`.
  - Each file starts with YAML frontmatter between `---` lines, parsed with `yaml` (YAML 1.2 core schema, so dates stay strings).
  - Any other file or folder in a bundle is an error.
- **Frontmatter fields.**
  - OKF fields: `type`, `title`, `description`, `tags`, `sources`, `generated`, `verified`, `status`, `stale_after`.
  - All audit extensions go under one `x_audit` key. Unknown top-level keys are an error, so typos are caught.
- **Ids.**
  - Concept id: `x_audit.id`, for example `21CFR211.22` or `PH-QU-01`. This is the key engagements, findings and eval cases already store, and it stays the key in `PackRegistry.clauses` and `.controls`.
  - Slug: `slugOf(id) = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')`. A concept's file name must be `<slugOf(x_audit.id)>.md`.
  - Node id: `<pack-id>/<type>/<slug>`, for example `pharma/clause/21cfr211-22`. The pack node is `<pack-id>/pack/<pack-id>`.
  - Concept ids are unique per type across all loaded bundles.
- **Links.**
  - A `sources[].ref` or Markdown link target ending in `.md` is a link to another concept. It may be pack-root-relative (`/clauses/x.md`) or file-relative (`../clauses/x.md`).
  - It must resolve to a concept **in the same pack**. Links to unknown concepts or outside the pack are rejected with the file and the link named.
  - `http(s)://` refs are external sources. Any other `ref` is an error.
- **Edges.**
  - Control `sources` → `cites` edges. Markdown links in bodies → `relates_to` edges.
  - All 1E edges are `origin = 'curated'`, with `created_by` = the compiling actor and `approved_by = 'git:<pack>@<version>'`, because the merged pull request is the approval.
  - The `engagement` and `proposed` origins exist in the schema only.
- **A control's two clause lists must agree.** `x_audit.clause_refs` (ordered; the engine's `clauseRefs`) must name exactly the clauses its `sources` link to. A mismatch is an error.
- **The live graph holds one version per pack, updated in place.**
  - `kg_node_versions` is append-only, keyed by node id and pack version.
  - If a concept's `source_sha256` differs from the one recorded for the same node and pack version, compile refuses: "bump the version in `<pack>/pack.md`".
  - A pack whose version and every file hash are unchanged is skipped: no writes, no trail entry.
  - Nodes missing from a newer bundle get `status = 'deprecated'`. Nodes are never deleted (trigger).
- **Compile is a release step, like `migrate`.**
  - Commands: `npm run packs:compile`; in the container, `node dist/knowledge/packs-cli.js compile`.
  - All packs compile in one transaction, trailed as `knowledge:compile`:
    - `engagementId` null, actor `system:packs`;
    - inputs: each compiled pack's id, version and bundle hash;
    - output: counts.
  - The API compiles at start-up when `NODE_ENV` isn't `production`. In production it never compiles, and refuses to start when the graph's pack version or any concept hash differs from the bundles in the image.
- **Trust rules (§6.4).**
  - A clause or control is citable only if:
    - `verified` is set (by, role, at);
    - `status` is `active`;
    - `stale_after` is null or later than today (UTC date).
  - **Unverified concepts:** citing one is `UNVERIFIED_SOURCE`. The gate action is `blocked` unless `ALLOW_UNVERIFIED_CITATIONS=true`, in which case it is `flagged`.
  - **Stale concepts:** citing one is `STALE_SOURCE`, always `flagged`.
  - Gate name `trust`. The detail text starts with the code.
  - `ALLOW_UNVERIFIED_CITATIONS=true` with `NODE_ENV=production` is refused at start-up.
  - `AuditService` defaults to `allowUnverified: false`.
- **Migrated content is honest.**
  - Every concept gets:
    - `verified: null`
    - `status: active`
    - `stale_after: 2027-10-11`
    - `generated: { by: mvp-pack-migration, at: "2026-10-11" }`
  - Every pack's version becomes `0.2.0`.
  - Until expert review, the flag must be `true` for demos, tests and eval. Set it in:
    - `backend/.env.example`
    - the Compose backend
    - `tests/helpers.ts`, explicitly through the service options
  - `npm run eval` reads it from the environment.
- **Concept order.** In a pack, clauses, controls and eval cases are ordered by concept id (plain string order). This applies to both `registryFromBundles` and `registryFromGraph`.
- **Engine changes stay limited.**
  - `Clause` and `Control` gain an optional `trust` field.
  - The citation gates take a `CitationPolicy`.
  - `ModuleContext` carries the policy.
  - `rcm.ts` and `gaps.ts` pass it on.
  - Nothing else in `src/engine` changes.
- **Retrieval-set rule (REQ-03).**
  - Unchanged for model-drafted findings: Gap Writer's per-row grounding set.
  - Human edits are still checked against the engagement's pack scope.
  - Trust rules apply to both.
- **Knowledge-graph nodes in search.**
  - Classification comes from `pack.md` `x_audit.classification` (default `internal`). Knowledge-graph chunks have `engagement_id` null.
  - Pack and eval-case nodes get no chunks.
  - The document kind `okf_concept` in a search's `kinds` selects knowledge-graph nodes.
- **Embeddings (ruling inherited from 1D).**
  - Migration 008 lets any chunk's `embedding` be set once, from NULL, with nothing else changing.
  - Document chunks stay otherwise immutable.
  - Knowledge-graph chunks are rewritten only by compile.
  - Computing embeddings is sub-project 7.
- **Admin access.** Admins see knowledge metadata (ids, titles, dates, paths) in the due-for-re-review list, never bodies.
- **Still deferred from 1D:** trail visibility by classification (to 1F), and the minor follow-ups listed on PR #5.
- **Tests, eval and requirements.**
  - Tests keep their `[REQ-xx]` tags.
  - `npm run eval` stays 25/25 with `ALLOW_UNVERIFIED_CITATIONS=true`.
  - `npm run traceability` goes to 23/23.
  - `validation/requirements.json` changes only by adding REQ-22.
- **Commits and content.**
  - No secrets are committed.
  - Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote it.
  - Gartner material never enters code, packs, prompts or the repo.

**Deliberate refinements of the spec (1E):**
- **History table instead of versioned primary keys.**
  - §6.3 says compile "upserts … versioned by `pack_version`". The live `kg_nodes` row is upserted.
  - An append-only `kg_node_versions` row keeps every compiled version's content and hash. This gives database-level immutability for ALCOA+ without composite keys on nodes, edges and chunks.
  - Reconstructing what a run saw uses the run's recorded `packVersions` plus `kg_node_versions`.
- **No `PackBm25Retriever` class.**
  - The engine's BM25 grounding index stays where it is.
  - It is now built from a registry that comes from the graph.
  - The `Retriever` interface gains knowledge-graph hits through `PgFtsRetriever`.
- **RCM rows have no release status.**
  - A trust failure on an RCM row is recorded as a failed `trust` gate action in the run's trail.
  - Release is enforced where it exists: findings, which carry the trust gate and are blocked.
  - The report lists every cited unverified source.
- **`packs:migrate` keeps working.** The legacy `pack.json` schema moves into the converter, so the command still works after the three `pack.json` files are deleted.
- **The retrieval-set check is not extended to controls.**
  - §6.4 extends REQ-03 "to every knowledge node". In 1E it still covers clauses, through Gap Writer's per-row grounding set.
  - A finding's control comes from its RCM row, which comes from the engagement's pack scope, so the control is always within that scope.
  - Trust rules now apply to both the clauses and the control.
  - The supervisor agents (sub-project 2) record node-level retrieval sets.
- **`verified.role` is stored** as `kg_nodes.verified_role`. The spec's YAML example has the field, but its table list doesn't.

## Review Focus

1. **A concept links to a clause that doesn't exist, or to another pack's file.** Compile rejects it, naming the file and the link, and writes nothing. Pinned in Tasks 2 and 4.
2. **Someone edits a clause but forgets to bump the pack version.** Compile refuses and names the changed file. The graph and history are untouched. Pinned in Task 4.
3. **`ALLOW_UNVERIFIED_CITATIONS=true` with `NODE_ENV=production`.** Start-up is refused with a clear message. Pinned in Task 5.
4. **A verified, active clause whose `stale_after` was yesterday.**
   - Citing it is flagged `STALE_SOURCE`, not blocked.
   - It appears in the due-for-re-review list.
   - Pinned in Tasks 5 and 7.
5. **The same bundles compiled twice.** No new trail entry, no duplicate chunks or edges, and identical counts. Pinned in Task 4.

## File structure

| File | Responsibility |
|---|---|
| `backend/migrations/008_knowledge_graph.sql` | `kg_nodes`, `kg_node_versions`, `kg_edges`; chunk → node foreign key and uniqueness; embedding fill-once |
| `backend/src/db/schema.ts` | Kysely types for the three new tables |
| `backend/src/knowledge/okf/frontmatter.ts` | `parseMarkdown()`, `renderMarkdown()` |
| `backend/src/knowledge/okf/schema.ts` | zod schemas for each concept type; `slugOf()`; `CONCEPT_DIRS` |
| `backend/src/knowledge/okf/control-body.ts` | `parseControlBody()`, `renderControlBody()` |
| `backend/src/knowledge/okf/bundle.ts` | `Concept`, `Bundle`, `loadBundle()`, `loadBundles()`, `DEFAULT_PACKS_DIR` |
| `backend/src/knowledge/okf/to-pack.ts` | `bundleToContentPack()` |
| `backend/src/knowledge/okf/migrate-json.ts` | Legacy `pack.json` schema; `loadLegacyPack()`; `packToFiles()` |
| `backend/src/knowledge/packs.ts` | `registryFromBundles()`, `registryFromGraph()` |
| `backend/src/knowledge/graph/compile.ts` | `compilePacks()`, `graphDrift()`, `CompileError` |
| `backend/src/knowledge/packs-cli.ts` | `compile` and `migrate` commands |
| `backend/src/engine/trust.ts` | `CitationPolicy`, `trustProblems()`, `isCitable()`, `trustActions()` |
| `backend/src/engine/{types,packs,qa,module}.ts`, `modules/{rcm,gaps,report}.ts` | Trust fields and policy plumbing |
| `backend/src/config.ts` | `loadCitationPolicy()` |
| `backend/src/knowledge/retriever.ts` | Knowledge-graph hits, `NodeCitation` |
| `backend/src/knowledge/graph/due.ts`, `src/auth/admin-routes.ts` | `GET /api/admin/knowledge/due` |
| `backend/packs/{common,food,pharma}/**.md` | Migrated bundles (generated once, then reviewed by people) |
| `frontend/src/pages/LibraryPage.tsx`, `AdminPage.tsx` | Trust columns; due list |
| Tests | `okf.test.ts`, `knowledge-graph.test.ts`, `trust.test.ts`, plus updates to `retrieval.test.ts`, `documents.test.ts`, `engine.test.ts`, `helpers.ts` |
| `docker-compose.yml`, `backend/.env.example`, `README.md`, `validation/requirements.json` | Ops and docs |

---

### Task 1: Knowledge-graph tables (migration 008)

**Files:**
- Create: `backend/migrations/008_knowledge_graph.sql`
- Modify: `backend/src/db/schema.ts` (three table types; register them in `DB`)
- Modify: `backend/tests/documents.test.ts` (the immutability test's knowledge-graph chunk now needs a node)
- Test: `backend/tests/knowledge-graph.test.ts` (new)

**Interfaces:**
- Consumes: `reject_change()` (001), `chunks` (005), the 007 chunk triggers.
- Produces:
  - Tables `kg_nodes`, `kg_node_versions` and `kg_edges` with exactly these columns.
  - Kysely types `KgNodesTable`, `KgNodeVersionsTable`, `KgEdgesTable`.
  - `chunks.kg_node_id` becomes a foreign key to `kg_nodes(id)`, unique per `(kg_node_id, ordinal)`.
  - Any chunk's `embedding` may be set once, from NULL.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/knowledge-graph.test.ts`:

```ts
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import { insertDocument, setDocumentText } from '../src/knowledge/document-repo';
import { newService } from './helpers';

const SHA = 'a'.repeat(64);

function nodeRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, type: 'clause', pack_id: 'p', pack_version: '0.2.0', concept_id: id.split('/').pop()!.toUpperCase(),
    title: 'T', description: 'D', body: '', tags: '[]', attrs: '{}', generated: null,
    verified_by: null, verified_role: null, verified_at: null, status: 'active', stale_after: null,
    source_path: `p/clauses/${id.split('/').pop()}.md`, source_sha256: SHA, classification: 'internal', ...over,
  } as const;
}

describe('knowledge-graph schema', () => {
  it('never deletes or truncates nodes, and keeps node history append-only', async () => {
    const db = (await newService()).db.kysely;
    await db.insertInto('kg_nodes').values(nodeRow('p/clause/c1')).execute();
    await db.updateTable('kg_nodes').set({ status: 'deprecated' }).where('id', '=', 'p/clause/c1').execute();
    await expect(db.deleteFrom('kg_nodes').execute()).rejects.toThrow(/append-only: DELETE/);
    await expect(sql`TRUNCATE kg_nodes CASCADE`.execute(db)).rejects.toThrow(/append-only: TRUNCATE/);

    await db.insertInto('kg_node_versions').values({ node_id: 'p/clause/c1', pack_version: '0.2.0', source_sha256: SHA, snapshot: '{}', compiled_by: 'system:packs' }).execute();
    await expect(db.insertInto('kg_node_versions').values({ node_id: 'p/clause/c1', pack_version: '0.2.0', source_sha256: SHA, snapshot: '{}', compiled_by: 'x' }).execute()).rejects.toThrow(/duplicate key/);
    await expect(db.updateTable('kg_node_versions').set({ snapshot: '{"a":1}' }).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.deleteFrom('kg_node_versions').execute()).rejects.toThrow(/append-only: DELETE/);
    await expect(sql`TRUNCATE kg_node_versions`.execute(db)).rejects.toThrow(/append-only: TRUNCATE/);
  });

  it('checks node fields and keeps concept ids unique per type', async () => {
    const db = (await newService()).db.kysely;
    await db.insertInto('kg_nodes').values(nodeRow('p/clause/c1')).execute();
    await expect(db.insertInto('kg_nodes').values(nodeRow('p/clause/c1-copy', { concept_id: 'C1' })).execute()).rejects.toThrow(/duplicate key/);
    await expect(db.insertInto('kg_nodes').values(nodeRow('p/clause/c2', { type: 'opinion' })).execute()).rejects.toThrow(/check constraint/);
    await expect(db.insertInto('kg_nodes').values(nodeRow('p/clause/c3', { status: 'draft' })).execute()).rejects.toThrow(/check constraint/);
    await expect(db.insertInto('kg_nodes').values(nodeRow('p/clause/c4', { source_sha256: 'nope' })).execute()).rejects.toThrow(/check constraint/);
    // Verification is all or nothing: who, in what role, and when.
    await expect(db.insertInto('kg_nodes').values(nodeRow('p/clause/c5', { verified_by: 'Dr A' })).execute()).rejects.toThrow(/check constraint/);
    await db.insertInto('kg_nodes').values(nodeRow('p/clause/c6', { verified_by: 'Dr A', verified_role: 'QA SME', verified_at: '2026-10-01' })).execute();
  });

  it('links edges to existing nodes and requires curated edges to be approved', async () => {
    const db = (await newService()).db.kysely;
    await db.insertInto('kg_nodes').values([nodeRow('p/control/k1', { type: 'control' }), nodeRow('p/clause/c1')]).execute();
    const edge = { from_id: 'p/control/k1', to_id: 'p/clause/c1', rel: 'cites', origin: 'curated', created_by: 'system:packs', approved_by: 'git:p@0.2.0', approved_at: new Date() } as const;
    await db.insertInto('kg_edges').values(edge).execute();
    await expect(db.insertInto('kg_edges').values(edge).execute()).rejects.toThrow(/duplicate key/);
    await expect(db.insertInto('kg_edges').values({ ...edge, to_id: 'p/clause/missing' }).execute()).rejects.toThrow(/foreign key/);
    await expect(db.insertInto('kg_edges').values({ ...edge, rel: 'Cites!' }).execute()).rejects.toThrow(/check constraint/);
    await expect(db.insertInto('kg_edges').values({ ...edge, rel: 'tests', approved_by: null, approved_at: null }).execute()).rejects.toThrow(/check constraint/);
    await db.insertInto('kg_edges').values({ ...edge, rel: 'relates_to', origin: 'proposed', approved_by: null, approved_at: null }).execute();
  });

  it('ties knowledge-graph chunks to a node, one per ordinal', async () => {
    const db = (await newService()).db.kysely;
    const chunk = { id: 'KG:p/clause/c1:0', document_id: null, kg_node_id: 'p/clause/c1', ordinal: 0, page: null, text: 'node text', classification: 'internal', engagement_id: null } as const;
    await expect(db.insertInto('chunks').values(chunk).execute()).rejects.toThrow(/foreign key/);
    await db.insertInto('kg_nodes').values(nodeRow('p/clause/c1')).execute();
    await db.insertInto('chunks').values(chunk).execute();
    await expect(db.insertInto('chunks').values({ ...chunk, id: 'KG:other' }).execute()).rejects.toThrow(/duplicate key/);
  });

  it('lets any chunk get its embedding once and changes nothing else', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const db = svc.db.kysely;
    const d = await insertDocument(db, {
      sha256: 'b'.repeat(64), filename: 'sop.txt', mime: 'text/plain', size: 10, kind: 'sop',
      classification: 'internal', engagementId: null, uploadedBy: 'auditor',
    });
    await setDocumentText(db, d, { extractor: 'test', extractorVersion: '1', text: 'Some text.' });
    const id = (await db.selectFrom('chunks').select('id').where('document_id', '=', d.id).executeTakeFirstOrThrow()).id;

    await db.updateTable('chunks').set({ embedding: '[1,2,3]' }).where('id', '=', id).execute();
    await expect(db.updateTable('chunks').set({ embedding: '[3,2,1]' }).where('id', '=', id).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.updateTable('chunks').set({ embedding: null }).where('id', '=', id).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.updateTable('chunks').set({ text: 'changed' }).where('id', '=', id).execute()).rejects.toThrow(/append-only: UPDATE/);
  });
});
```

- [ ] **Step 2: Run the test and make sure it fails**

Run: `cd backend && npx vitest run tests/knowledge-graph.test.ts`
Expected: FAIL. `relation "kg_nodes" does not exist`, and TypeScript errors on the unknown tables.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/008_knowledge_graph.sql`:

```sql
-- The knowledge graph compiled from the OKF bundles in backend/packs (spec §6).
-- kg_nodes is the live graph: one row per concept at the pack version last compiled,
-- updated in place by compile, never deleted (a concept that leaves its bundle is deprecated).
-- kg_node_versions is the append-only history: every concept at every compiled pack version.

CREATE TABLE kg_nodes (
  id             text PRIMARY KEY,                -- <pack>/<type>/<slug>
  type           text NOT NULL CHECK (type IN ('pack', 'regulation', 'clause', 'control', 'risk', 'eval_case')),
  pack_id        text NOT NULL,
  pack_version   text NOT NULL,
  concept_id     text NOT NULL,                   -- x_audit.id: the id engagements and findings store
  title          text NOT NULL,
  description    text,
  body           text NOT NULL,
  tags           jsonb NOT NULL DEFAULT '[]',
  sources        jsonb NOT NULL DEFAULT '[]',     -- OKF sources: [{ ref }], links and external URLs as written
  attrs          jsonb NOT NULL DEFAULT '{}',     -- x_audit
  generated      jsonb,
  verified_by    text,
  verified_role  text,
  verified_at    date,
  status         text NOT NULL CHECK (status IN ('active', 'deprecated')),
  stale_after    date,
  source_path    text NOT NULL,
  source_sha256  text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  classification text NOT NULL CHECK (classification IN ('internal', 'confidential', 'restricted')),
  compiled_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((verified_by IS NULL AND verified_role IS NULL AND verified_at IS NULL)
      OR (verified_by IS NOT NULL AND verified_role IS NOT NULL AND verified_at IS NOT NULL)),
  UNIQUE (type, concept_id)
);
CREATE INDEX kg_nodes_pack_idx ON kg_nodes (pack_id, type);
CREATE TRIGGER kg_nodes_never_deleted BEFORE DELETE ON kg_nodes
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER kg_nodes_no_truncate BEFORE TRUNCATE ON kg_nodes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TABLE kg_node_versions (
  node_id       text NOT NULL,
  pack_version  text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot      jsonb NOT NULL,
  compiled_at   timestamptz NOT NULL DEFAULT now(),
  compiled_by   text NOT NULL,
  PRIMARY KEY (node_id, pack_version)
);
CREATE TRIGGER kg_node_versions_append_only BEFORE UPDATE OR DELETE ON kg_node_versions
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER kg_node_versions_no_truncate BEFORE TRUNCATE ON kg_node_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Curated edges come from the bundles and are rewritten by compile; their approval is the merged pull request.
-- 'engagement' and 'proposed' edges arrive with later sub-projects.
CREATE TABLE kg_edges (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_id     text NOT NULL REFERENCES kg_nodes (id),
  to_id       text NOT NULL REFERENCES kg_nodes (id),
  rel         text NOT NULL CHECK (rel ~ '^[a-z][a-z_]*$'),
  origin      text NOT NULL CHECK (origin IN ('curated', 'engagement', 'proposed')),
  created_by  text NOT NULL,
  source_ref  jsonb,
  approved_by text,
  approved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (origin <> 'curated' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  UNIQUE (from_id, to_id, rel, origin)
);
CREATE INDEX kg_edges_to_idx ON kg_edges (to_id, rel);

-- Knowledge-graph chunks belong to a node, one per ordinal.
ALTER TABLE chunks ADD CONSTRAINT chunks_kg_node_fk FOREIGN KEY (kg_node_id) REFERENCES kg_nodes (id);
CREATE UNIQUE INDEX chunks_kg_node_ordinal_idx ON chunks (kg_node_id, ordinal) WHERE kg_node_id IS NOT NULL;

-- Ruling carried from 1D: an embedding may be filled in once (sub-project 7 computes them);
-- nothing else about a document chunk may change. Same message shape as reject_change().
CREATE FUNCTION reject_chunk_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.embedding IS NULL AND NEW.embedding IS NOT NULL
     AND (to_jsonb(OLD) - 'embedding' - 'tsv') IS NOT DISTINCT FROM (to_jsonb(NEW) - 'embedding' - 'tsv') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'chunks is append-only: UPDATE rejected (only a missing embedding may be filled in)' USING ERRCODE = 'insufficient_privilege';
END
$$;
DROP TRIGGER chunks_document_update ON chunks;
CREATE TRIGGER chunks_document_update BEFORE UPDATE ON chunks
  FOR EACH ROW WHEN (OLD.document_id IS NOT NULL) EXECUTE FUNCTION reject_chunk_change();
```

- [ ] **Step 4: Add the Kysely types**

In `backend/src/db/schema.ts`, after `BlobUploadsTable`, add the following and register the three tables in `DB` as `kg_nodes`, `kg_node_versions` and `kg_edges`. Also remove the stray blank line after `ChunksTable`.

```ts
export type KgNodeType = 'pack' | 'regulation' | 'clause' | 'control' | 'risk' | 'eval_case';

export interface KgNodesTable {
  id: string;
  type: KgNodeType;
  pack_id: string;
  pack_version: string;
  concept_id: string;
  title: string;
  description: string | null;
  body: string;
  tags: Json<string[]>;
  sources: ColumnType<{ ref: string }[], string | undefined, string>;
  attrs: Json<Record<string, unknown>>;
  generated: ColumnType<{ by: string; at: string } | null, string | null, string | null>;
  verified_by: string | null;
  verified_role: string | null;
  /** date: read as 'YYYY-MM-DD' (parser 1082 in db/index.ts and db/pglite.ts). */
  verified_at: string | null;
  status: 'active' | 'deprecated';
  stale_after: string | null;
  source_path: string;
  source_sha256: string;
  classification: 'internal' | 'confidential' | 'restricted';
  compiled_at: DefaultedTimestamp;
}

export interface KgNodeVersionsTable {
  node_id: string;
  pack_version: string;
  source_sha256: string;
  snapshot: Json<unknown>;
  compiled_at: DefaultedTimestamp;
  compiled_by: string;
}

export interface KgEdgesTable {
  id: Generated<string>;
  from_id: string;
  to_id: string;
  rel: string;
  origin: 'curated' | 'engagement' | 'proposed';
  created_by: string;
  source_ref: ColumnType<unknown, string | null | undefined, string | null>;
  approved_by: string | null;
  approved_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: DefaultedTimestamp;
}
```

- [ ] **Step 5: Update the 1D immutability test's knowledge-graph chunk**

In `backend/tests/documents.test.ts`, find the test "keeps documents, their text, chunks and upload records immutable". Its last block inserts a chunk for `kg_node_id: 'KG-1'`, which now needs a node. Replace that block with:

```ts
    // Knowledge-graph chunks are not document chunks: compile rewrites them (plan 1E).
    await db.insertInto('kg_nodes').values({
      id: 'p/clause/kg-1', type: 'clause', pack_id: 'p', pack_version: '0.2.0', concept_id: 'KG-1', title: 'T',
      description: null, body: '', tags: '[]', attrs: '{}', generated: null, verified_by: null, verified_role: null,
      verified_at: null, status: 'active', stale_after: null, source_path: 'p/clauses/kg-1.md',
      source_sha256: 'c'.repeat(64), classification: 'internal',
    }).execute();
    await db.insertInto('chunks').values({ id: 'KG:p/clause/kg-1:0', document_id: null, kg_node_id: 'p/clause/kg-1', ordinal: 0, page: null, text: 'node', classification: 'internal', engagement_id: null }).execute();
    await db.updateTable('chunks').set({ text: 'node v2' }).where('id', '=', 'KG:p/clause/kg-1:0').execute();
    await db.deleteFrom('chunks').where('id', '=', 'KG:p/clause/kg-1:0').execute();
```

In the same test, the existing assertion `db.updateTable('chunks').set({ classification: 'internal' })` must still be rejected. It will be, with the new message, which still matches `/append-only: UPDATE/`.

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `cd backend && npx vitest run tests/knowledge-graph.test.ts tests/documents.test.ts && npm run typecheck`
Expected: PASS.

Then run `npm test && npm run eval`. Expected: the whole suite passes, and eval is 25/25. PGlite runs 008 too, so a failure there means the migration uses something PGlite lacks; fix the migration, not PGlite.

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/008_knowledge_graph.sql backend/src/db/schema.ts backend/tests/knowledge-graph.test.ts backend/tests/documents.test.ts
git commit -m "Add knowledge-graph tables with append-only node history and let chunk embeddings be filled once"
```

---

### Task 2: OKF bundle format, parser and the one-time `pack.json` conversion

**Files:**
- Create:
  - `backend/src/knowledge/okf/frontmatter.ts`
  - `backend/src/knowledge/okf/schema.ts`
  - `backend/src/knowledge/okf/control-body.ts`
  - `backend/src/knowledge/okf/bundle.ts`
  - `backend/src/knowledge/okf/to-pack.ts`
  - `backend/src/knowledge/okf/migrate-json.ts`
  - `backend/src/knowledge/packs-cli.ts`
- Modify:
  - `backend/src/engine/types.ts`: add `ConceptTrust`, plus optional `trust` on `Clause` and `Control`.
  - `backend/src/engine/packs.ts`: the zod schemas move to `migrate-json.ts`; `loadFromDir` imports `LegacyPackSchema` from there until Task 3 removes it.
  - `backend/package.json`: add the `yaml` dependency and the `packs:migrate` script.
- Generate and commit: `backend/packs/{common,food,pharma}/**/*.md`. Keep `pack.json` for now; Task 3 deletes it.
- Test: `backend/tests/okf.test.ts` (new) and `backend/tests/okf-fixtures.ts` (new; shared with Task 4's tests, so they never import another test file)

**Interfaces:**
- Consumes:
  - `ContentPack`, `Clause`, `Control` and `EvalCase` from `engine/types.ts`.
  - `CLASSIFICATIONS` and `Classification` from `knowledge/access.ts`.
- Produces:
  - `parseMarkdown(text, file): { data: Record<string, unknown>; body: string }` and `renderMarkdown(data, body): string`.
  - `slugOf(id): string`, `CONCEPT_DIRS`, `ConceptType`, `CONCEPT_SCHEMAS`.
  - `parseControlBody(body, file): ControlBody` and `renderControlBody(b): string`.
  - `Concept`, `Bundle`, `BundleError`, `DEFAULT_PACKS_DIR`, `loadBundle(packsDir, packId): Bundle`, `loadBundles(packsDir?): Bundle[]`.
  - `conceptTrust(c): ConceptTrust` and `bundleToContentPack(b): ContentPack`.
  - `LegacyPackSchema`, `loadLegacyPack(file): ContentPack`, `MVP_MIGRATION`, `packToFiles(pack, stamp?): Map<string, string>`.
  - `ConceptTrust`:

    ```ts
    {
      nodeId: string;
      verifiedBy: string | null;
      verifiedRole: string | null;
      verifiedAt: string | null;
      status: 'active' | 'deprecated';
      staleAfter: string | null;
      sourcePath: string;
    }
    ```

- [ ] **Step 1: Add the dependency and the trust type**

```bash
cd backend && npm install yaml@2.9.1
```

In `backend/src/engine/types.ts`, add the type below above `Clause`. Then add `trust?: ConceptTrust;` as the last field of both `Clause` and `Control`.

```ts
/** Where a library concept came from and whether a person has verified it (plan 1E, spec §6.4). */
export interface ConceptTrust {
  /** Knowledge-graph node id, e.g. "pharma/clause/21cfr211-22". */
  nodeId: string;
  verifiedBy: string | null;
  verifiedRole: string | null;
  /** 'YYYY-MM-DD' */
  verifiedAt: string | null;
  status: 'active' | 'deprecated';
  /** 'YYYY-MM-DD': on and after this date the concept is due for re-review and no longer citable. */
  staleAfter: string | null;
  /** Bundle file relative to the packs directory, e.g. "pharma/clauses/21cfr211-22.md". */
  sourcePath: string;
}
```

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/okf-fixtures.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ContentPack } from '../src/engine/types';
import { MVP_MIGRATION, packToFiles } from '../src/knowledge/okf/migrate-json';

// Shared OKF test fixtures: a tiny pack, and helpers that write it to a temporary packs directory.

export const FIXTURE: ContentPack = {
  id: 'demo', name: 'Demo Pack', version: '0.1.0', vertical: 'common', description: 'Demo content.',
  disclaimer: 'Draft content; not reviewed by a domain expert.', sources: { 'Demo Standard 2020': 'DS' },
  clauses: [
    { id: 'DS-2', regulation: 'Demo Standard 2020', ref: 'Clause 2', title: 'Records', summary: 'Records are kept and reviewed.', tags: ['records'], reviewStatus: 'draft', sourceUrl: 'https://example.org/ds#2' },
    { id: 'DS-1', regulation: 'Demo Standard 2020', ref: 'Clause 1', title: 'Policy', summary: 'A records policy exists.', tags: ['policy'], reviewStatus: 'draft' },
  ],
  controls: [{
    id: 'DM-01', title: 'Records are reviewed', processArea: 'Records', objective: 'Ensure records are complete.', risk: 'Incomplete records.',
    riskRating: 'High', type: 'Detective', nature: 'Manual', frequency: 'Monthly', clauseRefs: ['DS-2', 'DS-1'],
    testOfDesign: ['Inspect the procedure.'], testOfEffectiveness: ['Sample 10 records.', 'Check sign-off.'], evidenceExpected: ['Review log'],
    checklist: [], recommendation: 'Review records monthly.', keywords: ['review', 'records'],
  }],
  evalCases: [{ id: 'DM-R1', kind: 'retrieval', description: 'Finds the records clause', input: { query: 'records kept' }, expected: { clauseIds: ['DS-2'], k: 3 } }],
};

const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
/** What a migrated pack must equal: the original at the new version, concepts ordered by id, trust left aside. */
export function expectedAfterMigration(p: ContentPack): ContentPack {
  return { ...p, version: MVP_MIGRATION.version, clauses: byId(p.clauses), controls: byId(p.controls), evalCases: byId(p.evalCases) };
}
export function withoutTrust(p: ContentPack): ContentPack {
  return {
    ...p,
    clauses: p.clauses.map(({ trust: _t, ...c }) => c),
    controls: p.controls.map(({ trust: _t, ...c }) => c),
  };
}

export function writeBundle(root: string, packId: string, files: Map<string, string>) {
  for (const [rel, text] of files) {
    const file = path.join(root, packId, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}
export const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'okf-'));

export function demoRoot(edit?: (files: Map<string, string>) => void) {
  const root = tmpRoot();
  const files = packToFiles(FIXTURE);
  edit?.(files);
  writeBundle(root, 'demo', files);
  return root;
}
```

Create `backend/tests/okf.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PACKS_DIR, loadBundle, loadBundles } from '../src/knowledge/okf/bundle';
import { parseControlBody, renderControlBody } from '../src/knowledge/okf/control-body';
import { parseMarkdown, renderMarkdown } from '../src/knowledge/okf/frontmatter';
import { loadLegacyPack, packToFiles } from '../src/knowledge/okf/migrate-json';
import { slugOf } from '../src/knowledge/okf/schema';
import { bundleToContentPack } from '../src/knowledge/okf/to-pack';
import { demoRoot, expectedAfterMigration, FIXTURE, tmpRoot, withoutTrust, writeBundle } from './okf-fixtures';

describe('OKF frontmatter', () => {
  it('round-trips YAML frontmatter and keeps dates as strings', () => {
    const text = renderMarkdown({ type: 'clause', title: 'T', stale_after: '2027-10-11', x_audit: { id: 'A.1' } }, 'Body text.');
    expect(text.startsWith('---\n')).toBe(true);
    const doc = parseMarkdown(text, 'x.md');
    expect(doc.data).toEqual({ type: 'clause', title: 'T', stale_after: '2027-10-11', x_audit: { id: 'A.1' } });
    expect(doc.body).toBe('Body text.');
    expect(parseMarkdown('---\nat: 2026-10-11\nn: 3\n---\n', 'y.md').data).toEqual({ at: '2026-10-11', n: 3 });
  });

  it('rejects files without frontmatter or with a non-mapping frontmatter', () => {
    expect(() => parseMarkdown('# Just markdown', 'a.md')).toThrow(/a\.md: missing YAML frontmatter/);
    expect(() => parseMarkdown('---\n- a\n- b\n---\n', 'b.md')).toThrow(/b\.md: frontmatter must be a YAML mapping/);
    expect(() => parseMarkdown('---\ntitle: [unclosed\n---\n', 'c.md')).toThrow(/c\.md: invalid YAML frontmatter/);
  });
});

describe('control bodies', () => {
  const body = { objective: 'O.', testOfDesign: ['a', 'b'], testOfEffectiveness: ['c'], checklist: [], recommendation: 'R.' };

  it('round-trips the five sections', () => {
    expect(parseControlBody(renderControlBody(body), 'k.md')).toEqual(body);
  });

  it('rejects missing, reordered or malformed sections', () => {
    expect(() => parseControlBody('## Objective\nO.\n\n## Recommendation\nR.', 'k.md')).toThrow(/k\.md: control body must have the sections/);
    expect(() => parseControlBody(renderControlBody({ ...body, objective: '' }), 'k.md')).toThrow(/"## Objective" is empty/);
    expect(() => parseControlBody(renderControlBody(body).replace('- a', 'a'), 'k.md')).toThrow(/"## Test of design" must be a list of "- " items/);
    expect(() => parseControlBody(renderControlBody({ ...body, testOfDesign: [] }), 'k.md')).toThrow(/"## Test of design" needs at least one item/);
    expect(() => parseControlBody(`Intro\n${renderControlBody(body)}`, 'k.md')).toThrow(/text before the first "## Objective"/);
  });
});

describe('OKF bundles', () => {
  it('converts a pack to a bundle and back without losing anything', () => {
    const root = demoRoot();
    expect(fs.readdirSync(path.join(root, 'demo')).sort()).toEqual(['clauses', 'controls', 'eval', 'pack.md']);
    expect(fs.existsSync(path.join(root, 'demo/clauses/ds-2.md'))).toBe(true);
    const bundle = loadBundle(root, 'demo');
    expect(bundle.version).toBe('0.2.0');
    expect(bundle.classification).toBe('internal');
    expect(bundle.sha256).toMatch(/^[a-f0-9]{64}$/);
    const pack = bundleToContentPack(bundle);
    expect(withoutTrust(pack)).toEqual(expectedAfterMigration(FIXTURE));
    expect(pack.clauses.find((c) => c.id === 'DS-2')!.trust).toEqual({
      nodeId: 'demo/clause/ds-2', verifiedBy: null, verifiedRole: null, verifiedAt: null, status: 'active',
      staleAfter: '2027-10-11', sourcePath: 'demo/clauses/ds-2.md',
    });
  });

  it('turns control sources into cites edges and body links into relates_to edges', () => {
    const root = demoRoot((f) => f.set('controls/dm-01.md', f.get('controls/dm-01.md')!.replace('Review records monthly.', 'Review records monthly; see [the policy](../clauses/ds-1.md).')));
    const control = loadBundle(root, 'demo').concepts.find((c) => c.conceptId === 'DM-01')!;
    expect(control.links).toEqual([
      { target: 'demo/clause/ds-2', rel: 'cites', ref: '/clauses/ds-2.md' },
      { target: 'demo/clause/ds-1', rel: 'cites', ref: '/clauses/ds-1.md' },
      { target: 'demo/clause/ds-1', rel: 'relates_to', ref: '../clauses/ds-1.md' },
    ]);
  });

  it('rejects a link to a concept that does not exist, naming the file and the link', () => {
    const root = demoRoot((f) => f.set('controls/dm-01.md', f.get('controls/dm-01.md')!.replace('/clauses/ds-1.md', '/clauses/ds-9.md')));
    expect(() => loadBundle(root, 'demo')).toThrow(/demo\/controls\/dm-01\.md: link "\/clauses\/ds-9\.md" points to "demo\/clauses\/ds-9\.md", which is not a concept in this bundle/);
  });

  it('rejects a link that leaves the pack', () => {
    const root = demoRoot((f) => f.set('controls/dm-01.md', f.get('controls/dm-01.md')!.replace('/clauses/ds-1.md', '../../food/clauses/x.md')));
    expect(() => loadBundle(root, 'demo')).toThrow(/demo\/controls\/dm-01\.md: link "\.\.\/\.\.\/food\/clauses\/x\.md" points outside the pack/);
  });

  it('requires clause_refs to name exactly the clauses a control links to', () => {
    const root = demoRoot((f) => f.set('controls/dm-01.md', f.get('controls/dm-01.md')!.replace(/  - DS-1\n/, '')));
    expect(() => loadBundle(root, 'demo')).toThrow(/demo\/controls\/dm-01\.md: x_audit\.clause_refs \(DS-2\) must name exactly the clauses in sources \(DS-1, DS-2\)/);
  });

  it('rejects misplaced, misnamed, mistyped and unknown content', () => {
    const misnamed = demoRoot((f) => { f.set('clauses/other-name.md', f.get('clauses/ds-1.md')!); f.delete('clauses/ds-1.md'); });
    expect(() => loadBundle(misnamed, 'demo')).toThrow(/demo\/clauses\/other-name\.md: file name must be "ds-1\.md" \(the slug of x_audit\.id "DS-1"\)/);

    const wrongFolder = demoRoot((f) => f.set('controls/ds-1.md', f.get('clauses/ds-1.md')!));
    expect(() => loadBundle(wrongFolder, 'demo')).toThrow(/demo\/controls\/ds-1\.md: type "clause" does not match its folder \(expected "control"\)/);

    const typo = demoRoot((f) => f.set('clauses/ds-1.md', f.get('clauses/ds-1.md')!.replace('status: active', 'status: active\nstale_afer: 2027-01-01')));
    expect(() => loadBundle(typo, 'demo')).toThrow(/demo\/clauses\/ds-1\.md: invalid frontmatter: .*stale_afer/);

    const stray = demoRoot((f) => f.set('notes/todo.md', '---\ntype: clause\n---\n'));
    expect(() => loadBundle(stray, 'demo')).toThrow(/demo\/notes: not part of an OKF bundle/);

    const noPack = demoRoot((f) => f.delete('pack.md'));
    expect(() => loadBundle(noPack, 'demo')).toThrow(/demo: missing pack\.md/);
  });

  it('rejects the same concept id in two bundles', () => {
    const root = demoRoot();
    const copy = packToFiles({ ...FIXTURE, id: 'demo2', controls: [], evalCases: [], clauses: [FIXTURE.clauses[1]] });
    writeBundle(root, 'demo2', copy);
    expect(() => loadBundles(root)).toThrow(/clause "DS-1" is defined twice: demo\/clauses\/ds-1\.md and demo2\/clauses\/ds-1\.md/);
  });

  it('slugs concept ids for file names', () => {
    expect(slugOf('21CFR211.22')).toBe('21cfr211-22');
    expect(slugOf('PH-QU-01')).toBe('ph-qu-01');
    expect(slugOf('EU-GMP-Annex11 §4.8')).toBe('eu-gmp-annex11-4-8');
  });
});

describe('the migrated MVP packs', () => {
  for (const id of ['common', 'food', 'pharma']) {
    it(`${id}: pack.json converts losslessly and matches the committed bundle`, () => {
      const legacy = loadLegacyPack(path.join(DEFAULT_PACKS_DIR, id, 'pack.json'));
      const files = packToFiles(legacy);
      const root = tmpRoot();
      writeBundle(root, id, files);
      expect(withoutTrust(bundleToContentPack(loadBundle(root, id)))).toEqual(expectedAfterMigration(legacy));
      for (const [rel, text] of files) expect(fs.readFileSync(path.join(DEFAULT_PACKS_DIR, id, rel), 'utf8'), rel).toBe(text);
    });
  }
});
```

- [ ] **Step 3: Run the tests and make sure they fail**

Run: `cd backend && npx vitest run tests/okf.test.ts`
Expected: FAIL. The modules `../src/knowledge/okf/*` don't exist yet.

- [ ] **Step 4: Write `frontmatter.ts`**

```ts
import YAML from 'yaml';

// OKF concept files: YAML frontmatter between two "---" lines, then a Markdown body.
// YAML 1.2 core schema, so 2027-10-11 stays the string it looks like (no timestamp type).

export interface MarkdownDoc {
  data: Record<string, unknown>;
  body: string;
}

const FENCED = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

export function parseMarkdown(text: string, file: string): MarkdownDoc {
  const m = FENCED.exec(text);
  if (!m) throw new Error(`${file}: missing YAML frontmatter (the file must start with a line containing only ---)`);
  let data: unknown;
  try {
    data = YAML.parse(m[1], { schema: 'core', uniqueKeys: true });
  } catch (err) {
    throw new Error(`${file}: invalid YAML frontmatter: ${(err as Error).message.split('\n')[0]}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file}: frontmatter must be a YAML mapping`);
  return { data: data as Record<string, unknown>, body: (m[2] ?? '').trim() };
}

export function renderMarkdown(data: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(data, { lineWidth: 0, schema: 'core' }).trimEnd();
  return `---\n${yaml}\n---\n${body ? `${body}\n` : ''}`;
}
```

- [ ] **Step 5: Write `schema.ts`**

```ts
import { z } from 'zod';
import { CLASSIFICATIONS } from '../access';

// Frontmatter schemas for OKF v0.2 concepts plus the audit extensions under x_audit (spec §6.2).
// Objects are strict, so a misspelt field is an error rather than silently ignored.

export const CONCEPT_DIRS = {
  regulations: 'regulation',
  clauses: 'clause',
  controls: 'control',
  risks: 'risk',
  eval: 'eval_case',
} as const;

export type ConceptType = 'pack' | (typeof CONCEPT_DIRS)[keyof typeof CONCEPT_DIRS];

/** File-name slug of a concept id: "21CFR211.22" -> "21cfr211-22". */
export const slugOf = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .refine((s) => new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'must be a real calendar date');

const okf = {
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  sources: z.array(z.strictObject({ ref: z.string().min(1) })).default([]),
  generated: z.strictObject({ by: z.string().min(1), at: IsoDate }).nullable().default(null),
  verified: z.strictObject({ by: z.string().min(1), role: z.string().min(1), at: IsoDate }).nullable().default(null),
  status: z.enum(['active', 'deprecated']),
  stale_after: IsoDate.nullable().default(null),
};

export const RISK_RATINGS = ['High', 'Medium', 'Low'] as const;
export const CONTROL_TYPES = ['Preventive', 'Detective'] as const;
export const CONTROL_NATURES = ['Manual', 'Automated', 'IT-dependent manual'] as const;
export const FREQUENCIES = ['Annual', 'Quarterly', 'Monthly', 'Weekly', 'Daily', 'Per event', 'Per batch'] as const;

export const PackConcept = z.strictObject({
  type: z.literal('pack'),
  ...okf,
  description: z.string().default(''),
  x_audit: z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lower-case pack id'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be a semantic version such as 0.2.0'),
    vertical: z.string().min(1),
    classification: z.enum(CLASSIFICATIONS).default('internal'),
    /** Short citation prefix per regulation name, e.g. {"EU GMP Part I": "EU GMP"}. */
    citation_prefixes: z.record(z.string(), z.string()).default({}),
  }),
});

export const ClauseConcept = z.strictObject({
  type: z.literal('clause'),
  ...okf,
  description: z.string().min(1),
  x_audit: z.strictObject({ id: z.string().min(1), regulation: z.string().min(1), ref: z.string().min(1) }),
});

export const ControlConcept = z.strictObject({
  type: z.literal('control'),
  ...okf,
  x_audit: z.strictObject({
    id: z.string().min(1),
    process_area: z.string().min(1),
    risk: z.string().min(1),
    risk_rating: z.enum(RISK_RATINGS),
    type: z.enum(CONTROL_TYPES),
    nature: z.enum(CONTROL_NATURES),
    frequency: z.enum(FREQUENCIES),
    clause_refs: z.array(z.string().min(1)).min(1),
    evidence_expected: z.array(z.string().min(1)).min(1),
  }),
});

export const EvalCaseConcept = z.strictObject({
  type: z.literal('eval_case'),
  ...okf,
  description: z.string(),
  x_audit: z.strictObject({
    id: z.string().min(1),
    kind: z.enum(['retrieval', 'testing', 'gaps']),
    input: z.record(z.string(), z.unknown()),
    expected: z.record(z.string(), z.unknown()),
  }),
});

/** Regulations and risks: accepted and graphed; the MVP packs have none (regulation names live on clauses). */
const OpenConcept = (type: 'regulation' | 'risk') =>
  z.strictObject({ type: z.literal(type), ...okf, x_audit: z.looseObject({ id: z.string().min(1) }) });

export const CONCEPT_SCHEMAS = {
  pack: PackConcept,
  clause: ClauseConcept,
  control: ControlConcept,
  eval_case: EvalCaseConcept,
  regulation: OpenConcept('regulation'),
  risk: OpenConcept('risk'),
} satisfies Record<ConceptType, z.ZodType>;

export type PackAttrs = z.infer<typeof PackConcept>['x_audit'];
export type ClauseAttrs = z.infer<typeof ClauseConcept>['x_audit'];
export type ControlAttrs = z.infer<typeof ControlConcept>['x_audit'];
export type EvalCaseAttrs = z.infer<typeof EvalCaseConcept>['x_audit'];
```

- [ ] **Step 6: Write `control-body.ts`**

```ts
// A control's body: five "## " sections in a fixed order. Objective and Recommendation are prose;
// the other three are "- " lists (the checklist may be empty).

export const CONTROL_SECTIONS = ['Objective', 'Test of design', 'Test of effectiveness', 'Checklist', 'Recommendation'] as const;

export interface ControlBody {
  objective: string;
  testOfDesign: string[];
  testOfEffectiveness: string[];
  checklist: string[];
  recommendation: string;
}

export function parseControlBody(body: string, file: string): ControlBody {
  const parts = body.split(/^## /m);
  if (parts[0].trim()) throw new Error(`${file}: text before the first "## Objective" heading`);
  const sections = parts.slice(1).map((p) => {
    const nl = p.indexOf('\n');
    return { heading: (nl < 0 ? p : p.slice(0, nl)).trim(), content: nl < 0 ? '' : p.slice(nl + 1).trim() };
  });
  const found = sections.map((s) => s.heading);
  if (found.join('|') !== CONTROL_SECTIONS.join('|')) {
    const want = CONTROL_SECTIONS.map((h) => `"## ${h}"`).join(', ');
    throw new Error(`${file}: control body must have the sections ${want} in that order (found ${found.map((h) => `"## ${h}"`).join(', ') || 'none'})`);
  }
  const prose = (i: number) => {
    if (!sections[i].content) throw new Error(`${file}: "## ${CONTROL_SECTIONS[i]}" is empty`);
    return sections[i].content;
  };
  const list = (i: number, required: boolean) => {
    const lines = sections[i].content.split('\n').map((l) => l.trim()).filter(Boolean);
    const bad = lines.find((l) => !l.startsWith('- '));
    if (bad) throw new Error(`${file}: "## ${CONTROL_SECTIONS[i]}" must be a list of "- " items (found "${bad}")`);
    const items = lines.map((l) => l.slice(2).trim());
    if (items.some((x) => !x)) throw new Error(`${file}: "## ${CONTROL_SECTIONS[i]}" has an empty item`);
    if (required && !items.length) throw new Error(`${file}: "## ${CONTROL_SECTIONS[i]}" needs at least one item`);
    return items;
  };
  return { objective: prose(0), testOfDesign: list(1, true), testOfEffectiveness: list(2, true), checklist: list(3, false), recommendation: prose(4) };
}

export function renderControlBody(b: ControlBody): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
  return [
    '## Objective', b.objective, '',
    '## Test of design', list(b.testOfDesign), '',
    '## Test of effectiveness', list(b.testOfEffectiveness), '',
    '## Checklist', list(b.checklist), '',
    '## Recommendation', b.recommendation,
  ].join('\n');
}
```

- [ ] **Step 7: Write `bundle.ts`**

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Classification } from '../access';
import { parseControlBody } from './control-body';
import { parseMarkdown } from './frontmatter';
import { CONCEPT_DIRS, CONCEPT_SCHEMAS, slugOf, type ConceptType, type ControlAttrs, type PackAttrs } from './schema';

// Loads OKF bundles from backend/packs/<pack-id>/ (spec §6.2): validates every file, resolves
// links between concepts, and returns the concepts with their content hashes for the compiler.

export const DEFAULT_PACKS_DIR = path.resolve(__dirname, '../../../packs');

export class BundleError extends Error {}

export interface ConceptLink {
  /** Node id of the linked concept. */
  target: string;
  rel: 'cites' | 'relates_to';
  /** The link as written in the file. */
  ref: string;
}

export interface Concept {
  /** "<pack>/<type>/<slug>"; the pack itself is "<pack>/pack/<pack>". */
  nodeId: string;
  type: ConceptType;
  packId: string;
  /** x_audit.id: the id engagements, findings and eval cases store. */
  conceptId: string;
  /** Relative to the packs directory, forward slashes: "pharma/clauses/21cfr211-22.md". */
  path: string;
  /** SHA-256 of the file's bytes. */
  sha256: string;
  title: string;
  description: string | null;
  body: string;
  tags: string[];
  /** OKF sources exactly as written: concept links (.md) and external URLs. */
  sources: { ref: string }[];
  /** The validated x_audit block. */
  attrs: Record<string, unknown>;
  generated: { by: string; at: string } | null;
  verified: { by: string; role: string; at: string } | null;
  status: 'active' | 'deprecated';
  staleAfter: string | null;
  /** http(s) sources. */
  externalSources: string[];
  links: ConceptLink[];
}

export interface Bundle {
  packId: string;
  version: string;
  classification: Classification;
  /** SHA-256 over the sorted "<path> <sha256>" lines of every file: the bundle's exact content. */
  sha256: string;
  /** The pack concept first, then the others ordered by path. */
  concepts: Concept[];
}

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
export const EXTERNAL = /^https?:\/\//;
const BODY_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** The fields every concept schema shares; x_audit is otherwise type-specific. */
interface CommonFields {
  title: string;
  description?: string;
  tags: string[];
  sources: { ref: string }[];
  generated: Concept['generated'];
  verified: Concept['verified'];
  status: Concept['status'];
  stale_after: string | null;
  x_audit: { id: string } & Record<string, unknown>;
}

interface RawConcept extends Omit<Concept, 'links'> {
  linkRefs: { ref: string; rel: ConceptLink['rel'] }[];
}

function readConcept(packsDir: string, packId: string, rel: string, type: ConceptType): RawConcept {
  const file = `${packId}/${rel}`;
  const bytes = fs.readFileSync(path.join(packsDir, packId, rel));
  const doc = parseMarkdown(bytes.toString('utf8'), file);
  if (doc.data.type !== type) throw new BundleError(`${file}: type "${String(doc.data.type)}" does not match its folder (expected "${type}")`);
  const parsed = CONCEPT_SCHEMAS[type].safeParse(doc.data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}${'keys' in i ? ` (${(i as { keys: string[] }).keys.join(', ')})` : ''}`);
    throw new BundleError(`${file}: invalid frontmatter: ${issues.join('; ')}`);
  }
  const data = parsed.data as CommonFields;
  const conceptId = data.x_audit.id;
  if (type === 'pack') {
    if (conceptId !== packId) throw new BundleError(`${file}: x_audit.id "${conceptId}" must equal the folder name "${packId}"`);
  } else if (path.posix.basename(rel) !== `${slugOf(conceptId)}.md`) {
    throw new BundleError(`${file}: file name must be "${slugOf(conceptId)}.md" (the slug of x_audit.id "${conceptId}")`);
  }
  if (type === 'control') parseControlBody(doc.body, file);

  const linkRefs: RawConcept['linkRefs'] = [];
  const externalSources: string[] = [];
  for (const { ref } of data.sources) {
    if (EXTERNAL.test(ref)) externalSources.push(ref);
    else if (ref.endsWith('.md')) linkRefs.push({ ref, rel: 'cites' });
    else throw new BundleError(`${file}: source "${ref}" is neither a link to a concept (.md) nor an http(s) URL`);
  }
  for (const m of doc.body.matchAll(BODY_LINK)) {
    if (m[1].endsWith('.md')) linkRefs.push({ ref: m[1], rel: 'relates_to' });
  }

  return {
    nodeId: `${packId}/${type}/${type === 'pack' ? packId : slugOf(conceptId)}`,
    type, packId, conceptId, path: file, sha256: sha256(bytes),
    title: data.title, description: data.description ?? null, body: doc.body, tags: data.tags, sources: data.sources,
    attrs: data.x_audit, generated: data.generated, verified: data.verified, status: data.status,
    staleAfter: data.stale_after, externalSources, linkRefs,
  };
}

/** Resolves a link to a path inside the pack, or null when it points outside it. */
function resolveLink(fromRel: string, ref: string): string | null {
  const target = ref.startsWith('/')
    ? path.posix.normalize(ref.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), ref));
  return target === '..' || target.startsWith('../') || target.startsWith('/') ? null : target;
}

export function loadBundle(packsDir: string, packId: string): Bundle {
  const root = path.join(packsDir, packId);
  const files: { rel: string; type: ConceptType }[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile() && entry.name === 'pack.md') {
      files.push({ rel: 'pack.md', type: 'pack' });
      continue;
    }
    // pack.json is the pre-OKF format: tolerated beside a bundle until Task 3 deletes it.
    if (entry.isFile() && entry.name === 'pack.json') continue;
    const type = entry.isDirectory() ? CONCEPT_DIRS[entry.name as keyof typeof CONCEPT_DIRS] : undefined;
    if (!type) throw new BundleError(`${packId}/${entry.name}: not part of an OKF bundle (expected pack.md and the folders ${Object.keys(CONCEPT_DIRS).join(', ')})`);
    for (const f of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!f.isFile() || !f.name.endsWith('.md')) throw new BundleError(`${packId}/${entry.name}/${f.name}: only .md concept files belong in ${entry.name}/`);
      files.push({ rel: `${entry.name}/${f.name}`, type });
    }
  }
  if (!files.some((f) => f.type === 'pack')) throw new BundleError(`${packId}: missing pack.md`);

  const raw = files.map((f) => readConcept(packsDir, packId, f.rel, f.type));
  const byPath = new Map(raw.map((c) => [c.path.slice(packId.length + 1), c]));
  const seen = new Map<string, string>();
  for (const c of raw) {
    const key = `${c.type}:${c.conceptId}`;
    if (seen.has(key)) throw new BundleError(`${c.type} "${c.conceptId}" is defined twice: ${seen.get(key)} and ${c.path}`);
    seen.set(key, c.path);
  }

  const concepts: Concept[] = raw.map(({ linkRefs, ...c }) => {
    const links: ConceptLink[] = [];
    for (const { ref, rel } of linkRefs) {
      const resolved = resolveLink(c.path.slice(packId.length + 1), ref);
      if (resolved === null) throw new BundleError(`${c.path}: link "${ref}" points outside the pack (links must stay inside ${packId}/)`);
      const target = byPath.get(resolved);
      if (!target) throw new BundleError(`${c.path}: link "${ref}" points to "${packId}/${resolved}", which is not a concept in this bundle`);
      if (!links.some((l) => l.target === target.nodeId && l.rel === rel)) links.push({ target: target.nodeId, rel, ref });
    }
    return { ...c, links };
  });

  for (const c of concepts.filter((x) => x.type === 'control')) {
    const linked = [...new Set(c.links.filter((l) => l.rel === 'cites').map((l) => concepts.find((x) => x.nodeId === l.target)!).filter((x) => x.type === 'clause').map((x) => x.conceptId))].sort();
    const refs = [...new Set((c.attrs as ControlAttrs).clause_refs)].sort();
    if (linked.join('|') !== refs.join('|')) {
      throw new BundleError(`${c.path}: x_audit.clause_refs (${refs.join(', ')}) must name exactly the clauses in sources (${linked.join(', ')})`);
    }
  }

  const pack = concepts.find((c) => c.type === 'pack')!;
  const attrs = pack.attrs as PackAttrs;
  return {
    packId,
    version: attrs.version,
    classification: attrs.classification,
    sha256: sha256(concepts.map((c) => `${c.path} ${c.sha256}`).sort().join('\n')),
    concepts: [pack, ...concepts.filter((c) => c !== pack)],
  };
}

/** Every bundle under the packs directory, ordered by pack id. Concept ids must be unique per type across bundles. */
export function loadBundles(packsDir = DEFAULT_PACKS_DIR): Bundle[] {
  const bundles = fs
    .readdirSync(packsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
    .map((id) => loadBundle(packsDir, id));
  const seen = new Map<string, string>();
  for (const c of bundles.flatMap((b) => b.concepts)) {
    if (c.type === 'pack') continue;
    const key = `${c.type}:${c.conceptId}`;
    if (seen.has(key)) throw new BundleError(`${c.type} "${c.conceptId}" is defined twice: ${seen.get(key)} and ${c.path}`);
    seen.set(key, c.path);
  }
  return bundles;
}
```

- [ ] **Step 8: Write `to-pack.ts`**

```ts
import type { Clause, ConceptTrust, ContentPack, Control, EvalCase } from '../../engine/types';
import type { Bundle, Concept } from './bundle';
import { parseControlBody } from './control-body';
import type { ClauseAttrs, ControlAttrs, EvalCaseAttrs, PackAttrs } from './schema';

// A bundle in the engine's ContentPack shape. Deprecated concepts stay in the graph but leave the pack.
// Clauses, controls and eval cases are ordered by concept id so every source of a registry agrees.

export function conceptTrust(c: Concept): ConceptTrust {
  return {
    nodeId: c.nodeId,
    verifiedBy: c.verified?.by ?? null,
    verifiedRole: c.verified?.role ?? null,
    verifiedAt: c.verified?.at ?? null,
    status: c.status,
    staleAfter: c.staleAfter,
    sourcePath: c.path,
  };
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function bundleToContentPack(b: Bundle): ContentPack {
  const pack = b.concepts.find((c) => c.type === 'pack')!;
  const p = pack.attrs as PackAttrs;
  const active = (type: Concept['type']) => b.concepts.filter((c) => c.type === type && c.status === 'active');

  const clauses: Clause[] = active('clause').map((c) => {
    const a = c.attrs as ClauseAttrs;
    return {
      id: a.id, regulation: a.regulation, ref: a.ref, title: c.title, summary: c.description ?? '', tags: c.tags,
      reviewStatus: c.verified ? 'expert-reviewed' : 'draft',
      ...(c.externalSources[0] ? { sourceUrl: c.externalSources[0] } : {}),
      trust: conceptTrust(c),
    };
  });

  const controls: Control[] = active('control').map((c) => {
    const a = c.attrs as ControlAttrs;
    const body = parseControlBody(c.body, c.path);
    return {
      id: a.id, title: c.title, processArea: a.process_area, objective: body.objective, risk: a.risk, riskRating: a.risk_rating,
      type: a.type, nature: a.nature, frequency: a.frequency, clauseRefs: [...a.clause_refs], testOfDesign: body.testOfDesign,
      testOfEffectiveness: body.testOfEffectiveness, evidenceExpected: [...a.evidence_expected], checklist: body.checklist,
      recommendation: body.recommendation, keywords: c.tags, trust: conceptTrust(c),
    };
  });

  const evalCases: EvalCase[] = active('eval_case').map((c) => {
    const a = c.attrs as EvalCaseAttrs;
    return { id: a.id, kind: a.kind, description: c.description ?? '', input: a.input, expected: a.expected };
  });

  return {
    id: p.id, name: pack.title, version: p.version, vertical: p.vertical, description: pack.description ?? '',
    disclaimer: pack.body, sources: p.citation_prefixes,
    clauses: clauses.sort(byId), controls: controls.sort(byId), evalCases: evalCases.sort(byId),
  };
}
```

- [ ] **Step 9: Write `migrate-json.ts`**

Move `ClauseSchema`, `ControlSchema`, `EvalCaseSchema` and `PackSchema` out of `src/engine/packs.ts` into this file unchanged, renaming `PackSchema` to `LegacyPackSchema`. In `engine/packs.ts`, `import { LegacyPackSchema } from '../knowledge/okf/migrate-json';` and use it in `loadFromDir`. That import goes away in Task 3. Then add:

```ts
import fs from 'node:fs';
import type { ContentPack } from '../../engine/types';
import { renderControlBody } from './control-body';
import { renderMarkdown } from './frontmatter';
import { slugOf } from './schema';

// One-time conversion of the MVP's pack.json files into OKF bundles (spec §6.3, `npm run packs:migrate`).
// Honest by construction: nothing is marked verified, and everything is due for re-review in 12 months.

export interface MigrationStamp {
  version: string;
  generatedBy: string;
  generatedAt: string;
  staleAfter: string;
}

export const MVP_MIGRATION: MigrationStamp = { version: '0.2.0', generatedBy: 'mvp-pack-migration', generatedAt: '2026-10-11', staleAfter: '2027-10-11' };

export function loadLegacyPack(file: string): ContentPack {
  const parsed = LegacyPackSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid content pack ${file}: ${parsed.error.message}`);
  return parsed.data as ContentPack;
}

function singleLine(value: string, what: string) {
  if (/[\r\n]/.test(value)) throw new Error(`${what} spans several lines; a control body section holds one line per item`);
  return value;
}

/** The bundle's files, keyed by path relative to the pack folder. */
export function packToFiles(pack: ContentPack, stamp: MigrationStamp = MVP_MIGRATION): Map<string, string> {
  const files = new Map<string, string>();
  const put = (rel: string, text: string) => {
    if (files.has(rel)) throw new Error(`${pack.id}/${rel}: two concepts share this file name`);
    files.set(rel, text);
  };
  const okf = { generated: { by: stamp.generatedBy, at: stamp.generatedAt }, verified: null, status: 'active', stale_after: stamp.staleAfter };

  put('pack.md', renderMarkdown({
    type: 'pack', title: pack.name, description: pack.description, tags: [pack.vertical], ...okf,
    x_audit: { id: pack.id, version: stamp.version, vertical: pack.vertical, classification: 'internal', citation_prefixes: pack.sources },
  }, pack.disclaimer));

  for (const c of pack.clauses) {
    put(`clauses/${slugOf(c.id)}.md`, renderMarkdown({
      type: 'clause', title: c.title, description: c.summary, tags: c.tags,
      ...(c.sourceUrl ? { sources: [{ ref: c.sourceUrl }] } : {}), ...okf,
      x_audit: { id: c.id, regulation: c.regulation, ref: c.ref },
    }, ''));
  }

  for (const c of pack.controls) {
    const where = `${pack.id} control ${c.id}`;
    put(`controls/${slugOf(c.id)}.md`, renderMarkdown({
      type: 'control', title: c.title, tags: c.keywords, sources: c.clauseRefs.map((r) => ({ ref: `/clauses/${slugOf(r)}.md` })), ...okf,
      x_audit: {
        id: c.id, process_area: c.processArea, risk: c.risk, risk_rating: c.riskRating, type: c.type, nature: c.nature,
        frequency: c.frequency, clause_refs: c.clauseRefs, evidence_expected: c.evidenceExpected,
      },
    }, renderControlBody({
      objective: singleLine(c.objective, `${where} objective`),
      testOfDesign: c.testOfDesign.map((x) => singleLine(x, `${where} test of design`)),
      testOfEffectiveness: c.testOfEffectiveness.map((x) => singleLine(x, `${where} test of effectiveness`)),
      checklist: c.checklist.map((x) => singleLine(x, `${where} checklist`)),
      recommendation: singleLine(c.recommendation, `${where} recommendation`),
    })));
  }

  for (const e of pack.evalCases) {
    put(`eval/${slugOf(e.id)}.md`, renderMarkdown({
      type: 'eval_case', title: e.id, description: e.description, ...okf,
      x_audit: { id: e.id, kind: e.kind, input: e.input, expected: e.expected },
    }, ''));
  }
  return files;
}
```

- [ ] **Step 10: Write `packs-cli.ts` with the `migrate` command, and the script**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PACKS_DIR } from './okf/bundle';
import { loadLegacyPack, packToFiles } from './okf/migrate-json';

// Content-pack commands. In the container: node dist/knowledge/packs-cli.js <command>
//   migrate [--from <dir>] [--to <dir>]   convert <from>/<pack>/pack.json into OKF bundles under <to>/<pack>/ (once)

const USAGE = 'Usage: packs-cli migrate [--from <dir>] [--to <dir>]';

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function migrateCommand(args: string[]) {
  const from = path.resolve(arg(args, 'from') ?? DEFAULT_PACKS_DIR);
  const to = path.resolve(arg(args, 'to') ?? DEFAULT_PACKS_DIR);
  let converted = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const json = path.join(from, entry.name, 'pack.json');
    if (!entry.isDirectory() || !fs.existsSync(json)) continue;
    const pack = loadLegacyPack(json);
    const files = packToFiles(pack);
    for (const rel of files.keys()) {
      const target = path.join(to, pack.id, rel);
      if (fs.existsSync(target)) throw new Error(`${target} already exists; packs:migrate never overwrites a bundle`);
    }
    for (const [rel, text] of files) {
      const target = path.join(to, pack.id, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    console.log(`${pack.id}: ${files.size} files written to ${path.join(to, pack.id)}`);
    converted++;
  }
  if (!converted) throw new Error(`No pack.json found under ${from}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'migrate') migrateCommand(args);
  else throw new Error(USAGE);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
```

In `backend/package.json` scripts, add `"packs:migrate": "tsx src/knowledge/packs-cli.ts migrate"`.

- [ ] **Step 11: Run the unit tests, then convert the real packs**

Run: `cd backend && npx vitest run tests/okf.test.ts -t "OKF|control bodies|bundles"`
Expected: PASS.

Run: `npm run packs:migrate`
Expected: one line per pack. About 130 `.md` files appear under `backend/packs/{common,food,pharma}/`.

Run: `npx vitest run tests/okf.test.ts`
Expected: PASS, including "the migrated MVP packs".

If a pack fails, fix the converter or parser. **Never hand-edit a generated file to make the test pass.** The test proves the conversion lost nothing.

Then spot-check one control file by eye, for example `packs/pharma/controls/ph-qu-01.md`. It should read like spec §6.2: frontmatter, then the five sections.

- [ ] **Step 12: Run everything and commit**

Run: `npm run typecheck && npm test && npm run eval`
Expected: everything passes, and eval is 25/25. The engine still loads `pack.json` in this task.

```bash
git add backend/package.json backend/package-lock.json backend/src/knowledge/okf backend/src/knowledge/packs-cli.ts backend/src/engine/types.ts backend/src/engine/packs.ts backend/tests/okf.test.ts backend/tests/okf-fixtures.ts backend/packs
git commit -m "Convert the content packs to OKF Markdown bundles with a validating parser"
```

---

### Task 3: Load the registry from the bundles and retire `pack.json`

**Files:**
- Create: `backend/src/knowledge/packs.ts`
- Modify:
  - `backend/src/engine/packs.ts`: drop `loadFromDir`, `DEFAULT_PACKS_DIR` and the `fs`, `path`, `zod` and `migrate-json` imports.
  - `backend/src/knowledge/okf/bundle.ts`: a `pack.json` inside a bundle is now an error.
  - `backend/src/server.ts`, `backend/src/seed.ts`, `backend/src/eval/cli.ts`, `backend/tests/helpers.ts`
  - `backend/tests/engine.test.ts`: pack versions are now `0.2.0`.
  - `backend/tests/okf.test.ts`: the `pack.json` comparison becomes a check of the committed bundles.
- Delete: `backend/packs/common/pack.json`, `backend/packs/food/pack.json`, `backend/packs/pharma/pack.json`

**Interfaces:**
- Consumes:
  - `loadBundles(dir?)`, `bundleToContentPack(b)` and `DEFAULT_PACKS_DIR` (Task 2).
  - `PackRegistry`'s constructor `new PackRegistry(packs: ContentPack[])`, which is unchanged.
- Produces: `registryFromBundles(dir = DEFAULT_PACKS_DIR): PackRegistry`. Task 4 adds `registryFromGraph` to the same file.

- [ ] **Step 1: Replace the `pack.json` comparison with a check of the committed bundles**

In `backend/tests/okf.test.ts`, replace the whole `describe('the migrated MVP packs', …)` block with the block below. Also remove `loadLegacyPack` from the imports, and `DEFAULT_PACKS_DIR` if nothing else uses it.

```ts
describe('the committed MVP bundles', () => {
  const COUNTS = { common: [10, 10, 7], food: [33, 12, 9], pharma: [25, 13, 9] } as const;

  it('load into a registry with every concept, all unverified and due for re-review on 2027-10-11', () => {
    const registry = registryFromBundles();
    expect(registry.list().map((p) => `${p.id}@${p.version}`)).toEqual(['common@0.2.0', 'food@0.2.0', 'pharma@0.2.0']);
    for (const p of registry.list()) {
      expect([p.clauses.length, p.controls.length, p.evalCases.length], p.id).toEqual(COUNTS[p.id as keyof typeof COUNTS]);
      for (const c of [...p.clauses, ...p.controls]) {
        expect(c.trust, c.id).toMatchObject({ verifiedBy: null, status: 'active', staleAfter: '2027-10-11' });
        expect(c.trust!.sourcePath.startsWith(`${p.id}/`)).toBe(true);
      }
      expect(p.clauses.every((c) => c.reviewStatus === 'draft')).toBe(true);
    }
  });

  it('refuses a stray pack.json inside a bundle', () => {
    const root = demoRoot((f) => f.set('pack.json', '{}'));
    expect(() => loadBundle(root, 'demo')).toThrow(/demo\/pack\.json: not part of an OKF bundle/);
  });
});
```

Add `import { registryFromBundles } from '../src/knowledge/packs';`.

The counts are what `pack.json` held at the time of conversion, and the Task 2 test proved the conversion lossless. If the real numbers differ, take them from `git show HEAD:backend/packs/<id>/pack.json` and correct the constants. Never change a bundle to fit the constants.

- [ ] **Step 2: Run the test and make sure it fails**

Run: `cd backend && npx vitest run tests/okf.test.ts`
Expected: FAIL. `../src/knowledge/packs` does not exist.

- [ ] **Step 3: Write `src/knowledge/packs.ts`**

```ts
import { PackRegistry } from '../engine/packs';
import { DEFAULT_PACKS_DIR, loadBundles } from './okf/bundle';
import { bundleToContentPack } from './okf/to-pack';

// Where the engine's PackRegistry comes from. Tests use the bundles on disk; the API and
// the eval CLI read the compiled knowledge graph (registryFromGraph, plan 1E Task 4).

export function registryFromBundles(dir = DEFAULT_PACKS_DIR): PackRegistry {
  return new PackRegistry(loadBundles(dir).map(bundleToContentPack));
}
```

- [ ] **Step 4: Strip file loading from the engine**

In `backend/src/engine/packs.ts`:
- Delete `loadFromDir`, `DEFAULT_PACKS_DIR`, the comment about `pack.json`, and the `fs`, `path` and `LegacyPackSchema` imports.
- Keep the class, its constructor, `add`, `checkReferences` and every query method exactly as they are.
- Replace the top comment with:

```ts
// The loaded content packs, indexed for the engine. Packs are OKF bundles compiled into the
// knowledge graph (src/knowledge); this class only indexes them and checks cross-references.
```

In `backend/src/knowledge/okf/bundle.ts`, delete the two lines that skip `pack.json`, so a leftover `pack.json` becomes a "not part of an OKF bundle" error.

- [ ] **Step 5: Switch every caller**

```bash
cd backend && grep -rn "loadFromDir\|DEFAULT_PACKS_DIR" src tests
```

Change each hit:
- `src/server.ts`:

  ```ts
  const registry = registryFromBundles(config.packsDir);
  ```

  Task 4 replaces this with the graph.
- `src/seed.ts`:

  ```ts
  new AuditService(db, registryFromBundles(), createProvider())
  ```

- `src/eval/cli.ts`:

  ```ts
  const registry = registryFromBundles();
  ```

- `tests/helpers.ts`:

  ```ts
  export const registry = registryFromBundles();
  ```

Each file imports from `./knowledge/packs`, `../knowledge/packs` or `../src/knowledge/packs`, whichever its location needs. After the edits, the grep must list only `src/knowledge/okf/bundle.ts` and `src/knowledge/packs.ts`.

- [ ] **Step 6: Delete the JSON packs and update version expectations**

```bash
git rm backend/packs/common/pack.json backend/packs/food/pack.json backend/packs/pharma/pack.json
grep -rn "'0.1.0'" backend/tests | grep -i pack
```

In `tests/engine.test.ts`, the trail test expects `packVersions` `{ food: '0.1.0', common: '0.1.0' }`. Change it to `'0.2.0'`.

Update any other test that asserts a pack version the same way. Leave alone:
- engine and module versions, such as `ENGINE_VERSION`, `moduleVersion` and `engineVersion`, which stay `0.1.0`;
- fixtures that build their own bundles, such as `tests/trail.test.ts`.

- [ ] **Step 7: Run everything**

Run: `npx vitest run tests/okf.test.ts && npm run typecheck && npm test && npm run eval`
Expected: everything passes, and eval is 25/25. The registry's contents didn't change; only their source did.

If an engine test fails because of ordering, it means some code depended on `pack.json` order. Concepts are now ordered by id (Global Constraints). Fix the test's assumption only if the behaviour is still right, and say so in the report.

- [ ] **Step 8: Commit**

```bash
git add -A backend/src backend/tests backend/packs
git commit -m "Load content packs from the OKF bundles and retire pack.json"
```

---

### Task 4: Compile bundles into the knowledge graph and serve the registry from it

**Files:**
- Create: `backend/src/knowledge/graph/compile.ts`
- Modify:
  - `backend/src/knowledge/packs.ts`: add `registryFromGraph` and `prepareRegistry`.
  - `backend/src/knowledge/packs-cli.ts`: add the `compile` command.
  - `backend/package.json`: add the `packs:compile` script.
  - `backend/src/server.ts`, `backend/src/seed.ts`, `backend/src/eval/cli.ts`
  - `docker-compose.yml`: the `migrate` service also compiles.
- Test: `backend/tests/knowledge-graph.test.ts` (append a `describe('compiling bundles')`)

**Interfaces:**
- Consumes:
  - `Bundle`, `Concept`, `EXTERNAL`, `loadBundle` and `loadBundles` (Task 2).
  - `bundleToContentPack` (Task 2).
  - `chunkText(text)` from `knowledge/chunk.ts`.
  - `appendTrail(trx, bundle)` from `db/trail-repo.ts`.
  - `ENGINE_VERSION` from `service.ts`, imported the same way `knowledge/trail.ts` does.
  - `pendingMigrations(db)`.
  - The test fixtures `demoRoot`, `FIXTURE`, `tmpRoot` and `writeBundle` from `tests/okf-fixtures.ts`.
- Produces:
  - `compilePacks(db: Db, bundles: Bundle[], actor?: string): Promise<CompileResult>`
  - `CompileResult`:

    ```ts
    {
      packs: { packId; version; outcome: 'compiled' | 'unchanged' }[];
      nodes: number;
      edges: number;
      chunks: number;
      deprecated: number;
      trailBundleId: string | null;
    }
    ```

  - `CompileError`, `COMPILE_ACTOR = 'system:packs'`
  - `graphDrift(db: Executor, bundles: Bundle[]): Promise<string[]>`
  - `registryFromGraph(db: Executor, packIds?: string[]): Promise<PackRegistry>`
  - `prepareRegistry(db: Db, bundles: Bundle[], opts: { production: boolean; log?: (line: string) => void }): Promise<PackRegistry>`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/knowledge-graph.test.ts`. Add these imports at the top: `fs`, `path`, `verifyChain`, `readTrail`, `loadBundle` and `loadBundles`, `compilePacks` / `CompileError` / `graphDrift`, `prepareRegistry` / `registryFromBundles` / `registryFromGraph`, and `demoRoot` / `FIXTURE` from `./okf-fixtures`.

```ts
const count = async (db: Kysely<DB>, table: 'kg_nodes' | 'kg_edges' | 'kg_node_versions' | 'chunks' | 'trail') =>
  Number((await db.selectFrom(table).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);

/** Rewrites one file of the demo bundle on disk. */
function edit(root: string, rel: string, change: (text: string) => string) {
  const file = path.join(root, 'demo', rel);
  fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));
}

describe('compiling bundles', () => {
  it('compiles the real packs into a graph the registry can be built from, in one trailed step', async () => {
    const svc = await newService();
    const bundles = loadBundles();
    const r = await compilePacks(svc.db, bundles);
    const concepts = bundles.flatMap((b) => b.concepts);

    expect(r.packs).toEqual(bundles.map((b) => ({ packId: b.packId, version: '0.2.0', outcome: 'compiled' })));
    expect(r.nodes).toBe(concepts.length);
    expect(r.edges).toBe(concepts.reduce((n, c) => n + c.links.length, 0));
    expect(r.edges).toBeGreaterThan(0);
    expect(await count(svc.db.kysely, 'kg_nodes')).toBe(concepts.length);
    expect(await count(svc.db.kysely, 'kg_node_versions')).toBe(concepts.length);

    const chunks = await svc.db.kysely.selectFrom('chunks').selectAll().where('kg_node_id', 'is not', null).execute();
    expect(chunks.length).toBe(r.chunks);
    expect(new Set(chunks.map((c) => c.classification))).toEqual(new Set(['internal']));
    expect(chunks.every((c) => c.engagement_id === null && c.document_id === null)).toBe(true);
    const clauseChunk = chunks.find((c) => c.kg_node_id === 'pharma/clause/21cfr211-22')!;
    expect(clauseChunk.text).toMatch(/^21CFR211\.22: /);
    expect(chunks.some((c) => c.kg_node_id!.includes('/eval_case/') || c.kg_node_id!.includes('/pack/'))).toBe(false);

    expect((await registryFromGraph(svc.db.kysely)).list()).toEqual(registryFromBundles().list());

    const trail = await readTrail(svc.db.kysely);
    const compiled = trail.filter((b) => b.moduleId === 'knowledge:compile');
    expect(compiled).toHaveLength(1);
    expect(compiled[0]).toMatchObject({ id: r.trailBundleId, engagementId: null, actor: 'system:packs', packVersions: { common: '0.2.0', food: '0.2.0', pharma: '0.2.0' } });
    expect(compiled[0].inputs).toEqual({ packs: bundles.map((b) => ({ id: b.packId, version: b.version, sha256: b.sha256 })) });
    expect(verifyChain(trail).valid).toBe(true);
  });

  it('does nothing when the same bundles are compiled again', async () => {
    const svc = await newService();
    const db = svc.db.kysely;
    await compilePacks(svc.db, loadBundles());
    const before = await Promise.all((['kg_nodes', 'kg_edges', 'kg_node_versions', 'chunks', 'trail'] as const).map((t) => count(db, t)));
    const again = await compilePacks(svc.db, loadBundles());
    expect(again.packs.every((p) => p.outcome === 'unchanged')).toBe(true);
    expect(again.trailBundleId).toBeNull();
    expect(await Promise.all((['kg_nodes', 'kg_edges', 'kg_node_versions', 'chunks', 'trail'] as const).map((t) => count(db, t)))).toEqual(before);
  });

  it('refuses content that changed without a version bump and writes nothing', async () => {
    const svc = await newService();
    const db = svc.db.kysely;
    const root = demoRoot();
    await compilePacks(svc.db, [loadBundle(root, 'demo')]);
    const sha = (await db.selectFrom('kg_nodes').select('source_sha256').where('id', '=', 'demo/clause/ds-1').executeTakeFirstOrThrow()).source_sha256;
    const trailBefore = await count(db, 'trail');

    edit(root, 'clauses/ds-1.md', (t) => t.replace('A records policy exists.', 'A records policy exists and is approved.'));
    await expect(compilePacks(svc.db, [loadBundle(root, 'demo')])).rejects.toThrow(
      /demo\/clauses\/ds-1\.md changed after demo@0\.2\.0 was compiled; bump the version in demo\/pack\.md/,
    );
    expect((await db.selectFrom('kg_nodes').select('source_sha256').where('id', '=', 'demo/clause/ds-1').executeTakeFirstOrThrow()).source_sha256).toBe(sha);
    expect(await count(db, 'trail')).toBe(trailBefore);

    const added = demoRoot((f) => f.set('clauses/ds-3.md', f.get('clauses/ds-1.md')!.replace('id: DS-1', 'id: DS-3')));
    await expect(compilePacks(svc.db, [loadBundle(added, 'demo')])).rejects.toThrow(/demo\/clauses\/ds-3\.md was added after demo@0\.2\.0 was compiled/);

    const removed = demoRoot((f) => f.delete('eval/dm-r1.md'));
    await expect(compilePacks(svc.db, [loadBundle(removed, 'demo')])).rejects.toThrow(/demo\/eval_case\/dm-r1 was removed after demo@0\.2\.0 was compiled/);
  });

  it('applies a new version: updates nodes, deprecates removed ones, keeps every version in history', async () => {
    const svc = await newService();
    const db = svc.db.kysely;
    await compilePacks(svc.db, [loadBundle(demoRoot(), 'demo')]);

    const next = demoRoot((f) => {
      f.set('pack.md', f.get('pack.md')!.replace('version: 0.2.0', 'version: 0.3.0'));
      f.set('clauses/ds-1.md', f.get('clauses/ds-1.md')!.replace('A records policy exists.', 'A records retention policy exists.'));
      f.delete('eval/dm-r1.md');
    });
    const r = await compilePacks(svc.db, [loadBundle(next, 'demo')]);
    expect(r.packs).toEqual([{ packId: 'demo', version: '0.3.0', outcome: 'compiled' }]);
    expect(r.deprecated).toBe(1);

    const evalNode = await db.selectFrom('kg_nodes').selectAll().where('id', '=', 'demo/eval_case/dm-r1').executeTakeFirstOrThrow();
    expect(evalNode.status).toBe('deprecated');
    const clause = await db.selectFrom('kg_nodes').selectAll().where('id', '=', 'demo/clause/ds-1').executeTakeFirstOrThrow();
    expect(clause).toMatchObject({ pack_version: '0.3.0', description: 'A records retention policy exists.' });
    const history = await db.selectFrom('kg_node_versions').select('pack_version').where('node_id', '=', 'demo/clause/ds-1').orderBy('pack_version').execute();
    expect(history.map((h) => h.pack_version)).toEqual(['0.2.0', '0.3.0']);
    const chunkText = (await db.selectFrom('chunks').select('text').where('kg_node_id', '=', 'demo/clause/ds-1').execute()).map((c) => c.text).join(' ');
    expect(chunkText).toMatch(/retention/);
    expect((await registryFromGraph(db)).get('demo').evalCases).toEqual([]);
  });

  it('builds a production registry only from a graph that matches the release', async () => {
    const svc = await newService();
    const logs: string[] = [];
    const bundles = [loadBundle(demoRoot(), 'demo')];
    await expect(prepareRegistry(svc.db, bundles, { production: true })).rejects.toThrow(/does not match the content packs in this release:\n {2}- demo: not compiled/);

    const reg = await prepareRegistry(svc.db, bundles, { production: false, log: (l) => logs.push(l) });
    expect(reg.get('demo').clauses.map((c) => c.id)).toEqual(['DS-1', 'DS-2']);
    expect(logs.join()).toMatch(/demo@0\.2\.0 compiled/);
    await prepareRegistry(svc.db, bundles, { production: true });

    const bumped = [loadBundle(demoRoot((f) => f.set('pack.md', f.get('pack.md')!.replace('version: 0.2.0', 'version: 0.2.1'))), 'demo')];
    await expect(prepareRegistry(svc.db, bumped, { production: true })).rejects.toThrow(/demo: the graph has 0\.2\.0, this release has 0\.2\.1/);
    const edited = [loadBundle(demoRoot((f) => f.set('clauses/ds-2.md', f.get('clauses/ds-2.md')!.replace('kept and reviewed', 'kept'))), 'demo')];
    expect(await graphDrift(svc.db.kysely, edited)).toEqual(['demo@0.2.0: 1 concept(s) differ from the graph (first: demo/clauses/ds-2.md)']);
  });

  it('rejects a dangling link before anything is written', async () => {
    const svc = await newService();
    const root = demoRoot((f) => f.set('controls/dm-01.md', f.get('controls/dm-01.md')!.replace('/clauses/ds-1.md', '/clauses/ds-404.md')));
    expect(() => loadBundles(root)).toThrow(/demo\/controls\/dm-01\.md: link "\/clauses\/ds-404\.md"/);
    expect(await count(svc.db.kysely, 'kg_nodes')).toBe(0);
  });
});
```

Notes:
- `count` needs `import type { Kysely } from 'kysely'` and `import type { DB } from '../src/db/schema'`.
- The fixture's `FIXTURE` import is only needed if you assert on it. Drop unused imports.

- [ ] **Step 2: Run the tests and make sure they fail**

Run: `cd backend && npx vitest run tests/knowledge-graph.test.ts`
Expected: FAIL, because `../src/knowledge/graph/compile` does not exist.

- [ ] **Step 3: Write `src/knowledge/graph/compile.ts`**

```ts
import crypto from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Db } from '../../db';
import type { DB } from '../../db/schema';
import { appendTrail, type Executor } from '../../db/trail-repo';
import { ENGINE_VERSION } from '../../service';
import { chunkText } from '../chunk';
import type { Bundle, Concept } from '../okf/bundle';

// Compiles OKF bundles into the knowledge graph (spec §6.3). One transaction for all packs:
// node history first (refusing content changed without a version bump), then the live nodes,
// curated edges and search chunks, then one trail entry. An unchanged pack is skipped entirely.

export class CompileError extends Error {}

export const COMPILE_ACTOR = 'system:packs';
/** Serialises compiles (two dev API processes starting together, or the CLI beside the API). */
const COMPILE_LOCK_KEY = 0x4b4e4f57;
/** Concept types that are searchable; pack headers and eval cases are not. */
const SEARCHABLE: ReadonlySet<Concept['type']> = new Set(['regulation', 'clause', 'control', 'risk']);
const BATCH = 500;

export interface PackCompileResult {
  packId: string;
  version: string;
  outcome: 'compiled' | 'unchanged';
}

export interface CompileResult {
  packs: PackCompileResult[];
  nodes: number;
  edges: number;
  chunks: number;
  deprecated: number;
  trailBundleId: string | null;
}

function nodeRow(b: Bundle, c: Concept) {
  return {
    id: c.nodeId, type: c.type, pack_id: b.packId, pack_version: b.version, concept_id: c.conceptId,
    title: c.title, description: c.description, body: c.body,
    tags: JSON.stringify(c.tags), sources: JSON.stringify(c.sources), attrs: JSON.stringify(c.attrs),
    generated: c.generated ? JSON.stringify(c.generated) : null,
    verified_by: c.verified?.by ?? null, verified_role: c.verified?.role ?? null, verified_at: c.verified?.at ?? null,
    status: c.status, stale_after: c.staleAfter, source_path: c.path, source_sha256: c.sha256, classification: b.classification,
  };
}
/** Every kg_nodes column a recompile overwrites (all but the id). */
const NODE_COLUMNS = [
  'type', 'pack_id', 'pack_version', 'concept_id', 'title', 'description', 'body', 'tags', 'sources', 'attrs', 'generated',
  'verified_by', 'verified_role', 'verified_at', 'status', 'stale_after', 'source_path', 'source_sha256', 'classification',
] as const;

/** What a search finds for a concept: its id and title, the regulation reference, then its text. */
export function searchableText(c: Concept): string {
  const a = c.attrs;
  const label = [a.regulation, a.ref].filter((x): x is string => typeof x === 'string').join(' ');
  return [`${c.conceptId}: ${c.title}`, label, c.description, c.body].filter(Boolean).join('\n\n');
}

async function inBatches<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += BATCH) await insert(rows.slice(i, i + BATCH));
}

/** Refuses a bundle whose content differs from what was compiled before under the same version. */
async function checkHistory(trx: Transaction<DB>, b: Bundle) {
  const recorded = await trx
    .selectFrom('kg_node_versions')
    .select(['node_id', 'source_sha256'])
    .where('pack_version', '=', b.version)
    .where('node_id', 'like', `${b.packId}/%`)
    .execute();
  if (!recorded.length) return new Set<string>();
  const sha = new Map(recorded.map((r) => [r.node_id, r.source_sha256]));
  const bump = `bump the version in ${b.packId}/pack.md`;
  for (const c of b.concepts) {
    const was = sha.get(c.nodeId);
    if (was === undefined) throw new CompileError(`${c.path} was added after ${b.packId}@${b.version} was compiled; ${bump}`);
    if (was !== c.sha256) throw new CompileError(`${c.path} changed after ${b.packId}@${b.version} was compiled; ${bump}`);
  }
  const present = new Set(b.concepts.map((c) => c.nodeId));
  const gone = recorded.find((r) => !present.has(r.node_id));
  if (gone) throw new CompileError(`${gone.node_id} was removed after ${b.packId}@${b.version} was compiled; ${bump}`);
  return new Set(recorded.map((r) => r.node_id));
}

/** True when the live graph already holds exactly this bundle. */
async function isCurrent(trx: Transaction<DB>, b: Bundle): Promise<boolean> {
  const live = await trx.selectFrom('kg_nodes').select(['id', 'pack_version', 'source_sha256', 'status']).where('pack_id', '=', b.packId).execute();
  const byId = new Map(live.map((r) => [r.id, r]));
  const wanted = new Set(b.concepts.map((c) => c.nodeId));
  return (
    b.concepts.every((c) => {
      const r = byId.get(c.nodeId);
      return r && r.pack_version === b.version && r.source_sha256 === c.sha256 && r.status === c.status;
    }) && live.every((r) => wanted.has(r.id) || r.status === 'deprecated')
  );
}

async function compileBundle(trx: Transaction<DB>, b: Bundle, recorded: Set<string>, actor: string) {
  const fresh = b.concepts.filter((c) => !recorded.has(c.nodeId));
  await inBatches(fresh, (batch) =>
    trx.insertInto('kg_node_versions').values(batch.map((c) => ({
      node_id: c.nodeId, pack_version: b.version, source_sha256: c.sha256, snapshot: JSON.stringify(nodeRow(b, c)), compiled_by: actor,
    }))).execute(),
  );

  await inBatches(b.concepts, (batch) =>
    trx
      .insertInto('kg_nodes')
      .values(batch.map((c) => nodeRow(b, c)))
      .onConflict((oc) => oc.column('id').doUpdateSet((eb) => ({
        ...Object.fromEntries(NODE_COLUMNS.map((k) => [k, eb.ref(`excluded.${k}` as never)])),
        compiled_at: sql`now()`,
      }) as never))
      .execute(),
  );

  const ids = b.concepts.map((c) => c.nodeId);
  const dep = await trx.updateTable('kg_nodes').set({ status: 'deprecated' })
    .where('pack_id', '=', b.packId).where('id', 'not in', ids).where('status', '=', 'active').executeTakeFirst();

  const packNodes = trx.selectFrom('kg_nodes').select('id').where('pack_id', '=', b.packId);
  await trx.deleteFrom('kg_edges').where('origin', '=', 'curated').where('from_id', 'in', packNodes).execute();
  const approvedAt = new Date();
  const edges = b.concepts.flatMap((c) => c.links.map((l) => ({
    from_id: c.nodeId, to_id: l.target, rel: l.rel, origin: 'curated' as const, created_by: actor,
    source_ref: JSON.stringify({ path: c.path, ref: l.ref }), approved_by: `git:${b.packId}@${b.version}`, approved_at: approvedAt,
  })));
  await inBatches(edges, (batch) => trx.insertInto('kg_edges').values(batch).execute());

  await trx.deleteFrom('chunks').where('kg_node_id', 'in', packNodes).execute();
  const chunks = b.concepts
    .filter((c) => SEARCHABLE.has(c.type) && c.status === 'active')
    .flatMap((c) => chunkText(searchableText(c)).map((ch) => ({
      id: `KG:${c.nodeId}:${ch.ordinal}`, document_id: null, kg_node_id: c.nodeId, ordinal: ch.ordinal, page: null,
      text: ch.text, classification: b.classification, engagement_id: null,
    })));
  await inBatches(chunks, (batch) => trx.insertInto('chunks').values(batch).execute());

  return { nodes: b.concepts.length, edges: edges.length, chunks: chunks.length, deprecated: Number(dep.numUpdatedRows) };
}

export async function compilePacks(db: Db, bundles: Bundle[], actor = COMPILE_ACTOR): Promise<CompileResult> {
  return db.kysely.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${COMPILE_LOCK_KEY})`.execute(trx);
    const startedAt = new Date().toISOString();
    const result: CompileResult = { packs: [], nodes: 0, edges: 0, chunks: 0, deprecated: 0, trailBundleId: null };
    const compiled: { b: Bundle; counts: Awaited<ReturnType<typeof compileBundle>> }[] = [];

    for (const b of bundles) {
      const recorded = await checkHistory(trx, b);
      if (await isCurrent(trx, b)) {
        result.packs.push({ packId: b.packId, version: b.version, outcome: 'unchanged' });
        continue;
      }
      const counts = await compileBundle(trx, b, recorded, actor);
      compiled.push({ b, counts });
      result.packs.push({ packId: b.packId, version: b.version, outcome: 'compiled' });
      result.nodes += counts.nodes;
      result.edges += counts.edges;
      result.chunks += counts.chunks;
      result.deprecated += counts.deprecated;
    }

    if (compiled.length) {
      const now = new Date().toISOString();
      const sealed = await appendTrail(trx, {
        id: `KG-${crypto.randomBytes(8).toString('hex')}`,
        engagementId: null,
        moduleId: 'knowledge:compile',
        moduleVersion: ENGINE_VERSION,
        engineVersion: ENGINE_VERSION,
        packVersions: Object.fromEntries(compiled.map(({ b }) => [b.packId, b.version])),
        provider: { id: 'system', model: actor },
        promptHash: null,
        actor,
        startedAt,
        finishedAt: now,
        inputs: { packs: compiled.map(({ b }) => ({ id: b.packId, version: b.version, sha256: b.sha256 })) },
        retrievalSet: [],
        executionLog: compiled.map(({ b, counts }) => ({
          at: now, step: 'compile',
          detail: `${b.packId}@${b.version}: ${counts.nodes} nodes, ${counts.edges} edges, ${counts.chunks} chunks, ${counts.deprecated} deprecated`,
        })),
        qaActions: [],
        output: { nodes: result.nodes, edges: result.edges, chunks: result.chunks, deprecated: result.deprecated },
      });
      result.trailBundleId = sealed.id;
    }
    return result;
  });
}

/** Differences between the graph and the bundles in this release; empty when they match. */
export async function graphDrift(db: Executor, bundles: Bundle[]): Promise<string[]> {
  const live = await db.selectFrom('kg_nodes').select(['id', 'pack_version', 'source_sha256', 'status']).execute();
  const byId = new Map(live.map((r) => [r.id, r]));
  const drift: string[] = [];
  for (const b of bundles) {
    const head = byId.get(`${b.packId}/pack/${b.packId}`);
    if (!head) {
      drift.push(`${b.packId}: not compiled`);
      continue;
    }
    if (head.pack_version !== b.version) {
      drift.push(`${b.packId}: the graph has ${head.pack_version}, this release has ${b.version}`);
      continue;
    }
    const differ = b.concepts.filter((c) => {
      const r = byId.get(c.nodeId);
      return !r || r.source_sha256 !== c.sha256 || r.status !== c.status;
    });
    if (differ.length) drift.push(`${b.packId}@${b.version}: ${differ.length} concept(s) differ from the graph (first: ${differ[0].path})`);
  }
  return drift;
}
```

If `ENGINE_VERSION` from `../../service` makes a circular import at load time, move `ENGINE_VERSION` into `src/engine/version.ts` and re-export it from `service.ts`. `knowledge/trail.ts` already imports it from `service`, so check that first.

- [ ] **Step 4: Add `registryFromGraph` and `prepareRegistry` to `src/knowledge/packs.ts`**

```ts
import type { Db } from '../db';
import type { KgNodesTable } from '../db/schema';
import type { Executor } from '../db/trail-repo';
import type { Selectable } from 'kysely';
import { compilePacks, graphDrift } from './graph/compile';
import { EXTERNAL, type Bundle, type Concept } from './okf/bundle';

function rowToConcept(r: Selectable<KgNodesTable>): Concept {
  return {
    nodeId: r.id, type: r.type, packId: r.pack_id, conceptId: r.concept_id, path: r.source_path, sha256: r.source_sha256,
    title: r.title, description: r.description, body: r.body, tags: r.tags, sources: r.sources, attrs: r.attrs,
    generated: r.generated,
    verified: r.verified_by ? { by: r.verified_by, role: r.verified_role!, at: r.verified_at! } : null,
    status: r.status, staleAfter: r.stale_after,
    externalSources: r.sources.map((s) => s.ref).filter((ref) => EXTERNAL.test(ref)),
    links: [],
  };
}

/** The registry the API serves: active concepts of the given packs, as compiled into the graph. */
export async function registryFromGraph(db: Executor, packIds?: string[]): Promise<PackRegistry> {
  if (packIds && !packIds.length) return new PackRegistry([]);
  let q = db.selectFrom('kg_nodes').selectAll().where('status', '=', 'active');
  if (packIds) q = q.where('pack_id', 'in', packIds);
  const rows = await q.execute();
  const byPack = new Map<string, Selectable<KgNodesTable>[]>();
  for (const r of rows) byPack.set(r.pack_id, [...(byPack.get(r.pack_id) ?? []), r]);
  const bundles: Bundle[] = [...byPack.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([packId, nodes]) => {
    const head = nodes.find((n) => n.type === 'pack');
    if (!head) throw new Error(`Knowledge graph has concepts of pack ${packId} but no pack node; run packs:compile`);
    return { packId, version: head.pack_version, classification: head.classification, sha256: '', concepts: nodes.map(rowToConcept) };
  });
  return new PackRegistry(bundles.map(bundleToContentPack));
}

/**
 * Start-up: outside production, compile the bundles (a no-op when unchanged); in production never
 * compile, and refuse to start unless the graph holds exactly the bundles shipped with this release.
 */
export async function prepareRegistry(db: Db, bundles: Bundle[], opts: { production: boolean; log?: (line: string) => void }): Promise<PackRegistry> {
  const log = opts.log ?? console.log;
  if (opts.production) {
    const drift = await graphDrift(db.kysely, bundles);
    if (drift.length) {
      throw new Error(
        `The knowledge graph does not match the content packs in this release:\n  - ${drift.join('\n  - ')}\n` +
          'Run "npm run packs:compile" (in the container: node dist/knowledge/packs-cli.js compile) first; ' +
          'the API never compiles packs in production.',
      );
    }
  } else {
    const r = await compilePacks(db, bundles);
    log(`Content packs: ${r.packs.map((p) => `${p.packId}@${p.version} ${p.outcome}`).join(', ')}`);
  }
  return registryFromGraph(db.kysely, bundles.map((b) => b.packId));
}
```

`DB['kg_nodes']` columns typed `Json<…>` read back as parsed values, so `r.tags`, `r.sources` and `r.attrs` need no `JSON.parse`. The 1082 date parser returns `verified_at` and `stale_after` as `'YYYY-MM-DD'`.

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `cd backend && npx vitest run tests/knowledge-graph.test.ts`
Expected: PASS.

The equality `registryFromGraph(...).list()` = `registryFromBundles().list()` is the proof that the graph holds everything the engine needs. If it fails, compare one clause from each side; the usual culprits are `sourceUrl`, `description` and date formats. Fix the mapping, not the test.

- [ ] **Step 6: The `compile` command, start-up, seed, eval and Compose**

In `packs-cli.ts`:
- Update the header comment to list `compile [--dir <packs dir>]` as "compile the bundles into the knowledge graph (a release step, like migrate)".
- Make `USAGE` `'Usage: packs-cli <compile [--dir <dir>] | migrate [--from <dir>] [--to <dir>]>'`.
- Add the command below, dispatched with `if (command === 'compile') await compileCommand(args);`:

```ts
async function compileCommand(args: string[]) {
  loadDotEnv();
  const config = loadConfig();
  const dir = path.resolve(arg(args, 'dir') ?? config.packsDir ?? DEFAULT_PACKS_DIR);
  const bundles = loadBundles(dir);
  const db = connectPg(config.databaseUrl, { max: 2 });
  try {
    const pending = await pendingMigrations(db);
    if (pending.length) throw new Error(`Database has unapplied migrations (${pending.join(', ')}); run migrate first`);
    const r = await compilePacks(db, bundles);
    for (const p of r.packs) console.log(`${p.packId}@${p.version}: ${p.outcome}`);
    if (r.trailBundleId) console.log(`${r.nodes} nodes, ${r.edges} edges, ${r.chunks} chunks, ${r.deprecated} deprecated; trail ${r.trailBundleId}`);
  } finally {
    await db.close();
  }
}
```

Its imports: `loadConfig` and `loadDotEnv` from `../config`, `connectPg` from `../db`, `pendingMigrations` from `../db/migrate`, `compilePacks` from `./graph/compile`, and `loadBundles` from `./okf/bundle`.

Package script:

```json
"packs:compile": "tsx src/knowledge/packs-cli.ts compile"
```

`src/server.ts`: replace the `registryFromBundles(config.packsDir)` line with:

```ts
  const registry = await prepareRegistry(db, loadBundles(config.packsDir), { production: process.env.NODE_ENV === 'production' });
```

Place it before `createApp`. If it throws, close the database first, the same way the pending-migrations check does; wrap it in `try`/`catch` and rethrow after `await db.close()`.

`src/seed.ts`:

```ts
    const registry = await prepareRegistry(db, loadBundles(), { production: process.env.NODE_ENV === 'production' });
    const svc = new AuditService(db, registry, createProvider());
```

`src/eval/cli.ts`: eval qualifies the registry the API serves, so build it the same way, in a throwaway in-process database:

```ts
  const bundles = loadBundles();
  const graph = await createMemoryDb();
  let registry;
  try {
    await compilePacks(graph, bundles);
    registry = await registryFromGraph(graph.kysely, bundles.map((b) => b.packId));
  } finally {
    await graph.close();
  }
```

`docker-compose.yml`: give the `migrate` service this command:

```yaml
    command: ['sh', '-c', 'node dist/db/cli.js migrate && node dist/knowledge/packs-cli.js compile']
```

Add the comment `# Release steps: apply migrations, then compile the content packs into the knowledge graph.`

`backend/.gitignore` and the Dockerfile need no change, because `packs/` is already copied into the image.

- [ ] **Step 7: Run everything, including the start-up path**

Run: `cd backend && npm run typecheck && npm test && npm run eval`
Expected: everything passes, and eval is 25/25.

Smoke-test the CLI against a throwaway Postgres. Create a root `.env` from `.env.example` if none exists.

```bash
cd .. && docker compose up -d postgres && docker compose run --rm migrate
docker compose run --rm migrate   # second run: every pack "unchanged"
docker compose down -v
```

Expected:
- First run: "Applied …008_knowledge_graph.sql", then three "…@0.2.0: compiled" lines and a trail id.
- Second run: "Database is up to date", then three "unchanged" lines.

Delete any `.env` you created. Never touch the container `structai-test-db`.

- [ ] **Step 8: Commit**

```bash
git add backend/src backend/tests backend/package.json docker-compose.yml
git commit -m "Compile content bundles into the knowledge graph and serve the pack registry from it"
```

---

### Task 5: Trust rules in the citation gates (REQ-22)

**Files:**
- Create: `backend/src/engine/trust.ts`
- Modify:
  - Engine:
    - `backend/src/engine/qa.ts`: `findingCitationGate` takes a `CitationPolicy`.
    - `backend/src/engine/module.ts`: `ModuleContext` carries `policy`.
    - `backend/src/engine/modules/rcm.ts`: trust actions per row.
    - `backend/src/engine/modules/gaps.ts`: passes `ctx.policy`.
    - `backend/src/engine/modules/report.ts`: lists cited sources that aren't citable.
  - Service and app:
    - `backend/src/service.ts`: constructor options and `citationPolicy`.
    - `backend/src/config.ts`: `loadCitationPolicy`.
    - `backend/src/server.ts`, `backend/src/seed.ts`
  - Eval:
    - `backend/src/eval/harness.ts`: `runEval` gets a policy argument; `EvalReport.citationPolicy`.
    - `backend/src/eval/cli.ts`, `backend/src/app.ts`: the `/api/eval` call.
  - Tests:
    - `backend/tests/helpers.ts`: tests allow unverified citations explicitly.
    - `backend/tests/persistence.test.ts` and any other `new AuditService(` in tests.
  - Config and docs:
    - `backend/.env.example`, `docker-compose.yml`: `ALLOW_UNVERIFIED_CITATIONS`.
    - `backend/validation/requirements.json`: add REQ-22.
- Test: `backend/tests/trust.test.ts` (new)

**Interfaces:**
- Consumes:
  - `ConceptTrust` and optional `Clause.trust` / `Control.trust` (Task 2).
  - The registry built from the graph (Task 4).
- Produces:
  - `CitationPolicy { allowUnverified: boolean }` and `STRICT_CITATIONS`.
  - `TrustProblem = 'UNVERIFIED_SOURCE' | 'STALE_SOURCE'`.
  - `todayUtc(now?)`.
  - `trustProblems(trust, today?)` and `isCitable(trust, today?)`.
  - `trustActions(registry, target, { clauseIds, controlId? }, policy, today?): QaAction[]`.
  - `findingCitationGate(registry, finding, allowedClauseIds, policy)`, where `policy` is now required.
  - `new AuditService(db, registry, llm, opts?: { citationPolicy?: CitationPolicy })` and `svc.citationPolicy`.
  - `loadCitationPolicy(env?)`.
  - `runEval(registry, llm, packIds?, policy?)`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/trust.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadCitationPolicy } from '../src/config';
import { PackRegistry } from '../src/engine/packs';
import { isCitable, todayUtc, trustProblems } from '../src/engine/trust';
import type { ConceptTrust } from '../src/engine/types';
import { AuditService } from '../src/service';
import { testDb } from './db';
import { auditor, engagementWithFailedControl, registry } from './helpers';

const base: ConceptTrust = {
  nodeId: 'p/clause/x', verifiedBy: 'Dr Rao', verifiedRole: 'Pharma QA SME', verifiedAt: '2026-10-01',
  status: 'active', staleAfter: '2099-01-01', sourcePath: 'p/clauses/x.md',
};

/** The loaded registry with every clause's and control's trust replaced. */
function withTrust(change: (t: ConceptTrust) => ConceptTrust): PackRegistry {
  return new PackRegistry(registry.list().map((p) => ({
    ...p,
    clauses: p.clauses.map((c) => ({ ...c, trust: change(c.trust!) })),
    controls: p.controls.map((c) => ({ ...c, trust: change(c.trust!) })),
  })));
}
const verified = (t: ConceptTrust): ConceptTrust => ({ ...t, verifiedBy: 'Dr Rao', verifiedRole: 'Pharma QA SME', verifiedAt: '2026-10-01', staleAfter: '2099-01-01' });
const strict = async (reg = registry) => new AuditService(await testDb(), reg, null);
const trustGates = (actions: { gate: string }[]) => actions.filter((a) => a.gate === 'trust');

describe('trust rules [REQ-22]', () => {
  it('cites only verified, active knowledge that is not due for re-review [REQ-22]', () => {
    const today = '2026-10-11';
    expect(trustProblems(base, today)).toEqual([]);
    expect(isCitable(base, today)).toBe(true);
    expect(trustProblems({ ...base, verifiedBy: null, verifiedRole: null, verifiedAt: null }, today)).toEqual(['UNVERIFIED_SOURCE']);
    expect(trustProblems({ ...base, status: 'deprecated' }, today)).toEqual(['UNVERIFIED_SOURCE']);
    expect(trustProblems({ ...base, staleAfter: today }, today)).toEqual(['STALE_SOURCE']);
    expect(trustProblems({ ...base, staleAfter: null }, today)).toEqual([]);
    expect(trustProblems(undefined, today)).toEqual(['UNVERIFIED_SOURCE']);
    expect(todayUtc(new Date('2026-10-11T23:30:00-05:00'))).toBe('2026-10-12');
  });

  it('blocks a finding that cites unverified knowledge unless unverified citations are allowed [REQ-22]', async () => {
    const svc = await strict();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    expect(f.status).toBe('blocked');
    expect(f.blockedReasons.join(' ')).toMatch(/UNVERIFIED_SOURCE: .*FD-HACCP-03/);

    const trail = await svc.trailFor(e.id);
    const gaps = trail.find((b) => b.moduleId === 'gaps')!;
    expect(trustGates(gaps.qaActions)).toEqual([expect.objectContaining({ outcome: 'fail', action: 'blocked', detail: expect.stringMatching(/^UNVERIFIED_SOURCE: /) })]);
    const rcm = trail.find((b) => b.moduleId === 'rcm')!;
    expect(trustGates(rcm.qaActions).every((a) => a.action === 'blocked')).toBe(true);
    expect(trustGates(rcm.qaActions).length).toBeGreaterThan(0);
  });

  it('flags unverified knowledge instead when allowed outside production [REQ-22]', async () => {
    const svc = new AuditService(await testDb(), registry, null, { citationPolicy: { allowUnverified: true } });
    const e = await engagementWithFailedControl(svc);
    expect(e.findings[0].status).toBe('draft');
    const gaps = (await svc.trailFor(e.id)).find((b) => b.moduleId === 'gaps')!;
    expect(trustGates(gaps.qaActions)).toEqual([expect.objectContaining({ outcome: 'warn', action: 'flagged', detail: expect.stringMatching(/^UNVERIFIED_SOURCE: .*allowed outside production/) })]);
  });

  it('releases a finding that cites verified knowledge, and only flags stale knowledge [REQ-22]', async () => {
    const ok = await strict(withTrust(verified));
    const e = await engagementWithFailedControl(ok);
    expect(e.findings[0].status).toBe('draft');
    expect(trustGates((await ok.trailFor(e.id)).find((b) => b.moduleId === 'gaps')!.qaActions)).toEqual([expect.objectContaining({ outcome: 'pass' })]);

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const stale = await strict(withTrust((t) => ({ ...verified(t), staleAfter: yesterday })));
    const s = await engagementWithFailedControl(stale);
    expect(s.findings[0].status).toBe('draft');
    expect(trustGates((await stale.trailFor(s.id)).find((b) => b.moduleId === 'gaps')!.qaActions)).toEqual([
      expect.objectContaining({ outcome: 'warn', action: 'flagged', detail: expect.stringMatching(/^STALE_SOURCE: .*past re-review date/) }),
    ]);
  });

  it('applies the rules to human edits too [REQ-22]', async () => {
    const lenient = new AuditService(await testDb(), registry, null, { citationPolicy: { allowUnverified: true } });
    const e = await engagementWithFailedControl(lenient);
    const strictSameDb = new AuditService(lenient.db, registry, null);
    const edited = await strictSameDb.editFinding(e.id, e.findings[0].id, { title: 'Edited title' }, auditor);
    expect(edited.status).toBe('blocked');
    expect(edited.blockedReasons.join(' ')).toMatch(/UNVERIFIED_SOURCE/);
  });

  it('refuses ALLOW_UNVERIFIED_CITATIONS in production and anything but true or false [REQ-22]', () => {
    expect(loadCitationPolicy({})).toEqual({ allowUnverified: false });
    expect(loadCitationPolicy({ ALLOW_UNVERIFIED_CITATIONS: 'true', NODE_ENV: 'development' })).toEqual({ allowUnverified: true });
    expect(() => loadCitationPolicy({ ALLOW_UNVERIFIED_CITATIONS: 'true', NODE_ENV: 'production' })).toThrow(/ALLOW_UNVERIFIED_CITATIONS: must not be true in production/);
    expect(() => loadCitationPolicy({ ALLOW_UNVERIFIED_CITATIONS: 'yes' })).toThrow(/ALLOW_UNVERIFIED_CITATIONS: must be "true" or "false"/);
  });
});
```

- [ ] **Step 2: Run the tests and make sure they fail**

Run: `cd backend && npx vitest run tests/trust.test.ts`
Expected: FAIL, because `../src/engine/trust` does not exist.

- [ ] **Step 3: Write `src/engine/trust.ts`**

```ts
import type { PackRegistry } from './packs';
import type { ConceptTrust, QaAction } from './types';

// Trust rules for citing library knowledge (spec §6.4, REQ-22). A clause or control is citable only
// when a person has verified it, it is active, and its re-review date has not arrived. Unverified
// sources block release unless the policy allows them (outside production only); stale ones are flagged.

export interface CitationPolicy {
  /** ALLOW_UNVERIFIED_CITATIONS: flag instead of block. Refused in production (config.ts). */
  allowUnverified: boolean;
}

export const STRICT_CITATIONS: CitationPolicy = { allowUnverified: false };

export type TrustProblem = 'UNVERIFIED_SOURCE' | 'STALE_SOURCE';

/** Today's date in UTC, 'YYYY-MM-DD'. */
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

export function trustProblems(trust: ConceptTrust | undefined, today = todayUtc()): TrustProblem[] {
  const problems: TrustProblem[] = [];
  if (!trust?.verifiedBy || trust.status !== 'active') problems.push('UNVERIFIED_SOURCE');
  if (trust?.staleAfter && trust.staleAfter <= today) problems.push('STALE_SOURCE');
  return problems;
}

export const isCitable = (trust: ConceptTrust | undefined, today = todayUtc()) => trustProblems(trust, today).length === 0;

/** Gate actions for the clauses (and control) one finding or RCM row cites. */
export function trustActions(
  registry: PackRegistry,
  target: string,
  cited: { clauseIds: string[]; controlId?: string },
  policy: CitationPolicy,
  today = todayUtc(),
): QaAction[] {
  const sources: { id: string; trust: ConceptTrust | undefined }[] = [];
  for (const id of new Set(cited.clauseIds)) {
    const c = registry.clauses.get(id);
    if (c) sources.push({ id, trust: c.trust });
  }
  const control = cited.controlId ? registry.controls.get(cited.controlId) : undefined;
  if (control) sources.push({ id: control.id, trust: control.trust });
  if (!sources.length) return [];

  const having = (p: TrustProblem) => sources.filter((s) => trustProblems(s.trust, today).includes(p)).map((s) => s.id);
  const unverified = having('UNVERIFIED_SOURCE');
  const stale = having('STALE_SOURCE');
  const actions: QaAction[] = [];
  if (unverified.length) {
    actions.push(policy.allowUnverified
      ? { gate: 'trust', outcome: 'warn', target, detail: `UNVERIFIED_SOURCE: ${unverified.join(', ')} not yet verified by a reviewer (allowed outside production)`, action: 'flagged' }
      : { gate: 'trust', outcome: 'fail', target, detail: `UNVERIFIED_SOURCE: ${unverified.join(', ')} not verified by a reviewer`, action: 'blocked' });
  }
  if (stale.length) {
    actions.push({ gate: 'trust', outcome: 'warn', target, detail: `STALE_SOURCE: ${stale.join(', ')} past re-review date`, action: 'flagged' });
  }
  if (!actions.length) actions.push({ gate: 'trust', outcome: 'pass', target, detail: `${sources.length} source(s) verified and current`, action: 'none' });
  return actions;
}
```

- [ ] **Step 4: Apply the rules in the gates and modules**

`src/engine/qa.ts`, in `findingCitationGate`:
- Add the required parameter `policy: CitationPolicy` after `allowedClauseIds`.
- Compute the trust actions before the `if (reasons.length)` check, and turn a blocking one into a reason:

```ts
  const trust = trustActions(
    registry,
    finding.id,
    { clauseIds: finding.citations.map((c) => c.clauseId), controlId: finding.controlId },
    policy,
  );
  reasons.push(...trust.filter((a) => a.action === 'blocked').map((a) => a.detail));
```

Then return `[...actions, ...trust]` in both the blocked and the passing branch:
- The blocked branch currently returns `actions` holding the `triple-citation` fail; make it `actions: [...actions, ...trust]`.
- The passing branch keeps its `triple-citation` pass and `criteria-traceability` warn, followed by the trust actions.
- Update the doc comment: "…(4) every cited clause and the control are citable under the trust rules (REQ-22); an unverified source blocks release unless the policy allows it."

`src/engine/module.ts`:
- Add `readonly policy: CitationPolicy` as the last constructor parameter of `ModuleContext`.
- Import the type from `./trust`.

`src/engine/modules/rcm.ts`: next to `const action = rcmCitationGate(ctx.registry, r); ctx.gate(action);`, add:

```ts
      ctx.gate(...trustActions(ctx.registry, r.id, { clauseIds: r.citations.map((c) => c.clauseId), controlId: r.controlId }, ctx.policy));
```

`src/engine/modules/gaps.ts`: pass `ctx.policy` as the fourth argument of `findingCitationGate`.

`src/engine/modules/report.ts`: replace the `draftClauses` collection with:

```ts
    const notCitable = new Set<string>();
    e.rcm.forEach((r) => r.citations.forEach((c) => trustProblems(ctx.registry.clauses.get(c.clauseId)?.trust).length && notCitable.add(c.clauseId)));
```

Change its line in the report to:

```ts
      `Cited sources not yet verified by a reviewer or due for re-review (${notCitable.size}): ${[...notCitable].join(', ') || 'none'}.`,
```

Then grep the tests for `pending domain-expert review` and `marked draft`, and update any matching expectation.

- [ ] **Step 5: Plumb the policy through the service, config, eval and start-up**

`src/service.ts`:

```ts
export interface ServiceOptions {
  /** Defaults to STRICT_CITATIONS: unverified knowledge blocks release. */
  citationPolicy?: CitationPolicy;
}
// in the class:
  readonly citationPolicy: CitationPolicy;
  constructor(readonly db: Db, readonly registry: PackRegistry, readonly llm: LlmProvider | null, opts: ServiceOptions = {}) {
    this.citationPolicy = opts.citationPolicy ?? STRICT_CITATIONS;
    // …existing grounding set-up
  }
```

Then:
- Pass `this.citationPolicy` as the last argument to `new ModuleContext(…)` in `runModule`.
- Pass it as the fourth argument to `findingCitationGate` in `applyFindingEdit`.

`src/config.ts`:

```ts
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
```

`src/server.ts`:
- Call `const citationPolicy = loadCitationPolicy();` next to `loadConfig()`, so it fails before any connection is made.
- Construct the service with `new AuditService(db, registry, createProvider(), { citationPolicy })`.
- When `citationPolicy.allowUnverified` is true, `console.warn('ALLOW_UNVERIFIED_CITATIONS is on: findings may cite knowledge no reviewer has verified (flagged, not blocked). Never use this in production.')`.

`src/seed.ts`: the same `loadCitationPolicy()` and `{ citationPolicy }`.

`src/eval/harness.ts`:
- The signature becomes `runEval(registry, llm, packIds?: string[], policy: CitationPolicy = STRICT_CITATIONS)`.
- Pass `{ citationPolicy: policy }` to its `AuditService`.
- Add `citationPolicy?: CitationPolicy` to `EvalReport` (optional, because stored reports predate it) and set it in the returned report.
- In `evalMarkdown`, after the Engine line, add:

  ```ts
  `- Unverified citations: ${r.citationPolicy?.allowUnverified ? 'allowed with a warning (not valid for release)' : 'blocked'}`
  ```

`src/eval/cli.ts`:
- Call `loadDotEnv()` first.
- Pass `loadCitationPolicy()` as the fourth argument.

`src/app.ts`: `runEval(svc.registry, svc.llm, undefined, svc.citationPolicy)`.

`tests/helpers.ts`:

```ts
/**
 * The MVP packs are not yet expert-verified, so tests run the way demos do: unverified knowledge is
 * cited with a warning. tests/trust.test.ts covers the strict default.
 */
export const LENIENT = { citationPolicy: { allowUnverified: true } } as const;
export async function newService(llm: LlmProvider | null = null) {
  return new AuditService(await testDb(), registry, llm, LENIENT);
}
```

Give every other `new AuditService(` in `tests/`, such as `persistence.test.ts`, the same `LENIENT` options, unless it is in `trust.test.ts`. If an eval test calls `runEval`, pass `{ allowUnverified: true }` as its policy.

`backend/.env.example`: after the storage section, add:

```
# Knowledge trust rules (spec §6.4). Until a domain expert verifies the content packs, findings may
# cite unverified knowledge only when this is true; it is then flagged, not blocked. Refused in production.
ALLOW_UNVERIFIED_CITATIONS=true
```

`docker-compose.yml`, backend `environment`: add `ALLOW_UNVERIFIED_CITATIONS: 'true'`, with the comment `# Demo only: the packs are unreviewed drafts (refused when NODE_ENV=production)`.

`backend/validation/requirements.json`: append

```json
{ "id": "REQ-22", "risk": "High", "text": "Only human-verified, active, non-stale knowledge nodes are citable in released outputs; unverified sources block release unless explicitly allowed outside production, and stale sources are flagged.", "evalKinds": [] }
```

Match the file's existing formatting.

- [ ] **Step 6: Run everything**

Run: `cd backend && npx vitest run tests/trust.test.ts && npm run typecheck && npm test`
Expected: PASS.

Some engine tests may count QA actions or match whole `qaActions` arrays. With the lenient policy they now also see `trust` warnings. Update such expectations to include them, rather than filtering them out of the engine.

Run: `ALLOW_UNVERIFIED_CITATIONS=true npm run eval`
Expected: 25/25, with "Unverified citations: allowed with a warning" in the header.

Run: `npm run eval` with the variable unset and no `backend/.env`.
Expected: the gaps cases now fail, because their findings are blocked. That is correct: unverified content can't be qualified for release. Note the numbers in the report.

Run: `npm run traceability`
Expected: 23/23, with REQ-22 traced to `tests/trust.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add backend/src backend/tests backend/.env.example backend/validation/requirements.json docker-compose.yml
git commit -m "Block citations of unverified knowledge and flag stale knowledge in the QA gates (REQ-22)"
```

---

### Task 6: Knowledge-graph hits in search, with a trust-rule `citable` flag

**Files:**
- Modify:
  - `backend/src/knowledge/retriever.ts`: `Hit` becomes a union of document and node hits; the query left-joins `documents` and `kg_nodes`.
  - `backend/tests/retrieval.test.ts`: `docsFound` narrows to document hits; append knowledge-graph tests.
- Test: `backend/tests/retrieval.test.ts`

**Interfaces:**
- Consumes:
  - `trustProblems` and `todayUtc` (Task 5).
  - `compilePacks` (Task 4), `loadBundle` / `loadBundles` (Task 2).
  - `registry` and `newService` from `tests/helpers.ts`.
  - `demoRoot` from `tests/okf-fixtures.ts`.
- Produces:
  - `NodeCitation { nodeId; conceptId; packId; packVersion; sourcePath; chunkOrdinal }`.
  - `Hit = DocumentHit | NodeHit`. `NodeHit` has `kind: 'kg_node'` and `trustProblems: TrustProblem[]`. `DocumentHit` keeps `kind: 'chunk'`.
  - `RetrievalScope.kinds` containing `'okf_concept'` selects knowledge-graph nodes. Without `kinds`, both documents and nodes are searched.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/retrieval.test.ts`, make `docsFound` ignore node hits:

```ts
  const docsFound = async (user: typeof auditor, opts: { engagementId?: string; kinds?: DocumentKind[] } = {}) =>
    (await new PgFtsRetriever(svc.db.kysely).search('allergen', { user, ...opts }))
      .flatMap((h) => (h.kind === 'chunk' ? [h.citation.documentId] : []))
      .sort();
```

Append the block below. It needs these imports: `compilePacks` from `../src/knowledge/graph/compile`; `loadBundle` and `loadBundles` from `../src/knowledge/okf/bundle`; `registry` from `./helpers`; and `demoRoot` from `./okf-fixtures`.

```ts
describe('knowledge-graph hits', () => {
  let svc: AuditService;
  const search = (q: string, user: typeof auditor, kinds?: DocumentKind[]) => new PgFtsRetriever(svc.db.kysely).search(q, { user, kinds });

  beforeAll(async () => {
    svc = await newService();
    await compilePacks(svc.db, loadBundles());
  });

  it('finds library concepts with a citation to the bundle file and says they are not yet citable [REQ-22]', async () => {
    const clause = registry.clauses.get('21CFR211.22')!;
    const hits = await search(clause.title, viewer);
    const hit = hits.find((h) => h.kind === 'kg_node' && h.citation.conceptId === '21CFR211.22');
    expect(hit).toMatchObject({
      kind: 'kg_node', citable: false, trustProblems: ['UNVERIFIED_SOURCE'],
      citation: { nodeId: 'pharma/clause/21cfr211-22', packId: 'pharma', packVersion: '0.2.0', sourcePath: 'pharma/clauses/21cfr211-22.md', chunkOrdinal: 0 },
    });
    expect(hit!.title).toBe(`21CFR211.22 — ${clause.title}`);
    expect(await search(clause.title, admin)).toEqual([]);
  });

  it('selects knowledge-graph nodes with the okf_concept kind', async () => {
    const clause = registry.clauses.get('21CFR211.22')!;
    expect((await search(clause.title, auditor, ['sop'])).some((h) => h.kind === 'kg_node')).toBe(false);
    const only = await search(clause.title, auditor, ['okf_concept']);
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((h) => h.kind === 'kg_node')).toBe(true);
  });

  it('applies classification to knowledge-graph nodes too [REQ-23]', async () => {
    const restricted = demoRoot((f) => f.set('pack.md', f.get('pack.md')!.replace('classification: internal', 'classification: restricted')));
    await compilePacks(svc.db, [loadBundle(restricted, 'demo')]);
    const demoHits = async (user: typeof auditor) => (await search('records policy', user)).filter((h) => h.kind === 'kg_node' && h.citation.packId === 'demo');
    expect(await demoHits(viewer)).toEqual([]);
    expect(await demoHits(auditor)).toEqual([]);
    expect((await demoHits(reviewer)).length).toBeGreaterThan(0);
  });

  it('marks a verified, current concept citable and never returns deprecated ones [REQ-22]', async () => {
    const own = await newService();
    const v1 = demoRoot((f) => f.set('clauses/ds-1.md', f.get('clauses/ds-1.md')!.replace('verified: null', 'verified:\n  by: Dr Rao\n  role: QA SME\n  at: 2026-10-01')));
    await compilePacks(own.db, [loadBundle(v1, 'demo')]);
    const policy = (await new PgFtsRetriever(own.db.kysely).search('records policy', { user: auditor })).find((h) => h.kind === 'kg_node' && h.citation.conceptId === 'DS-1');
    expect(policy).toMatchObject({ citable: true, trustProblems: [] });

    const v2 = demoRoot((f) => {
      f.set('pack.md', f.get('pack.md')!.replace('version: 0.2.0', 'version: 0.3.0'));
      f.delete('clauses/ds-1.md');
      f.set('controls/dm-01.md', f.get('controls/dm-01.md')!.replace(/  - ref: \/clauses\/ds-1\.md\n/, '').replace(/    - DS-1\n/, ''));
    });
    await compilePacks(own.db, [loadBundle(v2, 'demo')]);
    const after = await new PgFtsRetriever(own.db.kysely).search('records policy exists', { user: auditor });
    expect(after.some((h) => h.kind === 'kg_node' && h.citation.conceptId === 'DS-1')).toBe(false);
  });
});
```

Notes:
- If `21CFR211.22` is not a pharma clause, take any pharma clause id from `registry`.

- [ ] **Step 2: Run the tests and make sure they fail**

Run: `cd backend && npx vitest run tests/retrieval.test.ts`
Expected: FAIL. The new tests return no `kg_node` hits, because the current query inner-joins `documents`, and `trustProblems` is undefined.

- [ ] **Step 3: Rewrite the retriever's result types and query**

In `backend/src/knowledge/retriever.ts`, replace `Hit` and add `NodeCitation`:

```ts
export interface NodeCitation {
  /** Knowledge-graph node, e.g. "pharma/clause/21cfr211-22". */
  nodeId: string;
  /** The id findings cite, e.g. "21CFR211.22". */
  conceptId: string;
  packId: string;
  packVersion: string;
  /** Bundle file, e.g. "pharma/clauses/21cfr211-22.md". */
  sourcePath: string;
  chunkOrdinal: number;
}

interface HitBase {
  id: string;
  title: string;
  snippet: string;
  score: number;
  /** Whether a finding may cite this hit (knowledge-graph nodes: the trust rules, spec §6.4). */
  citable: boolean;
}
export interface DocumentHit extends HitBase {
  kind: 'chunk';
  citation: DocumentCitation;
}
export interface NodeHit extends HitBase {
  kind: 'kg_node';
  citation: NodeCitation;
  /** Why the node is not citable; empty when it is. */
  trustProblems: TrustProblem[];
}
export type Hit = DocumentHit | NodeHit;
```

`RetrievalScope.kinds` keeps the type `readonly DocumentKind[]`. Document its new meaning: "Document kinds to search; 'okf_concept' also selects knowledge-graph nodes. Omit to search all documents and nodes."

Replace the query and mapping in `PgFtsRetriever.search`:

```ts
    const kinds = scope.kinds?.length ? scope.kinds : null;
    const docKinds = kinds ? sql`AND d.kind IN (${sql.join([...kinds])})` : sql``;
    const nodeKinds = kinds && !kinds.includes('okf_concept') ? sql`AND false` : sql``;

    const { rows } = await sql<{
      id: string; document_id: string | null; kg_node_id: string | null; ordinal: number; page: number | null; filename: string | null;
      node_title: string | null; concept_id: string | null; pack_id: string | null; pack_version: string | null; source_path: string | null;
      verified_by: string | null; verified_role: string | null; verified_at: string | null; node_status: 'active' | 'deprecated' | null;
      stale_after: string | null; score: number; snippet: string;
    }>`
      SELECT c.id, c.document_id, c.kg_node_id, c.ordinal, c.page, d.filename,
             n.title AS node_title, n.concept_id, n.pack_id, n.pack_version, n.source_path,
             n.verified_by, n.verified_role, n.verified_at, n.status AS node_status, n.stale_after,
             ts_rank(c.tsv, q) AS score,
             ts_headline('english', c.text, q, 'MaxWords=35, MinWords=12, ShortWord=3') AS snippet
      FROM chunks c
      LEFT JOIN documents d ON d.id = c.document_id
      LEFT JOIN kg_nodes n ON n.id = c.kg_node_id,
           websearch_to_tsquery('english', ${query}) q
      WHERE c.tsv @@ q
        AND c.classification IN (${classes})
        AND ${inScope(sql.ref('c.engagement_id'))}
        AND (
              (d.id IS NOT NULL AND d.classification IN (${classes}) AND ${inScope(sql.ref('d.engagement_id'))}
                AND d.retention_expired = false ${docKinds})
           OR (n.id IS NOT NULL AND n.status = 'active' AND n.classification IN (${classes}) ${nodeKinds})
        )
      ORDER BY score DESC, c.id
      LIMIT ${limit}`.execute(this.db);

    const today = todayUtc();
    return rows.map((r): Hit => {
      if (r.kg_node_id) {
        const problems = trustProblems({
          nodeId: r.kg_node_id, verifiedBy: r.verified_by, verifiedRole: r.verified_role, verifiedAt: r.verified_at,
          status: r.node_status!, staleAfter: r.stale_after, sourcePath: r.source_path!,
        }, today);
        return {
          id: r.id, kind: 'kg_node', title: `${r.concept_id} — ${r.node_title}`, snippet: r.snippet, score: Number(r.score),
          citable: problems.length === 0, trustProblems: problems,
          citation: { nodeId: r.kg_node_id, conceptId: r.concept_id!, packId: r.pack_id!, packVersion: r.pack_version!, sourcePath: r.source_path!, chunkOrdinal: r.ordinal },
        };
      }
      return {
        id: r.id, kind: 'chunk', title: r.filename!, snippet: r.snippet, score: Number(r.score), citable: true,
        citation: { documentId: r.document_id!, filename: r.filename!, page: r.page, chunkOrdinal: r.ordinal },
      };
    });
```

Delete the old `kindFilter`.

Update the class comment:

> Postgres full-text search over document chunks and knowledge-graph chunks. Permission filtering happens inside the query, so text a user may not read never leaves the database, not even in a snippet. Documents are checked against their documents row (classification, engagement, retention); knowledge-graph nodes against their kg_nodes row (classification, active).

Import `todayUtc`, `trustProblems` and `TrustProblem` from `../engine/trust`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run tests/retrieval.test.ts tests/documents-http.test.ts && npm run typecheck`
Expected: PASS. The 1D document tests must pass unchanged, apart from the `docsFound` narrowing.

Run: `cd ../frontend && npm run build`
Expected: PASS. The frontend doesn't call `/api/knowledge/search` yet; if it does, narrow on `kind`.

- [ ] **Step 5: Run everything and commit**

Run: `cd ../backend && npm test && ALLOW_UNVERIFIED_CITATIONS=true npm run eval && npm run traceability`
Expected: PASS, 25/25, 23/23.

```bash
git add backend/src/knowledge/retriever.ts backend/tests/retrieval.test.ts
git commit -m "Search knowledge-graph concepts alongside documents, with trust-rule citability"
```

---

### Task 7: Due-for-re-review list, library trust columns and documentation

**Files:**
- Create: `backend/src/knowledge/graph/due.ts`
- Modify:
  - `backend/src/auth/admin-routes.ts`: add `GET /api/admin/knowledge/due`.
  - `frontend/src/pages/LibraryPage.tsx`: verification, re-review date and source file for clauses and controls.
  - `frontend/src/pages/AdminPage.tsx`: a "Knowledge due for re-review" card.
  - `README.md`: rewrite "Adding a sector or regulation"; mention `packs:compile` in the quick start and Checks; add a knowledge section.
- Test: `backend/tests/admin.test.ts` (append)

**Interfaces:**
- Consumes:
  - `kg_nodes` (Task 1), `compilePacks` and `loadBundle(s)` (Tasks 2 and 4), `todayUtc` (Task 5).
  - `ConceptTrust` on `Clause` and `Control` (Task 2); `/api/packs/:id` already returns it.
  - `appWithDevUsers` and `signIn` from `tests/http.ts`; `demoRoot` from `tests/okf-fixtures.ts`.
- Produces:
  - `knowledgeDue(db: Executor, today?: string): Promise<DueConcept[]>`, where `DueConcept` is:

    ```ts
    {
      nodeId; conceptId; type; packId; packVersion; title; sourcePath;
      verifiedBy: string | null;
      verifiedAt: string | null;
      staleAfter: string | null;
      reasons: ('unverified' | 'stale')[];
    }
    ```

  - `GET /api/admin/knowledge/due`, admin only.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/admin.test.ts`. Add these imports: `compilePacks` from `../src/knowledge/graph/compile`, `loadBundle` from `../src/knowledge/okf/bundle`, and `demoRoot` from `./okf-fixtures`.

```ts
describe('knowledge due for re-review', () => {
  it('lists unverified and stale concepts for admins, metadata only [REQ-22]', async () => {
    const { app, svc } = await appWithDevUsers();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const verify = (text: string, staleAfter: string) =>
      text.replace('verified: null', 'verified:\n  by: Dr Rao\n  role: QA SME\n  at: 2026-10-01').replace(/stale_after: .*/, `stale_after: ${staleAfter}`);
    const root = demoRoot((f) => {
      f.set('clauses/ds-1.md', verify(f.get('clauses/ds-1.md')!, '2099-01-01'));
      f.set('clauses/ds-2.md', verify(f.get('clauses/ds-2.md')!, yesterday));
    });
    await compilePacks(svc.db, [loadBundle(root, 'demo')]);

    for (const id of ['auditor', 'reviewer', 'approver', 'viewer']) {
      expect((await (await signIn(app, id)).get('/api/admin/knowledge/due')).status).toBe(403);
    }
    const due = (await (await signIn(app, 'admin')).get('/api/admin/knowledge/due').expect(200)).body;
    expect(due).toEqual([
      { nodeId: 'demo/clause/ds-2', conceptId: 'DS-2', type: 'clause', packId: 'demo', packVersion: '0.2.0', title: 'Records',
        sourcePath: 'demo/clauses/ds-2.md', verifiedBy: 'Dr Rao', verifiedAt: '2026-10-01', staleAfter: yesterday, reasons: ['stale'] },
      { nodeId: 'demo/control/dm-01', conceptId: 'DM-01', type: 'control', packId: 'demo', packVersion: '0.2.0', title: 'Records are reviewed',
        sourcePath: 'demo/controls/dm-01.md', verifiedBy: null, verifiedAt: null, staleAfter: '2027-10-11', reasons: ['unverified'] },
    ]);
    // Admins manage access, not audit content: no bodies, descriptions or attributes.
    expect(Object.keys(due[0]).sort()).toEqual(['conceptId', 'nodeId', 'packId', 'packVersion', 'reasons', 'sourcePath', 'staleAfter', 'title', 'type', 'verifiedAt', 'verifiedBy']);
  });
});
```

`DS-1` is verified and current, so it is absent. Pack and eval-case nodes are never listed.

- [ ] **Step 2: Run the test and make sure it fails**

Run: `cd backend && npx vitest run tests/admin.test.ts -t "re-review"`
Expected: FAIL with 404 on `/api/admin/knowledge/due`.

- [ ] **Step 3: Write `src/knowledge/graph/due.ts` and the route**

```ts
import type { Executor } from '../../db/trail-repo';
import { todayUtc } from '../../engine/trust';

// The "due for re-review" list (spec §6.4, §9): active library concepts nobody has verified yet,
// or whose re-review date has arrived. Metadata only, so administrators see no audit content.

export interface DueConcept {
  nodeId: string;
  conceptId: string;
  type: string;
  packId: string;
  packVersion: string;
  title: string;
  sourcePath: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  staleAfter: string | null;
  reasons: ('unverified' | 'stale')[];
}

export async function knowledgeDue(db: Executor, today = todayUtc()): Promise<DueConcept[]> {
  const rows = await db
    .selectFrom('kg_nodes')
    .select(['id', 'concept_id', 'type', 'pack_id', 'pack_version', 'title', 'source_path', 'verified_by', 'verified_at', 'stale_after'])
    .where('status', '=', 'active')
    .where('type', 'in', ['regulation', 'clause', 'control', 'risk'])
    .where((eb) => eb.or([eb('verified_by', 'is', null), eb('stale_after', '<=', today)]))
    .orderBy('pack_id').orderBy('type').orderBy('concept_id')
    .execute();
  return rows.map((r) => ({
    nodeId: r.id, conceptId: r.concept_id, type: r.type, packId: r.pack_id, packVersion: r.pack_version, title: r.title,
    sourcePath: r.source_path, verifiedBy: r.verified_by, verifiedAt: r.verified_at, staleAfter: r.stale_after,
    reasons: [
      ...(r.verified_by ? [] : (['unverified'] as const)),
      ...(r.stale_after && r.stale_after <= today ? (['stale'] as const) : []),
    ],
  }));
}
```

In `src/auth/admin-routes.ts`, after `/api/admin/settings`, add:

```ts
  // Library concepts awaiting expert verification or re-review: ids, titles and dates only.
  r.get('/api/admin/knowledge/due', wrap(async (_req, res) => res.json(await knowledgeDue(db.kysely))));
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `npx vitest run tests/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Library and admin pages**

`frontend/src/pages/LibraryPage.tsx`:
- Add a small component in the same file:

```tsx
function TrustCell({ trust }: { trust?: ConceptTrust }) {
  if (!trust) return <TableCell>—</TableCell>;
  const today = new Date().toISOString().slice(0, 10);
  const stale = !!trust.staleAfter && trust.staleAfter <= today;
  return (
    <TableCell sx={{ whiteSpace: 'nowrap' }}>
      {trust.verifiedBy
        ? <Chip size="small" color="success" label={`Verified by ${trust.verifiedBy}`} title={`${trust.verifiedRole ?? ''}, ${trust.verifiedAt}`} />
        : <Chip size="small" color="warning" label="Unverified" />}
      <Typography variant="caption" display="block" color={stale ? 'error' : 'text.secondary'}>
        {trust.staleAfter ? `${stale ? 'Re-review overdue since' : 'Re-review by'} ${trust.staleAfter}` : 'No re-review date'}
      </Typography>
      <Typography variant="caption" display="block" sx={{ fontFamily: 'monospace' }} color="text.secondary">{trust.sourcePath}</Typography>
    </TableCell>
  );
}
```

  - Import `ConceptTrust` from `../types`.
  - Controls table: add a `<TableCell>Verification</TableCell>` header, and `<TrustCell trust={c.trust} />` as the last cell of each row.
  - Clauses table: replace the "Review" column (header and `reviewStatus` chip) with the same "Verification" header and `<TrustCell trust={c.trust} />`.
- Above the tabs, beside the disclaimer, add an `Alert severity="info"`: "Only knowledge a reviewer has verified, and that is not past its re-review date, may be cited in released findings. Unverified sources are blocked in production."

`frontend/src/pages/AdminPage.tsx`:
- Add an interface `DueConcept` with the same fields as the backend type.
- Load it beside users and settings: `api<DueConcept[]>('/admin/knowledge/due').then(setDue)`.
- Render a `Card` titled "Knowledge due for re-review (n)". Its table has these columns:
  - ID: `conceptId`, monospace
  - Title
  - Pack: `packId@packVersion`
  - Reason: one `Chip` per reason, warning for "unverified" and error for "stale"
  - Re-review by: `staleAfter`
  - Source file: `sourcePath`, monospace
- When the list is empty, show "Every library concept is verified and current."
- Follow the existing cards' layout and spacing.

Run: `cd ../frontend && npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: README**

In `README.md`, make these changes.

- **Quick start:**
  - Where it lists Compose services or the release steps, say that `migrate` also compiles the content packs into the knowledge graph.
  - For a local run outside Compose, add `npm run packs:compile` after `npm run migrate`. In development the API also compiles at start-up.
- **Replace "## Adding a sector or regulation"** with "## Content packs and the knowledge graph". It covers:
  - The bundle layout (`pack.md`, `clauses/`, `controls/`, `eval/`), and one short example control file trimmed from a real one.
  - Ids and file names: `x_audit.id` and its slug. Links between concepts are pack-relative (`/clauses/<slug>.md`). A control's `x_audit.clause_refs` must match its `sources`.
  - **Change control:** edit Markdown in a pull request, and bump `x_audit.version` in `pack.md` with every change; compile refuses changed content under an old version. `npm run packs:compile` (container: `node dist/knowledge/packs-cli.js compile`) is a release step like `migrate`. Production never compiles at start-up, and refuses to start when the graph doesn't match the release.
  - **Verification:**
    - A reviewer sets `verified: { by, role, at }` and a `stale_after` date.
    - Only verified, active and current concepts are citable.
    - `ALLOW_UNVERIFIED_CITATIONS=true` flags instead of blocking, outside production only. It is on in Compose and `.env.example`, because the MVP packs are unreviewed drafts. Expert review of the target pack is a pilot prerequisite.
    - The admin page lists what is due.
  - Every compile is written to the audit trail (`knowledge:compile`). Every compiled version of every concept is kept in `kg_node_versions`.
  - `npm run packs:migrate` converted the MVP `pack.json` files once, and is kept for anyone holding packs in that format.
  - Library search (`GET /api/knowledge/search`) returns documents and library concepts together. Each concept hit carries its bundle file and whether it is citable.
- **Checks:** note that `npm run eval` needs `ALLOW_UNVERIFIED_CITATIONS=true` until the packs are verified, and that the report header records it.

Keep the README's existing tone. Don't restate the spec.

- [ ] **Step 7: Run everything and commit**

Run: `cd backend && npm run typecheck && npm test && ALLOW_UNVERIFIED_CITATIONS=true npm run eval && npm run traceability && cd ../frontend && npm test && npm run build`
Expected: everything passes, eval is 25/25, and traceability is 23/23.

```bash
git add backend/src backend/tests frontend/src README.md
git commit -m "Show knowledge verification in the library and list concepts due for re-review"
```
