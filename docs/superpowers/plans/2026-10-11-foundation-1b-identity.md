# Foundation 1B — Identity, Roles and Segregation of Duties Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the demo "Acting as" user switcher with real sign-in. That means OIDC login against the client's identity provider (or a `DEV_AUTH` picker for development), server-side sessions with CSRF protection, five roles with segregation of duties enforced per finding, an admin page, and a UI that sends `If-Match` and shows a clear message when someone else changed the engagement.

**Architecture:**
- **Sign-in.** The backend runs the OIDC authorization-code flow with PKCE (`openid-client` v6) and never hands tokens to the browser.
- **Sessions.**
  - A random session token goes in an httpOnly `SameSite=Strict` cookie; only its SHA-256 is stored in `sessions`.
  - Each request resolves the session against `users`, so role changes and deactivation take effect on the very next request.
  - Every state-changing request must echo the session's CSRF token in `x-csrf-token`.
- **Roles.** Roles come from identity-provider groups through a configurable map, unless an admin has overridden them.
- **Segregation of duties.** Enforced in `AuditService` per finding by user id: whoever drafted or edited a finding may not sign it, and the reviewer may not approve it.
- **Audit trail.** Identity events (login, logout, role change, deactivation, session revocation) are sealed into the same hash-chained trail with `engagementId = null`.

**Tech Stack:** Node 22, TypeScript, Express 5, Kysely + Postgres 16, `openid-client` 6 (ESM, loaded with dynamic `import()`), `cookie-parser`, `jose` (test-only mock identity provider), vitest + Testcontainers; frontend React 18 + MUI 5 + vitest.

**Spec:** `docs/superpowers/specs/2026-10-11-production-foundation-design.md` (§4.1, §4.2, §4.3, §4.5, §8 codes, §9 sign-in, admin and conflict message, §11 REQ-16/REQ-17). Builds on plan 1A (`docs/superpowers/plans/2026-10-11-foundation-1a-postgres-persistence.md`), already merged into this branch.

## Global Constraints

- Builds on 1A. Persistence goes through Kysely, plain SQL migrations live in `backend/migrations/`, and the API never migrates on start-up. Add `003_identity.sql`; never edit `001`/`002`.
- Roles are exactly `auditor`, `audit_manager`, `cae`, `admin`, `viewer` (spec §4.2):
  - `auditor`: prepares the work.
  - `audit_manager`: everything an auditor may do, plus sign **Reviewed**.
  - `cae`: signs **Approved** / **Rejected**.
  - `admin`: manages users only and gets **no** audit content.
  - `viewer`: read-only.
- Segregation of duties (spec §4.3): the preparer (`preparedBy`, i.e. whoever ran Gap Writer for it, plus anyone who edited it since) cannot review or approve a finding, and the reviewer cannot approve it. Violations return `SOD_VIOLATION`.
- Session cookie:
  - Name `audit_session`, httpOnly, `SameSite=Strict`, `Secure` when `NODE_ENV=production`.
  - Idle timeout 30 min and absolute timeout 12 h (configurable). Admins can revoke sessions.
  - Raw tokens are never stored; the database holds their SHA-256.
- CSRF: every request with a method other than GET/HEAD/OPTIONS under `/api` and `/auth/logout` must send `x-csrf-token` equal to the session's token. The browser keeps that token in memory only and never in storage.
- The server refuses to start with `DEV_AUTH=true` and `NODE_ENV=production`.
- Users are never deleted, only deactivated (database trigger). New identity-provider users start with no role and see "pending access".
- Identity events are trailed with `engagementId: null` and `moduleId` values `identity:login`, `identity:logout`, `identity:role-change`, `identity:deactivate`, `identity:reactivate`, `identity:sessions-revoked`.
- Engine changes are limited to `backend/src/engine/types.ts`:
  - `Role`
  - `User.role`
  - optional `Finding.preparedBy`
  - nullable `TrailBundle.engagementId`
- Tests keep `[REQ-xx]` tags, and `npm run eval` stays 25/25. `validation/requirements.json` changes only as follows: REQ-15's text is updated, and REQ-16 and REQ-17 are added.
- Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote it.

**Deliberate refinements of the spec (1B):**
- **Group → role map.** It comes from configuration (`OIDC_ROLE_MAP`). The admin page shows it read-only instead of editing it. That keeps one source of truth, under change control in the deployment config.
- **Role precedence.** When a user's groups map to several roles, the first in `cae > audit_manager > auditor > admin > viewer` wins.
- **Conflict check granularity.** `If-Match` is checked against the whole engagement's version. A colleague's unrelated change also causes a "reload" prompt. That's coarse, but it can never silently overwrite.
- **Keycloak profile.** The `sso` compose profile runs Keycloak only. To test real OIDC, run the API on the host (`npm run dev`), because the browser and the API must see the same issuer URL.
- **`findings.csv` and `report.md` downloads** stay plain GET links and rely on the session cookie.

## Review Focus

1. **Session cookie replayed after logout.** The next request is 401, and the cookie is useless forever. Pinned in Task 3.
2. **Role changed by an admin, or user deactivated, while signed in.** The very next request uses the new role, or is refused (401 when deactivated). No re-login is needed for the change to bite. Pinned in Task 5.
3. **A state-changing request without the CSRF header** (another tab, a forged form). 403 `CSRF_FAILED`, and nothing changes. Pinned in Task 3.
4. **An admin removing their own admin role or deactivating themselves.** Refused with 409, so the last admin can't lock everyone out. Pinned in Task 5.
5. **IdP callback with no login cookie, a tampered state, or an IdP error.** A plain "sign-in failed" page, no session, no user created. Pinned in Task 4.

## File structure

| File | Responsibility |
|---|---|
| `backend/src/auth/roles.ts` | Role lists: read, preparer, reviewer, approver, precedence |
| `backend/src/auth/dev-users.ts` | Demo users for `DEV_AUTH`; `ensureDevUsers()` |
| `backend/migrations/003_identity.sql` | `users`, `sessions`, no-delete trigger on users |
| `backend/src/auth/user-repo.ts` | Provision from IdP, get/list, admin role/active changes |
| `backend/src/auth/session-repo.ts` | Create, resolve (idle/absolute expiry, touch), revoke |
| `backend/src/auth/identity-trail.ts` | `recordIdentityEvent()`: identity events into the trail |
| `backend/src/auth/config.ts` | `loadAuthConfig()`: DEV_AUTH, OIDC, session, cookie settings |
| `backend/src/auth/http.ts` | Session middleware, `requireUser`, `requireRole`, CSRF, cookies |
| `backend/src/auth/routes.ts` | `/auth/config`, dev login, logout, OIDC login/callback, `/api/me` |
| `backend/src/auth/oidc.ts` | `createOidcClient()`, `roleFromGroups()` |
| `backend/src/auth/admin-routes.ts` | `/api/admin/*` |
| `backend/src/http-util.ts` | Shared `wrap()` for async Express handlers |
| `backend/src/app.ts`, `server.ts`, `service.ts`, `seed.ts`, `eval/harness.ts`, `errors.ts`, `engine/types.ts` | Wiring and role changes |
| `backend/tests/http.ts`, `tests/mock-oidc.ts` | Sign-in helpers; in-process mock identity provider |
| `backend/tests/identity-repo.test.ts`, `auth.test.ts`, `oidc.test.ts`, `admin.test.ts` | New tests |
| `frontend/src/api.ts`, `session.tsx`, `roles.ts`, `App.tsx`, `pages/LoginPage.tsx`, `pages/PendingAccessPage.tsx`, `pages/AdminPage.tsx`, tabs | UI |
| `frontend/src/api.test.ts` | Unit tests for request headers and error mapping |
| `deploy/keycloak/audit-realm.json`, `docker-compose.yml`, `frontend/nginx.conf`, `frontend/vite.config.ts`, `README.md`, `backend/.env.example` | Packaging and docs |

---
### Task 1: Five roles and segregation of duties in the service

**Files:**
- Modify: `backend/src/engine/types.ts` (`Role`, `User.role`, `Finding.preparedBy?`, `TrailBundle.engagementId`)
- Create: `backend/src/auth/roles.ts`, `backend/src/auth/dev-users.ts`
- Modify: `backend/src/errors.ts`, `backend/src/service.ts`, `backend/src/app.ts`, `backend/src/seed.ts`, `backend/src/eval/harness.ts`
- Modify: `backend/tests/helpers.ts`, `backend/tests/engine.test.ts`, `backend/validation/requirements.json`
- Modify: `frontend/src/components/engagement/FindingsTab.tsx` (role names only, so the frontend still typechecks)

**Interfaces:**
- Consumes: the 1A `AuditService` (async, `mutate`, `humanBundle`, `emit`)
- Produces:
  - `type Role = 'auditor' | 'audit_manager' | 'cae' | 'admin' | 'viewer'`
  - `interface User { id: string; name: string; role: Role }`
  - `Finding.preparedBy?: string[]`
  - `TrailBundle.engagementId: string | null`
  - `ROLES`, `READ_ROLES`, `PREPARER_ROLES`, `REVIEWER_ROLES`, `APPROVER_ROLES`, `ROLE_PRECEDENCE`, `isRole(v): v is Role` from `src/auth/roles.ts`
  - `DEV_ISSUER = 'dev'`, `DEV_USERS: User[]` (ids `auditor`, `reviewer`, `approver`, `admin`, `viewer`), `devUser(id): User | undefined` from `src/auth/dev-users.ts`
  - `ErrorCode` gains `'SOD_VIOLATION' | 'CSRF_FAILED' | 'PENDING_ACCESS'`
  - test helper exports `auditor, reviewer, approver, admin, viewer`
- Removed: `USERS` and `AuditService.user()` from `service.ts`

- [ ] **Step 1: Write the failing tests.** In `backend/tests/helpers.ts`, replace the `USERS` import and the destructuring line:

```ts
import { DEV_USERS } from '../src/auth/dev-users';
import { AuditService } from '../src/service';
```

```ts
export const [auditor, reviewer, approver, admin, viewer] = DEV_USERS;
```

In `backend/tests/engine.test.ts`:
- add `import type { User } from '../src/engine/types';`
- extend the helpers import to `auditor, admin, approver, engagementWithFailedControl, FakeProvider, newService, registry, reviewer, viewer`
- change the expected sign-offs in `requires review then approval by a different person, with signature manifestation [REQ-08, REQ-15]` to:

```ts
    expect(done.signOffs.map((s) => [s.userId, s.role, s.meaning])).toEqual([
      ['reviewer', 'audit_manager', 'Reviewed'],
      ['approver', 'cae', 'Approved'],
    ]);
```

Then append this block at the end of the file:

```ts
describe('segregation of duties', () => {
  const manager2: User = { id: 'manager2', name: 'Maya Manager', role: 'audit_manager' };

  it('stops whoever ran Gap Writer from reviewing the findings it drafted [REQ-17]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    await svc.runModule(e.id, 'gaps', reviewer); // the audit manager redrafts, so now prepares the finding
    const f = (await svc.engagement(e.id)).findings[0];
    expect(f.preparedBy).toEqual(['reviewer']);
    await expect(svc.signOff(e.id, f.id, 'review', '', reviewer)).rejects.toMatchObject({ status: 403, code: 'SOD_VIOLATION' });
    await expect(svc.signOff(e.id, f.id, 'review', '', manager2)).resolves.toMatchObject({ status: 'reviewed' });
  });

  it('treats editing a finding as preparing it [REQ-17]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    expect(f.preparedBy).toEqual(['auditor']);
    const edited = await svc.editFinding(e.id, f.id, { title: 'Roaster CCP logs unsigned' }, reviewer);
    expect(edited.preparedBy).toEqual(['auditor', 'reviewer']);
    await expect(svc.signOff(e.id, f.id, 'review', '', reviewer)).rejects.toMatchObject({ code: 'SOD_VIOLATION' });
  });

  it('keeps the reviewer from also approving, judged by person rather than role [REQ-17]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.signOff(e.id, f.id, 'review', '', reviewer);
    const promoted: User = { ...reviewer, role: 'cae' }; // same person, given the CAE role between steps
    await expect(svc.signOff(e.id, f.id, 'approve', '', promoted)).rejects.toMatchObject({ status: 403, code: 'SOD_VIOLATION' });
  });

  it('gives admins and viewers no way to change audit work [REQ-15]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    for (const u of [admin, viewer]) {
      await expect(svc.runModule(e.id, 'report', u)).rejects.toMatchObject({ status: 403 });
      await expect(
        svc.recordTest(e.id, 'FD-HACCP-03', { designAdequate: true, observation: 'x', evidenceRefs: ['X'], sampleTested: 1, exceptions: 0 }, u),
      ).rejects.toMatchObject({ status: 403 });
      await expect(svc.signOff(e.id, e.findings[0].id, 'review', '', u)).rejects.toMatchObject({ status: 403 });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/engine.test.ts`
Expected: FAIL with `Cannot find module '../src/auth/dev-users'`.

- [ ] **Step 3: Update the engine types.** In `backend/src/engine/types.ts`:

Replace the `User` interface at the end of the file with:

```ts
export type Role = 'auditor' | 'audit_manager' | 'cae' | 'admin' | 'viewer';

export interface User {
  id: string;
  name: string;
  role: Role;
}
```

In `interface Finding`, add after `bundleId: string;`:

```ts
  /** Users who drafted or edited this finding since it was last reset; none of them may sign it. */
  preparedBy?: string[];
```

In `interface TrailBundle`, replace `engagementId: string;` with:

```ts
  /** null for identity events (login, role changes, …) that belong to no engagement. */
  engagementId: string | null;
```

- [ ] **Step 4: Create the role lists** `backend/src/auth/roles.ts`

```ts
import type { Role } from '../engine/types';

export const ROLES: readonly Role[] = ['auditor', 'audit_manager', 'cae', 'admin', 'viewer'];

/** Roles that may read audit content. Admins manage access only and see no audit content. */
export const READ_ROLES: readonly Role[] = ['auditor', 'audit_manager', 'cae', 'viewer'];

/** Roles that prepare audit work: create engagements, run modules, record tests, edit findings. */
export const PREPARER_ROLES: readonly Role[] = ['auditor', 'audit_manager'];

/** May sign a finding as Reviewed. */
export const REVIEWER_ROLES: readonly Role[] = ['audit_manager'];

/** May sign a finding as Approved or Rejected. */
export const APPROVER_ROLES: readonly Role[] = ['cae'];

/** When identity-provider groups map to several roles, the first role in this order wins. */
export const ROLE_PRECEDENCE: readonly Role[] = ['cae', 'audit_manager', 'auditor', 'admin', 'viewer'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
```

- [ ] **Step 5: Create the demo users** `backend/src/auth/dev-users.ts`

```ts
import type { User } from '../engine/types';

// Demo identities for DEV_AUTH (never available in production). The first three
// keep the MVP's ids so existing trail entries still name the same people.

export const DEV_ISSUER = 'dev';

export const DEV_USERS: User[] = [
  { id: 'auditor', name: 'Asha Auditor', role: 'auditor' },
  { id: 'reviewer', name: 'Ravi Reviewer', role: 'audit_manager' },
  { id: 'approver', name: 'Priya QA Head', role: 'cae' },
  { id: 'admin', name: 'Arun Admin', role: 'admin' },
  { id: 'viewer', name: 'Vera Viewer', role: 'viewer' },
];

export function devUser(id: string | undefined): User | undefined {
  return DEV_USERS.find((u) => u.id === id);
}
```

- [ ] **Step 6: Add the new error codes.** In `backend/src/errors.ts`, extend the `ErrorCode` union with three members after `'FINDING_LOCKED'`:

```ts
  | 'SOD_VIOLATION'
  | 'CSRF_FAILED'
  | 'PENDING_ACCESS'
```

- [ ] **Step 7: Enforce roles and segregation of duties in the service.** In `backend/src/service.ts`:

1. Replace the `import type { … } from './engine/types';` line with:

```ts
import type { Engagement, Finding, QaAction, Role, SignOff, TestInput, TrailBundle, User } from './engine/types';
```

   and add:

```ts
import { APPROVER_ROLES, PREPARER_ROLES, REVIEWER_ROLES } from './auth/roles';
```

2. Delete the `export const USERS: User[] = [ … ];` block, the `const PREPARERS = ['auditor', 'reviewer'];` line and the whole `user(id: string | undefined): User { … }` method.

3. Replace the `require` method with:

```ts
  private require(user: User, roles: readonly Role[], what: string) {
    if (!roles.includes(user.role)) throw new AppError(403, `${user.role} may not ${what}`);
  }
```

4. Replace every remaining `PREPARERS` with `PREPARER_ROLES`. That's five call sites: `createEngagement`, `runModule`, `setScope`, `recordTest` and `editFinding`.

5. In `runModule`, directly after `mod.apply(e, output, bundle.id);`, add:

```ts
      // Whoever runs Gap Writer prepared the findings it drafted, so they may not sign them.
      for (const f of e.findings) if (f.bundleId === bundle.id) f.preparedBy = [actor.id];
```

6. In `editFinding`, replace the `const edited: Finding = …` line with:

