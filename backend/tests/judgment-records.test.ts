import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import { loadEngagement } from '../src/db/engagement-repo';
import { insertResponse, insertTolerance, responseHistory, responsesFor, tolerancesFor } from '../src/db/judgment-repo';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

describe('tolerances and management responses (spec §3.3)', () => {
  it('keeps the latest row per control and per finding, loads them into the engagement, and never updates or deletes a row', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const k = svc.db.kysely;
    await ensureDevUsers(k);
    expect((await loadEngagement(k, e.id))!.engagement).toMatchObject({ tolerances: {}, responses: {} });
    await insertTolerance(k, e.id, { id: 't1', controlId: 'FD-HACCP-03', rate: 0.05, recordedBy: 'auditor', recordedAt: '2026-10-22T00:00:00.000Z', trailBundleId: 'b1' });
    await insertTolerance(k, e.id, { id: 't2', controlId: 'FD-HACCP-03', rate: 0.1, recordedBy: 'auditor', recordedAt: '2026-10-22T00:00:01.000Z', trailBundleId: 'b2' });
    expect((await tolerancesFor(k, e.id))['FD-HACCP-03']).toMatchObject({ rate: 0.1, trailBundleId: 'b2' });
    await insertResponse(k, e.id, { id: 'r1', findingId: 'F-1', response: 'disagree', owner: 'Plant manager', dueDate: null, actionPlan: '', recordedBy: 'auditor', recordedAt: '2026-10-22T00:00:00.000Z', trailBundleId: 'b3' });
    await insertResponse(k, e.id, { id: 'r2', findingId: 'F-1', response: 'agree', owner: 'Plant manager', dueDate: '2026-12-31', actionPlan: 'Retrain the line leads', recordedBy: 'auditor', recordedAt: '2026-10-22T00:00:01.000Z', trailBundleId: 'b4' });
    expect((await responsesFor(k, e.id))['F-1']).toMatchObject({ response: 'agree', dueDate: '2026-12-31' });
    expect((await responseHistory(k, e.id, 'F-1')).map((r) => r.id)).toEqual(['r1', 'r2']);
    const loaded = (await loadEngagement(k, e.id))!.engagement;
    expect(loaded.tolerances['FD-HACCP-03'].rate).toBe(0.1);
    expect(loaded.responses['F-1'].response).toBe('agree');
    await expect(k.updateTable('test_tolerances').set({ rate: 0 }).where('id', '=', 't1').execute()).rejects.toThrow();
    await expect(k.deleteFrom('finding_responses').where('id', '=', 'r1').execute()).rejects.toThrow();
    await expect(insertTolerance(k, e.id, { id: 't3', controlId: 'X', rate: 0.3, recordedBy: 'auditor', recordedAt: '2026-10-22T00:00:02.000Z', trailBundleId: 'b5' })).rejects.toThrow();
  });
});
