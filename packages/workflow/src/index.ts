import type {
  AgentMessage,
  AgentToolResultBlock,
  ActionOutcome,
  ActionProposal,
  CapabilityExecution,
  Approval,
  CapabilityAdapter,
  CapabilityManifest,
  CausalRecord,
  CompletionAssessment,
  Condition,
  CorrectionAssessment,
  CorrectionRule,
  ContextSource,
  DelegationResult,
  EvidenceRef,
  IntentContract,
  LedgerEvent,
  ModelProposalResult,
  PolicyDecision,
  ProgressAssessment,
  WorkflowCompleteProposal,
  WorkflowAskProposal,
  WorkflowRunResult,
  WorkflowStepRecord,
  ComposedWorkflowPlan,
  WorkflowNode,
  WorkflowNodeResult,
  SemanticVerificationRequest,
  VerificationResult,
  VerifiedToolResultProjection,
  Observation,
} from '@hyper/contracts';
import { DynamicContextCompiler, detectContextSignals, renderContextPacket, serializeBoundedModelData } from '@hyper/context';
import {
  validateJsonSchema,
  type ChildRuntimeExecutor,
  type ChildRuntimeRequest,
} from '@hyper/delegation';
import type { ModelDriver } from '@hyper/model';
import {
  AuthorizedRuntime,
  DeterministicPolicyEngine,
  HashChainLedger,
} from '@hyper/runtime';

export interface CompletionOracleInput {
  intent: IntentContract;
  proposal: WorkflowCompleteProposal;
  satisfiedEvidence: string[];
  steps: WorkflowStepRecord[];
}

export interface CompletionOracle {
  verify(input: CompletionOracleInput): Promise<CompletionAssessment>;
}

/**
 * Evidence obligations may be bound to the effect or capability that must
 * actually have crossed the verified runtime boundary. Unqualified names stay
 * backward compatible with existing task files, but qualified obligations
 * cannot be satisfied by an unrelated successful action.
 */
export function actionSatisfiesEvidenceRequirement(
  action: ActionProposal,
  requirement: string,
): boolean {
  if (requirement.startsWith('effect:')) {
    return action.declaredEffects.includes(requirement.slice('effect:'.length) as ActionProposal['declaredEffects'][number]);
  }
  if (requirement.startsWith('capability:')) {
    return action.capabilityId === requirement.slice('capability:'.length);
  }
  return true;
}

export class RequiredEvidenceCompletionOracle implements CompletionOracle {
  async verify(input: CompletionOracleInput): Promise<CompletionAssessment> {
    const missingObserved = input.intent.requiredEvidence.filter(
      requirement => !input.satisfiedEvidence.includes(requirement),
    );
    const verifiedEvidenceByRequirement = new Map<string, Set<string>>();
    for (const step of input.steps) {
      if (
        step.proposal.kind !== 'action'
        || step.outcome?.status !== 'completed'
        || !step.outcome.verification?.passed
      ) continue;
      for (const requirement of step.proposal.action.expectedEvidence) {
        if (!actionSatisfiesEvidenceRequirement(step.proposal.action, requirement)) continue;
        const evidenceIds = verifiedEvidenceByRequirement.get(requirement) ?? new Set<string>();
        for (const evidence of step.outcome.verification.evidence) evidenceIds.add(evidence.id);
        verifiedEvidenceByRequirement.set(requirement, evidenceIds);
      }
    }
    const missingClaim = input.intent.requiredEvidence.filter(
      requirement => {
        if (input.proposal.evidenceRefs.includes(requirement)) return false;
        const verifiedIds = verifiedEvidenceByRequirement.get(requirement);
        return !verifiedIds
          || !input.proposal.evidenceRefs.some(evidenceId => verifiedIds.has(evidenceId));
      },
    );
    const passed = missingObserved.length === 0 && missingClaim.length === 0;
    return {
      passed,
      reasonCodes: passed
        ? ['REQUIRED_EVIDENCE_OBSERVED']
        : [
            ...missingObserved.map(value => `EVIDENCE_NOT_OBSERVED:${value}`),
            ...missingClaim.map(value => `EVIDENCE_NOT_REFERENCED:${value}`),
          ],
      evidence: input.steps.flatMap(step =>
        step.outcome?.verification?.evidence ?? [],
      ),
    };
  }
}

export class CapabilityRegistry {
  private readonly adapters = new Map<string, CapabilityAdapter<any>>();

  register(adapter: CapabilityAdapter<any>): this {
    if (this.adapters.has(adapter.manifest.id)) {
      throw new Error(`Capability ${adapter.manifest.id} is already registered.`);
    }
    this.adapters.set(adapter.manifest.id, adapter);
    return this;
  }

  get(id: string): CapabilityAdapter<any> | undefined {
    return this.adapters.get(id);
  }

  manifests(): CapabilityManifest[] {
    return [...this.adapters.values()].map(adapter => structuredClone(adapter.manifest));
  }
}

export interface WorkflowDefinition {
  runId: string;
  intent: IntentContract;
  conditions: Condition[];
  constraints: string[];
  sources: ContextSource[];
  initialStrategyId: string;
  focusTags?: string[];
  /** A request-specific subset shown to the proposal model. This narrows the
   * model's choice surface without expanding or replacing intent authority. */
  proposalCapabilityIds?: string[];
  /** Permits the completion oracle to finish immediately after a verified
   * action. Enable only for requests whose bounded plan is known to be one-step. */
  completeAfterVerifiedAction?: boolean;
  tokenBudget?: number;
  maxSteps?: number;
  maxWallTimeMs?: number;
  correctionRules?: CorrectionRule[];
  approvalFor?: (proposalId: string) => Approval | undefined;
  requestApprovalFor?: (proposalId: string) => Promise<Approval | undefined>;
  clarificationPolicy?: (input: ClarificationPolicyInput) => ClarificationPolicyDecision;
  signal?: AbortSignal;
  resumeFrom?: WorkflowResumeSeed;
}

export interface ClarificationPolicyInput {
  proposal: WorkflowAskProposal;
  intent: IntentContract;
  sources: ContextSource[];
  availableCapabilities: CapabilityManifest[];
  step: number;
}

export interface ClarificationPolicyDecision {
  allowed: boolean;
  reasonCode: string;
  instruction?: string;
}

export interface WorkflowResumeSeed {
  runId: string;
  steps: WorkflowStepRecord[];
  sources: ContextSource[];
  satisfiedEvidence: string[];
  causalHistory: CausalRecord[];
  strategies: string[];
  activeStrategyId: string;
  agentMessages?: AgentMessage[];
  pendingNativeProposals?: PendingNativeProposal[];
}

