import { spawnSync } from 'node:child_process';
import path from 'node:path';
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

    for (const [user, userId, action] of [[reviewer, 'reviewer', 'review'], [approver, 'approver', 'approve']] as const) {
      const intent = await user.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action, comment: 'ok' }).expect(201);
      const nonce = /name="nonce" value="([^"]+)"/.exec((await user.get(intent.body.reauthUrl).expect(200)).text)![1];
      await user.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: userId }).expect(200);
    }
    await auditor.post(`/api/engagements/${id}/modules/report/run`).expect(200);

    const md = await auditor.get(`/api/engagements/${id}/report.md`).expect(200);
    expect(md.text).toContain('§11.10(e)');
    expect(md.text).toMatch(/Reviewed by Ravi Reviewer \(audit_manager\) at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, re-authenticated by demo confirmation \[SIG-[0-9a-f]{12}\]/);
    expect(md.text).toMatch(/Approved by Priya QA Head \(cae\) at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, re-authenticated by demo confirmation \[SIG-[0-9a-f]{12}\]/);
    const csv = await auditor.get(`/api/engagements/${id}/findings.csv`).expect(200);
    const lines = csv.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(',signatures,');
    expect(lines[0]).not.toContain('approvedBy');
    expect(lines[1]).toMatch(/"Reviewed\|Ravi Reviewer\|audit_manager\|[^|]+\|dev\|SIG-[0-9a-f]{12}\|valid; Approved\|Priya QA Head\|cae\|[^|]+\|dev\|SIG-[0-9a-f]{12}\|valid"/);
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

  it('fails the traceability command when a requirement has no automated evidence', () => {
    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync('npx', ['tsx', 'src/validation/cli.ts'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ...env } });
    expect(run({}).status).toBe(0);
    const failing = run({ TRACEABILITY_REQUIREMENTS: path.resolve(__dirname, 'fixtures/requirements-uncovered.json') });
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain('**NOT COVERED**');
  }, 60_000);
});
