// Core domain types for the audit engine. Content packs are pure data and are
// validated against these shapes (see packs.ts); engagements are the working
// state of one audit.

export type RiskRating = 'High' | 'Medium' | 'Low';
export type ReviewStatus = 'draft' | 'expert-reviewed';

/** Where a library concept came from and whether a person has verified it (plan 1E, spec §6.4). */
export interface ConceptTrust {
  /** Knowledge-graph node id, e.g. "pharma/clause/21cfr211-22". */
  nodeId: string;
  verifiedBy: string | null;
  verifiedRole: string | null;
  /** 'YYYY-MM-DD' */
  verifiedAt: string | null;
  status: 'active' | 'deprecated';
  /** 'YYYY-MM-DD': on and after this date the concept is due for re-review and no longer citable. */
  staleAfter: string | null;
  /** Bundle file relative to the packs directory, e.g. "pharma/clauses/21cfr211-22.md". */
  sourcePath: string;
}

/** One clause of a regulation or standard, indexed for grounding and citation. */
export interface Clause {
  id: string; // globally unique, e.g. "21CFR211.192"
  regulation: string; // e.g. "21 CFR Part 211"
  ref: string; // e.g. "§211.192"
  title: string;
  summary: string; // paraphrased summary, never the copyrighted text
  tags: string[];
  reviewStatus: ReviewStatus;
  sourceUrl?: string;
  trust?: ConceptTrust;
}

export interface Control {
  id: string;
  title: string;
  processArea: string;
  objective: string;
  risk: string;
  riskRating: RiskRating;
  type: 'Preventive' | 'Detective';
  nature: 'Manual' | 'Automated' | 'IT-dependent manual';
  frequency: Frequency;
  clauseRefs: string[];
  testOfDesign: string[];
  testOfEffectiveness: string[];
  evidenceExpected: string[];
  checklist: string[];
  recommendation: string;
  keywords: string[];
  trust?: ConceptTrust;
}

export type Frequency =
  | 'Annual'
  | 'Quarterly'
  | 'Monthly'
  | 'Weekly'
  | 'Daily'
  | 'Per event'
  | 'Per batch';

