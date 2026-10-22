import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { agentPort } from '../src/agents/port';
import { defaultAssistantConfig } from '../src/assistant/config';
import { createApp } from '../src/app';
import type { TestDraft } from '../src/engine/types';
import { ensureDevUsers } from '../src/auth/dev-users';
import { DEFAULT_RATE_LIMITS } from '../src/http/security';
import { insertDocument } from '../src/knowledge/document-repo';
import { devAuthConfig, signIn } from './http';
import { auditor, leasedRun, NEW_ENGAGEMENT, newService } from './helpers';

// Drafts are served per reader (spec §12, REQ-41): only to a preparer who may read every document the draft cites.

const draftCiting = (rowId: string, documentId: string, quote = 'the internal clause'): TestDraft => ({
  rowId,
  proposal: { designAdequate: true, sampleTested: 5, exceptions: 0, observation: 'Reviewed.' },
  evidence: [{ documentId, quote }],
  couldNotVerify: [], confidence: 'medium', qa: { blocking: [], advisory: [] },
  draftedBy: { runId: 'RUN-X', at: '2026-10-22T10:00:00.000Z', model: 'm' },
});

async function setup() {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  await svc.runModule(e.id, 'scope', auditor);
  const scope = (await svc.engagement(e.id)).scope;
  const [a, b] = scope.slice(0, 2).map((s) => s.controlId);
  await svc.setScope(e.id, scope.map((s) => ({ controlId: s.controlId, included: s.controlId === a || s.controlId === b })), auditor);
  await svc.runModule(e.id, 'rcm', auditor);
  const rows = (await svc.engagement(e.id)).rcm.map((r) => r.id);
  const db = svc.db.kysely;
  const doc = (classification: 'internal' | 'restricted', sha: string) =>
    insertDocument(db, { sha256: sha.repeat(64), filename: `${classification}.pdf`, mime: 'application/pdf', size: 10, kind: 'evidence', classification, engagementId: e.id, uploadedBy: 'auditor' });
  const restricted = await doc('restricted', 'a');
  const internal = await doc('internal', 'b');
  const { acting } = await leasedRun(svc, e.id);
  await agentPort(svc).saveTestDrafts(
    e.id,
    { [rows[0]]: draftCiting(rows[0], restricted.id, 'the restricted clause'), [rows[1]]: draftCiting(rows[1], internal.id) },
    acting('evidence'),
    { expectedVersion: (await svc.engagement(e.id)).version! },
  );
  const http = createApp(svc, { config: devAuthConfig(), oidc: null });
  return { svc, e, rows, http };
}

describe('drafts are redacted per reader', () => {
  it('the manager sees every draft, the auditor not one citing a restricted document, the viewer none [REQ-41]', async () => {
    const { e, rows, http } = await setup();
    const url = `/api/engagements/${e.id}`;
    const manager = await signIn(http, 'reviewer');
    const aud = await signIn(http, 'auditor');
    const view = await signIn(http, 'viewer');
    const m = (await manager.get(url).expect(200)).body;
    expect(Object.keys(m.testDrafts).sort()).toEqual([...rows].sort());
    expect(m.testDrafts[rows[0]].evidence[0].quote).toBe('the restricted clause');
    const a = (await aud.get(url).expect(200)).body;
    expect(Object.keys(a.testDrafts)).toEqual([rows[1]]);
    expect(JSON.stringify(a)).not.toContain('the restricted clause');
    const v = (await view.get(url).expect(200)).body;
    expect(v.testDrafts).toEqual({});
  });

  it('a mutation that returns the engagement is redacted the same way', async () => {
    const { e, rows, http } = await setup();
    const aud = await signIn(http, 'auditor');
    const res = (await aud.post(`/api/engagements/${e.id}/tests/${rows[1]}/draft/discard`).expect(200)).body;
    expect(Object.keys(res.testDrafts)).toEqual([rows[1]]);
    const recorded = (await aud.put(`/api/engagements/${e.id}/tests/${rows[1]}`, { designAdequate: true, observation: 'Reviewed.', evidenceRefs: [], sampleTested: 5, exceptions: 0 }).expect(200)).body;
    expect(recorded.testDrafts[rows[0]]).toBeUndefined();
    const run = (await aud.post(`/api/engagements/${e.id}/modules/scope/run`, {}).expect(200)).body;
    expect(run.engagement.testDrafts[rows[0]]).toBeUndefined();
  });

  it('an assistant write command that returns the engagement is redacted too', async () => {
    const { svc, e, rows } = await setup();
    const app = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, {
      agents: defaultAgentConfig(), assistant: defaultAssistantConfig(), rateLimits: DEFAULT_RATE_LIMITS,
    });
    const aud = await signIn(app, 'auditor');
    const controlId = (await svc.engagement(e.id)).rcm.find((r) => r.id === rows[0])!.controlId;
    const res = (await aud.post('/api/assistant/commands', { name: 'set_tolerance', args: { engagementId: e.id, controlId, rate: 0.05 } }).expect(200)).body;
    expect(Object.keys(res.result.testDrafts)).toEqual([rows[1]]);
    expect(JSON.stringify(res)).not.toContain('the restricted clause');
  });
});
