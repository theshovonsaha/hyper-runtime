import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActionProposal,
  Condition,
  ContextSource,
  IntentContract,
  WorkflowProposal,
  WorkflowRunResult,
} from '@hyper/contracts';
import { CONTRACT_VERSION } from '@hyper/contracts';
import { DynamicContextCompiler } from '@hyper/context';
import { InMemoryWorkspaceCapability, type MemoryWriteArgs } from '@hyper/capability-memory';
import { ScriptedModelDriver } from '@hyper/model';
import { CapabilityRegistry, WorkflowRunner } from '@hyper/workflow';

interface ContextScenario {
  id: string;
  focusTags: string[];
  tokenBudget: number;
  sources: Array<Pick<
    ContextSource,
    'id' | 'content' | 'kind' | 'authority' | 'validity' | 'tags' | 'priority'
  >>;
  expectedIncluded: string[];
  expectedExcluded: string[];
  expectedNonInstructionEligible: string[];
}

interface WorkflowScenario {
  id: string;
  sequence: Array<'fail' | 'pivot' | 'apply' | 'complete' | 'cyclic_pivot'>;
  expectedStatus: WorkflowRunResult['status'];
  expectsRecovery: boolean;
  expectsEarlyCompletionRejection: boolean;
}

interface AdaptiveBenchmark {
  benchmark: string;
  version: string;
  fixedNow: string;
  researchQuestion: string;
  contextScenarios: ContextScenario[];
  workflowScenarios: WorkflowScenario[];
}

export interface ContextTrial {
  scenarioId: string;
  expectedIncluded: string[];
  actualIncluded: string[];
  expectedExcluded: string[];
  actualExcluded: string[];
  expectedNonInstructionEligible: string[];
  actualNonInstructionEligible: string[];
  passed: boolean;
}

export interface WorkflowTrial {
  scenarioId: string;
  expectedStatus: WorkflowRunResult['status'];
  actualStatus: WorkflowRunResult['status'];
  causalActionSteps: number;
  totalActionSteps: number;
  pivotCount: number;
  earlyCompletionRejected: boolean;
  ledgerValid: boolean;
  passed: boolean;
}

