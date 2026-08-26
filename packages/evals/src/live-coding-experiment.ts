import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BoundedProcessCapability,
  PatchFileCapability,
  ReadFileCapability,
  RepositorySearchCapability,
} from '@hyper/capabilities';
import { CONTRACT_VERSION, type ContextSource, type LedgerEvent, type WorkflowRunResult } from '@hyper/contracts';
import { createModelDriver } from '@hyper/cli';
import type { ModelDriver } from '@hyper/model';
import { CapabilityRegistry, WorkflowRunner } from '@hyper/workflow';
import { configuredLiveRoutes, type LiveRoute } from './live-provider-experiment';

export interface LiveCodingTrial {
  provider: string;
  model: string;
  status: WorkflowRunResult['status'] | 'driver_failed';
  latencyMs: number;
  cancellationLatencyMs?: number;
  cancellationSucceeded?: boolean;
  modelCalls: number;
  actionCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd?: number;
  costObserved: boolean;
  proposalFailureCount: number;
  proposalRejectionCount: number;
  proposalFailureReasons: string[];
  proposalRejectionReasons: string[];
  modelPassTrace: Array<{
    step: number;
    purpose?: string;
    proposalKind: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    latencyMs: number;
    estimatedTokens?: number;
    tokenEstimateError?: number;
  }>;
  actionTrace: Array<{
    capabilityId: string;
    success: boolean;
    summary: string;
    errorCode?: string;
    effectState?: string;
    observed: boolean;
  }>;
  policyTrace: Array<{
    proposalId: string;
    disposition: string;
    capabilityId?: string;
    target?: string;
    reasonCodes: string[];
  }>;
  toolCallValidity: number;
  implementationCorrect: boolean;
  testExitObserved: boolean;
  patchProvenanceObserved: boolean;
  ledgerValid: boolean;
  cancellationPassed: boolean;
  taskCompleted: boolean;
  qualityScore: number;
  passed: boolean;
  reasonCodes: string[];
  error?: string;
}

export interface LiveCodingReport {
  benchmark: 'hyper-live-coding-smoke';
  version: '1.0.0';
  evidenceClass: 'live_model';
  claimBoundary: string;
  generatedAt: string;
  providers: string[];
  trials: LiveCodingTrial[];
  metrics: {
    passRate: number;
    taskCompletionRate: number;
    toolCallValidity: number;
    averageLatencyMs: number;
    averageCancellationLatencyMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd?: number;
    costCoverageRate: number;
  };
}

