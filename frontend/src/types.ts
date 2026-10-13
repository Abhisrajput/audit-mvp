// Shared with the backend so the UI and API cannot drift.
export type * from '../../backend/src/engine/types';
export type { EvalReport } from '../../backend/src/eval/harness';
export type { VisibleTrailBundle } from '../../backend/src/knowledge/trail-visibility';
export type { AgentRun, AgentStep } from '../../backend/src/agents/run-repo';
export type { Gate } from '../../backend/src/agents/gate-repo';
export type { Action, Budget, Decision, GateKind, PolicyAttempt, QaIssue, QaReport, RunStatus, Spent, StepKind } from '../../backend/src/agents/types';
export type { DelegateRecord } from '../../backend/src/agents/state';
