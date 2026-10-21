import { describe, expect, it } from 'vitest';
import { loadEngagement, saveEngagement } from '../src/db/engagement-repo';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

describe('judgment fields on the engagement', () => {
  it('round-trips the context, coverage and memos, and loads older rows as empty', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const k = svc.db.kysely;
    const fresh = (await loadEngagement(k, e.id))!;
    expect(fresh.engagement).toMatchObject({ context: null, coverage: null, memos: {} });
    fresh.engagement.context = { factors: [{ kind: 'incident', processAreas: ['HACCP'], description: 'Two CCP deviations in March' }], background: 'One plant.', updatedBy: 'auditor', updatedAt: '2026-10-21T00:00:00.000Z' };
    fresh.engagement.coverage = { excluded: [{ processArea: 'Procure to pay', reason: 'below relevance threshold' }], statement: '1 area excluded.' };
    fresh.engagement.memos = { scope: { subjectKey: 'scope', calls: [], forTheReviewer: ['Nothing to verify.'], producedAt: '2026-10-21T00:00:00.000Z' } };
    await saveEngagement(k, fresh);
    const again = (await loadEngagement(k, e.id))!.engagement;
    expect(again.context?.factors[0].description).toBe('Two CCP deviations in March');
    expect(again.coverage?.excluded).toHaveLength(1);
    expect(again.memos.scope.forTheReviewer).toEqual(['Nothing to verify.']);
  });
});
