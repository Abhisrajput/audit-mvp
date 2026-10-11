# Foundation 1C — Part 11 Electronic Signatures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make finding sign-off a 21 CFR Part 11 electronic signature. The signer re-authenticates at the moment of signing, and the signature is bound to the exact content signed, kept in an append-only record and displayed with name, meaning, time and how the signer re-authenticated.

**Architecture:**
- **Signing request.** Clicking **Sign** creates a short-lived signing request (an *intent*) holding the finding's current content hash and one-time OIDC `state`, `nonce` and PKCE verifier. The service checks role and segregation of duties first, so nobody re-authenticates for nothing.
- **Re-authentication pop-up.**
  - OIDC users are sent to the identity provider with `prompt=login&max_age=0`.
  - Demo users (DEV_AUTH only) confirm by typing their user id.
- **Callback checks.** The callback checks four things:
  - the same person came back (issuer and subject)
  - they authenticated at the identity provider within the last 120 s (`auth_time`)
  - the intent is unexpired and unused
  - the finding's content hash is unchanged
- **Signing.** Only after all four checks does `AuditService.signOff` write the signature row, the finding status and the trail bundle, in one transaction.
- **Failures** are recorded on the intent and in the audit trail.
- **Revisions.** Every change to a finding's content is recorded as an append-only revision, so a signature can always be matched to the revision it signed.

**Tech Stack:** Node 22, TypeScript, Express 5, Kysely + Postgres 16, `openid-client` 6, vitest + Testcontainers + the in-process mock OIDC provider from 1B; React 18 + MUI 5 + vitest.

**Spec:** `docs/superpowers/specs/2026-10-11-production-foundation-design.md`:
- §3.1: `signatures` table
- §3.2: signatures bind content
- §4.4: Part 11 signing flow
- §8: codes `REAUTH_REQUIRED`, `REAUTH_STALE`, `REAUTH_USER_MISMATCH`, `INTENT_EXPIRED`, `CONTENT_CHANGED`
- §9: sign flow, signature display, broken signature
- §11: REQ-18 and REQ-19

Builds on 1A and 1B (branch `design/foundation-1b-identity`); this plan's branch is `design/foundation-1c-signing`.

## Global Constraints

- Builds on 1A and 1B. Follow 1A's persistence conventions (Kysely; plain SQL migrations in `backend/migrations/`; never migrate on start-up). Add `004_signing.sql`; never edit `001`–`003`.
- Signing re-authentication must have happened at the identity provider no more than **120 s** before the callback (`auth_time`). A signing request (intent) expires **5 minutes** after creation and can be used **once**.
- The OIDC re-authentication request carries `prompt=login` and `max_age=0`, plus the intent's own `state`, `nonce` and PKCE S256 verifier. It reuses the single registered redirect URI (`OIDC_REDIRECT_URI`, i.e. `/auth/callback`). The callback tells a signing response from a login response by `state`.
- A signature's `content_hash` is the SHA-256 of `canonicalJson` of exactly these finding fields: `id`, `rowId`, `controlId`, `title`, `rating`, `condition`, `criteria`, `cause`, `effect`, `recommendation`, `citations`, `evidenceRefs`. Status, sign-offs and preparers are not signed content.
- `signatures` and `finding_revisions` are append-only: UPDATE, DELETE and TRUNCATE are rejected by the existing `reject_change()` trigger function.
- The signature row, the finding's status change and the `human:sign-off` trail bundle commit in one transaction. Signing with a stale content hash fails with `409 CONTENT_CHANGED` and writes nothing.
- The HTTP route `POST /api/engagements/:id/findings/:fid/signoff` no longer signs. It returns `428 REAUTH_REQUIRED`. Server-side code (seed, tests) may still call `AuditService.signOff` without re-authentication; such signatures are recorded with `reauth_method = 'none'` and shown as "not re-authenticated".
- Failed signing attempts are recorded on the intent (`failure_code`, `failure_message`) and trailed as `identity:sign-failed`.
- Segregation of duties, role checks and their error codes from 1B are unchanged. The same guard runs when the intent is created and when the signature is written.
- Engine changes are limited to `backend/src/engine/types.ts` (optional `SignOff` fields).
- Tests keep `[REQ-xx]` tags; `npm run eval` stays 25/25. `validation/requirements.json` changes only by adding REQ-18 and REQ-19.
- Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote it.

**Deliberate refinements of the spec (1C):**
- **Deferred tables.** The `gates` and `agent_runs`/`agent_steps` tables listed in spec §3.1 move to the agent-orchestration sub-project, which is the first code to use them. Creating empty tables now has nothing to test.
- **Rate limiting** of failed signing attempts is in plan 1F with the other rate limits. 1C trails every failure, so it is visible.
- **"Broken" signatures** are computed when an engagement is read: a sign-off whose `contentHash` no longer matches the finding is returned with `broken: true`. Edits reset sign-offs (1A), so this only shows after tampering at the database level, which is exactly what it is for.
- **Status by polling.** The UI follows a signing request by polling `GET /api/sign-intents/:id` while the pop-up is open, rather than `postMessage`. Polling also works when the identity provider breaks the window opener.

## Review Focus

1. **The pop-up's callback arrives without the session cookie.** It's a cross-site redirect, so the `SameSite=Strict` cookie is withheld. Signing still completes, because the intent identifies the signer and the ID token must match them. Pinned in Task 4.
2. **A signing request is replayed** (the same callback URL loaded twice, or the dev form posted twice). Exactly one signature; the second attempt changes nothing. Pinned in Tasks 3 and 4.
3. **The finding is edited between starting to sign and re-authenticating.** No signature, `CONTENT_CHANGED`, and the UI explains it. Pinned in Tasks 3 and 5.
4. **Someone else's signing request, opened by another signed-in user.** "Signing request not found", and nothing is revealed or changed. Pinned in Task 3.
5. **The pop-up is blocked, or closed before finishing.** A clear message, and no signature left half-done. Pinned in Task 5.

## File structure

| File | Responsibility |
|---|---|
| `backend/migrations/004_signing.sql` | `finding_revisions`, `signatures`, `sign_intents` |
| `backend/src/db/schema.ts` | Kysely types for the three tables |
| `backend/src/signing/content-hash.ts` | `findingContentHash()`, `withSignatureStatus()` |
| `backend/src/db/revision-repo.ts` | `recordRevision()`, `listRevisions()` |
| `backend/src/db/signature-repo.ts` | `insertSignature()`, `listSignatures()` |
| `backend/src/db/engagement-repo.ts` | Records a revision whenever finding content is inserted or changes |
| `backend/src/service.ts` | `SignAction`, `SignatureContext`, `signOffGuard`, `checkSignOff`, signatures written in `signOff` |
| `backend/src/signing/intent-repo.ts` | Create, read, claim and finish signing requests |
| `backend/src/signing/flow.ts` | `completeSigning()`, `failIntent()`, `REAUTH_MAX_AGE_MS` |
| `backend/src/signing/routes.ts` | Intent API, status API, pop-up start page, demo confirmation, IdP callback handler |
| `backend/src/auth/page.ts` | Shared tiny HTML pages (moved out of `auth/routes.ts`) |
| `backend/src/auth/oidc.ts` | `reauthUrl()` |
| `backend/src/auth/routes.ts` | `/auth/callback` hands signing responses to the signing handler |
| `backend/src/app.ts` | Wiring; `/signoff` → 428; signature status on GET engagement |
| `frontend/src/signing.ts` | `signWithReauth()`: intent → pop-up → poll |
| `frontend/src/components/engagement/FindingsTab.tsx` | Sign buttons use it; signature display |
| Tests | `backend/tests/signing-store.test.ts`, `signing-service.test.ts`, `signing-http.test.ts`, `signing-oidc.test.ts`; `frontend/src/signing.test.ts` |

---
### Task 1: Signing storage — content hash, revisions, signatures and intents tables

**Files:**
- Create: `backend/migrations/004_signing.sql`, `backend/src/signing/content-hash.ts`, `backend/src/db/revision-repo.ts`, `backend/src/db/signature-repo.ts`
- Modify: `backend/src/db/schema.ts`, `backend/src/db/engagement-repo.ts`, `backend/src/engine/types.ts`
- Test: `backend/tests/signing-store.test.ts`

**Interfaces:**
- Consumes:
  - `canonicalJson`, `sha256` (`src/engine/trail.ts`)
  - `Executor` (`src/db/trail-repo.ts`)
  - `insertFinding`, `saveEngagement` (`src/db/engagement-repo.ts`)
  - test helpers `newService`, `engagementWithFailedControl`, `auditor`
- Produces:
  - `findingContentHash(f: Finding): string`
  - `withSignatureStatus(e: Engagement): Engagement`
  - `recordRevision(db: Executor, engagementId: string, f: Finding): Promise<void>`
  - `listRevisions(db, engagementId, findingId): Promise<{ revision: number; contentHash: string; recordedAt: string }[]>`
  - `interface SignatureRow { id: string; engagementId: string; findingId: string; userId: string; userName: string; role: string; meaning: 'Reviewed' | 'Approved' | 'Rejected'; comment: string; contentHash: string; reauthMethod: 'oidc' | 'dev' | 'none'; reauthAt: string | null; intentId: string | null; trailBundleId: string; signedAt: string }`
  - `insertSignature(db: Executor, s: SignatureRow): Promise<void>`
  - `listSignatures(db: Executor, engagementId: string): Promise<SignatureRow[]>` (ordered by `signed_at`, then `id`)
  - Kysely tables `finding_revisions`, `signatures`, `sign_intents`
  - `SignOff` gains the optional fields `signatureId`, `contentHash`, `reauth`, `broken`