```ts
      const previous = e.findings[idx];
      const preparedBy = [...new Set([...(previous.preparedBy ?? []), actor.id])];
      const edited: Finding = { ...previous, ...patch, status: 'draft', signOffs: [], preparedBy };
```

7. In `signOff`, replace the `if (action === 'review') { … } else { … }` block with:

```ts
      const preparedBy = f.preparedBy ?? [];
      let meaning: SignOff['meaning'];
      if (action === 'review') {
        this.require(actor, REVIEWER_ROLES, 'review findings');
        if (f.status !== 'draft') throw new AppError(409, `Only draft findings can be reviewed (status ${f.status})`);
        if (preparedBy.includes(actor.id)) throw new AppError(403, 'You prepared this finding, so someone else must review it', 'SOD_VIOLATION');
        f.status = 'reviewed';
        meaning = 'Reviewed';
      } else {
        this.require(actor, APPROVER_ROLES, `${action} findings`);
        if (f.status !== 'reviewed') throw new AppError(409, 'Finding must be reviewed before approval or rejection');
        if (preparedBy.includes(actor.id)) throw new AppError(403, 'You prepared this finding, so someone else must approve it', 'SOD_VIOLATION');
        if (f.signOffs.some((s) => s.userId === actor.id)) throw new AppError(403, 'Approver must differ from reviewer', 'SOD_VIOLATION');
        f.status = action === 'approve' ? 'approved' : 'rejected';
        meaning = action === 'approve' ? 'Approved' : 'Rejected';
      }
```

   Delete the old `let meaning: SignOff['meaning'];` line above the block, which is now inside it.

- [ ] **Step 8: Keep the HTTP layer working until Task 3 replaces it.** In `backend/src/app.ts`:
- replace `import { AppError, AuditService, USERS, type MutationOptions } from './service';` with `import { AppError, AuditService, type MutationOptions } from './service';` and add `import { DEV_USERS, devUser } from './auth/dev-users';`
- replace the `actor` helper with:

```ts
  // Temporary until Task 3: the demo header identifies a demo user.
  const actor = (req: Request) => {
    const u = devUser(req.header('x-user-id'));
    if (!u) throw new AppError(401, 'Unknown user; send x-user-id header', 'UNAUTHENTICATED');
    return u;
  };
```

- replace `res.json(USERS)` in `/api/users` with `res.json(DEV_USERS)`.

- [ ] **Step 9: Update the seed and eval callers.**

In `backend/src/seed.ts`, replace `import { AuditService, USERS } from './service';` with:

```ts
import { DEV_USERS } from './auth/dev-users';
import { AuditService } from './service';
```

and replace `const [auditor, reviewer, approver] = USERS;` with `const [auditor, reviewer, approver] = DEV_USERS;`.

In `backend/src/eval/harness.ts`, replace `import { AuditService, ENGINE_VERSION, USERS } from '../service';` with `import { AuditService, ENGINE_VERSION } from '../service';` and add `import type { User } from '../engine/types';`. Inside `runFieldCase`, replace `const [auditor] = USERS;` with:

```ts
  const auditor: User = { id: 'eval', name: 'Evaluation harness', role: 'auditor' };
```

- [ ] **Step 10: Keep the frontend compiling with the new role names.** In `frontend/src/components/engagement/FindingsTab.tsx`, replace every `'reviewer'` string literal with `'audit_manager'` and every `'approver'` literal with `'cae'`. There are six occurrences in `FindingCard`. Then replace the two hint lines at the end of `FindingCard`'s action row with:

```tsx
          {f.status === 'draft' && role !== 'audit_manager' && <Typography variant="caption" color="text.secondary">Awaiting review by an audit manager.</Typography>}
          {f.status === 'reviewed' && role !== 'cae' && <Typography variant="caption" color="text.secondary">Awaiting approval by the Chief Audit Executive.</Typography>}
```

- [ ] **Step 11: Register the requirements.** In `backend/validation/requirements.json`, replace the REQ-15 line with:

```json
  { "id": "REQ-15", "risk": "Medium", "text": "Actions are restricted by role (auditor, audit manager, CAE, admin, viewer); admins and viewers cannot change audit work.", "evalKinds": [] },
```

and add after the REQ-21 entry, with a comma after REQ-21:

```json
  { "id": "REQ-17", "risk": "High", "text": "Actions are authorised by role, and the preparer, reviewer and approver of a finding are distinct people (21 CFR Part 11 §11.10(g)).", "evalKinds": [] }
```

- [ ] **Step 12: Run the tests to verify they pass**

Run: `cd backend && npm test && npm run eval && npm run typecheck && cd ../frontend && npm run typecheck`
Expected:
- all backend tests pass, including the 4 new segregation tests
- eval 25/25
- both typechecks exit 0

- [ ] **Step 13: Commit**

```bash
git add backend/src backend/tests backend/validation/requirements.json frontend/src/components/engagement/FindingsTab.tsx
git commit -m "Introduce five roles and enforce segregation of duties per finding

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---
### Task 2: Users, sessions and identity events in Postgres

**Files:**
- Create: `backend/migrations/003_identity.sql`
- Modify: `backend/src/db/schema.ts`
- Create: `backend/src/auth/user-repo.ts`, `backend/src/auth/session-repo.ts`, `backend/src/auth/identity-trail.ts`
- Modify: `backend/src/auth/dev-users.ts` (add `ensureDevUsers`)
- Test: `backend/tests/identity-repo.test.ts`

**Interfaces:**
- Consumes:
  - `Executor`, `appendTrail` (1A `src/db/trail-repo.ts`)
  - `readTrail`
  - `verifyChain`
  - `ENGINE_VERSION` (`src/service.ts`)
  - `Role`, `isRole`, `DEV_USERS`, `DEV_ISSUER` (Task 1)
  - `testDb()`
- Produces:
  - `interface UserRecord { id: string; issuer: string; subject: string; name: string; email: string | null; role: Role | null; roleSource: 'idp' | 'admin'; active: boolean; createdAt: string; lastLoginAt: string | null }`
  - `provisionUser(db, p: { issuer: string; subject: string; name: string; email: string | null; idpRole: Role | null }): Promise<UserRecord>`
  - `getUser(db, id): Promise<UserRecord | null>`
  - `listUsers(db): Promise<UserRecord[]>`
  - `setUserRole(db, id, role: Role | null): Promise<UserRecord | null>`
  - `setUserActive(db, id, active: boolean): Promise<UserRecord | null>`
  - `interface SessionPolicy { idleMinutes: number; maxHours: number }`
  - `interface ActiveSession { sessionId: string; user: UserRecord; csrfToken: string }`
  - `createSession(db, userId): Promise<{ token: string; csrfToken: string }>`
  - `resolveSession(db, token, policy, now?): Promise<ActiveSession | null>`
  - `revokeSession(db, token): Promise<boolean>`
  - `revokeUserSessions(db, userId): Promise<number>`
  - `recordIdentityEvent(db: Kysely<DB>, event: IdentityEvent, actor: { id: string; name: string; role: string | null }, inputs: unknown, output: unknown): Promise<TrailBundle>`
  - `type IdentityEvent = 'login' | 'logout' | 'role-change' | 'deactivate' | 'reactivate' | 'sessions-revoked'`
  - `ensureDevUsers(db: Executor): Promise<void>`

- [ ] **Step 1: Write the failing tests** `backend/tests/identity-repo.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import { recordIdentityEvent } from '../src/auth/identity-trail';
import { createSession, resolveSession, revokeSession, revokeUserSessions } from '../src/auth/session-repo';
import { getUser, listUsers, provisionUser, setUserActive, setUserRole } from '../src/auth/user-repo';
import { readTrail } from '../src/db/trail-repo';
import { verifyChain } from '../src/engine/trail';
import { testDb } from './db';

const POLICY = { idleMinutes: 30, maxHours: 12 };
const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const idp = (sub: string, idpRole: 'auditor' | 'cae' | null = 'auditor') => ({
  issuer: 'https://idp.example.com', subject: sub, name: `User ${sub}`, email: `${sub}@example.com`, idpRole,
});

describe('users', () => {
  it('provisions an identity-provider user once and follows later role changes from the IdP', async () => {
    const db = (await testDb()).kysely;
    const first = await provisionUser(db, idp('s1', 'auditor'));
    expect(first).toMatchObject({ role: 'auditor', roleSource: 'idp', active: true, email: 's1@example.com' });
    expect(first.id).toMatch(/^U-[0-9a-f]{12}$/);
    const again = await provisionUser(db, idp('s1', 'cae'));
    expect(again.id).toBe(first.id);
    expect(again.role).toBe('cae');
    expect(again.lastLoginAt).not.toBeNull();
  });

  it('keeps a role set by an admin even when the IdP says otherwise', async () => {
    const db = (await testDb()).kysely;
    const u = await provisionUser(db, idp('s2', null));
    expect(u.role).toBeNull();
    await setUserRole(db, u.id, 'audit_manager');
    const later = await provisionUser(db, idp('s2', 'auditor'));
    expect(later).toMatchObject({ role: 'audit_manager', roleSource: 'admin' });
  });

  it('creates exactly one user when the same person signs in twice at once', async () => {
    const db = (await testDb()).kysely;
    await Promise.all([provisionUser(db, idp('s3')), provisionUser(db, idp('s3'))]);
    expect((await listUsers(db)).filter((u) => u.subject === 's3')).toHaveLength(1);
  });

  it('never deletes users, and seeds the demo users idempotently', async () => {
    const db = (await testDb()).kysely;
    await ensureDevUsers(db);
    await ensureDevUsers(db);
    expect((await listUsers(db)).map((u) => [u.id, u.role])).toEqual([
      ['admin', 'admin'], ['approver', 'cae'], ['auditor', 'auditor'], ['reviewer', 'audit_manager'], ['viewer', 'viewer'],
    ]);
    await expect(db.deleteFrom('users').where('id', '=', 'auditor').execute()).rejects.toThrow(/append-only: DELETE/);
    expect(await getUser(db, 'nobody')).toBeNull();
  });
});

describe('sessions', () => {
  it('resolves a fresh session and never stores the raw token', async () => {
    const db = (await testDb()).kysely;
    const u = await provisionUser(db, idp('s4'));
    const { token, csrfToken } = await createSession(db, u.id);
    const s = await resolveSession(db, token, POLICY);
    expect(s).toMatchObject({ csrfToken, user: { id: u.id, role: 'auditor' } });
    const stored = await db.selectFrom('sessions').select('id').execute();
    expect(stored.map((r) => r.id)).not.toContain(token);
    expect(await resolveSession(db, 'not-a-token', POLICY)).toBeNull();
  });

  it('expires after 30 idle minutes and after 12 hours however active', async () => {
    const db = (await testDb()).kysely;
    const u = await provisionUser(db, idp('s5'));
    const idle = await createSession(db, u.id);
    expect(await resolveSession(db, idle.token, POLICY, minutes(31))).toBeNull();
    expect(await resolveSession(db, idle.token, POLICY)).toBeNull(); // revoked once expired

    const busy = await createSession(db, u.id);
    for (let m = 20; m <= 700; m += 20) expect(await resolveSession(db, busy.token, POLICY, minutes(m))).not.toBeNull();
    expect(await resolveSession(db, busy.token, POLICY, minutes(12 * 60 + 1))).toBeNull();
  });

  it('stops working after logout, revocation or deactivation', async () => {
    const db = (await testDb()).kysely;
    const u = await provisionUser(db, idp('s6'));
    const a = await createSession(db, u.id);
    expect(await revokeSession(db, a.token)).toBe(true);
    expect(await resolveSession(db, a.token, POLICY)).toBeNull();

    const b = await createSession(db, u.id);
    const c = await createSession(db, u.id);
    expect(await revokeUserSessions(db, u.id)).toBe(2);
    expect(await resolveSession(db, b.token, POLICY)).toBeNull();
    expect(await resolveSession(db, c.token, POLICY)).toBeNull();

    const d = await createSession(db, u.id);
    await setUserActive(db, u.id, false);
    expect(await resolveSession(db, d.token, POLICY)).toBeNull();
  });
});

