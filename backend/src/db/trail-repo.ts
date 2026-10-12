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