export interface PendingNativeProposal {
  proposal: Extract<WorkflowStepRecord['proposal'], { kind: 'action' }>;
  toolCallId: string;
  toolName: string;
  model: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Rebuilds the resumable semantic state from canonical events. If a verified
 * action crossed the effect boundary after the last checkpoint, it is folded
 * into the continuation so the side effect is not proposed again. */
export function rebuildWorkflowResumeSeedFromEvents(
  sourceRunId: string,
  events: readonly LedgerEvent[],
): WorkflowResumeSeed | undefined {
  const ordered = [...events]
    .filter(event => event.runId === sourceRunId)
    .sort((left, right) => left.sequence - right.sequence);
  const started = ordered.find(event => event.type === 'workflow.started');
  if (!started) return undefined;
  const checkpointEvent = [...ordered].reverse().find(event => event.type === 'workflow.checkpoint');
  const checkpoint = checkpointEvent?.payload;
  const steps = Array.isArray(checkpoint?.steps)
    ? structuredClone(checkpoint.steps as WorkflowStepRecord[])
    : [];
  const sources = Array.isArray(checkpoint?.sources)
    ? structuredClone(checkpoint.sources as ContextSource[])
    : [];
  const satisfiedEvidence = new Set(stringArray(checkpoint?.satisfiedEvidence));
  const causalHistory = Array.isArray(checkpoint?.causalHistory)
    ? structuredClone(checkpoint.causalHistory as CausalRecord[])
    : [];
  const agentMessages = Array.isArray(checkpoint?.agentMessages)
    ? structuredClone(checkpoint.agentMessages as AgentMessage[])
    : undefined;
  const pendingNativeProposals = Array.isArray(checkpoint?.pendingNativeProposals)
    ? structuredClone(checkpoint.pendingNativeProposals as PendingNativeProposal[])
    : undefined;
  const strategies = new Set(stringArray(checkpoint?.strategies));
  let activeStrategyId = typeof checkpoint?.activeStrategyId === 'string'
    ? checkpoint.activeStrategyId
    : typeof started.payload.initialStrategyId === 'string'
      ? started.payload.initialStrategyId
      : 'strategy:recovered';
  strategies.add(activeStrategyId);
  const afterSequence = checkpointEvent?.sequence ?? started.sequence;
  const modelEvents = ordered.filter(event => event.type === 'model.proposed' && event.sequence > afterSequence);

  for (const modelEvent of modelEvents) {
    const proposal = object(modelEvent.payload.proposal) as WorkflowStepRecord['proposal'] | undefined;
    if (!proposal || proposal.kind !== 'action') continue;
    if (steps.some(step => step.proposal.kind === 'action' && step.proposal.action.id === proposal.action.id)) continue;
    const receipt = ordered.find(event =>
      event.sequence > modelEvent.sequence
      && event.type === 'action.receipt'
      && (event.payload.decisionId === undefined || typeof event.payload.decisionId === 'string'),
    );
    if (!receipt || typeof receipt.payload.status !== 'string') continue;
    const decisionEvent = ordered.find(event =>
      event.sequence > modelEvent.sequence
      && event.sequence < receipt.sequence
      && event.type === 'policy.decided'
      && event.payload.proposalId === proposal.action.id,
    );
    if (!decisionEvent) continue;
    const executionEvent = ordered.find(event =>
      event.sequence > decisionEvent.sequence && event.sequence < receipt.sequence
      && event.type === 'action.executed' && event.payload.proposalId === proposal.action.id,
    );
    const observationEvent = ordered.find(event =>
      event.sequence > decisionEvent.sequence && event.sequence < receipt.sequence
      && event.type === 'state.observed' && event.payload.proposalId === proposal.action.id,
    );
    const verificationEvent = ordered.find(event =>
      event.sequence > decisionEvent.sequence && event.sequence < receipt.sequence
      && event.type === 'action.verified' && event.payload.proposalId === proposal.action.id,
    );
    const outcome: ActionOutcome = {
      runId: sourceRunId,
      status: receipt.payload.status as ActionOutcome['status'],
      decision: structuredClone(decisionEvent.payload) as unknown as PolicyDecision,
      executed: receipt.payload.executed === true,
      claimedSuccess: receipt.payload.claimedSuccess === true,
      receiptHash: receipt.hash,
      ...(executionEvent ? { execution: structuredClone(executionEvent.payload) as unknown as CapabilityExecution } : {}),
      ...(observationEvent ? { observation: structuredClone(observationEvent.payload) as unknown as Observation } : {}),
      ...(verificationEvent ? { verification: structuredClone(verificationEvent.payload) as unknown as VerificationResult } : {}),
    };
    const stepNumber = typeof modelEvent.payload.step === 'number' ? modelEvent.payload.step : steps.length + 1;
    const contextEvent = [...ordered].reverse().find(event =>
      event.sequence < modelEvent.sequence && event.type === 'context.compiled' && event.payload.step === stepNumber,
    );
    const progressEvent = ordered.find(event =>
      event.sequence > receipt.sequence && event.type === 'workflow.progress_assessed' && event.payload.step === stepNumber,
    );
    const causal = object(progressEvent?.payload.causal) as unknown as CausalRecord | undefined;
    const progress = object(progressEvent?.payload.progress) as unknown as ProgressAssessment | undefined;
    const strategyId = proposal.strategyId;
    activeStrategyId = strategyId;
    strategies.add(strategyId);
    const reconstructed: WorkflowStepRecord = {
      step: stepNumber,
      phase: typeof contextEvent?.payload.phase === 'string'
        ? contextEvent.payload.phase as WorkflowStepRecord['phase']
        : 'recover',
      strategyId,
      packetId: typeof modelEvent.payload.packetId === 'string' ? modelEvent.payload.packetId : `recovered:${modelEvent.hash}`,
      proposal: structuredClone(proposal),
      usage: object(modelEvent.payload.usage) as unknown as WorkflowStepRecord['usage']
        ?? { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
      outcome,
      ...(causal ? { causal } : {}),
      ...(progress ? { progress } : {}),
    };
    steps.push(reconstructed);
    if (causal) causalHistory.push(causal);
    if (outcome.status === 'completed' && outcome.verification?.passed) {
      for (const evidence of proposal.action.expectedEvidence) {
        if (actionSatisfiesEvidenceRequirement(proposal.action, evidence)) satisfiedEvidence.add(evidence);
      }
    }
  }
  if (!checkpointEvent && steps.length === 0) return undefined;
  return {
    runId: sourceRunId,
    steps,
    sources,
    satisfiedEvidence: [...satisfiedEvidence],
    causalHistory,
    strategies: [...strategies],
    activeStrategyId,
    ...(agentMessages ? { agentMessages } : {}),
    ...(pendingNativeProposals ? { pendingNativeProposals } : {}),
  };
}

export interface WorkflowRunnerOptions {
  model: ModelDriver;
  capabilities: CapabilityRegistry;
  completionOracle?: CompletionOracle;
  contextCompiler?: DynamicContextCompiler;
  ledger?: HashChainLedger;
  now?: () => string;
  pivotAfterRepeatedFailures?: number;
  lifecycle?: DeterministicLifecycle;
}

export type LifecycleStage =
  | 'run_start'
  | 'context_compiled'
  | 'before_action'
  | 'after_action'
  | 'run_finish';

export interface LifecycleHook {
  id: string;
  stage: LifecycleStage;
  order: number;
  failureMode: 'fail_closed' | 'record_and_continue';
  handle(payload: Readonly<Record<string, unknown>>): Record<string, unknown> | void;
}

export class LifecycleHookError extends Error {
  constructor(readonly hookId: string, message: string) {
    super(`Lifecycle hook ${hookId} failed: ${message}`);
    this.name = 'LifecycleHookError';
  }
}

/** Ordered hooks can add telemetry or deterministic policy annotations. They
 * receive a clone and cannot replace workflow state or acquire authority. */
export class DeterministicLifecycle {
  private readonly hooks: LifecycleHook[];

  constructor(hooks: LifecycleHook[] = []) {
    const ids = new Set<string>();
    for (const hook of hooks) {
      if (!hook.id.trim() || ids.has(hook.id) || !Number.isInteger(hook.order)) {
        throw new Error('Lifecycle hooks require unique IDs and integer order values.');
      }
      ids.add(hook.id);
    }
    this.hooks = hooks.map(hook => ({ ...hook })).sort((left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
    );
  }

  dispatch(
    stage: LifecycleStage,
    payload: Record<string, unknown>,
    events?: { append(runId: string, type: string, payload: Record<string, unknown>): unknown },
    runId = '',
  ): Record<string, unknown>[] {
    const annotations: Record<string, unknown>[] = [];
    for (const hook of this.hooks.filter(candidate => candidate.stage === stage)) {
      try {
        const output = hook.handle(Object.freeze(structuredClone(payload)));
        const annotation = output ? structuredClone(output) : {};
        annotations.push({ hookId: hook.id, ...annotation });
        events?.append(runId, 'lifecycle.hook_completed', { hookId: hook.id, stage, annotation });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        events?.append(runId, 'lifecycle.hook_failed', {
          hookId: hook.id, stage, failureMode: hook.failureMode, detail,
        });
        if (hook.failureMode === 'fail_closed') throw new LifecycleHookError(hook.id, detail);
      }
    }
    return annotations;
  }
}

function observationSummary(outcome: ActionOutcome): string {
  if (outcome.observation) {
    const boundedValue = JSON.parse(serializeBoundedModelData(outcome.observation.value, 3_000)) as unknown;
    return serializeBoundedModelData({
      target: outcome.observation.target,
      exists: outcome.observation.exists,
      verification: outcome.verification?.reasonCodes,
      verifiedEvidenceIds: outcome.verification?.evidence.map(evidence => evidence.id) ?? [],
      value: boundedValue,
      valueEncoding: 'bounded_json',
    }, 4_000);
  }
  return outcome.execution?.summary
    ?? outcome.decision.reasonCodes.join(', ')
    ?? outcome.status;
}

function verifiedCompletionEvidence(
  requiredEvidence: string[],
  steps: WorkflowStepRecord[],
): string[] {
  const required = new Set(requiredEvidence);
  return [...new Set(steps.flatMap(step => {
    if (
      step.proposal.kind !== 'action'
      || step.outcome?.status !== 'completed'
      || !step.outcome.verification?.passed
    ) return [];
    const action = step.proposal.action;
    if (!action.expectedEvidence.some(value =>
      required.has(value) && actionSatisfiesEvidenceRequirement(action, value),
    )) return [];
    return step.outcome.verification.evidence.map(evidence => evidence.id);
  }))];
}

function failureSignature(outcome: ActionOutcome): string | undefined {
  if (outcome.status === 'completed') return undefined;
  return [
    outcome.status,
    outcome.execution?.errorCode,
    ...outcome.decision.reasonCodes,
    ...(outcome.verification?.reasonCodes ?? []),
  ].filter(Boolean).join('|');
}

function outcomeCodes(outcome: ActionOutcome): string[] {
  return [
    outcome.status,
    outcome.execution?.errorCode,
    ...outcome.decision.reasonCodes,
    ...(outcome.verification?.reasonCodes ?? []),
  ].filter((value): value is string => !!value);
}

function validateCorrectionRules(rules: CorrectionRule[]): void {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!rule.id.trim() || ids.has(rule.id)) {
      throw new Error(`Correction rule IDs must be non-empty and unique: ${rule.id}.`);
    }
    ids.add(rule.id);
    if (
      rule.triggerCodes.length === 0
      || rule.triggerCodes.some(code => !code.trim())
      || !rule.instruction.trim()
      || !rule.expectedEffect.trim()
      || !Number.isInteger(rule.maxApplications)
      || rule.maxApplications < 1
    ) {
      throw new Error(`Correction rule ${rule.id} is malformed.`);
    }
  }
}

interface PendingCorrection {
  rule: CorrectionRule;
  triggeredByCausalId: string;
  appliedAtStep: number;
  triggerFailureSignature?: string;
  sourceId: string;
}

function correctionSource(
  runId: string,
  step: number,
  causal: CausalRecord,
  rule: CorrectionRule,
  now: string,
): ContextSource {
  return {
    id: `context:${runId}:correction:${rule.id}:${step}`,
    title: `Active correction: ${rule.id}`,
    content: rule.instruction,
    kind: 'constraint',
    authority: 'constraint',
    validity: 'active',
    provenance: [causal.id],
    tags: ['recover', 'correction', ...rule.focusTags],
    createdAt: now,
    priority: 100,
    derivedFrom: [causal.id],
    semanticTag: 'repair',
    confidence: 1,
    rebuildable: true,
  };
}

export class CausalProgressOracle {
  constructor(private readonly pivotAfter = 2) {}

