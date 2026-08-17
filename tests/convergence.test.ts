import { describe, expect, test } from 'bun:test';
import {
  CONTRACT_VERSION,
  type ActionProposal,
  type ComposedWorkflowPlan,
  type Condition,
  type ContextRecord,
  type IntentContract,
  type ModelProposalResult,
  type WorkflowRunResult,
} from '@hyper/contracts';
import { DynamicContextCompiler, StructuredContextLedger } from '@hyper/context';
import { InMemoryWorkspaceCapability, type MemoryWriteArgs } from '@hyper/capability-memory';
import {
  RecordingModelDriver,
  ReplayModelDriver,
  ScriptedModelDriver,
  modelRequestFingerprint,
} from '@hyper/model';
import { compileNaturalLanguageWorkflow, compileSemanticWorkflowConfig, compileWorkflowConfig, crystallizeVerifiedWorkflow, activateWorkflowCandidate } from '@hyper/planning';
import { AuthorizedRuntime } from '@hyper/runtime';
import {
  CapabilityRegistry,
  ComposedWorkflowRunner,
  StructuralOutcomeVerifier,
  VerifierRegistry,
} from '@hyper/workflow';
import { backtestWorkflowCandidate, runRuntimeLab, runSpecializedAgentBenchmark } from '@hyper/evals';

const now = '2026-01-15T12:00:00.000Z';
const intent: IntentContract = {
  id: 'intent:convergence', version: CONTRACT_VERSION, objective: 'Write and verify state.',
  principals: ['agent:test'], authorizedCapabilities: ['memory.workspace.write'],
  authorizedResources: ['workspace/**'], prohibitedEffects: ['state.delete', 'network.request', 'process.execute'],
  requiredConditionIds: ['condition:current'], requiredEvidence: ['observed_state'], riskBudget: 3,
  approvalAboveRisk: 3, completionCriteria: ['State is observed.'],
};
const conditions: Condition[] = [{
  id: 'condition:current', statement: 'Current.', status: 'active', evidenceRefs: ['clock'],
  source: 'test', observedAt: '2026-01-15T11:59:00.000Z', expiresAt: '2026-01-15T12:05:00.000Z',
}];
const action: ActionProposal<MemoryWriteArgs> = {
  id: 'proposal:compose', intentId: intent.id, principalId: 'agent:test', conditionIds: ['condition:current'],
  capabilityId: 'memory.workspace.write', target: 'workspace/result.txt', declaredEffects: ['state.write'],
  risk: 1, expectedEvidence: ['observed_state'], idempotencyKey: 'compose:1', args: { value: 'done' },
};

function packet() {
  return new DynamicContextCompiler().compile({
    runId: 'run:replay', phase: 'plan', objective: intent.objective, constraints: [], strategyId: 'direct',
    focusTags: [], sources: [], tokenBudget: 100, now,
  });
}

