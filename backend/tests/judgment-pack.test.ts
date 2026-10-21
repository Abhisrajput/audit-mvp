import { describe, expect, it } from 'vitest';
import { IIA, METHODOLOGY_PACK_ID } from '../src/judgment/standards';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';
import { appWithDevUsers, signIn } from './http';

describe('the IIA methodology pack (spec §4)', () => {
  it('loads with every clause the judgments cite, all draft and unverified', async () => {
    const svc = await newService();
    const pack = svc.registry.get(METHODOLOGY_PACK_ID);
    expect(pack.controls).toHaveLength(0);
    expect(pack.sources).toEqual({ 'IIA Global Internal Audit Standards 2024': 'IIA' });
    for (const id of Object.values(IIA)) {
      const c = svc.registry.clauses.get(id);
      expect(c, id).toBeDefined();
      expect(c!.reviewStatus).toBe('draft');
      expect(c!.trust?.verifiedBy ?? null).toBeNull();
      expect(svc.registry.citationLabel(id)).toMatch(/^IIA /);
    }
  });

  it('is never an engagement pack: not offered, not accepted, not retrieved', async () => {
    const { app, svc } = await appWithDevUsers();
    const user = await signIn(app, 'auditor');
    const listed = (await user.get('/api/packs').expect(200)).body.map((p: { id: string }) => p.id);
    expect(listed).not.toContain(METHODOLOGY_PACK_ID);
    expect((await user.post('/api/engagements', { ...NEW_ENGAGEMENT, packIds: ['common', METHODOLOGY_PACK_ID] })).status).toBe(400);
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    expect(svc.registry.clausesFor(e.packIds).some((c) => c.packId === METHODOLOGY_PACK_ID)).toBe(false);
    const hits = (await user.get('/api/search?q=risk assessment').expect(200)).body as { clause: { packId: string } }[];
    expect(hits.some((h) => h.clause.packId === METHODOLOGY_PACK_ID)).toBe(false);
  });
});