  assess(outcome: ActionOutcome, history: CausalRecord[]): ProgressAssessment {
    const signature = failureSignature(outcome);
    const repeatedFailureCount = signature
      ? history.filter(record => record.failureSignature === signature).length + 1
      : 0;

    if (outcome.status === 'completed') {
      return {
        disposition: 'advanced',
        reasonCodes: ['VERIFIED_ACTION_ADVANCED_WORKFLOW'],
        recovery: 'continue',
        repeatedFailureCount,
      };
    }
    if (outcome.status === 'awaiting_approval') {
      return {
        disposition: 'blocked',
        reasonCodes: ['APPROVAL_REQUIRED'],
        recovery: 'ask',
        failureSignature: signature,
        repeatedFailureCount,
      };
    }
    if (outcome.status === 'denied') {
      return {
        disposition: 'blocked',
        reasonCodes: ['PROPOSAL_DENIED', ...outcome.decision.reasonCodes],
        recovery: repeatedFailureCount >= this.pivotAfter ? 'stop' : 'pivot',
        failureSignature: signature,
        repeatedFailureCount,
      };
    }
    if (
      outcome.status === 'execution_failed'
      && (
        outcome.execution?.reconciliationRequired
        || ['unknown', 'partially_applied'].includes(
          outcome.execution?.effectState ?? '',
        )
      )
      && outcome.execution?.retrySafe !== true
    ) {
      return {
        disposition: 'blocked',
        reasonCodes: ['EFFECT_STATE_REQUIRES_RECONCILIATION'],
        recovery: 'stop',
        failureSignature: signature,
        repeatedFailureCount,
      };
    }
    return {
      disposition: 'stalled',
      reasonCodes: [
        outcome.status === 'execution_failed' ? 'EXECUTION_DID_NOT_ADVANCE' : 'VERIFICATION_DID_NOT_ADVANCE',
      ],
      recovery: repeatedFailureCount >= this.pivotAfter ? 'pivot' : 'retry',
      failureSignature: signature,
      repeatedFailureCount,
    };
  }
}

function evidenceFromOutcome(outcome: ActionOutcome): EvidenceRef[] {
  const evidence = [
    ...(outcome.execution?.evidence ?? []),
    ...(outcome.observation?.evidence ?? []),
    ...(outcome.verification?.evidence ?? []),
  ];
  return [...new Map(evidence.map(item => [item.id, item])).values()];
}

function diagnosticSource(
  runId: string,
  step: number,
  causal: CausalRecord,
  progress: ProgressAssessment,
  now: string,
): ContextSource {
  return {
    id: `context:${runId}:diagnostic:${step}`,
    title: `Step ${step} causal diagnosis`,
    content: JSON.stringify({ causal, progress }),
    kind: 'diagnostic',
    authority: 'evidence',
    validity: 'active',
    provenance: causal.evidenceRefs,
    tags: ['diagnose', 'recover', causal.strategyId],
    createdAt: now,
    priority: progress.recovery === 'pivot' ? 95 : 70,
    derivedFrom: causal.evidenceRefs,
    semanticTag: causal.failureSignature ? 'failure' : 'evidence',
    confidence: 1,
    rebuildable: true,
  };
}

function observationSource(
  runId: string,
  step: number,
  outcome: ActionOutcome,
  now: string,
): ContextSource | undefined {
  if (!outcome.observation) return undefined;
  return {
    id: `context:${runId}:observation:${step}`,
    title: `Observed result from step ${step}`,
    content: observationSummary(outcome),
    kind: 'evidence',
    authority: 'evidence',
    validity: 'active',
    provenance: outcome.observation.evidence.map(evidence => evidence.id),
    tags: ['evidence', 'verify', outcome.observation.target],
    createdAt: now,
    priority: 80,
    derivedFrom: outcome.observation.evidence.map(evidence => evidence.id),
    semanticTag: 'observation',
    confidence: 1,
    rebuildable: true,
  };
}

/** Builds the small inference payload from a complete canonical outcome. Raw
 * observations remain in the ledger; this projection is data, never authority. */
export function projectVerifiedToolResult(
  callId: string,
  action: ActionProposal,
  outcome: ActionOutcome,
  maximumCharacters = 12_000,
): VerifiedToolResultProjection {
  const full = serializeBoundedModelData(outcome.observation?.value ?? null, 64_000);
  const content = serializeBoundedModelData(outcome.observation?.value ?? null, maximumCharacters);
  const observationRefs = outcome.observation?.evidence.map(item => item.id) ?? [];
  const evidenceRefs = outcome.verification?.evidence.map(item => item.id) ?? [];
  const completed = outcome.status === 'completed' && outcome.verification?.passed === true;
  return {
    callId,
    capabilityId: action.capabilityId,
    target: action.target,
    status: completed ? 'completed' : 'failed',
    summary: outcome.execution?.summary
      ?? (completed ? `Verified ${action.capabilityId} at ${action.target}.` : `The ${action.capabilityId} action did not verify.`),
    content,
    evidenceRefs,
    observationRefs,
    ...(full.length > content.length ? {
      omittedContentRef: observationRefs[0] ?? `observation:${action.id}`,
    } : {}),
    ...(outcome.verification?.limitations?.length
      ? { limitations: [...outcome.verification.limitations] }
      : {}),
  };
}

function toolResultMessage(
  runId: string,
  step: number,
  callName: string,
  projection: VerifiedToolResultProjection,
  createdAt: string,
): AgentMessage {
  const block: AgentToolResultBlock = {
    type: 'tool_result',
    callId: projection.callId,
    name: callName,
    status: projection.status,
    summary: projection.summary,
    content: serializeBoundedModelData({
      status: projection.status,
      capabilityId: projection.capabilityId,
      target: projection.target,
      summary: projection.summary,
      observation: JSON.parse(projection.content),
      evidenceRefs: projection.evidenceRefs,
      limitations: projection.limitations ?? [],
      omittedContentRef: projection.omittedContentRef ?? null,
    }, 14_000),
    evidenceRefs: projection.evidenceRefs,
    observationRefs: projection.observationRefs,
    ...(projection.omittedContentRef ? { omittedContentRef: projection.omittedContentRef } : {}),
    ...(projection.status !== 'completed' ? { isError: true } : {}),
  };
  return {
    id: `message:${runId}:tool:${step}:${projection.callId}`,
    role: 'tool',
    content: [block],
    createdAt,
  };
}

function durableAgentMessage(message: AgentMessage): AgentMessage {
  const durable = structuredClone(message);
  delete durable.providerState;
  return durable;
}

export class WorkflowRunner {
  readonly ledger: HashChainLedger;
  private readonly completionOracle: CompletionOracle;
  private readonly contextCompiler: DynamicContextCompiler;
  private readonly now: () => string;
  private readonly progressOracle: CausalProgressOracle;
  private readonly lifecycle: DeterministicLifecycle;

  constructor(private readonly options: WorkflowRunnerOptions) {
    this.ledger = options.ledger ?? new HashChainLedger();
    this.completionOracle = options.completionOracle ?? new RequiredEvidenceCompletionOracle();
    this.contextCompiler = options.contextCompiler ?? new DynamicContextCompiler();
    this.now = options.now ?? (() => new Date().toISOString());
    this.progressOracle = new CausalProgressOracle(options.pivotAfterRepeatedFailures ?? 2);
    this.lifecycle = options.lifecycle ?? new DeterministicLifecycle();
  }