describe('runtime convergence boundaries', () => {
  test('records and exactly replays a validated model request', async () => {
    const proposal = { kind: 'complete' as const, strategyId: 'direct', evidenceRefs: [] };
    const recorder = new RecordingModelDriver(new ScriptedModelDriver([proposal]));
    const scope = {
      intentId: intent.id, principalId: 'agent:test', authorizedCapabilityIds: [], requiredConditionIds: [],
      requiredEvidence: [], riskBudget: 3, activeStrategyId: 'direct',
    };
    const original = await recorder.propose(packet(), [], scope);
    expect(recorder.cassette[0]?.requestFingerprint).toBe(modelRequestFingerprint(packet(), [], scope));
    const replayed = await new ReplayModelDriver(recorder.cassette).propose(packet(), [], scope);
    expect(replayed.proposal).toEqual(original.proposal);
    expect(replayed.model.startsWith('replay:')).toBeTrue();
    await expect(new ReplayModelDriver(recorder.cassette).propose(
      { ...packet(), objective: 'changed request' }, [], scope,
    )).rejects.toThrow('MODEL_REPLAY_REQUEST_MISMATCH');
  });

  test('keeps contradiction edges inspectable and reports them in packet audit', () => {
    const ledger = new StructuredContextLedger();
    const base = {
      tag: 'evidence' as const, authority: 'evidence' as const, confidence: 0.8, priority: 70,
      createdAt: now, searchTags: ['plan'], rebuildable: true, status: 'active' as const,
    };
    const first: ContextRecord = { ...base, id: 'fact:a', title: 'A', content: 'Provider says enabled.', sourceEventIds: ['event:a'] };
    const second: ContextRecord = {
      ...base, id: 'fact:b', title: 'B', content: 'Provider says disabled.', sourceEventIds: ['event:b'],
      relations: [{ kind: 'contradicts', targetId: 'fact:a', evidenceRefs: ['event:b'] }],
    };
    ledger.append(first); ledger.append(second);
    const compiled = new DynamicContextCompiler().compile({
      runId: 'run:context', phase: 'plan', objective: 'Resolve provider state.', constraints: [],
      strategyId: 'direct', focusTags: ['plan'], sources: ledger.sources(now), tokenBudget: 200, now,
    });
    expect(compiled.items.map(item => item.sourceId)).toEqual(['fact:a', 'fact:b']);
    expect(compiled.audit.contradictionCount).toBe(1);
    expect(compiled.audit.unresolvedConflictIds).toEqual(['fact:a<->fact:b']);
  });

  test('executes bounded composition through policy and semantic verification', async () => {
    const runtime = new AuthorizedRuntime();
    const capabilities = new CapabilityRegistry().register(new InMemoryWorkspaceCapability());
    const verifiers = new VerifierRegistry().register(new StructuralOutcomeVerifier());
    const runner = new ComposedWorkflowRunner(runtime, capabilities, verifiers);
    const plan: ComposedWorkflowPlan = {
      id: 'plan:composed', version: '1.0', intent,
      root: { id: 'root', kind: 'sequence', children: [
        { id: 'gate', kind: 'gate', reason: 'operator requested execution', child: {
          id: 'choice', kind: 'choice', predicate: { fact: 'enabled', operator: 'equals', value: true },
          whenTrue: { id: 'write', kind: 'action', proposal: action },
        } },
        { id: 'loop', kind: 'loop', predicate: { fact: 'continue', operator: 'equals', value: true }, maxIterations: 2,
          body: { id: 'never', kind: 'action', proposal: { ...action, id: 'proposal:never', idempotencyKey: 'never' } } },
        { id: 'child', kind: 'subworkflow', intent: { ...intent, riskBudget: 2 }, child: {
          id: 'semantic', kind: 'verify', verifierIds: ['structural'], claims: ['State was observed.'],
        } },
      ] },
    };
    const results = await runner.run(plan, {
      runId: 'run:composed', now: () => now, conditions, facts: { enabled: true, continue: false },
      approveGate: async () => true,
    });
    expect(results.find(result => result.nodeId === 'write')?.status).toBe('completed');
    expect(results.find(result => result.nodeId === 'loop')?.status).toBe('completed');
    expect(results.find(result => result.nodeId === 'semantic')?.status).toBe('completed');
    expect(runtime.ledger.forRun('run:composed').some(event => event.type === 'policy.decided')).toBeTrue();
  });

  test('blocks a subworkflow that attempts to widen parent authority', async () => {
    const runtime = new AuthorizedRuntime();
    const runner = new ComposedWorkflowRunner(runtime, new CapabilityRegistry(), new VerifierRegistry());
    const results = await runner.run({
      id: 'plan:widen', version: '1.0', intent,
      root: { id: 'child', kind: 'subworkflow', intent: { ...intent, authorizedResources: ['**'] },
        child: { id: 'noop', kind: 'sequence', children: [] } },
    }, { runId: 'run:widen', now: () => now, conditions });
    expect(results.find(result => result.nodeId === 'child')?.reasonCodes).toContain('SUBWORKFLOW_AUTHORITY_EXPANDED');
  });

  test('compiles and runs bounded deterministic, model, and parallel nodes', async () => {
    const compiled = compileWorkflowConfig({
      id: 'plan:semantic', version: '1.0', intent,
      root: { id: 'root', kind: 'sequence', children: [
        { id: 'parallel', kind: 'parallel', maxConcurrency: 2, children: [
          { id: 'normalize', kind: 'deterministic', adapterId: 'normalize', input: { value: '  READY ' },
            outputFact: 'normalized', outputSchema: { type: 'string' } },
          { id: 'classify', kind: 'model', operation: 'classify_status', input: { value: 'ready' },
            outputFact: 'classification', outputSchema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } } },
        ] },
        { id: 'route', kind: 'choice', predicate: { fact: 'normalized', operator: 'equals', value: 'ready' },
          whenTrue: { id: 'verified', kind: 'verify', verifierIds: ['structural'], claims: ['Bounded operations completed.'] } },
      ] },
    });
    const runtime = new AuthorizedRuntime();
    const runner = new ComposedWorkflowRunner(
      runtime,
      new CapabilityRegistry(),
      new VerifierRegistry().register({ id: 'structural', verify: async request => ({
        passed: request.claims.length > 0, reasonCodes: ['CLAIM_PRESENT'], evidence: [],
      }) }),
      {
        deterministicSteps: [{ id: 'normalize', execute: input => String(input.value).trim().toLowerCase() }],
        modelOperations: { execute: async request => ({ status: request.input.value }) },
      },
    );
    const results = await runner.run(compiled, { runId: 'run:semantic', now: () => now, conditions });
    expect(results.find(result => result.nodeId === 'parallel')?.status).toBe('completed');
    expect(results.find(result => result.nodeId === 'verified')?.status).toBe('completed');
    expect(runtime.ledger.forRun('run:semantic').filter(event => event.type === 'workflow.fact_recorded')).toHaveLength(2);
  });

  test('rejects unbounded or duplicate semantic workflow config', () => {
    expect(() => compileWorkflowConfig({
      id: 'plan:bad', version: '1.0', intent,
      root: { id: 'same', kind: 'parallel', maxConcurrency: 0, children: [] },
    })).toThrow('WORKFLOW_PARALLEL_BOUND_INVALID');
    expect(() => compileWorkflowConfig({
      id: 'plan:duplicate', version: '1.0', intent,
      root: { id: 'same', kind: 'sequence', children: [
        { id: 'same', kind: 'verify', verifierIds: ['structural'], claims: ['x'] },
      ] },
    })).toThrow('WORKFLOW_NODE_ID_INVALID');
  });

  test('lowers semantic use steps only through reviewed inert adapters', () => {
    const plan = compileSemanticWorkflowConfig({
      workflow: 'research:verified',
      intent,
      steps: [
        { use: 'normalize_query', with: { query: '  Runtime recovery  ' } },
        { use: 'verify_evidence' },
      ],
    }, [{
      id: 'normalize_query',
      compile: ({ nodeId, parameters }) => ({
        id: nodeId, kind: 'deterministic', adapterId: 'normalize_query', input: { query: parameters.query },
        outputFact: 'research_query', outputSchema: { type: 'string' },
      }),
    }, {
      id: 'verify_evidence',
      compile: ({ nodeId }) => ({ id: nodeId, kind: 'verify', verifierIds: ['citations'], claims: ['Sources are linked.'] }),
    }]);
    expect(plan.root).toMatchObject({ kind: 'sequence', children: [
      { kind: 'deterministic', adapterId: 'normalize_query' },
      { kind: 'verify', verifierIds: ['citations'] },
    ] });
    expect(() => compileSemanticWorkflowConfig({
      workflow: 'research:unsafe', intent, steps: [{ use: 'arbitrary_shell' }],
    }, [])).toThrow('SEMANTIC_WORKFLOW_OPERATION_UNAVAILABLE');
  });

  test('crystallization remains inert until verified backtest and human activation', () => {
    const plan = compileNaturalLanguageWorkflow({ message: 'Inspect runtime status.', sessionId: 'session:1', intentId: intent.id, now, idFactory: () => 'candidate' });
    const run: WorkflowRunResult = {
      runId: 'run:verified', status: 'completed', steps: [], activeStrategyId: 'direct',
      completion: { passed: true, reasonCodes: ['VERIFIED'], evidence: [] }, reasonCodes: ['COMPLETED'], receiptHash: 'receipt',
    };
    const candidate = crystallizeVerifiedWorkflow({ id: 'candidate:1', plan, sourceRuns: [run], now });
    expect(candidate.status).toBe('candidate');
    expect(() => activateWorkflowCandidate(candidate, {
      candidateId: candidate.id, scenarioCount: 1, passed: 0, failed: 1, mutationsSurvived: 0, acceptancePassed: false,
    }, { candidateId: candidate.id, principalId: 'human', approvedAt: now, receiptId: 'approval:1' })).toThrow('BACKTEST_FAILED');
    expect(activateWorkflowCandidate(candidate, {
      candidateId: candidate.id, scenarioCount: 2, passed: 2, failed: 0, mutationsSurvived: 2, acceptancePassed: true,
    }, { candidateId: candidate.id, principalId: 'human', approvedAt: now, receiptId: 'approval:1' }).status).toBe('ready');
  });

  test('scenario lab proves injected failures and event assertions', async () => {
    const report = await runRuntimeLab();
    expect(report.acceptance.passed).toBeTrue();
    expect(report.trials).toHaveLength(10);
    expect(report.metrics.falseSuccessPreventionRate).toBe(1);
    expect(report.metrics.modelCalls).toBe(0);
  });

  test('specialized benchmark runs 50 frozen mutations with reproducible traces', async () => {
    const report = await runSpecializedAgentBenchmark();
    expect(report.acceptance.passed).toBeTrue();
    expect(report.trialCount).toBe(50);
    expect(report.replayFidelity).toBe(1);
    expect(report.reachableOnlyBaseline.falseSuccessRate).toBeGreaterThan(0);
  });

  test('candidate backtest requires every base and mutation scenario to survive', async () => {
    const plan = compileNaturalLanguageWorkflow({ message: 'Inspect runtime status.', sessionId: 'session:1', intentId: intent.id, now, idFactory: () => 'backtest' });
    const run: WorkflowRunResult = {
      runId: 'run:backtest', status: 'completed', steps: [], activeStrategyId: 'direct',
      completion: { passed: true, reasonCodes: [], evidence: [] }, reasonCodes: [], receiptHash: 'receipt',
    };
    const candidate = crystallizeVerifiedWorkflow({ id: 'candidate:backtest', plan, sourceRuns: [run], now });
    const report = await backtestWorkflowCandidate(candidate, [value => value.plan.steps.length > 0], [{
      id: 'safe-title-mutation', apply: value => ({ ...value, plan: { ...value.plan, objective: `${value.plan.objective} safely` } }),
    }]);
    expect(report.acceptancePassed).toBeTrue();
    expect(report.mutationsSurvived).toBe(1);
  });
});
