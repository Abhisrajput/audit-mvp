import { z } from 'zod';
import { pct, reportMemo, sameMemo } from '../../judgment/memo';
import { approvedFindingsFingerprint, opinionBasisText, opinionOf, OPINIONS, parseOpinionDirective, worsens } from '../../judgment/opinion';
import { METHODOLOGY_PACK_ID } from '../../judgment/standards';
import type { AuditModule } from '../module';
import { trustProblems } from '../trust';
import type { AuditReport, Engagement, Finding, FindingResponse, JudgmentCall, JudgmentMemo, Opinion, ReportOpinion, ResponseKind, SignOff, TestConclusion } from '../types';
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

const RESPONSE_LABEL: Record<ResponseKind, string> = { agree: 'Agree', partially_agree: 'Partially agree', disagree: 'Disagree' };

/** Management's latest response to a finding, as the report prints it (spec §3.3). */
export function responseLine(r: FindingResponse | undefined): string {
  if (!r) return '- **Management response:** No response recorded';
  return `- **Management response:** ${RESPONSE_LABEL[r.response]} — owner ${r.owner}, due ${r.dueDate ?? 'no date'} (recorded ${utc(r.recordedAt)}): ${r.actionPlan}`;
}

const OPINION_LABEL: Record<Opinion, string> = { satisfactory: 'Satisfactory', needs_improvement: 'Needs improvement', unsatisfactory: 'Unsatisfactory' };

/** Links as `filename (p. N)` (the id when the file is unknown), then the free-text references. */
function evidenceText(f: Finding, names: ReadonlyMap<string, { filename: string }>): string {
  const links = (f.evidence ?? []).map((l) => `${names.get(l.documentId)?.filename ?? l.documentId}${l.page !== undefined ? ` (p. ${l.page})` : ''}`);
  return [...links, ...f.evidenceRefs].join(', ');
}

