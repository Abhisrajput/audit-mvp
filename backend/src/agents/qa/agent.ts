import { z } from 'zod';
import { asData, DATA_RULES } from '../../engine/llm/prompt';
import { MalformedOutputError } from '../../engine/llm/provider';
import type { Engagement } from '../../engine/types';
import { ModelUnavailableError, type AgentModels } from '../llm/models';
import type { GraphNode, KnowledgeHit, Neighbourhood } from '../tools/knowledge';
import type { LookupRequest, LookupResult, Toolbox } from '../tools/toolbox';
import type { QaIssue, QaReport } from '../types';
import { reviewSubject, type QaChecks } from './deterministic';
import { CHALLENGE_CRITERIA, normalise, RUBRICS, rubricKind, subjectContent, type RubricCriterion } from './rubric';

// The QA agent (spec §5.5). The automatic checks always run, and their issues and score always stand. A model then
// scores the rubric (review) or hunts for problems (challenge), and may add issues and lower the score. It can never
// remove an issue or raise the score, so text that takes over the model can only push work back to a redraft or a person.

export const QA_AGENT_VERSION = 'qa-llm-1';

export const REVIEW_SYSTEM = `You review internal-audit workpapers before a person signs them. Score every criterion listed from 0 (not met) to 4 (fully met), with a short note, and list the issues you find. Tag an issue blocking only when the workpaper must not reach its signer as it is. You review; you never approve or sign anything, and your review cannot open a gate.
${DATA_RULES}`;

export const CHALLENGE_SYSTEM = `You are the adversarial reviewer of an internal-audit workpaper. Look for claims the evidence does not support, risks or controls that are missing, and citations that do not support the text relying on them. Score every criterion listed from 0 (serious problems) to 4 (none found), with a short note, and list each problem as an issue. Tag it blocking only when the workpaper must not reach its signer as it is.
${DATA_RULES}`;

export const LOOKUP_SYSTEM = `Before you challenge an internal-audit workpaper you may look up to three things. Tools: search_knowledge (set query to the words to search for) and node_neighbourhood (set conceptId to a control or clause id, to see what it cites and what cites it). Leave the field you do not use empty. Return an empty list if you need nothing.
${DATA_RULES}`;

export const ModelReviewSchema = z.object({
  criteria: z.array(z.object({ id: z.string(), score: z.number().int().min(0).max(4), note: z.string() })),
  issues: z.array(z.object({ criterion: z.string(), severity: z.enum(['blocking', 'advisory']), detail: z.string() })),
});
export type ModelReview = z.infer<typeof ModelReviewSchema>;

const LookupAnswer = z.object({ lookups: z.array(z.object({ tool: z.string(), query: z.string(), conceptId: z.string() })) });

const toRequest = (l: z.infer<typeof LookupAnswer>['lookups'][number]): LookupRequest =>
  ({ tool: l.tool, args: l.tool === 'node_neighbourhood' ? { conceptId: l.conceptId } : { query: l.query } });

/** One tool result as text. Every string in it came from a document, a filename or the graph, so each goes in its own data block. */
function lookupText(l: LookupResult): string {
  const head = `Lookup ${asData('lookup-tool', l.tool)} ${asData('lookup-args', l.args)}`;
  if (l.refused) return `${head} was refused: ${asData('lookup-refusal', l.refused)}`;
  const r = l.result as KnowledgeHit[] | Neighbourhood;
  if (Array.isArray(r)) {
    return [head, ...r.map((h) => `- ${asData('lookup-id', h.id)} (${h.kind}, ${h.citable ? 'citable' : 'not citable'}): ${asData('lookup-title', h.title)} ${asData('lookup-snippet', h.snippet)} ${asData('lookup-source', h.source)}`)].join('\n');
  }
  const node = (n: GraphNode) => `${asData('lookup-node-id', n.nodeId)} (${asData('lookup-node-type', n.type)}, ${n.citable ? 'citable' : 'not citable'}): ${asData('lookup-node-title', n.title)}`;
  return [head, r.node ? `Concept ${node(r.node)}` : 'No such concept.', ...r.neighbours.map((n) => `- ${n.direction} ${asData('lookup-rel', n.rel)} ${node(n.node)}`)].join('\n');
}

export function reviewPrompt(subjectKey: string, criteria: readonly RubricCriterion[], automatic: QaIssue[], content: unknown, lookups?: LookupResult[]): string {
  return [
    `Workpaper: ${subjectKey}.`,
    'Criteria:',
    ...criteria.map((c) => `- ${c.id}: ${c.question}`),
    '',
    'The automatic checks already found these issues. They stand whatever you find:',
    asData('automatic-checks', automatic),
    '',
    asData(`workpaper:${subjectKey}`, content),
    ...(lookups?.length ? ['', 'What you looked up:', ...lookups.map(lookupText)] : []),
  ].join('\n');
}

