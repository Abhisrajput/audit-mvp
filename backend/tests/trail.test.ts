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