describe('identity events', () => {
  it('seals identity events into the same chain with no engagement', async () => {
    const db = (await testDb()).kysely;
    await recordIdentityEvent(db, 'login', { id: 'auditor', name: 'Asha Auditor', role: 'auditor' }, { method: 'dev' }, { userId: 'auditor' });
    await recordIdentityEvent(db, 'logout', { id: 'auditor', name: 'Asha Auditor', role: 'auditor' }, {}, {});
    const trail = await readTrail(db);
    expect(trail.map((b) => [b.moduleId, b.engagementId, b.actor])).toEqual([
      ['identity:login', null, 'auditor'],
      ['identity:logout', null, 'auditor'],
    ]);
    expect(verifyChain(trail).valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/identity-repo.test.ts`
Expected: FAIL with `Cannot find module '../src/auth/identity-trail'`.

- [ ] **Step 3: Write the migration** `backend/migrations/003_identity.sql`

```sql
-- People and their sign-in sessions. Users are never deleted, only deactivated,
-- so every trail entry keeps resolving to a person.

CREATE TABLE users (
  id            text PRIMARY KEY,
  issuer        text NOT NULL,
  subject       text NOT NULL,
  name          text NOT NULL,
  email         text,
  role          text CHECK (role IN ('auditor', 'audit_manager', 'cae', 'admin', 'viewer')),
  role_source   text NOT NULL DEFAULT 'idp' CHECK (role_source IN ('idp', 'admin')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (issuer, subject)
);

CREATE TRIGGER users_never_deleted BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION reject_change();

-- id is the SHA-256 of the session cookie value; the raw token is never stored.
CREATE TABLE sessions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id),
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX sessions_live_by_user ON sessions (user_id) WHERE revoked_at IS NULL;
```

- [ ] **Step 4: Add the tables to the Kysely schema.** In `backend/src/db/schema.ts`, add `Role` to the type import from `../engine/types`, then add before `export interface DB`:

```ts
export interface UsersTable {
  id: string;
  issuer: string;
  subject: string;
  name: string;
  email: string | null;
  role: Role | null;
  role_source: ColumnType<'idp' | 'admin', 'idp' | 'admin' | undefined, 'idp' | 'admin'>;
  active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Generated<Date>;
  last_login_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  csrf_token: string;
  created_at: Generated<Date>;
  last_seen_at: DefaultedTimestamp;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}
```

and add `users: UsersTable;` and `sessions: SessionsTable;` to `interface DB`.

- [ ] **Step 5: Write the user repository** `backend/src/auth/user-repo.ts`

```ts
import crypto from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { Executor } from '../db/trail-repo';
import type { UsersTable } from '../db/schema';
import type { Role } from '../engine/types';

export interface UserRecord {
  id: string;
  issuer: string;
  subject: string;
  name: string;
  email: string | null;
  /** null until a role is mapped from the identity provider or assigned by an admin ("pending access"). */
  role: Role | null;
  /** 'admin' once an administrator has set the role; identity-provider groups no longer change it. */
  roleSource: 'idp' | 'admin';
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ProvisionInput {
  issuer: string;
  subject: string;
  name: string;
  email: string | null;
  idpRole: Role | null;
}

const iso = (d: Date | string) => new Date(d).toISOString();

export function toUserRecord(row: Selectable<UsersTable>): UserRecord {
  return {
    id: row.id, issuer: row.issuer, subject: row.subject, name: row.name, email: row.email, role: row.role,
    roleSource: row.role_source, active: row.active, createdAt: iso(row.created_at), lastLoginAt: row.last_login_at ? iso(row.last_login_at) : null,
  };
}

/**
 * Creates the user on first sign-in, or refreshes name, email and last login.
 * The role follows the identity provider unless an admin has set it.
 */
export async function provisionUser(db: Executor, p: ProvisionInput): Promise<UserRecord> {
  const now = new Date().toISOString();
  const row = await db
    .insertInto('users')
    .values({
      id: `U-${crypto.randomBytes(6).toString('hex')}`,
      issuer: p.issuer, subject: p.subject, name: p.name, email: p.email, role: p.idpRole, role_source: 'idp', last_login_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['issuer', 'subject']).doUpdateSet({
        name: (eb) => eb.ref('excluded.name'),
        email: (eb) => eb.ref('excluded.email'),
        last_login_at: (eb) => eb.ref('excluded.last_login_at'),
        role: sql<Role | null>`CASE WHEN users.role_source = 'idp' THEN excluded.role ELSE users.role END`,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return toUserRecord(row);
}

export async function getUser(db: Executor, id: string): Promise<UserRecord | null> {
  const row = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toUserRecord(row) : null;
}

export async function listUsers(db: Executor): Promise<UserRecord[]> {
  return (await db.selectFrom('users').selectAll().orderBy('id').execute()).map(toUserRecord);
}

export async function setUserRole(db: Executor, id: string, role: Role | null): Promise<UserRecord | null> {
  const row = await db.updateTable('users').set({ role, role_source: 'admin' }).where('id', '=', id).returningAll().executeTakeFirst();
  return row ? toUserRecord(row) : null;
}

export async function setUserActive(db: Executor, id: string, active: boolean): Promise<UserRecord | null> {
  const row = await db.updateTable('users').set({ active }).where('id', '=', id).returningAll().executeTakeFirst();
  return row ? toUserRecord(row) : null;
}
```

- [ ] **Step 6: Write the session repository** `backend/src/auth/session-repo.ts`

```ts
import crypto from 'node:crypto';
import type { Executor } from '../db/trail-repo';
import { toUserRecord, type UserRecord } from './user-repo';

export interface SessionPolicy {
  idleMinutes: number;
  maxHours: number;
}

export interface ActiveSession {
  /** SHA-256 of the cookie token. */
  sessionId: string;
  user: UserRecord;
  csrfToken: string;
}

/** last_seen_at is refreshed at most this often, so reads don't write on every request. */
const TOUCH_INTERVAL_MS = 60_000;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

export async function createSession(db: Executor, userId: string): Promise<{ token: string; csrfToken: string }> {
  const token = randomToken();
  const csrfToken = randomToken();
  await db.insertInto('sessions').values({ id: sha256(token), user_id: userId, csrf_token: csrfToken }).execute();
  return { token, csrfToken };
}

/**
 * The live session for a cookie token, or null when it is unknown, revoked,
 * idle too long, past its absolute lifetime, or its user is deactivated.
 * The user (and so the role) is read fresh on every call.
 */
export async function resolveSession(db: Executor, token: string, policy: SessionPolicy, now = new Date()): Promise<ActiveSession | null> {
  const id = sha256(token);
  const row = await db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select([
      's.csrf_token', 's.created_at as session_created_at', 's.last_seen_at', 's.revoked_at',
      'u.id', 'u.issuer', 'u.subject', 'u.name', 'u.email', 'u.role', 'u.role_source', 'u.active', 'u.created_at', 'u.last_login_at',
    ])
    .where('s.id', '=', id)
    .executeTakeFirst();
  if (!row || row.revoked_at || !row.active) return null;

  const t = now.getTime();
  const lastSeen = new Date(row.last_seen_at).getTime();
  const expired =
    t - new Date(row.session_created_at).getTime() > policy.maxHours * 3_600_000 || t - lastSeen > policy.idleMinutes * 60_000;
  if (expired) {
    await db.updateTable('sessions').set({ revoked_at: now.toISOString() }).where('id', '=', id).where('revoked_at', 'is', null).execute();
    return null;
  }
  if (t - lastSeen > TOUCH_INTERVAL_MS) {
    await db.updateTable('sessions').set({ last_seen_at: now.toISOString() }).where('id', '=', id).execute();
  }
  return { sessionId: id, csrfToken: row.csrf_token, user: toUserRecord(row) };
}

export async function revokeSession(db: Executor, token: string): Promise<boolean> {
  const res = await db
    .updateTable('sessions')
    .set({ revoked_at: new Date().toISOString() })
    .where('id', '=', sha256(token))
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) === 1;
}

export async function revokeUserSessions(db: Executor, userId: string): Promise<number> {
  const res = await db
    .updateTable('sessions')
    .set({ revoked_at: new Date().toISOString() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}
```

- [ ] **Step 7: Write the identity trail helper** `backend/src/auth/identity-trail.ts`

```ts
import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema';
import { appendTrail } from '../db/trail-repo';
import type { TrailBundle } from '../engine/types';
import { ENGINE_VERSION } from '../service';

export type IdentityEvent = 'login' | 'logout' | 'role-change' | 'deactivate' | 'reactivate' | 'sessions-revoked';

/** Seals an identity event (who signed in, who changed whose access) into the shared audit trail. */
export async function recordIdentityEvent(
  db: Kysely<DB>,
  event: IdentityEvent,
  actor: { id: string; name: string; role: string | null },
  inputs: unknown,
  output: unknown,
): Promise<TrailBundle> {
  const now = new Date().toISOString();
  const moduleId = `identity:${event}`;
  return db.transaction().execute((trx) =>
    appendTrail(trx, {
      id: `IDN-${crypto.randomBytes(4).toString('hex')}`,
      engagementId: null,
      moduleId,
      moduleVersion: ENGINE_VERSION,
      engineVersion: ENGINE_VERSION,
      packVersions: {},
      provider: { id: 'human', model: actor.id },
      promptHash: null,
      actor: actor.id,
      startedAt: now,
      finishedAt: now,
      inputs,
      retrievalSet: [],
      executionLog: [{ at: now, step: moduleId, detail: `${actor.name} (${actor.role ?? 'no role'})` }],
      qaActions: [],
      output,
    }),
  );
}
```

- [ ] **Step 8: Seed the demo users.** Append to `backend/src/auth/dev-users.ts`:

```ts
import type { Executor } from '../db/trail-repo';

/** Inserts the demo users if missing. Their roles count as admin-set, so they never drift. */
export async function ensureDevUsers(db: Executor): Promise<void> {
  await db
    .insertInto('users')
    .values(DEV_USERS.map((u) => ({ id: u.id, issuer: DEV_ISSUER, subject: u.id, name: u.name, email: null, role: u.role, role_source: 'admin' as const })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}
```

Move the new `import type { Executor } …` line up to join the existing import at the top of the file.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/identity-repo.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 10: Run everything**

Run: `cd backend && npm test && npm run eval && npm run typecheck`
Expected: all green; eval 25/25. Migration 003 also applies on PGlite.

- [ ] **Step 11: Commit**

```bash
git add backend/migrations/003_identity.sql backend/src/db/schema.ts backend/src/auth backend/tests/identity-repo.test.ts
git commit -m "Store users and sessions in Postgres and trail identity events

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---
### Task 3: Sessions, CSRF and role gates on every route (with `DEV_AUTH` sign-in)

**Files:**
- Create: `backend/src/auth/config.ts`, `backend/src/auth/http.ts`, `backend/src/auth/routes.ts`, `backend/src/http-util.ts`
- Rewrite: `backend/src/app.ts`; Modify: `backend/src/server.ts`, `backend/package.json` (cookie-parser)
- Create: `backend/tests/http.ts`; Rewrite: `backend/tests/api.test.ts`; Create: `backend/tests/auth.test.ts`

**Interfaces:**
- Consumes: Task 1 role lists and `DEV_USERS`/`DEV_ISSUER`; Task 2 `getUser`, `createSession`, `resolveSession`, `revokeSession`, `recordIdentityEvent`, `ensureDevUsers`, `UserRecord`, `SessionPolicy`, `ActiveSession`
- Produces (Tasks 4–6 rely on these):
  - `interface OidcConfig { issuer: string; clientId: string; clientSecret?: string; redirectUri: string; groupsClaim: string; roleMap: Record<string, Role>; allowInsecure: boolean }`
  - `interface AuthConfig { devAuth: boolean; secureCookies: boolean; publicUrl: string; session: SessionPolicy; oidc: OidcConfig | null }`
  - `loadAuthConfig(env?): AuthConfig`
  - `interface AuthDeps { config: AuthConfig }` (Task 4 adds `oidc`)
  - `createApp(svc: AuditService, auth: AuthDeps)`
  - `SESSION_COOKIE = 'audit_session'`
  - `sessionMiddleware(db, policy)`, `requireUser(opts?: { allowPending?: boolean })`, `requireRole(roles)`, `actorOf(req): User`, `setSessionCookie(res, token, cfg)`, `clearSessionCookie(res, cfg)`
  - `authRoutes(db: Db, auth: AuthDeps): Router`
  - `startSession(db: Db, res, cfg, user: UserRecord, method: string, details: object): Promise<void>`
  - `wrap(fn)` from `src/http-util.ts`
  - Routes:
    - `GET /auth/config` → `{ devAuth: boolean, oidc: boolean }`
    - `GET /auth/dev-users`, `POST /auth/dev-login { userId }` (only when `devAuth`)
    - `POST /auth/logout` (CSRF) → 204
    - `GET /api/me` → `{ user: { id, name, email, role }, csrfToken, pendingAccess }`
  - Test helpers: `devAuthConfig(overrides?)`, `appWithDevUsers()`, `signIn(app, userId)` → `{ agent, csrf, get, post, put, patch }`

- [ ] **Step 1: Add the dependency**

```bash
cd backend && npm install cookie-parser && npm install -D @types/cookie-parser
```

- [ ] **Step 2: Write the test helpers** `backend/tests/http.ts`

```ts
import request from 'supertest';
import { ensureDevUsers } from '../src/auth/dev-users';
import type { AuthConfig } from '../src/auth/config';
import { createApp } from '../src/app';
import { newService } from './helpers';

export function devAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    devAuth: true,
    secureCookies: false,
    publicUrl: 'http://localhost:5174',
    session: { idleMinutes: 30, maxHours: 12 },
    oidc: null,
    ...overrides,
  };
}

/** A service on a fresh database with the demo users, behind the real HTTP stack. */
export async function appWithDevUsers(config: AuthConfig = devAuthConfig()) {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  return { svc, app: createApp(svc, { config }) };
}

/** Signs in a demo user; the returned helpers carry the session cookie and CSRF token. */
export async function signIn(app: ReturnType<typeof createApp>, userId: string) {
  const agent = request.agent(app);
  await agent.post('/auth/dev-login').send({ userId }).expect(200);
  const me = await agent.get('/api/me').expect(200);
  const csrf = me.body.csrfToken as string;
  return {
    agent,
    csrf,
    get: (path: string) => agent.get(path),
    post: (path: string, body: object = {}) => agent.post(path).set('x-csrf-token', csrf).send(body),
    put: (path: string, body: object) => agent.put(path).set('x-csrf-token', csrf).send(body),
    patch: (path: string, body: object) => agent.patch(path).set('x-csrf-token', csrf).send(body),
  };
}
```

- [ ] **Step 3: Write the failing tests**

`backend/tests/auth.test.ts`:

```ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadAuthConfig } from '../src/auth/config';
import { readTrail } from '../src/db/trail-repo';
import { appWithDevUsers, devAuthConfig, signIn } from './http';

const NEW_ENGAGEMENT = {
  name: 'n', entity: 'e', site: 's', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 't', scopeStatement: 'hedging limits', packIds: ['common'],
};

describe('sign-in and sessions', () => {
  it('requires a session for audit content but not for health or sign-in options', async () => {
    const { app } = await appWithDevUsers();
    await request(app).get('/api/health').expect(200);
    expect((await request(app).get('/auth/config').expect(200)).body).toEqual({ devAuth: true, oidc: false });
    const res = await request(app).get('/api/engagements').expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect((await request(app).get('/api/users')).status).toBe(401);
  });

  it('signs a demo user in, shows who they are, and trails the login', async () => {
    const { app, svc } = await appWithDevUsers();
    const auditor = await signIn(app, 'auditor');
    const me = await auditor.get('/api/me').expect(200);
    expect(me.body).toMatchObject({ user: { id: 'auditor', name: 'Asha Auditor', role: 'auditor' }, pendingAccess: false });
    expect(me.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const trail = await readTrail(svc.db.kysely);
    expect(trail.map((b) => [b.moduleId, b.actor, b.engagementId])).toEqual([['identity:login', 'auditor', null]]);
    await request(app).post('/auth/dev-login').send({ userId: 'nobody' }).expect(401);
  });

  it('rejects a state-changing request without the CSRF token, and changes nothing', async () => {
    const { app } = await appWithDevUsers();
    const auditor = await signIn(app, 'auditor');
    const forged = await auditor.agent.post('/api/engagements').send(NEW_ENGAGEMENT);
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('CSRF_FAILED');
    expect((await auditor.agent.post('/api/engagements').set('x-csrf-token', 'wrong').send(NEW_ENGAGEMENT)).status).toBe(403);
    expect((await auditor.get('/api/engagements')).body).toEqual([]);
    await auditor.post('/api/engagements', NEW_ENGAGEMENT).expect(201);
  });

  it('makes the cookie useless after logout', async () => {
    const { app, svc } = await appWithDevUsers();
    const login = await request(app).post('/auth/dev-login').send({ userId: 'auditor' }).expect(200);
    const cookie = login.headers['set-cookie'] as unknown as string[];
    expect(cookie.join(';')).toMatch(/audit_session=.*HttpOnly.*SameSite=Strict/i);
    const me = await request(app).get('/api/me').set('Cookie', cookie).expect(200);
    await request(app).post('/auth/logout').set('Cookie', cookie).expect(403); // no CSRF token
    await request(app).post('/auth/logout').set('Cookie', cookie).set('x-csrf-token', me.body.csrfToken).expect(204);
    await request(app).get('/api/me').set('Cookie', cookie).expect(401);
    expect((await readTrail(svc.db.kysely)).map((b) => b.moduleId)).toEqual(['identity:login', 'identity:logout']);
  });

  it('keeps admins out of audit content and viewers read-only [REQ-15]', async () => {
    const { app } = await appWithDevUsers();
    const auditor = await signIn(app, 'auditor');
    await auditor.post('/api/engagements', NEW_ENGAGEMENT).expect(201);

    const admin = await signIn(app, 'admin');
    const denied = await admin.get('/api/engagements');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    await admin.get('/api/packs').expect(403);

    const viewer = await signIn(app, 'viewer');
    expect((await viewer.get('/api/engagements').expect(200)).body).toHaveLength(1);
    expect((await viewer.post('/api/engagements', NEW_ENGAGEMENT)).status).toBe(403);
    expect((await viewer.post('/api/eval/run')).status).toBe(403);
  });
});

describe('DEV_AUTH safety', () => {
  it('offers no demo sign-in when DEV_AUTH is off', async () => {
    const { app } = await appWithDevUsers(devAuthConfig({ devAuth: false }));
    await request(app).post('/auth/dev-login').send({ userId: 'auditor' }).expect(404);
    await request(app).get('/auth/dev-users').expect(404);
  });

  it('refuses to start with DEV_AUTH in production, and needs OIDC otherwise [REQ-16]', () => {
    const base = { DATABASE_URL: 'postgres://u:p@h/d' };
    expect(() => loadAuthConfig({ ...base, NODE_ENV: 'production', DEV_AUTH: 'true' })).toThrow(/DEV_AUTH must not be true in production/);
    expect(() => loadAuthConfig({ ...base, DEV_AUTH: 'false' })).toThrow(/OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_REDIRECT_URI are required/);
    expect(() =>
      loadAuthConfig({ ...base, NODE_ENV: 'production', OIDC_ISSUER: 'http://idp.example.com', OIDC_CLIENT_ID: 'c', OIDC_REDIRECT_URI: 'https://audit.example.com/auth/callback' }),
    ).toThrow(/OIDC_ISSUER must use https in production/);
    expect(() => loadAuthConfig({ ...base, DEV_AUTH: 'true', OIDC_ROLE_MAP: '{"g":"superuser"}' })).toThrow(/OIDC_ROLE_MAP/);

    const prod = loadAuthConfig({
      ...base, NODE_ENV: 'production', OIDC_ISSUER: 'https://login.example.com/tenant/v2.0', OIDC_CLIENT_ID: 'audit', OIDC_CLIENT_SECRET: 's',
      OIDC_REDIRECT_URI: 'https://audit.example.com/auth/callback', OIDC_ROLE_MAP: '{"Audit-CAE":"cae"}', PUBLIC_URL: 'https://audit.example.com',
    });
    expect(prod).toMatchObject({
      devAuth: false, secureCookies: true, publicUrl: 'https://audit.example.com', session: { idleMinutes: 30, maxHours: 12 },
      oidc: { issuer: 'https://login.example.com/tenant/v2.0', clientId: 'audit', clientSecret: 's', groupsClaim: 'groups', roleMap: { 'Audit-CAE': 'cae' }, allowInsecure: false },
    });
    expect(loadAuthConfig({ ...base, DEV_AUTH: 'true', OIDC_ISSUER: '', OIDC_CLIENT_ID: '' })).toMatchObject({ devAuth: true, secureCookies: false, oidc: null });
  });
});
```

Replace `backend/tests/api.test.ts`. The same journeys as before now run through real sessions:

```ts
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { appWithDevUsers, signIn } from './http';

describe('HTTP API', () => {
  let app: Awaited<ReturnType<typeof appWithDevUsers>>['app'];
  let auditor: Awaited<ReturnType<typeof signIn>>;
  let reviewer: Awaited<ReturnType<typeof signIn>>;
  let approver: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    ({ app } = await appWithDevUsers());
    [auditor, reviewer, approver] = await Promise.all([signIn(app, 'auditor'), signIn(app, 'reviewer'), signIn(app, 'approver')]);
  });

  it('runs a full engagement end to end over HTTP [REQ-06, REQ-15]', async () => {
    expect((await auditor.post('/api/engagements', {})).status).toBe(400);

    const created = await auditor.post('/api/engagements', {
      name: 'Pharma self-inspection', entity: 'Demo Pharma', site: 'OSD plant', periodFrom: '2026-01-01', periodTo: '2026-06-30',
      auditType: 'GMP self-inspection', scopeStatement: 'Data integrity: HPLC audit trails and user access; deviations and CAPA', packIds: ['pharma'],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    expect((await approver.post(`/api/engagements/${id}/modules/scope/run`)).status).toBe(403);
    const scope = await auditor.post(`/api/engagements/${id}/modules/scope/run`);
    expect(scope.status).toBe(200);
    expect(scope.body.engagement.scope.filter((s: any) => s.included).map((s: any) => s.controlId)).toContain('PH-DI-01');

    await auditor.post(`/api/engagements/${id}/modules/rcm/run`).expect(200);
    await auditor.put(`/api/engagements/${id}/tests/PH-DI-01`, { designAdequate: true, observation: 'Audit trail review missing for 5 of 20 sequences', evidenceRefs: ['SEQ-Q2'], sampleTested: 20, exceptions: 5 }).expect(200);
    await auditor.post(`/api/engagements/${id}/modules/testing/run`).expect(200);
    const gaps = await auditor.post(`/api/engagements/${id}/modules/gaps/run`).expect(200);
    const fid = gaps.body.engagement.findings[0].id;

    await reviewer.post(`/api/engagements/${id}/findings/${fid}/signoff`, { action: 'review' }).expect(200);
    await approver.post(`/api/engagements/${id}/findings/${fid}/signoff`, { action: 'approve', comment: 'ok' }).expect(200);
    await auditor.post(`/api/engagements/${id}/modules/report/run`).expect(200);

    const md = await auditor.get(`/api/engagements/${id}/report.md`).expect(200);
    expect(md.text).toContain('§11.10(e)');
    const csv = await auditor.get(`/api/engagements/${id}/findings.csv`).expect(200);
    expect(csv.text.split('\n')).toHaveLength(2);
    expect((await auditor.get('/api/trail/verify')).body.valid).toBe(true);
  });

  it('rejects exceptions greater than the sample', async () => {
    const id = (await auditor.get('/api/engagements')).body[0].id;
    const r = await auditor.put(`/api/engagements/${id}/tests/PH-DI-01`, { designAdequate: true, observation: '', evidenceRefs: ['x'], sampleTested: 2, exceptions: 3 });
    expect(r.status).toBe(400);
  });

  it('rejects a change sent with a stale If-Match version [REQ-21]', async () => {
    const id = (await auditor.get('/api/engagements')).body[0].id;
    const current = await auditor.get(`/api/engagements/${id}`).expect(200);
    expect(current.headers.etag).toBe(`"${current.body.version}"`);
    const body = { designAdequate: true, observation: 'All sequences reviewed', evidenceRefs: ['SEQ-Q3'], sampleTested: 20, exceptions: 0 };
    const put = () => auditor.agent.put(`/api/engagements/${id}/tests/PH-DI-01`).set('x-csrf-token', auditor.csrf);
    await put().set('If-Match', `"${current.body.version}"`).send(body).expect(200);
    const stale = await put().set('If-Match', `"${current.body.version}"`).send(body);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect((await put().set('If-Match', 'not-a-version').send(body)).status).toBe(400);
  });

  it('runs the evaluation harness over all packs and serves the traceability matrix [REQ-13]', async () => {
    const before = (await auditor.get('/api/trail/verify')).body.length;
    const run = await auditor.post('/api/eval/run').expect(200);
    expect(run.body.passed).toBe(run.body.total);
    expect((await auditor.get('/api/trail/verify')).body.length).toBe(before);
    expect((await auditor.get('/api/eval/runs')).body.map((r: any) => r.id)).toEqual([run.body.id]);
    const tm = await auditor.get('/api/validation/traceability').expect(200);
    const high = tm.body.rows.filter((r: any) => r.risk === 'High');
    expect(high.filter((r: any) => !r.covered).map((r: any) => r.id)).toEqual([]);
  }, 120_000);

  it('no longer trusts the demo x-user-id header', async () => {
    expect((await request(app).get('/api/engagements').set('x-user-id', 'auditor')).status).toBe(401);
  });
});
```

The traceability assertion lists any uncovered High requirement by id. Until Task 4 registers REQ-16 it is `[]` already, since REQ-16 is not yet in the file.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/auth.test.ts tests/api.test.ts`
Expected: FAIL with `Cannot find module '../src/auth/config'`.

- [ ] **Step 5: Write the auth configuration** `backend/src/auth/config.ts`

```ts
import { z } from 'zod';
import type { Role } from '../engine/types';
import { isRole } from './roles';
import type { SessionPolicy } from './session-repo';

// Identity settings for the API server. The database-only commands (migrate,
// seed, import-json, verify) keep using loadConfig() and need none of this.

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Public URL of /auth/callback as registered with the identity provider. */
  redirectUri: string;
  /** ID-token claim listing the user's groups. */
  groupsClaim: string;
  /** Identity-provider group → role. */
  roleMap: Record<string, Role>;
  /** Plain-http identity provider allowed (development and tests only). */
  allowInsecure: boolean;
}

export interface AuthConfig {
  devAuth: boolean;
  secureCookies: boolean;
  /** Where the browser app lives; used after sign-in. */
  publicUrl: string;
  session: SessionPolicy;
  oidc: OidcConfig | null;
}

const flag = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

const AuthEnv = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DEV_AUTH: flag,
    PUBLIC_URL: z.string().url().default('http://localhost:5174'),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).default(30),
    SESSION_MAX_HOURS: z.coerce.number().int().min(1).default(12),
    OIDC_ISSUER: z.string().url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_REDIRECT_URI: z.string().url().optional(),
    OIDC_GROUPS_CLAIM: z.string().min(1).default('groups'),
    OIDC_ROLE_MAP: z.string().default('{}'),
  })
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === 'production';
    if (production && env.DEV_AUTH) {
      ctx.addIssue({ code: 'custom', path: ['DEV_AUTH'], message: 'DEV_AUTH must not be true in production' });
    }
    const oidcSet = !!(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_REDIRECT_URI);
    if (!env.DEV_AUTH && !oidcSet) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_REDIRECT_URI are required unless DEV_AUTH=true' });
    }
    if (production && env.OIDC_ISSUER && !env.OIDC_ISSUER.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'OIDC_ISSUER must use https in production' });
    }
    if (parseRoleMap(env.OIDC_ROLE_MAP) === null) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ROLE_MAP'], message: 'OIDC_ROLE_MAP must be a JSON object of group → auditor | audit_manager | cae | admin | viewer' });
    }
  });

function parseRoleMap(raw: string): Record<string, Role> | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.values(value).every(isRole) ? (value as Record<string, Role>) : null;
  } catch {
    return null;
  }
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  // Compose passes unset optional settings as empty strings; treat them as absent.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = AuthEnv.safeParse(present);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  return {
    devAuth: e.DEV_AUTH,
    secureCookies: production,
    publicUrl: e.PUBLIC_URL.replace(/\/$/, ''),
    session: { idleMinutes: e.SESSION_IDLE_MINUTES, maxHours: e.SESSION_MAX_HOURS },
    oidc:
      e.OIDC_ISSUER && e.OIDC_CLIENT_ID && e.OIDC_REDIRECT_URI
        ? {
            issuer: e.OIDC_ISSUER,
            clientId: e.OIDC_CLIENT_ID,
            clientSecret: e.OIDC_CLIENT_SECRET,
            redirectUri: e.OIDC_REDIRECT_URI,
            groupsClaim: e.OIDC_GROUPS_CLAIM,
            roleMap: parseRoleMap(e.OIDC_ROLE_MAP) ?? {},
            allowInsecure: !production,
          }
        : null,
  };
}
```

- [ ] **Step 6: Write the shared handler wrapper** `backend/src/http-util.ts`

```ts
import type { NextFunction, Request, Response } from 'express';

