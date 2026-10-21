import { z } from 'zod';
import { namedAreas } from '../../judgment/context';
import { contextInclusions, coverageStatement, excludedAreas, includedByRule, statementCoversAll, type Candidate } from '../../judgment/coverage';
import { scopeMemo } from '../../judgment/memo';
import { acceptsOverlay, areaRisk, assessControl, RANK } from '../../judgment/risk-assessment';
import { tokenize } from '../grounding';
import type { AuditModule } from '../module';
import { toCitation } from '../qa';
import type { Citation, Coverage, JudgmentMemo, ScopeItem } from '../types';
import { asData } from '../llm/prompt';
import { keepScopeDecisions } from '../../agents/rails';
import { canonicalJson } from '../trail';
import { askModel, SYSTEM_PREAMBLE } from './llm-step';

const ModelScope = z.object({
  items: z.array(z.object({ controlId: z.string(), included: z.boolean(), rationale: z.string(), assessedRisk: z.enum(['High', 'Medium', 'Low']).optional() })),
  coverageStatement: z.string().optional(),
  exclusions: z.array(z.object({ processArea: z.string(), reason: z.string() })).optional(),
});

/** What the module produces: the proposed items, the coverage statement and the judgment memo. */
export interface ScopeOutput { items: ScopeItem[]; coverage: Coverage; memo: JudgmentMemo }

