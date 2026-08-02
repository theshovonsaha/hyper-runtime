import type {
  ActionOutcome,
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
  ProgressAssessment,
  WorkflowCompleteProposal,
  WorkflowRunResult,
  WorkflowStepRecord,
} from '@hyper/contracts';
import { DynamicContextCompiler } from '@hyper/context';
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
  tokenBudget?: number;
  maxSteps?: number;
  correctionRules?: CorrectionRule[];
  approvalFor?: (proposalId: string) => Approval | undefined;
  requestApprovalFor?: (proposalId: string) => Promise<Approval | undefined>;
  signal?: AbortSignal;
}

export interface WorkflowRunnerOptions {
  model: ModelDriver;
  capabilities: CapabilityRegistry;
  completionOracle?: CompletionOracle;
  contextCompiler?: DynamicContextCompiler;
  ledger?: HashChainLedger;
  now?: () => string;
  pivotAfterRepeatedFailures?: number;
}

function observationSummary(outcome: ActionOutcome): string {
  if (outcome.observation) {
    return JSON.stringify({
      target: outcome.observation.target,
      exists: outcome.observation.exists,
      value: outcome.observation.value,
      verification: outcome.verification?.reasonCodes,
    }).slice(0, 4_000);
  }
  return outcome.execution?.summary
    ?? outcome.decision.reasonCodes.join(', ')
    ?? outcome.status;
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

export class WorkflowRunner {
  readonly ledger: HashChainLedger;
  private readonly completionOracle: CompletionOracle;
  private readonly contextCompiler: DynamicContextCompiler;
  private readonly now: () => string;
  private readonly progressOracle: CausalProgressOracle;

  constructor(private readonly options: WorkflowRunnerOptions) {
    this.ledger = options.ledger ?? new HashChainLedger();
    this.completionOracle = options.completionOracle ?? new RequiredEvidenceCompletionOracle();
    this.contextCompiler = options.contextCompiler ?? new DynamicContextCompiler();
    this.now = options.now ?? (() => new Date().toISOString());
    this.progressOracle = new CausalProgressOracle(options.pivotAfterRepeatedFailures ?? 2);
  }

  async run(definition: WorkflowDefinition): Promise<WorkflowRunResult> {
    if (this.ledger.forRun(definition.runId).some(event => event.type === 'workflow.started')) {
      throw new Error(`Run ${definition.runId} already exists in this ledger.`);
    }
    const steps: WorkflowStepRecord[] = [];
    const correctionRules = definition.correctionRules?.map(rule => structuredClone(rule)) ?? [];
    validateCorrectionRules(correctionRules);
    const correctionApplications = new Map<string, number>();
    let pendingCorrection: PendingCorrection | undefined;
    const causalHistory: CausalRecord[] = [];
    const sources = definition.sources.map(source => structuredClone(source));
    const satisfiedEvidence = new Set<string>();
    const strategies = new Set([definition.initialStrategyId]);
    let activeStrategyId = definition.initialStrategyId;
    let consecutiveModelFailures = 0;
    let previousCompletionFailure = '';
    let repeatedCompletionFailures = 0;
    const maxSteps = definition.maxSteps ?? 12;
    const runtime = new AuthorizedRuntime(new DeterministicPolicyEngine(), this.ledger);

    this.ledger.append(definition.runId, 'workflow.started', {
      intentId: definition.intent.id,
      objective: definition.intent.objective,
      initialStrategyId: activeStrategyId,
      maxSteps,
      correctionRuleIds: correctionRules.map(rule => rule.id),
    });

    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber += 1) {
      if (definition.signal?.aborted) {
        return this.finish(definition.runId, 'blocked', steps, activeStrategyId, {
          reasonCodes: ['WORKFLOW_ABORTED'],
        });
      }
      const now = this.now();
      const recoveryFocus = causalHistory.at(-1)?.failureSignature ? ['diagnose', 'recover'] : [];
      const packet = this.contextCompiler.compile({
        runId: definition.runId,
        phase: recoveryFocus.length ? 'diagnose' : stepNumber === 1 ? 'orient' : 'act',
        objective: definition.intent.objective,
        constraints: definition.constraints,
        strategyId: activeStrategyId,
        focusTags: [
          ...(definition.focusTags ?? []),
          ...recoveryFocus,
          activeStrategyId,
        ],
        sources,
        tokenBudget: definition.tokenBudget ?? 4_000,
        now,
      });
      const registeredCapabilityManifests = this.options.capabilities.manifests();
      const authorizedCapabilities = definition.intent.authorizedCapabilities;
      const capabilityManifests = authorizedCapabilities
        ? registeredCapabilityManifests.filter(manifest => authorizedCapabilities.includes(manifest.id))
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
      });

      let modelResult;
      try {
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
          },
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.ledger.append(definition.runId, 'model.proposal_failed', { step: stepNumber, reason });
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
        continue;
      }

      const proposal = modelResult.proposal;
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
        steps.push({
          step: stepNumber,
          phase: packet.phase,
          strategyId: activeStrategyId,
          packetId: packet.id,
          proposal,
          usage: modelResult.usage,
        });
        return this.finish(definition.runId, 'needs_input', steps, activeStrategyId, {
          question: proposal.question,
          reasonCodes: ['MODEL_REQUESTED_USER_DECISION'],
        });
      }

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
      let outcome = await runtime.execute({
        runId: definition.runId,
        now,
        intent: definition.intent,
        conditions: definition.conditions,
        proposal: proposal.action,
        capability,
        approval: definition.approvalFor?.(proposal.action.id),
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
          });
        }
      }
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
          satisfiedEvidence.add(requirement);
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

      if (outcome.status === 'awaiting_approval') {
        return this.finish(definition.runId, 'needs_approval', steps, activeStrategyId, {
          reasonCodes: ['PROPOSAL_SCOPED_APPROVAL_REQUIRED'],
        });
      }
      if (progress.recovery === 'stop') {
        return this.finish(definition.runId, 'blocked', steps, activeStrategyId, {
          reasonCodes: ['REPEATED_DENIED_PROPOSAL'],
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