- [ ] **Step 1: Write the failing tests** `backend/tests/signing-store.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { listRevisions } from '../src/db/revision-repo';
import { insertSignature, listSignatures, type SignatureRow } from '../src/db/signature-repo';
import type { Finding } from '../src/engine/types';
import { findingContentHash, withSignatureStatus } from '../src/signing/content-hash';
import { auditor, engagementWithFailedControl, newService } from './helpers';

describe('finding content hash', () => {
  it('covers what the finding says, not its key order, status or sign-offs', async () => {
    const e = await engagementWithFailedControl(await newService());
    const f = e.findings[0];
    const h = findingContentHash(f);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(findingContentHash(Object.fromEntries(Object.entries(f).reverse()) as Finding)).toBe(h);
    expect(findingContentHash({ ...f, status: 'reviewed', signOffs: [], preparedBy: ['someone'] })).toBe(h);
    expect(findingContentHash({ ...f, condition: `${f.condition}!` })).not.toBe(h);
    expect(findingContentHash({ ...f, evidenceRefs: [...f.evidenceRefs, 'EXTRA'] })).not.toBe(h);
  });

  it('flags a sign-off whose content no longer matches as broken, without touching the original', async () => {
    const e = await engagementWithFailedControl(await newService());
    const f = e.findings[0];
    const good = { userId: 'r', userName: 'R', role: 'audit_manager', meaning: 'Reviewed' as const, comment: '', at: '2026-10-11T00:00:00.000Z', contentHash: findingContentHash(f) };
    const bad = { ...good, contentHash: 'b'.repeat(64) };
    const legacy = { userId: 'x', userName: 'X', role: 'reviewer', meaning: 'Reviewed' as const, comment: '', at: '2026-01-01T00:00:00.000Z' };
    const shown = withSignatureStatus({ ...e, findings: [{ ...f, signOffs: [good, bad, legacy] }] });
    expect(shown.findings[0].signOffs.map((s) => s.broken)).toEqual([false, true, undefined]);
    expect(e.findings[0].signOffs).toEqual([]);
  });
});

describe('finding revisions', () => {
  it('records a revision when a finding is drafted and whenever its content changes', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const db = svc.db.kysely;
    expect((await listRevisions(db, e.id, f.id)).map((r) => r.revision)).toEqual([1]);
    await svc.editFinding(e.id, f.id, { title: 'Roaster CCP logs unsigned' }, auditor);
    await svc.editFinding(e.id, f.id, { title: 'Roaster CCP logs unsigned' }, auditor); // same content: no new revision
    const revisions = await listRevisions(db, e.id, f.id);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(revisions[1].contentHash).toBe(findingContentHash((await svc.engagement(e.id)).findings[0]));
    await expect(db.deleteFrom('finding_revisions').execute()).rejects.toThrow(/append-only: DELETE/);
  });
});

describe('signatures table', () => {
  it('stores signatures and refuses to change or delete them [REQ-20]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const db = svc.db.kysely;
    const row: SignatureRow = {
      id: 'SIG-1', engagementId: e.id, findingId: e.findings[0].id, userId: 'reviewer', userName: 'Ravi Reviewer', role: 'audit_manager',
      meaning: 'Reviewed', comment: '', contentHash: 'a'.repeat(64), reauthMethod: 'dev', reauthAt: '2026-10-11T00:00:00.000Z',
      intentId: null, trailBundleId: 'HUM-1', signedAt: '2026-10-11T00:00:01.000Z',
    };
    await insertSignature(db, row);
    expect(await listSignatures(db, e.id)).toEqual([row]);
    await expect(db.updateTable('signatures').set({ comment: 'x' }).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.deleteFrom('signatures').execute()).rejects.toThrow(/append-only: DELETE/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/signing-store.test.ts`
Expected: FAIL with `Cannot find module '../src/db/revision-repo'`.

- [ ] **Step 3: Write the migration** `backend/migrations/004_signing.sql`

```sql
-- 21 CFR Part 11 electronic signatures. A signature binds a person, a meaning
-- and a time to the exact content signed (its SHA-256). Signatures and the
-- revisions they refer to are never updated or deleted.

CREATE TABLE finding_revisions (
  engagement_id text NOT NULL,
  finding_id    text NOT NULL,
  revision      integer NOT NULL CHECK (revision > 0),
  content_hash  text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engagement_id, finding_id, revision)
);
CREATE TRIGGER finding_revisions_append_only BEFORE UPDATE OR DELETE ON finding_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER finding_revisions_no_truncate BEFORE TRUNCATE ON finding_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TABLE signatures (
  id              text PRIMARY KEY,
  engagement_id   text NOT NULL REFERENCES engagements (id),
  finding_id      text NOT NULL,
  user_id         text NOT NULL,
  user_name       text NOT NULL,
  role            text NOT NULL,
  meaning         text NOT NULL CHECK (meaning IN ('Reviewed', 'Approved', 'Rejected')),
  comment         text NOT NULL DEFAULT '',
  content_hash    text NOT NULL,
  reauth_method   text NOT NULL CHECK (reauth_method IN ('oidc', 'dev', 'none')),
  reauth_at       timestamptz,
  intent_id       text,
  trail_bundle_id text NOT NULL,
  signed_at       timestamptz NOT NULL
);
CREATE INDEX signatures_by_finding ON signatures (engagement_id, finding_id, signed_at);
CREATE TRIGGER signatures_append_only BEFORE UPDATE OR DELETE ON signatures
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER signatures_no_truncate BEFORE TRUNCATE ON signatures
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- A signing request: what is about to be signed, by whom, and the one-time
-- OIDC values for its re-authentication. Single use, short-lived.
CREATE TABLE sign_intents (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users (id),
  engagement_id   text NOT NULL REFERENCES engagements (id),
  finding_id      text NOT NULL,
  action          text NOT NULL CHECK (action IN ('review', 'approve', 'reject')),
  comment         text NOT NULL DEFAULT '',
  content_hash    text NOT NULL,
  state           text NOT NULL UNIQUE,
  nonce           text NOT NULL,
  code_verifier   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'signed', 'failed')),
  failure_code    text,
  failure_message text,
  completed_at    timestamptz
);
```

- [ ] **Step 4: Add the tables to the Kysely schema.** In `backend/src/db/schema.ts`, add before `export interface DB`:

```ts
export interface FindingRevisionsTable {
  engagement_id: string;
  finding_id: string;
  revision: number;
  content_hash: string;
  recorded_at: Generated<Date>;
}

type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type NullableText = ColumnType<string | null, string | null | undefined, string | null>;

export interface SignaturesTable {
  id: string;
  engagement_id: string;
  finding_id: string;
  user_id: string;
  user_name: string;
  role: string;
  meaning: 'Reviewed' | 'Approved' | 'Rejected';
  comment: string;
  content_hash: string;
  reauth_method: 'oidc' | 'dev' | 'none';
  reauth_at: NullableTimestamp;
  intent_id: NullableText;
  trail_bundle_id: string;
  signed_at: Timestamp;
}

export interface SignIntentsTable {
  id: string;
  user_id: string;
  engagement_id: string;
  finding_id: string;
  action: 'review' | 'approve' | 'reject';
  comment: string;
  content_hash: string;
  state: string;
  nonce: string;
  code_verifier: string;
  created_at: Generated<Date>;
  expires_at: Timestamp;
  status: ColumnType<'pending' | 'claimed' | 'signed' | 'failed', 'pending' | undefined, 'claimed' | 'signed' | 'failed'>;
  failure_code: NullableText;
  failure_message: NullableText;
  completed_at: NullableTimestamp;
}
```

and add these three members to `interface DB`:

```ts
  finding_revisions: FindingRevisionsTable;
  signatures: SignaturesTable;
  sign_intents: SignIntentsTable;
```

- [ ] **Step 5: Extend the sign-off type.** In `backend/src/engine/types.ts`, inside `interface SignOff`, add after `at: string;`:

```ts
  /** Signatures captured since Part 11 signing (plan 1C) carry these. */
  signatureId?: string;
  /** SHA-256 of the finding content this signature vouches for. */
  contentHash?: string;
  /** How the signer proved who they were at the moment of signing; 'none' for server-side signing (seed, tests). */
  reauth?: { method: 'oidc' | 'dev' | 'none'; at: string | null };
  /** Set only in API responses: the finding's content no longer matches what was signed. */
  broken?: boolean;
```

- [ ] **Step 6: Write the content hash** `backend/src/signing/content-hash.ts`

```ts
import { canonicalJson, sha256 } from '../engine/trail';
import type { Engagement, Finding } from '../engine/types';

/** SHA-256 of what a finding says — the part a signature vouches for. Status, sign-offs and preparers are not content. */
export function findingContentHash(f: Finding): string {
  const { id, rowId, controlId, title, rating, condition, criteria, cause, effect, recommendation, citations, evidenceRefs } = f;
  return sha256(canonicalJson({ id, rowId, controlId, title, rating, condition, criteria, cause, effect, recommendation, citations, evidenceRefs }));
}

/** A copy of the engagement for display, with each signed sign-off marked broken if the content no longer matches. */
export function withSignatureStatus(e: Engagement): Engagement {
  return {
    ...e,
    findings: e.findings.map((f) => {
      const current = findingContentHash(f);
      return { ...f, signOffs: f.signOffs.map((s) => (s.contentHash ? { ...s, broken: s.contentHash !== current } : s)) };
    }),
  };
}
```

- [ ] **Step 7: Write the revision repository** `backend/src/db/revision-repo.ts`

```ts
import type { Finding } from '../engine/types';
import { findingContentHash } from '../signing/content-hash';
import type { Executor } from './trail-repo';

export interface FindingRevision {
  revision: number;
  contentHash: string;
  recordedAt: string;
}

/** Appends a revision when the finding's content differs from its latest recorded revision. */
export async function recordRevision(db: Executor, engagementId: string, f: Finding): Promise<void> {
  const hash = findingContentHash(f);
  const last = await db
    .selectFrom('finding_revisions')
    .select(['revision', 'content_hash'])
    .where('engagement_id', '=', engagementId)
    .where('finding_id', '=', f.id)
    .orderBy('revision', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (last?.content_hash === hash) return;
  await db
    .insertInto('finding_revisions')
    .values({ engagement_id: engagementId, finding_id: f.id, revision: (last?.revision ?? 0) + 1, content_hash: hash })
    .execute();
}

export async function listRevisions(db: Executor, engagementId: string, findingId: string): Promise<FindingRevision[]> {
  const rows = await db
    .selectFrom('finding_revisions')
    .select(['revision', 'content_hash', 'recorded_at'])
    .where('engagement_id', '=', engagementId)
    .where('finding_id', '=', findingId)
    .orderBy('revision')
    .execute();
  return rows.map((r) => ({ revision: r.revision, contentHash: r.content_hash, recordedAt: new Date(r.recorded_at).toISOString() }));
}
```

- [ ] **Step 8: Write the signature repository** `backend/src/db/signature-repo.ts`

```ts
import type { Executor } from './trail-repo';

export interface SignatureRow {
  id: string;
  engagementId: string;
  findingId: string;
  userId: string;
  userName: string;
  role: string;
  meaning: 'Reviewed' | 'Approved' | 'Rejected';
  comment: string;
  contentHash: string;
  reauthMethod: 'oidc' | 'dev' | 'none';
  reauthAt: string | null;
  intentId: string | null;
  trailBundleId: string;
  signedAt: string;
}

const iso = (d: Date | string) => new Date(d).toISOString();

export async function insertSignature(db: Executor, s: SignatureRow): Promise<void> {
  await db
    .insertInto('signatures')
    .values({
      id: s.id, engagement_id: s.engagementId, finding_id: s.findingId, user_id: s.userId, user_name: s.userName, role: s.role,
      meaning: s.meaning, comment: s.comment, content_hash: s.contentHash, reauth_method: s.reauthMethod, reauth_at: s.reauthAt,
      intent_id: s.intentId, trail_bundle_id: s.trailBundleId, signed_at: s.signedAt,
    })
    .execute();
}

export async function listSignatures(db: Executor, engagementId: string): Promise<SignatureRow[]> {
  const rows = await db.selectFrom('signatures').selectAll().where('engagement_id', '=', engagementId).orderBy('signed_at').orderBy('id').execute();
  return rows.map((r) => ({
    id: r.id, engagementId: r.engagement_id, findingId: r.finding_id, userId: r.user_id, userName: r.user_name, role: r.role,
    meaning: r.meaning, comment: r.comment, contentHash: r.content_hash, reauthMethod: r.reauth_method,
    reauthAt: r.reauth_at ? iso(r.reauth_at) : null, intentId: r.intent_id, trailBundleId: r.trail_bundle_id, signedAt: iso(r.signed_at),
  }));
}
```

