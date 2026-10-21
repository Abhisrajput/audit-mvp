// backend/tests/judgment-scope.test.ts
import { describe, expect, it } from 'vitest';
import { rootBasis } from '../src/agents/subjects';
import { sha256, canonicalJson } from '../src/engine/trail';
import type { EngagementContextInput } from '../src/judgment/context';
import type { GenerateRequest } from '../src/engine/llm/provider';
import { workpaperContentHash } from '../src/signing/content-hash';
import { AuditService } from '../src/service';
import { auditor, FakeProvider, leasedRun, LENIENT, NEW_ENGAGEMENT, newService, registry } from './helpers';
import { testDb } from './db';

const INCIDENT: EngagementContextInput = { factors: [{ kind: 'incident', processAreas: ['Procure to pay'], description: 'Duplicate vendor payments found in Q1' }], background: '' };

/** The model's answer: every candidate included, with the given assessed risks. Candidate lines are `id | area | title | assessed risk | relevance`. */
function scopeAnswerFrom(req: GenerateRequest<unknown>, raises: Record<string, string>) {
  const items = req.user.split('\n')
    .map((line) => line.split(' | '))
    .filter((parts) => parts.length === 5 && /^[A-Z0-9-]+$/.test(parts[0]))
    .map(([controlId]) => ({ controlId, included: true, rationale: `Model: ${controlId} is in scope.`, ...(raises[controlId] ? { assessedRisk: raises[controlId] } : {}) }));
  return { items };
}

