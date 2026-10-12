import type { ColumnType, Generated } from 'kysely';
import type { EvalReport } from '../eval/harness';
import type { AuditReport, EngagementStage, Finding, FindingStatus, RcmRow, RiskRating, ScopeItem, TestInput, TestResult } from '../engine/types';

// JSONB columns are read as parsed values and written as JSON strings.
type Json<T> = ColumnType<T, string, string>;
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type DefaultedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface EngagementsTable {
  id: string;
  name: string;
  entity: string;
  site: string;
  period_from: string;
  period_to: string;
  audit_type: string;
  scope_statement: string;
  pack_ids: Json<string[]>;
  created_by: string;
  created_at: Timestamp;
  updated_at: DefaultedTimestamp;
  stage: EngagementStage;
  version: ColumnType<number, number | undefined, number>;
}

export interface EngagementWorkTable {
  engagement_id: string;
  scope: Json<ScopeItem[]>;
  rcm: Json<RcmRow[]>;
  test_inputs: Json<Record<string, TestInput>>;
  test_results: Json<Record<string, TestResult>>;
  report: ColumnType<AuditReport | null, string | null, string | null>;
}

export interface FindingsTable {
  seq: Generated<number>;
  engagement_id: string;
  id: string;
  row_id: string;
  control_id: string;
  status: FindingStatus;
  rating: RiskRating;
  data: Json<Finding>;
  superseded_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Generated<Date>;
  updated_at: DefaultedTimestamp;
}

export interface TrailTable {
  seq: number;
  id: string;
  engagement_id: string | null;
  module_id: string;
  actor: string;
  prev_hash: string;
  hash: string;
  body: string;
  recorded_at: Generated<Date>;
}

export interface EvalRunsTable {
  id: string;
  at: Timestamp;
  body: Json<EvalReport>;
}

export interface SchemaMigrationsTable {
  name: string;
  applied_at: Generated<Date>;
}

export interface DB {
  engagements: EngagementsTable;
  engagement_work: EngagementWorkTable;
  findings: FindingsTable;
  trail: TrailTable;
  eval_runs: EvalRunsTable;
  schema_migrations: SchemaMigrationsTable;
}
