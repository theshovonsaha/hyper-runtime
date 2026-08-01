import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActionProposal,
  CapabilityManifest,
  Condition,
  ContextPacket,
  CorrectionRule,
  IntentContract,
  ModelProposalResult,
  WorkflowRunResult,
} from '@hyper/contracts';
import { CONTRACT_VERSION } from '@hyper/contracts';
import { InMemoryWorkspaceCapability, type MemoryWriteArgs } from '@hyper/capability-memory';
import type { ModelDriver, ModelProposalScope } from '@hyper/model';
import { CapabilityRegistry, WorkflowRunner } from '@hyper/workflow';

interface CorrectionBenchmark {
  benchmark: string;
  version: string;
  fixedNow: string;
  researchQuestion: string;
  maxSteps: number;
  rule: CorrectionRule;
  expected: {
    baselineStatus: WorkflowRunResult['status'];
    treatmentStatus: WorkflowRunResult['status'];
    applicationCount: number;
    assessment: 'improved' | 'not_improved' | 'inconclusive';
  };
}

export interface CorrectionGrammarReport {
  benchmark: string;
  benchmarkVersion: string;
  researchQuestion: string;
  design: { deterministic: true; modelCalls: 0 };
  baselineStatus: WorkflowRunResult['status'];
  treatmentStatus: WorkflowRunResult['status'];
  applicationCount: number;
  assessment?: string;
  correctionIncluded: boolean;
  ledgerValid: boolean;
  acceptance: { passed: boolean; criteria: Record<string, boolean> };
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORRECTION_BENCHMARK_PATH = resolve(
  MODULE_DIR,
  '../../../evals/correction-grammar.v1.json',
);

function correctionAwareModel(): ModelDriver {
  let actionIndex = 0;
  let repaired = false;
  return {
    async propose(
      packet: ContextPacket,
      _capabilities: CapabilityManifest[],
      scope: ModelProposalScope,
    ): Promise<ModelProposalResult> {
      if (repaired) {
        return {
          proposal: {
            kind: 'complete',
            strategyId: scope.activeStrategyId,
            evidenceRefs: scope.requiredEvidence,
          },
          model: 'fixture:correction-aware',
          usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
        };
      }
      const correctionActive = packet.items.some(item => item.semanticTag === 'repair');
      actionIndex += 1;
      repaired = correctionActive;
      const action: ActionProposal<MemoryWriteArgs> = {
        id: `proposal:correction:${actionIndex}`,
        intentId: scope.intentId,
        principalId: scope.principalId,
        conditionIds: scope.requiredConditionIds,
        capabilityId: 'memory.workspace.write',
        target: 'workspace/result.txt',
        declaredEffects: ['state.write'],
        risk: 1,
        expectedEvidence: scope.requiredEvidence,
        idempotencyKey: `correction:${actionIndex}`,
        args: { value: 'verified', behavior: correctionActive ? 'apply' : 'fail' },
      };
      return {
        proposal: {
          kind: 'action',
          strategyId: scope.activeStrategyId,
          hypothesis: correctionActive
            ? 'The activated repair constraint should change the write behavior.'
            : 'The uncorrected write behavior may succeed.',
          expectedObservation: 'workspace/result.txt contains verified',
          action,
        },
        model: 'fixture:correction-aware',
        usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
      };
    },
  };
}

async function runCondition(
  benchmark: CorrectionBenchmark,
  condition: 'baseline' | 'treatment',
) {
  const intent: IntentContract = {
    id: `intent:correction:${condition}`,
    version: CONTRACT_VERSION,
    objective: 'Produce and observe the verified workspace value.',
    principals: ['agent:eval'],
    authorizedCapabilities: ['memory.workspace.write'],
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
    observedAt: benchmark.fixedNow,
    expiresAt: '2026-07-24T12:10:00.000Z',
  }];
  const runner = new WorkflowRunner({
    model: correctionAwareModel(),
    capabilities: new CapabilityRegistry().register(new InMemoryWorkspaceCapability()),
    now: () => benchmark.fixedNow,
  });
  const result = await runner.run({
    runId: `eval:correction:${condition}`,
    intent,
    conditions,
    constraints: ['Use only the authorized workspace capability.'],
    sources: [],
    initialStrategyId: 'strategy:direct',
    maxSteps: benchmark.maxSteps,
    correctionRules: condition === 'treatment' ? [benchmark.rule] : [],
  });
  return { result, events: runner.ledger.all(), ledgerValid: runner.ledger.verifyIntegrity().valid };
}

export async function runCorrectionGrammarExperiment(
  path = DEFAULT_CORRECTION_BENCHMARK_PATH,
): Promise<CorrectionGrammarReport> {
  const benchmark = JSON.parse(readFileSync(path, 'utf8')) as CorrectionBenchmark;
  const baseline = await runCondition(benchmark, 'baseline');
  const treatment = await runCondition(benchmark, 'treatment');
  const applications = treatment.events.filter(event => event.type === 'correction.applied');
  const assessment = treatment.events.find(event => event.type === 'correction.assessed')
    ?.payload.disposition as string | undefined;
  const correctionIncluded = treatment.events.some(event =>
    event.type === 'context.compiled'
    && (event.payload.includedSourceIds as string[]).some(id => id.includes(':correction:')),
  );
  const ledgerValid = baseline.ledgerValid && treatment.ledgerValid;
  const criteria = {
    baseline_matches: baseline.result.status === benchmark.expected.baselineStatus,
    treatment_matches: treatment.result.status === benchmark.expected.treatmentStatus,
    application_count_matches: applications.length === benchmark.expected.applicationCount,
    assessment_matches: assessment === benchmark.expected.assessment,
    correction_enters_next_packet: correctionIncluded,
    ledgers_are_valid: ledgerValid,
  };
  return {
    benchmark: benchmark.benchmark,
    benchmarkVersion: benchmark.version,
    researchQuestion: benchmark.researchQuestion,
    design: { deterministic: true, modelCalls: 0 },
    baselineStatus: baseline.result.status,
    treatmentStatus: treatment.result.status,
    applicationCount: applications.length,
    assessment,
    correctionIncluded,
    ledgerValid,
    acceptance: { passed: Object.values(criteria).every(Boolean), criteria },
  };
}

export function writeCorrectionGrammarReport(
  report: CorrectionGrammarReport,
  outputDir: string,
): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    resolve(outputDir, 'correction-latest.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(resolve(outputDir, 'correction-latest.md'), `# Correction Grammar Ablation v${report.benchmarkVersion}

**Research question:** ${report.researchQuestion}

This is a deterministic mechanism benchmark with zero model calls.

| Condition | Status |
|---|---|
| Baseline | ${report.baselineStatus} |
| Treatment | ${report.treatmentStatus} |

Correction applications: ${report.applicationCount}  
Next-action assessment: ${report.assessment ?? 'missing'}  
Correction included in next packet: ${report.correctionIncluded}  
Ledger integrity: ${report.ledgerValid}

Acceptance gate: **${report.acceptance.passed ? 'PASS' : 'FAIL'}**

This establishes deterministic wiring only, not learned correction quality or live-model improvement.
`);
}