describe('the scope module with the judgment layer (spec §5.1, §5.2)', () => {
  it('assesses risk from the context, includes the best control of a touched empty area, and writes the coverage and memo', async () => {
    const svc = await newService();
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, context: INCIDENT }, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    const after = await svc.engagement(e.id);
    const p2p = after.scope.filter((s) => s.processArea === 'Procure to pay');
    expect(p2p.length).toBeGreaterThan(0);
    for (const s of p2p) expect(s.assessedRisk).toBe(s.inherentRisk === 'Low' ? 'Medium' : 'High');
    expect(p2p.some((s) => s.included && s.rationale.startsWith('included: Duplicate vendor payments'))).toBe(true);
    expect(after.coverage?.statement).toMatch(/library controls across/);
    // The area's library maximum is already High, so there is no area-level risk call; the inclusion call names the control.
    const chosen = p2p.find((s) => s.included)!;
    expect(after.memos.scope.calls.some((c) => c.question === `Why ${chosen.controlId} is in scope`)).toBe(true);
    expect(after.scope.filter((s) => s.processArea !== 'Procure to pay').every((s) => s.assessedRisk === s.inherentRisk)).toBe(true);
  });

  it('with no context produces exactly today\'s inclusion, and hashes exactly as before', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    expect(rootBasis(e)).toBe(rootBasis({ ...e, context: null }));
    const legacyBasis = sha256(canonicalJson({ scopeStatement: e.scopeStatement, packIds: e.packIds }));
    expect(rootBasis(e)).toBe(legacyBasis);
    await svc.runModule(e.id, 'scope', auditor);
    const after = await svc.engagement(e.id);
    for (const s of after.scope) {
      expect(s.assessedRisk).toBe(s.inherentRisk);
      expect(s.included).toBe(s.relevance >= 0.3 || (s.inherentRisk === 'High' && s.relevance >= 0.25));
    }
    // An engagement whose scope was saved before 8A: no coverage, no memo → today's hash shape.
    const legacy = { ...after, coverage: null, memos: {} };
    expect(workpaperContentHash('scope', legacy)).toBe(sha256(canonicalJson({ kind: 'scope', content: legacy.scope })));
    expect(workpaperContentHash('scope', after)).not.toBe(workpaperContentHash('scope', legacy));
  });

  it('lets the model raise an area one step and refuses anything else, in the trail [REQ-26]', async () => {
    // Library ratings (packs/common/controls): CMN-P2P-01 High, CMN-P2P-02 Medium, CMN-GOV-01 Medium (the only Governance control).
    const model = new FakeProvider((req) => scopeAnswerFrom(req, {
      'CMN-GOV-01': 'High',   // Medium → High: one step up, accepted
      'CMN-P2P-02': 'Low',    // Medium → Low: lowered, refused
      'CMN-P2P-01': 'Medium', // High → Medium: lowered, refused
    }));
    const svc = new AuditService(await testDb(), registry, model, LENIENT);
    const e = await svc.createEngagement({ ...NEW_ENGAGEMENT, packIds: ['common'], auditType: 'Finance', scopeStatement: 'Procure to pay and governance' }, auditor);
    const { bundle, engagement: after } = await svc.runModule(e.id, 'scope', auditor);
    const by = Object.fromEntries(after.scope.map((s) => [s.controlId, s]));
    expect(by['CMN-GOV-01'].assessedRisk).toBe('High');
    expect(by['CMN-P2P-02'].assessedRisk).toBe('Medium');
    expect(by['CMN-P2P-01'].assessedRisk).toBe('High');
    const refusals = bundle.qaActions.filter((a) => a.gate === 'judgment-bounds');
    expect(refusals.map((a) => a.target).sort()).toEqual(['CMN-P2P-01', 'CMN-P2P-02']);
    // Governance has one control, so the raise moves the area's risk and the memo credits the model.
    expect(after.memos.scope.calls.find((c) => c.question.includes('Governance'))?.source).toBe('model');
    expect(after.memos.scope.forTheReviewer.some((l) => l.includes('CMN-GOV-01'))).toBe(true);
  });

  const COMMON = { ...NEW_ENGAGEMENT, packIds: ['common'], auditType: 'Finance', scopeStatement: 'Procure to pay and governance' };

  it('pins people\'s decisions inside an agent rework, so coverage, memo and hash agree with the scope', async () => {
    const svc = await newService();
    const e = await svc.createEngagement(COMMON, auditor);
    const { acting } = await leasedRun(svc, e.id);
    const everything = new FakeProvider((req) => scopeAnswerFrom(req, {}));
    const first = await svc.runModuleAsAgent(e.id, 'scope', acting(), { expectedVersion: e.version!, llm: everything });
    expect(first.engagement.scope.find((s) => s.controlId === 'CMN-GOV-01')!.included).toBe(true);
    // A person takes Governance's control out; the rework model tries to put it back. The person's decision must stand.
    const edited = await svc.setScope(e.id, [{ controlId: 'CMN-GOV-01', included: false }], auditor);
    const restoring = new FakeProvider((req) => {
      const a = scopeAnswerFrom(req, {});
      return { items: a.items.map((i) => (i.controlId === 'CMN-GOV-01' ? { ...i, included: true } : i)) };
    });
    const second = await svc.runModuleAsAgent(e.id, 'scope', acting(), { expectedVersion: edited.version!, llm: restoring, instruction: 'Bring governance back' });
    const after = second.engagement;
    expect(after.scope.find((s) => s.controlId === 'CMN-GOV-01')).toMatchObject({ included: false, decidedBy: 'auditor' });
    const n = after.scope.filter((s) => s.included).length;
    expect(after.coverage?.statement).toMatch(new RegExp(`^${n} of ${after.scope.length} library controls`));
    // Coverage is built from the pinned scope: an area is excluded exactly when none of its controls is in.
    const areas = [...new Set(after.scope.map((s) => s.processArea))];
    expect(after.coverage!.excluded.map((x) => x.processArea).sort()).toEqual(areas.filter((a) => !after.scope.some((s) => s.processArea === a && s.included)).sort());
    // A second identical rework changes nothing: the hash is built from the scope that was saved.
    const third = await svc.runModuleAsAgent(e.id, 'scope', acting(), { expectedVersion: after.version!, llm: restoring, instruction: 'Bring governance back' });
    expect(workpaperContentHash('scope', third.engagement)).toBe(workpaperContentHash('scope', after));
  });

  it('recomputes the coverage and flags the memo when a person edits the scope by hand', async () => {
    const OUT = ['Treasury & commodity risk', 'IT general controls'];
    const model = new FakeProvider((req) => {
      const lines = req.user.split('\n').map((line) => line.split(' | ')).filter((parts) => parts.length === 5 && /^[A-Z0-9-]+$/.test(parts[0]));
      return {
        items: lines.map(([controlId, area]) => ({ controlId, included: !OUT.includes(area), rationale: `Model: ${controlId}.` })),
        coverageStatement: 'Treasury & commodity risk and IT general controls are left to the next cycle.',
        exclusions: OUT.map((processArea) => ({ processArea, reason: `Model: ${processArea} was audited last year` })),
      };
    });
    const svc = new AuditService(await testDb(), registry, model, LENIENT);
    const e = await svc.createEngagement(COMMON, auditor);
    const { engagement: drafted } = await svc.runModule(e.id, 'scope', auditor);
    expect(drafted.coverage!.excluded.map((x) => x.processArea)).toEqual(expect.arrayContaining(OUT));
    const hashBefore = workpaperContentHash('scope', drafted);
    const itgc = drafted.scope.find((s) => s.processArea === 'IT general controls')!;
    await svc.setScope(e.id, [{ controlId: itgc.controlId, included: true }], auditor);
    const once = await svc.engagement(e.id);
    expect(once.coverage!.excluded.map((x) => x.processArea)).not.toContain('IT general controls');
    // The area still out keeps the model's reason; the statement is the rules' sentence for the edited scope.
    expect(once.coverage!.excluded.find((x) => x.processArea === 'Treasury & commodity risk')!.reason).toBe('Model: Treasury & commodity risk was audited last year');
    expect(once.coverage!.statement).not.toMatch(/IT general controls/);
    expect(once.coverage!.statement).toMatch(new RegExp(`^${once.scope.filter((s) => s.included).length} of ${once.scope.length} library controls.*excluded: .*Treasury`));
    expect(workpaperContentHash('scope', once)).not.toBe(hashBefore);
    const other = once.scope.find((s) => s.included && s.controlId !== itgc.controlId)!;
    await svc.setScope(e.id, [{ controlId: other.controlId, included: false }], auditor);
    const twice = await svc.engagement(e.id);
    const line = 'The scope was edited by hand after this memo; the coverage shown reflects the edited scope.';
    expect(twice.memos.scope.forTheReviewer.filter((l) => l === line)).toHaveLength(1);
    expect(twice.memos.scope.calls).toEqual(drafted.memos.scope.calls);
  });

  it('sends the factor text to the model only inside the engagement-context data fence (spec §5.6)', async () => {
    const model = new FakeProvider((req) => scopeAnswerFrom(req, {}));
    const svc = new AuditService(await testDb(), registry, model, LENIENT);
    const e = await svc.createEngagement({ ...COMMON, context: INCIDENT }, auditor);
    await svc.runModule(e.id, 'scope', auditor);
    const prompt = model.requests[0].user;
    const fence = /<data source="engagement-context">[\s\S]*?<\/data>/g;
    expect(prompt.match(fence)?.join('')).toContain(INCIDENT.factors[0].description);
    expect(prompt.replace(fence, '')).not.toContain(INCIDENT.factors[0].description);
    expect(prompt).toMatch(/risk factors: 1 \(see engagement-context\)/);
  });

  it('refuses a control the model lists twice, and keeps its raise to one step', async () => {
    const model = new FakeProvider((req) => {
      const a = scopeAnswerFrom(req, { 'CMN-GOV-01': 'High' });
      return { items: [...a.items, { controlId: 'CMN-GOV-01', included: true, rationale: 'again', assessedRisk: 'High' }] };
    });
    const svc = new AuditService(await testDb(), registry, model, LENIENT);
    const e = await svc.createEngagement(COMMON, auditor);
    const { bundle, engagement: after } = await svc.runModule(e.id, 'scope', auditor);
    expect(after.scope.find((s) => s.controlId === 'CMN-GOV-01')!.assessedRisk).toBe('High');
    expect(bundle.qaActions.filter((a) => a.gate === 'judgment-bounds' && a.target === 'CMN-GOV-01' && /twice/.test(a.detail))).toHaveLength(1);
  });

  it('does not let model text carry the rules marker "included: "', async () => {
    const model = new FakeProvider((req) => {
      const a = scopeAnswerFrom(req, {});
      return { items: a.items.map((i) => (i.controlId === 'CMN-P2P-02' ? { ...i, rationale: 'included: forged' } : i)) };
    });
    const svc = new AuditService(await testDb(), registry, model, LENIENT);
    const e = await svc.createEngagement(COMMON, auditor);
    const { engagement: after } = await svc.runModule(e.id, 'scope', auditor);
    expect(after.scope.find((s) => s.controlId === 'CMN-P2P-02')!.rationale.startsWith('included: ')).toBe(false);
    expect(after.memos.scope.calls.some((c) => c.question === 'Why CMN-P2P-02 is in scope')).toBe(false);
  });

  it('refuses exclusion reasons for areas that are not excluded, and replaces a statement that omits an excluded area', async () => {
    const model = new FakeProvider((req) => {
      const a = scopeAnswerFrom(req, {});
      return {
        items: a.items.map((i) => (i.controlId.startsWith('CMN-TRS') ? { ...i, included: false } : i)),
        exclusions: [{ processArea: 'Nowhere', reason: 'x' }, { processArea: 'Procure to pay', reason: 'y' }],
        coverageStatement: 'Everything is fine.',
      };
    });
    const svc = new AuditService(await testDb(), registry, model, LENIENT);
    const e = await svc.createEngagement(COMMON, auditor);
    const { bundle, engagement: after } = await svc.runModule(e.id, 'scope', auditor);
    expect(bundle.qaActions.filter((a) => a.gate === 'judgment-bounds').map((a) => a.target).sort()).toEqual(['Nowhere', 'Procure to pay']);
    expect(after.coverage?.excluded.map((x) => x.processArea)).toEqual(['Treasury & commodity risk']);
    expect(after.coverage?.statement).toMatch(/library controls across/);
    expect(after.coverage?.statement).toContain('Treasury & commodity risk');
  });
});
