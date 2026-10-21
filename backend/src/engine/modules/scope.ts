import { z } from 'zod';
import { tokenize } from '../grounding';
import type { AuditModule } from '../module';
import { toCitation } from '../qa';
import type { Citation, ScopeItem } from '../types';
import { asData } from '../llm/prompt';
import { askModel, SYSTEM_PREAMBLE } from './llm-step';

const ModelScope = z.object({
  items: z.array(z.object({ controlId: z.string(), included: z.boolean(), rationale: z.string() })),
});

/** Risk & Scope Analysis: proposes which library controls are in scope for this audit. */
export const scopeModule: AuditModule<ScopeItem[]> = {
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
      const included = rel >= 0.3 || (c.riskRating === 'High' && rel >= 0.25);
      return {
        controlId: c.id,
        packId: c.packId,
        processArea: c.processArea,
        risk: c.risk,
        inherentRisk: c.riskRating,
        assessedRisk: c.riskRating,
        riskFactors: [],
        relevance: rel,
        rationale: matched.length
          ? `Scope mentions ${matched.slice(0, 5).join(', ')}; inherent risk ${c.riskRating}.`
          : `No direct match to the scope statement; inherent risk ${c.riskRating}.`,
        citations: c.clauseRefs.map((r) => toCitation(ctx.registry, r)).filter((x): x is Citation => !!x),
        included,
      };
    });

    const drafted = await askModel(
      ctx,
      SYSTEM_PREAMBLE,
      `Audit details and scope statement:\n${asData('workpaper:scope', { audit: e.name, auditType: e.auditType, entity: e.entity, site: e.site, scopeStatement: e.scopeStatement })}\n\n` +
        `Candidate controls (id | process area | title | inherent risk | keyword relevance):\n` +
        items.map((i) => `${i.controlId} | ${i.processArea} | ${ctx.registry.controls.get(i.controlId)!.title} | ${i.inherentRisk} | ${i.relevance}`).join('\n') +
        `\n\nFor every candidate decide whether it is in scope for this audit and give a one-sentence rationale tied to the scope statement.`,
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
        item.included = d.included;
        item.rationale = d.rationale;
      }
    }

    for (const i of items.filter((x) => !x.included && x.inherentRisk === 'High')) {
      ctx.gate({ gate: 'scope-coverage', outcome: 'warn', target: i.controlId, detail: 'High inherent-risk control proposed out of scope; confirm with the audit lead', action: 'flagged' });
    }
    items = items.sort((a, b) => Number(b.included) - Number(a.included) || b.relevance - a.relevance);
    ctx.step('result', `${items.filter((i) => i.included).length} controls proposed in scope`);
    return items;
  },

  apply(e, items) {
    e.scope = items;
    e.stage = 'planning';
  },
};
