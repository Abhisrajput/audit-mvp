// Shared with the backend so the UI and API cannot drift.
export type * from '../../backend/src/engine/types';
export type { EvalReport } from '../../backend/src/eval/harness';
export type { VisibleTrailBundle } from '../../backend/src/knowledge/trail-visibility';