export interface EvalCase {
  id: string;
  kind: 'retrieval' | 'testing' | 'gaps';
  description: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface ContentPack {
  id: string;
  name: string;
  version: string;
  vertical: 'common' | 'food' | 'pharma' | string;
  description: string;
  disclaimer: string;
  /** Short citation prefix per regulation name, e.g. {"COSO Internal Control 2013": "COSO"}. */
  sources: Record<string, string>;
  clauses: Clause[];
  controls: Control[];
  evalCases: EvalCase[];
}

// ---------- Engagement working state ----------

export type EngagementStage = 'planning' | 'rcm' | 'fieldwork' | 'findings' | 'reporting';

export interface Citation {
  clauseId: string;
  regulation: string;
  ref: string;
  label: string; // short display form, e.g. "COSO Principle 10"
}

/** What kind of thing an auditor-entered context factor is (spec §3.1). */
export type FactorKind = 'change' | 'incident' | 'regulatory' | 'prior_finding' | 'complexity';

/** One auditor-entered fact that bears on risk, tied to the process areas it touches (spec §3.1). */
export interface ContextFactor { kind: FactorKind; processAreas: string[]; description: string }

/** The auditor-entered engagement context that drives the risk assessment (spec §3.1). */
export interface EngagementContext { factors: ContextFactor[]; background: string; updatedBy: string; updatedAt: string }

/** The scope coverage statement: which process areas were left out and why (spec §3.2). */
export interface Coverage { excluded: { processArea: string; reason: string }[]; statement: string }

/** One judgment the engine made, with its decision, reasoning and the standards behind it (spec §3.4). */
export interface JudgmentCall { question: string; decision: string; rationale: string; basis: string[]; standard: string[]; source: 'rules' | 'model' }

/** The judgment memo for one subject, with the points a reviewer should verify (spec §3.4). */
export interface JudgmentMemo { subjectKey: string; calls: JudgmentCall[]; forTheReviewer: string[]; producedAt: string }

export interface ScopeItem {
  controlId: string;
  packId: string;
  processArea: string;
  risk: string;
  inherentRisk: RiskRating;
  /** Risk after the engagement context is applied (spec §3.2). */
  assessedRisk: RiskRating;
  /** Which context factors raised the assessed risk (spec §3.2). */
  riskFactors: string[];
  relevance: number; // retrieval score normalised 0..1
  rationale: string;
  citations: Citation[];
  included: boolean;
  /** Set when a person decided the in/out flag; absent on agent-drafted and pre-8A rows. */
  decidedBy?: string;
}

export interface RcmRow {
  id: string;
  controlId: string;
  packId: string;
  processArea: string;
  risk: string;
  riskRating: RiskRating;
  control: string;
  objective: string;
  type: Control['type'];
  nature: Control['nature'];
  frequency: Frequency;
  sampleSize: number;
  testOfDesign: string[];
  testOfEffectiveness: string[];
  evidenceExpected: string[];
  checklist: string[];
  citations: Citation[];
}

export type TestConclusion = 'Effective' | 'Ineffective' | 'Design deficient' | 'Not tested';

/** What the auditor records in the field. */
export interface TestInput {
  designAdequate: boolean | null;
  observation: string;
  evidenceRefs: string[];
  sampleTested: number;
  exceptions: number;
  updatedBy: string;
  updatedAt: string;
}

/** What the Testing module concludes from the auditor's record. */
export interface TestResult {
  rowId: string;
  conclusion: TestConclusion;
  rationale: string;
  exceptionRate: number | null;
  qaFlags: string[];
}

/** A drafted test plan for one RCM row (agent spec §3.1). Auditors may edit it; only an auditor sets notTestedJustification. */
export interface TestPlan {
  rowId: string;
  /** SHA-256 of the RCM row the plan was drafted from; a changed row gets a fresh draft. */
  rowHash: string;
  attribute: string;
  population: string;
  sampleSize: number;
  selectionMethod: 'random' | 'all' | 'judgemental';
  evidenceToRequest: string[];
  procedure: string;
  /** Set by an auditor only: why this row will not be tested. The agent never sets or clears it. */
  notTestedJustification?: string;
  editedBy?: string;
  editedAt?: string;
}

export type FindingStatus = 'draft' | 'blocked' | 'reviewed' | 'approved' | 'rejected';

export interface SignOff {
  userId: string;
  userName: string;
  role: string;
  meaning: 'Reviewed' | 'Approved' | 'Rejected';
  comment: string;
  at: string;
  /** Signatures captured since Part 11 signing (plan 1C) carry these. */
  signatureId?: string;
  /** SHA-256 of the finding content this signature vouches for. */
  contentHash?: string;
  /** How the signer proved who they were at the moment of signing; 'none' for server-side signing (seed, tests). */
  reauth?: { method: 'oidc' | 'dev' | 'none'; at: string | null };
  /** Set only in API responses and exports: the signature record is missing, or the sign-off or content no longer matches it. */
  broken?: boolean;
  /** Set only in API responses and exports: no signature record (signed before Part 11 signing, or imported). */
  legacy?: boolean;
}

/** A finding with triple citation: regulation clause + control + evidence. */
export interface Finding {
  id: string;
  rowId: string;
  controlId: string;
  title: string;
  rating: RiskRating;
  condition: string;
  criteria: string;
  cause: string;
  effect: string;
  recommendation: string;
  citations: Citation[];
  evidenceRefs: string[];
  status: FindingStatus;
  blockedReasons: string[];
  signOffs: SignOff[];
  bundleId: string;
  /** Users who drafted or edited this finding since it was last reset; none of them may sign it. */
  preparedBy?: string[];
  /**
   * Set only in API responses and exports, never stored: problems found by checking the finding against the
   * append-only signature records, e.g. a recorded signature that is missing from the finding.
   */
  signatureIssues?: string[];
}

export interface AuditReport {
  generatedAt: string;
  bundleId: string;
  markdown: string;
  includedFindingIds: string[];
  excludedFindingIds: string[];
}

export interface Engagement {
  id: string;
  name: string;
  entity: string;
  site: string;
  periodFrom: string;
  periodTo: string;
  auditType: string;
  scopeStatement: string;
  packIds: string[];
  createdBy: string;
  createdAt: string;
  stage: EngagementStage;
  scope: ScopeItem[];
  rcm: RcmRow[];
  testInputs: Record<string, TestInput>;
  testResults: Record<string, TestResult>;
  /** Test plans by RCM row id. */
  testPlans: Record<string, TestPlan>;
  findings: Finding[];
  report: AuditReport | null;
  /** Auditor-entered context (spec §3.1); null until entered. */
  context: EngagementContext | null;
  /** Scope coverage statement (spec §3.2); null until scope is drafted. */
  coverage: Coverage | null;
  /** Judgment memos by subject key (spec §3.4). */
  memos: Record<string, JudgmentMemo>;
  /** Optimistic-concurrency version from the database; absent on objects not yet saved. */
  version?: number;
}

// ---------- Evidence / audit trail ----------

export type QaOutcome = 'pass' | 'fail' | 'warn';

export interface QaAction {
  gate: string;
  outcome: QaOutcome;
  target: string; // what the gate looked at, e.g. finding id
  detail: string;
  action: 'none' | 'blocked' | 'downgraded' | 'flagged';
}

export interface RetrievalHit {
  clauseId: string;
  score: number;
}

export interface LogEntry {
  at: string;
  step: string;
  detail: string;
}

/** Immutable record of one module execution, hash-chained to the previous one. */
export interface TrailBundle {
  id: string;
  seq: number;
  /** null for identity events (login, role changes, …) that belong to no engagement. */
  engagementId: string | null;
  moduleId: string;
  moduleVersion: string;
  engineVersion: string;
  packVersions: Record<string, string>;
  provider: { id: string; model: string };
  promptHash: string | null;
  actor: string;
  startedAt: string;
  finishedAt: string;
  inputs: unknown;
  retrievalSet: RetrievalHit[];
  executionLog: LogEntry[];
  qaActions: QaAction[];
  output: unknown;
  /** The API request that wrote this bundle (absent for CLI, seed, import and eval bundles). Covered by the hash. */
  requestId?: string;
  prevHash: string;
  hash: string;
}

export type Role = 'auditor' | 'audit_manager' | 'cae' | 'admin' | 'viewer';

export interface User {
  id: string;
  name: string;
  role: Role;
}
