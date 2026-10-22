import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { reviewSubject } from '../src/agents/qa/deterministic';
import { listSteps } from '../src/agents/run-repo';
import { AgentWorker } from '../src/agents/worker';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { ModuleContext } from '../src/engine/module';
import { reportModule } from '../src/engine/modules/report';
import { canonicalJson, sha256 } from '../src/engine/trail';
import type { Engagement } from '../src/engine/types';
import { insertSignature, listSignatures } from '../src/db/signature-repo';
import { workpaperContentHash } from '../src/signing/content-hash';
import { AuditService } from '../src/service';
import { approver, auditor, engagementWithFailedControl, FakeProvider, leasedRun, LENIENT, NEW_ENGAGEMENT, newService, registry, reviewer, unattended } from './helpers';
import { appWithDevUsers, devAuthConfig, devSign, devSignGate, signIn } from './http';

type Svc = Awaited<ReturnType<typeof newService>>;

/** Reviews and approves the engagement's first finding. */
async function approveFirst(svc: Svc, id: string) {
  const fid = (await svc.engagement(id)).findings[0].id;
  await svc.signOff(id, fid, 'review', 'ok', reviewer, {}, unattended);
  await svc.signOff(id, fid, 'approve', 'ok', approver, {}, unattended);
  return fid;
}

/** One approved Medium finding: 1 of 40 exceptions is a rare likelihood on a High-risk control (major impact). */
async function approvedMedium(svc: Svc) {
  const e = await engagementWithFailedControl(svc, 'FD-HACCP-03', ['CCP-LOG-MAR'], { sampleTested: 40, exceptions: 1, observation: '1 of 40 CCP logs unsigned.' });
  expect(e.findings[0].rating).toBe('Medium');
  await approveFirst(svc, e.id);
  return e.id;
}

/** The report module run directly on an engagement, the way the service runs it, with the given module input. */
async function runReport(svc: Svc, e: Engagement, input: Record<string, unknown> = {}) {
  const ctx = new ModuleContext(e, svc.registry, svc.grounding, null, auditor, input, LENIENT.citationPolicy);
  const out = await reportModule.run(ctx);
  reportModule.apply(e, out, `RUN-${Math.random().toString(16).slice(2, 10)}`);
  return { out, ctx };
}

/** A model that answers the report prompt only. */
const reportModel = (answer: Record<string, unknown>) => new FakeProvider(() => answer);

