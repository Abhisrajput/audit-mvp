// Shared types for agent orchestration (spec docs/superpowers/specs/2026-10-12-agent-orchestration-design.md).

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