- [ ] **Step 9: Record revisions when finding content is saved.** In `backend/src/db/engagement-repo.ts`:
- add `import { recordRevision } from './revision-repo';`
- in `insertFinding`, after the `.execute();` of the insert, add `await recordRevision(db, engagementId, f);`
- in `saveEngagement`, inside the `else if (before !== canonicalJson(f)) { … }` branch, add `await recordRevision(db, e.id, f);` after the update's `.execute();`

`recordRevision` itself skips the insert when the content hash is unchanged. A status-only change, such as a sign-off, therefore never creates a revision.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/signing-store.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 11: Run everything.** Migration 004 must also apply on PGlite.

Run: `cd backend && npm test && npm run eval && npm run typecheck`
Expected: all green; eval 25/25.

- [ ] **Step 12: Commit**

```bash
git add backend/migrations/004_signing.sql backend/src/db backend/src/signing backend/src/engine/types.ts backend/tests/signing-store.test.ts
git commit -m "Add append-only signatures and finding revisions bound to a content hash

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---

### Task 2: Signatures written by the service, with the same guard for requests and signatures

**Files:**
- Modify: `backend/src/service.ts`, `backend/src/errors.ts`
- Test: `backend/tests/signing-service.test.ts`

**Interfaces:**
- Consumes:
  - `findingContentHash` (Task 1)
  - `insertSignature` (Task 1)
  - `failTrailWrites(db, moduleIds)` from `backend/tests/http.ts` (1B)
- Produces:
  - `export type SignAction = 'review' | 'approve' | 'reject'`
  - `export interface SignatureContext { contentHash: string; reauthMethod: 'oidc' | 'dev'; reauthAt: string; intentId: string }`
  - `checkSignOff(engagementId, findingId, action: SignAction, actor: User): Promise<{ contentHash: string }>`
  - `signOff(engagementId, findingId, action, comment, actor, opts?: MutationOptions, signature?: SignatureContext): Promise<Finding>`, which now writes a `signatures` row and fills `signatureId`, `contentHash` and `reauth` on the `SignOff`
  - The private `mutate` callback receives the transaction as its third argument: `fn(e, emit, trx)`
  - `ErrorCode` gains `'REAUTH_REQUIRED' | 'REAUTH_STALE' | 'REAUTH_USER_MISMATCH' | 'INTENT_EXPIRED' | 'CONTENT_CHANGED'`

- [ ] **Step 1: Write the failing tests** `backend/tests/signing-service.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { listSignatures } from '../src/db/signature-repo';
import { readTrail } from '../src/db/trail-repo';
import { findingContentHash } from '../src/signing/content-hash';
import { approver, auditor, engagementWithFailedControl, newService, reviewer } from './helpers';
import { failTrailWrites } from './http';

const reauth = (contentHash: string, intentId = 'INT-1') => ({ contentHash, reauthMethod: 'dev' as const, reauthAt: '2026-10-11T09:00:00.000Z', intentId });