describe('the report opinion (spec §5.6) [REQ-32, REQ-31]', () => {
  it('rates the engagement by the rule over approved findings, with the fixed basis, the opinion section first, a response line per finding and the memo on the engagement [REQ-32, REQ-31]', async () => {
    const svc = await newService();
    const { id } = await engagementWithFailedControl(svc);
    await approveFirst(svc, id);
    await svc.runModule(id, 'report', auditor);
    const e = await svc.engagement(id);
    expect(e.findings[0].rating).toBe('High');
    expect(e.report!.opinion).toMatchObject({ rating: 'unsatisfactory', findingsFingerprint: expect.any(String) });
    expect(e.report!.opinion!.setBy).toBeUndefined();
    expect(e.report!.opinion!.basis).toContain('1 approved finding(s): 1 High, 0 Medium, 0 Low.');
    const md = e.report!.markdown;
    expect(md.indexOf('## 1. Overall opinion')).toBeGreaterThan(-1);
    expect(md.indexOf('## 1. Overall opinion')).toBeLessThan(md.indexOf('## 2. Executive summary'));
    const order = ['## 1. Overall opinion', '## 2. Executive summary', '## 3. Scope and approach', '## 4. Findings', '## 5. Controls tested', '## 7. Excluded from this report'];
    expect(order.slice(0, 5).map((h) => md.indexOf(h)).every((at, i, all) => at > -1 && (i === 0 || at > all[i - 1]))).toBe(true);
    expect(md).not.toContain('## 6. Tolerances applied');
    expect(md).not.toContain(order[5]);
    expect(md).toContain('- **Management response:** No response recorded');
    expect(md).toMatch(/Methodology: .* v\S+, \d+ of \d+ clause summaries verified by a reviewer\./);
    // The trailer's cited-sources line stays as it was (trust.test.ts pins it).
    expect(md).toMatch(/\nCited sources not yet verified by a reviewer or due for re-review \(\d+\): .*\.\nMethodology: /);
    expect(e.memos.report?.subjectKey).toBe('report');
    expect(e.memos.report!.calls[0]).toMatchObject({ question: 'Overall opinion', decision: 'unsatisfactory', source: 'rules' });
    expect(reviewSubject(e, 'report').issues.map((i) => i.criterion)).not.toContain('report.opinion-rule');

    // A regeneration that decides nothing new keeps the memo object, so the report hash moves only with the markdown.
    const memoBefore = e.memos.report!;
    await svc.runModule(id, 'report', auditor);
    expect((await svc.engagement(id)).memos.report!.producedAt).toBe(memoBefore.producedAt);
  });

  it('lists the latest response, the tolerances in force and the coverage statement [REQ-32]', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely); // a tolerance and a response name their author
    const failing = 'FD-HACCP-03';
    const created = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const id = created.id;
    await svc.runModule(id, 'scope', auditor);
    const clean = (await svc.engagement(id)).scope.find((s) => s.controlId !== failing)!.controlId;
    await svc.setScope(id, [{ controlId: failing, included: true }, { controlId: clean, included: true }], auditor);
    await svc.runModule(id, 'rcm', auditor);
    await svc.setTolerance(id, clean, 0.05, auditor);
    await svc.recordTest(id, failing, { designAdequate: true, observation: '3 of 20 CCP logs unsigned.', evidenceRefs: ['CCP-LOG-MAR'], sampleTested: 20, exceptions: 3 }, auditor);
    await svc.recordTest(id, clean, { designAdequate: true, observation: 'All items in order.', evidenceRefs: ['EV-2'], sampleTested: 20, exceptions: 0 }, auditor);
    await svc.runModule(id, 'testing', auditor);
    await svc.runModule(id, 'gaps', auditor);
    const fid = await approveFirst(svc, id);
    await svc.recordManagementResponse(id, fid, { response: 'partially_agree', owner: 'Line lead', actionPlan: 'Earlier plan' }, auditor);
    await svc.recordManagementResponse(id, fid, { response: 'agree', owner: 'Plant manager', dueDate: '2026-12-31', actionPlan: 'Retrain the line leads' }, auditor);
    await svc.runModule(id, 'report', auditor);
    const e = await svc.engagement(id);
    const md = e.report!.markdown;
    const recorded = e.responses[fid].recordedAt;
    expect(md).toContain(`- **Management response:** Agree — owner Plant manager, due 2026-12-31 (recorded ${recorded.slice(0, 10)} ${recorded.slice(11, 16)} UTC): Retrain the line leads`);
    expect(md).not.toContain('Line lead');
    expect(md).toContain('## 6. Tolerances applied');
    expect(md).toContain('| Control | Tolerance | Set by | At |');
    expect(md).toMatch(new RegExp(`\\| ${clean} \\| 5% \\| auditor \\| \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC \\|`));
    expect(md.indexOf('## 5. Controls tested')).toBeLessThan(md.indexOf('## 6. Tolerances applied'));
    expect(e.coverage).not.toBeNull();
    expect(md).toContain(e.coverage!.statement);
    expect(md.indexOf(e.coverage!.statement)).toBeGreaterThan(md.indexOf('## 3. Scope and approach'));
    expect(md.indexOf(e.coverage!.statement)).toBeLessThan(md.indexOf('## 4. Findings'));
    expect(e.memos.report!.calls[1].decision).toBe('1 of 1 approved finding(s) have a response');
    expect(reviewSubject(e, 'report').issues.map((i) => i.criterion)).not.toContain('report.responses');
  });

  it('lets the model worsen the opinion by one step with its rationale and refuses a better or two-step one in the trail [REQ-32, REQ-31]', async () => {
    const svc = await newService();
    const id = await approvedMedium(svc);

    const worse = reportModel({ executiveSummary: 's', opinion: 'unsatisfactory', opinionRationale: 'why', basisNarrative: 'The exceptions cluster on one line.' });
    const { bundle } = await new AuditService(svc.db, registry, worse, LENIENT).runModule(id, 'report', auditor);
    let e = await svc.engagement(id);
    expect(e.report!.opinion).toMatchObject({ rating: 'unsatisfactory', rationale: 'why' });
    expect(e.report!.opinion!.setBy).toBeUndefined();
    expect(e.report!.opinion!.basis).toContain('\n\nThe exceptions cluster on one line. _(Narrative drafted by AI; reviewed at report sign-off.)_');
    expect(e.memos.report!.calls[0]).toMatchObject({ decision: 'unsatisfactory', source: 'model' });
    expect(e.memos.report!.calls[0].rationale).toContain('why');
    expect(bundle.qaActions.filter((a) => a.gate === 'judgment-bounds')).toEqual([]);
    // The rule's value and the counts reach the model as data; the only instruction names the rule.
    const prompt = worse.requests[0].user;
    expect(prompt).toContain('You may state a worse opinion than needs_improvement with a one-sentence rationale; never a better one.');
    expect(prompt).toMatch(/<data source="workpaper:approved-findings">[\s\S]*"ruleOpinion": "needs_improvement"[\s\S]*<\/data>/);
    expect(prompt).toMatch(/<data source="workpaper:approved-findings">[\s\S]*"reportOpinion": "needs_improvement"[\s\S]*<\/data>/);
    // Under a CAE directive the data names the opinion the report will state, with the rule beside it; the instruction is unchanged.
    const directed = reportModel({ executiveSummary: 's' });
    const dctx = new ModuleContext(structuredClone(e), svc.registry, svc.grounding, directed, auditor, { reworkInstruction: 'opinion: satisfactory', reworkSignatureId: 'SIG-test' }, LENIENT.citationPolicy);
    await reportModule.run(dctx);
    const directedPrompt = directed.requests[0].user;
    expect(directedPrompt).toContain('You may state a worse opinion than needs_improvement with a one-sentence rationale; never a better one.');
    expect(directedPrompt).toMatch(/<data source="workpaper:approved-findings">[\s\S]*"ruleOpinion": "needs_improvement"[\s\S]*<\/data>/);
    expect(directedPrompt).toMatch(/<data source="workpaper:approved-findings">[\s\S]*"reportOpinion": "satisfactory"[\s\S]*<\/data>/);
    expect(reviewSubject(e, 'report').issues.map((i) => i.criterion)).not.toContain('report.opinion-rule');

    for (const proposed of ['satisfactory']) {
      const better = reportModel({ executiveSummary: 's', opinion: proposed, opinionRationale: 'all fine' });
      const run = await new AuditService(svc.db, registry, better, LENIENT).runModule(id, 'report', auditor);
      e = await svc.engagement(id);
      expect(e.report!.opinion!.rating).toBe('needs_improvement');
      expect(e.report!.opinion!.rationale).toBeUndefined();
      expect(e.memos.report!.calls[0].source).toBe('rules');
      expect(run.bundle.qaActions).toContainEqual(expect.objectContaining({ gate: 'judgment-bounds', outcome: 'fail', target: 'report', action: 'blocked', detail: expect.stringContaining(proposed) }));
      expect(e.memos.report!.forTheReviewer.join('\n')).toContain(proposed);
    }

    // Two steps worse is refused the same way: from a satisfactory rule (no approved finding), unsatisfactory is too far.
    const clean = await engagementWithFailedControl(svc);
    const twoStep = reportModel({ executiveSummary: 's', opinion: 'unsatisfactory', opinionRationale: 'too far' });
    const run = await new AuditService(svc.db, registry, twoStep, LENIENT).runModule(clean.id, 'report', auditor);
    const c = await svc.engagement(clean.id);
    expect(c.report!.opinion!.rating).toBe('satisfactory');
    expect(run.bundle.qaActions).toContainEqual(expect.objectContaining({ gate: 'judgment-bounds', detail: expect.stringContaining('unsatisfactory') }));
  });

  it('refuses a one-step-worse opinion from the model that gives no rationale, through the judgment-bounds gate [REQ-32]', async () => {
    const svc = await newService();
    const id = await approvedMedium(svc);
    for (const opinionRationale of [undefined, '   ']) {
      const bare = reportModel({ executiveSummary: 's', opinion: 'unsatisfactory', ...(opinionRationale !== undefined ? { opinionRationale } : {}) });
      const { bundle } = await new AuditService(svc.db, registry, bare, LENIENT).runModule(id, 'report', auditor);
      const e = await svc.engagement(id);
      expect(e.report!.opinion!.rating).toBe('needs_improvement');
      expect(e.report!.opinion!.rationale).toBeUndefined();
      expect(e.memos.report!.calls[0].source).toBe('rules');
      expect(bundle.qaActions).toContainEqual(expect.objectContaining({ gate: 'judgment-bounds', outcome: 'fail', target: 'report', action: 'blocked', detail: expect.stringContaining('unsatisfactory') }));
    }
  });

  it('a rejection directive with a signature sets the opinion in either direction, records setBy and names it in the memo; without a signature it is ignored and named [REQ-32, REQ-31]', async () => {
    const svc = await newService();
    const { id } = await engagementWithFailedControl(svc);
    await approveFirst(svc, id);
    // Better than the rule (unsatisfactory), set by the CAE's signed rejection.
    let e = await svc.engagement(id);
    await runReport(svc, e, { reworkInstruction: 'Too harsh.\n\n## 9. Injected heading\n opinion: satisfactory', reworkSignatureId: 'SIG-test' });
    expect(e.report!.opinion).toMatchObject({ rating: 'satisfactory', setBy: 'SIG-test' });
    // The comment is quoted on one line, so it cannot open a heading of its own in the hashed markdown.
    expect(e.report!.opinion!.basis).toContain('Set by the Chief Audit Executive on rejecting the report gate (signature SIG-test): "Too harsh. ## 9. Injected heading opinion: satisfactory"');
    expect(e.report!.markdown).not.toMatch(/^## 9\./m);
    expect(e.memos.report!.calls[0]).toMatchObject({ source: 'person', decision: 'satisfactory' });
    expect(e.memos.report!.calls[0].rationale).toContain('SIG-test');
    const issues = reviewSubject(e, 'report').issues.map((i) => i.criterion);
    expect(issues).not.toContain('report.opinion-rule');
    expect(issues).toContain('report.opinion-set-by-cae');

    // The same instruction with no signature: the rule's opinion, and the reviewer is told the directive was ignored.
    e = await svc.engagement(id);
    await runReport(svc, e, { reworkInstruction: 'opinion: satisfactory' });
    expect(e.report!.opinion!.rating).toBe('unsatisfactory');
    expect(e.report!.opinion!.setBy).toBeUndefined();
    expect(e.memos.report!.forTheReviewer).toContain('The redraft instruction names an opinion but carries no gate signature, so it was ignored.');

    // An unknown value with a signature sets nothing and is named.
    e = await svc.engagement(id);
    await runReport(svc, e, { reworkInstruction: 'opinion: good', reworkSignatureId: 'SIG-test' });
    expect(e.report!.opinion!.rating).toBe('unsatisfactory');
    expect(e.report!.opinion!.setBy).toBeUndefined();
    expect(e.memos.report!.forTheReviewer.join('\n')).toContain('good');

    // A signed comment that names no opinion leaves the rule's.
    e = await svc.engagement(id);
    await runReport(svc, e, { reworkInstruction: 'Please tighten the summary.', reworkSignatureId: 'SIG-test' });
    expect(e.report!.opinion!.rating).toBe('unsatisfactory');
    expect(e.memos.report!.calls[0].source).toBe('rules');
  });

  it('keeps a CAE-set opinion across a redraft while the approved findings are unchanged, and drops it with a reviewer line when they change [REQ-32]', async () => {
    const svc = await newService();
    const id = await approvedMedium(svc);
    const e = await svc.engagement(id);
    await runReport(svc, e, { reworkInstruction: 'opinion: unsatisfactory', reworkSignatureId: 'SIG-cae' });
    const set = e.report!.opinion!;
    expect(set).toMatchObject({ rating: 'unsatisfactory', setBy: 'SIG-cae' });

    // A redraft with no instruction (a response recorded after the rejection, say) carries it unchanged.
    await runReport(svc, e);
    expect(e.report!.opinion).toEqual(set);
    expect(e.memos.report!.calls[0]).toMatchObject({ source: 'person', decision: 'unsatisfactory' });

    // The approved findings change: the rule applies again and the reviewer is told why.
    e.findings[0] = { ...e.findings[0], condition: `${e.findings[0].condition} (amended)` };
    await runReport(svc, e);
    expect(e.report!.opinion!.rating).toBe('needs_improvement');
    expect(e.report!.opinion!.setBy).toBeUndefined();
    expect(e.memos.report!.forTheReviewer).toContain('The opinion unsatisfactory set by signature SIG-cae was dropped because the approved findings changed; the rule\'s opinion applies. Reject again to set it.');
  });

  it('a report written before 8C hashes as before and gets no new QA issue [REQ-32]', async () => {
    const svc = await newService();
    const { id } = await engagementWithFailedControl(svc);
    await approveFirst(svc, id);
    await svc.runModule(id, 'report', auditor);
    const e = await svc.engagement(id);
    const { opinion: _opinion, ...before8c } = e.report!;
    const old: Engagement = { ...e, report: before8c };
    const { markdown, includedFindingIds, excludedFindingIds } = before8c;
    expect(workpaperContentHash('report', old)).toBe(sha256(canonicalJson({ kind: 'report', content: { markdown, includedFindingIds, excludedFindingIds } })));
    expect(reviewSubject(old, 'report').issues.map((i) => i.criterion).filter((c) => c.startsWith('report.opinion'))).toEqual([]);
  });
});