  async run(definition: WorkflowDefinition): Promise<WorkflowRunResult> {
    if (this.ledger.forRun(definition.runId).some(event => event.type === 'workflow.started')) {
      throw new Error(`Run ${definition.runId} already exists in this ledger.`);
    }
    const seed = definition.resumeFrom;
    const steps: WorkflowStepRecord[] = seed?.steps.map(step => structuredClone(step)) ?? [];
    const correctionRules = definition.correctionRules?.map(rule => structuredClone(rule)) ?? [];
    validateCorrectionRules(correctionRules);
    const correctionApplications = new Map<string, number>();
    let pendingCorrection: PendingCorrection | undefined;
    const causalHistory: CausalRecord[] = seed?.causalHistory.map(record => structuredClone(record)) ?? [];
    const agentMessages: AgentMessage[] = seed?.agentMessages?.map(message => structuredClone(message)) ?? [];
    const pendingNativeProposals: PendingNativeProposal[] = seed?.pendingNativeProposals?.map(item => structuredClone(item)) ?? [];
    const sources = [...(seed?.sources ?? []), ...definition.sources].map(source => structuredClone(source));
    const satisfiedEvidence = new Set(seed?.satisfiedEvidence ?? []);
    const strategies = new Set(seed?.strategies ?? [definition.initialStrategyId]);
    let activeStrategyId = seed?.activeStrategyId ?? definition.initialStrategyId;
    let consecutiveModelFailures = 0;
    let consecutiveClarificationRejections = 0;
    let previousCompletionFailure = '';
    let repeatedCompletionFailures = 0;
    const maxSteps = definition.maxSteps ?? 12;
    const maxWallTimeMs = definition.maxWallTimeMs;
    const startedAtMs = Date.now();
    const runtime = new AuthorizedRuntime(new DeterministicPolicyEngine(), this.ledger);

    this.ledger.append(definition.runId, 'workflow.started', {
      intentId: definition.intent.id,
      objective: definition.intent.objective,
      initialStrategyId: activeStrategyId,
      maxSteps,
      maxWallTimeMs,
      correctionRuleIds: correctionRules.map(rule => rule.id),
      resumedFromRunId: seed?.runId,
      resumedVerifiedStepCount: seed?.steps.length ?? 0,
    });
    this.lifecycle.dispatch('run_start', {
      intentId: definition.intent.id,
      objective: definition.intent.objective,
      resumedFromRunId: seed?.runId,
    }, this.ledger, definition.runId);

    const checkpoint = (nextStep: number) => this.ledger.append(definition.runId, 'workflow.checkpoint', {
      nextStep,
      steps: steps.map(step => ({
        ...structuredClone(step),
        ...(step.assistantMessage ? { assistantMessage: durableAgentMessage(step.assistantMessage) } : {}),
      })),
      sources,
      satisfiedEvidence: [...satisfiedEvidence],
      causalHistory,
      strategies: [...strategies],
      activeStrategyId,
      agentMessages: agentMessages.map(durableAgentMessage),
      pendingNativeProposals,
    });

    for (let stepNumber = steps.length + 1; stepNumber <= maxSteps; stepNumber += 1) {
      if (maxWallTimeMs && Date.now() - startedAtMs >= maxWallTimeMs) {
        return this.finish(definition.runId, 'blocked', steps, activeStrategyId, {
          reasonCodes: ['WORKFLOW_WALL_TIME_LIMIT_REACHED'],
        });
      }
      if (definition.signal?.aborted) {
        return this.finish(definition.runId, 'cancelled', steps, activeStrategyId, {
          reasonCodes: ['WORKFLOW_ABORTED'],
        });
      }
      const now = this.now();
      const latestCausal = causalHistory.at(-1);
      const recoveryFocus = latestCausal?.failureSignature ? ['diagnose', 'recover'] : [];
      const packetPhase = recoveryFocus.length
        ? 'diagnose'
        : stepNumber === 1
          ? 'orient'
          : latestCausal?.actionStatus === 'completed'
            ? 'verify'
            : 'act';
      const packet = this.contextCompiler.compile({
        runId: definition.runId,
        phase: packetPhase,
        objective: definition.intent.objective,
        constraints: definition.constraints,
        strategyId: activeStrategyId,
        focusTags: [
          ...(definition.focusTags ?? []),
          ...recoveryFocus,
          ...(packetPhase === 'verify' ? ['verify', 'observation'] : []),
          activeStrategyId,
        ],
        sources,
        tokenBudget: definition.tokenBudget ?? 4_000,
        now,
      });
      const registeredCapabilityManifests = this.options.capabilities.manifests();
      const authorizedCapabilities = definition.intent.authorizedCapabilities;
      const capabilityManifests = authorizedCapabilities
        ? registeredCapabilityManifests.filter(manifest =>
            authorizedCapabilities.includes(manifest.id)
            && (!definition.proposalCapabilityIds || definition.proposalCapabilityIds.includes(manifest.id)),
          )
        : registeredCapabilityManifests;
      this.ledger.append(definition.runId, 'context.compiled', {
        step: stepNumber,
        packetId: packet.id,
        phase: packet.phase,
        objective: packet.objective,
        strategyId: packet.strategyId,
        legalCapabilityIds: capabilityManifests.map(manifest => manifest.id),
        outputContract: ['action', 'pivot', 'ask', 'complete'],
        requiredEvidence: definition.intent.requiredEvidence,
        riskBudget: definition.intent.riskBudget,
        includedSourceIds: packet.items.map(item => item.sourceId),
        excludedSourceIds: packet.excludedSourceIds,
        exclusions: packet.exclusions,
        estimatedTokens: packet.estimatedTokens,
        tokenBudget: packet.tokenBudget,
        audit: packet.audit,
        items: packet.items,
      });
      const contextSignals = detectContextSignals({ objective: definition.intent.objective, sources });
      if (contextSignals.length > 0) this.ledger.append(definition.runId, 'context.signals_detected', {
        step: stepNumber,
        packetId: packet.id,
        signals: contextSignals,
      });
      this.lifecycle.dispatch('context_compiled', {
        step: stepNumber,
        packetId: packet.id,
        phase: packet.phase,
        includedSourceIds: packet.items.map(item => item.sourceId),
        excludedSourceIds: packet.excludedSourceIds,
      }, this.ledger, definition.runId);

      if (agentMessages.length === 0) {
        agentMessages.push({
          id: `message:${definition.runId}:user:${packet.id}`,
          role: 'user',
          content: [{ type: 'text', text: `CURRENT TASK\n${renderContextPacket(packet)}` }],
          createdAt: now,
        });
      }

      let modelResult: ModelProposalResult;
      const queuedNativeProposal = pendingNativeProposals.shift();
      try {
        if (queuedNativeProposal) {
          modelResult = {
            proposal: queuedNativeProposal.proposal,
            proposalToolCallId: queuedNativeProposal.toolCallId,
            proposalToolName: queuedNativeProposal.toolName,
            model: queuedNativeProposal.model,
            usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
          };
          this.ledger.append(definition.runId, 'model.queued_tool_selected', {
            step: stepNumber,
            toolCallId: queuedNativeProposal.toolCallId,
            toolName: queuedNativeProposal.toolName,
            proposal: queuedNativeProposal.proposal,
          });
        } else {
          modelResult = await this.options.model.propose(
            packet,
            capabilityManifests,
            {
              intentId: definition.intent.id,
              principalId: definition.intent.principals[0] ?? '',
              authorizedCapabilityIds: capabilityManifests.map(manifest => manifest.id),
              requiredConditionIds: definition.intent.requiredConditionIds,
              requiredEvidence: definition.intent.requiredEvidence,
              riskBudget: definition.intent.riskBudget,
              activeStrategyId,
              agentMessages,
              completionEvidenceRefs: definition.intent.requiredEvidence.every(value => satisfiedEvidence.has(value))
                ? verifiedCompletionEvidence(definition.intent.requiredEvidence, steps)
                : [],
              inferencePurpose: definition.intent.requiredEvidence.every(value => satisfiedEvidence.has(value))
                ? 'completion'
                : packet.phase === 'diagnose' || packet.phase === 'recover'
                  ? 'diagnosis'
                  : 'tool_selection',
            },
            definition.signal,
          );
          for (const additional of modelResult.additionalProposals ?? []) {
            pendingNativeProposals.push({ ...structuredClone(additional), model: modelResult.model });
          }
        }
      } catch (error) {
        if (definition.signal?.aborted) {
          return this.finish(definition.runId, 'cancelled', steps, activeStrategyId, {
            reasonCodes: ['WORKFLOW_ABORTED_DURING_MODEL_REQUEST'],
          });
        }
        const reason = error instanceof Error ? error.message : String(error);
        this.ledger.append(definition.runId, 'model.proposal_failed', { step: stepNumber, reason });
        if (definition.intent.requiredEvidence.every(value => satisfiedEvidence.has(value))) {
          const proposal: WorkflowCompleteProposal = {
            kind: 'complete',
            strategyId: activeStrategyId,
            evidenceRefs: verifiedCompletionEvidence(definition.intent.requiredEvidence, steps),
          };
          const completion = await this.completionOracle.verify({
            intent: definition.intent,
            proposal,
            satisfiedEvidence: [...satisfiedEvidence],
            steps,
          });
          if (completion.passed) {
            steps.push({
              step: stepNumber,
              phase: 'complete',
              strategyId: activeStrategyId,
              packetId: packet.id,
              proposal,
              usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
            });
            this.ledger.append(definition.runId, 'workflow.model_failure_recovered', {
              step: stepNumber,
              reason,
              recovery: 'deterministic_verified_completion',
              evidenceRefs: proposal.evidenceRefs,
            });
            this.ledger.append(definition.runId, 'workflow.completion_checked', {
              step: stepNumber,
              passed: true,
              reasonCodes: completion.reasonCodes,
              evidence: completion.evidence,
              deterministicRecovery: true,
            });
            return this.finish(definition.runId, 'completed', steps, activeStrategyId, {
              completion,
              reasonCodes: ['MODEL_FAILED_AFTER_VERIFIED_OUTCOME', 'COMPLETION_ORACLE_PASSED'],
            });
          }
        }
        consecutiveModelFailures += 1;
        if (consecutiveModelFailures >= 2) {
          return this.finish(definition.runId, 'blocked', steps, activeStrategyId, {
            reasonCodes: ['MODEL_PROPOSAL_FAILED_REPEATEDLY'],
          });
        }
        sources.push({
          id: `context:${definition.runId}:model-failure:${stepNumber}`,
          title: 'Previous proposal was rejected at the canonical boundary',
          content: `${reason} Return exactly one valid proposal using the supplied scope and capability schema.`,
          kind: 'diagnostic',
          authority: 'evidence',
          validity: 'active',
          provenance: [`model-failure:${stepNumber}`],
          tags: ['diagnose', 'recover', activeStrategyId],
          createdAt: now,
          priority: 100,
          semanticTag: 'failure',
          confidence: 1,
          rebuildable: true,
        });
        checkpoint(stepNumber + 1);
        continue;
      }

      const proposal = modelResult.proposal;
      if (modelResult.assistantMessage) {
        agentMessages.push(structuredClone(modelResult.assistantMessage));
        this.ledger.append(definition.runId, 'model.assistant_message', {
          step: stepNumber,
          message: durableAgentMessage(modelResult.assistantMessage),
          providerContinuationRetainedInMemory: !!modelResult.assistantMessage.providerState,
        });
      }
      if (definition.signal?.aborted) {
        return this.finish(definition.runId, 'cancelled', steps, activeStrategyId, {
          reasonCodes: ['WORKFLOW_ABORTED_AFTER_MODEL_REQUEST'],
        });
      }
      consecutiveModelFailures = 0;
      this.ledger.append(definition.runId, 'model.proposed', {
        step: stepNumber,
        packetId: packet.id,
        model: modelResult.model,
        proposal,
        usage: modelResult.usage,
        requestAudit: modelResult.requestAudit,
      });

      if (proposal.strategyId !== activeStrategyId && proposal.kind !== 'pivot') {
        this.ledger.append(definition.runId, 'model.proposal_rejected', {
          step: stepNumber,
          reasonCode: 'STRATEGY_MISMATCH',
          expectedStrategyId: activeStrategyId,
          proposedStrategyId: proposal.strategyId,
        });
        return this.finish(definition.runId, 'blocked', steps, activeStrategyId, {
          reasonCodes: ['STRATEGY_MISMATCH'],
        });
      }

      if (proposal.kind === 'ask') {
        const clarification = definition.clarificationPolicy?.({
          proposal,
          intent: structuredClone(definition.intent),
          sources: sources.map(source => structuredClone(source)),
          availableCapabilities: capabilityManifests.map(manifest => structuredClone(manifest)),
          step: stepNumber,
        });
        if (clarification && !clarification.allowed) {
          consecutiveClarificationRejections += 1;
          this.ledger.append(definition.runId, 'workflow.clarification_rejected', {
            step: stepNumber,
            packetId: packet.id,
            question: proposal.question,
            proposalReason: proposal.reason,
            reasonCode: clarification.reasonCode,
          });
          sources.push({
            id: `context:${definition.runId}:clarification-policy:${stepNumber}`,
            title: 'Clarification policy rejected an unnecessary question',
            content: clarification.instruction
              ?? 'Proceed with reasonable, reversible defaults using the supplied objective, conversation context, and bounded capabilities. Do not ask the same preference question again.',
            kind: 'constraint',
            authority: 'constraint',
            validity: 'active',
            provenance: [`clarification-policy:${clarification.reasonCode}`],
            tags: ['constraint', 'repair', activeStrategyId],
            createdAt: now,
            priority: 100,
            semanticTag: 'constraint',
            confidence: 1,
            rebuildable: true,
          });
          checkpoint(stepNumber + 1);
          if (consecutiveClarificationRejections >= 2) {
            return this.finish(definition.runId, 'blocked', steps, activeStrategyId, {
              reasonCodes: ['CLARIFICATION_POLICY_REJECTED_REPEATEDLY'],
            });
          }
          continue;
        }
        steps.push({
          step: stepNumber,
          phase: packet.phase,
          strategyId: activeStrategyId,
          packetId: packet.id,
          proposal,
          usage: modelResult.usage,
          assistantMessage: modelResult.assistantMessage,
        });
        return this.finish(definition.runId, 'needs_input', steps, activeStrategyId, {
          question: proposal.question,
          reasonCodes: ['MODEL_REQUESTED_USER_DECISION'],
        });
      }

      consecutiveClarificationRejections = 0;

      if (proposal.kind === 'pivot') {
        if (
          proposal.fromStrategyId !== activeStrategyId
          || proposal.strategyId === activeStrategyId
          || strategies.has(proposal.strategyId)
        ) {
          return this.finish(definition.runId, 'blocked', steps, activeStrategyId, {
            reasonCodes: ['INVALID_OR_CYCLIC_PIVOT'],
          });
        }
        steps.push({
          step: stepNumber,
          phase: 'recover',
          strategyId: activeStrategyId,
          packetId: packet.id,
          proposal,
          usage: modelResult.usage,
          assistantMessage: modelResult.assistantMessage,
        });
        strategies.add(proposal.strategyId);
        activeStrategyId = proposal.strategyId;
        sources.push({
          id: `context:${definition.runId}:pivot:${stepNumber}`,
          title: `Strategy pivot at step ${stepNumber}`,
          content: JSON.stringify({
            from: proposal.fromStrategyId,
            to: proposal.strategyId,
            cause: proposal.cause,
          }),
          kind: 'decision',
          authority: 'evidence',
          validity: 'active',
          provenance: [`model-proposal:${stepNumber}`],
          tags: ['recover', 'strategy', proposal.strategyId],
          createdAt: now,
          priority: 90,
          semanticTag: 'decision',
          confidence: 1,
          rebuildable: true,
        });
        this.ledger.append(definition.runId, 'workflow.pivoted', {
          step: stepNumber,
          fromStrategyId: proposal.fromStrategyId,
          strategyId: proposal.strategyId,
          cause: proposal.cause,
        });
        checkpoint(stepNumber + 1);
        continue;
      }

      if (proposal.kind === 'complete') {
        const completion = await this.completionOracle.verify({
          intent: definition.intent,
          proposal,
          satisfiedEvidence: [...satisfiedEvidence],
          steps,
        });
        steps.push({
          step: stepNumber,
          phase: 'complete',
          strategyId: activeStrategyId,
          packetId: packet.id,
          proposal,
          usage: modelResult.usage,
          assistantMessage: modelResult.assistantMessage,
        });
        this.ledger.append(definition.runId, 'workflow.completion_checked', {
          step: stepNumber,
          passed: completion.passed,
          reasonCodes: completion.reasonCodes,
          evidence: completion.evidence,
        });
        if (completion.passed) {
          return this.finish(definition.runId, 'completed', steps, activeStrategyId, {
            completion,
            reasonCodes: ['COMPLETION_ORACLE_PASSED'],
          });
        }
        const completionFailure = completion.reasonCodes.slice().sort().join('|');
        repeatedCompletionFailures = completionFailure === previousCompletionFailure
          ? repeatedCompletionFailures + 1
          : 1;
        previousCompletionFailure = completionFailure;
        if (repeatedCompletionFailures >= 2) {
          return this.finish(definition.runId, 'blocked', steps, activeStrategyId, {
            reasonCodes: [
              'REPEATED_COMPLETION_REJECTION',
              ...completion.reasonCodes,
            ],
          });
        }
        sources.push({
          id: `context:${definition.runId}:completion-rejected:${stepNumber}`,
          title: 'Completion claim rejected',
          content: completion.reasonCodes.join('\n'),
          kind: 'diagnostic',
          authority: 'evidence',
          validity: 'active',
          provenance: completion.evidence.map(evidence => evidence.id),
          tags: ['verify', 'diagnose', activeStrategyId],
          createdAt: now,
          priority: 100,
        });
        checkpoint(stepNumber + 1);
        continue;
      }

      const capability = this.options.capabilities.get(proposal.action.capabilityId);
      if (!capability) {
        this.ledger.append(definition.runId, 'model.proposal_rejected', {
          step: stepNumber,
          reasonCode: 'UNKNOWN_CAPABILITY',
          capabilityId: proposal.action.capabilityId,
        });
        return this.finish(definition.runId, 'blocked', steps, activeStrategyId, {
          reasonCodes: [`UNKNOWN_CAPABILITY:${proposal.action.capabilityId}`],
        });
      }
      if (capability.manifest.inputSchema) {
        const input = validateJsonSchema(capability.manifest.inputSchema, proposal.action.args);
        if (!input.valid) {
          this.ledger.append(definition.runId, 'model.proposal_rejected', {
            step: stepNumber,
            reasonCode: 'CAPABILITY_INPUT_SCHEMA_MISMATCH',
            capabilityId: proposal.action.capabilityId,
            errors: input.errors,
          });
          return this.finish(definition.runId, 'blocked', steps, activeStrategyId, {
            reasonCodes: [
              `CAPABILITY_INPUT_SCHEMA_MISMATCH:${proposal.action.capabilityId}`,
              ...input.errors,
            ],
          });
        }
      }
      this.lifecycle.dispatch('before_action', {
        step: stepNumber,
        proposalId: proposal.action.id,
        capabilityId: proposal.action.capabilityId,
        target: proposal.action.target,
      }, this.ledger, definition.runId);
      let outcome = await runtime.execute({
        runId: definition.runId,
        now,
        intent: definition.intent,
        conditions: definition.conditions,
        proposal: proposal.action,
        capability,
        approval: definition.approvalFor?.(proposal.action.id),
        signal: definition.signal,
      });
      if (outcome.status === 'awaiting_approval' && definition.requestApprovalFor) {
        this.ledger.append(definition.runId, 'workflow.approval_requested', {
          step: stepNumber,
          proposalId: proposal.action.id,
          capabilityId: proposal.action.capabilityId,
          target: proposal.action.target,
          risk: proposal.action.risk,
          declaredEffects: proposal.action.declaredEffects,
        });
        const approval = await definition.requestApprovalFor(proposal.action.id);
        this.ledger.append(definition.runId, 'workflow.approval_resolved', {
          step: stepNumber,
          proposalId: proposal.action.id,
          approved: !!approval,
        });
        if (approval) {
          outcome = await runtime.execute({
            runId: definition.runId,
            now: this.now(),
            intent: definition.intent,
            conditions: definition.conditions,
            proposal: proposal.action,
            capability,
            approval,
            signal: definition.signal,
          });
        }
      }
      this.lifecycle.dispatch('after_action', {
        step: stepNumber,
        proposalId: proposal.action.id,
        status: outcome.status,
        receiptHash: outcome.receiptHash,
      }, this.ledger, definition.runId);
      const signature = failureSignature(outcome);
      const causal: CausalRecord = {
        id: `causal:${definition.runId}:${stepNumber}`,
        step: stepNumber,
        strategyId: activeStrategyId,
        hypothesis: proposal.hypothesis,
        predictedObservation: proposal.expectedObservation,
        actionProposalId: proposal.action.id,
        actionStatus: outcome.status,
        actualObservation: observationSummary(outcome),
        environmentChanged: outcome.status === 'completed'
          && proposal.action.declaredEffects.some(effect =>
            effect === 'state.write' || effect === 'state.delete',
          ),
        failureSignature: signature,
        evidenceRefs: evidenceFromOutcome(outcome).map(evidence => evidence.id),
      };
      const progress = this.progressOracle.assess(outcome, causalHistory);
      causalHistory.push(causal);

      if (pendingCorrection) {
        const disposition: CorrectionAssessment['disposition'] = outcome.status === 'completed'
          ? 'improved'
          : signature === pendingCorrection.triggerFailureSignature
            ? 'not_improved'
            : 'inconclusive';
        const assessment: CorrectionAssessment = {
          ruleId: pendingCorrection.rule.id,
          triggeredByCausalId: pendingCorrection.triggeredByCausalId,
          appliedAtStep: pendingCorrection.appliedAtStep,
          assessedAtStep: stepNumber,
          disposition,
          expectedEffect: pendingCorrection.rule.expectedEffect,
          observedActionStatus: outcome.status,
          observedFailureSignature: signature,
        };
        this.ledger.append(definition.runId, 'correction.assessed', {
          ...assessment,
        });
        const activeSource = sources.find(source => source.id === pendingCorrection?.sourceId);
        if (activeSource) activeSource.validity = 'superseded';
        pendingCorrection = undefined;
      }
      if (outcome.status === 'completed') {
        for (const requirement of proposal.action.expectedEvidence) {
          if (actionSatisfiesEvidenceRequirement(proposal.action, requirement)) {
            satisfiedEvidence.add(requirement);
          }
        }
      }

      const step: WorkflowStepRecord = {
        step: stepNumber,
        phase: packet.phase,
        strategyId: activeStrategyId,
        packetId: packet.id,
        proposal,
        usage: modelResult.usage,
        outcome,
        causal,
        progress,
        assistantMessage: modelResult.assistantMessage,
      };
      steps.push(step);
      this.ledger.append(definition.runId, 'workflow.progress_assessed', {
        step: stepNumber,
        causal,
        progress,
      });
      const observed = observationSource(definition.runId, stepNumber, outcome, now);
      if (observed) sources.push(observed);
      sources.push(diagnosticSource(definition.runId, stepNumber, causal, progress, now));
      const nativeCall = modelResult.proposalToolCallId && modelResult.proposalToolName
        ? { callId: modelResult.proposalToolCallId, name: modelResult.proposalToolName }
        : undefined;
      if (nativeCall) {
        const projection = projectVerifiedToolResult(nativeCall.callId, proposal.action, outcome);
        const resultMessage = toolResultMessage(
          definition.runId,
          stepNumber,
          nativeCall.name,
          projection,
          now,
        );
        agentMessages.push(resultMessage);
        this.ledger.append(definition.runId, 'model.tool_result_message', {
          step: stepNumber,
          message: resultMessage,
          projection,
        });
      }

      if (
        definition.completeAfterVerifiedAction
        && outcome.status === 'completed'
        && definition.intent.requiredEvidence.every(value => satisfiedEvidence.has(value))
      ) {
        const completionProposal: WorkflowCompleteProposal = {
          kind: 'complete',
          strategyId: activeStrategyId,
          evidenceRefs: verifiedCompletionEvidence(definition.intent.requiredEvidence, steps),
        };
        const completion = await this.completionOracle.verify({
          intent: definition.intent,
          proposal: completionProposal,
          satisfiedEvidence: [...satisfiedEvidence],
          steps,
        });
        this.ledger.append(definition.runId, 'workflow.completion_checked', {
          step: stepNumber,
          passed: completion.passed,
          reasonCodes: completion.reasonCodes,
          evidence: completion.evidence,
          deterministicFastPath: true,
        });
        if (completion.passed) {
          return this.finish(definition.runId, 'completed', steps, activeStrategyId, {
            completion,
            reasonCodes: ['VERIFIED_SINGLE_ACTION_FAST_PATH', 'COMPLETION_ORACLE_PASSED'],
          });
        }
      }

      if (outcome.status === 'execution_failed' || outcome.status === 'verification_failed') {
        const codes = outcomeCodes(outcome);
        const rule = correctionRules.find(candidate =>
          (correctionApplications.get(candidate.id) ?? 0) < candidate.maxApplications
          && candidate.triggerCodes.some(code => codes.includes(code)),
        );
        if (rule) {
          const applied = (correctionApplications.get(rule.id) ?? 0) + 1;
          correctionApplications.set(rule.id, applied);
          const source = correctionSource(definition.runId, stepNumber, causal, rule, now);
          sources.push(source);
          pendingCorrection = {
            rule,
            triggeredByCausalId: causal.id,
            appliedAtStep: stepNumber,
            triggerFailureSignature: signature,
            sourceId: source.id,
          };
          this.ledger.append(definition.runId, 'correction.applied', {
            ruleId: rule.id,
            triggeredByCausalId: causal.id,
            appliedAtStep: stepNumber,
            application: applied,
            triggerCodes: codes.filter(code => rule.triggerCodes.includes(code)),
            instruction: rule.instruction,
            expectedEffect: rule.expectedEffect,
            sourceId: source.id,
          });
        }
      }
      checkpoint(stepNumber + 1);

      if (definition.signal?.aborted) {
        return this.finish(definition.runId, 'cancelled', steps, activeStrategyId, {
          reasonCodes: ['WORKFLOW_ABORTED_AFTER_ACTION_RECONCILIATION'],
        });
      }

      if (outcome.status === 'awaiting_approval') {
        return this.finish(definition.runId, 'needs_approval', steps, activeStrategyId, {
          reasonCodes: ['PROPOSAL_SCOPED_APPROVAL_REQUIRED'],
        });
      }
      if (progress.recovery === 'stop') {
        return this.finish(definition.runId, 'blocked', steps, activeStrategyId, {
          reasonCodes: progress.reasonCodes.includes('EFFECT_STATE_REQUIRES_RECONCILIATION')
            ? ['EFFECT_STATE_REQUIRES_RECONCILIATION']
            : ['REPEATED_DENIED_PROPOSAL'],
        });
      }
    }

    return this.finish(definition.runId, 'step_limit', steps, activeStrategyId, {
      reasonCodes: ['WORKFLOW_STEP_LIMIT_REACHED'],
    });
  }