/** Forwards errors from async route handlers to the Express error middleware. */
export const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);
```

- [ ] **Step 7: Write the session middleware and gates** `backend/src/auth/http.ts`

```ts
import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema';
import type { Role, User } from '../engine/types';
import { AppError } from '../errors';
import type { AuthConfig } from './config';
import { resolveSession, type ActiveSession, type SessionPolicy } from './session-repo';

declare module 'express-serve-static-core' {
  interface Request {
    /** The signed-in session, set by sessionMiddleware when the cookie resolves. */
    auth?: ActiveSession;
  }
}

export const SESSION_COOKIE = 'audit_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function sessionMiddleware(db: Kysely<DB>, policy: SessionPolicy): RequestHandler {
  return (req, _res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || !token) return next();
    resolveSession(db, token, policy).then((session) => {
      if (session) req.auth = session;
      next();
    }, next);
  };
}

function sameToken(sent: string, expected: string) {
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Requires a signed-in user. State-changing requests must echo the session's
 * CSRF token in x-csrf-token. Users without a role are "pending access" and
 * may only reach routes that opt in with allowPending.
 */
export function requireUser(opts: { allowPending?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    const session = req.auth;
    if (!session) return next(new AppError(401, 'Sign in to continue', 'UNAUTHENTICATED'));
    if (!SAFE_METHODS.has(req.method) && !sameToken(req.header('x-csrf-token') ?? '', session.csrfToken)) {
      return next(new AppError(403, 'Missing or invalid CSRF token; reload the page and try again', 'CSRF_FAILED'));
    }
    if (!session.user.role && !opts.allowPending) {
      return next(new AppError(403, 'Your account is waiting for an administrator to assign a role', 'PENDING_ACCESS'));
    }
    next();
  };
}

export function requireRole(roles: readonly Role[]): RequestHandler {
  return (req, _res, next) => {
    const role = req.auth?.user.role;
    if (!role || !roles.includes(role)) return next(new AppError(403, `${role ?? 'This account'} may not access this`, 'FORBIDDEN'));
    next();
  };
}

/** The signed-in user as the service sees them. */
export function actorOf(req: Request): User {
  const user = req.auth?.user;
  if (!user?.role) throw new AppError(401, 'Sign in to continue', 'UNAUTHENTICATED');
  return { id: user.id, name: user.name, role: user.role };
}

export function setSessionCookie(res: Response, token: string, cfg: AuthConfig) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: cfg.secureCookies, path: '/', maxAge: cfg.session.maxHours * 3_600_000,
  });
}

export function clearSessionCookie(res: Response, cfg: AuthConfig) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: cfg.secureCookies, path: '/' });
}
```

- [ ] **Step 8: Write the sign-in routes** `backend/src/auth/routes.ts`

```ts
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Db } from '../db';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import type { AuthConfig } from './config';
import { DEV_ISSUER, DEV_USERS } from './dev-users';
import { clearSessionCookie, requireUser, SESSION_COOKIE, setSessionCookie } from './http';
import { recordIdentityEvent } from './identity-trail';
import { createSession, revokeSession } from './session-repo';
import { getUser, type UserRecord } from './user-repo';

export interface AuthDeps {
  config: AuthConfig;
}

/** Opens a session for a user who has just proved who they are, and trails the login. */
export async function startSession(db: Db, res: Response, cfg: AuthConfig, user: UserRecord, method: string, details: object) {
  const { token } = await createSession(db.kysely, user.id);
  setSessionCookie(res, token, cfg);
  await recordIdentityEvent(db.kysely, 'login', user, { method, ...details }, { userId: user.id, role: user.role });
}

export function authRoutes(db: Db, auth: AuthDeps): Router {
  const cfg = auth.config;
  const r = Router();

  r.get('/auth/config', (_req, res) => res.json({ devAuth: cfg.devAuth, oidc: false }));

  if (cfg.devAuth) {
    r.get('/auth/dev-users', (_req, res) => res.json(DEV_USERS));
    r.post('/auth/dev-login', wrap(async (req, res) => {
      const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
      const user = await getUser(db.kysely, userId);
      if (!user || user.issuer !== DEV_ISSUER || !user.active) throw new AppError(401, 'Unknown or inactive demo user', 'UNAUTHENTICATED');
      await startSession(db, res, cfg, user, 'dev', {});
      res.json({ ok: true });
    }));
  }

  r.post('/auth/logout', requireUser({ allowPending: true }), wrap(async (req, res) => {
    await revokeSession(db.kysely, String(req.cookies[SESSION_COOKIE]));
    await recordIdentityEvent(db.kysely, 'logout', req.auth!.user, {}, {});
    clearSessionCookie(res, cfg);
    res.status(204).end();
  }));

  r.get('/api/me', requireUser({ allowPending: true }), (req, res) => {
    const { user, csrfToken } = req.auth!;
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, csrfToken, pendingAccess: !user.role });
  });

  return r;
}
```

- [ ] **Step 9: Rewrite the HTTP layer** `backend/src/app.ts`

```ts
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorOf, requireRole, requireUser, sessionMiddleware } from './auth/http';
import { PREPARER_ROLES, READ_ROLES } from './auth/roles';
import { authRoutes, type AuthDeps } from './auth/routes';
import { evalMarkdown, runEval } from './eval/harness';
import { wrap } from './http-util';
import { AppError, AuditService, type MutationOptions } from './service';
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

export function createApp(svc: AuditService, auth: AuthDeps) {
  const app = express();
  // Same-origin only: the UI is served behind the same host (nginx or the Vite proxy), so no CORS.
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionMiddleware(svc.db.kysely, auth.config.session));

  const param = (req: Request, name: string) => String(req.params[name]);

  /** `If-Match: "<version>"` opts a change into the optimistic-concurrency check. */
  const mutation = (req: Request): MutationOptions => {
    const header = req.header('if-match');
    if (header === undefined) return {};
    const version = Number(header.replace(/^W\//, '').replace(/"/g, ''));
    if (!Number.isInteger(version) || version < 1) throw new AppError(400, 'If-Match must be the engagement version number');
    return { expectedVersion: version };
  };

  // ----- Public -----
  app.get('/api/health', (_req, res) => res.json({ ok: true, provider: svc.providerInfo }));
  app.use(authRoutes(svc.db, auth));

  // ----- Everything below needs a signed-in user with a role (and CSRF on changes) -----
  app.use('/api', requireUser());
  const readers = requireRole(READ_ROLES);
  const evaluators = requireRole([...PREPARER_ROLES, 'cae']);

  app.get('/api/modules', readers, (_req, res) => res.json(svc.modules()));

  // ----- Content library -----
  app.get('/api/packs', readers, (_req, res) =>
    res.json(svc.registry.list().map(({ clauses, controls, evalCases, ...p }) => ({ ...p, clauseCount: clauses.length, controlCount: controls.length, evalCaseCount: evalCases.length }))),
  );
  app.get('/api/packs/:id', readers, wrap((req, res) => {
    const pack = svc.registry.packs.get(param(req, 'id'));
    if (!pack) throw new AppError(404, 'Pack not found');
    res.json(pack);
  }));
  app.get('/api/search', readers, (req, res) => {
    const q = String(req.query.q ?? '');
    const packIds = req.query.packs ? String(req.query.packs).split(',') : svc.registry.list().map((p) => p.id);
    const allowed = new Set(svc.registry.clausesFor(packIds).map((c) => c.id));
    const hits = svc.grounding.clauses.search(q, 10, (id) => allowed.has(id));
    res.json(hits.map((h) => ({ ...h, clause: svc.registry.clauses.get(h.clauseId) })));
  });

  // ----- Engagements -----
  app.get('/api/engagements', readers, wrap(async (_req, res) => res.json(await svc.listEngagements())));
  app.post('/api/engagements', readers, wrap(async (req, res) => {
    const body = NewEngagementSchema.parse(req.body);
    res.status(201).json(await svc.createEngagement(body, actorOf(req)));
  }));
  app.get('/api/engagements/:id', readers, wrap(async (req, res) => {
    const e = await svc.engagement(param(req, 'id'));
    res.set('ETag', `"${e.version}"`).json(e);
  }));

  app.post('/api/engagements/:id/modules/:moduleId/run', readers, wrap(async (req, res) => {
    const { bundle, engagement } = await svc.runModule(param(req, 'id'), param(req, 'moduleId'), actorOf(req), req.body ?? {}, mutation(req));
    res.json({ bundle, engagement });
  }));

  app.put('/api/engagements/:id/scope', readers, wrap(async (req, res) => {
    const items = z.array(z.object({ controlId: z.string(), included: z.boolean() })).parse(req.body.items);
    res.json(await svc.setScope(param(req, 'id'), items, actorOf(req), mutation(req)));
  }));

  app.put('/api/engagements/:id/tests/:rowId', readers, wrap(async (req, res) => {
    res.json(await svc.recordTest(param(req, 'id'), param(req, 'rowId'), TestInputSchema.parse(req.body), actorOf(req), mutation(req)));
  }));

  app.put('/api/engagements/:id/findings/:fid', readers, wrap(async (req, res) => {
    res.json(await svc.editFinding(param(req, 'id'), param(req, 'fid'), FindingPatchSchema.parse(req.body), actorOf(req), mutation(req)));
  }));

  app.post('/api/engagements/:id/findings/:fid/signoff', readers, wrap(async (req, res) => {
    const body = z.object({ action: z.enum(['review', 'approve', 'reject']), comment: z.string().default('') }).parse(req.body);
    res.json(await svc.signOff(param(req, 'id'), param(req, 'fid'), body.action, body.comment, actorOf(req), mutation(req)));
  }));

  app.get('/api/engagements/:id/report.md', readers, wrap(async (req, res) => {
    const e = await svc.engagement(param(req, 'id'));
    if (!e.report) throw new AppError(404, 'No report generated yet');
    res.type('text/markdown').attachment(`${e.id}-report.md`).send(e.report.markdown);
  }));

  app.get('/api/engagements/:id/findings.csv', readers, wrap(async (req, res) => {
    res.type('text/csv').attachment(`${param(req, 'id')}-findings.csv`).send(await svc.findingsCsv(param(req, 'id')));
  }));

  // ----- Evidence & validation -----
  app.get('/api/engagements/:id/trail', readers, wrap(async (req, res) => res.json(await svc.trailFor(param(req, 'id')))));
  app.get('/api/trail/verify', readers, wrap(async (_req, res) => res.json(await svc.verifyTrail())));

  app.post('/api/eval/run', evaluators, wrap(async (_req, res) => {
    const report = await runEval(svc.registry, svc.llm);
    await svc.saveEvalRun(report);
    res.json(report);
  }));
  app.get('/api/eval/runs', readers, wrap(async (_req, res) => res.json(await svc.listEvalRuns())));
  app.get('/api/eval/runs/:id', readers, wrap(async (req, res) => {
    const r = await svc.getEvalRun(param(req, 'id'));
    if (!r) throw new AppError(404, 'Eval run not found');
    res.json({ ...r, markdown: evalMarkdown(r) });
  }));
  app.get('/api/validation/traceability', readers, wrap(async (_req, res) => res.json(buildTraceability(await svc.latestEvalRun()))));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION', issues: err.issues });
    console.error(err);
    res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
  });

  return app;
}
```

Notes:
- **`readers` on mutating routes.** It keeps admins out of every engagement route. The service's own role checks still decide who may *change* things: viewers and the CAE get 403 from the service where they lack the role.
- **`/api/users` is gone.** Demo users are listed by `GET /auth/dev-users` only when `DEV_AUTH` is on.

- [ ] **Step 10: Wire configuration and demo users into the server.** In `backend/src/server.ts`, add these imports:

```ts
import { loadAuthConfig } from './auth/config';
import { ensureDevUsers } from './auth/dev-users';
```

Inside `main()`, directly after `const config = loadConfig();`, add:

```ts
  const auth = loadAuthConfig();
