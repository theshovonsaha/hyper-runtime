import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  CONTRACT_VERSION,
  type CapabilityAdapter,
  type DelegationContract,
  type DelegationResult,
  type IntentContract,
  type InterruptedEffect,
} from '@hyper/contracts';
import {
  DelegationBudgetPool,
  CancellableChildWorkerExecutor,
  signDelegationResult,
  validateDelegationResult,
} from '@hyper/delegation';
import { ReviewedSkillRegistry, detectContextSignals } from '@hyper/context';
import {
  HashChainLedger,
  pendingInterruptedEffects,
  rebuildCanonicalRunProjection,
  recoverInterruptedEffects,
} from '@hyper/runtime';
import { DeterministicLifecycle, LifecycleHookError } from '@hyper/workflow';
import { OciContainerSandboxBackend } from '@hyper/capabilities';

const intent: IntentContract = {
  id: 'intent:hardening', version: CONTRACT_VERSION, objective: 'Inspect one verified result.',
  principals: ['agent:test'], authorizedCapabilities: ['workspace.file.read'], authorizedResources: ['workspace/**'],
  prohibitedEffects: ['state.write', 'state.delete', 'network.request', 'process.execute'], requiredConditionIds: [],
  requiredEvidence: [], riskBudget: 2, approvalAboveRisk: 2, completionCriteria: ['Observed result exists.'],
};
const contract: DelegationContract = {
  id: 'delegation:hardening', version: CONTRACT_VERSION, parentRunId: 'run:parent', childRunId: 'run:child',
  childIntent: intent, contextRefs: [], budget: { tokenBudget: 100, actionBudget: 2, wallTimeMs: 100 },
  expectedOutputSchema: { type: 'object' },
  verification: { minimumEvidence: 1, requireVerifiedCompletion: true },
};
const result: DelegationResult = {
  delegationId: contract.id, childRunId: contract.childRunId, status: 'completed', output: {},
  evidenceRefs: ['evidence:1'], policyViolations: [], verificationPassed: true,
  budgetUsage: { inputTokens: 10, outputTokens: 5, actions: 1, wallTimeMs: 20 }, childReceiptHash: 'receipt',
};

