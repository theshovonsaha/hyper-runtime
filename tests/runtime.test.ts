import { describe, expect, test } from 'bun:test';
import {
  CONTRACT_VERSION,
  type ActionProposal,
  type CapabilityAdapter,
  type Condition,
  type IntentContract,
} from '@hyper/contracts';
import { InMemoryWorkspaceCapability, type MemoryWriteArgs } from '@hyper/capability-memory';
import {
  AuthorizedRuntime,
  DeterministicPolicyEngine,
  HashChainLedger,
  OneShotGrantGuard,
} from '@hyper/runtime';

const now = '2026-01-15T12:00:00.000Z';

function fixture(overrides: Partial<ActionProposal<MemoryWriteArgs>> = {}) {
  const intent: IntentContract = {
    id: 'intent:test',
    version: CONTRACT_VERSION,
    objective: 'Write a value inside the workspace.',
    principals: ['agent:test'],
    authorizedResources: ['workspace/**'],
    prohibitedEffects: ['state.delete', 'network.request', 'process.execute'],
    requiredConditionIds: ['condition:current'],
    requiredEvidence: ['observed_state'],
    riskBudget: 3,
    approvalAboveRisk: 3,
    completionCriteria: ['Observed value matches requested value.'],
  };
  const conditions: Condition[] = [{
    id: 'condition:current',
    statement: 'State is current.',
    status: 'active',
    evidenceRefs: ['evidence:setup'],
    source: 'test',
    observedAt: '2026-01-15T11:59:00.000Z',
    expiresAt: '2026-01-15T12:05:00.000Z',
  }];
  const proposal: ActionProposal<MemoryWriteArgs> = {
    id: 'proposal:test',
    intentId: intent.id,
    principalId: 'agent:test',
    conditionIds: ['condition:current'],
    capabilityId: 'memory.workspace.write',
    target: 'workspace/result.txt',
    declaredEffects: ['state.write'],
    risk: 1,
    expectedEvidence: ['observed_state'],
    idempotencyKey: 'idempotency:test',
    args: { value: 'done', behavior: 'apply' },
    ...overrides,
  };
  return { intent, conditions, proposal };
}

