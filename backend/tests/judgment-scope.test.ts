// backend/tests/judgment-scope.test.ts
import { describe, expect, it } from 'vitest';
import { rootBasis } from '../src/agents/subjects';
import { loadEngagement, saveEngagement } from '../src/db/engagement-repo';
import { sha256, canonicalJson } from '../src/engine/trail';
import type { EngagementContext } from '../src/engine/types';
import type { GenerateRequest } from '../src/engine/llm/provider';
import { workpaperContentHash } from '../src/signing/content-hash';
import { AuditService } from '../src/service';
import { auditor, FakeProvider, leasedRun, LENIENT, NEW_ENGAGEMENT, newService, registry } from './helpers';
import { testDb } from './db';

const INCIDENT: EngagementContext = { factors: [{ kind: 'incident', processAreas: ['Procure to pay'], description: 'Duplicate vendor payments found in Q1' }], background: '', updatedBy: 'auditor', updatedAt: '2026-10-21T00:00:00.000Z' };

/** Sets the context on a saved engagement. Task 7 switches this to createEngagement({ ...NEW_ENGAGEMENT, context }). */
async function withContext(svc: Awaited<ReturnType<typeof newService>>, id: string, context: EngagementContext) {
  const loaded = (await loadEngagement(svc.db.kysely, id))!;
  loaded.engagement.context = context;
  await saveEngagement(svc.db.kysely, loaded);
}

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
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    await withContext(svc, e.id, INCIDENT);
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
    const hashBefore = workpaperContentHash('scope', first.engagement);
    // The rework model tries to take Governance out of scope; the earlier decision (included) must stand.
    const flipping = new FakeProvider((req) => {
      const a = scopeAnswerFrom(req, {});
      return { items: a.items.map((i) => (i.controlId === 'CMN-GOV-01' ? { ...i, included: false } : i)) };
    });
    const second = await svc.runModuleAsAgent(e.id, 'scope', acting(), { expectedVersion: first.engagement.version!, llm: flipping, instruction: 'Take governance out' });
    const after = second.engagement;
    expect(after.scope.find((s) => s.controlId === 'CMN-GOV-01')!.included).toBe(true);
    const n = after.scope.filter((s) => s.included).length;
    expect(after.coverage?.statement).toMatch(new RegExp(`^${n} of ${after.scope.length} library controls`));
    expect(after.coverage?.excluded.some((x) => x.processArea === 'Governance')).toBe(false);
    expect(JSON.stringify(after.memos.scope.calls)).not.toMatch(/Governance: /);
    expect(workpaperContentHash('scope', after)).toBe(hashBefore);
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
