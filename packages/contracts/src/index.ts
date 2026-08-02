export const CONTRACT_VERSION = '0.1.0' as const;

export type ConditionStatus = 'active' | 'expired' | 'superseded' | 'disputed';
export type PolicyDisposition = 'allow' | 'narrow' | 'require_approval' | 'deny';
export type Effect = 'state.read' | 'state.write' | 'state.delete' | 'network.request' | 'process.execute';
export type RiskLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface EvidenceRef {
  id: string;
  kind:
    | 'observation'
    | 'approval'
    | 'policy'
    | 'tool_result'
    | 'context'
    | 'model'
    | 'diagnostic'
    | 'verification';
  source: string;
  digest?: string;
}

export interface Condition {
  id: string;
  statement: string;
  status: ConditionStatus;
  evidenceRefs: string[];
  source: string;
  observedAt: string;
  expiresAt?: string;
  supersededBy?: string;
}

export interface IntentContract {
  id: string;
  version: typeof CONTRACT_VERSION;
  objective: string;
  principals: string[];
  /**
   * Optional for v0.1 compatibility. Delegation requires this field so a child
   * capability set can be proven to be a subset of parent authority.
   */
  authorizedCapabilities?: string[];
  authorizedResources: string[];
  prohibitedEffects: Effect[];
  requiredConditionIds: string[];
  requiredEvidence: string[];
  riskBudget: RiskLevel;
  approvalAboveRisk: RiskLevel;
  completionCriteria: string[];
}

export interface ActionProposal<Args extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  intentId: string;
  principalId: string;
  conditionIds: string[];
  capabilityId: string;
  target: string;
  declaredEffects: Effect[];
  risk: RiskLevel;
  expectedEvidence: string[];
  idempotencyKey: string;
  args: Args;
}

export interface Approval {
  id: string;
  proposalId: string;
  principalId: string;
  issuedAt: string;
  expiresAt: string;
}

export interface CapabilityManifest {
  id: string;
  version: string;
  description?: string;
  effects: Effect[];
  targetPatterns: string[];
  riskCeiling: RiskLevel;
  approval: 'never' | 'risk_based' | 'always';
  idempotent: boolean;
  verification: 'required' | 'optional';
  /** Machine-readable arguments exposed to proposal-producing models. */
  inputSchema?: JsonSchema;
}

export interface CapabilityGrant {
  id: string;
  proposalId: string;
  decisionId: string;
  principalId: string;
  capabilityId: string;
  target: string;
  effects: Effect[];
  maxRisk: RiskLevel;
  expiresAt: string;
}

export interface PolicyDecision {
  id: string;
  proposalId: string;
  disposition: PolicyDisposition;
  reasonCodes: string[];
  obligations: string[];
  grant?: CapabilityGrant;
}

export interface CapabilityExecution {
  success: boolean;
  summary: string;
  evidence: EvidenceRef[];
  errorCode?: string;
}

export interface Observation {
  target: string;
  exists: boolean;
  value?: unknown;
  evidence: EvidenceRef[];
}

export interface VerificationResult {
  passed: boolean;
  reasonCodes: string[];
  evidence: EvidenceRef[];
}