describe('convergence hardening mechanisms', () => {
  test('reconciles a prepared effect without replaying it and rebuilds the projection', async () => {
    const ledger = new HashChainLedger();
    ledger.append('run:recover', 'workflow.started', { objective: 'Recover safely.' });
    ledger.append('run:recover', 'effect.prepared', {
      proposalId: 'proposal:1', capabilityId: 'fixture.recover', target: 'workspace/a',
      idempotencyKey: 'effect:1', declaredEffects: ['state.write'], idempotent: true,
    });
    let recovered = 0;
    const capability = { recoverInterrupted: async (effect: InterruptedEffect) => {
      recovered += 1;
      return { effectId: effect.idempotencyKey, state: 'not_applied' as const, retrySafe: true,
        summary: 'No effect found.', evidence: [] };
    } } as unknown as CapabilityAdapter;
    expect(pendingInterruptedEffects(ledger.forRun('run:recover'))).toHaveLength(1);
    const recovery = await recoverInterruptedEffects({
      runId: 'run:recover', ledger, capabilities: { get: id => id === 'fixture.recover' ? capability : undefined },
    });
    expect(recovery[0]?.reasonCode).toBe('INTERRUPTED_EFFECT_RECONCILED');
    expect(recovered).toBe(1);
    expect(pendingInterruptedEffects(ledger.forRun('run:recover'))).toHaveLength(0);
    const projection = rebuildCanonicalRunProjection(ledger.forRun('run:recover'));
    expect(projection.pendingEffects).toHaveLength(0);
    expect(projection.timeline.some(item => item.title === 'Interrupted effect reconciled')).toBeTrue();
  });

  test('reserves concurrent child budgets atomically and settles only actual usage', () => {
    const pool = new DelegationBudgetPool({ tokenBudget: 100, actionBudget: 4, wallTimeMs: 1_000 });
    expect(pool.reserve('a', { tokenBudget: 70, actionBudget: 2, wallTimeMs: 600 }).accepted).toBeTrue();
    expect(pool.reserve('b', { tokenBudget: 40, actionBudget: 2, wallTimeMs: 500 }).reasonCodes).toContain('TOKEN_BUDGET_NOT_AVAILABLE');
    pool.settle('a', { inputTokens: 20, outputTokens: 10, actions: 1, wallTimeMs: 200 });
    expect(pool.remaining()).toEqual({ tokenBudget: 70, actionBudget: 3, wallTimeMs: 800 });
    expect(pool.reserve('b', { tokenBudget: 40, actionBudget: 2, wallTimeMs: 500 }).accepted).toBeTrue();
    const hostile = new DelegationBudgetPool({ tokenBudget: 100, actionBudget: 10, wallTimeMs: 1_000 });
    expect(hostile.reserve('hostile', { tokenBudget: 50, actionBudget: 5, wallTimeMs: 500 }).accepted).toBeTrue();
    hostile.settle('hostile', {
      inputTokens: Number.NaN, outputTokens: 0, actions: -1, wallTimeMs: Number.POSITIVE_INFINITY,
    });
    expect(hostile.remaining()).toEqual({ tokenBudget: 50, actionBudget: 5, wallTimeMs: 500 });
  });

  test('accepts only a trusted Ed25519-attested child receipt', () => {
    const keys = generateKeyPairSync('ed25519');
    const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signed = signDelegationResult(result, { keyId: 'worker:1', privateKeyPem });
    const attested = { ...contract, verification: { ...contract.verification,
      receiptAttestation: { required: true, trustedKeyIds: ['worker:1'] } } };
    expect(validateDelegationResult(attested, signed, { 'worker:1': publicKeyPem })).toEqual([]);
    expect(validateDelegationResult(attested, { ...signed, childReceiptHash: 'tampered' }, { 'worker:1': publicKeyPem }))
      .toContain('CHILD_RECEIPT_ATTESTATION_DIGEST_MISMATCH');
  });

  test('terminates an isolated worker when its parent signal aborts', async () => {
    const abort = new AbortController();
    let terminated = '';
    const executor = new CancellableChildWorkerExecutor({ start: () => ({
      result: new Promise<DelegationResult>(() => {}),
      async terminate(reason) { terminated = reason; },
    }) });
    const pending = executor.run({ contract, childIntent: intent, context: [], signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrow('CHILD_WORKER_TERMINATED');
    expect(terminated).toBe('wall-time-or-parent-abort');
  });

  test('loads only reviewed procedural knowledge through bounded disclosure', () => {
    const skills = new ReviewedSkillRegistry().register({
      id: 'skill:inspect', version: '1', title: 'Inspect files', description: 'Read and verify a file.',
      triggers: ['inspect', 'file'], content: 'Read once. Verify the digest.',
      references: [{ id: 'ref:format', title: 'Format', content: 'Return a short result.' }],
      review: { status: 'reviewed', reviewerId: 'human:reviewer', reviewedAt: '2026-08-09T00:00:00.000Z', contentDigest: 'sha256:fixture' },
    });
    expect(skills.catalog('inspect')).toHaveLength(1);
    expect(skills.load('skill:inspect').references).toHaveLength(0);
    expect(skills.load('skill:inspect', ['ref:format']).references).toHaveLength(1);
  });

  test('flags explicit drift, goal mismatch, contradictions, and history dominance without changing authority', () => {
    const sources = [{ id:'goal:new',title:'Direction',content:'Book a flight tomorrow',kind:'conversation' as const,
      authority:'data' as const,validity:'active' as const,provenance:['turn:1'],tags:[],createdAt:'2026-08-09T00:00:00.000Z',priority:90,
      semanticTag:'current_direction' as const },{ id:'drift:1',title:'Changed premise',content:'The file format changed.',kind:'diagnostic' as const,
      authority:'evidence' as const,validity:'active' as const,provenance:['event:1'],tags:[],createdAt:'2026-08-09T00:00:00.000Z',priority:90,
      semanticTag:'drift' as const,relations:[{kind:'contradicts' as const,targetId:'goal:new',evidenceRefs:['event:1']}] }];
    const signals = detectContextSignals({ objective: 'Inspect README runtime architecture', sources });
    expect(signals.map(signal => signal.kind)).toEqual(expect.arrayContaining(['representation_drift','goal_mismatch','contradiction']));
    expect(signals.every(signal => 'requiresHumanReview' in signal)).toBeTrue();
  });

  test('runs lifecycle hooks in stable order and fails closed deterministically', () => {
    const order: string[] = [];
    const lifecycle = new DeterministicLifecycle([
      { id:'b',stage:'run_start',order:2,failureMode:'record_and_continue',handle(){order.push('b');}},
      { id:'a',stage:'run_start',order:1,failureMode:'record_and_continue',handle(){order.push('a');return {ok:true};}},
    ]);
    lifecycle.dispatch('run_start',{objective:'x'});
    expect(order).toEqual(['a','b']);
    const closed = new DeterministicLifecycle([{ id:'deny',stage:'before_action',order:1,failureMode:'fail_closed',handle(){throw new Error('blocked');} }]);
    expect(()=>closed.dispatch('before_action',{})).toThrow(LifecycleHookError);
  });

  test('builds a networkless, read-only, capability-dropped OCI command from a pinned image', () => {
    const backend = new OciContainerSandboxBackend({ image: `hyper/worker@sha256:${'a'.repeat(64)}` });
    const command = backend.command({ workspaceRoot:'/workspace/root',cwd:'/workspace/root/sub',executable:'bun',arguments:['test'] });
    expect(command).toContain('none');
    expect(command).toContain('--read-only');
    expect(command).toContain('ALL');
    expect(command).toContain('/workspace/sub');
  });
});