describe('signatures written by the service', () => {
  it('binds each sign-off to the exact content signed and records it in the signatures table [REQ-19]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const hash = findingContentHash(f);
    const reviewed = await svc.signOff(e.id, f.id, 'review', 'agreed', reviewer, {}, reauth(hash));
    const s = reviewed.signOffs[0];
    expect(s).toMatchObject({
      userId: 'reviewer', userName: 'Ravi Reviewer', role: 'audit_manager', meaning: 'Reviewed', comment: 'agreed',
      contentHash: hash, reauth: { method: 'dev', at: '2026-10-11T09:00:00.000Z' },
    });
    expect(s.signatureId).toMatch(/^SIG-[0-9a-f]{12}$/);
    const [row] = await listSignatures(svc.db.kysely, e.id);
    const bundle = (await readTrail(svc.db.kysely, e.id)).at(-1)!;
    expect(bundle.moduleId).toBe('human:sign-off');
    expect(row).toMatchObject({
      id: s.signatureId, findingId: f.id, userId: 'reviewer', meaning: 'Reviewed', contentHash: hash,
      reauthMethod: 'dev', reauthAt: '2026-10-11T09:00:00.000Z', intentId: 'INT-1', trailBundleId: bundle.id,
    });
  });

  it('records server-side signing without re-authentication as such', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = await svc.signOff(e.id, e.findings[0].id, 'review', '', reviewer);
    expect(f.signOffs[0].reauth).toEqual({ method: 'none', at: null });
    expect((await listSignatures(svc.db.kysely, e.id))[0]).toMatchObject({ reauthMethod: 'none', reauthAt: null, intentId: null });
  });

  it('refuses to sign content that changed after the signing request, writing nothing [REQ-19]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const stale = findingContentHash(f);
    await svc.editFinding(e.id, f.id, { condition: 'Four of twenty logs unsigned.' }, auditor);
    await expect(svc.signOff(e.id, f.id, 'review', '', reviewer, {}, reauth(stale, 'INT-2'))).rejects.toMatchObject({ status: 409, code: 'CONTENT_CHANGED' });
    expect(await listSignatures(svc.db.kysely, e.id)).toEqual([]);
  });

  it('writes no signature when the sign-off cannot be trailed', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    await failTrailWrites(svc.db, ['human:sign-off']);
    await expect(svc.signOff(e.id, e.findings[0].id, 'review', '', reviewer)).rejects.toThrow(/trail unavailable/);
    expect(await listSignatures(svc.db.kysely, e.id)).toEqual([]);
    expect((await svc.engagement(e.id)).findings[0].status).toBe('draft');
  });

  it('checks who may sign before any re-authentication starts [REQ-17]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await expect(svc.checkSignOff(e.id, f.id, 'review', reviewer)).resolves.toEqual({ contentHash: findingContentHash(f) });
    await expect(svc.checkSignOff(e.id, f.id, 'review', auditor)).rejects.toMatchObject({ status: 403 });
    await expect(svc.checkSignOff(e.id, f.id, 'approve', approver)).rejects.toThrow(/reviewed before/);
    await svc.editFinding(e.id, f.id, { title: 'Roaster CCP logs unsigned' }, reviewer);
    await expect(svc.checkSignOff(e.id, f.id, 'review', reviewer)).rejects.toMatchObject({ code: 'SOD_VIOLATION' });
    await expect(svc.checkSignOff(e.id, 'F-NOPE', 'review', reviewer)).rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/signing-service.test.ts`
Expected: FAIL. `checkSignOff` is not a function, `signatureId` is undefined, and no signature rows exist.

- [ ] **Step 3: Add the error codes.** In `backend/src/errors.ts`, extend `ErrorCode` with these members after `'PENDING_ACCESS'`:

```ts
  | 'REAUTH_REQUIRED'
  | 'REAUTH_STALE'
  | 'REAUTH_USER_MISMATCH'
  | 'INTENT_EXPIRED'
  | 'CONTENT_CHANGED'
```

- [ ] **Step 4: Make the service write signatures.** In `backend/src/service.ts`:

1. Add these imports:

```ts
import type { Transaction } from 'kysely';
import type { DB } from './db/schema';
import { insertSignature } from './db/signature-repo';
import { findingContentHash } from './signing/content-hash';
```

2. After `export interface MutationOptions { … }`, add:

```ts
export type SignAction = 'review' | 'approve' | 'reject';

/** Proof that the signer re-authenticated for this exact content (plan 1C). */
export interface SignatureContext {
  /** Content hash captured when the signing request was made; the signature is refused if the finding changed since. */
  contentHash: string;
  reauthMethod: 'oidc' | 'dev';
  /** When the signer re-authenticated (ISO). */
  reauthAt: string;
  intentId: string;
}
```

3. Give `mutate` the transaction. Change its `fn` parameter type to:

```ts
    fn: (e: Engagement, emit: Emit, trx: Transaction<DB>) => Promise<T> | T,
```

   and the call to `const result = await fn(loaded.engagement, (b) => pending.push(b), trx);`.

4. Replace the whole `async signOff(…) { … }` method with these three members:

```ts
  /** Who may sign what, and what signing does. The same checks guard the signing request and the signature itself. */
  private signOffGuard(f: Finding, action: SignAction, actor: User): { meaning: SignOff['meaning']; status: Finding['status'] } {
    if (f.status === 'blocked') throw new AppError(409, `Finding is blocked by QA gates: ${f.blockedReasons.join('; ')}`, 'FINDING_BLOCKED');
    const preparedBy = f.preparedBy ?? [];
    if (action === 'review') {
      this.require(actor, REVIEWER_ROLES, 'review findings');
      if (f.status !== 'draft') throw new AppError(409, `Only draft findings can be reviewed (status ${f.status})`);
      if (preparedBy.includes(actor.id)) throw new AppError(403, 'You prepared this finding, so someone else must review it', 'SOD_VIOLATION');
      return { meaning: 'Reviewed', status: 'reviewed' };
    }
    this.require(actor, APPROVER_ROLES, `${action} findings`);
    if (f.status !== 'reviewed') throw new AppError(409, 'Finding must be reviewed before approval or rejection');
    if (preparedBy.includes(actor.id)) throw new AppError(403, 'You prepared this finding, so someone else must approve it', 'SOD_VIOLATION');
    if (f.signOffs.some((s) => s.userId === actor.id)) throw new AppError(403, 'Approver must differ from reviewer', 'SOD_VIOLATION');
    return action === 'approve' ? { meaning: 'Approved', status: 'approved' } : { meaning: 'Rejected', status: 'rejected' };
  }

  /** Checks a signature would be allowed, before the signer is asked to re-authenticate; returns the content to bind. */
  async checkSignOff(engagementId: string, findingId: string, action: SignAction, actor: User): Promise<{ contentHash: string }> {
    const e = await this.engagement(engagementId);
    const f = e.findings.find((x) => x.id === findingId);
    if (!f) throw new AppError(404, `Finding ${findingId} not found`);
    this.signOffGuard(f, action, actor);
    return { contentHash: findingContentHash(f) };
  }

  async signOff(
    engagementId: string, findingId: string, action: SignAction, comment: string, actor: User,
    opts: MutationOptions = {}, signature?: SignatureContext,
  ) {
    const { result } = await this.mutate(engagementId, opts, async (e, emit, trx) => {
      const f = e.findings.find((x) => x.id === findingId);
      if (!f) throw new AppError(404, `Finding ${findingId} not found`);
      const contentHash = findingContentHash(f);
      if (signature && signature.contentHash !== contentHash) {
        throw new AppError(409, 'The finding changed after you started signing; review it again, then sign', 'CONTENT_CHANGED');
      }
      const { meaning, status } = this.signOffGuard(f, action, actor);
      f.status = status;

      // Signature manifestation (§11.50) bound to the signed content (§11.70).
      const at = new Date().toISOString();
      const reauth: NonNullable<SignOff['reauth']> = signature ? { method: signature.reauthMethod, at: signature.reauthAt } : { method: 'none', at: null };
      const sig: SignOff = {
        userId: actor.id, userName: actor.name, role: actor.role, meaning, comment, at,
        signatureId: `SIG-${crypto.randomBytes(6).toString('hex')}`, contentHash, reauth,
      };
      f.signOffs.push(sig);
      const bundle = this.humanBundle(e, 'human:sign-off', actor, { findingId, action, comment, intentId: signature?.intentId ?? null }, sig);
      emit(bundle);
      await insertSignature(trx, {
        id: sig.signatureId!, engagementId: e.id, findingId, userId: actor.id, userName: actor.name, role: actor.role, meaning, comment,
        contentHash, reauthMethod: reauth.method, reauthAt: reauth.at, intentId: signature?.intentId ?? null, trailBundleId: bundle.id, signedAt: at,
      });
      return f;
    });
    return result;
  }
```

The old checks kept their messages, statuses and codes; they now live in `signOffGuard`. The content check comes first, so a finding edited after the request (which also resets it to draft) reports `CONTENT_CHANGED` rather than a confusing status error.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/signing-service.test.ts tests/engine.test.ts`
Expected: PASS. The 5 new tests pass, and every existing engine test still passes unchanged.

- [ ] **Step 6: Run everything**

Run: `cd backend && npm test && npm run eval && npm run typecheck`
Expected: all green; eval 25/25.

- [ ] **Step 7: Commit**

```bash
git add backend/src/service.ts backend/src/errors.ts backend/tests/signing-service.test.ts
git commit -m "Write a content-bound signature row with every sign-off, in the same transaction

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---
### Task 3: Signing requests over HTTP, with demo re-authentication

**Files:**
- Create: `backend/src/signing/intent-repo.ts`, `backend/src/signing/flow.ts`, `backend/src/signing/pages.ts`, `backend/src/signing/routes.ts`, `backend/src/auth/page.ts`
- Modify: `backend/src/auth/routes.ts` (use `auth/page.ts`), `backend/src/auth/identity-trail.ts` (`sign-failed`), `backend/src/app.ts`
- Modify: `backend/tests/api.test.ts` (sign through the new flow)
- Test: `backend/tests/signing-http.test.ts`
- Modify: `backend/validation/requirements.json` (REQ-19)

**Interfaces:**
- Consumes:
  - `SignAction`, `checkSignOff`, `signOff(…, signature)` (Task 2)
  - `withSignatureStatus` (Task 1)
  - `listSignatures` (Task 1)
  - from 1B: `AuthDeps`, `requireRole`, `actorOf`, `READ_ROLES`, `DEV_ISSUER`, `getUser`, `recordIdentityEvent`, `wrap`
  - test helpers `appWithDevUsers`, `signIn`
- Produces:
  - `interface SignIntent { id; userId; engagementId; findingId; action: SignAction; comment; contentHash; state; nonce; codeVerifier; createdAt: string; expiresAt: string; status: 'pending' | 'claimed' | 'signed' | 'failed'; failureCode: string | null; failureMessage: string | null }`
  - `INTENT_TTL_MS = 300_000`
  - `createIntent(db, p, now?)`, `getIntent(db, id)`, `getIntentByState(db, state)`, `claimIntent(db, id): Promise<boolean>`, `finishIntent(db, id, outcome)`
  - `type SignOutcome = { ok: true } | { ok: false; code: ErrorCode; message: string }`
  - `completeSigning(svc, intent, actor: User, reauth: { method: 'oidc' | 'dev'; at: string }, now?)`
  - `failIntent(svc, intent, actor, code, message)`
  - `REAUTH_MAX_AGE_MS = 120_000`
  - `signingRoutes(svc, auth: AuthDeps): { router: Router; handleIdpCallback(req, res): Promise<boolean> }`. `handleIdpCallback` returns false in this task when OIDC is off; Task 4 exercises it.
  - `page(res, status, title, message, next?)` and `escapeHtml(s)` from `src/auth/page.ts`
  - `IdentityEvent` gains `'sign-failed'`
  - Routes:
    - `POST /api/engagements/:id/findings/:fid/sign-intents { action, comment }` → `201 { intentId, reauthUrl, method: 'oidc' | 'dev', expiresAt }`
    - `GET /api/sign-intents/:intentId` → `{ status, code, message }`
    - `GET /auth/sign/:intentId` (the pop-up)
    - `POST /auth/sign/:intentId/dev` (form fields `nonce`, `confirm`)
    - `POST …/signoff` → `428 REAUTH_REQUIRED`
  - `GET /api/engagements/:id` returns sign-offs with `broken` computed

- [ ] **Step 1: Write the failing tests** `backend/tests/signing-http.test.ts`

```ts
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { listSignatures } from '../src/db/signature-repo';
import { readTrail } from '../src/db/trail-repo';
import { appWithDevUsers, signIn } from './http';

type Session = Awaited<ReturnType<typeof signIn>>;

/** Runs the pharma chain as the auditor until one draft finding exists. */
async function draftFinding(app: Awaited<ReturnType<typeof appWithDevUsers>>['app']) {
  const auditor = await signIn(app, 'auditor');
  const created = await auditor.post('/api/engagements', {
    name: 'Pharma self-inspection', entity: 'Demo Pharma', site: 'OSD plant', periodFrom: '2026-01-01', periodTo: '2026-06-30',
    auditType: 'GMP self-inspection', scopeStatement: 'Data integrity: HPLC audit trails and user access', packIds: ['pharma'],
  }).expect(201);
  const id = created.body.id as string;
  await auditor.post(`/api/engagements/${id}/modules/scope/run`).expect(200);
  await auditor.post(`/api/engagements/${id}/modules/rcm/run`).expect(200);
  await auditor.put(`/api/engagements/${id}/tests/PH-DI-01`, { designAdequate: true, observation: 'Audit trail review missing for 5 of 20 sequences', evidenceRefs: ['SEQ-Q2'], sampleTested: 20, exceptions: 5 }).expect(200);
  await auditor.post(`/api/engagements/${id}/modules/testing/run`).expect(200);
  const gaps = await auditor.post(`/api/engagements/${id}/modules/gaps/run`).expect(200);
  return { auditor, id, fid: gaps.body.engagement.findings[0].id as string };
}

/** The signing pop-up for a demo user: start, read the form, confirm. */
async function devSign(user: Session, userId: string, id: string, fid: string, action: string, confirm = userId) {
  const intent = await user.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action, comment: 'agreed' });
  if (intent.status !== 201) return { intent, status: null as null | { status: string; code: string | null } };
  const popup = await user.get(intent.body.reauthUrl).expect(200);
  const nonce = /name="nonce" value="([^"]+)"/.exec(popup.text)![1];
  const done = await user.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm });
  const status = (await user.get(`/api/sign-intents/${intent.body.intentId}`).expect(200)).body;
  return { intent, popup, done, nonce, status };
}