```

After the pending-migrations check, add:

```ts
  if (auth.devAuth) {
    await ensureDevUsers(db.kysely);
    console.warn('DEV_AUTH is on: demo sign-in is enabled. Never use this in production.');
  }
```

and replace `createApp(svc)` with `createApp(svc, { config: auth })`.

- [ ] **Step 11: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/auth.test.ts tests/api.test.ts`
Expected: PASS, 7 auth tests and 5 api tests.

- [ ] **Step 12: Run everything**

Run: `cd backend && npm test && npm run eval && npm run traceability | head -3 && npm run typecheck`
Expected: all green; eval 25/25; traceability `18/18`.

- [ ] **Step 13: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src backend/tests
git commit -m "Require signed-in sessions with CSRF protection and role gates on every route

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---
### Task 4: OIDC sign-in with group-to-role mapping

**Files:**
- Create: `backend/src/auth/oidc.ts`
- Modify: `backend/src/auth/routes.ts` (OIDC login/callback, `AuthDeps.oidc`), `backend/src/server.ts`, `backend/package.json` (`openid-client`, dev `jose`)
- Modify: `backend/tests/http.ts` (pass `oidc: null`)
- Create: `backend/tests/mock-oidc.ts`, `backend/tests/oidc.test.ts`
- Modify: `backend/validation/requirements.json` (REQ-16)

**Interfaces:**
- Consumes:
  - `OidcConfig`, `AuthConfig` (Task 3)
  - `startSession` (Task 3)
  - `provisionUser`, `setUserActive` (Task 2)
  - `ROLE_PRECEDENCE` (Task 1)
- Produces:
  - `interface OidcIdentity { issuer: string; subject: string; name: string; email: string | null; groups: string[]; authTime: number | null }`
  - `interface OidcChecks { state: string; nonce: string; codeVerifier: string }`
  - `interface OidcClient { start(): Promise<{ url: string } & OidcChecks>; finish(callbackUrl: URL, checks: OidcChecks): Promise<OidcIdentity> }`
  - `createOidcClient(cfg: OidcConfig): Promise<OidcClient>`
  - `roleFromGroups(groups: string[], roleMap: Record<string, Role>): Role | null`
  - `AuthDeps = { config: AuthConfig; oidc: OidcClient | null }`
  - Routes: `GET /auth/login` (302 to the identity provider) and `GET /auth/callback` (HTML page that redirects to `publicUrl`). `/auth/config` reports `oidc: true` when configured.
  - Test helper `startMockOidc()` → `{ issuer, setUser(u: MockUser), close() }`
  - `interface MockUser { sub: string; name: string; email?: string; groups?: string[] }`

`authTime` is unused here; plan 1C uses it for re-authentication at signing.

- [ ] **Step 1: Add the dependencies**

```bash
cd backend && npm install openid-client && npm install -D jose
```

- [ ] **Step 2: Write the mock identity provider** `backend/tests/mock-oidc.ts`

```ts
import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// A minimal, standards-shaped OpenID provider for tests: discovery, JWKS,
// authorization-code flow with PKCE (S256), signed RS256 ID tokens.

export interface MockUser {
  sub: string;
  name: string;
  email?: string;
  groups?: string[];
}

interface PendingCode {
  nonce: string;
  challenge: string;
  clientId: string;
  user: MockUser;
}

export async function startMockOidc() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();
  let nextUser: MockUser = { sub: 'user-1', name: 'Test User', groups: [] };

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  app.get('/.well-known/openid-configuration', (_req, res) =>
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    }),
  );
  app.get('/jwks', (_req, res) => res.json({ keys: [jwk] }));

  app.get('/authorize', (req, res) => {
    const q = req.query as Record<string, string>;
    const code = crypto.randomBytes(16).toString('hex');
    codes.set(code, { nonce: q.nonce, challenge: q.code_challenge, clientId: q.client_id, user: nextUser });
    const back = new URL(q.redirect_uri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.state);
    res.redirect(back.href);
  });

  app.post('/token', async (req, res) => {
    const pending = codes.get(req.body.code);
    codes.delete(req.body.code);
    if (!pending) return res.status(400).json({ error: 'invalid_grant' });
    const challenge = crypto.createHash('sha256').update(String(req.body.code_verifier)).digest('base64url');
    if (challenge !== pending.challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    const now = Math.floor(Date.now() / 1000);
    const u = pending.user;
    const idToken = await new SignJWT({ nonce: pending.nonce, name: u.name, email: u.email, groups: u.groups ?? [], auth_time: now })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience(pending.clientId)
      .setSubject(u.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    res.json({ access_token: crypto.randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
  });

  return {
    issuer,
    setUser(user: MockUser) {
      nextUser = user;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 3: Write the failing tests** `backend/tests/oidc.test.ts`

```ts
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { OidcConfig } from '../src/auth/config';
import { createOidcClient, roleFromGroups, type OidcClient } from '../src/auth/oidc';
import { listUsers, setUserActive } from '../src/auth/user-repo';
import { readTrail } from '../src/db/trail-repo';
import type { AuditService } from '../src/service';
import { newService } from './helpers';
import { devAuthConfig } from './http';
import { startMockOidc, type MockUser } from './mock-oidc';