export interface LedgerEvent {
  version: typeof CONTRACT_VERSION;
  runId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface ActionOutcome {
  runId: string;
  status: 'denied' | 'awaiting_approval' | 'execution_failed' | 'verification_failed' | 'completed';
  decision: PolicyDecision;
  executed: boolean;
  claimedSuccess: boolean;
  execution?: CapabilityExecution;
  observation?: Observation;
  verification?: VerificationResult;
  receiptHash: string;
}

export interface CapabilityAdapter<Args extends Record<string, unknown> = Record<string, unknown>> {
  readonly manifest: CapabilityManifest;
  execute(proposal: ActionProposal<Args>, grant: CapabilityGrant): Promise<CapabilityExecution>;
  observe(proposal: ActionProposal<Args>): Promise<Observation>;
  verify(
    proposal: ActionProposal<Args>,
    execution: CapabilityExecution,
    observation: Observation,
  ): Promise<VerificationResult>;
}

export type WorkflowPhase =
  | 'orient'
  | 'plan'
  | 'act'
  | 'verify'
  | 'diagnose'
  | 'recover'
  | 'complete';

export type ContextAuthority = 'directive' | 'constraint' | 'evidence' | 'data' | 'untrusted';
export type ContextValidity = 'active' | 'expired' | 'superseded' | 'disputed' | 'unverified';
export type ContextTag =
  | 'intent'
  | 'current_direction'
  | 'hypothesis'
  | 'decision'
  | 'rejected'
  | 'open_question'
  | 'assumption'
  | 'evidence'
  | 'constraint'
  | 'condition'
  | 'capability'
  | 'authority'
  | 'action_proposal'
  | 'observation'
  | 'verification'
  | 'failure'
  | 'repair'
  | 'drift'
  | 'artifact'
  | 'next_step'
  | 'summary';

export type ContextRecordStatus =
  | 'candidate'
  | 'active'
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'expired'
  | 'disputed';

export interface ContextRecord {
  id: string;
  tag: ContextTag;
  title: string;
  content: string;
  sourceEventIds: string[];
  status: ContextRecordStatus;
  authority: ContextAuthority;
  confidence: number;
  priority: number;
  createdAt: string;
  searchTags: string[];
  supersedes?: string;
  expiresAt?: string;
  rebuildable: boolean;
}

export interface ConversationTurn {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  createdAt: string;
}

export interface ContextSource {
  id: string;
  title: string;
  content: string;
  kind: 'goal' | 'constraint' | 'decision' | 'conversation' | 'environment' | 'evidence' | 'diagnostic';
  authority: ContextAuthority;
  validity: ContextValidity;
  provenance: string[];
  tags: string[];
  createdAt: string;
  expiresAt?: string;
  priority: number;
  derivedFrom?: string[];
  semanticTag?: ContextTag;
  confidence?: number;
  supersedes?: string;
  rebuildable?: boolean;
}

export interface ContextPacketItem {
  sourceId: string;
  title: string;
  content: string;
  authority: ContextAuthority;
  provenance: string[];
  instructionEligible: boolean;
  score: number;
  estimatedTokens: number;
  semanticTag?: ContextTag;
  confidence?: number;
  rebuildable?: boolean;
  /** Other non-authoritative sources represented by this exact-content item. */
  collapsedSourceIds?: string[];
}

export type ContextExclusionReason =
  | 'inactive'
  | 'expired'
  | 'irrelevant'
  | 'duplicate'
  | 'budget';

export interface ContextPacketExclusion {
  sourceId: string;
  reason: ContextExclusionReason;
  representedBySourceId?: string;
}

export interface ContextPacketAudit {
  sourcesConsidered: number;
  sourcesIncluded: number;
  stableItems: number;
  dynamicItems: number;
  stableTokens: number;
  dynamicTokens: number;
  duplicateTokensRemoved: number;
  budgetUtilization: number;
  tokensByAuthority: Record<string, number>;
  tokensBySemanticTag: Record<string, number>;
}

export interface ContextPacket {
  id: string;
  runId: string;
  phase: WorkflowPhase;
  objective: string;
  constraints: string[];
  strategyId: string;
  focusTags: string[];
  items: ContextPacketItem[];
  excludedSourceIds: string[];
  exclusions: ContextPacketExclusion[];
  audit: ContextPacketAudit;
  estimatedTokens: number;
  tokenBudget: number;
  compiledAt: string;
}

export interface WorkflowActionProposal {
  kind: 'action';
  strategyId: string;
  hypothesis: string;
  expectedObservation: string;
  action: ActionProposal;
}

export interface WorkflowCompleteProposal {
  kind: 'complete';
  strategyId: string;
  evidenceRefs: string[];
}

export interface WorkflowAskProposal {
  kind: 'ask';
  strategyId: string;
  question: string;
  reason: string;
}

export interface WorkflowPivotProposal {
  kind: 'pivot';
  strategyId: string;
  fromStrategyId: string;
  cause: string;
}

export type WorkflowProposal =
  | WorkflowActionProposal
  | WorkflowCompleteProposal
  | WorkflowAskProposal
  | WorkflowPivotProposal;

export type ProgressDisposition = 'advanced' | 'stalled' | 'blocked' | 'completed';
export type RecoveryDisposition = 'continue' | 'retry' | 'pivot' | 'ask' | 'stop';

export interface CausalRecord {
  id: string;
  step: number;
  strategyId: string;
  hypothesis: string;
  predictedObservation: string;
  actionProposalId: string;
  actionStatus: ActionOutcome['status'];
  actualObservation: string;
  environmentChanged: boolean;
  failureSignature?: string;
  evidenceRefs: string[];
}

export interface ProgressAssessment {
  disposition: ProgressDisposition;
  reasonCodes: string[];
  recovery: RecoveryDisposition;
  failureSignature?: string;
  repeatedFailureCount: number;
}

/**
 * A human-authored, deterministic recovery rule. It does not learn or grant
 * authority; it activates a bounded constraint after an observed failure.
 */
export interface CorrectionRule {
  id: string;
  triggerCodes: string[];
  instruction: string;
  focusTags: string[];
  maxApplications: number;
  expectedEffect: string;
}

export interface CorrectionAssessment {
  ruleId: string;
  triggeredByCausalId: string;
  appliedAtStep: number;
  assessedAtStep: number;
  disposition: 'improved' | 'not_improved' | 'inconclusive';
  expectedEffect: string;
  observedActionStatus: ActionOutcome['status'];
  observedFailureSignature?: string;
}

export interface CompletionAssessment {
  passed: boolean;
  reasonCodes: string[];
  evidence: EvidenceRef[];
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  latencyMs: number;
}

export interface ModelRequestAudit {
  requestId: string;
  endpoint: string;
  sessionIdentifier: string | null;
  messageCount: number;
  promptCharacters: number;
  estimatedTokens: number;
  toolSchemaCharacters: number;
  systemCharacters: number;
  contextCharacters: number;
  promptHash: string;
  systemHash: string;
  contextHash: string;
}

export interface ModelProposalResult {
  proposal: WorkflowProposal;
  usage: ModelUsage;
  model: string;
  requestAudit?: ModelRequestAudit;
}

export interface WorkflowStepRecord {
  step: number;
  phase: WorkflowPhase;
  strategyId: string;
  packetId: string;
  proposal: WorkflowProposal;
  usage: ModelUsage;
  outcome?: ActionOutcome;
  causal?: CausalRecord;
  progress?: ProgressAssessment;
}

export interface WorkflowRunResult {
  runId: string;
  status: 'completed' | 'needs_input' | 'needs_approval' | 'blocked' | 'step_limit';
  steps: WorkflowStepRecord[];
  activeStrategyId: string;
  completion?: CompletionAssessment;
  question?: string;
  reasonCodes: string[];
  receiptHash: string;
}

export type ExecutablePlanStatus =
  | 'ready'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed';

export type ExecutableStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'skipped';

export type PlanConditionStatus = 'pending' | 'satisfied' | 'failed';

export interface PlanCondition {
  id: string;
  statement: string;
  predicate: 'step_completed' | 'result_nonempty' | 'artifact_exists';
  sourceStepId: string;
  status: PlanConditionStatus;
  evidenceRefs: string[];
}

export interface ExecutablePlanStep {
  id: string;
  ordinal: number;
  title: string;
  capabilityId: string;
  target: string;
  declaredEffects: Effect[];
  risk: RiskLevel;
  dependsOn: string[];
  conditionIds: string[];
  expectedEvidence: string[];
  idempotencyKey: string;
  args: Record<string, unknown>;
  status: ExecutableStepStatus;
  attempts: number;
  output?: unknown;
  evidenceRefs: string[];
  failureCode?: string;
}

export interface ExecutableWorkflowPlan {
  id: string;
  version: '1.0';
  intentId: string;
  objective: string;
  source: 'natural_language' | 'command';
  status: ExecutablePlanStatus;
  steps: ExecutablePlanStep[];
  conditions: PlanCondition[];
  completionCriteria: string[];
  currentStepId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowArtifact {
  id: string;
  planId: string;
  createdByStepId: string;
  kind: 'report' | 'note' | 'data';
  title: string;
  mediaType: 'text/markdown' | 'application/json' | 'text/plain';
  content: string;
  evidenceRefs: string[];
  verified: boolean;
  createdAt: string;
}

export interface WorkflowCheckpoint {
  id: string;
  planId: string;
  stepId?: string;
  status: 'paused' | 'blocked' | 'completed';
  reasonCode: string;
  nextStepId?: string;
  evidenceRefs: string[];
  createdAt: string;
}

export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minItems?: number;
  enum?: unknown[];
  additionalProperties?: boolean;
}

export interface DelegationBudget {
  tokenBudget: number;
  actionBudget: number;
  wallTimeMs: number;
}

export interface DelegationBudgetUsage {
  inputTokens: number;
  outputTokens: number;
  actions: number;
  wallTimeMs: number;
}

export interface DelegationVerificationSpec {
  minimumEvidence: number;
  requireVerifiedCompletion: boolean;
}

export interface DelegationContract {
  id: string;
  version: typeof CONTRACT_VERSION;
  parentRunId: string;
  childRunId: string;
  childIntent: IntentContract;
  contextRefs: string[];
  budget: DelegationBudget;
  expectedOutputSchema: JsonSchema;
  verification: DelegationVerificationSpec;
}

export interface StructuredFailure {
  type:
    | 'invalid_delegation'
    | 'missing_permission'
    | 'budget_exhausted'
    | 'condition_failed'
    | 'execution_failed'
    | 'verification_failed'
    | 'runtime_unavailable';
  message: string;
  failedCondition?: string;
  recoverableByChild: boolean;
  recommendedEscalation: 'child' | 'parent' | 'human' | 'stop';
  evidenceRefs: string[];
}

export interface DelegationResult {
  delegationId: string;
  childRunId: string;
  status: 'completed' | 'failed' | 'needs_input' | 'needs_approval' | 'step_limit';
  output?: unknown;
  evidenceRefs: string[];
  policyViolations: string[];
  verificationPassed: boolean;
  budgetUsage: DelegationBudgetUsage;
  childReceiptHash?: string;
  failure?: StructuredFailure;
}

export interface DelegationDecision {
  id: string;
  delegationId: string;
  disposition: 'allow' | 'deny';
  reasonCodes: string[];
}

export interface DelegationReceipt {
  delegationId: string;
  parentRunId: string;
  childRunId: string;
  authorized: boolean;
  accepted: boolean;
  reasonCodes: string[];
  result?: DelegationResult;
  parentReceiptHash?: string;
}