export interface LiveCodingGradeInput {
  provider: string;
  model: string;
  status: LiveCodingTrial['status'];
  latencyMs: number;
  cancellationLatencyMs?: number;
  cancellationSucceeded?: boolean;
  implementation: string;
  events: readonly LedgerEvent[];
  ledgerValid: boolean;
  reasonCodes?: string[];
  error?: string;
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function gradeLiveCodingTrial(input: LiveCodingGradeInput): LiveCodingTrial {
  const proposed = input.events.filter(event => event.type === 'model.proposed');
  const proposalFailureCount = input.events.filter(event => event.type === 'model.proposal_failed').length;
  const proposalRejectionCount = input.events.filter(event => event.type === 'model.proposal_rejected').length;
  const proposalFailureReasons = input.events
    .filter(event => event.type === 'model.proposal_failed')
    .map(event => String(event.payload.reason ?? 'MODEL_PROPOSAL_FAILED'));
  const proposalRejectionReasons = input.events
    .filter(event => event.type === 'model.proposal_rejected')
    .map(event => String(event.payload.reasonCode ?? event.payload.reason ?? 'MODEL_PROPOSAL_REJECTED'));
  const actionEvents = input.events.filter(event => event.type === 'action.executed');
  const observedProposalIds = new Set(input.events
    .filter(event => event.type === 'state.observed')
    .map(event => String(event.payload.proposalId ?? '')));
  const actionTrace = actionEvents.map(event => ({
    capabilityId: String(event.payload.capabilityId ?? 'unknown'),
    success: event.payload.success === true,
    summary: String(event.payload.summary ?? '').slice(0, 300),
    ...(typeof event.payload.errorCode === 'string' ? { errorCode: event.payload.errorCode } : {}),
    ...(typeof event.payload.effectState === 'string' ? { effectState: event.payload.effectState } : {}),
    observed: observedProposalIds.has(String(event.payload.proposalId ?? '')),
  }));
  const policyTrace = input.events.filter(event => event.type === 'policy.decided').map(event => ({
    proposalId: String(event.payload.proposalId ?? ''),
    disposition: String(event.payload.disposition ?? 'unknown'),
    ...(typeof event.payload.capabilityId === 'string' ? { capabilityId: event.payload.capabilityId } : {}),
    ...(typeof event.payload.target === 'string' ? { target: event.payload.target } : {}),
    reasonCodes: Array.isArray(event.payload.reasonCodes)
      ? event.payload.reasonCodes.map(String)
      : [],
  }));
  const usages = proposed.map(event => event.payload.usage as Record<string, unknown> | undefined);
  const observedCosts = usages.flatMap(usage => typeof usage?.costUsd === 'number' ? [usage.costUsd] : []);
  const costObserved = observedCosts.length === usages.length && usages.length > 0;
  const modelPassTrace = proposed.map(event => {
    const usage = event.payload.usage as Record<string, unknown> | undefined;
    const audit = event.payload.requestAudit as Record<string, unknown> | undefined;
    const proposal = event.payload.proposal as Record<string, unknown> | undefined;
    return {
      step: numberField(event.payload.step),
      ...(typeof audit?.inferencePurpose === 'string' ? { purpose: audit.inferencePurpose } : {}),
      proposalKind: typeof proposal?.kind === 'string' ? proposal.kind : 'unknown',
      inputTokens: numberField(usage?.inputTokens), outputTokens: numberField(usage?.outputTokens),
      cachedInputTokens: numberField(usage?.cachedInputTokens), reasoningTokens: numberField(usage?.reasoningTokens),
      latencyMs: numberField(usage?.latencyMs),
      ...(typeof audit?.estimatedTokens === 'number' ? { estimatedTokens: audit.estimatedTokens } : {}),
      ...(typeof audit?.tokenEstimateError === 'number' ? { tokenEstimateError: audit.tokenEstimateError } : {}),
    };
  });
  const observations = input.events.filter(event => event.type === 'state.observed');
  const testExitObserved = observations.some(event => {
    const value = event.payload.value as Record<string, unknown> | undefined;
    return event.payload.capabilityId === 'workspace.process.run'
      && value?.exitCode === 0
      && typeof value.stdout === 'string'
      && value.stdout.includes('VERIFIED_ADD_RESULT_5');
  });
  const patchProvenanceObserved = observations.some(event => {
    const value = event.payload.value as Record<string, unknown> | undefined;
    return event.payload.capabilityId === 'workspace.file.patch'
      && typeof value?.previousSha256 === 'string'
      && typeof value.newSha256 === 'string';
  });
  const implementationCorrect = input.implementation.includes('a + b')
    && !input.implementation.includes('a - b');
  const modelCalls = proposed.filter(event => numberField((event.payload.usage as Record<string, unknown> | undefined)?.latencyMs) > 0).length
    + proposalFailureCount;
  const proposalAttempts = proposed.length + proposalFailureCount;
  const toolCallValidity = proposalAttempts === 0
    ? 0
    : Math.max(0, (proposalAttempts - proposalFailureCount - proposalRejectionCount) / proposalAttempts);
  const cancellationPassed = input.cancellationSucceeded === true
    && input.cancellationLatencyMs !== undefined
    && input.cancellationLatencyMs <= 2_000;
  const taskCompleted = input.status === 'completed' && implementationCorrect && testExitObserved && patchProvenanceObserved;
  const ledgerValid = input.ledgerValid;
  const qualityScore = [implementationCorrect, testExitObserved, patchProvenanceObserved, ledgerValid, cancellationPassed]
    .filter(Boolean).length / 5;
  return {
    provider: input.provider,
    model: input.model,
    status: input.status,
    latencyMs: input.latencyMs,
    cancellationLatencyMs: input.cancellationLatencyMs,
    cancellationSucceeded: input.cancellationSucceeded,
    modelCalls,
    actionCount: actionEvents.length,
    inputTokens: usages.reduce((total, usage) => total + numberField(usage?.inputTokens), 0),
    outputTokens: usages.reduce((total, usage) => total + numberField(usage?.outputTokens), 0),
    cachedInputTokens: usages.reduce((total, usage) => total + numberField(usage?.cachedInputTokens), 0),
    reasoningTokens: usages.reduce((total, usage) => total + numberField(usage?.reasoningTokens), 0),
    ...(costObserved ? { costUsd: observedCosts.reduce((total, cost) => total + cost, 0) } : {}),
    costObserved,
    proposalFailureCount,
    proposalRejectionCount,
    proposalFailureReasons,
    proposalRejectionReasons,
    modelPassTrace,
    actionTrace,
    policyTrace,
    toolCallValidity,
    implementationCorrect,
    testExitObserved,
    patchProvenanceObserved,
    ledgerValid,
    cancellationPassed,
    taskCompleted,
    qualityScore,
    passed: taskCompleted && ledgerValid && cancellationPassed && toolCallValidity === 1,
    reasonCodes: [...(input.reasonCodes ?? [])],
    ...(input.error ? { error: input.error } : {}),
  };
}

function codingWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'hyper-live-coding-'));
  mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, 'lib', 'math.ts'), 'export const add = (a: number, b: number) => a - b; // BUG_ADD\n');
  writeFileSync(join(root, 'math.test.ts'), [
    "import { add } from './lib/math';",
    'const actual = add(2, 3);',
    "if (actual !== 5) { process.stderr.write(`EXPECTED_5_RECEIVED_${actual}\\n`); process.exit(1); }",
    "process.stdout.write('VERIFIED_ADD_RESULT_5\\n');",
    '',
  ].join('\n'));
  return root;
}