export interface AdaptiveWorkflowReport {
  benchmark: string;
  benchmarkVersion: string;
  researchQuestion: string;
  design: {
    deterministic: true;
    modelCalls: 0;
    contextScenarios: number;
    workflowScenarios: number;
  };
  metrics: {
    contextExpectationAccuracy: number;
    untrustedInstructionIsolationRate: number;
    workflowStatusAccuracy: number;
    causalTraceCoverage: number;
    recoverySuccessRate: number;
    falseCompletionCommitRate: number;
    ledgerIntegrityRate: number;
  };
  contextTrials: ContextTrial[];
  workflowTrials: WorkflowTrial[];
  acceptance: {
    passed: boolean;
    criteria: Record<string, boolean>;
  };
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ADAPTIVE_BENCHMARK_PATH = resolve(
  MODULE_DIR,
  '../../../evals/workflow-context.v1.json',
);

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function loadAdaptiveBenchmark(path = DEFAULT_ADAPTIVE_BENCHMARK_PATH): AdaptiveBenchmark {
  return JSON.parse(readFileSync(path, 'utf8')) as AdaptiveBenchmark;
}

function runContextTrial(scenario: ContextScenario, fixedNow: string): ContextTrial {
  const packet = new DynamicContextCompiler().compile({
    runId: `eval:${scenario.id}`,
    phase: 'act',
    objective: 'Complete the benchmark task without scope drift.',
    constraints: ['Preserve authoritative constraints.'],
    strategyId: 'strategy:benchmark',
    focusTags: scenario.focusTags,
    sources: scenario.sources.map(source => ({
      ...source,
      title: source.id,
      provenance: [`fixture:${scenario.id}`],
      createdAt: fixedNow,
    })),
    tokenBudget: scenario.tokenBudget,
    now: fixedNow,
  });
  const actualIncluded = packet.items.map(item => item.sourceId);
  const actualNonInstructionEligible = packet.items
    .filter(item => !item.instructionEligible)
    .map(item => item.sourceId);
  const passed = scenario.expectedIncluded.every(id => actualIncluded.includes(id))
    && scenario.expectedExcluded.every(id => packet.excludedSourceIds.includes(id))
    && scenario.expectedNonInstructionEligible.every(id =>
      actualNonInstructionEligible.includes(id),
    );
  return {
    scenarioId: scenario.id,
    expectedIncluded: scenario.expectedIncluded,
    actualIncluded,
    expectedExcluded: scenario.expectedExcluded,
    actualExcluded: packet.excludedSourceIds,
    expectedNonInstructionEligible: scenario.expectedNonInstructionEligible,
    actualNonInstructionEligible,
    passed,
  };
}

function workflowProposal(
  scenarioId: string,
  item: WorkflowScenario['sequence'][number],
  index: number,
  activeStrategy: string,
): WorkflowProposal {
  if (item === 'pivot') {
    return {
      kind: 'pivot',
      strategyId: 'strategy:recovered',
      fromStrategyId: activeStrategy,
      cause: 'The previous execution failed with observed evidence.',
    };
  }
  if (item === 'cyclic_pivot') {
    return {
      kind: 'pivot',
      strategyId: activeStrategy,
      fromStrategyId: activeStrategy,
      cause: 'No strategy change.',
    };
  }
  if (item === 'complete') {
    return {
      kind: 'complete',
      strategyId: activeStrategy,
      evidenceRefs: ['workspace_value_observed'],
    };
  }
  const action: ActionProposal<MemoryWriteArgs> = {
    id: `proposal:${scenarioId}:${index}`,
    intentId: `intent:${scenarioId}`,
    principalId: 'agent:eval',
    conditionIds: ['condition:current'],
    capabilityId: 'memory.workspace.write',
    target: 'workspace/result.txt',
    declaredEffects: ['state.write'],
    risk: 1,
    expectedEvidence: ['workspace_value_observed'],
    idempotencyKey: `idempotency:${scenarioId}:${index}`,
    args: {
      value: 'verified',
      behavior: item === 'fail' ? 'fail' : 'apply',
    },
  };
  return {
    kind: 'action',
    strategyId: activeStrategy,
    hypothesis: item === 'fail' ? 'The initial write may work.' : 'The revised write should work.',
    expectedObservation: 'Observed value equals verified.',
    action,
  };
}

async function runWorkflowTrial(
  scenario: WorkflowScenario,
  fixedNow: string,
): Promise<WorkflowTrial> {
  let activeStrategy = 'strategy:direct';
  const proposals = scenario.sequence.map((item, index) => {
    const proposal = workflowProposal(scenario.id, item, index, activeStrategy);
    if (proposal.kind === 'pivot' && proposal.strategyId !== activeStrategy) {
      activeStrategy = proposal.strategyId;
    }
    return proposal;
  });
  const intent: IntentContract = {
    id: `intent:${scenario.id}`,
    version: CONTRACT_VERSION,
    objective: 'Produce and observe the verified workspace value.',
    principals: ['agent:eval'],
    authorizedResources: ['workspace/**'],
    prohibitedEffects: ['state.delete', 'network.request', 'process.execute'],
    requiredConditionIds: ['condition:current'],
    requiredEvidence: ['workspace_value_observed'],
    riskBudget: 2,
    approvalAboveRisk: 3,
    completionCriteria: ['Observed workspace value equals verified.'],
  };
  const conditions: Condition[] = [{
    id: 'condition:current',
    statement: 'Benchmark state is current.',
    status: 'active',
    evidenceRefs: ['fixture:state'],
    source: 'benchmark',
    observedAt: fixedNow,
    expiresAt: '2026-07-24T12:10:00.000Z',
  }];
  const capability = new InMemoryWorkspaceCapability();
  const runner = new WorkflowRunner({
    model: new ScriptedModelDriver(proposals),
    capabilities: new CapabilityRegistry().register(capability),
    now: () => fixedNow,
  });
  const result = await runner.run({
    runId: `eval:${scenario.id}`,
    intent,
    conditions,
    constraints: ['Use only authorized workspace capabilities.'],
    sources: [{
      id: `goal:${scenario.id}`,
      title: 'Benchmark goal',
      content: intent.objective,
      kind: 'goal',
      authority: 'directive',
      validity: 'active',
      provenance: [`fixture:${scenario.id}`],
      tags: ['workspace'],
      createdAt: fixedNow,
      priority: 100,
    }],
    initialStrategyId: 'strategy:direct',
    maxSteps: 8,
  });
  const actionSteps = result.steps.filter(step => step.proposal.kind === 'action');
  const completionChecks = runner.ledger.all()
    .filter(event => event.type === 'workflow.completion_checked')
    .map(event => event.payload.passed);
  const earlyCompletionRejected = completionChecks.length > 1 && completionChecks[0] === false;
  const passed = result.status === scenario.expectedStatus
    && (!scenario.expectsEarlyCompletionRejection || earlyCompletionRejected)
    && runner.ledger.verifyIntegrity().valid;
  return {
    scenarioId: scenario.id,
    expectedStatus: scenario.expectedStatus,
    actualStatus: result.status,
    causalActionSteps: actionSteps.filter(step => !!step.causal).length,
    totalActionSteps: actionSteps.length,
    pivotCount: result.steps.filter(step => step.proposal.kind === 'pivot').length,
    earlyCompletionRejected,
    ledgerValid: runner.ledger.verifyIntegrity().valid,
    passed,
  };
}

export async function runAdaptiveWorkflowExperiment(
  path = DEFAULT_ADAPTIVE_BENCHMARK_PATH,
): Promise<AdaptiveWorkflowReport> {
  const benchmark = loadAdaptiveBenchmark(path);
  const contextTrials = benchmark.contextScenarios.map(scenario =>
    runContextTrial(scenario, benchmark.fixedNow),
  );
  const workflowTrials: WorkflowTrial[] = [];
  for (const scenario of benchmark.workflowScenarios) {
    workflowTrials.push(await runWorkflowTrial(scenario, benchmark.fixedNow));
  }
  const expectedContextAssertions = contextTrials.reduce(
    (total, trial) =>
      total
      + trial.expectedIncluded.length
      + trial.expectedExcluded.length
      + trial.expectedNonInstructionEligible.length,
    0,
  );
  const passedContextAssertions = contextTrials.reduce((total, trial) => {
    return total
      + trial.expectedIncluded.filter(id => trial.actualIncluded.includes(id)).length
      + trial.expectedExcluded.filter(id => trial.actualExcluded.includes(id)).length
      + trial.expectedNonInstructionEligible.filter(id =>
        trial.actualNonInstructionEligible.includes(id),
      ).length;
  }, 0);
  const untrustedExpectations = contextTrials.flatMap(trial =>
    trial.expectedNonInstructionEligible.map(id => ({ trial, id })),
  );
  const recoveryTrials = workflowTrials.filter(trial =>
    benchmark.workflowScenarios.find(scenario => scenario.id === trial.scenarioId)?.expectsRecovery,
  );
  const falseCompletionTrials = workflowTrials.filter(trial =>
    benchmark.workflowScenarios.find(scenario =>
      scenario.id === trial.scenarioId
      && scenario.expectsEarlyCompletionRejection,
    ),
  );
  const totalActionSteps = workflowTrials.reduce((total, trial) => total + trial.totalActionSteps, 0);
  const causalActionSteps = workflowTrials.reduce((total, trial) => total + trial.causalActionSteps, 0);
  const metrics = {
    contextExpectationAccuracy: rate(passedContextAssertions, expectedContextAssertions),
    untrustedInstructionIsolationRate: rate(
      untrustedExpectations.filter(({ trial, id }) =>
        trial.actualNonInstructionEligible.includes(id),
      ).length,
      untrustedExpectations.length,
    ),
    workflowStatusAccuracy: rate(workflowTrials.filter(trial => trial.passed).length, workflowTrials.length),
    causalTraceCoverage: rate(causalActionSteps, totalActionSteps),
    recoverySuccessRate: rate(
      recoveryTrials.filter(trial => trial.actualStatus === 'completed' && trial.pivotCount > 0).length,
      recoveryTrials.length,
    ),
    falseCompletionCommitRate: rate(
      falseCompletionTrials.filter(trial => !trial.earlyCompletionRejected).length,
      falseCompletionTrials.length,
    ),
    ledgerIntegrityRate: rate(
      workflowTrials.filter(trial => trial.ledgerValid).length,
      workflowTrials.length,
    ),
  };
  const criteria = {
    context_expectation_accuracy_is_one: metrics.contextExpectationAccuracy === 1,
    untrusted_instruction_isolation_is_one: metrics.untrustedInstructionIsolationRate === 1,
    workflow_status_accuracy_is_one: metrics.workflowStatusAccuracy === 1,
    causal_trace_coverage_is_one: metrics.causalTraceCoverage === 1,
    recovery_success_is_one: metrics.recoverySuccessRate === 1,
    false_completion_commit_is_zero: metrics.falseCompletionCommitRate === 0,
    ledger_integrity_is_one: metrics.ledgerIntegrityRate === 1,
  };
  return {
    benchmark: benchmark.benchmark,
    benchmarkVersion: benchmark.version,
    researchQuestion: benchmark.researchQuestion,
    design: {
      deterministic: true,
      modelCalls: 0,
      contextScenarios: contextTrials.length,
      workflowScenarios: workflowTrials.length,
    },
    metrics,
    contextTrials,
    workflowTrials,
    acceptance: {
      passed: Object.values(criteria).every(Boolean),
      criteria,
    },
  };
}

export function renderAdaptiveMarkdown(report: AdaptiveWorkflowReport): string {
  return `# Adaptive Context and Workflow Evals v${report.benchmarkVersion}

**Research question:** ${report.researchQuestion}

This is a deterministic mechanism benchmark with ${report.design.contextScenarios} context fixtures, ${report.design.workflowScenarios} workflow fixtures, and zero model calls.

| Metric | Result |
|---|---:|
| Context expectation accuracy | ${(report.metrics.contextExpectationAccuracy * 100).toFixed(1)}% |
| Untrusted instruction isolation | ${(report.metrics.untrustedInstructionIsolationRate * 100).toFixed(1)}% |
| Workflow status accuracy | ${(report.metrics.workflowStatusAccuracy * 100).toFixed(1)}% |
| Causal trace coverage | ${(report.metrics.causalTraceCoverage * 100).toFixed(1)}% |
| Recovery success | ${(report.metrics.recoverySuccessRate * 100).toFixed(1)}% |
| False-completion commit | ${(report.metrics.falseCompletionCommitRate * 100).toFixed(1)}% |
| Ledger integrity | ${(report.metrics.ledgerIntegrityRate * 100).toFixed(1)}% |

Acceptance gate: **${report.acceptance.passed ? 'PASS' : 'FAIL'}**

## Interpretation boundary

The benchmark establishes deterministic fixture behavior only. It does not establish live-model planning quality, resistance to adaptive prompt injection, hardened process isolation, or general recovery performance.
`;
}

export function writeAdaptiveReport(report: AdaptiveWorkflowReport, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    resolve(outputDir, 'workflow-latest.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(resolve(outputDir, 'workflow-latest.md'), renderAdaptiveMarkdown(report));
}
