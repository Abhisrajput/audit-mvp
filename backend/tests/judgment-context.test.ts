import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { startRun } from '../src/agents/runs';
import { subjectInfo } from '../src/agents/subjects';
import { listGates } from '../src/agents/gate-repo';
import { getRun, listSteps } from '../src/agents/run-repo';
import { AgentWorker } from '../src/agents/worker';
import { auditor, NEW_ENGAGEMENT, reviewer, unattended } from './helpers';
import { appWithDevUsers, signIn } from './http';

const CONTEXT = { factors: [{ kind: 'change' as const, processAreas: ['Food safety – HACCP'], description: 'New metal detector line 2' }], background: 'Single site.' };

describe('the engagement context (spec §3.1) [REQ-35]', () => {
  it('is set by people, trailed, and refused past its limits [REQ-35]', async () => {
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

  it('reopens an approved scope, but not when re-saved unchanged, and locks once the RCM gate is approved [REQ-35]', async () => {
    const { svc } = await appWithDevUsers();
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, context: CONTEXT }, auditor);
    const { run } = await startRun(svc, defaultAgentConfig(), e.id, auditor);
    const worker = new AgentWorker(svc, defaultAgentConfig(), { id: 'w-ctx' });
    await worker.drain();
    // An area of the chosen packs with no control in the first scope: the new factor below names it.
    const first = await svc.engagement(e.id);
    const left = first.coverage!.excluded.map((x) => x.processArea);
    const area = left.includes('IT general controls') ? 'IT general controls' : left[0];
    expect(area).toBeDefined();
    expect(first.scope.some((s) => s.processArea === area && s.included)).toBe(false);
    const scopeGate = (await listGates(svc.db.kysely, e.id)).find((g) => g.kind === 'scope' && g.state === 'open')!;
    await svc.signGate(scopeGate.id, 'approve', 'ok', reviewer, unattended);
    const before = subjectInfo(await svc.engagement(e.id), 'scope')!;
    await svc.setEngagementContext(e.id, CONTEXT, auditor);                     // same content
    expect(subjectInfo(await svc.engagement(e.id), 'scope')!.basis).toBe(before.basis);
    await svc.setEngagementContext(e.id, { ...CONTEXT, factors: [...CONTEXT.factors, { kind: 'incident', processAreas: [area], description: 'Access review skipped for a quarter' }] }, auditor);
    expect(subjectInfo(await svc.engagement(e.id), 'scope')!.basis).not.toBe(before.basis);
    await worker.drain();
    const gates = await listGates(svc.db.kysely, e.id);
    expect(gates.filter((g) => g.kind === 'scope')).toHaveLength(2);           // the old one approved, a fresh one open
    expect(gates.find((g) => g.kind === 'scope' && g.state === 'open')).toBeDefined();
    // The rebuilt scope follows the new context: the named area now has a control in scope, and the run waits on the gate.
    const rebuilt = await svc.engagement(e.id);
    expect(rebuilt.scope.some((s) => s.processArea === area && s.included)).toBe(true);
    expect(rebuilt.coverage!.excluded.map((x) => x.processArea)).not.toContain(area);
    expect((await getRun(svc.db.kysely, run.id))!.status).not.toBe('needs_human');
    // Approve scope again and the RCM, then the context is locked.
    await svc.signGate(gates.find((g) => g.kind === 'scope' && g.state === 'open')!.id, 'approve', 'ok', reviewer, unattended);
    await worker.drain();
    const rcm = (await listGates(svc.db.kysely, e.id)).find((g) => g.kind === 'rcm' && g.state === 'open')!;
    await svc.signGate(rcm.id, 'approve', 'ok', reviewer, unattended);
    await expect(svc.setEngagementContext(e.id, CONTEXT, auditor)).rejects.toMatchObject({ status: 409, code: 'CONTEXT_LOCKED' });

  });
});

describe('the scope memo on the gate [REQ-31]', () => {
  it('is part of the content the scope gate and its signature cover, and is served for the panel [REQ-31]', async () => {
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

describe('a hand-drafted subject under a changing basis [REQ-35]', () => {
  it('rebuilds a hand-drafted scope once when the context changes under an open gate, instead of reopening a gate on stale assessments [REQ-35]', async () => {
    const { svc } = await appWithDevUsers();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const AREA = 'Food safety – HACCP';
    const A = 'Metal detector line 2 failed twice in March';
    const B = 'Allergen cross-contact found on line 3';
    await svc.setEngagementContext(e.id, { factors: [{ kind: 'incident', processAreas: [AREA], description: A }], background: 'Single site.' }, auditor);
    await svc.runModule(e.id, 'scope', auditor);                               // drafted by hand, before any agent run
    const { run } = await startRun(svc, defaultAgentConfig(), e.id, auditor);
    const worker = new AgentWorker(svc, defaultAgentConfig(), { id: 'w-hand' });
    await worker.drain();
    const first = (await listGates(svc.db.kysely, e.id)).filter((g) => g.kind === 'scope');
    expect(first).toHaveLength(1);
    expect(first[0].state).toBe('open');
    const before = (await svc.engagement(e.id)).scope.filter((s) => s.processArea === AREA);
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((s) => s.riskFactors.join(' ').includes(A))).toBe(true);

    await svc.setEngagementContext(e.id, {
      factors: [
        { kind: 'incident', processAreas: [AREA], description: B },
        { kind: 'prior_finding', processAreas: ['Governance'], description: 'Prior audit: board minutes not retained' },
      ],
      background: 'Single site.',
    }, auditor);
    await worker.drain();

    const scopeDelegates = async () => (await listSteps(svc.db.kysely, run.id)).filter((s) => s.kind === 'delegate' && (s.decision as { action: { subjectKey: string } }).action.subjectKey === 'scope');
    const gates = (await listGates(svc.db.kysely, e.id)).filter((g) => g.kind === 'scope');
    expect(gates.find((g) => g.id === first[0].id)!.state).toBe('superseded');
    expect(await scopeDelegates()).toHaveLength(1);
    const scope = (await svc.engagement(e.id)).scope;
    const food = scope.filter((s) => s.processArea === AREA);
    expect(food.length).toBeGreaterThan(0);
    expect(food.some((s) => s.riskFactors.join(' ').includes(B))).toBe(true);
    expect(food.some((s) => s.riskFactors.join(' ').includes(A))).toBe(false);
    const step = { Low: 'Medium', Medium: 'High', High: 'High' } as const;
    const gov = scope.filter((s) => s.processArea === 'Governance');
    expect(gov.length).toBeGreaterThan(0);
    for (const s of gov) expect(s.assessedRisk).toBe(step[s.inherentRisk]);
    expect(gates.filter((g) => g.state === 'open')).toHaveLength(1);

    await worker.drain();                                                       // nothing changed: no second rebuild
    expect(await scopeDelegates()).toHaveLength(1);
    expect((await listGates(svc.db.kysely, e.id)).filter((g) => g.kind === 'scope')).toHaveLength(2);
  });
});