describe('signing over HTTP', () => {
  it('no longer signs without re-authentication', async () => {
    const { app } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const res = await reviewer.post(`/api/engagements/${id}/findings/${fid}/signoff`, { action: 'review' });
    expect(res.status).toBe(428);
    expect(res.body.code).toBe('REAUTH_REQUIRED');
  });

  it('signs after re-authentication and shows who signed, what it means, when and how [REQ-19]', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const r = await devSign(reviewer, 'reviewer', id, fid, 'review');
    expect(r.intent.body).toMatchObject({ method: 'dev', reauthUrl: `/auth/sign/${r.intent.body.intentId}` });
    expect(r.popup!.text).toContain('Reviewed');
    expect(r.done!.text).toMatch(/signature was recorded/);
    expect(r.status).toEqual({ status: 'signed', code: null, message: null });

    const approver = await signIn(app, 'approver');
    expect((await devSign(approver, 'approver', id, fid, 'approve')).status!.status).toBe('signed');

    const e = (await approver.get(`/api/engagements/${id}`).expect(200)).body;
    const signOffs = e.findings[0].signOffs;
    expect(signOffs.map((s: any) => [s.userName, s.meaning, s.reauth.method, s.broken])).toEqual([
      ['Ravi Reviewer', 'Reviewed', 'dev', false],
      ['Priya QA Head', 'Approved', 'dev', false],
    ]);
    expect(signOffs.every((s: any) => !Number.isNaN(Date.parse(s.at)) && !Number.isNaN(Date.parse(s.reauth.at)))).toBe(true);
    expect((await listSignatures(svc.db.kysely, id)).map((s) => s.intentId)).toEqual([r.intent.body.intentId, expect.stringMatching(/^INT-/)]);
  });

  it('refuses a confirmation by someone else and trails the failure', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const r = await devSign(reviewer, 'reviewer', id, fid, 'review', 'approver');
    expect(r.status).toMatchObject({ status: 'failed', code: 'REAUTH_USER_MISMATCH' });
    expect((await reviewer.get(`/api/engagements/${id}`)).body.findings[0].status).toBe('draft');
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
    const failed = (await readTrail(svc.db.kysely)).find((b) => b.moduleId === 'identity:sign-failed')!;
    expect(failed).toMatchObject({ actor: 'reviewer', inputs: { engagementId: id, findingId: fid, action: 'review' }, output: { code: 'REAUTH_USER_MISMATCH' } });
  });

  it('uses a signing request once only', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const r = await devSign(reviewer, 'reviewer', id, fid, 'review');
    const again = await reviewer.agent.post(`${r.intent.body.reauthUrl}/dev`).type('form').send({ nonce: r.nonce, confirm: 'reviewer' });
    expect(again.text).not.toMatch(/signature was recorded/);
    expect(await listSignatures(svc.db.kysely, id)).toHaveLength(1);
    expect((await reviewer.get(`/api/sign-intents/${r.intent.body.intentId}`)).body.status).toBe('signed');
  });

  it('expires a signing request after five minutes', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    expect(Date.parse(intent.body.expiresAt) - Date.now()).toBeGreaterThan(4.9 * 60_000);
    const popup = await reviewer.get(intent.body.reauthUrl).expect(200);
    const nonce = /name="nonce" value="([^"]+)"/.exec(popup.text)![1];
    await sql`UPDATE sign_intents SET expires_at = now() - interval '1 second'`.execute(svc.db.kysely);
    await reviewer.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: 'reviewer' });
    expect((await reviewer.get(`/api/sign-intents/${intent.body.intentId}`)).body).toMatchObject({ status: 'failed', code: 'INTENT_EXPIRED' });
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
    expect((await reviewer.get(intent.body.reauthUrl)).status).toBe(410);
  });

  it('refuses to sign a finding that was edited after the request', async () => {
    const { app, svc } = await appWithDevUsers();
    const { auditor, id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    const popup = await reviewer.get(intent.body.reauthUrl).expect(200);
    const nonce = /name="nonce" value="([^"]+)"/.exec(popup.text)![1];
    await auditor.put(`/api/engagements/${id}/findings/${fid}`, { condition: 'Six of twenty sequences lacked audit trail review.' }).expect(200);
    const done = await reviewer.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: 'reviewer' });
    expect(done.text).toMatch(/changed after you started signing/);
    expect((await reviewer.get(`/api/sign-intents/${intent.body.intentId}`)).body.code).toBe('CONTENT_CHANGED');
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
  });

  it("keeps one person's signing request away from everyone else", async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    const nonce = /name="nonce" value="([^"]+)"/.exec((await reviewer.get(intent.body.reauthUrl)).text)![1];
    const viewer = await signIn(app, 'viewer');
    expect((await viewer.get(intent.body.reauthUrl)).status).toBe(404);
    expect((await viewer.get(`/api/sign-intents/${intent.body.intentId}`)).status).toBe(404);
    await viewer.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: 'viewer' }).expect(404);
    expect((await reviewer.get(`/api/sign-intents/${intent.body.intentId}`)).body.status).toBe('pending');
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
  });

  it('checks roles and segregation of duties before asking anyone to re-authenticate [REQ-17]', async () => {
    const { app } = await appWithDevUsers();
    const { auditor, id, fid } = await draftFinding(app);
    expect((await auditor.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' })).status).toBe(403);
    const reviewer = await signIn(app, 'reviewer');
    await reviewer.put(`/api/engagements/${id}/findings/${fid}`, { title: 'Audit trail review not evidenced' }).expect(200);
    const sod = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' });
    expect(sod.status).toBe(403);
    expect(sod.body.code).toBe('SOD_VIOLATION');
  });

  it('shows a signature as broken if the signed content is altered behind the application [REQ-19]', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    await devSign(reviewer, 'reviewer', id, fid, 'review');
    await sql`UPDATE findings SET data = jsonb_set(data, '{condition}', '"rewritten quietly"') WHERE id = ${fid}`.execute(svc.db.kysely);
    const e = (await reviewer.get(`/api/engagements/${id}`)).body;
    expect(e.findings[0].signOffs[0].broken).toBe(true);
  });
});
```

Then update `backend/tests/api.test.ts`. In `runs a full engagement end to end over HTTP [REQ-06, REQ-15]`, replace the two lines that `post …/signoff` with signing through the pop-up flow:

```ts
    for (const [user, userId, action] of [[reviewer, 'reviewer', 'review'], [approver, 'approver', 'approve']] as const) {
      const intent = await user.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action, comment: 'ok' }).expect(201);
      const nonce = /name="nonce" value="([^"]+)"/.exec((await user.get(intent.body.reauthUrl).expect(200)).text)![1];
      await user.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: userId }).expect(200);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/signing-http.test.ts tests/api.test.ts`
Expected: FAIL. The `sign-intents` route returns 404, and `/signoff` still signs with a 200 instead of a 428.

- [ ] **Step 3: Move the tiny HTML pages into their own module** `backend/src/auth/page.ts`

```ts
import type { Response } from 'express';

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A tiny HTML page. Redirecting from our own page keeps the SameSite=Strict session cookie on the next request. */
export function page(res: Response, status: number, title: string, message: string, next?: string) {
  const go = next ? escapeHtml(next) : null;
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8">${go ? `<meta http-equiv="refresh" content="0;url=${go}">` : ''}` +
        `<title>${escapeHtml(title)}</title><p>${escapeHtml(message)}</p>${go ? `<p><a href="${go}">Continue</a></p>` : ''}`,
    );
}
```

In `backend/src/auth/routes.ts`, delete the local `escapeHtml` and `page` definitions and add `import { page } from './page';`.

- [ ] **Step 4: Trail failed signing.** In `backend/src/auth/identity-trail.ts`, add `| 'sign-failed'` to the `IdentityEvent` union.

- [ ] **Step 5: Write the intent repository** `backend/src/signing/intent-repo.ts`

```ts
import crypto from 'node:crypto';
import type { Selectable } from 'kysely';
import type { SignIntentsTable } from '../db/schema';
import type { Executor } from '../db/trail-repo';
import type { SignAction } from '../service';

export interface SignIntent {
  id: string;
  userId: string;
  engagementId: string;
  findingId: string;
  action: SignAction;
  comment: string;
  contentHash: string;
  /** One-time OIDC values for this request's re-authentication. */
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'claimed' | 'signed' | 'failed';
  failureCode: string | null;
  failureMessage: string | null;
}

/** A signing request must be completed within five minutes. */
export const INTENT_TTL_MS = 5 * 60_000;

const token = () => crypto.randomBytes(32).toString('base64url');
const iso = (d: Date | string) => new Date(d).toISOString();

function toIntent(r: Selectable<SignIntentsTable>): SignIntent {
  return {
    id: r.id, userId: r.user_id, engagementId: r.engagement_id, findingId: r.finding_id, action: r.action, comment: r.comment,
    contentHash: r.content_hash, state: r.state, nonce: r.nonce, codeVerifier: r.code_verifier, createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at), status: r.status, failureCode: r.failure_code, failureMessage: r.failure_message,
  };
}