  private finish(
    runId: string,
    status: WorkflowRunResult['status'],
    steps: WorkflowStepRecord[],
    activeStrategyId: string,
    options: {
      completion?: CompletionAssessment;
      question?: string;
      reasonCodes: string[];
    },
  ): WorkflowRunResult {
    this.lifecycle.dispatch('run_finish', {
      status,
      activeStrategyId,
      stepCount: steps.length,
      reasonCodes: options.reasonCodes,
    }, this.ledger, runId);
    const receipt = this.ledger.append(runId, 'workflow.receipt', {
      status,
      activeStrategyId,
      steps: steps.length,
      completionPassed: options.completion?.passed,
      reasonCodes: options.reasonCodes,
    });
    return {
      runId,
      status,
      steps,
      activeStrategyId,
      completion: options.completion,
      question: options.question,
      reasonCodes: options.reasonCodes,
      receiptHash: receipt.hash,
    };
  }
}

export interface WorkflowChildPlan {
  runner: WorkflowRunner;
  conditions: Condition[];
  constraints: string[];
  initialStrategyId: string;
  focusTags?: string[];
  tokenBudget?: number;
  maxSteps?: number;
  output?: (result: WorkflowRunResult) => unknown;
}

export type WorkflowChildPlanFactory = (
  request: ChildRuntimeRequest,
) => WorkflowChildPlan | Promise<WorkflowChildPlan>;

/**
 * Adapts the same WorkflowRunner used by a parent into the narrow executor
 * interface accepted by the delegation package. The adapter, not the child
 * model, fixes the child intent, context view, run ID, and budget ceilings.
 */
export class WorkflowChildRuntimeExecutor implements ChildRuntimeExecutor {
  constructor(private readonly factory: WorkflowChildPlanFactory) {}