async function cancellationProbe(driver: ModelDriver): Promise<{ latencyMs: number; succeeded: boolean }> {
  const controller = new AbortController();
  controller.abort(new DOMException('Cancelled by live coding benchmark.', 'AbortError'));
  const started = performance.now();
  try {
    await driver.propose({
      id: 'context:live-coding-cancel', runId: 'run:live-coding-cancel', phase: 'orient',
      objective: 'Inspect workspace/lib/math.ts.', strategyId: 'strategy:live-coding',
      constraints: [], focusTags: [], compiledAt: new Date().toISOString(),
      items: [], excludedSourceIds: [], exclusions: [], estimatedTokens: 0, tokenBudget: 512,
      audit: {
        sourcesConsidered: 0, sourcesIncluded: 0, stableItems: 0, dynamicItems: 0,
        stableTokens: 0, dynamicTokens: 0, duplicateTokensRemoved: 0, budgetUtilization: 0,
        tokensByAuthority: {}, tokensBySemanticTag: {},
      },
    }, [], {
      intentId: 'intent:live-coding-cancel', principalId: 'agent:live-coding', authorizedCapabilityIds: [],
      requiredConditionIds: [], requiredEvidence: [], riskBudget: 1, activeStrategyId: 'strategy:live-coding',
      inferencePurpose: 'tool_selection',
    }, controller.signal);
    return { latencyMs: performance.now() - started, succeeded: false };
  } catch {
    return { latencyMs: performance.now() - started, succeeded: true };
  }
}