/**
 * A pharma engagement driven by the agent worker up to its open report gate, the way judgment-responses.test.ts does.
 * `failing` gives PH-DI-01 5 of 20 exceptions (one approved finding); otherwise every row passes and there is none.
 */
async function runToReportGate(failing: boolean) {
  const { svc } = await appWithDevUsers();
  const cfg = defaultAgentConfig();
  const served = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { agents: cfg });
  const worker = new AgentWorker(svc, cfg, { id: 'w-opinion' });
  const auditorS = await signIn(served, 'auditor');
  const manager = await signIn(served, 'reviewer');
  const cae = await signIn(served, 'approver');
  const id = (await auditorS.post('/api/engagements', {
    name: 'Pharma self-inspection', entity: 'Demo Pharma', site: 'OSD plant', periodFrom: '2026-01-01', periodTo: '2026-06-30',
    auditType: 'GMP self-inspection', scopeStatement: 'Data integrity: HPLC audit trails and user access', packIds: ['pharma'],
  }).expect(201)).body.id as string;
  const runId = (await auditorS.post(`/api/engagements/${id}/runs`, {}).expect(201)).body.run.id as string;
  type GateRow = { id: string; kind: string; state: string; signatureId: string | null; qaReport: { issues: { criterion: string; severity: string }[] } | null };
  const gateRows = async () => (await auditorS.get(`/api/engagements/${id}/gates`).expect(200)).body as GateRow[];
  const openGate = async (kind: string) => (await gateRows()).find((g) => g.kind === kind && g.state === 'open')!;
  await worker.drain();
  await devSignGate(manager, 'reviewer', (await openGate('scope')).id, 'approve');
  await worker.drain();
  await devSignGate(manager, 'reviewer', (await openGate('rcm')).id, 'approve');
  await worker.drain();
  const planned = (await auditorS.get(`/api/engagements/${id}`).expect(200)).body;
  for (const row of planned.rcm as { id: string }[]) {
    const fails = failing && row.id === 'PH-DI-01';
    await auditorS.put(`/api/engagements/${id}/tests/${row.id}`, {
      designAdequate: true, observation: fails ? 'Audit trail review missing for 5 of 20 sequences' : 'All 20 items reviewed',
      evidenceRefs: ['EV-1'], sampleTested: 20, exceptions: fails ? 5 : 0,
    }).expect(200);
  }
  await worker.drain();
  const fid = failing ? (await auditorS.get(`/api/engagements/${id}`).expect(200)).body.findings[0].id as string : null;
  if (fid) {
    await devSign(manager, 'reviewer', id, fid, 'review');
    await devSign(cae, 'approver', id, fid, 'approve');
    await worker.drain();
  }
  return { svc, id, runId, fid, worker, cae, gateRows, openGate };
}

