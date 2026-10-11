import type { ColumnType, Generated } from 'kysely';
import type { EvalReport } from '../eval/harness';
import type { AuditReport, Role, EngagementStage, Finding, FindingStatus, RcmRow, RiskRating, ScopeItem, TestInput, TestResult } from '../engine/types';

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

export interface UsersTable {
  id: string;
  issuer: string;
  subject: string;
  name: string;
  email: string | null;
  role: Role | null;
  role_source: ColumnType<'idp' | 'admin', 'idp' | 'admin' | undefined, 'idp' | 'admin'>;
  active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Generated<Date>;
  last_login_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  csrf_token: string;
  created_at: Generated<Date>;
  last_seen_at: DefaultedTimestamp;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface FindingRevisionsTable {
  engagement_id: string;
  finding_id: string;
  revision: number;
  content_hash: string;
  recorded_at: Generated<Date>;
}

type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type NullableText = ColumnType<string | null, string | null | undefined, string | null>;

export interface SignaturesTable {
  id: string;
  engagement_id: string;
  finding_id: string;
  user_id: string;
  user_name: string;
  role: string;
  meaning: 'Reviewed' | 'Approved' | 'Rejected';
  comment: string;
  content_hash: string;
  reauth_method: 'oidc' | 'dev' | 'none';
  reauth_at: NullableTimestamp;
  intent_id: NullableText;
  trail_bundle_id: string;
  signed_at: Timestamp;
}

export interface SignIntentsTable {
  id: string;
  user_id: string;
  engagement_id: string;
  finding_id: string;
  action: 'review' | 'approve' | 'reject';
  comment: string;
  content_hash: string;
  state: string;
  nonce: string;
  code_verifier: string;
  created_at: Generated<Date>;
  expires_at: Timestamp;
  status: ColumnType<'pending' | 'claimed' | 'signed' | 'failed', 'pending' | undefined, 'claimed' | 'signed' | 'failed'>;
  failure_code: NullableText;
  failure_message: NullableText;
  completed_at: NullableTimestamp;
}

export interface DocumentsTable {
  id: string;
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  kind: 'evidence' | 'sop' | 'policy' | 'prior_report' | 'regulation' | 'okf_concept' | 'other';
  classification: 'internal' | 'confidential' | 'restricted';
  engagement_id: string | null;
  uploaded_by: string;
  uploaded_at: Generated<Date>;
  retain_until: ColumnType<Date | null, string | null | undefined, string | null>;
  retention_expired: ColumnType<boolean, boolean | undefined, boolean>;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
}

export interface DocumentTextTable {
  document_id: string;
  extractor: string;
  extractor_version: string;
  text: string;
  pages: ColumnType<number[], string | undefined, string>;
  extracted_at: Generated<Date>;
}

export interface ChunksTable {
  id: string;
  document_id: string | null;
  kg_node_id: string | null;
  ordinal: number;
  page: number | null;
  text: string;
  tsv: ColumnType<string, never, never>;
  embedding: ColumnType<string | null, string | null | undefined, string | null>;
  classification: 'internal' | 'confidential' | 'restricted';
  engagement_id: string | null;
}


export interface DB {
  engagements: EngagementsTable;
  engagement_work: EngagementWorkTable;
  findings: FindingsTable;
  trail: TrailTable;
  eval_runs: EvalRunsTable;
  schema_migrations: SchemaMigrationsTable;
  users: UsersTable;
  sessions: SessionsTable;
  finding_revisions: FindingRevisionsTable;
  signatures: SignaturesTable;
  sign_intents: SignIntentsTable;
  documents: DocumentsTable;
  document_text: DocumentTextTable;
  chunks: ChunksTable;
}
