import { rcmRowHash } from '../src/agents/subjects';
import type { Citation, Engagement, Finding, RcmRow, ScopeItem, TestInput, TestPlan, TestResult } from '../src/engine/types';

// In-memory engagements for the pure agent tests (graph, QA, drafter).

export const cite: Citation = { clauseId: 'C1', regulation: 'Reg', ref: '§1', label: 'Reg §1' };

export const scopeItem = (id: string, included = true, over: Partial<ScopeItem> = {}): ScopeItem => ({
  controlId: id, packId: 'p', processArea: 'a', risk: 'r', inherentRisk: 'Medium', assessedRisk: 'Medium', riskFactors: [], relevance: 1, rationale: 'x', citations: [cite], included, ...over,
});

export const row = (id: string, over: Partial<RcmRow> = {}): RcmRow => ({
  id, controlId: id, packId: 'p', processArea: 'a', risk: 'r', riskRating: 'Medium', control: `Control ${id}`, objective: `Objective ${id}`, type: 'Preventive',
  nature: 'Manual', frequency: 'Monthly', sampleSize: 2, testOfDesign: ['d'], testOfEffectiveness: ['t'], evidenceExpected: ['ev'], checklist: [], citations: [cite], ...over,
});

export const plan = (r: RcmRow, over: Partial<TestPlan> = {}): TestPlan => ({
  rowId: r.id, rowHash: rcmRowHash(r), attribute: 'a', population: 'p', sampleSize: r.sampleSize, selectionMethod: 'random', evidenceToRequest: ['ev'], procedure: 't', ...over,
});

export const input = (exceptions = 1): TestInput => ({ designAdequate: true, observation: 'o', evidenceRefs: ['E1'], sampleTested: 2, exceptions, updatedBy: 'auditor', updatedAt: 't' });

export const result = (rowId: string, conclusion: TestResult['conclusion'] = 'Ineffective'): TestResult => ({ rowId, conclusion, rationale: 'x', exceptionRate: 0.5, qaFlags: [] });

export const finding = (rowId: string, status: Finding['status'] = 'draft', over: Partial<Finding> = {}): Finding => ({
  id: `F-${rowId}`, rowId, controlId: rowId, title: 't', rating: 'Medium', condition: 'c', criteria: 'k', cause: 'u', effect: 'f', recommendation: 'r',
  citations: [cite], evidenceRefs: ['E1'], status, blockedReasons: [], signOffs: [], bundleId: 'RUN-1', ...over,
});

export function engagement(over: Partial<Engagement> = {}): Engagement {
  return {
    id: 'ENG-1', name: 'n', entity: 'e', site: 's', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 't', scopeStatement: 'stmt',
    packIds: ['p'], createdBy: 'auditor', createdAt: '2026-01-01T00:00:00.000Z', stage: 'planning', scope: [], rcm: [], testInputs: {},
    testResults: {}, testPlans: {}, findings: [], report: null, context: null, coverage: null, memos: {}, ...over,
  };
}
