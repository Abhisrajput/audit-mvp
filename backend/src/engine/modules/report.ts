import { z } from 'zod';
import type { AuditModule } from '../module';
import { trustProblems } from '../trust';
import type { AuditReport, Engagement, Finding, SignOff, TestConclusion } from '../types';
import { asData } from '../llm/prompt';
import { askModel, SYSTEM_PREAMBLE } from './llm-step';

const ORDER = { High: 0, Medium: 1, Low: 2 } as const;

/** 'YYYY-MM-DD HH:MM UTC' */
function utc(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/**
 * Signature manifestation (21 CFR 11.50): meaning, printed name, role, time and how the signer re-authenticated.
 * `broken` and `legacy` are set by the service from the signatures table before this module runs; a sign-off
 * without a signature id is never shown as re-authenticated.
 */
export function signatureText(s: SignOff): string {
  const legacy = s.legacy || !s.signatureId;
  const how = legacy || !s.reauth || s.reauth.method === 'none'
    ? ', not re-authenticated'
    : s.reauth.method === 'oidc' ? ', re-authenticated via identity provider' : ', re-authenticated by demo confirmation';
  const status = s.broken ? ' — SIGNATURE BROKEN: does not match its signature record' : legacy ? ' (legacy signature, before Part 11)' : '';
  return `${s.meaning} by ${s.userName} (${s.role}) at ${utc(s.at)}${how}${s.signatureId ? ` [${s.signatureId}]` : ''}${status}`;
}

function findingMd(f: Finding, n: number): string {
  const signedBy = f.signOffs.map(signatureText).join('; ');
  return [
    `### ${n}. ${f.title}`,
    ``,
    `**Rating:** ${f.rating} &nbsp; **Control:** ${f.controlId} &nbsp; **Sign-off:** ${signedBy || 'none'}`,
    ``,
    ...(f.signatureIssues?.length ? [`**Signature issues:** ${f.signatureIssues.join('; ')}`, ``] : []),
    `- **Condition:** ${f.condition}`,
    `- **Criteria:** ${f.criteria}`,
    `- **Cause:** ${f.cause}`,
    `- **Effect / risk:** ${f.effect}`,
    `- **Recommendation:** ${f.recommendation}`,
    ``,
    `_Citations:_ ${f.citations.map((c) => `${c.regulation} ${c.ref}`).join('; ')} &nbsp; _Evidence:_ ${f.evidenceRefs.join(', ')} &nbsp; _Trail:_ ${f.bundleId}`,
    ``,
  ].join('\n');
}

export function defaultSummary(e: Engagement, approved: Finding[]): string {
  const tested = Object.values(e.testResults).filter((r) => r.conclusion !== 'Not tested').length;
  const byRating = (r: string) => approved.filter((f) => f.rating === r).length;
  if (!approved.length) {
    return `We tested ${tested} of ${e.rcm.length} in-scope controls. No approved findings are reported for this engagement.`;
  }
  return `We tested ${tested} of ${e.rcm.length} in-scope controls and report ${approved.length} approved finding(s): ${byRating('High')} High, ${byRating('Medium')} Medium and ${byRating('Low')} Low. Management actions are recommended for each finding below.`;
}

const ModelSummary = z.object({ executiveSummary: z.string() });

/** Report Writer: compiles approved findings into the audit report. */
export const reportModule: AuditModule<Omit<AuditReport, 'bundleId'>> = {
  id: 'report',
  name: 'Report Writer',
  version: '0.1.0',
  description: 'Compiles the report from approved findings only; unapproved or blocked findings are listed as excluded.',
  precondition: (e) => (e.rcm.length ? null : 'Build the RCM first'),

  async run(ctx) {
    const e = ctx.engagement;
    const approved = e.findings.filter((f) => f.status === 'approved').sort((a, b) => ORDER[a.rating] - ORDER[b.rating]);
    const excluded = e.findings.filter((f) => f.status !== 'approved');
    for (const f of excluded) {
      ctx.gate({ gate: 'release', outcome: f.status === 'blocked' ? 'fail' : 'warn', target: f.id, detail: `Finding status "${f.status}" — excluded from report until approved`, action: 'blocked' });
    }

    let summary = defaultSummary(e, approved);
    const drafted = await askModel(
      ctx,
      SYSTEM_PREAMBLE,
      `Write a 3-5 sentence executive summary for the audit committee. Use only these facts.\n` +
        asData('workpaper:approved-findings', { engagement: { name: e.name, entity: e.entity, site: e.site, period: `${e.periodFrom} to ${e.periodTo}`, scope: e.scopeStatement }, controlsInScope: e.rcm.length, findings: approved.map((f) => ({ title: f.title, rating: f.rating, effect: f.effect })) }),
      ModelSummary,
    );
    if (drafted?.executiveSummary) summary = `${drafted.executiveSummary}\n\n_(Executive summary drafted by AI from approved findings; reviewed at report sign-off.)_`;

    const counts: Record<TestConclusion, number> = { Effective: 0, Ineffective: 0, 'Design deficient': 0, 'Not tested': 0 };
    e.rcm.forEach((r) => counts[e.testResults[r.id]?.conclusion ?? 'Not tested']++);
    const packs = e.packIds.map((id) => `${ctx.registry.get(id).name} v${ctx.registry.get(id).version}`).join(', ');
    // Every cited source that can't be cited under the trust rules (REQ-22): each row's and each reported finding's
    // clauses and control. A finding may cite clauses outside its row (Gap Writer's grounding hits, human edits).
    const notCitable = new Set<string>();
    const cited = [
      ...e.rcm.map((r) => ({ clauseIds: r.citations.map((c) => c.clauseId), controlId: r.controlId })),
      ...approved.map((f) => ({ clauseIds: f.citations.map((c) => c.clauseId), controlId: f.controlId })),
    ];
    for (const { clauseIds, controlId } of cited) {
      clauseIds.forEach((id) => trustProblems(ctx.registry.clauses.get(id)?.trust).length && notCitable.add(id));
      if (trustProblems(ctx.registry.controls.get(controlId)?.trust).length) notCitable.add(controlId);
    }

    const md = [
      `# Internal Audit Report — ${e.name}`,
      ``,
      `| Field | Detail |`,
      `|---|---|`,
      `| Entity / site | ${e.entity} — ${e.site} |`,
      `| Audit type | ${e.auditType} |`,
      `| Period | ${e.periodFrom} to ${e.periodTo} |`,
      `| Content packs | ${packs} |`,
      `| Generated | ${new Date().toISOString()} |`,
      ``,
      `## 1. Executive summary`,
      ``,
      summary,
      ``,
      `## 2. Scope and approach`,
      ``,
      e.scopeStatement,
      ``,
      `${e.rcm.length} controls were placed in scope from the control library. Each control was assessed for design (TOD) and, where designed adequately, tested for operating effectiveness (TOE) on a sample sized by frequency and risk.`,
      ``,
      `| Conclusion | Controls |`,
      `|---|---|`,
      ...Object.entries(counts).map(([k, v]) => `| ${k} | ${v} |`),
      ``,
      `## 3. Findings`,
      ``,
      approved.length ? approved.map((f, i) => findingMd(f, i + 1)).join('\n') : '_No approved findings._',
      ``,
      `## 4. Controls tested`,
      ``,
      `| Control | Process area | Risk | Sample | Conclusion |`,
      `|---|---|---|---|---|`,
      ...e.rcm.map((r) => `| ${r.controlId} ${r.control} | ${r.processArea} | ${r.riskRating} | ${e.testInputs[r.id]?.sampleTested ?? 0}/${r.sampleSize} | ${e.testResults[r.id]?.conclusion ?? 'Not tested'} |`),
      ``,
      excluded.length ? `## 5. Excluded from this report\n\n${excluded.map((f) => `- ${f.id} ${f.title} — status ${f.status}`).join('\n')}\n` : '',
      `---`,
      `Cited sources not yet verified by a reviewer or due for re-review (${notCitable.size}): ${[...notCitable].join(', ') || 'none'}.`,
    ].join('\n');

    return { generatedAt: new Date().toISOString(), markdown: md, includedFindingIds: approved.map((f) => f.id), excludedFindingIds: excluded.map((f) => f.id) };
  },

  apply(e, report, bundleId) {
    e.report = { ...report, bundleId };
    e.stage = 'reporting';
  },
};