/** Risk & Scope Analysis: proposes which library controls are in scope for this audit. */
export const scopeModule: AuditModule<ScopeOutput> = {
  id: 'scope',
  name: 'Risk & Scope Analysis',
  version: '0.1.0',
  description: 'Ranks the control library against the scope statement and proposes the in-scope risks.',
  precondition: (e) => (e.scopeStatement.trim() ? null : 'Engagement has no scope statement'),

  async run(ctx) {
    const e = ctx.engagement;
    const query = `${e.auditType} ${e.scopeStatement}`;
    ctx.retrieveClauses(query, 10);

    const candidates = ctx.registry.controlsFor(e.packIds);
    const ids = new Set(candidates.map((c) => c.id));
    const hits = ctx.grounding.controls.search(query, candidates.length, (id) => ids.has(id));
    const top = hits[0]?.score ?? 1;
    const relevance = new Map(hits.map((h) => [h.clauseId, Math.round((h.score / top) * 100) / 100]));
    ctx.step('rank', `${hits.length}/${candidates.length} library controls matched the scope statement`);

    const queryTokens = new Set(tokenize(query));
    let items: ScopeItem[] = candidates.map((c) => {
      const rel = relevance.get(c.id) ?? 0;
      const words = `${c.title} ${c.processArea} ${c.keywords.join(' ')}`.toLowerCase().split(/[^a-z0-9]+/);
      const matched = [...new Set(words.filter((w) => tokenize(w).some((t) => queryTokens.has(t))))];
      const { assessedRisk, riskFactors } = assessControl(c, e.context);
      const included = includedByRule(assessedRisk, rel);
      return {
        controlId: c.id,
        packId: c.packId,
        processArea: c.processArea,
        risk: c.risk,
        inherentRisk: c.riskRating,
        assessedRisk,
        riskFactors,
        relevance: rel,
        rationale: matched.length
          ? `Scope mentions ${matched.slice(0, 5).join(', ')}; inherent risk ${c.riskRating}.`
          : `No direct match to the scope statement; inherent risk ${c.riskRating}.`,
        citations: c.clauseRefs.map((r) => toCitation(ctx.registry, r)).filter((x): x is Citation => !!x),
        included,
      };
    });

    // Context can pull in the best control of a touched area that has nothing above the threshold (spec §5.2).
    const asCandidates = (): Candidate[] => items.map((i) => ({ controlId: i.controlId, processArea: i.processArea, inherentRisk: i.inherentRisk, assessedRisk: i.assessedRisk, relevance: i.relevance }));
    const ruleCandidates = asCandidates();
    const contextIncluded = contextInclusions(ruleCandidates, e.context);
    for (const i of items) {
      const why = contextIncluded.get(i.controlId);
      if (why !== undefined) { i.included = true; i.rationale = `included: ${why}`; }
    }
    const areaRiskBefore = new Map([...new Set(items.map((i) => i.processArea))].map((area) => [area, areaRisk(items.filter((i) => i.processArea === area))]));

    const modelNotes: string[] = [];
    const overlayRationale = new Map<string, string[]>();
    const ruleRisk = new Map(items.map((i) => [i.controlId, i.assessedRisk]));
    const seen = new Set<string>();
    const drafted = await askModel(
      ctx,
      SYSTEM_PREAMBLE,
      `Audit details and scope statement:\n${asData('workpaper:scope', { audit: e.name, auditType: e.auditType, entity: e.entity, site: e.site, scopeStatement: e.scopeStatement })}\n\n` +
        (e.context ? `What the auditor recorded about the business (facts that bear on risk):\n${asData('engagement-context', { factors: e.context.factors, background: e.context.background })}\n\n` : '') +
        `Candidate controls (id | process area | title | assessed risk | keyword relevance):\n` +
        items.map((i) => `${i.controlId} | ${i.processArea} | ${ctx.registry.controls.get(i.controlId)!.title} | ${i.assessedRisk} | ${i.relevance}` + (i.riskFactors.length ? `\n  risk factors: ${i.riskFactors.join('; ')}` : '')).join('\n') +
        `\n\nFor every candidate decide whether it is in scope for this audit and give a one-sentence rationale tied to the scope statement.` +
        `\nOptionally, set assessedRisk on a candidate if the facts above justify a higher risk. You may raise it by one step only (Low to Medium, or Medium to High), never lower it, and you must say why in the rationale.` +
        `\nOptionally, give coverageStatement (one sentence that names every process area left out of scope) and exclusions (a reason for each process area you leave out).`,
      ModelScope,
    );
    if (drafted) {
      const byId = new Map(items.map((i) => [i.controlId, i]));
      for (const d of drafted.items) {
        const item = byId.get(d.controlId);
        if (!item) {
          ctx.gate({ gate: 'library-only', outcome: 'fail', target: d.controlId, detail: 'Model proposed a control that is not in the library; ignored', action: 'blocked' });
          continue;
        }
        if (seen.has(d.controlId)) {
          ctx.gate({ gate: 'judgment-bounds', outcome: 'fail', target: d.controlId, detail: 'Model listed the control twice; the repeat is ignored', action: 'blocked' });
          continue;
        }
        seen.add(d.controlId);
        // The model may raise the rule rating one step; anything else is refused and the rule value stands.
        const rule = ruleRisk.get(d.controlId)!;
        if (d.assessedRisk && d.assessedRisk !== rule) {
          if (acceptsOverlay(rule, d.assessedRisk)) {
            modelNotes.push(`Model raised the risk of ${item.controlId} from ${rule} to ${d.assessedRisk}: ${d.rationale}`);
            overlayRationale.set(item.processArea, [...(overlayRationale.get(item.processArea) ?? []), d.rationale]);
            item.assessedRisk = d.assessedRisk;
          } else {
            ctx.gate({ gate: 'judgment-bounds', outcome: 'fail', target: item.controlId, detail: `Model proposed ${d.assessedRisk} for a control the rules rate ${rule}; only a one-step raise is allowed, so the rule value stands`, action: 'blocked' });
          }
        }
        item.included = d.included;
        // A context inclusion keeps the rules' rationale as long as the model leaves the control in. Model text never
        // carries the rules' "included: " marker.
        if (!(d.included && contextIncluded.has(item.controlId))) item.rationale = d.rationale.replace(/^\s*included:\s*/i, '');
      }
    }

    // On an agent rework, people's earlier in/out decisions win. Pin them now, so the coverage, the memo and the hash
    // are built from the scope that will be saved.
    if (ctx.input.keepDecisions === true && e.scope.length) keepScopeDecisions(e.scope, items);

    // The model's raise counts for the memo only where it moved the area's risk.
    const modelRaises = [...overlayRationale].filter(([area]) => RANK[areaRisk(items.filter((i) => i.processArea === area))] > RANK[areaRiskBefore.get(area)!])
      .map(([processArea, rationales]) => ({ processArea, rationale: rationales.join(' ') }));

    const includedIds = new Set(items.filter((i) => i.included).map((i) => i.controlId));
    const candidatesNow = asCandidates();
    const excluded = excludedAreas(candidatesNow, includedIds, e.scopeStatement);
    for (const x of drafted?.exclusions ?? []) {
      const area = excluded.find((a) => a.processArea === x.processArea);
      if (area) {
        area.reason = x.reason;
        modelNotes.push(`Model gave the reason ${x.processArea} is out of scope: ${x.reason}`);
      } else {
        ctx.gate({ gate: 'judgment-bounds', outcome: 'fail', target: x.processArea, detail: 'Model gave an exclusion reason for an area that is not excluded; ignored', action: 'blocked' });
      }
    }
    let statement = coverageStatement(candidatesNow, includedIds, excluded);
    if (drafted?.coverageStatement && statementCoversAll(drafted.coverageStatement, excluded)) {
      statement = drafted.coverageStatement;
      modelNotes.push('The coverage statement was written by the model.');
    }
    const coverage: Coverage = { excluded, statement };

    for (const i of items.filter((x) => !x.included && x.inherentRisk === 'High')) {
      ctx.gate({ gate: 'scope-coverage', outcome: 'warn', target: i.controlId, detail: 'High inherent-risk control proposed out of scope; confirm with the audit lead', action: 'flagged' });
    }
    items = items.sort((a, b) => Number(b.included) - Number(a.included) || b.relevance - a.relevance);
    ctx.step('result', `${items.filter((i) => i.included).length} controls proposed in scope`);
    const memo = scopeMemo({
      items, coverage, context: e.context, modelNotes, modelRaises, contextIncluded: [...contextIncluded.keys()], producedAt: new Date().toISOString(),
      unknownAreas: namedAreas(e.context).filter((area) => !candidatesNow.some((c) => c.processArea === area)),
    });
    return { items, coverage, memo };
  },

  apply(e, output) {
    e.scope = output.items;
    e.coverage = output.coverage;
    // A redraft that decides nothing new keeps the old memo, time stamp included, so the workpaper hash does not move
    // and the agent can tell that the redraft changed nothing.
    const before = e.memos?.scope;
    const same = before && canonicalJson({ ...before, producedAt: '' }) === canonicalJson({ ...output.memo, producedAt: '' });
    e.memos = { ...e.memos, scope: same ? before : output.memo };
    e.stage = 'planning';
  },
};