  async run(request: ChildRuntimeRequest): Promise<DelegationResult> {
    const started = performance.now();
    const plan = await this.factory(request);
    const result = await plan.runner.run({
      runId: request.contract.childRunId,
      intent: request.childIntent,
      conditions: plan.conditions,
      constraints: plan.constraints,
      sources: request.context,
      initialStrategyId: plan.initialStrategyId,
      focusTags: plan.focusTags,
      tokenBudget: Math.min(
        request.contract.budget.tokenBudget,
        plan.tokenBudget ?? request.contract.budget.tokenBudget,
      ),
      maxSteps: Math.min(
        request.contract.budget.actionBudget,
        plan.maxSteps ?? request.contract.budget.actionBudget,
      ),
      signal: request.signal,
    });
    const actionSteps = result.steps.filter(step => step.proposal.kind === 'action');
    const evidenceRefs = [...new Set(result.steps.flatMap(step => [
      ...(step.outcome?.execution?.evidence.map(evidence => evidence.id) ?? []),
      ...(step.outcome?.observation?.evidence.map(evidence => evidence.id) ?? []),
      ...(step.outcome?.verification?.evidence.map(evidence => evidence.id) ?? []),
    ]))];
    const policyViolations = result.steps.flatMap(step =>
      step.outcome?.status === 'denied'
        ? step.outcome.decision.reasonCodes.map(reason => `DENIED_ACTION_ATTEMPT:${reason}`)
        : [],
    );
    const completed = result.status === 'completed' && result.completion?.passed === true;
    const status = result.status === 'completed'
      ? 'completed'
      : result.status === 'needs_input'
        ? 'needs_input'
        : result.status === 'needs_approval'
          ? 'needs_approval'
          : result.status === 'step_limit'
            ? 'step_limit'
            : 'failed';
    const failure = completed ? undefined : {
      type: result.status === 'step_limit' ? 'budget_exhausted' as const : 'verification_failed' as const,
      message: result.reasonCodes.join(', '),
      recoverableByChild: result.status !== 'needs_input' && result.status !== 'needs_approval',
      recommendedEscalation: result.status === 'needs_input' || result.status === 'needs_approval'
        ? 'parent' as const
        : 'child' as const,
      evidenceRefs,
    };

    return {
      delegationId: request.contract.id,
      childRunId: request.contract.childRunId,
      status,
      output: plan.output?.(result) ?? {
        status: result.status,
        reasonCodes: result.reasonCodes,
      },
      evidenceRefs,
      policyViolations,
      verificationPassed: completed,
      budgetUsage: {
        inputTokens: result.steps.reduce((total, step) => total + step.usage.inputTokens, 0),
        outputTokens: result.steps.reduce((total, step) => total + step.usage.outputTokens, 0),
        actions: actionSteps.length,
        wallTimeMs: Math.max(0, performance.now() - started),
      },
      childReceiptHash: result.receiptHash,
      failure,
    };
  }
}

export interface OutcomeVerifier {
  readonly id: string;
  verify(request: SemanticVerificationRequest): Promise<VerificationResult>;
}

export class VerifierRegistry {
  private readonly verifiers = new Map<string, OutcomeVerifier>();

