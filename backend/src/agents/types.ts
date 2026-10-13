// Shared types for agent orchestration (spec docs/superpowers/specs/2026-10-12-agent-orchestration-design.md).

import { z } from 'zod';
import { canonicalJson } from '../engine/trail';
import type { Engagement } from '../engine/types';

export type RunStatus = 'running' | 'runnable' | 'waiting' | 'needs_human' | 'completed' | 'cancelled' | 'failed';
export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'cancelled', 'failed'];

export type StepKind = 'decision' | 'delegate' | 'tool_call' | 'qa';
export type GateKind = 'scope' | 'rcm' | 'finding' | 'report';
export type GateState = 'open' | 'approved' | 'rejected' | 'superseded';
export type WorkpaperKind = 'scope' | 'rcm' | 'test_plans' | 'report';
/** Workpapers a gate signature can cover. Test plans have no gate. */
export type SignableWorkpaper = 'scope' | 'rcm' | 'report';

export interface Budget {
  maxSteps: number;
  maxTokens: number;
  maxCostUsd: number;
}

export interface Spent {
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export const NO_SPEND: Spent = { steps: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };

export interface QaIssue {
  criterion: string;
  severity: 'blocking' | 'advisory';
  detail: string;
}

/** A QA review of one subject at one content hash (spec §5.5). */
export interface QaReport {
  subjectKey: string;
  subjectHash: string;
  mode: 'review' | 'challenge';
  reviewer: string;
  /** 0–100 */
  score: number;
  issues: QaIssue[];
}

/** The specialists the supervisor can delegate to. Each wraps one existing module (or, for test plans, the drafter). */
export const SPECIALISTS = ['scope', 'rcm', 'test-plan', 'testing', 'gaps', 'report'] as const;
export type Specialist = (typeof SPECIALISTS)[number];

const SpecialistSchema = z.enum(SPECIALISTS);
const Rows = z.array(z.string()).optional();

/** Everything a run can do (spec §5.2). A closed union: a decision naming anything else is refused. */
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delegate'), specialist: SpecialistSchema, subjectKey: z.string(), rows: Rows }),
  z.object({ type: z.literal('request_qa'), subjectKey: z.string(), mode: z.enum(['review', 'challenge']) }),
  z.object({ type: z.literal('rework'), specialist: SpecialistSchema, subjectKey: z.string(), instruction: z.string().max(2000), rows: Rows }),
  z.object({ type: z.literal('open_gate'), subjectKey: z.string() }),
  z.object({ type: z.literal('wait'), reason: z.string() }),
  z.object({ type: z.literal('escalate'), reason: z.string() }),
  z.object({ type: z.literal('complete') }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const DecisionSchema = z.object({
  action: ActionSchema,
  rationale: z.string().max(500),
  /** 'forced' when the menu had one entry and no policy was asked. */
  policy: z.enum(['llm', 'rules', 'forced']),
  policyVersion: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export type Stage = 'scope' | 'rcm' | 'test_plans' | 'awaiting_tests' | 'testing' | 'gaps' | 'findings' | 'report' | 'done';

/** What the graph needs to know about a gate. */
export interface GateRecord {
  id: string;
  kind: GateKind;
  subjectKey: string;
  subjectId: string;
  subjectHash: string;
  basisHash: string;
  state: GateState;
  attempt: number;
  comment: string;
  signatureId: string | null;
}

/** A specialist run on a subject, from the run's delegate steps. */
export interface RedraftRecord {
  subjectKey: string;
  kind: 'delegate' | 'rework';
  /** redraftBasis() when it ran. */
  basis: string;
  /** The subject's latest gate when it ran (null before any gate). */
  sinceGateId: string | null;
}

export interface GraphInput {
  engagement: Engagement;
  /** Every gate on the engagement, oldest first. */
  gates: GateRecord[];
  /** This run's QA reports, oldest first. */
  qa: QaReport[];
  redrafts: RedraftRecord[];
  qaThreshold: number;
}

/** The legal next actions, and the QA report they were derived from (if any). */
export interface Menu {
  stage: Stage;
  actions: Action[];
  qa: QaReport | null;
  qaThreshold: number;
}

export interface Policy {
  readonly kind: 'llm' | 'rules';
  readonly version: string;
  decide(menu: Menu): Promise<Decision>;
}

/** Redrafts a subject may get from QA feedback before its gate (spec §5.3). */
export const MAX_SELF_REWORKS = 2;
/** Rejected gates on one subject before the run hands it to a person (spec §4.5). */
export const MAX_REJECTIONS = 2;

export const sameAction = (a: Action, b: Action) => canonicalJson(a) === canonicalJson(b);
