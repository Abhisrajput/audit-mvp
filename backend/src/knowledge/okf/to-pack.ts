import type { Clause, ConceptTrust, ContentPack, Control, EvalCase } from '../../engine/types';
import type { Bundle, Concept } from './bundle';
import { parseControlBody } from './control-body';
import type { ClauseAttrs, ControlAttrs, EvalCaseAttrs, PackAttrs } from './schema';

// A bundle in the engine's ContentPack shape. Deprecated concepts stay in the graph but leave the pack.
// Clauses, controls and eval cases are ordered by concept id so every source of a registry agrees.

export function conceptTrust(c: Concept): ConceptTrust {
  return {
    nodeId: c.nodeId,
    verifiedBy: c.verified?.by ?? null,
    verifiedRole: c.verified?.role ?? null,
    verifiedAt: c.verified?.at ?? null,
    status: c.status,
    staleAfter: c.staleAfter,
    sourcePath: c.path,
  };
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function bundleToContentPack(b: Bundle): ContentPack {
  const pack = b.concepts.find((c) => c.type === 'pack')!;
  const p = pack.attrs as PackAttrs;
  const active = (type: Concept['type']) => b.concepts.filter((c) => c.type === type && c.status === 'active');

  const clauses: Clause[] = active('clause').map((c) => {
    const a = c.attrs as ClauseAttrs;
    return {
      id: a.id, regulation: a.regulation, ref: a.ref, title: c.title, summary: c.description ?? '', tags: c.tags,
      reviewStatus: c.verified ? 'expert-reviewed' : 'draft',
      ...(c.externalSources[0] ? { sourceUrl: c.externalSources[0] } : {}),
      trust: conceptTrust(c),
    };
  });

  const controls: Control[] = active('control').map((c) => {
    const a = c.attrs as ControlAttrs;
    const body = parseControlBody(c.body, c.path);
    return {
      id: a.id, title: c.title, processArea: a.process_area, objective: body.objective, risk: a.risk, riskRating: a.risk_rating,
      type: a.type, nature: a.nature, frequency: a.frequency, clauseRefs: [...a.clause_refs], testOfDesign: body.testOfDesign,
      testOfEffectiveness: body.testOfEffectiveness, evidenceExpected: [...a.evidence_expected], checklist: body.checklist,
      recommendation: body.recommendation, keywords: c.tags, trust: conceptTrust(c),
    };
  });

  const evalCases: EvalCase[] = active('eval_case').map((c) => {
    const a = c.attrs as EvalCaseAttrs;
    return { id: a.id, kind: a.kind, description: c.description ?? '', input: a.input, expected: a.expected };
  });

  return {
    id: p.id, name: pack.title, version: p.version, vertical: p.vertical, description: pack.description ?? '',
    disclaimer: pack.body, sources: p.citation_prefixes,
    clauses: clauses.sort(byId), controls: controls.sort(byId), evalCases: evalCases.sort(byId),
  };
}
