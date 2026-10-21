import type { ColumnType, Generated } from 'kysely';
import type { Budget, GateKind, GateState, QaReport, RunStatus, SignableWorkpaper, Spent, StepKind, WorkpaperKind } from '../agents/types';
import type { EvalReport } from '../eval/harness';
import type { AuditReport, Coverage, ResponseKind, EngagementContext, JudgmentMemo, Role, EngagementStage, Finding, FindingStatus, RcmRow, RiskRating, ScopeItem, TestInput, TestPlan, TestResult } from '../engine/types';

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
  test_plans: ColumnType<Record<string, TestPlan>, string | undefined, string>;
  report: ColumnType<AuditReport | null, string | null, string | null>;
  context: ColumnType<EngagementContext | null, string | null, string | null>;
  coverage: ColumnType<Coverage | null, string | null, string | null>;
  memos: ColumnType<Record<string, JudgmentMemo>, string | undefined, string>;
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
  /** null for a workpaper signature. */
  finding_id: string | null;
  subject_kind: ColumnType<'finding' | 'workpaper', 'finding' | 'workpaper' | undefined, never>;
  workpaper: ColumnType<SignableWorkpaper | null, SignableWorkpaper | null | undefined, never>;
  gate_id: NullableText;
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
  finding_id: string | null;
  subject_kind: ColumnType<'finding' | 'workpaper', 'finding' | 'workpaper' | undefined, never>;
  workpaper: ColumnType<SignableWorkpaper | null, SignableWorkpaper | null | undefined, never>;
  gate_id: NullableText;
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
  retain_until: ColumnType<string | null, string | null | undefined, string | null>;
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

export interface BlobUploadsTable {
  sha256: string;
  uploaded_by: string;
  uploaded_at: Generated<Date>;
}

export type KgNodeType = 'pack' | 'regulation' | 'clause' | 'control' | 'risk' | 'eval_case';

export interface KgNodesTable {
  id: string;
  type: KgNodeType;
  pack_id: string;
  pack_version: string;
  concept_id: string;
  title: string;
  description: string | null;
  body: string;
  tags: Json<string[]>;
  sources: ColumnType<{ ref: string }[], string | undefined, string>;
  attrs: Json<Record<string, unknown>>;
  generated: ColumnType<{ by: string; at: string } | null, string | null, string | null>;
  verified_by: string | null;
  verified_role: string | null;
  /** date: read as 'YYYY-MM-DD' (parser 1082 in db/index.ts and db/pglite.ts). */
  verified_at: string | null;
  status: 'active' | 'deprecated';
  stale_after: string | null;
  source_path: string;
  source_sha256: string;
  classification: 'internal' | 'confidential' | 'restricted';
  compiled_at: DefaultedTimestamp;
}

export interface KgNodeVersionsTable {
  node_id: string;
  pack_version: string;
  source_sha256: string;
  snapshot: Json<unknown>;
  compiled_at: DefaultedTimestamp;
  compiled_by: string;
}

export interface KgEdgesTable {
  id: Generated<number>;
  from_id: string;
  to_id: string;
  rel: string;
  origin: 'curated' | 'engagement' | 'proposed';
  created_by: string;
  source_ref: ColumnType<unknown, string | null | undefined, string | null>;
  approved_by: string | null;
  approved_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: DefaultedTimestamp;
}

export interface WorkpaperRevisionsTable {
  engagement_id: string;
  kind: WorkpaperKind;
  revision: number;
  content_hash: string;
  recorded_at: Generated<Date>;
}

type Flag = ColumnType<boolean, boolean | undefined, boolean>;
type Count = ColumnType<number, number | undefined, number>;

export interface AgentRunsTable {
  id: string;
  engagement_id: string;
  goal: ColumnType<'engagement', 'engagement' | undefined, never>;
  status: RunStatus;
  status_reason: ColumnType<string, string | undefined, string>;
  policy: 'llm' | 'rules';
  policy_version: string;
  budget: Json<Budget>;
  spent: ColumnType<Spent, string | undefined, string>;
  started_by: string;
  cancel_requested: Flag;
  pause_requested: Flag;
  wake_requested: Flag;
  failure_streak: Count;
  conflict_streak: Count;
  wake_at: NullableTimestamp;
  lease_owner: NullableText;
  lease_until: NullableTimestamp;
  version: Count;
  created_at: Generated<Date>;
  updated_at: DefaultedTimestamp;
  ended_at: NullableTimestamp;
}

export interface AgentStepsTable {
  run_id: string;
  seq: number;
  kind: StepKind;
  agent: string;
  decision: ColumnType<unknown, string, never>;
  model: ColumnType<string | null, string | null | undefined, never>;
  tokens_in: ColumnType<number, number | undefined, never>;
  tokens_out: ColumnType<number, number | undefined, never>;
  cost_usd: ColumnType<number, number | undefined, never>;
  duration_ms: ColumnType<number, number | undefined, never>;
  trail_bundle_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: Generated<Date>;
}

export interface GatesTable {
  id: string;
  seq: Generated<number>;
  engagement_id: string;
  run_id: string;
  kind: GateKind;
  subject_key: string;
  subject_id: string;
  subject_hash: string;
  basis_hash: string;
  qa_report: ColumnType<QaReport | null, string, never>;
  attempt: number;
  state: ColumnType<GateState, GateState | undefined, GateState>;
  signature_id: NullableText;
  comment: ColumnType<string, string | undefined, string>;
  opened_at: Generated<Date>;
  closed_at: NullableTimestamp;
}

export interface TestTolerancesTable {
  id: string;
  engagement_id: string;
  control_id: string;
  /** numeric(4,3): pg returns it as a string. */
  rate: ColumnType<string, number | string, never>;
  recorded_by: string;
  recorded_at: Timestamp;
  trail_bundle_id: string;
}

export interface FindingResponsesTable {
  id: string;
  engagement_id: string;
  finding_id: string;
  response: ResponseKind;
  owner: string;
  /** A date column: the connection parses it as text (see db/index.ts). */
  due_date: ColumnType<string | null, string | null, never>;
  action_plan: string;
  recorded_by: string;
  recorded_at: Timestamp;
  trail_bundle_id: string;
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
  blob_uploads: BlobUploadsTable;
  kg_nodes: KgNodesTable;
  kg_node_versions: KgNodeVersionsTable;
  kg_edges: KgEdgesTable;
  workpaper_revisions: WorkpaperRevisionsTable;
  agent_runs: AgentRunsTable;
  agent_steps: AgentStepsTable;
  gates: GatesTable;
  test_tolerances: TestTolerancesTable;
  finding_responses: FindingResponsesTable;
}
