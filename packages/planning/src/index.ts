import type {
  Effect,
  ExecutablePlanStep,
  ExecutableWorkflowPlan,
  PlanCondition,
  RiskLevel,
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