export async function createIntent(
  db: Executor,
  p: { userId: string; engagementId: string; findingId: string; action: SignAction; comment: string; contentHash: string },
  now = new Date(),
): Promise<SignIntent> {
  const row = await db
    .insertInto('sign_intents')
    .values({
      id: `INT-${crypto.randomBytes(8).toString('hex')}`, user_id: p.userId, engagement_id: p.engagementId, finding_id: p.findingId,
      action: p.action, comment: p.comment, content_hash: p.contentHash, state: token(), nonce: token(), code_verifier: token(),
      expires_at: new Date(now.getTime() + INTENT_TTL_MS).toISOString(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toIntent(row);
}

export async function getIntent(db: Executor, id: string): Promise<SignIntent | null> {
  const row = await db.selectFrom('sign_intents').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toIntent(row) : null;
}

export async function getIntentByState(db: Executor, state: string): Promise<SignIntent | null> {
  const row = await db.selectFrom('sign_intents').selectAll().where('state', '=', state).executeTakeFirst();
  return row ? toIntent(row) : null;
}

/** Takes a pending request for completion. Only one caller can ever succeed. */
export async function claimIntent(db: Executor, id: string): Promise<boolean> {
  const res = await db.updateTable('sign_intents').set({ status: 'claimed' }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
  return Number(res.numUpdatedRows) === 1;
}

export async function finishIntent(
  db: Executor,
  id: string,
  outcome: { status: 'signed' } | { status: 'failed'; code: string; message: string },
): Promise<void> {
  await db
    .updateTable('sign_intents')
    .set({
      status: outcome.status,
      failure_code: outcome.status === 'failed' ? outcome.code : null,
      failure_message: outcome.status === 'failed' ? outcome.message : null,
      completed_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .where('status', 'in', ['pending', 'claimed'])
    .execute();
}
```

- [ ] **Step 6: Write the completion logic** `backend/src/signing/flow.ts`

```ts
import { recordIdentityEvent } from '../auth/identity-trail';
import type { User } from '../engine/types';
import { AppError, type ErrorCode } from '../errors';
import type { AuditService } from '../service';
import { claimIntent, finishIntent, type SignIntent } from './intent-repo';

/** The signer must have authenticated at the identity provider at most this long before the callback (spec §4.4). */
export const REAUTH_MAX_AGE_MS = 120_000;

export type SignOutcome = { ok: true } | { ok: false; code: ErrorCode; message: string };

/** Records a failed signing attempt on the request and in the audit trail. */
export async function failIntent(
  svc: AuditService,
  intent: SignIntent,
  actor: { id: string; name: string; role: string | null },
  code: ErrorCode,
  message: string,
): Promise<SignOutcome> {
  await svc.db.kysely.transaction().execute(async (trx) => {
    await finishIntent(trx, intent.id, { status: 'failed', code, message });
    await recordIdentityEvent(trx, 'sign-failed', actor, { intentId: intent.id, engagementId: intent.engagementId, findingId: intent.findingId, action: intent.action }, { code, message });
  });
  return { ok: false, code, message };
}

/** Turns a re-authenticated signing request into a signature, at most once. */
export async function completeSigning(
  svc: AuditService,
  intent: SignIntent,
  actor: User,
  reauth: { method: 'oidc' | 'dev'; at: string },
  now = new Date(),
): Promise<SignOutcome> {
  if (!(await claimIntent(svc.db.kysely, intent.id))) {
    return { ok: false, code: 'INTENT_EXPIRED', message: 'This signing request has already been used. Start signing again from the finding.' };
  }
  if (now.getTime() > Date.parse(intent.expiresAt)) {
    return failIntent(svc, intent, actor, 'INTENT_EXPIRED', 'The signing request expired. Start signing again from the finding.');
  }
  try {
    await svc.signOff(intent.engagementId, intent.findingId, intent.action, intent.comment, actor, {}, {
      contentHash: intent.contentHash, reauthMethod: reauth.method, reauthAt: reauth.at, intentId: intent.id,
    });
  } catch (err) {
    if (err instanceof AppError) return failIntent(svc, intent, actor, err.code, err.message);
    await failIntent(svc, intent, actor, 'INTERNAL', 'Signing failed unexpectedly.');
    throw err;
  }
  await finishIntent(svc.db.kysely, intent.id, { status: 'signed' });
  return { ok: true };
}
```

- [ ] **Step 7: Write the pop-up pages** `backend/src/signing/pages.ts`

```ts
import type { Response } from 'express';
import { escapeHtml } from '../auth/page';
import type { SignOutcome } from './flow';
import type { SignIntent } from './intent-repo';

const MEANING = { review: 'Reviewed', approve: 'Approved', reject: 'Rejected' } as const;

/** Demo users have no password: they re-authenticate by typing their user id. DEV_AUTH only. */
export function devConfirmPage(res: Response, intent: SignIntent, userName: string) {
  res
    .status(200)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>Confirm your signature</title>` +
        `<h1>Confirm your signature</h1>` +
        `<p>${escapeHtml(userName)}, you are signing finding <b>${escapeHtml(intent.findingId)}</b> as <b>${MEANING[intent.action]}</b>.</p>` +
        `<p>Demo sign-in has no password, so type your user id to confirm it is you.</p>` +
        `<form method="post" action="/auth/sign/${escapeHtml(intent.id)}/dev">` +
        `<input type="hidden" name="nonce" value="${escapeHtml(intent.nonce)}">` +
        `<label>User id <input name="confirm" autocomplete="off" autofocus></label> <button type="submit">Sign</button></form>`,
    );
}

/** The last page of the pop-up. The app is polling the request's status, so this window can close itself. */
export function resultPage(res: Response, outcome: SignOutcome) {
  const [status, title, message] = outcome.ok
    ? [200, 'Signed', 'Your signature was recorded. You can close this window.']
    : [409, 'Not signed', outcome.message];
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><h1>${escapeHtml(title)}</h1>` +
        `<p>${escapeHtml(message)}</p><script>setTimeout(function () { window.close(); }, 1500);</script>`,
    );
}
```

- [ ] **Step 8: Write the signing routes** `backend/src/signing/routes.ts`

```ts
import crypto from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DEV_ISSUER } from '../auth/dev-users';
import { actorOf, requireRole } from '../auth/http';
import { page } from '../auth/page';
import { READ_ROLES } from '../auth/roles';
import type { AuthDeps } from '../auth/routes';
import { getUser } from '../auth/user-repo';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import type { AuditService } from '../service';
import { completeSigning, failIntent, REAUTH_MAX_AGE_MS } from './flow';
import { createIntent, getIntent, getIntentByState } from './intent-repo';
import { devConfirmPage, resultPage } from './pages';

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Part 11 signing: a signing request, re-authentication in a pop-up, then the signature. */
export function signingRoutes(svc: AuditService, auth: AuthDeps) {
  const cfg = auth.config;
  const db = svc.db.kysely;
  const r = Router();
  const readers = requireRole(READ_ROLES);

  const reauthMethodFor = (issuer: string): 'oidc' | 'dev' | null =>
    issuer === DEV_ISSUER ? (cfg.devAuth ? 'dev' : null) : auth.oidc ? 'oidc' : null;

  // Under /api, so the session, CSRF and role gates in app.ts already apply.
  r.post('/api/engagements/:id/findings/:fid/sign-intents', readers, wrap(async (req, res) => {
    const body = z.object({ action: z.enum(['review', 'approve', 'reject']), comment: z.string().max(2000).default('') }).parse(req.body);
    const actor = actorOf(req);
    const engagementId = String(req.params.id);
    const findingId = String(req.params.fid);
    const { contentHash } = await svc.checkSignOff(engagementId, findingId, body.action, actor);
    const method = reauthMethodFor(req.auth!.user.issuer);
    if (!method) throw new AppError(409, 'No way to re-authenticate is configured for your account; ask your administrator', 'REAUTH_REQUIRED');
    const intent = await createIntent(db, { userId: actor.id, engagementId, findingId, action: body.action, comment: body.comment, contentHash });
    res.status(201).json({ intentId: intent.id, reauthUrl: `/auth/sign/${intent.id}`, method, expiresAt: intent.expiresAt });
  }));

  r.get('/api/sign-intents/:intentId', wrap(async (req, res) => {
    const intent = await getIntent(db, String(req.params.intentId));
    if (!intent || intent.userId !== req.auth!.user.id) throw new AppError(404, 'Signing request not found');
    res.json({ status: intent.status, code: intent.failureCode, message: intent.failureMessage });
  }));

  // The pop-up opens here (same origin, so the session cookie is sent).
  r.get('/auth/sign/:intentId', wrap(async (req, res) => {
    const user = req.auth?.user;
    const intent = await getIntent(db, String(req.params.intentId));
    if (!user || !intent || intent.userId !== user.id) return page(res, 404, 'Signing request not found', 'Start signing again from the finding.');
    if (intent.status !== 'pending' || Date.now() > Date.parse(intent.expiresAt)) {
      return page(res, 410, 'Signing request expired', 'Start signing again from the finding.');
    }
    const method = reauthMethodFor(user.issuer);
    if (method === 'oidc') return res.redirect(await auth.oidc!.reauthUrl({ state: intent.state, nonce: intent.nonce, codeVerifier: intent.codeVerifier }));
    if (method === 'dev') return devConfirmPage(res, intent, user.name);
    return page(res, 409, 'Cannot re-authenticate', 'No way to re-authenticate is configured for your account.');
  }));

  if (cfg.devAuth) {
    // A plain form post from the pop-up. The intent's secret nonce, only ever shown to its owner, stands in for the CSRF header.
    r.post('/auth/sign/:intentId/dev', express.urlencoded({ extended: false }), wrap(async (req, res) => {
      const user = req.auth?.user;
      const intent = await getIntent(db, String(req.params.intentId));
      if (!user || !intent || intent.userId !== user.id || !sameToken(String(req.body?.nonce ?? ''), intent.nonce)) {
        return page(res, 404, 'Signing request not found', 'Start signing again from the finding.');
      }
      if (!user.role) return page(res, 403, 'Cannot sign', 'Your account has no role.');
      const actor = { id: user.id, name: user.name, role: user.role };
      if (user.issuer !== DEV_ISSUER || String(req.body?.confirm ?? '') !== user.id) {
        return resultPage(res, await failIntent(svc, intent, actor, 'REAUTH_USER_MISMATCH', 'The identity you confirmed is not the signed-in user.'));
      }
      resultPage(res, await completeSigning(svc, intent, actor, { method: 'dev', at: new Date().toISOString() }));
    }));
  }

  /**
   * Called first by /auth/callback. When the identity provider's answer belongs to a
   * signing request (matched by state), verify it and sign; return false otherwise.
   * The session cookie is not needed (and is absent on this cross-site redirect): the
   * request names the signer, and the ID token must prove it is them, just now.
   */
  async function handleIdpCallback(req: Request, res: Response): Promise<boolean> {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const intent = state ? await getIntentByState(db, state) : null;
    if (!intent || !auth.oidc || !cfg.oidc) return false;

    const user = await getUser(db, intent.userId);
    if (!user || !user.active || !user.role) {
      resultPage(res, { ok: false, code: 'REAUTH_REQUIRED', message: 'This account can no longer sign.' });
      return true;
    }
    const actor = { id: user.id, name: user.name, role: user.role };
    const callbackUrl = new URL(cfg.oidc.redirectUri);
    for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') callbackUrl.searchParams.set(k, v);

    let identity;
    try {
      identity = await auth.oidc.finish(callbackUrl, { state: intent.state, nonce: intent.nonce, codeVerifier: intent.codeVerifier });
    } catch (err) {
      console.warn('Signing re-authentication rejected:', err instanceof Error ? err.message : err);
      resultPage(res, await failIntent(svc, intent, actor, 'REAUTH_REQUIRED', 'Re-authentication could not be verified. Try again.'));
      return true;
    }
    if (identity.issuer !== user.issuer || identity.subject !== user.subject) {
      resultPage(res, await failIntent(svc, intent, actor, 'REAUTH_USER_MISMATCH', 'You re-authenticated as a different person.'));
      return true;
    }
    if (identity.authTime === null || Date.now() - identity.authTime * 1000 > REAUTH_MAX_AGE_MS) {
      resultPage(res, await failIntent(svc, intent, actor, 'REAUTH_STALE', 'Your identity provider did not ask for your password just now. Try again.'));
      return true;
    }
    resultPage(res, await completeSigning(svc, intent, actor, { method: 'oidc', at: new Date(identity.authTime * 1000).toISOString() }));
    return true;
  }

  return { router: r, handleIdpCallback };
}
```

`auth.oidc!.reauthUrl` doesn't exist until Task 4. To keep this task compiling, add it to the `OidcClient` interface in `backend/src/auth/oidc.ts` now:

```ts
  /** The identity provider's sign-in URL that forces a fresh password entry, for signing. */
  reauthUrl(checks: OidcChecks): Promise<string>;
```

and implement it there, inside the object `createOidcClient` returns:

```ts
    async reauthUrl(checks) {
      const url = client.buildAuthorizationUrl(server, {
        redirect_uri: cfg.redirectUri,
        scope: cfg.scopes,
        code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
        code_challenge_method: 'S256',
        state: checks.state,
        nonce: checks.nonce,
        prompt: 'login',
        max_age: '0',
      });
      return url.href;
    },
```

Task 4 tests it end to end.

- [ ] **Step 9: Wire signing into the app.** In `backend/src/app.ts`:
- add `import { signingRoutes } from './signing/routes';` and `import { withSignatureStatus } from './signing/content-hash';`
- before `app.use(authRoutes(svc.db, auth));`, add `const signing = signingRoutes(svc, auth);`
- after `app.use(adminRoutes(svc.db, auth.config));`, add `app.use(signing.router);`
- in `GET /api/engagements/:id`, replace `.json(e)` with `.json(withSignatureStatus(e))`
- replace the body of the `POST /api/engagements/:id/findings/:fid/signoff` handler with:

```ts
  app.post('/api/engagements/:id/findings/:fid/signoff', readers, () => {
    throw new AppError(428, 'Signing needs re-authentication: start a signing request (POST …/sign-intents) instead', 'REAUTH_REQUIRED');
  });
```

- [ ] **Step 10: Register REQ-19.** In `backend/validation/requirements.json`, add after REQ-17, with a comma after REQ-17:

```json
  { "id": "REQ-19", "risk": "High", "text": "Each signature records full name, meaning and time, is displayed with the record, and is bound to the signed content by hash (21 CFR Part 11 §11.50, §11.70).", "evalKinds": [] }
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/signing-http.test.ts tests/api.test.ts`
Expected: PASS, 9 signing tests and 5 api tests.

- [ ] **Step 12: Run everything**

Run: `cd backend && npm test && npm run eval && npm run traceability | head -3 && npm run typecheck`
Expected: all green; eval 25/25; traceability `20/20`.

- [ ] **Step 13: Commit**

```bash
git add backend/src backend/tests backend/validation/requirements.json
git commit -m "Sign findings through a re-authenticated, single-use signing request

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---
### Task 4: Re-authentication at the identity provider for signing

**Files:**
- Modify: `backend/src/auth/routes.ts` (callback hands signing responses over), `backend/src/app.ts`
- Modify: `backend/tests/mock-oidc.ts` (record authorize parameters; configurable `auth_time`)
- Test: `backend/tests/signing-oidc.test.ts`
- Modify: `backend/validation/requirements.json` (REQ-18)

**Interfaces:**
- Consumes:
  - `signingRoutes(svc, auth).handleIdpCallback` (Task 3)
  - `OidcClient.reauthUrl` (Task 3)
  - `createOidcClient`, `startMockOidc` (1B)
  - `ensureDevUsers`, `devAuthConfig`, `signIn`, `newService`
- Produces:
  - `authRoutes(db, auth, hooks?: { idpCallback?: (req: Request, res: Response) => Promise<boolean> })`
  - Mock additions: `lastAuthorize(): Record<string, string>` and `setAuthTimeOffset(seconds: number)`

- [ ] **Step 1: Extend the mock identity provider.** In `backend/tests/mock-oidc.ts`:
- after `let nextUser: MockUser = …;`, add:

```ts
  let lastAuthorize: Record<string, string> = {};
  let authTimeOffset = 0;
```

- in the `/authorize` handler, after `const q = req.query as Record<string, string>;`, add `lastAuthorize = { ...q };`
- in the `/token` handler, replace `auth_time: now` in the ID-token claims with `auth_time: now - authTimeOffset`
- add to the returned object:

```ts
    /** Query parameters of the most recent /authorize request. */
    lastAuthorize: () => lastAuthorize,
    /** Pretend the user last entered their password this many seconds ago. */
    setAuthTimeOffset(seconds: number) {
      authTimeOffset = seconds;
    },
```

- [ ] **Step 2: Write the failing tests** `backend/tests/signing-oidc.test.ts`

```ts
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import type { OidcConfig } from '../src/auth/config';
import { createOidcClient, type OidcClient } from '../src/auth/oidc';
import { listSignatures } from '../src/db/signature-repo';
import { readTrail } from '../src/db/trail-repo';
import type { AuditService } from '../src/service';
import { newService } from './helpers';
import { devAuthConfig, signIn } from './http';
import { startMockOidc, type MockUser } from './mock-oidc';

const PRIYA: MockUser = { sub: 'priya-1', name: 'Priya Prakash', email: 'priya@example.test', groups: ['audit-cae'] };

describe('signing with identity-provider re-authentication', () => {
  let mock: Awaited<ReturnType<typeof startMockOidc>>;
  let oidcCfg: OidcConfig;
  let oidc: OidcClient;

  beforeAll(async () => {
    mock = await startMockOidc();
    oidcCfg = {
      issuer: mock.issuer, clientId: 'audit-platform', clientSecret: 'test-secret', redirectUri: 'http://localhost:5174/auth/callback',
      groupsClaim: 'groups', roleMap: { 'audit-cae': 'cae' }, allowInsecure: true, scopes: 'openid profile email',
    };
    oidc = await createOidcClient(oidcCfg);
  });
  afterAll(() => mock.close());
  beforeEach(() => mock.setAuthTimeOffset(0));

  /**
   * Demo users prepare and review a finding; the CAE signs in through the IdP.
   * DEV_AUTH and OIDC together are allowed outside production.
   */
  async function reviewedFinding(): Promise<{ svc: AuditService; app: ReturnType<typeof createApp>; id: string; fid: string }> {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const app = createApp(svc, { config: devAuthConfig({ devAuth: true, oidc: oidcCfg }), oidc });
    const auditor = await signIn(app, 'auditor');
    const id = (await auditor.post('/api/engagements', {
      name: 'Pharma', entity: 'Demo Pharma', site: 'OSD', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 'GMP',
      scopeStatement: 'Data integrity: HPLC audit trails and user access', packIds: ['pharma'],
    }).expect(201)).body.id as string;
    for (const m of ['scope', 'rcm']) await auditor.post(`/api/engagements/${id}/modules/${m}/run`).expect(200);
    await auditor.put(`/api/engagements/${id}/tests/PH-DI-01`, { designAdequate: true, observation: 'Audit trail review missing for 5 of 20 sequences', evidenceRefs: ['SEQ-Q2'], sampleTested: 20, exceptions: 5 }).expect(200);
    await auditor.post(`/api/engagements/${id}/modules/testing/run`).expect(200);
    const fid = (await auditor.post(`/api/engagements/${id}/modules/gaps/run`).expect(200)).body.engagement.findings[0].id as string;
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    const nonce = /name="nonce" value="([^"]+)"/.exec((await reviewer.get(intent.body.reauthUrl)).text)![1];
    await reviewer.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: 'reviewer' }).expect(200);
    return { svc, app, id, fid };
  }

  /** Signs Priya in through the IdP and returns a session with her CSRF token. */
  async function priyaSession(app: ReturnType<typeof createApp>) {
    mock.setUser(PRIYA);
    const agent = request.agent(app);
    const start = await agent.get('/auth/login').expect(302);
    const back = new URL((await fetch(start.headers.location, { redirect: 'manual' })).headers.get('location')!);
    await agent.get(back.pathname + back.search).expect(200);
    const csrf = (await agent.get('/api/me').expect(200)).body.csrfToken as string;
    return { agent, csrf };
  }

  /** Starts an approval, follows the pop-up to the IdP and back; the callback is sent WITHOUT cookies, like a cross-site redirect. */
  async function approveViaIdp(app: ReturnType<typeof createApp>, id: string, fid: string, asUser: MockUser) {
    const priya = await priyaSession(app);
    const intent = await priya.agent.post(`/api/engagements/${id}/findings/${fid}/sign-intents`).set('x-csrf-token', priya.csrf).send({ action: 'approve', comment: 'agreed' }).expect(201);
    expect(intent.body.method).toBe('oidc');
    const popup = await priya.agent.get(intent.body.reauthUrl).expect(302);
    mock.setUser(asUser);
    const back = new URL((await fetch(popup.headers.location, { redirect: 'manual' })).headers.get('location')!);
    const result = await request(app).get(back.pathname + back.search);
    const status = (await priya.agent.get(`/api/sign-intents/${intent.body.intentId}`).expect(200)).body;
    return { intent, popup, result, status };
  }

  it('asks the identity provider for a fresh sign-in and records the signature [REQ-18]', async () => {
    const { app, svc, id, fid } = await reviewedFinding();
    const { popup, result, status, intent } = await approveViaIdp(app, id, fid, PRIYA);
    const authorize = new URL(popup.headers.location);
    expect(authorize.origin).toBe(mock.issuer);
    expect(mock.lastAuthorize()).toMatchObject({ prompt: 'login', max_age: '0', code_challenge_method: 'S256', redirect_uri: oidcCfg.redirectUri });
    expect(result.status).toBe(200);
    expect(result.text).toMatch(/signature was recorded/);
    expect(status).toEqual({ status: 'signed', code: null, message: null });
    const approval = (await listSignatures(svc.db.kysely, id)).find((s) => s.meaning === 'Approved')!;
    expect(approval).toMatchObject({ userName: 'Priya Prakash', role: 'cae', reauthMethod: 'oidc', intentId: intent.body.intentId });
    expect(Date.now() - Date.parse(approval.reauthAt!)).toBeLessThan(60_000);
  });

  it('refuses a re-authentication older than two minutes [REQ-18]', async () => {
    const { app, svc, id, fid } = await reviewedFinding();
    mock.setAuthTimeOffset(300);
    const { status } = await approveViaIdp(app, id, fid, PRIYA);
    expect(status).toMatchObject({ status: 'failed', code: 'REAUTH_STALE' });
    expect((await listSignatures(svc.db.kysely, id)).filter((s) => s.meaning === 'Approved')).toEqual([]);
    expect((await readTrail(svc.db.kysely)).some((b) => b.moduleId === 'identity:sign-failed')).toBe(true);
  });

  it('refuses a re-authentication by a different person [REQ-18]', async () => {
    const { app, svc, id, fid } = await reviewedFinding();
    const { status } = await approveViaIdp(app, id, fid, { sub: 'someone-else', name: 'Someone Else', groups: ['audit-cae'] });
    expect(status).toMatchObject({ status: 'failed', code: 'REAUTH_USER_MISMATCH' });
    expect((await listSignatures(svc.db.kysely, id)).filter((s) => s.meaning === 'Approved')).toEqual([]);
  });

  it('signs once even if the callback is replayed, and a forged state is not a signing response', async () => {
    const { app, svc, id, fid } = await reviewedFinding();
    const priya = await priyaSession(app);
    const intent = await priya.agent.post(`/api/engagements/${id}/findings/${fid}/sign-intents`).set('x-csrf-token', priya.csrf).send({ action: 'approve' }).expect(201);
    const popup = await priya.agent.get(intent.body.reauthUrl).expect(302);
    const back = new URL((await fetch(popup.headers.location, { redirect: 'manual' })).headers.get('location')!);
    await request(app).get(back.pathname + back.search).expect(200);
    const replay = await request(app).get(back.pathname + back.search);
    expect(replay.text).not.toMatch(/signature was recorded/);
    expect((await listSignatures(svc.db.kysely, id)).filter((s) => s.meaning === 'Approved')).toHaveLength(1);

    back.searchParams.set('state', 'forged');
    const forged = await request(app).get(back.pathname + back.search);
    expect(forged.text).toMatch(/expired/i); // treated as an ordinary login callback without its cookie
  });
});
```

`devAuthConfig({ …, oidc: oidcCfg })` relies on `OidcConfig` including `scopes`, which 1B's final fix added.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/signing-oidc.test.ts`
Expected: FAIL. The IdP callback goes to the login handler, which finds no login cookie and answers "Sign-in expired", so the intent stays `pending`.

- [ ] **Step 4: Let the callback hand signing responses over.** In `backend/src/auth/routes.ts`:
- change the `express` import to `import { Router, type Request, type Response } from 'express';`
- add above `export function authRoutes`:

```ts
export interface AuthHooks {
  /** Gets the IdP callback first; returns true when it handled the response (e.g. a signing re-authentication). */
  idpCallback?: (req: Request, res: Response) => Promise<boolean>;
}
```

- change the signature to `export function authRoutes(db: Db, auth: AuthDeps, hooks: AuthHooks = {}): Router {`
- make this the first statement inside the `/auth/callback` handler, before `const home = …`:

```ts
      if (hooks.idpCallback && (await hooks.idpCallback(req, res))) return;
```

In `backend/src/app.ts`, change `app.use(authRoutes(svc.db, auth));` to:

```ts
  app.use(authRoutes(svc.db, auth, { idpCallback: signing.handleIdpCallback }));
```

- [ ] **Step 5: Register REQ-18.** In `backend/validation/requirements.json`, add after REQ-17, with a trailing comma:

```json
  { "id": "REQ-18", "risk": "High", "text": "Signing requires re-authentication within 120 seconds, bound to a single-use signing request for that finding, meaning and content (21 CFR Part 11 §11.200(a)).", "evalKinds": [] },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/signing-oidc.test.ts tests/oidc.test.ts`
Expected: PASS, 4 new tests and the 1B OIDC tests unchanged.

- [ ] **Step 7: Run everything**

Run: `cd backend && npm test && npm run eval && npm run traceability | head -3 && npm run typecheck`
Expected: all green; eval 25/25; traceability `21/21`.

- [ ] **Step 8: Commit**

```bash
git add backend/src backend/tests backend/validation/requirements.json
git commit -m "Re-authenticate signers at the identity provider within two minutes of signing

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---

### Task 5: Signing from the UI, signature display and docs

**Files:**
- Create: `frontend/src/signing.ts`, `frontend/src/signing.test.ts`
- Modify: `frontend/src/components/engagement/FindingsTab.tsx`, `frontend/src/api.ts` (friendly messages)
- Modify: `README.md`

**Interfaces:**
- Consumes:
  - `POST …/sign-intents` → `{ intentId, reauthUrl, method, expiresAt }`
  - `GET /api/sign-intents/:id` → `{ status, code, message }` (Task 3)
  - `SignOff.reauth`, `SignOff.broken` (Task 1)
- Produces:
  - `signWithReauth(engagementId, findingId, action, comment, deps?): Promise<void>`
  - `class SigningError extends Error { code: string | null }`
  - `interface SigningDeps { api; openPopup(url): { closed: boolean } | null; sleep(ms): Promise<void>; now(): number }`

- [ ] **Step 1: Write the failing tests** `frontend/src/signing.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { signWithReauth, type SigningDeps } from './signing';

/** Fake browser: the intent call returns `intent`, then each status poll returns the next queued status. */
function fakeDeps(statuses: { status: string; code?: string | null; message?: string | null }[], popup: { closed: boolean } | null = { closed: false }) {
  const calls: string[] = [];
  let t = 0;
  const deps: SigningDeps = {
    api: (async (path: string) => {
      calls.push(path);
      if (path.endsWith('/sign-intents')) {
        return { intentId: 'INT-1', reauthUrl: '/auth/sign/INT-1', method: 'dev', expiresAt: new Date(10 * 60_000).toISOString() };
      }
      const next = statuses.shift() ?? { status: 'pending' };
      return { code: null, message: null, ...next };
    }) as SigningDeps['api'],
    openPopup: () => popup,
    sleep: async () => {
      t += 1000;
    },
    now: () => t,
  };
  return { deps, calls };
}

describe('signWithReauth', () => {
  it('opens the re-authentication window and resolves once the signature is recorded', async () => {
    const { deps, calls } = fakeDeps([{ status: 'pending' }, { status: 'claimed' }, { status: 'signed' }]);
    await expect(signWithReauth('ENG-1', 'F-1', 'review', 'ok', deps)).resolves.toBeUndefined();
    expect(calls[0]).toBe('/engagements/ENG-1/findings/F-1/sign-intents');
    expect(calls.filter((c) => c === '/sign-intents/INT-1')).toHaveLength(3);
  });

  it('explains a finding that changed while signing', async () => {
    const { deps } = fakeDeps([{ status: 'failed', code: 'CONTENT_CHANGED', message: 'server text' }]);
    await expect(signWithReauth('ENG-1', 'F-1', 'approve', '', deps)).rejects.toMatchObject({
      code: 'CONTENT_CHANGED', message: expect.stringMatching(/changed after you started signing/),
    });
  });

  it('asks for pop-ups to be allowed when the window is blocked', async () => {
    const { deps } = fakeDeps([], null);
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', deps)).rejects.toMatchObject({ code: 'POPUP_BLOCKED' });
  });

  it('stops when the window is closed before re-authentication finishes, leaving nothing signed', async () => {
    const popup = { closed: false };
    const { deps } = fakeDeps([{ status: 'pending' }]);
    const sleeping = deps.sleep;
    deps.sleep = async (ms) => {
      popup.closed = true;
      await sleeping(ms);
    };
    deps.openPopup = () => popup;
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', deps)).rejects.toMatchObject({ code: 'POPUP_CLOSED' });
  });

  it('gives up when the signing request expires', async () => {
    const { deps } = fakeDeps([]);
    deps.now = () => 11 * 60_000;
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', deps)).rejects.toMatchObject({ code: 'INTENT_EXPIRED' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/signing.test.ts`
Expected: FAIL with `Failed to resolve import "./signing"`.

- [ ] **Step 3: Write the signing client** `frontend/src/signing.ts`

```ts
import { api } from './api';

export class SigningError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = 'SigningError';
  }
}

export interface SigningDeps {
  api: typeof api;
  openPopup: (url: string) => { closed: boolean } | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

interface Intent {
  intentId: string;
  reauthUrl: string;
  method: 'oidc' | 'dev';
  expiresAt: string;
}

interface IntentStatus {
  status: 'pending' | 'claimed' | 'signed' | 'failed';
  code: string | null;
  message: string | null;
}

const MESSAGES: Record<string, string> = {
  REAUTH_STALE: 'Your identity provider did not ask for your password just now. Try again and enter your password when asked.',
  REAUTH_USER_MISMATCH: 'You re-authenticated as a different person. Sign with the account you are signed in with.',
  INTENT_EXPIRED: 'The signing request expired. Start signing again.',
  CONTENT_CHANGED: 'The finding changed after you started signing. Review it again, then sign.',
  REAUTH_REQUIRED: 'Re-authentication did not complete. Try again.',
};

const browser: SigningDeps = {
  api,
  openPopup: (url) => window.open(url, 'audit-sign', 'popup,width=520,height=640'),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Signs a finding as a Part 11 electronic signature. It asks the server for a signing request,
 * opens the re-authentication window, then follows the request until it is signed or fails.
 */
export async function signWithReauth(
  engagementId: string,
  findingId: string,
  action: 'review' | 'approve' | 'reject',
  comment: string,
  deps: SigningDeps = browser,
): Promise<void> {
  const intent = await deps.api<Intent>(`/engagements/${engagementId}/findings/${findingId}/sign-intents`, { method: 'POST', body: { action, comment } });
  const popup = deps.openPopup(intent.reauthUrl);
  if (!popup) throw new SigningError('Your browser blocked the sign-in window. Allow pop-ups for this site, then sign again.', 'POPUP_BLOCKED');
  const deadline = Date.parse(intent.expiresAt);
  for (;;) {
    await deps.sleep(1000);
    const s = await deps.api<IntentStatus>(`/sign-intents/${intent.intentId}`);
    if (s.status === 'signed') return;
    if (s.status === 'failed') throw new SigningError((s.code && MESSAGES[s.code]) || s.message || 'Signing failed.', s.code);
    if (s.status === 'pending' && popup.closed) throw new SigningError('The sign-in window was closed before you finished. Nothing was signed.', 'POPUP_CLOSED');
    if (deps.now() > deadline) throw new SigningError(MESSAGES.INTENT_EXPIRED, 'INTENT_EXPIRED');
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/signing.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Use it in the findings tab.** In `frontend/src/components/engagement/FindingsTab.tsx`:
- add `Chip` to the `@mui/material` import, and add `import { signWithReauth } from '../../signing';`
- replace the `sign` helper in `FindingCard` with:

```tsx
  const sign = (action: 'review' | 'approve' | 'reject') => async () => {
    await signWithReauth(ctx.engagementId, f.id, action, comment);
    setComment('');
    await ctx.reload();
  };
```

- replace the sign-off line inside `f.signOffs.map(…)` with:

```tsx
              <Typography key={i} variant="body2" color="text.secondary">
                ✍ {s.meaning} by {s.userName} ({s.role}) at {new Date(s.at).toLocaleString()}
                {s.reauth && s.reauth.method !== 'none'
                  ? ` · re-authenticated ${s.reauth.method === 'oidc' ? 'with the identity provider' : 'by demo confirmation'}`
                  : ' · not re-authenticated'}
                {s.comment && ` — "${s.comment}"`}
                {s.broken && <Chip size="small" color="error" label="Signature broken: content changed after signing" sx={{ ml: 1 }} />}
              </Typography>
```

- in the action row, directly after the comment `TextField`, add:

```tsx
              <Typography variant="caption" color="text.secondary">
                Signing opens a window where you confirm your identity again.
              </Typography>
```

- [ ] **Step 6: Add the signing messages to the API client.** In `frontend/src/api.ts`, add these entries to `FRIENDLY`, so errors raised when a signing request is created read well too:

```ts
  REAUTH_REQUIRED: 'Signing needs you to confirm your identity again. Use the Sign buttons, which open the confirmation window.',
  CONTENT_CHANGED: 'The finding changed after you started signing. Review it again, then sign.',
```

- [ ] **Step 7: Document signing.** In `README.md`, add after the **Signing in** section:

```markdown
### Electronic signatures (21 CFR Part 11)

Signing a finding as **Reviewed**, **Approved** or **Rejected** is an electronic signature:

- **Confirm it's you, again, at the moment of signing.** A window opens:
  - With your organisation's sign-in, the identity provider asks for your password again. The signature only counts if you authenticated there within the last **2 minutes**.
  - With demo sign-in, you type your user id.
- **Bound to exactly what you saw.** The signature records the SHA-256 of the finding's content. If someone changes the finding while you are signing, the signature is refused ("the finding changed after you started signing").
- **Shown with the finding and in the report:** full name, role, meaning, time, and how you re-authenticated. Signatures are kept in an append-only table. A signature whose content no longer matches is flagged **broken**.
- **Single-use requests.** Each signing request lasts 5 minutes and works once. Failed attempts are recorded in the audit trail.

Seeded demo data is signed by the seed script without re-authentication and shows "not re-authenticated".
```

- [ ] **Step 8: Check the whole thing**

Run: `cd frontend && npm test && npm run typecheck && npm run build && cd ../backend && npm test && npm run eval && npm run traceability | head -3 && npm run typecheck`
Expected:
- frontend: 10 tests (5 api + 5 signing), typecheck and build OK
- backend: green, eval 25/25, traceability `21/21`

Then check it in the browser. Run `docker compose up -d postgres`, then `cd backend && npm run migrate && npm run dev` (with `DEV_AUTH=true` in `backend/.env`) and `cd frontend && npm run dev`. Open http://localhost:5174:
1. As Asha, run the chain to a finding.
2. As Ravi, click **Sign as reviewed**. A window asks for your user id: type `reviewer`. The window closes and the finding shows "Reviewed by Ravi Reviewer … re-authenticated by demo confirmation".
3. Try again with a wrong id. The error explains it.

Record what you saw in the task report, then stop the servers and run `docker compose down -v`.

- [ ] **Step 9: Commit**

```bash
git add frontend/src README.md
git commit -m "Sign from the UI through a re-authentication window and show how each signature was made

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---

## Done when

- **Signing needs fresh re-authentication.**
  - The old `/signoff` route returns 428.
  - Signing goes through a single-use, 5-minute signing request.
  - OIDC users re-authenticate with `prompt=login&max_age=0`, and the signature is accepted only if they authenticated within 120 s and are the same person.
  - Demo users confirm their user id (DEV_AUTH only).
- **Signatures are bound and permanent.**
  - Each signature is bound to the finding's content hash.
  - A signature is refused with `CONTENT_CHANGED` if the finding changed, and shown as broken if the content is altered behind the application.
  - Signatures and finding revisions are append-only.
  - The signature, the status change and the trail entry commit together, and failures are trailed.
- **The UI** opens the window, follows the request, and explains pop-up blocking, closing, expiry and every failure code.
- **Checks:** backend, frontend and eval green; traceability 21/21.

**Next plan:** 1D — Storage: `BlobStore` (S3, Azure Blob, local), the document registry (`documents`, `document_text`, `chunks`), and the `Retriever` with permission filtering in SQL.