describe('the CAE sets the opinion by rejecting the report gate (spec §5.6, ruling 1) [REQ-32, REQ-27]', () => {
  it('a report gate rejected with "opinion: satisfactory" against a rule of unsatisfactory redrafts with that opinion, setBy the rejection signature, and QA does not block the new gate [REQ-32, REQ-27]', async () => {
    const { svc, id, runId, fid, worker, cae, gateRows, openGate } = await runToReportGate(true);
    const gate = await openGate('report');
    expect((await svc.engagement(id)).report!.opinion!.rating).toBe('unsatisfactory');
    await devSignGate(cae, 'approver', gate.id, 'reject', 'Isolated lapse, remediated.\nopinion: satisfactory');
    await worker.drain();
    const e = await svc.engagement(id);
    const rejected = (await gateRows()).find((g) => g.id === gate.id)!;
    expect(rejected.signatureId).toEqual(expect.any(String));
    expect(e.report!.opinion).toMatchObject({ rating: 'satisfactory', setBy: rejected.signatureId });
    const next = await openGate('report');
    expect(next.id).not.toBe(gate.id);
    expect(next.qaReport!.issues).toContainEqual(expect.objectContaining({ criterion: 'report.opinion-set-by-cae', severity: 'advisory' }));
    expect(next.qaReport!.issues.some((i) => i.severity === 'blocking')).toBe(false);
    const steps = await listSteps(svc.db.kysely, runId);
    expect(steps.some((s) => s.decision?.action?.type === 'rework' && (s.decision.action as { directiveBy?: string }).directiveBy === rejected.signatureId)).toBe(true);

    // A response recorded after the CAE set the opinion keeps it through the redraft it triggers.
    await svc.recordManagementResponse(id, fid!, { response: 'agree', owner: 'QA head', actionPlan: 'Weekly audit-trail review' }, auditor);
    await worker.drain();
    const third = await openGate('report');
    expect(third.id).not.toBe(next.id);
    const after = await svc.engagement(id);
    expect(after.report!.opinion).toMatchObject({ rating: 'satisfactory', setBy: rejected.signatureId });
    expect(after.report!.markdown).toContain('- **Management response:** Agree — owner QA head');
    expect(third.qaReport!.issues.some((i) => i.severity === 'blocking')).toBe(false);
  });

  it('a rejection with "opinion: unsatisfactory" against a rule of satisfactory is carried too (the CAE may worsen) [REQ-32, REQ-27]', async () => {
    const { svc, id, worker, cae, gateRows, openGate } = await runToReportGate(false);
    const gate = await openGate('report');
    expect((await svc.engagement(id)).report!.opinion!.rating).toBe('satisfactory');
    await devSignGate(cae, 'approver', gate.id, 'reject', 'Coverage too thin to conclude. opinion: unsatisfactory');
    await worker.drain();
    const rejected = (await gateRows()).find((g) => g.id === gate.id)!;
    expect((await svc.engagement(id)).report!.opinion).toMatchObject({ rating: 'unsatisfactory', setBy: rejected.signatureId });
    const next = await openGate('report');
    expect(next.id).not.toBe(gate.id);
    expect(next.qaReport!.issues.some((i) => i.severity === 'blocking')).toBe(false);
  });
});

