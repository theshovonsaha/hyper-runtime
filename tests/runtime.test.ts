import { describe, expect, test } from 'bun:test';
import { CONTRACT_VERSION, type ActionProposal, type Condition, type IntentContract } from '@hyper/contracts';
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
});