describe('OIDC sign-in', () => {
  let mock: Awaited<ReturnType<typeof startMockOidc>>;
  let oidcCfg: OidcConfig;
  let oidc: OidcClient;

  beforeAll(async () => {
    mock = await startMockOidc();
    oidcCfg = {
      issuer: mock.issuer, clientId: 'audit-platform', clientSecret: 'test-secret', redirectUri: 'http://localhost:5174/auth/callback',
      groupsClaim: 'groups', roleMap: { 'audit-cae': 'cae', 'audit-auditors': 'auditor', 'audit-managers': 'audit_manager' }, allowInsecure: true,
    };
    oidc = await createOidcClient(oidcCfg);
  });
  afterAll(() => mock.close());

  async function setup(): Promise<{ svc: AuditService; app: ReturnType<typeof createApp> }> {
    const svc = await newService();
    return { svc, app: createApp(svc, { config: devAuthConfig({ devAuth: false, oidc: oidcCfg }), oidc }) };
  }

  /** Browser round trip: our /auth/login → IdP /authorize → our /auth/callback. */
  async function login(app: ReturnType<typeof createApp>, user: MockUser) {
    mock.setUser(user);
    const agent = request.agent(app);
    const start = await agent.get('/auth/login').expect(302);
    const authorize = await fetch(start.headers.location, { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location')!);
    const res = await agent.get(callback.pathname + callback.search);
    return { agent, res, callback };
  }

  it('signs a user in through the identity provider and maps their group to a role [REQ-16]', async () => {
    const { app, svc } = await setup();
    expect((await request(app).get('/auth/config')).body).toEqual({ devAuth: false, oidc: true });
    const { agent, res } = await login(app, { sub: 'p-1', name: 'Priya Prakash', email: 'priya@example.com', groups: ['audit-cae', 'staff'] });
    expect(res.status).toBe(200);
    expect(res.text).toContain('http://localhost:5174/');
    const me = await agent.get('/api/me').expect(200);
    expect(me.body).toMatchObject({ user: { name: 'Priya Prakash', email: 'priya@example.com', role: 'cae' }, pendingAccess: false });
    const login1 = (await readTrail(svc.db.kysely)).find((b) => b.moduleId === 'identity:login')!;
    expect(login1.inputs).toMatchObject({ method: 'oidc', issuer: mock.issuer, groups: ['audit-cae', 'staff'] });
  });

  it('follows group changes at the next sign-in, and leaves unmapped users pending', async () => {
    const { app } = await setup();
    await login(app, { sub: 'a-1', name: 'Anil', groups: ['audit-auditors'] });
    const { agent } = await login(app, { sub: 'a-1', name: 'Anil', groups: ['audit-managers'] });
    expect((await agent.get('/api/me')).body.user.role).toBe('audit_manager');

    const pending = await login(app, { sub: 'n-1', name: 'New Joiner', groups: ['staff'] });
    expect((await pending.agent.get('/api/me')).body).toMatchObject({ pendingAccess: true, user: { role: null } });
    const blocked = await pending.agent.get('/api/engagements');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PENDING_ACCESS');
  });

  it('refuses a callback without the login cookie or with a tampered state, creating nothing', async () => {
    const { app, svc } = await setup();
    const { callback } = await login(app, { sub: 'x-1', name: 'X', groups: ['audit-auditors'] });
    const noCookie = await request(app).get(callback.pathname + callback.search);
    expect(noCookie.status).toBe(400);
    expect(noCookie.text).toMatch(/expired/i);

    mock.setUser({ sub: 't-1', name: 'Tampered', groups: ['audit-cae'] });
    const agent = request.agent(app);
    const start = await agent.get('/auth/login').expect(302);
    const authorize = await fetch(start.headers.location, { redirect: 'manual' });
    const cb = new URL(authorize.headers.get('location')!);
    cb.searchParams.set('state', 'forged');
    const res = await agent.get(cb.pathname + cb.search);
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/could not be verified/);
    expect((await agent.get('/api/me')).status).toBe(401);
    expect((await listUsers(svc.db.kysely)).map((u) => u.subject)).toEqual(['x-1']);

    const denied = await agent.get('/auth/callback?error=access_denied&state=whatever');
    expect(denied.status).toBe(400);
  });

  it('turns away a deactivated user at the door', async () => {
    const { app, svc } = await setup();
    await login(app, { sub: 'd-1', name: 'Dee', groups: ['audit-auditors'] });
    const [dee] = await listUsers(svc.db.kysely);
    await setUserActive(svc.db.kysely, dee.id, false);
    const { agent, res } = await login(app, { sub: 'd-1', name: 'Dee', groups: ['audit-auditors'] });
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/deactivated/);
    expect((await agent.get('/api/me')).status).toBe(401);
  });

  it('picks the most senior mapped role when groups map to several', () => {
    const map = { a: 'viewer', b: 'auditor', c: 'cae', d: 'admin' } as const;
    expect(roleFromGroups(['a', 'b'], map)).toBe('auditor');
    expect(roleFromGroups(['d', 'c'], map)).toBe('cae');
    expect(roleFromGroups(['d', 'a'], map)).toBe('admin');
    expect(roleFromGroups(['zzz'], map)).toBeNull();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/oidc.test.ts`
Expected: FAIL with `Cannot find module '../src/auth/oidc'`.

- [ ] **Step 5: Write the OIDC client** `backend/src/auth/oidc.ts`

```ts
import type { Role } from '../engine/types';
import type { OidcConfig } from './config';
import { ROLE_PRECEDENCE } from './roles';

// openid-client v6 is ESM-only; this CommonJS backend loads it with import().
type OpenIdClient = typeof import('openid-client', { with: { 'resolution-mode': 'import' } });

export interface OidcChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  name: string;
  email: string | null;
  groups: string[];
  /** When the user last actually authenticated at the IdP (seconds since epoch). */
  authTime: number | null;
}

export interface OidcClient {
  start(): Promise<{ url: string } & OidcChecks>;
  finish(callbackUrl: URL, checks: OidcChecks): Promise<OidcIdentity>;
}

const text = (v: unknown) => (typeof v === 'string' && v ? v : null);

export async function createOidcClient(cfg: OidcConfig): Promise<OidcClient> {
  const client: OpenIdClient = await import('openid-client');
  const options = cfg.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined;
  const server = await client.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret, undefined, options);

  return {
    async start() {
      const codeVerifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(server, {
        redirect_uri: cfg.redirectUri,
        scope: 'openid profile email',
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      return { url: url.href, state, nonce, codeVerifier };
    },

    async finish(callbackUrl, checks) {
      const tokens = await client.authorizationCodeGrant(server, callbackUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('The identity provider returned no ID token');
      const rawGroups = claims[cfg.groupsClaim];
      return {
        issuer: claims.iss,
        subject: claims.sub,
        name: text(claims.name) ?? text(claims.preferred_username) ?? claims.sub,
        email: text(claims.email),
        groups: Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === 'string') : [],
        authTime: typeof claims.auth_time === 'number' ? claims.auth_time : null,
      };
    },
  };
}

/** The most senior role any of the user's groups maps to, or null (pending access). */
export function roleFromGroups(groups: string[], roleMap: Record<string, Role>): Role | null {
  const mapped = new Set(groups.map((g) => roleMap[g]).filter(Boolean));
  return ROLE_PRECEDENCE.find((r) => mapped.has(r)) ?? null;
}
```

- [ ] **Step 6: Add the OIDC routes.** In `backend/src/auth/routes.ts`:

Add imports:

```ts
import type { OidcChecks, OidcClient } from './oidc';
import { roleFromGroups } from './oidc';
import { provisionUser } from './user-repo';
```

(merge the last one with the existing `./user-repo` import).

Replace `AuthDeps` with:

```ts
export interface AuthDeps {
  config: AuthConfig;
  /** null when no identity provider is configured (DEV_AUTH only). */
  oidc: OidcClient | null;
}

const LOGIN_COOKIE = 'audit_oidc';
const LOGIN_COOKIE_MAX_AGE_MS = 10 * 60_000;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A tiny HTML page. Redirecting from our own page keeps the SameSite=Strict session cookie on the next request. */
function page(res: Response, status: number, title: string, message: string, next?: string) {
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

Change `/auth/config` to report OIDC:

```ts
  r.get('/auth/config', (_req, res) => res.json({ devAuth: cfg.devAuth, oidc: !!auth.oidc }));
```

Add before `r.post('/auth/logout', …)`:

```ts
  const oidc = auth.oidc;
  const oidcCfg = cfg.oidc;
  if (oidc && oidcCfg) {
    r.get('/auth/login', wrap(async (_req, res) => {
      const { url, ...checks } = await oidc.start();
      res.cookie(LOGIN_COOKIE, Buffer.from(JSON.stringify(checks)).toString('base64url'), {
        httpOnly: true, sameSite: 'lax', secure: cfg.secureCookies, path: '/auth', maxAge: LOGIN_COOKIE_MAX_AGE_MS,
      });
      res.redirect(url);
    }));

    r.get('/auth/callback', wrap(async (req, res) => {
      const home = `${cfg.publicUrl}/`;
      const raw: unknown = req.cookies?.[LOGIN_COOKIE];
      res.clearCookie(LOGIN_COOKIE, { path: '/auth' });
      let checks: OidcChecks;
      try {
        checks = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
        if (typeof raw !== 'string' || !checks.state || !checks.nonce || !checks.codeVerifier) throw new Error('missing');
      } catch {
        return page(res, 400, 'Sign-in expired', 'Your sign-in attempt expired. Please start again.', home);
      }

      // The token request must use the redirect URI exactly as registered, whatever host the proxy forwarded.
      const callbackUrl = new URL(oidcCfg.redirectUri);
      for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') callbackUrl.searchParams.set(k, v);

      let identity;
      try {
        identity = await oidc.finish(callbackUrl, checks);
      } catch (err) {
        console.warn('OIDC callback rejected:', err instanceof Error ? err.message : err);
        return page(res, 400, 'Sign-in failed', 'The identity provider response could not be verified. Please try again.', home);
      }

      const user = await provisionUser(db.kysely, {
        issuer: identity.issuer, subject: identity.subject, name: identity.name, email: identity.email,
        idpRole: roleFromGroups(identity.groups, oidcCfg.roleMap),
      });
      if (!user.active) return page(res, 403, 'Account deactivated', 'Your account has been deactivated. Contact your administrator.');
      await startSession(db, res, cfg, user, 'oidc', { issuer: identity.issuer, groups: identity.groups });
      page(res, 200, 'Signed in', 'Signed in. Taking you to the audit platform…', home);
    }));
  }
```

- [ ] **Step 7: Pass the OIDC client everywhere `createApp` is called.**

In `backend/tests/http.ts`, change `createApp(svc, { config })` to `createApp(svc, { config, oidc: null })`.

In `backend/src/server.ts`, add `import { createOidcClient } from './auth/oidc';`. After the DEV_AUTH block, add:

```ts
  const oidc = auth.oidc ? await createOidcClient(auth.oidc) : null;
  if (oidc) console.log(`Sign-in via ${auth.oidc!.issuer}`);
```

and change `createApp(svc, { config: auth })` to `createApp(svc, { config: auth, oidc })`.

- [ ] **Step 8: Register REQ-16.** In `backend/validation/requirements.json`, add after REQ-15, with a trailing comma:

```json
  { "id": "REQ-16", "risk": "High", "text": "Users authenticate through the configured OIDC identity provider; demo sign-in is impossible in production (21 CFR Part 11 §11.10(d)).", "evalKinds": [] },
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/oidc.test.ts`
Expected: PASS, 5 tests.

If `client.discovery` refuses the plain-http mock even with `allowInsecureRequests`, that's an installed-version API difference. Check the installed `openid-client` README for the option name, and keep the `allowInsecure` config flag as the switch.

- [ ] **Step 10: Run everything**

Run: `cd backend && npm test && npm run eval && npm run traceability | head -3 && npm run typecheck`
Expected: all green; eval 25/25; traceability `19/19`.

- [ ] **Step 11: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src backend/tests backend/validation/requirements.json
git commit -m "Sign users in through OIDC with PKCE and map IdP groups to roles

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---
### Task 5: Admin API — users, role overrides, deactivation, session revocation

**Files:**
- Create: `backend/src/auth/admin-routes.ts`
- Modify: `backend/src/app.ts` (mount it)
- Test: `backend/tests/admin.test.ts`

**Interfaces:**
- Consumes:
  - `listUsers`, `getUser`, `setUserRole`, `setUserActive` (Task 2)
  - `revokeUserSessions` (Task 2)
  - `recordIdentityEvent` (Task 2)
  - `requireRole`, `actorOf` (Task 3)
  - `AuthConfig` (Task 3)
  - `isRole` (Task 1)
  - test helpers `appWithDevUsers`, `signIn`
- Produces (the frontend admin page in Task 7 uses these):
  - `GET /api/admin/users` → `UserRecord[]`
  - `PATCH /api/admin/users/:id { role?: Role | null, active?: boolean }` → `UserRecord`
  - `POST /api/admin/users/:id/revoke-sessions` → `{ revoked: number }`
  - `GET /api/admin/settings` → `{ devAuth, oidc: { issuer, groupsClaim, roleMap } | null, session: { idleMinutes, maxHours } }`
  - `adminRoutes(db: Db, cfg: AuthConfig): Router`

- [ ] **Step 1: Write the failing tests** `backend/tests/admin.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { readTrail } from '../src/db/trail-repo';
import { appWithDevUsers, signIn } from './http';

describe('administration', () => {
  it('is for admins only', async () => {
    const { app } = await appWithDevUsers();
    for (const id of ['auditor', 'reviewer', 'approver', 'viewer']) {
      const u = await signIn(app, id);
      expect((await u.get('/api/admin/users')).status).toBe(403);
    }
    const admin = await signIn(app, 'admin');
    const users = (await admin.get('/api/admin/users').expect(200)).body;
    expect(users.map((u: any) => [u.id, u.role, u.active])).toContainEqual(['auditor', 'auditor', true]);
    expect((await admin.get('/api/admin/settings').expect(200)).body).toEqual({
      devAuth: true, oidc: null, session: { idleMinutes: 30, maxHours: 12 },
    });
  });

  it('changes a role with effect on the very next request, and trails it', async () => {
    const { app, svc } = await appWithDevUsers();
    const viewer = await signIn(app, 'viewer');
    expect((await viewer.post('/api/engagements', { name: 'n', entity: 'e', site: 's', periodFrom: 'a', periodTo: 'b', auditType: 't', scopeStatement: 'hedging', packIds: ['common'] })).status).toBe(403);

    const admin = await signIn(app, 'admin');
    const updated = await admin.patch('/api/admin/users/viewer', { role: 'auditor' }).expect(200);
    expect(updated.body).toMatchObject({ id: 'viewer', role: 'auditor', roleSource: 'admin' });

    await viewer.post('/api/engagements', { name: 'n', entity: 'e', site: 's', periodFrom: 'a', periodTo: 'b', auditType: 't', scopeStatement: 'hedging', packIds: ['common'] }).expect(201);
    const change = (await readTrail(svc.db.kysely)).find((b) => b.moduleId === 'identity:role-change')!;
    expect(change).toMatchObject({ actor: 'admin', engagementId: null, inputs: { userId: 'viewer', from: 'viewer', to: 'auditor' } });

    await admin.patch('/api/admin/users/viewer', { role: null }).expect(200);
    const pending = await viewer.get('/api/engagements');
    expect(pending.body.code).toBe('PENDING_ACCESS');
    expect((await admin.patch('/api/admin/users/viewer', { role: 'superuser' })).status).toBe(400);
    expect((await admin.patch('/api/admin/users/nobody', { role: 'auditor' })).status).toBe(404);
  });

  it('deactivating a user ends their sessions at once; reactivating lets them sign in again', async () => {
    const { app, svc } = await appWithDevUsers();
    const auditor = await signIn(app, 'auditor');
    const admin = await signIn(app, 'admin');
    await admin.patch('/api/admin/users/auditor', { active: false }).expect(200);
    expect((await auditor.get('/api/me')).status).toBe(401);
    expect((await auditor.agent.post('/auth/dev-login').send({ userId: 'auditor' })).status).toBe(401);
    await admin.patch('/api/admin/users/auditor', { active: true }).expect(200);
    await signIn(app, 'auditor');
    const events = (await readTrail(svc.db.kysely)).map((b) => b.moduleId);
    expect(events).toEqual(expect.arrayContaining(['identity:deactivate', 'identity:reactivate']));
  });

  it('signs a user out everywhere on request', async () => {
    const { app } = await appWithDevUsers();
    const a1 = await signIn(app, 'auditor');
    const a2 = await signIn(app, 'auditor');
    const admin = await signIn(app, 'admin');
    expect((await admin.post('/api/admin/users/auditor/revoke-sessions').expect(200)).body).toEqual({ revoked: 2 });
    expect((await a1.get('/api/me')).status).toBe(401);
    expect((await a2.get('/api/me')).status).toBe(401);
  });

  it('will not let an admin lock themselves out', async () => {
    const { app } = await appWithDevUsers();
    const admin = await signIn(app, 'admin');
    expect((await admin.patch('/api/admin/users/admin', { role: 'viewer' })).status).toBe(409);
    expect((await admin.patch('/api/admin/users/admin', { active: false })).status).toBe(409);
    expect((await admin.get('/api/admin/users')).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/admin.test.ts`
Expected: FAIL. The admin routes don't exist yet, so requests get 403 (for the admin, from the `readers` gate) or 404 where 200 is expected.

- [ ] **Step 3: Write the admin routes** `backend/src/auth/admin-routes.ts`

```ts
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import type { AuthConfig } from './config';
import { actorOf, requireRole } from './http';
import { recordIdentityEvent } from './identity-trail';
import { isRole } from './roles';
import { revokeUserSessions } from './session-repo';
import { getUser, listUsers, setUserActive, setUserRole } from './user-repo';

const PatchUser = z
  .object({
    role: z.string().nullable().refine((r) => r === null || isRole(r), 'role must be auditor, audit_manager, cae, admin, viewer or null'),
    active: z.boolean(),
  })
  .partial();

/** User administration. Admins manage access only; they never see audit content. */
export function adminRoutes(db: Db, cfg: AuthConfig): Router {
  const r = Router();
  r.use('/api/admin', requireRole(['admin']));

  r.get('/api/admin/users', wrap(async (_req, res) => res.json(await listUsers(db.kysely))));

  r.get('/api/admin/settings', (_req, res) =>
    res.json({
      devAuth: cfg.devAuth,
      oidc: cfg.oidc ? { issuer: cfg.oidc.issuer, groupsClaim: cfg.oidc.groupsClaim, roleMap: cfg.oidc.roleMap } : null,
      session: cfg.session,
    }),
  );

  r.patch('/api/admin/users/:id', wrap(async (req, res) => {
    const me = actorOf(req);
    const id = String(req.params.id);
    const patch = PatchUser.parse(req.body);
    const before = await getUser(db.kysely, id);
    if (!before) throw new AppError(404, `User ${id} not found`);
    if (id === me.id && ((patch.role !== undefined && patch.role !== 'admin') || patch.active === false)) {
      throw new AppError(409, 'You cannot remove your own admin access; ask another admin');
    }

    let after = before;
    if (patch.role !== undefined && patch.role !== before.role) {
      const role = patch.role === null ? null : isRole(patch.role) ? patch.role : null;
      after = (await setUserRole(db.kysely, id, role))!;
      await recordIdentityEvent(db.kysely, 'role-change', me, { userId: id, from: before.role, to: after.role }, { roleSource: after.roleSource });
    }
    if (patch.active !== undefined && patch.active !== before.active) {
      after = (await setUserActive(db.kysely, id, patch.active))!;
      const revoked = patch.active ? 0 : await revokeUserSessions(db.kysely, id);
      await recordIdentityEvent(db.kysely, patch.active ? 'reactivate' : 'deactivate', me, { userId: id }, { sessionsRevoked: revoked });
    }
    res.json(after);
  }));

  r.post('/api/admin/users/:id/revoke-sessions', wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!(await getUser(db.kysely, id))) throw new AppError(404, `User ${id} not found`);
    const revoked = await revokeUserSessions(db.kysely, id);
    await recordIdentityEvent(db.kysely, 'sessions-revoked', actorOf(req), { userId: id }, { revoked });
    res.json({ revoked });
  }));

  return r;
}
```

- [ ] **Step 4: Mount the admin routes.** In `backend/src/app.ts`, add `import { adminRoutes } from './auth/admin-routes';`, and directly after `const evaluators = …;` add:

```ts
  app.use(adminRoutes(svc.db, auth.config));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/admin.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run everything**

Run: `cd backend && npm test && npm run eval && npm run typecheck`
Expected: all green; eval 25/25.

- [ ] **Step 7: Commit**

```bash
git add backend/src/auth/admin-routes.ts backend/src/app.ts backend/tests/admin.test.ts
git commit -m "Add user administration: role overrides, deactivation and session revocation

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---
### Task 6: Frontend sign-in, session, CSRF and conflict handling

**Files:**
- Rewrite: `frontend/src/api.ts`, `frontend/src/session.tsx`, `frontend/src/App.tsx`, `frontend/src/components/engagement/FindingsTab.tsx`
- Create: `frontend/src/roles.ts`, `frontend/src/pages/LoginPage.tsx`, `frontend/src/pages/PendingAccessPage.tsx`, `frontend/src/api.test.ts`
- Modify: `frontend/src/pages/EngagementPage.tsx`, `frontend/src/components/engagement/ScopeTab.tsx`, `frontend/src/components/engagement/FieldworkTab.tsx`, `frontend/src/pages/EngagementsPage.tsx`
- Modify: `frontend/vite.config.ts`, `frontend/package.json`, `frontend/nginx.conf`

**Interfaces:**
- Consumes (backend, Tasks 3–4):
  - `GET /auth/config` → `{ devAuth, oidc }`
  - `GET /auth/dev-users`
  - `POST /auth/dev-login { userId }`
  - `GET /auth/login`
  - `POST /auth/logout`
  - `GET /api/me` → `{ user: { id, name, email, role }, csrfToken, pendingAccess }`
  - error bodies `{ error, code }`
  - `ETag`/`If-Match` on engagements
  - `Finding.preparedBy`
- Produces:
  - `api<T>(path, init?: ApiInit)`, `request<T>(url, init?)`
  - `interface ApiInit { method?: string; body?: unknown; ifMatch?: number }`
  - `class ApiError { status; code }`
  - `setCsrfToken(t)`, `setUnauthenticatedHandler(fn)`, `requestInit(init)`, `errorFrom(status, data)`
  - `useSession()` → `{ status: 'loading' | 'signed-out' | 'pending' | 'ready'; user: User | null; me; options; provider; error; devLogin(id); logout() }`
  - `ROLE_LABEL: Record<Role, string>`, `canPrepare(role)` from `src/roles.ts`

- [ ] **Step 1: Add vitest to the frontend**

```bash
cd frontend && npm install -D vitest
```

In `frontend/package.json` `"scripts"`, add `"test": "vitest run",`.

Replace `frontend/vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_URL ?? 'http://localhost:3002';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // /auth carries sign-in, the OIDC callback and logout; same origin keeps the session cookie first-party.
    proxy: { '/api': api, '/auth': api },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
```

In `frontend/nginx.conf`, add before `location / {`:

```nginx
  location /auth/ {
    proxy_pass http://backend:3002;
  }
```

- [ ] **Step 2: Write the failing tests** `frontend/src/api.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, requestInit, setCsrfToken, setUnauthenticatedHandler } from './api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  setCsrfToken(null);
  setUnauthenticatedHandler(() => undefined);
  vi.unstubAllGlobals();
});

describe('requestInit', () => {
  it('sends the CSRF token on changes, never on reads', () => {
    setCsrfToken('tok');
    expect((requestInit({ method: 'POST', body: {} }).headers as Record<string, string>)['x-csrf-token']).toBe('tok');
    expect((requestInit({}).headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
    expect(requestInit({}).credentials).toBe('same-origin');
  });

  it('sends the engagement version as a quoted If-Match', () => {
    expect((requestInit({ method: 'PUT', ifMatch: 7 }).headers as Record<string, string>)['If-Match']).toBe('"7"');
    expect((requestInit({ method: 'PUT' }).headers as Record<string, string>)['If-Match']).toBeUndefined();
  });
});

describe('api errors', () => {
  it('turns a version conflict into a plain "reload" message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { error: 'Engagement ENG-1 is at version 4, not 3', code: 'VERSION_CONFLICT' })));
    await expect(api('/engagements/ENG-1/scope', { method: 'PUT', body: {}, ifMatch: 3 })).rejects.toMatchObject({
      status: 409, code: 'VERSION_CONFLICT', message: expect.stringMatching(/Someone else changed this engagement.*Reload/),
    });
  });

  it("keeps the server's own message for other errors", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { error: 'You prepared this finding, so someone else must review it', code: 'SOD_VIOLATION' })));
    await expect(api('/x', { method: 'POST' })).rejects.toMatchObject({ code: 'SOD_VIOLATION', message: 'You prepared this finding, so someone else must review it' });
  });

  it('tells the app when the session has ended', async () => {
    const signedOut = vi.fn();
    setUnauthenticatedHandler(signedOut);
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'Sign in to continue', code: 'UNAUTHENTICATED' })));
    await expect(api('/engagements')).rejects.toMatchObject({ status: 401 });
    expect(signedOut).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npm test`
Expected: FAIL. `requestInit` and `setUnauthenticatedHandler` aren't exported by the current `api.ts`.

- [ ] **Step 4: Rewrite the API client** `frontend/src/api.ts`

```ts
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Messages people can act on, for errors where the server's wording is too technical. */
const FRIENDLY: Record<string, string> = {
  VERSION_CONFLICT: 'Someone else changed this engagement while you were working. Reload the page to see their changes, then try again.',
  CSRF_FAILED: 'Your session security token is out of date. Reload the page and try again.',
  PENDING_ACCESS: 'Your account is waiting for an administrator to assign a role.',
};

export interface ApiInit {
  method?: string;
  body?: unknown;
  /** The engagement version this change is based on; the server refuses it if someone saved since. */
  ifMatch?: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Held in memory only — never in localStorage — and refreshed from /api/me after sign-in.
let csrfToken: string | null = null;
let onUnauthenticated: () => void = () => undefined;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export function setUnauthenticatedHandler(handler: () => void) {
  onUnauthenticated = handler;
}

export function requestInit(init: ApiInit = {}): RequestInit {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!SAFE_METHODS.has(method) && csrfToken) headers['x-csrf-token'] = csrfToken;
  if (init.ifMatch !== undefined) headers['If-Match'] = `"${init.ifMatch}"`;
  return { method, headers, credentials: 'same-origin', body: init.body === undefined ? undefined : JSON.stringify(init.body) };
}

export function errorFrom(status: number, data: unknown): ApiError {
  const body = (data && typeof data === 'object' ? data : {}) as { error?: string; code?: string };
  const code = body.code ?? null;
  return new ApiError((code && FRIENDLY[code]) || body.error || `HTTP ${status}`, status, code);
}

export async function request<T>(url: string, init: ApiInit = {}): Promise<T> {
  const res = await fetch(url, requestInit(init));
  const text = await res.text();
  const data = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  if (res.status === 401) onUnauthenticated();
  if (!res.ok) throw errorFrom(res.status, data);
  return data as T;
}

export const api = <T>(path: string, init?: ApiInit) => request<T>(`/api${path}`, init);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npm test`
Expected: PASS, 5 tests.

- [ ] **Step 6: Add the role labels** `frontend/src/roles.ts`

```ts
import type { Role } from './types';

export const ROLE_LABEL: Record<Role, string> = {
  auditor: 'Auditor',
  audit_manager: 'Audit manager',
  cae: 'Chief Audit Executive',
  admin: 'Administrator',
  viewer: 'Viewer',
};

/** May create engagements, run modules, record tests and edit findings. */
export const canPrepare = (role: Role | null | undefined) => role === 'auditor' || role === 'audit_manager';
```

- [ ] **Step 7: Rewrite the session** `frontend/src/session.tsx`

```tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, request, setCsrfToken, setUnauthenticatedHandler } from './api';
import type { Role, User } from './types';

export interface Me {
  user: { id: string; name: string; email: string | null; role: Role | null };
  csrfToken: string;
  pendingAccess: boolean;
}

export interface SignInOptions {
  devAuth: boolean;
  oidc: boolean;
}

export type SessionStatus = 'loading' | 'signed-out' | 'pending' | 'ready';

interface Session {
  status: SessionStatus;
  /** The signed-in user, once they have a role. */
  user: User | null;
  me: Me | null;
  options: SignInOptions | null;
  provider: { id: string; model: string } | null;
  error: string | null;
  devLogin: (userId: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [options, setOptions] = useState<SignInOptions | null>(null);
  const [provider, setProvider] = useState<Session['provider']>(null);
  const [error, setError] = useState<string | null>(null);

  const signedOut = useCallback(() => {
    setCsrfToken(null);
    setMe(null);
    setStatus('signed-out');
  }, []);

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/me');
      setCsrfToken(m.csrfToken);
      setMe(m);
      setError(null);
      setStatus(m.pendingAccess ? 'pending' : 'ready');
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(e instanceof Error ? e.message : String(e));
      signedOut();
    }
  }, [signedOut]);

  useEffect(() => {
    setUnauthenticatedHandler(signedOut);
    request<SignInOptions>('/auth/config').then(setOptions, () => setOptions({ devAuth: false, oidc: false }));
    api<{ provider: Session['provider'] }>('/health').then((h) => setProvider(h.provider), () => undefined);
    refresh();
  }, [refresh, signedOut]);

  const devLogin = async (userId: string) => {
    await request('/auth/dev-login', { method: 'POST', body: { userId } });
    await refresh();
  };

  const logout = async () => {
    try {
      await request('/auth/logout', { method: 'POST' });
    } finally {
      signedOut();
    }
  };

  const user: User | null = me?.user.role ? { id: me.user.id, name: me.user.name, role: me.user.role } : null;
  return <Ctx.Provider value={{ status, user, me, options, provider, error, devLogin, logout }}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const session = useContext(Ctx);
  if (!session) throw new Error('useSession must be used inside SessionProvider');
  return session;
}
```

- [ ] **Step 8: Add the sign-in and pending pages**

`frontend/src/pages/LoginPage.tsx`:

```tsx
import { Login as LoginIcon } from '@mui/icons-material';
import { Alert, Box, Button, Card, CardContent, Divider, List, ListItemButton, ListItemText, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { request } from '../api';
import { ROLE_LABEL } from '../roles';
import { useSession } from '../session';
import type { User } from '../types';

export default function LoginPage() {
  const { options, devLogin, error } = useSession();
  const [devUsers, setDevUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (options?.devAuth) request<User[]>('/auth/dev-users').then(setDevUsers, () => setDevUsers([]));
  }, [options?.devAuth]);

  const signInAs = async (id: string) => {
    setBusy(id);
    setFailure(null);
    try {
      await devLogin(id);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Card variant="outlined" sx={{ width: '100%', maxWidth: 440 }}>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h5" fontWeight={600}>
              Audit & Controls Platform
            </Typography>
            <Typography color="text.secondary">Sign in to continue.</Typography>
            {(failure || error) && <Alert severity="error">{failure ?? error}</Alert>}
            {options?.oidc && (
              <Button variant="contained" size="large" startIcon={<LoginIcon />} href="/auth/login">
                Sign in with your organisation account
              </Button>
            )}
            {options?.devAuth && (
              <>
                {options.oidc && <Divider>or</Divider>}
                <Alert severity="warning">Demo sign-in is enabled. It is for development only and is refused in production.</Alert>
                <List dense disablePadding>
                  {devUsers.map((u) => (
                    <ListItemButton key={u.id} disabled={!!busy} onClick={() => signInAs(u.id)}>
                      <ListItemText primary={u.name} secondary={ROLE_LABEL[u.role]} />
                    </ListItemButton>
                  ))}
                </List>
              </>
            )}
            {options && !options.oidc && !options.devAuth && <Alert severity="error">No sign-in method is configured. Contact your administrator.</Alert>}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
```

`frontend/src/pages/PendingAccessPage.tsx`:

```tsx
import { Box, Button, Card, CardContent, Stack, Typography } from '@mui/material';
import { useSession } from '../session';

export default function PendingAccessPage() {
  const { me, logout } = useSession();
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Card variant="outlined" sx={{ width: '100%', maxWidth: 520 }}>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h5" fontWeight={600}>
              Waiting for access
            </Typography>
            <Typography>
              You are signed in as <b>{me?.user.name}</b>
              {me?.user.email ? ` (${me.user.email})` : ''}, but no role has been assigned to your account yet.
            </Typography>
            <Typography color="text.secondary">Ask your audit platform administrator to assign you a role, then check again.</Typography>
            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={() => window.location.reload()}>
                Check again
              </Button>
              <Button onClick={logout}>Sign out</Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
```

- [ ] **Step 9: Rewrite the app shell** `frontend/src/App.tsx`

```tsx
import { FactCheck as FactCheckIcon, Logout as LogoutIcon } from '@mui/icons-material';
import { Alert, AppBar, Box, Button, Chip, Container, LinearProgress, Toolbar, Typography } from '@mui/material';
import { Link as RouterLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import EngagementPage from './pages/EngagementPage';
import EngagementsPage from './pages/EngagementsPage';
import LibraryPage from './pages/LibraryPage';
import LoginPage from './pages/LoginPage';
import PendingAccessPage from './pages/PendingAccessPage';
import ValidationPage from './pages/ValidationPage';
import { ROLE_LABEL } from './roles';
import { SessionProvider, useSession } from './session';

const AUDIT_NAV = [
  { to: '/engagements', label: 'Engagements' },
  { to: '/library', label: 'Content library' },
  { to: '/validation', label: 'Evaluation & validation' },
];

function Shell() {
  const { user, provider, logout } = useSession();
  const { pathname } = useLocation();
  if (!user) return null;
  const isAdmin = user.role === 'admin';
  const nav = isAdmin ? [] : AUDIT_NAV;
  return (
    <>
      <AppBar position="sticky" elevation={0}>
        <Toolbar sx={{ gap: 2, flexWrap: 'wrap' }}>
          <FactCheckIcon />
          <Typography variant="h6" sx={{ mr: 2, fontWeight: 600 }}>
            Audit & Controls Platform
          </Typography>
          {nav.map((n) => (
            <Button key={n.to} component={RouterLink} to={n.to} color="inherit" sx={{ opacity: pathname.startsWith(n.to) ? 1 : 0.7, fontWeight: pathname.startsWith(n.to) ? 700 : 400 }}>
              {n.label}
            </Button>
          ))}
          <Box sx={{ flex: 1 }} />
          {provider && !isAdmin && (
            <Chip size="small" label={`Model: ${provider.id === 'offline' ? 'offline rules' : provider.model}`} sx={{ bgcolor: 'rgba(255,255,255,0.15)', color: 'inherit' }} />
          )}
          <Typography variant="body2">{user.name}</Typography>
          <Chip size="small" label={ROLE_LABEL[user.role]} sx={{ bgcolor: 'rgba(255,255,255,0.15)', color: 'inherit' }} />
          <Button color="inherit" startIcon={<LogoutIcon />} onClick={logout}>
            Sign out
          </Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 3 }}>
        {isAdmin ? (
          <Alert severity="info">Administrators manage access and do not see audit content.</Alert>
        ) : (
          <Routes>
            <Route path="/" element={<Navigate to="/engagements" />} />
            <Route path="/engagements" element={<EngagementsPage />} />
            <Route path="/engagements/:id" element={<EngagementPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/validation" element={<ValidationPage />} />
          </Routes>
        )}
      </Container>
    </>
  );
}

function Gate() {
  const { status } = useSession();
  if (status === 'loading') return <LinearProgress />;
  if (status === 'signed-out') return <LoginPage />;
  if (status === 'pending') return <PendingAccessPage />;
  return <Shell />;
}

export default function App() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}
```

- [ ] **Step 10: Send `If-Match` with every engagement change.**

In `frontend/src/pages/EngagementPage.tsx`, in `run`, change the request options to:

```ts
{ method: 'POST', body: {}, ifMatch: engagement?.version }
```

In `frontend/src/components/engagement/ScopeTab.tsx`, change the scope request's options to:

```ts
{ method: 'PUT', ifMatch: e.version, body: { items: e.scope.map((s) => ({ controlId: s.controlId, included: included[s.controlId] })) } }
```

In `frontend/src/components/engagement/FieldworkTab.tsx`:
- add `version?: number` to `RowCard`'s props type and destructuring: `({ row, input, result, engagementId, version, onSaved }: { …; version?: number; … })`
- in its request options, add `ifMatch: version,` after `method: 'PUT',`
- in `FieldworkTab`, pass `version={e.version}` to `<RowCard …>`

In `frontend/src/pages/EngagementsPage.tsx`, add the imports

```tsx
import { canPrepare } from '../roles';
import { useSession } from '../session';
```

and `const { user } = useSession();` at the top of the component. Wrap the **New engagement** `<Button …>…</Button>` in `{canPrepare(user?.role) && ( … )}`.

- [ ] **Step 11: Rewrite the findings tab** `frontend/src/components/engagement/FindingsTab.tsx`. It now sends `If-Match` and explains segregation of duties in the UI:

```tsx
import { PlayArrow as PlayArrowIcon } from '@mui/icons-material';
import {
  Alert, Button, Card, CardContent, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Grid, MenuItem, Stack, TextField, Typography,
} from '@mui/material';
import { useState } from 'react';
import { api } from '../../api';
import type { TabProps } from '../../pages/EngagementPage';
import { canPrepare } from '../../roles';
import { useSession } from '../../session';
import type { Engagement, Finding } from '../../types';
import { ActionButton, Citations, RiskChip, StatusChip } from '../common';

const FIELDS = ['condition', 'criteria', 'cause', 'effect', 'recommendation'] as const;

interface CardContext {
  engagementId: string;
  version: number | undefined;
  reload: () => Promise<void>;
}

function EditDialog({ finding, ctx, onClose }: { finding: Finding; ctx: CardContext; onClose: () => void }) {
  const [f, setF] = useState({ ...finding, evidence: finding.evidenceRefs.join(', ') });
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Edit finding {finding.id}</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>
          Saving resets sign-offs to draft and re-runs the triple-citation gate. Editing makes you a preparer of this finding, so you will not be able to sign it.
        </Alert>
        <Stack spacing={2}>
          <TextField label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <TextField select label="Rating" value={f.rating} onChange={(e) => setF({ ...f, rating: e.target.value as Finding['rating'] })}>
            {['High', 'Medium', 'Low'].map((r) => (
              <MenuItem key={r} value={r}>
                {r}
              </MenuItem>
            ))}
          </TextField>
          {FIELDS.map((k) => (
            <TextField key={k} label={k[0].toUpperCase() + k.slice(1)} multiline minRows={2} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          ))}
          <TextField label="Evidence references" value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <ActionButton
          action={async () => {
            await api(`/engagements/${ctx.engagementId}/findings/${finding.id}`, {
              method: 'PUT',
              ifMatch: ctx.version,
              body: { title: f.title, rating: f.rating, ...Object.fromEntries(FIELDS.map((k) => [k, f[k]])), evidenceRefs: f.evidence.split(',').map((s) => s.trim()).filter(Boolean) },
            });
            await ctx.reload();
            onClose();
          }}
        >
          Save
        </ActionButton>
      </DialogActions>
    </Dialog>
  );
}

function FindingCard({ f, ctx }: { f: Finding; ctx: CardContext }) {
  const { user } = useSession();
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const sign = (action: string) => async () => {
    await api(`/engagements/${ctx.engagementId}/findings/${f.id}/signoff`, { method: 'POST', ifMatch: ctx.version, body: { action, comment } });
    setComment('');
    await ctx.reload();
  };
  const role = user?.role;
  const preparedByMe = !!user && (f.preparedBy ?? []).includes(user.id);
  const reviewedByMe = !!user && f.signOffs.some((s) => s.userId === user.id);
  const canReview = role === 'audit_manager' && f.status === 'draft';
  const canApprove = role === 'cae' && f.status === 'reviewed';
  const blockedBySod = (canReview || canApprove) && (preparedByMe || (canApprove && reviewedByMe));

  return (
    <Card variant="outlined" sx={{ borderLeft: 4, borderLeftColor: f.status === 'blocked' ? 'error.main' : f.status === 'approved' ? 'success.main' : 'grey.400' }}>
      <CardContent>
        <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
          <Typography variant="h6" sx={{ flex: 1, fontSize: 17 }}>
            {f.title}
          </Typography>
          <RiskChip rating={f.rating} />
          <StatusChip status={f.status} />
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
          {f.id} · control {f.controlId} · drafted in {f.bundleId}
          {f.preparedBy?.length ? ` · prepared by ${f.preparedBy.join(', ')}` : ''}
        </Typography>
        {f.status === 'blocked' && (
          <Alert severity="error" sx={{ mt: 1 }}>
            Blocked by QA gate: {f.blockedReasons.join('; ')}
          </Alert>
        )}
        <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
          {FIELDS.map((k) => (
            <Grid item xs={12} md={k === 'criteria' ? 12 : 6} key={k}>
              <Typography variant="subtitle2" sx={{ textTransform: 'capitalize' }}>
                {k}
              </Typography>
              <Typography variant="body2">{f[k]}</Typography>
            </Grid>
          ))}
        </Grid>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mt: 1.5 }} alignItems={{ md: 'center' }}>
          <Typography variant="subtitle2">Triple citation:</Typography>
          <Citations citations={f.citations} />
          <Typography variant="body2">
            control <b>{f.controlId}</b> · evidence <b>{f.evidenceRefs.join(', ') || '—'}</b>
          </Typography>
        </Stack>
        {f.signOffs.length > 0 && (
          <Stack sx={{ mt: 1.5 }}>
            {f.signOffs.map((s, i) => (
              <Typography key={i} variant="body2" color="text.secondary">
                ✍ {s.meaning} by {s.userName} ({s.role}) at {new Date(s.at).toLocaleString()}
                {s.comment && ` — "${s.comment}"`}
              </Typography>
            ))}
          </Stack>
        )}
        <Divider sx={{ my: 1.5 }} />
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          {canPrepare(role) && f.status !== 'approved' && (
            <Button size="small" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {(canReview || canApprove) && !blockedBySod && (
            <>
              <TextField size="small" placeholder="Sign-off comment" value={comment} onChange={(e) => setComment(e.target.value)} sx={{ minWidth: 280 }} />
              {canReview && (
                <ActionButton size="small" action={sign('review')}>
                  Sign as reviewed
                </ActionButton>
              )}
              {canApprove && (
                <>
                  <ActionButton size="small" color="success" action={sign('approve')}>
                    Approve
                  </ActionButton>
                  <ActionButton size="small" color="warning" variant="outlined" action={sign('reject')}>
                    Reject
                  </ActionButton>
                </>
              )}
            </>
          )}
          {blockedBySod && (
            <Typography variant="caption" color="text.secondary">
              You {preparedByMe ? 'prepared' : 'reviewed'} this finding, so another person must sign it.
            </Typography>
          )}
          {f.status === 'draft' && role !== 'audit_manager' && <Typography variant="caption" color="text.secondary">Awaiting review by an audit manager.</Typography>}
          {f.status === 'reviewed' && role !== 'cae' && <Typography variant="caption" color="text.secondary">Awaiting approval by the Chief Audit Executive.</Typography>}
        </Stack>
      </CardContent>
      {editing && <EditDialog finding={f} ctx={ctx} onClose={() => setEditing(false)} />}
    </Card>
  );
}

export default function FindingsTab({ engagement: e, setEngagement, run }: TabProps) {
  const ctx: CardContext = {
    engagementId: e.id,
    version: e.version,
    reload: async () => setEngagement(await api<Engagement>(`/engagements/${e.id}`)),
  };
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <ActionButton startIcon={<PlayArrowIcon />} action={() => run('gaps')}>
          Run Gap Writer
        </ActionButton>
        <Typography color="text.secondary">
          Drafts a finding for each failed control. Approved findings are locked; others are redrafted. Whoever runs it prepares the drafts and cannot sign them.
        </Typography>
      </Stack>
      {e.findings.map((f) => (
        <FindingCard key={f.id} f={f} ctx={ctx} />
      ))}
      {!e.findings.length && <Typography color="text.secondary">No findings yet.</Typography>}
    </Stack>
  );
}
```

- [ ] **Step 12: Typecheck and test the frontend**

Run: `cd frontend && npm test && npm run typecheck && npm run build`
Expected: 5 tests pass; typecheck exits 0; the Vite build succeeds.

- [ ] **Step 13: Try it in the browser.** With the backend running against a migrated database (`cd backend && DEV_AUTH=true npm run dev`) and `cd frontend && npm run dev`, open http://localhost:5174 and check:
- the sign-in page lists five demo users
- Asha (Auditor) sees engagements and **New engagement**
- Vera (Viewer) sees engagements but no **New engagement**
- Arun (Administrator) sees only the "Administrators manage access" notice
- **Sign out** returns to the sign-in page
- with two browser windows as Asha on the same engagement, saving a scope change in one and then in the other shows "Someone else changed this engagement … Reload"

Note what you saw in the task report.

- [ ] **Step 14: Commit**

```bash
git add frontend
git commit -m "Sign in from the UI, keep CSRF in memory and surface edit conflicts

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---
### Task 7: Admin page, Keycloak profile, packaging and docs

**Files:**
- Create: `frontend/src/pages/AdminPage.tsx`; Modify: `frontend/src/App.tsx`
- Create: `deploy/keycloak/audit-realm.json`
- Modify: `docker-compose.yml`, `backend/.env.example`, `README.md`

**Interfaces:**
- Consumes:
  - `GET /api/admin/users`
  - `PATCH /api/admin/users/:id`
  - `POST /api/admin/users/:id/revoke-sessions`
  - `GET /api/admin/settings` (Task 5)
  - `useSession`, `ROLE_LABEL`, `api`, `ActionButton` (Task 6)
- Produces:
  - the `/admin` page
  - `docker compose up` with demo sign-in by default
  - `docker compose --profile sso up keycloak` for a real OIDC provider on http://localhost:8081

- [ ] **Step 1: Write the admin page** `frontend/src/pages/AdminPage.tsx`

```tsx
import { Logout as LogoutIcon } from '@mui/icons-material';
import {
  Alert, Card, CardContent, Chip, MenuItem, Stack, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ActionButton } from '../components/common';
import { ROLE_LABEL } from '../roles';
import { useSession } from '../session';
import type { Role } from '../types';

interface AdminUser {
  id: string;
  issuer: string;
  name: string;
  email: string | null;
  role: Role | null;
  roleSource: 'idp' | 'admin';
  active: boolean;
  lastLoginAt: string | null;
}

interface AdminSettings {
  devAuth: boolean;
  oidc: { issuer: string; groupsClaim: string; roleMap: Record<string, Role> } | null;
  session: { idleMinutes: number; maxHours: number };
}

const ROLE_OPTIONS: Role[] = ['auditor', 'audit_manager', 'cae', 'admin', 'viewer'];

export default function AdminPage() {
  const { user } = useSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<AdminUser[]>('/admin/users').then(setUsers), []);
  useEffect(() => {
    load();
    api<AdminSettings>('/admin/settings').then(setSettings);
  }, [load]);

  const patch = async (id: string, body: { role?: Role | null; active?: boolean }) => {
    setError(null);
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', body });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await load();
  };

  return (
    <Stack spacing={2}>
      <Typography variant="h5" fontWeight={600}>
        User administration
      </Typography>
      <Typography color="text.secondary">
        Every change here is recorded in the audit trail. A role set here overrides the identity provider's groups for that person.
      </Typography>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <Card variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              {['Name', 'Email', 'Sign-in', 'Role', 'Active', 'Last sign-in', ''].map((h) => (
                <TableCell key={h}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {users.map((u) => {
              const self = u.id === user?.id;
              return (
                <TableRow key={u.id}>
                  <TableCell>
                    {u.name}
                    <Typography variant="caption" display="block" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                      {u.id}
                    </Typography>
                  </TableCell>
                  <TableCell>{u.email ?? '—'}</TableCell>
                  <TableCell>
                    <Chip size="small" label={u.issuer === 'dev' ? 'demo' : 'SSO'} />
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <TextField
                        select
                        size="small"
                        value={u.role ?? ''}
                        disabled={self}
                        onChange={(e) => patch(u.id, { role: (e.target.value || null) as Role | null })}
                        sx={{ minWidth: 220 }}
                      >
                        <MenuItem value="">No role (pending access)</MenuItem>
                        {ROLE_OPTIONS.map((r) => (
                          <MenuItem key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </MenuItem>
                        ))}
                      </TextField>
                      {u.roleSource === 'admin' && <Chip size="small" variant="outlined" label="set by admin" />}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Switch checked={u.active} disabled={self} onChange={(e) => patch(u.id, { active: e.target.checked })} />
                  </TableCell>
                  <TableCell>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</TableCell>
                  <TableCell>
                    <ActionButton size="small" variant="outlined" startIcon={<LogoutIcon />} action={() => api(`/admin/users/${u.id}/revoke-sessions`, { method: 'POST' })}>
                      Sign out everywhere
                    </ActionButton>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      {settings && (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="h6" fontSize={16}>
              Sign-in settings
            </Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>
              Sessions end after {settings.session.idleMinutes} idle minutes and at most {settings.session.maxHours} hours after sign-in.
            </Typography>
            {settings.devAuth && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                Demo sign-in is enabled. Turn it off (DEV_AUTH=false) before real use.
              </Alert>
            )}
            {settings.oidc ? (
              <>
                <Typography variant="body2" sx={{ mt: 1 }}>
                  Identity provider: <b>{settings.oidc.issuer}</b> · groups claim <code>{settings.oidc.groupsClaim}</code>
                </Typography>
                <Table size="small" sx={{ mt: 1, maxWidth: 520 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Identity-provider group</TableCell>
                      <TableCell>Role</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {Object.entries(settings.oidc.roleMap).map(([group, role]) => (
                      <TableRow key={group}>
                        <TableCell sx={{ fontFamily: 'monospace' }}>{group}</TableCell>
                        <TableCell>{ROLE_LABEL[role]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                No identity provider is configured.
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              Group mappings come from the deployment configuration (OIDC_ROLE_MAP) and change under change control, not here.
            </Typography>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}
```

- [ ] **Step 2: Route admins to it.** In `frontend/src/App.tsx`:
- add `import AdminPage from './pages/AdminPage';`
- replace `const nav = isAdmin ? [] : AUDIT_NAV;` with `const nav = isAdmin ? [{ to: '/admin', label: 'Administration' }] : AUDIT_NAV;`
- replace the `<Alert severity="info">Administrators manage access and do not see audit content.</Alert>` branch with:

```tsx
          <Routes>
            <Route path="/admin" element={<AdminPage />} />
            <Route path="*" element={<Navigate to="/admin" />} />
          </Routes>
```

- remove `Alert` from the `@mui/material` import if it's now unused.

- [ ] **Step 3: Add the Keycloak realm for local SSO testing** `deploy/keycloak/audit-realm.json`

```json
{
  "realm": "audit",
  "enabled": true,
  "groups": [
    { "name": "audit-auditors" },
    { "name": "audit-managers" },
    { "name": "audit-cae" },
    { "name": "audit-admins" },
    { "name": "audit-viewers" }
  ],
  "clients": [
    {
      "clientId": "audit-platform",
      "enabled": true,
      "protocol": "openid-connect",
      "publicClient": false,
      "secret": "audit-dev-secret",
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "redirectUris": ["http://localhost:5174/auth/callback"],
      "webOrigins": ["http://localhost:5174"],
      "attributes": { "pkce.code.challenge.method": "S256" },
      "protocolMappers": [
        {
          "name": "groups",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-group-membership-mapper",
          "config": { "claim.name": "groups", "full.path": "false", "id.token.claim": "true", "access.token.claim": "true", "userinfo.token.claim": "true" }
        }
      ]
    }
  ],
  "users": [
    { "username": "asha", "enabled": true, "firstName": "Asha", "lastName": "Auditor", "email": "asha@example.test", "emailVerified": true, "credentials": [{ "type": "password", "value": "demo", "temporary": false }], "groups": ["/audit-auditors"] },
    { "username": "ravi", "enabled": true, "firstName": "Ravi", "lastName": "Reviewer", "email": "ravi@example.test", "emailVerified": true, "credentials": [{ "type": "password", "value": "demo", "temporary": false }], "groups": ["/audit-managers"] },
    { "username": "priya", "enabled": true, "firstName": "Priya", "lastName": "QA Head", "email": "priya@example.test", "emailVerified": true, "credentials": [{ "type": "password", "value": "demo", "temporary": false }], "groups": ["/audit-cae"] },
    { "username": "arun", "enabled": true, "firstName": "Arun", "lastName": "Admin", "email": "arun@example.test", "emailVerified": true, "credentials": [{ "type": "password", "value": "demo", "temporary": false }], "groups": ["/audit-admins"] },
    { "username": "nina", "enabled": true, "firstName": "Nina", "lastName": "New", "email": "nina@example.test", "emailVerified": true, "credentials": [{ "type": "password", "value": "demo", "temporary": false }], "groups": [] }
  ]
}
```

- [ ] **Step 4: Update Compose.** In `docker-compose.yml`, replace the `backend` service's `environment:` block with:

```yaml
    environment:
      PORT: '3002'
      DATABASE_URL: postgres://audit:${POSTGRES_PASSWORD:-audit-dev-only}@postgres:5432/audit
      # Local demo defaults. A real deployment sets NODE_ENV=production, DEV_AUTH=false and the OIDC_* settings.
      NODE_ENV: ${NODE_ENV:-development}
      DEV_AUTH: ${DEV_AUTH:-true}
      PUBLIC_URL: ${PUBLIC_URL:-http://localhost:8080}
      OIDC_ISSUER: ${OIDC_ISSUER:-}
      OIDC_CLIENT_ID: ${OIDC_CLIENT_ID:-}
      OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET:-}
      OIDC_REDIRECT_URI: ${OIDC_REDIRECT_URI:-}
      OIDC_GROUPS_CLAIM: ${OIDC_GROUPS_CLAIM:-groups}
      OIDC_ROLE_MAP: ${OIDC_ROLE_MAP:-}
      # offline (default, no key needed) | anthropic
      LLM_PROVIDER: ${LLM_PROVIDER:-offline}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
```

and add this service before `volumes:`:

```yaml
  # Local OpenID provider for testing real sign-in: docker compose --profile sso up -d keycloak
  # Run the API on the host (npm run dev) so the browser and the API see the same issuer URL.
  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    profiles: ['sso']
    command: ['start-dev', '--import-realm', '--http-port=8081']
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD:-admin-dev-only}
    volumes:
      - ./deploy/keycloak/audit-realm.json:/opt/keycloak/data/import/audit-realm.json:ro
    ports:
      - '127.0.0.1:8081:8081'
```

- [ ] **Step 5: Document the settings** by replacing `backend/.env.example`:

```bash
# Copy to backend/.env for local development (never used when NODE_ENV=production).
DATABASE_URL=postgres://audit:audit-dev-only@localhost:5432/audit
PORT=3002
# offline (default, no key needed) | anthropic
LLM_PROVIDER=offline
# ANTHROPIC_API_KEY=

# ---- Sign-in ----
# Demo users (development only; the server refuses DEV_AUTH=true with NODE_ENV=production)
DEV_AUTH=true
PUBLIC_URL=http://localhost:5174
# SESSION_IDLE_MINUTES=30
# SESSION_MAX_HOURS=12

# Real sign-in through an OpenID Connect provider (Entra ID, Okta, Keycloak, …).
# With the local Keycloak (docker compose --profile sso up -d keycloak):
# OIDC_ISSUER=http://localhost:8081/realms/audit
# OIDC_CLIENT_ID=audit-platform
# OIDC_CLIENT_SECRET=audit-dev-secret
# OIDC_REDIRECT_URI=http://localhost:5174/auth/callback
# OIDC_GROUPS_CLAIM=groups
# OIDC_ROLE_MAP={"audit-auditors":"auditor","audit-managers":"audit_manager","audit-cae":"cae","audit-admins":"admin","audit-viewers":"viewer"}
```

- [ ] **Step 6: Update the README.** In `README.md`, add this section directly after the **Quick start** section, before `### Demo script`:

````markdown
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
- New people with no mapped group see "waiting for access" until an administrator assigns a role.

To try real sign-in locally with Keycloak:

```bash
docker compose --profile sso up -d keycloak   # http://localhost:8081, realm "audit"
# in backend/.env: DEV_AUTH=false and the commented OIDC_* lines
cd backend && npm run dev                     # then cd frontend && npm run dev
```

Sign in as `asha`, `ravi`, `priya` or `arun` with the password `demo`. `nina` has no group, so she shows the pending-access page.
````

In the **Demo script**, replace step 5 with:

```markdown
5. **Findings**: findings are drafted with the 5 C's and a triple citation
   (clause + control + evidence). Sign out, sign in as *Ravi Reviewer* (audit
   manager) and sign as reviewed. Then sign in as *Priya QA Head* (CAE) and approve.
   A finding with no evidence reference is **blocked** and cannot be signed.
   Whoever drafted or edited a finding is not offered the sign buttons.
```

In `## Not in the MVP (next steps)`, replace the **Identity** bullet with:

```markdown
- **E-signatures:** sign-in is real (OIDC), but signing a finding does not yet
  re-authenticate. Part 11 signing (re-authentication bound to the signed
  content) is plan 1C.
```

- [ ] **Step 7: Smoke-test the stack**

```bash
docker compose up --build -d
docker compose ps migrate --format '{{.State}} {{.ExitCode}}'
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/api/engagements
curl -s localhost:8080/auth/config
curl -s -c /tmp/audit-jar -H 'content-type: application/json' -d '{"userId":"auditor"}' localhost:8080/auth/dev-login
curl -s -b /tmp/audit-jar localhost:8080/api/me
curl -s -b /tmp/audit-jar -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' localhost:8080/api/engagements
docker compose exec backend node dist/seed.js
curl -s -b /tmp/audit-jar localhost:8080/api/engagements | head -c 200; echo
rm -f /tmp/audit-jar
docker compose down -v
```

Expected:
- `migrate` shows `exited 0`
- `/api/engagements` without a session returns `401`
- `/auth/config` returns `{"devAuth":true,"oidc":false}`
- dev-login returns `{"ok":true}`
- `/api/me` names Asha Auditor with a `csrfToken`
- the POST without the CSRF header returns `403`
- seed prints two engagements
- the session lists them

Also open http://localhost:8080 before `down -v` and run the demo script's step 5 as the three demo users.

- [ ] **Step 8: Run all checks**

Run: `cd backend && npm test && npm run eval && npm run traceability | head -3 && npm run typecheck && cd ../frontend && npm test && npm run typecheck && cd .. && docker compose config -q`
Expected:
- backend all green
- eval 25/25
- traceability `19/19`
- both typechecks clean
- frontend tests pass
- compose config valid

- [ ] **Step 9: Commit**

```bash
git add frontend/src deploy docker-compose.yml backend/.env.example README.md
git commit -m "Add the admin page, a local Keycloak profile and sign-in docs

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---

## Done when

- **Sign-in**
  - Demo sign-in works locally and is refused in production.
  - OIDC sign-in works against the mock provider in tests and against Keycloak by hand.
  - Unmapped users see "waiting for access".
- **Sessions**
  - Every `/api` route needs a session, and every change needs the CSRF token.
  - Sessions expire after 30 idle minutes or 12 hours, and end at once on logout, deactivation or admin revocation.
- **Roles and segregation of duties**
  - Roles gate every route: admins see no audit content, and viewers can't change anything.
  - The preparer, reviewer and approver of a finding are three different people.
- **Admin and audit trail**
  - The admin page changes roles and active status and signs people out everywhere.
  - Each of those actions is in the hash-chained trail.
- **UI conflicts**: the UI sends `If-Match` and shows "Someone else changed this engagement … Reload" on conflict.
- **Checks**
  - Backend, frontend and eval checks are green.
  - `npm run traceability` reports 19/19.

**Next plan:** 1C — Part 11 signing: `signatures` and `finding_revisions` tables, sign intents, a re-authentication popup using `authTime`, and the `gates` and `agent_*` tables.