describe('who may name a signature on the report module input [REQ-26, REQ-32]', () => {
  it('a person running the report module cannot send a directive or a signature: the opinion stays at the rule [REQ-26, REQ-32]', async () => {
    const svc = await newService();
    const { id } = await engagementWithFailedControl(svc);
    await approveFirst(svc, id);
    const { bundle } = await svc.runModule(id, 'report', auditor, { reworkInstruction: 'opinion: satisfactory', reworkSignatureId: 'SIG-forged' });
    const e = await svc.engagement(id);
    expect(e.report!.opinion!.rating).toBe('unsatisfactory');
    expect(e.report!.opinion!.setBy).toBeUndefined();
    expect((bundle.inputs as { moduleInput: Record<string, unknown> }).moduleInput).toEqual({});
  });

  it('an agent redraft naming a signature that is not a CAE rejection of this report gate is refused [REQ-26, REQ-32]', async () => {
    const svc = await newService();
    const { id } = await engagementWithFailedControl(svc);
    await approveFirst(svc, id);
    const { acting } = await leasedRun(svc, id);
    const e = await svc.engagement(id);
    // A made-up id, and a real signature that is not a report rejection (the CAE's approval of the finding).
    const real = (await listSignatures(svc.db.kysely, id)).find((s) => s.meaning === 'Approved')!;
    for (const instructionBy of ['SIG-forged', real.id]) {
      await expect(svc.runModuleAsAgent(id, 'report', acting('report'), { expectedVersion: e.version!, instruction: 'opinion: satisfactory', instructionBy, llm: null }))
        .rejects.toMatchObject({ status: 409, code: 'DIRECTIVE_SIGNATURE_INVALID' });
    }
    expect((await svc.engagement(id)).report).toBeFalsy();
  });

  it('a verified signature supplies the directive text: other instruction text paired with it is not used [REQ-26, REQ-32]', async () => {
    const svc = await newService();
    const { id } = await engagementWithFailedControl(svc);
    await approveFirst(svc, id);
    const { acting } = await leasedRun(svc, id);
    const e = await svc.engagement(id);
    // A CAE's rejection of the report gate whose comment sets satisfactory (the rule gives unsatisfactory).
    const cae = (await listSignatures(svc.db.kysely, id)).find((s) => s.meaning === 'Approved')!;
    const rejection = {
      ...cae, id: 'SIG-REPORT-REJECT', findingId: null, subjectKind: 'workpaper' as const, workpaper: 'report' as const, gateId: 'GATE-R',
      meaning: 'Rejected' as const, comment: '  Too harsh. opinion: satisfactory  ', signedAt: new Date().toISOString(),
    };
    await insertSignature(svc.db.kysely, rejection);
    await svc.runModuleAsAgent(id, 'report', acting('report'), { expectedVersion: e.version!, instruction: 'opinion: needs_improvement', instructionBy: rejection.id, llm: null });
    const after = await svc.engagement(id);
    expect(after.report!.opinion).toMatchObject({ rating: 'satisfactory', setBy: rejection.id });
    expect(after.report!.opinion!.basis).toContain('"Too harsh. opinion: satisfactory"');
  });
});