const issueKey = (i: QaIssue) => `${i.severity}|${i.criterion}|${i.detail}`;
const dedupe = (issues: QaIssue[]): QaIssue[] => [...new Map(issues.map((i) => [issueKey(i), i])).values()];
const MAX_MODEL_ISSUES = 20;

/** The review a challenge builds on, if it is of the same content. */
const priorOf = (base: QaReport, previous: QaReport | null): QaReport | null => (previous && previous.subjectHash === base.subjectHash ? previous : null);
const carriedIssues = (prior: QaReport | null): QaIssue[] => (prior ? prior.issues.filter((i) => i.criterion.startsWith('model.')) : []);

/**
 * The automatic report with a model's review added. Its subject, hash and the automatic issues stay as they are. A
 * criterion the model skipped scores 0. The score is the lowest of the automatic score, the rubric score and (for a
 * challenge) the review it challenges. A challenge also keeps that review's model issues.
 */
export function mergeModelReview(base: QaReport, criteria: readonly RubricCriterion[], out: ModelReview, servedModel: string, previous: QaReport | null): QaReport {
  const given = new Map(out.criteria.map((c) => [c.id, c]));
  const scored = criteria.map((c) => ({ id: c.id, score: given.get(c.id)?.score ?? 0, note: (given.get(c.id)?.note ?? 'not scored').slice(0, 300) }));
  const modelIssues: QaIssue[] = out.issues.map((i) => ({ criterion: `model.${i.criterion}`.slice(0, 80), severity: i.severity, detail: i.detail.slice(0, 500) }));
  const prior = priorOf(base, previous);
  // At most 20 model issues in all: the review's come first, so a challenge never drops one of them.
  const kept = dedupe([...carriedIssues(prior), ...modelIssues]).slice(0, MAX_MODEL_ISSUES);
  return {
    ...base,
    reviewer: `${QA_AGENT_VERSION}:${servedModel}`,
    score: Math.min(base.score, normalise(scored.map((s) => s.score)), prior?.score ?? 100),
    issues: dedupe([...base.issues, ...kept]),
    criteria: scored,
  };
}

export interface QaAgentDeps {
  /** The run's metered model access; without a model, the review is the automatic checks alone. */
  models?: AgentModels;
  /** The QA agent's tools, for a challenge's lookups. */
  toolbox?: Toolbox;
  checks?: QaChecks;
  /** For a challenge: the review of this same content it builds on. */
  previous?: QaReport | null;
}

/** Reviews (or challenges) one subject as it stands now. */
export async function reviewWithAgent(e: Engagement, subjectKey: string, mode: 'review' | 'challenge', deps: QaAgentDeps = {}): Promise<QaReport> {
  const automatic: QaReport = { ...reviewSubject(e, subjectKey, deps.checks), mode };
  const models = deps.models;
  if (!models?.available) return automatic;
  try {
    const content = subjectContent(e, subjectKey);
    let lookups: LookupResult[] | undefined;
    if (mode === 'challenge' && deps.toolbox) {
      const asked = await models.generate('qa', { system: LOOKUP_SYSTEM, user: `Workpaper: ${subjectKey}.\n${asData(`workpaper:${subjectKey}`, content)}`, schema: LookupAnswer });
      lookups = await deps.toolbox.lookups(asked.output.lookups.map(toRequest));
    }
    const criteria = mode === 'review' ? RUBRICS[rubricKind(subjectKey)] : CHALLENGE_CRITERIA;
    const { output, servedModel } = await models.generate('qa', {
      system: mode === 'review' ? REVIEW_SYSTEM : CHALLENGE_SYSTEM,
      user: reviewPrompt(subjectKey, criteria, automatic.issues, content, lookups),
      schema: ModelReviewSchema,
    });
    return mergeModelReview(automatic, criteria, output, servedModel, mode === 'challenge' ? deps.previous ?? null : null);
  } catch (err) {
    // A refused budget or a lost lease ends the iteration; a model that is down or answers badly leaves the automatic review.
    if (!(err instanceof ModelUnavailableError || err instanceof MalformedOutputError)) throw err;
    // A failed challenge must never raise the review's score or drop its model issues.
    const prior = mode === 'challenge' ? priorOf(automatic, deps.previous ?? null) : null;
    return {
      ...automatic,
      withoutModel: true,
      score: Math.min(automatic.score, prior?.score ?? 100),
      issues: dedupe([
        ...automatic.issues,
        { criterion: 'qa.model-unavailable', severity: 'advisory', detail: `Reviewed without the model (${err.message.slice(0, 200)}); only the automatic checks ran` },
        ...carriedIssues(prior),
      ]),
    };
  }
}
