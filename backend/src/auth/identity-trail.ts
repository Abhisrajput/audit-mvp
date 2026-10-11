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
