import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { startRun } from '../src/agents/runs';
import { subjectInfo } from '../src/agents/subjects';
import { listGates } from '../src/agents/gate-repo';
import { AgentWorker } from '../src/agents/worker';
import { auditor, NEW_ENGAGEMENT, reviewer, unattended } from './helpers';
import { appWithDevUsers, signIn } from './http';

const CONTEXT = { factors: [{ kind: 'change' as const, processAreas: ['HACCP'], description: 'New metal detector line 2' }], background: 'Single site.' };

describe('the engagement context (spec §3.1) [REQ-35]', () => {
  it('is set by people, trailed, and refused past its limits', async () => {
    const { app, svc } = await appWithDevUsers();
    const user = await signIn(app, 'auditor');
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const saved = await user.put(`/api/engagements/${e.id}/context`, CONTEXT);
    expect(saved.status).toBe(200);
    expect(saved.body.context).toMatchObject({ ...CONTEXT, updatedBy: 'auditor' });
    const trail = await svc.trailFor(e.id);
    expect(trail.some((b) => b.moduleId === 'human:set-context' && b.actor === 'auditor')).toBe(true);
    const tooLong = await user.put(`/api/engagements/${e.id}/context`, { ...CONTEXT, background: 'x'.repeat(4001) });
    expect(tooLong.status).toBe(400);
    expect(JSON.stringify(tooLong.body)).toMatch(/background/);
    const viewer = await signIn(app, 'viewer');
    expect((await viewer.put(`/api/engagements/${e.id}/context`, CONTEXT)).status).toBe(403);
  });

  it('reopens an approved scope, but not when re-saved unchanged, and locks once the RCM gate is approved', async () => {
    const { svc } = await appWithDevUsers();
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, context: CONTEXT }, auditor);
    await startRun(svc, defaultAgentConfig(), e.id, auditor);
    const worker = new AgentWorker(svc, defaultAgentConfig(), { id: 'w-ctx' });
    await worker.drain();
    const scopeGate = (await listGates(svc.db.kysely, e.id)).find((g) => g.kind === 'scope' && g.state === 'open')!;
    await svc.signGate(scopeGate.id, 'approve', 'ok', reviewer, unattended);
    const before = subjectInfo(await svc.engagement(e.id), 'scope')!;
    await svc.setEngagementContext(e.id, CONTEXT, auditor);                     // same content
    expect(subjectInfo(await svc.engagement(e.id), 'scope')!.basis).toBe(before.basis);
    await svc.setEngagementContext(e.id, { ...CONTEXT, factors: [...CONTEXT.factors, { kind: 'incident', processAreas: ['Allergens'], description: 'Undeclared allergen recall' }] }, auditor);
    expect(subjectInfo(await svc.engagement(e.id), 'scope')!.basis).not.toBe(before.basis);
    await worker.drain();
    const gates = await listGates(svc.db.kysely, e.id);
    expect(gates.filter((g) => g.kind === 'scope')).toHaveLength(2);           // the old one approved, a fresh one open
    expect(gates.find((g) => g.kind === 'scope' && g.state === 'open')).toBeDefined();
    // Approve scope again and the RCM, then the context is locked.
    await svc.signGate(gates.find((g) => g.kind === 'scope' && g.state === 'open')!.id, 'approve', 'ok', reviewer, unattended);
    await worker.drain();
    const rcm = (await listGates(svc.db.kysely, e.id)).find((g) => g.kind === 'rcm' && g.state === 'open')!;
    await svc.signGate(rcm.id, 'approve', 'ok', reviewer, unattended);
    await expect(svc.setEngagementContext(e.id, CONTEXT, auditor)).rejects.toMatchObject({ status: 409, code: 'CONTEXT_LOCKED' });

  });
});

describe('the scope memo on the gate [REQ-31]', () => {
  it('is part of the content the scope gate and its signature cover, and is served for the panel', async () => {
    const { app, svc } = await appWithDevUsers();
    const user = await signIn(app, 'auditor');
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, context: CONTEXT }, auditor);
    await startRun(svc, defaultAgentConfig(), e.id, auditor);
    await new AgentWorker(svc, defaultAgentConfig(), { id: 'w-memo' }).drain();
    const gate = (await listGates(svc.db.kysely, e.id)).find((g) => g.kind === 'scope' && g.state === 'open')!;
    const current = await svc.engagement(e.id);
    expect(gate.subjectHash).toBe(subjectInfo(current, 'scope')!.hash);
    const edited = { ...current, memos: { ...current.memos, scope: { ...current.memos.scope, forTheReviewer: ['tampered'] } } };
    expect(subjectInfo(edited, 'scope')!.hash).not.toBe(gate.subjectHash);
    const memo = await user.get(`/api/engagements/${e.id}/memos/scope`).expect(200);
    expect(memo.body.memo.subjectKey).toBe('scope');
    expect(memo.body.markdown).toMatch(/For the reviewer/);
    await user.get(`/api/engagements/${e.id}/memos/report`).expect(404);
  });
});
