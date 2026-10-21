import { z } from 'zod';
import type { AuditModule } from '../module';
import { rcmCitationGate, toCitation } from '../qa';
import { trustActions } from '../trust';
import type { Citation, RcmRow } from '../types';
import { asData } from '../llm/prompt';
import { askModel, SYSTEM_PREAMBLE } from './llm-step';
import { sampleSize } from '../../judgment/sampling';
export { sampleSize } from '../../judgment/sampling';

const ModelRcm = z.object({
  rows: z.array(
    z.object({
      controlId: z.string(),
      testOfDesign: z.array(z.string()),
      testOfEffectiveness: z.array(z.string()),
      checklist: z.array(z.string()),
    }),
  ),
});

/** Control & Risk Writer: turns the accepted scope into a risk & control matrix with test programmes. */
export const rcmModule: AuditModule<RcmRow[]> = {
  id: 'rcm',
  name: 'Control & Risk Writer (RCM)',
  version: '0.1.0',
  description: 'Builds the risk & control matrix: risks, controls, sample sizes, TOD/TOE steps and checklists, each cited to clauses.',
  precondition: (e) => (e.scope.some((s) => s.included) ? null : 'Run Risk & Scope and include at least one control first'),

  async run(ctx) {
    const e = ctx.engagement;
    const rows: RcmRow[] = e.scope
      .filter((s) => s.included)
      .map((s) => {
        const c = ctx.registry.controls.get(s.controlId)!;
        return {
          id: c.id, // one row per control, so field work survives a regeneration
          controlId: c.id,
          packId: c.packId,
          processArea: c.processArea,
          risk: c.risk,
          riskRating: c.riskRating,
          control: c.title,
          objective: c.objective,
          type: c.type,
          nature: c.nature,
          frequency: c.frequency,
          sampleSize: sampleSize(c.frequency, c.riskRating),
          testOfDesign: [...c.testOfDesign],
          testOfEffectiveness: [...c.testOfEffectiveness],
          evidenceExpected: [...c.evidenceExpected],
          checklist: [...c.checklist],
          citations: c.clauseRefs.map((r) => toCitation(ctx.registry, r)).filter((x): x is Citation => !!x),
        };
      });
    ctx.step('build', `${rows.length} RCM rows from the control library`);
    rows.forEach((r) => ctx.retrieveClauses(`${r.control} ${r.risk}`, 3));

    const drafted = await askModel(
      ctx,
      SYSTEM_PREAMBLE,
      `Tailor these library test programmes to the client context. Keep each step concrete and testable; do not add regulatory references.\n` +
        `Client context:\n${asData('workpaper:engagement', { entity: e.entity, site: e.site, periodFrom: e.periodFrom, periodTo: e.periodTo, scopeStatement: e.scopeStatement })}\n\n` +
        asData('library:test-programmes', rows.map((r) => ({ controlId: r.controlId, control: r.control, testOfDesign: r.testOfDesign, testOfEffectiveness: r.testOfEffectiveness, checklist: r.checklist }))),
      ModelRcm,
    );
    if (drafted) {
      for (const d of drafted.rows) {
        const row = rows.find((r) => r.controlId === d.controlId);
        if (!row) continue;
        if (d.testOfDesign.length) row.testOfDesign = d.testOfDesign;
        if (d.testOfEffectiveness.length) row.testOfEffectiveness = d.testOfEffectiveness;
        if (d.checklist.length) row.checklist = d.checklist;
      }
      ctx.gate({ gate: 'citation-lock', outcome: 'pass', target: 'rcm', detail: 'Model tailored test steps only; citations and sample sizes come from the library', action: 'none' });
    }

    const released: RcmRow[] = [];
    for (const r of rows) {
      const action = rcmCitationGate(ctx.registry, r);
      ctx.gate(action);
      ctx.gate(...trustActions(ctx.registry, r.id, { clauseIds: r.citations.map((c) => c.clauseId), controlId: r.controlId }, ctx.policy));
      if (action.action !== 'blocked') released.push(r);
    }
    return released;
  },

  apply(e, rows) {
    e.rcm = rows;
    // Keep field results only for rows that survived regeneration.
    const keep = new Set(rows.map((r) => r.id));
    e.testInputs = Object.fromEntries(Object.entries(e.testInputs).filter(([id]) => keep.has(id)));
    e.testResults = {};
    e.stage = 'rcm';
  },
};