  register(verifier: OutcomeVerifier): this {
    if (this.verifiers.has(verifier.id)) throw new Error(`Verifier ${verifier.id} is already registered.`);
    this.verifiers.set(verifier.id, verifier);
    return this;
  }

  async verify(ids: string[], request: SemanticVerificationRequest): Promise<VerificationResult> {
    if (ids.length === 0) throw new Error('At least one verifier is required.');
    const results = await Promise.all(ids.map(async id => {
      const verifier = this.verifiers.get(id);
      if (!verifier) throw new Error(`Verifier ${id} is not registered.`);
      return verifier.verify(request);
    }));
    return {
      passed: results.every(result => result.passed),
      reasonCodes: results.flatMap(result => result.reasonCodes),
      evidence: results.flatMap(result => result.evidence),
      establishes: [...new Set(results.flatMap(result => result.establishes ?? []))],
      limitations: [...new Set(results.flatMap(result => result.limitations ?? []))],
      verifierIds: ids,
    };
  }
}

export class StructuralOutcomeVerifier implements OutcomeVerifier {
  readonly id = 'structural';
  async verify(request: SemanticVerificationRequest): Promise<VerificationResult> {
    const passed = request.claims.length > 0 && request.evidence.length > 0;
    return {
      passed,
      reasonCodes: [passed ? 'STRUCTURE_AND_EVIDENCE_PRESENT' : 'STRUCTURE_OR_EVIDENCE_MISSING'],
      evidence: request.evidence,
      establishes: passed ? ['required structure and evidence references are present'] : [],
      limitations: ['does not establish factual correctness or goal alignment'],
      verifierIds: [this.id],
    };
  }
}

export class FreshnessOutcomeVerifier implements OutcomeVerifier {
  readonly id = 'freshness';
  constructor(private readonly maximumAgeMs: number) {}
  async verify(request: SemanticVerificationRequest): Promise<VerificationResult> {
    const cutoff = Date.parse(request.now) - this.maximumAgeMs;
    const stale = request.evidence.filter(item => {
      const match = item.source.match(/(?:^|@)(\d{4}-\d\d-\d\dT[^@]+)$/);
      return match ? Date.parse(match[1]!) < cutoff : true;
    });
    return {
      passed: stale.length === 0,
      reasonCodes: stale.length ? ['EVIDENCE_FRESHNESS_NOT_ESTABLISHED'] : ['EVIDENCE_WITHIN_FRESHNESS_WINDOW'],
      evidence: request.evidence,
      establishes: stale.length ? [] : [`evidence age is at most ${this.maximumAgeMs}ms`],
      limitations: ['does not establish truth beyond evidence recency'],
      verifierIds: [this.id],
    };
  }
}

export interface ComposedWorkflowOptions {
  runId: string;
  now: () => string;
  conditions: Condition[];
  facts?: Record<string, unknown>;
  approvalFor?: (proposalId: string) => Approval | undefined;
  approveGate?: (nodeId: string, reason: string) => Promise<boolean>;
}

export interface DeterministicStepExecutor {
  readonly id: string;
  execute(input: Readonly<Record<string, unknown>>, facts: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
}

export interface BoundedModelOperationExecutor {
  execute(request: {
    runId: string;
    nodeId: string;
    operation: string;
    input: Readonly<Record<string, unknown>>;
    facts: Readonly<Record<string, unknown>>;
    outputSchema: Extract<WorkflowNode, { kind: 'model' }>['outputSchema'];
  }): Promise<unknown>;
}

export interface ComposedWorkflowServices {
  deterministicSteps?: DeterministicStepExecutor[];
  modelOperations?: BoundedModelOperationExecutor;
}

function matchesPredicate(predicate: Extract<WorkflowNode, { kind: 'choice' | 'loop' }>['predicate'], facts: Record<string, unknown>): boolean {
  const present = Object.hasOwn(facts, predicate.fact);
  if (predicate.operator === 'exists') return present;
  if (!present) return false;
  return predicate.operator === 'equals'
    ? Object.is(facts[predicate.fact], predicate.value)
    : !Object.is(facts[predicate.fact], predicate.value);
}

function narrows(parent: IntentContract, child: IntentContract): boolean {
  const subset = <T>(values: T[], allowed: T[]) => values.every(value => allowed.includes(value));
  return child.principals.every(value => parent.principals.includes(value))
    && child.authorizedResources.every(value => parent.authorizedResources.includes(value))
    && subset(child.authorizedCapabilities ?? [], parent.authorizedCapabilities ?? [])
    && parent.prohibitedEffects.every(value => child.prohibitedEffects.includes(value))
    && child.riskBudget <= parent.riskBudget
    && child.approvalAboveRisk <= parent.approvalAboveRisk;
}

/** Deterministic interpreter; every action node still crosses AuthorizedRuntime. */
export class ComposedWorkflowRunner {
  private readonly deterministicSteps: Map<string, DeterministicStepExecutor>;

  constructor(
    private readonly runtime: AuthorizedRuntime,
    private readonly capabilities: CapabilityRegistry,
    private readonly verifiers: VerifierRegistry,
    private readonly services: ComposedWorkflowServices = {},
  ) {
    this.deterministicSteps = new Map(
      (services.deterministicSteps ?? []).map(step => [step.id, step]),
    );
    if (this.deterministicSteps.size !== (services.deterministicSteps ?? []).length) {
      throw new Error('Deterministic workflow step IDs must be unique.');
    }
  }

