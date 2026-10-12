import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { newService } from './helpers';

describe('HTTP API', () => {
  let app: ReturnType<typeof createApp>;
  const as = (user: string) => ({ 'x-user-id': user });

  beforeAll(async () => {
    app = createApp(await newService());
  });

  it('runs a full engagement end to end over HTTP [REQ-06, REQ-15]', async () => {
    expect((await request(app).post('/api/engagements').send({}).set(as('nobody'))).status).toBe(400);

    const created = await request(app).post('/api/engagements').set(as('auditor')).send({
      name: 'Pharma self-inspection', entity: 'Demo Pharma', site: 'OSD plant', periodFrom: '2026-01-01', periodTo: '2026-06-30',
      auditType: 'GMP self-inspection', scopeStatement: 'Data integrity: HPLC audit trails and user access; deviations and CAPA', packIds: ['pharma'],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    expect((await request(app).post(`/api/engagements/${id}/modules/scope/run`).set(as('approver'))).status).toBe(403);
    const scope = await request(app).post(`/api/engagements/${id}/modules/scope/run`).set(as('auditor'));
    expect(scope.status).toBe(200);
    expect(scope.body.engagement.scope.filter((s: any) => s.included).map((s: any) => s.controlId)).toContain('PH-DI-01');

    await request(app).post(`/api/engagements/${id}/modules/rcm/run`).set(as('auditor')).expect(200);
    await request(app).put(`/api/engagements/${id}/tests/PH-DI-01`).set(as('auditor'))
      .send({ designAdequate: true, observation: 'Audit trail review missing for 5 of 20 sequences', evidenceRefs: ['SEQ-Q2'], sampleTested: 20, exceptions: 5 }).expect(200);
    await request(app).post(`/api/engagements/${id}/modules/testing/run`).set(as('auditor')).expect(200);
    const gaps = await request(app).post(`/api/engagements/${id}/modules/gaps/run`).set(as('auditor')).expect(200);
    const fid = gaps.body.engagement.findings[0].id;

    await request(app).post(`/api/engagements/${id}/findings/${fid}/signoff`).set(as('reviewer')).send({ action: 'review' }).expect(200);
    await request(app).post(`/api/engagements/${id}/findings/${fid}/signoff`).set(as('approver')).send({ action: 'approve', comment: 'ok' }).expect(200);
    await request(app).post(`/api/engagements/${id}/modules/report/run`).set(as('auditor')).expect(200);

    const md = await request(app).get(`/api/engagements/${id}/report.md`).expect(200);
    expect(md.text).toContain('§11.10(e)');
    const csv = await request(app).get(`/api/engagements/${id}/findings.csv`).expect(200);
    expect(csv.text.split('\n')).toHaveLength(2);
    expect((await request(app).get('/api/trail/verify')).body.valid).toBe(true);
  });

  it('rejects exceptions greater than the sample', async () => {
    const res = await request(app).get('/api/engagements');
    const id = res.body[0].id;
    const r = await request(app).put(`/api/engagements/${id}/tests/PH-DI-01`).set(as('auditor'))
      .send({ designAdequate: true, observation: '', evidenceRefs: ['x'], sampleTested: 2, exceptions: 3 });
    expect(r.status).toBe(400);
  });

  it('rejects a change sent with a stale If-Match version [REQ-21]', async () => {
    const id = (await request(app).get('/api/engagements')).body[0].id;
    const current = await request(app).get(`/api/engagements/${id}`).expect(200);
    expect(current.headers.etag).toBe(`"${current.body.version}"`);
    const body = { designAdequate: true, observation: 'All sequences reviewed', evidenceRefs: ['SEQ-Q3'], sampleTested: 20, exceptions: 0 };
    const put = () => request(app).put(`/api/engagements/${id}/tests/PH-DI-01`).set(as('auditor'));
    await put().set('If-Match', `"${current.body.version}"`).send(body).expect(200);
    const stale = await put().set('If-Match', `"${current.body.version}"`).send(body);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect((await put().set('If-Match', 'not-a-version').send(body)).status).toBe(400);
  });

  it('runs the evaluation harness over all packs and serves the traceability matrix [REQ-13]', async () => {
    const before = (await request(app).get('/api/trail/verify')).body.length;
    const run = await request(app).post('/api/eval/run').expect(200);
    expect(run.body.passed).toBe(run.body.total);
    expect((await request(app).get('/api/trail/verify')).body.length).toBe(before);
    expect((await request(app).get('/api/eval/runs')).body.map((r: any) => r.id)).toEqual([run.body.id]);
    const tm = await request(app).get('/api/validation/traceability').expect(200);
    const high = tm.body.rows.filter((r: any) => r.risk === 'High');
    expect(high.every((r: any) => r.covered)).toBe(true);
  }, 120_000);
});
