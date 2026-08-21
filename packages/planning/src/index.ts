import type {
  Effect,
  ExecutablePlanStep,
  ExecutableWorkflowPlan,
  PlanCondition,
  RiskLevel,
  WorkflowCandidate,
  WorkflowRunResult,
  WorkflowBacktestReport,
  HumanWorkflowActivation,
  ComposedWorkflowPlan,
  WorkflowNode,
} from '@hyper/contracts';

export type PrimitiveWorkflowOperation =
  | 'runtime.inspect'
  | 'web.search'
  | 'artifact.write';

export interface WorkflowLanguageAnalysis {
  source: ExecutableWorkflowPlan['source'];
  objective: string;
  operations: PrimitiveWorkflowOperation[];
  searchQuery?: string;
  conditionalArtifact: boolean;
  reasonCodes: string[];
}

export interface CompileWorkflowInput {
  message: string;
  sessionId: string;
  intentId: string;
  now: string;
  idFactory?: () => string;
}

export interface SemanticWorkflowOperationAdapter {
  readonly id: string;
  compile(input: {
    nodeId: string;
    parameters: Readonly<Record<string, unknown>>;
    intent: Readonly<ComposedWorkflowPlan['intent']>;
  }): WorkflowNode;
}

function workflowObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}_OBJECT_REQUIRED`);
  return value as Record<string, unknown>;
}

/** Validates a declarative workflow graph into an inert plan. The compiler
 * resolves no adapters, performs no model calls, and grants no authority. */
export function compileWorkflowConfig(value: unknown): ComposedWorkflowPlan {
  const config = workflowObject(value, 'WORKFLOW_CONFIG');
  const intent = workflowObject(config.intent, 'WORKFLOW_INTENT') as unknown as ComposedWorkflowPlan['intent'];
  if (typeof config.id !== 'string' || !config.id.trim()) throw new Error('WORKFLOW_ID_REQUIRED');
  if (config.version !== '1.0') throw new Error('WORKFLOW_VERSION_UNSUPPORTED');
  if (typeof intent.id !== 'string' || typeof intent.objective !== 'string') throw new Error('WORKFLOW_INTENT_INVALID');
  const ids = new Set<string>();
  const validateNode = (raw: unknown): WorkflowNode => {
    const node = workflowObject(raw, 'WORKFLOW_NODE') as Record<string, unknown>;
    if (typeof node.id !== 'string' || !node.id.trim() || ids.has(node.id)) throw new Error('WORKFLOW_NODE_ID_INVALID');
    ids.add(node.id);
    if (typeof node.kind !== 'string') throw new Error('WORKFLOW_NODE_KIND_REQUIRED');
    if (node.kind === 'action') {
      const proposal = workflowObject(node.proposal, 'WORKFLOW_ACTION_PROPOSAL');
      if (typeof proposal.capabilityId !== 'string' || typeof proposal.target !== 'string') throw new Error('WORKFLOW_ACTION_INVALID');
    } else if (node.kind === 'deterministic') {
      if (typeof node.adapterId !== 'string' || typeof node.outputFact !== 'string') throw new Error('WORKFLOW_DETERMINISTIC_INVALID');
      workflowObject(node.input, 'WORKFLOW_DETERMINISTIC_INPUT');
      workflowObject(node.outputSchema, 'WORKFLOW_DETERMINISTIC_SCHEMA');
    } else if (node.kind === 'model') {
      if (typeof node.operation !== 'string' || typeof node.outputFact !== 'string') throw new Error('WORKFLOW_MODEL_INVALID');
      workflowObject(node.input, 'WORKFLOW_MODEL_INPUT');
      workflowObject(node.outputSchema, 'WORKFLOW_MODEL_SCHEMA');
    } else if (node.kind === 'sequence' || node.kind === 'parallel') {
      if (!Array.isArray(node.children)) throw new Error('WORKFLOW_CHILDREN_REQUIRED');
      if (node.kind === 'parallel' && (!Number.isInteger(node.maxConcurrency) || Number(node.maxConcurrency) < 1 || Number(node.maxConcurrency) > 32)) {
        throw new Error('WORKFLOW_PARALLEL_BOUND_INVALID');
      }
      node.children = node.children.map(validateNode);
    } else if (node.kind === 'choice') {
      workflowObject(node.predicate, 'WORKFLOW_PREDICATE');
      node.whenTrue = validateNode(node.whenTrue);
      if (node.whenFalse !== undefined) node.whenFalse = validateNode(node.whenFalse);
    } else if (node.kind === 'loop') {
      workflowObject(node.predicate, 'WORKFLOW_PREDICATE');
      if (!Number.isInteger(node.maxIterations) || Number(node.maxIterations) < 1 || Number(node.maxIterations) > 100) throw new Error('WORKFLOW_LOOP_BOUND_INVALID');
      node.body = validateNode(node.body);
    } else if (node.kind === 'gate') {
      if (typeof node.reason !== 'string' || !node.reason.trim()) throw new Error('WORKFLOW_GATE_REASON_REQUIRED');
      node.child = validateNode(node.child);
    } else if (node.kind === 'verify') {
      if (!Array.isArray(node.verifierIds) || !Array.isArray(node.claims)) throw new Error('WORKFLOW_VERIFY_INVALID');
    } else if (node.kind === 'subworkflow') {
      workflowObject(node.intent, 'WORKFLOW_CHILD_INTENT');
      node.child = validateNode(node.child);
    } else throw new Error(`WORKFLOW_NODE_KIND_UNSUPPORTED:${node.kind}`);
    return structuredClone(node) as unknown as WorkflowNode;
  };
  return {
    id: config.id,
    version: '1.0',
    intent: structuredClone(intent),
    root: validateNode(config.root),
  };
}

/** Lowers semantic `use:` steps through a reviewed, code-owned adapter catalog.
 * Config chooses parameters, never arbitrary functions, capabilities, or
 * authority. The lowered graph is validated again as an inert workflow. */
export function compileSemanticWorkflowConfig(
  value: unknown,
  adapters: readonly SemanticWorkflowOperationAdapter[],
): ComposedWorkflowPlan {
  const config = workflowObject(value, 'SEMANTIC_WORKFLOW_CONFIG');
  const workflowId = typeof config.workflow === 'string' && config.workflow.trim()
    ? config.workflow.trim()
    : typeof config.id === 'string' && config.id.trim()
      ? config.id.trim()
      : undefined;
  if (!workflowId) throw new Error('SEMANTIC_WORKFLOW_ID_REQUIRED');
  const intent = workflowObject(config.intent, 'SEMANTIC_WORKFLOW_INTENT') as unknown as ComposedWorkflowPlan['intent'];
  if (!Array.isArray(config.steps) || config.steps.length === 0) throw new Error('SEMANTIC_WORKFLOW_STEPS_REQUIRED');
  const catalog = new Map(adapters.map(adapter => [adapter.id, adapter]));
  if (catalog.size !== adapters.length || adapters.some(adapter => !adapter.id.trim())) {
    throw new Error('SEMANTIC_WORKFLOW_ADAPTER_IDS_INVALID');
  }
  const children = config.steps.map((raw, index) => {
    const step = workflowObject(raw, 'SEMANTIC_WORKFLOW_STEP');
    const use = typeof step.use === 'string' ? step.use.trim() : '';
    const adapter = catalog.get(use);
    if (!adapter) throw new Error(`SEMANTIC_WORKFLOW_OPERATION_UNAVAILABLE:${use || '<missing>'}`);
    const parameters = step.with === undefined
      ? {}
      : workflowObject(step.with, 'SEMANTIC_WORKFLOW_PARAMETERS');
    const nodeId = typeof step.id === 'string' && step.id.trim()
      ? step.id.trim()
      : `${workflowId}:step:${index + 1}`;
    return adapter.compile({
      nodeId,
      parameters: Object.freeze(structuredClone(parameters)),
      intent: Object.freeze(structuredClone(intent)),
    });
  });
  return compileWorkflowConfig({
    id: workflowId,
    version: '1.0',
    intent,
    root: { id: `${workflowId}:root`, kind: 'sequence', children },
  });
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseGoal(message: string): {
  source: ExecutableWorkflowPlan['source'];
  objective: string;
} {
  const command = message.match(/^\/workflow(?:\s+([\s\S]+))?$/i);
  return command
    ? { source: 'command', objective: compact(command[1] ?? '') }
    : { source: 'natural_language', objective: compact(message) };
}

function extractSearchQuery(goal: string): string | undefined {
  const match = goal.match(
    /(?:web\s+search|search(?:\s+the)?\s+web|look\s+up|research)\s+(?:for\s+)?(.+?)(?=\s+(?:and\s+then|then|and\s+if|if)\b|[.;\n]|$)/i,
  );
  const value = compact(match?.[1] ?? '');
  return value || undefined;
}

interface Candidate {
  index: number;
  operation: PrimitiveWorkflowOperation;
}

function operationCandidates(goal: string): Candidate[] {
  const patterns: Array<{ operation: PrimitiveWorkflowOperation; pattern: RegExp }> = [
    {
      operation: 'runtime.inspect',
      pattern:
        /\b(inspect|examine|read|show|summari[sz]e)\b.{0,36}\b(runtime|session|state|status|events?|history)\b/i,
    },
    {
      operation: 'web.search',
      pattern:
        /\b(web\s+search|search(?:\s+the)?\s+web|look\s+up|research)\b/i,
    },
    {
      operation: 'artifact.write',
      pattern:
        /\b(write|create|draft|generate|produce|build)\b.{0,80}\b(report|summary|brief|document|artifact|note)\b/i,
    },
  ];
  return patterns
    .flatMap(({ operation, pattern }) => {
      const match = pattern.exec(goal);
      return match?.index === undefined ? [] : [{ index: match.index, operation }];
    })
    .sort((left, right) => left.index - right.index);
}

export function analyzeWorkflowLanguage(message: string): WorkflowLanguageAnalysis {
  const parsed = parseGoal(message);
  if (!parsed.objective) throw new Error('WORKFLOW_GOAL_REQUIRED');
  let candidates = operationCandidates(parsed.objective);
  const reasonCodes: string[] = [];
  if (candidates.length === 0) {
    candidates = [
      { index: 0, operation: 'runtime.inspect' },
      { index: 1, operation: 'artifact.write' },
    ];
    reasonCodes.push('SAFE_INSPECT_THEN_ARTIFACT_DEFAULT');
  } else {
    reasonCodes.push('OPERATIONS_EXTRACTED_FROM_LANGUAGE');
  }
  if (
    candidates.some(candidate => candidate.operation === 'web.search')
    && !candidates.some(candidate => candidate.operation === 'artifact.write')
    && /\b(report|summary|brief|document|artifact)\b/i.test(parsed.objective)
  ) {
    candidates.push({
      index: parsed.objective.length,
      operation: 'artifact.write',
    });
    reasonCodes.push('REQUESTED_ARTIFACT_APPENDED');
  }
  const conditionalArtifact =
    /\bif\b.{0,48}\b(found|results?|exists?|available|non[- ]?empty)\b/i.test(
      parsed.objective,
    )
    && candidates.some(candidate => candidate.operation === 'web.search')
    && candidates.some(candidate => candidate.operation === 'artifact.write');
  if (conditionalArtifact) reasonCodes.push('EXPLICIT_RESULT_CONDITION_EXTRACTED');
  return {
    source: parsed.source,
    objective: parsed.objective,
    operations: candidates
      .sort((left, right) => left.index - right.index)
      .map(candidate => candidate.operation),
    searchQuery: extractSearchQuery(parsed.objective),
    conditionalArtifact,
    reasonCodes,
  };
}

function titleFor(objective: string, query?: string): string {
  return `Report: ${compact(query ?? objective).slice(0, 90) || 'workflow result'}`;
}

function createStep(input: {
  planId: string;
  ordinal: number;
  operation: PrimitiveWorkflowOperation;
  sessionId: string;
  objective: string;
  searchQuery?: string;
  dependsOn: string[];
}): ExecutablePlanStep {
  const id = `${input.planId}:step:${input.ordinal}`;
  let title: string;
  let target: string;
  let declaredEffects: Effect[];
  let risk: RiskLevel;
  let args: Record<string, unknown>;
  let expectedEvidence: string[];

  if (input.operation === 'runtime.inspect') {
    title = 'Inspect bounded runtime state';
    target = `runtime:${input.sessionId}`;
    declaredEffects = ['state.read'];
    risk = 0;
    args = {};
    expectedEvidence = [`runtime.snapshot:${id}`];
  } else if (input.operation === 'web.search') {
    const query = input.searchQuery ?? input.objective;
    title = `Search the web for “${query.slice(0, 72)}”`;
    target = `search:${query}`;
    declaredEffects = ['network.request', 'state.read'];
    risk = 1;
    args = { query, limit: 5 };
    expectedEvidence = [`search.results:${id}`];
  } else {
    title = 'Create a verified portable report';
    target = `artifact:${input.sessionId}/${input.planId}`;
    declaredEffects = ['state.write'];
    risk = 0;
    args = {
      title: titleFor(input.objective, input.searchQuery),
      kind: 'report',
      mediaType: 'text/markdown',
    };
    expectedEvidence = [`artifact.observed:${id}`];
  }

  return {
    id,
    ordinal: input.ordinal,
    title,
    capabilityId: input.operation,
    target,
    declaredEffects,
    risk,
    dependsOn: input.dependsOn,
    conditionIds: [],
    expectedEvidence,
    idempotencyKey: `${input.planId}:${input.operation}:${String(args.query ?? input.ordinal).toLowerCase()}`,
    args,
    status: 'pending',
    attempts: 0,
    evidenceRefs: [],
  };
}

function connectCondition(input: {
  planId: string;
  conditions: PlanCondition[];
  target: ExecutablePlanStep;
  source: ExecutablePlanStep;
  predicate: PlanCondition['predicate'];
  statement: string;
}): void {
  const condition: PlanCondition = {
    id: `${input.planId}:condition:${input.conditions.length + 1}`,
    statement: input.statement,
    predicate: input.predicate,
    sourceStepId: input.source.id,
    status: 'pending',
    evidenceRefs: [],
  };
  input.conditions.push(condition);
  input.target.conditionIds.push(condition.id);
}

/**
 * Compiles a small compositional language into a capability graph. It never
 * authorizes or executes a capability; the policy/runtime boundary remains
 * responsible for both.
 */
export function compileNaturalLanguageWorkflow(
  input: CompileWorkflowInput,
): ExecutableWorkflowPlan {
  const analysis = analyzeWorkflowLanguage(input.message);
  const suffix = (input.idFactory ?? (() => crypto.randomUUID()))();
  const planId = `workflow_${suffix.replaceAll('-', '').slice(0, 16)}`;
  const steps: ExecutablePlanStep[] = [];
  for (const operation of analysis.operations) {
    const previous = steps.at(-1);
    steps.push(createStep({
      planId,
      ordinal: steps.length + 1,
      operation,
      sessionId: input.sessionId,
      objective: analysis.objective,
      searchQuery: analysis.searchQuery,
      dependsOn: previous ? [previous.id] : [],
    }));
  }

  const conditions: PlanCondition[] = [];
  for (const step of steps) {
    for (const dependencyId of step.dependsOn) {
      const dependency = steps.find(candidate => candidate.id === dependencyId);
      if (dependency) {
        connectCondition({
          planId,
          conditions,
          target: step,
          source: dependency,
          predicate: 'step_completed',
          statement: `${dependency.title} must complete before ${step.title}.`,
        });
      }
    }
  }
  if (analysis.conditionalArtifact) {
    const search = steps.find(step => step.capabilityId === 'web.search');
    const artifact = search
      ? steps.find(step =>
          step.ordinal > search.ordinal && step.capabilityId === 'artifact.write')
      : undefined;
    if (search && artifact) {
      connectCondition({
        planId,
        conditions,
        target: artifact,
        source: search,
        predicate: 'result_nonempty',
        statement: 'At least one observed search result must exist before the report is created.',
      });
    }
  }

  return {
    id: planId,
    version: '1.0',
    intentId: input.intentId,
    objective: analysis.objective,
    source: analysis.source,
    status: 'ready',
    steps,
    conditions,
    completionCriteria: [
      'Every applicable step is completed or conditionally skipped.',
      'Every completed action has observation and verification evidence.',
      'A requested report produces exactly one verified artifact.',
      'A false condition is reported rather than rewritten as success.',
    ],
    currentStepId: steps[0]?.id,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface CrystallizeWorkflowInput {
  id: string;
  plan: ExecutableWorkflowPlan;
  sourceRuns: WorkflowRunResult[];
  parameterSlots?: string[];
  now: string;
}

/** Converts only verified successful traces into an inert, reviewable candidate. */
export function crystallizeVerifiedWorkflow(input: CrystallizeWorkflowInput): WorkflowCandidate {
  if (input.sourceRuns.length === 0) throw new Error('WORKFLOW_CANDIDATE_REQUIRES_SOURCE_RUNS');
  if (input.sourceRuns.some(run => run.status !== 'completed' || run.completion?.passed !== true)) {
    throw new Error('WORKFLOW_CANDIDATE_SOURCE_NOT_VERIFIED');
  }
  const slots = [...new Set(input.parameterSlots ?? [])];
  const confidence = Math.min(1, input.sourceRuns.length / 5);
  return {
    id: input.id,
    status: 'candidate',
    sourceRunIds: input.sourceRuns.map(run => run.runId),
    plan: structuredClone(input.plan),
    parameterSlots: slots,
    confidence,
    verifiedSourceOutcomes: input.sourceRuns.length,
    createdAt: input.now,
  };
}

/** Backtest and a human receipt are both required; neither grants runtime authority. */
export function activateWorkflowCandidate(
  candidate: WorkflowCandidate,
  backtest: WorkflowBacktestReport,
  activation: HumanWorkflowActivation,
): WorkflowCandidate {
  if (candidate.status !== 'candidate') throw new Error('WORKFLOW_CANDIDATE_NOT_ACTIVATABLE');
  if (backtest.candidateId !== candidate.id || !backtest.acceptancePassed || backtest.failed > 0) {
    throw new Error('WORKFLOW_CANDIDATE_BACKTEST_FAILED');
  }
  if (
    activation.candidateId !== candidate.id
    || !activation.principalId.trim()
    || !activation.receiptId.trim()
    || !Number.isFinite(Date.parse(activation.approvedAt))
  ) throw new Error('WORKFLOW_CANDIDATE_HUMAN_ACTIVATION_INVALID');
  return { ...structuredClone(candidate), status: 'ready' };
}