  async run(plan: ComposedWorkflowPlan, options: ComposedWorkflowOptions): Promise<WorkflowNodeResult[]> {
    const results: WorkflowNodeResult[] = [];
    const observations: Observation[] = [];
    const evidence: EvidenceRef[] = [];
    const facts = { ...(options.facts ?? {}) };
    const visit = async (node: WorkflowNode, intent: IntentContract): Promise<WorkflowNodeResult> => {
      this.runtime.ledger.append(options.runId, 'workflow.node_started', { nodeId: node.id, kind: node.kind });
      let result: WorkflowNodeResult;
      if (node.kind === 'action') {
        const capability = this.capabilities.get(node.proposal.capabilityId);
        if (!capability) result = { nodeId: node.id, status: 'blocked', reasonCodes: ['CAPABILITY_UNAVAILABLE'], evidence: [] };
        else {
          const actionOutcome = await this.runtime.execute({
            runId: options.runId,
            now: options.now(),
            intent,
            conditions: options.conditions,
            proposal: node.proposal,
            capability,
            approval: options.approvalFor?.(node.proposal.id),
          });
          if (actionOutcome.observation) observations.push(actionOutcome.observation);
          const actionEvidence = actionOutcome.verification?.evidence ?? actionOutcome.execution?.evidence ?? [];
          evidence.push(...actionEvidence);
          facts[`action:${node.id}:status`] = actionOutcome.status;
          result = {
            nodeId: node.id,
            status: actionOutcome.status === 'completed' ? 'completed' : 'failed',
            reasonCodes: actionOutcome.verification?.reasonCodes ?? actionOutcome.decision.reasonCodes,
            evidence: actionEvidence,
            actionOutcome,
          };
        }
      } else if (node.kind === 'deterministic') {
        const adapter = this.deterministicSteps.get(node.adapterId);
        if (!adapter) {
          result = { nodeId: node.id, status: 'blocked', reasonCodes: ['DETERMINISTIC_ADAPTER_UNAVAILABLE'], evidence: [] };
        } else {
          const output = await adapter.execute(
            Object.freeze(structuredClone(node.input)),
            Object.freeze(structuredClone(facts)),
          );
          const validation = validateJsonSchema(node.outputSchema, output);
          if (!validation.valid) {
            result = { nodeId: node.id, status: 'failed', reasonCodes: ['DETERMINISTIC_OUTPUT_SCHEMA_INVALID', ...validation.errors], evidence: [] };
          } else {
            facts[node.outputFact] = structuredClone(output);
            this.runtime.ledger.append(options.runId, 'workflow.fact_recorded', {
              nodeId: node.id, fact: node.outputFact, source: `deterministic:${node.adapterId}`, value: output,
            });
            result = { nodeId: node.id, status: 'completed', reasonCodes: ['DETERMINISTIC_STEP_COMPLETED'], evidence: [] };
          }
        }
      } else if (node.kind === 'model') {
        if (!this.services.modelOperations) {
          result = { nodeId: node.id, status: 'blocked', reasonCodes: ['MODEL_OPERATION_UNAVAILABLE'], evidence: [] };
        } else {
          const output = await this.services.modelOperations.execute({
            runId: options.runId,
            nodeId: node.id,
            operation: node.operation,
            input: Object.freeze(structuredClone(node.input)),
            facts: Object.freeze(structuredClone(facts)),
            outputSchema: structuredClone(node.outputSchema),
          });
          const validation = validateJsonSchema(node.outputSchema, output);
          if (!validation.valid) {
            result = { nodeId: node.id, status: 'failed', reasonCodes: ['MODEL_OUTPUT_SCHEMA_INVALID', ...validation.errors], evidence: [] };
          } else {
            facts[node.outputFact] = structuredClone(output);
            this.runtime.ledger.append(options.runId, 'workflow.fact_recorded', {
              nodeId: node.id, fact: node.outputFact, source: `model:${node.operation}`, value: output,
            });
            result = { nodeId: node.id, status: 'completed', reasonCodes: ['BOUNDED_MODEL_OPERATION_COMPLETED'], evidence: [] };
          }
        }
      } else if (node.kind === 'sequence') {
        result = { nodeId: node.id, status: 'completed', reasonCodes: ['SEQUENCE_COMPLETED'], evidence: [] };
        for (const child of node.children) {
          const childResult = await visit(child, intent);
          if (childResult.status !== 'completed' && childResult.status !== 'skipped') {
            result = { nodeId: node.id, status: childResult.status, reasonCodes: ['SEQUENCE_CHILD_FAILED'], evidence: childResult.evidence };
            break;
          }
        }
      } else if (node.kind === 'parallel') {
        const unsafe = node.children.some(child => {
          const actions: ActionProposal[] = [];
          const collect = (candidate: WorkflowNode): void => {
            if (candidate.kind === 'action') actions.push(candidate.proposal);
            else if (candidate.kind === 'sequence' || candidate.kind === 'parallel') candidate.children.forEach(collect);
            else if (candidate.kind === 'choice') { collect(candidate.whenTrue); if (candidate.whenFalse) collect(candidate.whenFalse); }
            else if (candidate.kind === 'loop') collect(candidate.body);
            else if (candidate.kind === 'gate' || candidate.kind === 'subworkflow') collect(candidate.child);
          };
          collect(child);
          return actions.some(action => action.declaredEffects.some(effect =>
            effect === 'state.write' || effect === 'state.delete' || effect === 'process.execute',
          ));
        });
        if (unsafe) {
          result = { nodeId: node.id, status: 'blocked', reasonCodes: ['PARALLEL_EFFECT_REQUIRES_EXPLICIT_SERIALIZATION'], evidence: [] };
        } else {
          const childResults: WorkflowNodeResult[] = new Array(node.children.length);
          let cursor = 0;
          const workers = Array.from({ length: Math.min(node.maxConcurrency, node.children.length) }, async () => {
            while (cursor < node.children.length) {
              const index = cursor++;
              childResults[index] = await visit(node.children[index]!, intent);
            }
          });
          await Promise.all(workers);
          const failed = childResults.find(child => child.status !== 'completed' && child.status !== 'skipped');
          result = failed
            ? { nodeId: node.id, status: failed.status, reasonCodes: ['PARALLEL_CHILD_FAILED'], evidence: childResults.flatMap(child => child.evidence) }
            : { nodeId: node.id, status: 'completed', reasonCodes: ['PARALLEL_COMPLETED'], evidence: childResults.flatMap(child => child.evidence) };
        }
      } else if (node.kind === 'choice') {
        const branch = matchesPredicate(node.predicate, facts) ? node.whenTrue : node.whenFalse;
        if (branch) {
          const branchResult = await visit(branch, intent);
          result = { ...branchResult, nodeId: node.id, reasonCodes: ['CHOICE_BRANCH_SELECTED', ...branchResult.reasonCodes] };
        } else result = { nodeId: node.id, status: 'skipped', reasonCodes: ['CHOICE_NO_BRANCH'], evidence: [] };
      } else if (node.kind === 'loop') {
        let iterations = 0;
        let last: WorkflowNodeResult | undefined;
        while (matchesPredicate(node.predicate, facts) && iterations < node.maxIterations) {
          last = await visit(node.body, intent);
          iterations += 1;
          facts[`loop:${node.id}:iterations`] = iterations;
          if (last.status !== 'completed') break;
        }
        const stillTrue = matchesPredicate(node.predicate, facts);
        result = stillTrue && iterations === node.maxIterations
          ? { nodeId: node.id, status: 'blocked', reasonCodes: ['LOOP_BOUND_REACHED'], evidence: last?.evidence ?? [] }
          : { nodeId: node.id, status: last?.status === 'failed' ? 'failed' : 'completed', reasonCodes: ['LOOP_TERMINATED'], evidence: last?.evidence ?? [] };
      } else if (node.kind === 'gate') {
        const approved = await options.approveGate?.(node.id, node.reason) ?? false;
        result = approved
          ? await visit(node.child, intent)
          : { nodeId: node.id, status: 'blocked', reasonCodes: ['GATE_APPROVAL_REQUIRED'], evidence: [] };
      } else if (node.kind === 'verify') {
        const verification = await this.verifiers.verify(node.verifierIds, {
          runId: options.runId, claims: node.claims, observations, evidence, now: options.now(),
        });
        result = { nodeId: node.id, status: verification.passed ? 'completed' : 'failed', reasonCodes: verification.reasonCodes, evidence: verification.evidence };
      } else {
        if (narrows(intent, node.intent)) {
          const childResult = await visit(node.child, node.intent);
          result = { ...childResult, nodeId: node.id, reasonCodes: ['SUBWORKFLOW_AUTHORITY_NARROWED', ...childResult.reasonCodes] };
        } else result = { nodeId: node.id, status: 'blocked', reasonCodes: ['SUBWORKFLOW_AUTHORITY_EXPANDED'], evidence: [] };
      }
      if (!results.includes(result)) results.push(result);
      this.runtime.ledger.append(options.runId, 'workflow.node_finished', {
        nodeId: node.id, kind: node.kind, status: result.status, reasonCodes: result.reasonCodes,
      });
      return result;
    };
    await visit(plan.root, plan.intent);
    return results;
  }
}