async function runRoute(route: LiveRoute, driverFactory: (route: LiveRoute) => Promise<ModelDriver>): Promise<LiveCodingTrial> {
  const root = codingWorkspace();
  const started = performance.now();
  let events: readonly LedgerEvent[] = [];
  let implementation = readFileSync(join(root, 'lib', 'math.ts'), 'utf8');
  try {
    const driver = await driverFactory(route);
    const runner = new WorkflowRunner({
      model: driver,
      capabilities: new CapabilityRegistry()
        .register(new RepositorySearchCapability(root))
        .register(new ReadFileCapability(root))
        .register(new PatchFileCapability(root))
        .register(new BoundedProcessCapability(root, {
          allowedExecutables: [process.execPath], environment: { PATH: process.env.PATH ?? '' },
          maxOutputBytes: 32_000, maxTimeoutMs: 20_000,
        })),
    });
    const createdAt = new Date().toISOString();
    const source: ContextSource = {
      id: `goal:live-coding:${route.id}`, title: 'Live coding smoke task',
      content: 'BUG_ADD marks the defective implementation. Inspect current state; never guess file contents.',
      kind: 'goal', authority: 'directive', validity: 'active', provenance: ['benchmark:live-coding'],
      tags: ['coding', 'inspect', 'test'], createdAt, priority: 100,
    };
    const result = await runner.run({
      runId: `live-coding:${route.id}:${Date.now()}`,
      intent: {
        id: `intent:live-coding:${route.id}`, version: CONTRACT_VERSION,
        objective: 'Fix BUG_ADD in workspace/lib/math.ts so add(2, 3) returns 5, then run workspace/math.test.ts with the configured Bun executable and complete only after exit code 0.',
        principals: ['agent:live-coding'],
        authorizedCapabilities: ['workspace.repository.search', 'workspace.file.read', 'workspace.file.patch', 'workspace.process.run'],
        authorizedResources: ['workspace/**'], prohibitedEffects: ['state.delete', 'network.request'],
        requiredConditionIds: ['condition:live-workspace'],
        requiredEvidence: ['capability:workspace.file.patch', 'effect:process.execute'],
        riskBudget: 4, approvalAboveRisk: 5,
        completionCriteria: ['The inspected implementation is patched and the focused test exits successfully.'],
      },
      conditions: [{
        id: 'condition:live-workspace', statement: 'The isolated benchmark workspace is current.', status: 'active',
        evidenceRefs: ['benchmark:workspace-created'], source: 'live-coding-benchmark', observedAt: createdAt,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }],
      constraints: [
        'Search and read before patching; use the observed SHA-256 precondition.',
        `Use only the executable enum supplied by workspace.process.run and arguments ["math.test.ts"].`,
        'If a command fails, use its observed diagnostics before changing the implementation.',
      ],
      sources: [source], initialStrategyId: 'strategy:live-coding', focusTags: ['coding', 'inspect', 'test'],
      proposalCapabilityIds: ['workspace.repository.search', 'workspace.file.read', 'workspace.file.patch', 'workspace.process.run'],
      tokenBudget: 3_000, maxSteps: 8, maxWallTimeMs: 120_000,
    });
    events = runner.ledger.forRun(result.runId);
    implementation = readFileSync(join(root, 'lib', 'math.ts'), 'utf8');
    const cancellation = await cancellationProbe(driver);
    return gradeLiveCodingTrial({
      provider: route.id, model: route.model ?? 'unknown', status: result.status,
      latencyMs: performance.now() - started, cancellationLatencyMs: cancellation.latencyMs,
      cancellationSucceeded: cancellation.succeeded,
      implementation, events, ledgerValid: runner.ledger.verifyIntegrity().valid,
      reasonCodes: result.reasonCodes,
    });
  } catch (error) {
    return gradeLiveCodingTrial({
      provider: route.id, model: route.model ?? 'unknown', status: 'driver_failed',
      latencyMs: performance.now() - started, implementation, events, ledgerValid: true,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runLiveCodingExperiment(
  environment: Record<string, string | undefined> = process.env,
  driverFactory: (route: LiveRoute) => Promise<ModelDriver> = createModelDriver,
): Promise<LiveCodingReport> {
  if (environment.HYPER_LIVE_CODING !== '1') {
    throw new Error('Live coding eval is disabled. Set HYPER_LIVE_CODING=1 to authorize bounded provider calls.');
  }
  const available = configuredLiveRoutes(environment);
  const maximumProviders = Math.max(1, Number.parseInt(environment.HYPER_LIVE_CODING_MAX_PROVIDERS ?? '2', 10) || 2);
  const routes = available.slice(0, maximumProviders);
  if (routes.length === 0) throw new Error('No selected live coding provider is configured.');
  const trials: LiveCodingTrial[] = [];
  for (const route of routes) trials.push(await runRoute(route, driverFactory));
  const sum = (field: keyof LiveCodingTrial) => trials.reduce((total, trial) => total + numberField(trial[field]), 0);
  const costTrials = trials.filter(trial => trial.costObserved);
  return {
    benchmark: 'hyper-live-coding-smoke', version: '1.0.0', evidenceClass: 'live_model',
    claimBoundary: 'Credentialed smoke evidence for one synthetic repository task; not a general coding-quality estimate.',
    generatedAt: new Date().toISOString(), providers: routes.map(route => route.id), trials,
    metrics: {
      passRate: trials.filter(trial => trial.passed).length / trials.length,
      taskCompletionRate: trials.filter(trial => trial.taskCompleted).length / trials.length,
      toolCallValidity: sum('toolCallValidity') / trials.length,
      averageLatencyMs: sum('latencyMs') / trials.length,
      averageCancellationLatencyMs: sum('cancellationLatencyMs') / Math.max(1, trials.filter(trial => trial.cancellationLatencyMs !== undefined).length),
      totalInputTokens: sum('inputTokens'), totalOutputTokens: sum('outputTokens'),
      ...(costTrials.length ? { totalCostUsd: costTrials.reduce((total, trial) => total + (trial.costUsd ?? 0), 0) } : {}),
      costCoverageRate: costTrials.length / trials.length,
    },
  };
}

if (import.meta.main) {
  const report = await runLiveCodingExperiment();
  const output = resolve(process.cwd(), 'evals/results/live-coding-latest.json');
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Live Coding Evals: pass_rate=${report.metrics.passRate.toFixed(3)} providers=${report.providers.join(',')}`);
  console.log(`Results: ${output}`);
  if (report.metrics.passRate < 1) process.exitCode = 1;
}