function findingMd(f: Finding, n: number, response: FindingResponse | undefined, names: ReadonlyMap<string, { filename: string }>): string {
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
    responseLine(response),
    ``,
    `_Citations:_ ${f.citations.map((c) => `${c.regulation} ${c.ref}`).join('; ')} &nbsp; _Evidence:_ ${evidenceText(f, names)} &nbsp; _Trail:_ ${f.bundleId}`,
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

/** The model's draft: the summary, and optionally an opinion (one step worse than the rule at most) with its rationale and a basis narrative (spec §5.6). */
const ModelReport = z.object({
  executiveSummary: z.string(),
  opinion: z.enum(OPINIONS as [Opinion, ...Opinion[]]).optional(),
  opinionRationale: z.string().optional(),
  basisNarrative: z.string().optional(),
});

const NARRATIVE_NOTE = '_(Narrative drafted by AI; reviewed at report sign-off.)_';

/** Report Writer: compiles approved findings into the audit report, with the engagement opinion and its memo. */
export const reportModule: AuditModule<Omit<AuditReport, 'bundleId'> & { memo: JudgmentMemo }> = {
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

    // The engagement opinion (spec §5.6): the rule over approved findings; a CAE's signed rejection may set it either
    // way, and that choice holds while the approved findings stay the same; otherwise the model may only worsen it by one step.
    const rule = opinionOf(e.findings);
    const fingerprint = approvedFindingsFingerprint(e.findings);
    const responses = e.responses ?? {};
    const tolerances = Object.values(e.tolerances ?? {}).filter((t) => t.rate > 0);
    const rowsTested = Object.values(e.testResults).filter((r) => r.conclusion !== 'Not tested').length;
    const fixedBasis = opinionBasisText({
      approved, coverage: e.coverage ?? null, rowsTested, rowsInScope: e.rcm.length,
      areasCovered: [...new Set(e.rcm.map((r) => r.processArea))],
    });
    const notes: string[] = [];
    let opinion: ReportOpinion | null = null;
    let source: JudgmentCall['source'] = 'rules';

    // (a) A directive counts only with the rejection's signature; the instruction text alone can come from QA or a model.
    const instruction = typeof ctx.input.reworkInstruction === 'string' ? ctx.input.reworkInstruction.trim() : '';
    const signatureId = typeof ctx.input.reworkSignatureId === 'string' ? ctx.input.reworkSignatureId : null;
    const directive = instruction ? parseOpinionDirective(instruction) : null;
    if (directive && !signatureId) {
      notes.push('The redraft instruction names an opinion but carries no gate signature, so it was ignored.');
    } else if (directive && 'problem' in directive) {
      notes.push(directive.problem);
    } else if (directive && signatureId) {
      opinion = {
        rating: directive.opinion,
        // Quoted on one line, so a multi-line comment cannot open a heading of its own in the hashed markdown.
        basis: `${fixedBasis}\n\nSet by the Chief Audit Executive on rejecting the report gate (signature ${signatureId}): "${instruction.replace(/\s+/g, ' ')}"`,
        setBy: signatureId,
        findingsFingerprint: fingerprint,
      };
      source = 'person';
    }
    // (b) A CAE-set opinion survives a redraft while the approved findings are the ones it was set over.
    const carried = e.report?.opinion?.setBy ? e.report.opinion : null;
    if (!opinion && carried) {
      if (carried.findingsFingerprint === fingerprint) {
        opinion = carried;
        source = 'person';
      } else {
        notes.push(`The opinion ${carried.rating} set by signature ${carried.setBy} was dropped because the approved findings changed; the rule's opinion applies. Reject again to set it.`);
      }
    }

    let summary = defaultSummary(e, approved);
    const count = (r: Finding['rating']) => approved.filter((f) => f.rating === r).length;
    const drafted = await askModel(
      ctx,
      SYSTEM_PREAMBLE,
      `Write a 3-5 sentence executive summary for the audit committee. Use only these facts.\n` +
        `You may state a worse opinion than ${rule} with a one-sentence rationale; never a better one.\n` +
        asData('workpaper:approved-findings', {
          engagement: { name: e.name, entity: e.entity, site: e.site, period: `${e.periodFrom} to ${e.periodTo}`, scope: e.scopeStatement },
          controlsInScope: e.rcm.length,
          findings: approved.map((f) => ({ title: f.title, rating: f.rating, effect: f.effect })),
          ruleOpinion: rule,
          // The opinion the report will state: a CAE's directive or carried opinion where one applies, else the rule.
          reportOpinion: opinion?.rating ?? rule,
          approvedFindings: { total: approved.length, High: count('High'), Medium: count('Medium'), Low: count('Low') },
          controlsTested: rowsTested,
        }),
      ModelReport,
    );
    if (drafted?.executiveSummary) summary = `${drafted.executiveSummary}\n\n_(Executive summary drafted by AI from approved findings; reviewed at report sign-off.)_`;
    const narrative = drafted?.basisNarrative?.trim();
    const ruleBasis = narrative ? `${fixedBasis}\n\n${narrative} ${NARRATIVE_NOTE}` : fixedBasis;

    // (c) The model may worsen the rule's opinion by exactly one step, with a rationale. A directive or a carried opinion is final.
    const proposed = drafted?.opinion;
    if (!opinion && proposed && proposed !== rule) {
      const rationale = drafted?.opinionRationale?.trim() ?? '';
      if (worsens(rule, proposed) && OPINIONS.indexOf(proposed) === OPINIONS.indexOf(rule) + 1 && rationale) {
        opinion = { rating: proposed, basis: ruleBasis, rationale, findingsFingerprint: fingerprint };
        source = 'model';
      } else {
        const detail = `Model proposed the opinion ${proposed} where the rule gives ${rule}; only an opinion exactly one step worse, with a rationale, is accepted, so the rule's opinion stands`;
        ctx.gate({ gate: 'judgment-bounds', outcome: 'fail', target: 'report', detail, action: 'blocked' });
        notes.push(`${detail}.`);
      }
    }
    // (d) Otherwise the rule.
    if (!opinion) opinion = { rating: rule, basis: ruleBasis, findingsFingerprint: fingerprint };

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

    // The methodology pack's verification status, named once in the trailer (spec §4).
    const iiaPack = ctx.registry.packs.get(METHODOLOGY_PACK_ID);
    const iia = { verified: iiaPack ? iiaPack.clauses.filter((c) => trustProblems(c.trust).length === 0).length : 0, total: iiaPack?.clauses.length ?? 0 };
    const methodology = iiaPack
      ? `Methodology: ${iiaPack.name} v${iiaPack.version}, ${iia.verified} of ${iia.total} clause summaries verified by a reviewer.`
      : 'Methodology: no methodology pack is loaded.';

    const opinionMd = [
      `**${OPINION_LABEL[opinion.rating]}**`,
      ``,
      opinion.basis,
      ...(opinion.rationale ? [``, `_Worsened from the rule's ${rule} by AI: ${opinion.rationale} Reviewed at report sign-off._`] : []),
    ].join('\n');

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
      `## 1. Overall opinion`,
      ``,
      opinionMd,
      ``,
      `## 2. Executive summary`,
      ``,
      summary,
      ``,
      `## 3. Scope and approach`,
      ``,
      e.scopeStatement,
      ``,
      `${e.rcm.length} controls were placed in scope from the control library. Each control was assessed for design (TOD) and, where designed adequately, tested for operating effectiveness (TOE) on a sample sized by frequency and risk.`,
      ``,
      `| Conclusion | Controls |`,
      `|---|---|`,
      ...Object.entries(counts).map(([k, v]) => `| ${k} | ${v} |`),
      ``,
      ...(e.coverage ? [e.coverage.statement, ``] : []),
      `## 4. Findings`,
      ``,
      approved.length ? approved.map((f, i) => findingMd(f, i + 1, responses[f.id], ctx.documentNames)).join('\n') : '_No approved findings._',
      ``,
      `## 5. Controls tested`,
      ``,
      `| Control | Process area | Risk | Sample | Conclusion |`,
      `|---|---|---|---|---|`,
      ...e.rcm.map((r) => `| ${r.controlId} ${r.control} | ${r.processArea} | ${r.riskRating} | ${e.testInputs[r.id]?.sampleTested ?? 0}/${r.sampleSize} | ${e.testResults[r.id]?.conclusion ?? 'Not tested'} |`),
      ``,
      tolerances.length
        ? `## 6. Tolerances applied\n\n| Control | Tolerance | Set by | At |\n|---|---|---|---|\n${tolerances.map((t) => `| ${t.controlId} | ${pct(t.rate)} | ${t.recordedBy} | ${utc(t.recordedAt)} |`).join('\n')}\n`
        : '',
      excluded.length ? `## 7. Excluded from this report\n\n${excluded.map((f) => `- ${f.id} ${f.title} — status ${f.status}`).join('\n')}\n` : '',
      `---`,
      `Cited sources not yet verified by a reviewer or due for re-review (${notCitable.size}): ${[...notCitable].join(', ') || 'none'}.`,
      methodology,
    ].join('\n');

    const memo = reportMemo({
      opinion, ruleOpinion: rule, source, approved, responses, coverage: e.coverage ?? null, tolerances, iia, notes,
      producedAt: new Date().toISOString(),
    });
    return { generatedAt: new Date().toISOString(), markdown: md, includedFindingIds: approved.map((f) => f.id), excludedFindingIds: excluded.map((f) => f.id), opinion, memo };
  },

  apply(e, output, bundleId) {
    const { memo, ...report } = output;
    e.report = { ...report, bundleId };
    // A regeneration that decides nothing new keeps the old memo, so the workpaper hash moves only with the report.
    const before = e.memos?.report;
    e.memos = { ...e.memos, report: sameMemo(before, memo) ? before! : memo };
    e.stage = 'reporting';
  },
};