describe('deterministic authority boundary', () => {
  test('denies a reachable capability when the target is outside intent scope', () => {
    const capability = new InMemoryWorkspaceCapability();
    const input = fixture({ target: 'private/secret.txt' });
    const decision = new DeterministicPolicyEngine().decide({
      now,
      ...input,
      manifest: capability.manifest,
    });

    expect(decision.disposition).toBe('deny');
    expect(decision.reasonCodes).toContain('TARGET_OUTSIDE_SCOPE');
  });

  test('does not let a recursive resource pattern match its bare container', () => {
    const capability = new InMemoryWorkspaceCapability();
    const input = fixture({ target: 'workspace' });
    input.intent.authorizedResources = ['workspace'];
    const decision = new DeterministicPolicyEngine().decide({
      now,
      ...input,
      manifest: capability.manifest,
    });

    expect(decision.disposition).toBe('deny');
    expect(decision.reasonCodes).toContain('TARGET_UNSUPPORTED_BY_CAPABILITY');
  });

  test('requires active, evidenced, unexpired conditions', () => {
    const capability = new InMemoryWorkspaceCapability();
    const input = fixture();
    input.conditions[0]!.status = 'superseded';
    const decision = new DeterministicPolicyEngine().decide({
      now,
      ...input,
      manifest: capability.manifest,
    });

    expect(decision.disposition).toBe('deny');
    expect(decision.reasonCodes).toContain('CONDITION_NOT_ACTIVE:condition:current:superseded');
  });

  test('enforces an explicit intent capability allowlist', () => {
    const capability = new InMemoryWorkspaceCapability();
    const input = fixture();
    input.intent.authorizedCapabilities = ['workspace.file.read'];
    const decision = new DeterministicPolicyEngine().decide({
      now,
      ...input,
      manifest: capability.manifest,
    });

    expect(decision.disposition).toBe('deny');
    expect(decision.reasonCodes).toContain('CAPABILITY_OUTSIDE_INTENT');
  });

  test('does not let a proposal manufacture evidence outside the intent contract', () => {
    const capability = new InMemoryWorkspaceCapability();
    const input = fixture({ expectedEvidence: ['confident_model_claim'] });
    const decision = new DeterministicPolicyEngine().decide({
      now,
      ...input,
      manifest: capability.manifest,
    });

    expect(decision.disposition).toBe('deny');
    expect(decision.reasonCodes).toContain('EVIDENCE_OUTSIDE_INTENT:confident_model_claim');
  });

  test('detects a false-success tool result through observed state', async () => {
    const capability = new InMemoryWorkspaceCapability();
    const runtime = new AuthorizedRuntime();
    const input = fixture({
      args: { value: 'done', behavior: 'false_success' },
    });
    const outcome = await runtime.execute({
      runId: 'run:false-success',
      now,
      ...input,
      capability,
    });

    expect(outcome.status).toBe('verification_failed');
    expect(outcome.claimedSuccess).toBeFalse();
    expect(outcome.verification?.reasonCodes).toContain('OBSERVED_STATE_MISMATCH');
    expect(runtime.ledger.verifyIntegrity()).toEqual({ valid: true });
  });

  test('consumes a proposal-scoped grant exactly once', async () => {
    const capability = new InMemoryWorkspaceCapability();
    const runtime = new AuthorizedRuntime();
    const input = fixture();
    const first = await runtime.execute({
      runId: 'run:one-shot',
      now,
      ...input,
      capability,
    });
    const repeated = await runtime.execute({
      runId: 'run:one-shot',
      now,
      ...input,
      capability,
    });

    expect(first.status).toBe('completed');
    expect(repeated.status).toBe('denied');
    expect(repeated.decision.reasonCodes).toContain('GRANT_ALREADY_CONSUMED');
    expect(
      runtime.ledger.all().some(event => event.type === 'capability.grant_rejected'),
    ).toBe(true);
  });

  test('rejects an expired grant before it reaches a capability', () => {
    const guard = new OneShotGrantGuard();
    const expired = guard.claim(
      {
        id: 'grant:expired',
        expiresAt: '2026-01-15T11:59:59.000Z',
      },
      now,
    );
    expect(expired).toEqual({
      accepted: false,
      reasonCodes: ['GRANT_EXPIRED'],
    });
  });

  test('turns thrown capability execution into a failed receipt', async () => {
    const base = new InMemoryWorkspaceCapability();
    const input = fixture();
    const runtime = new AuthorizedRuntime();
    const capability: CapabilityAdapter<MemoryWriteArgs> = {
      manifest: base.manifest,
      async execute() { throw new Error('adapter crashed'); },
      observe: proposal => base.observe(proposal),
      verify: (proposal, execution, observation) =>
        base.verify(proposal, execution, observation),
    };
    const outcome = await runtime.execute({
      runId: 'run:execute-throws',
      now,
      ...input,
      capability,
    });

    expect(outcome.status).toBe('execution_failed');
    expect(outcome.execution?.errorCode).toBe('CAPABILITY_EXECUTION_THROWN');
    expect(runtime.ledger.all().at(-1)?.type).toBe('action.receipt');
    expect(runtime.ledger.verifyIntegrity()).toEqual({ valid: true });
  });

  test('turns thrown observation and verification into failed receipts', async () => {
    const observationBase = new InMemoryWorkspaceCapability();
    const observationRuntime = new AuthorizedRuntime();
    const observationCapability: CapabilityAdapter<MemoryWriteArgs> = {
      manifest: observationBase.manifest,
      execute: (proposal, grant) => observationBase.execute(proposal, grant),
      async observe() { throw new Error('observer crashed'); },
      verify: (proposal, execution, observation) =>
        observationBase.verify(proposal, execution, observation),
    };
    const observationOutcome = await observationRuntime.execute({
      runId: 'run:observe-throws',
      now,
      ...fixture({ id: 'proposal:observe-throws' }),
      capability: observationCapability,
    });
    expect(observationOutcome.status).toBe('verification_failed');
    expect(observationOutcome.verification?.reasonCodes).toContain('CAPABILITY_OBSERVATION_THROWN');
    expect(observationRuntime.ledger.all().at(-1)?.type).toBe('action.receipt');

    const verificationBase = new InMemoryWorkspaceCapability();
    const verificationRuntime = new AuthorizedRuntime();
    const verificationCapability: CapabilityAdapter<MemoryWriteArgs> = {
      manifest: verificationBase.manifest,
      execute: (proposal, grant) => verificationBase.execute(proposal, grant),
      observe: proposal => verificationBase.observe(proposal),
      async verify() { throw new Error('verifier crashed'); },
    };
    const verificationOutcome = await verificationRuntime.execute({
      runId: 'run:verify-throws',
      now,
      ...fixture({ id: 'proposal:verify-throws' }),
      capability: verificationCapability,
    });
    expect(verificationOutcome.status).toBe('verification_failed');
    expect(verificationOutcome.verification?.reasonCodes).toContain('CAPABILITY_VERIFICATION_THROWN');
    expect(verificationRuntime.ledger.all().at(-1)?.type).toBe('action.receipt');
  });
});

describe('hash-chained ledger', () => {
  test('detects mutation of a committed payload', () => {
    const ledger = new HashChainLedger();
    ledger.append('run:ledger', 'one', { value: 1 });
    ledger.append('run:ledger', 'two', { value: 2 });
    expect(ledger.verifyIntegrity()).toEqual({ valid: true });

    const internal = ledger as unknown as { events: Array<{ payload: Record<string, unknown> }> };
    internal.events[0]!.payload.value = 99;
    expect(ledger.verifyIntegrity()).toEqual({ valid: false, brokenAt: 0 });
  });

  test('commits a clone instead of retaining a caller-owned payload', () => {
    const ledger = new HashChainLedger();
    const payload = { nested: { value: 1 } };
    ledger.append('run:immutable-input', 'test.event', payload);
    payload.nested.value = 99;

    expect(ledger.all()[0]?.payload).toEqual({ nested: { value: 1 } });
    expect(ledger.verifyIntegrity()).toEqual({ valid: true });
  });

  test('does not advance memory when durable append fails', () => {
    const ledger = new HashChainLedger({
      load: () => [],
      append: () => { throw new Error('disk full'); },
    });
    expect(() => ledger.append('run:io-failure', 'test.event', {})).toThrow('disk full');
    expect(ledger.all()).toHaveLength(0);
  });
});
