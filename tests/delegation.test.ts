import { describe, expect, test } from 'bun:test';
import { InMemoryWorkspaceCapability, type MemoryWriteArgs } from '@hyper/capability-memory';
import {
  CONTRACT_VERSION,
  type ActionProposal,
  type Condition,
  type ContextSource,
  type DelegationContract,
  type DelegationResult,
  type IntentContract,
  type WorkflowProposal,
} from '@hyper/contracts';
import {
  DelegationController,
  DelegationPolicy,
  validateDelegationResult,
} from '@hyper/delegation';
import { ScriptedModelDriver } from '@hyper/model';
import { HashChainLedger } from '@hyper/runtime';
import {
  CapabilityRegistry,
  WorkflowChildRuntimeExecutor,
  WorkflowRunner,
} from '@hyper/workflow';

const now = '2026-07-24T12:00:00.000Z';

function parentIntent(overrides: Partial<IntentContract> = {}): IntentContract {
  return {
    id: 'intent:parent',
    version: CONTRACT_VERSION,
    objective: 'Build a verified competitor monitor.',
    principals: ['agent:parent'],
    authorizedCapabilities: ['network.http.get', 'workspace.file.read'],
    authorizedResources: ['public-web/**', 'workspace/**'],
    prohibitedEffects: ['state.write', 'state.delete', 'process.execute'],
    requiredConditionIds: [],
    requiredEvidence: ['verified_monitor'],
    riskBudget: 3,
    approvalAboveRisk: 3,
    completionCriteria: ['Monitor artifact is verified.'],
    ...overrides,
  };
}

function childIntent(overrides: Partial<IntentContract> = {}): IntentContract {
  return {
    id: 'intent:child-research',
    version: CONTRACT_VERSION,
    objective: 'Find verified primary competitor sources.',
    principals: ['agent:research-child'],
    authorizedCapabilities: ['network.http.get'],
    authorizedResources: ['public-web/competitors/**'],
    prohibitedEffects: ['state.write', 'state.delete', 'process.execute'],
    requiredConditionIds: [],
    requiredEvidence: ['primary_sources'],
    riskBudget: 2,
    approvalAboveRisk: 2,
    completionCriteria: ['At least one primary source is verified.'],
    ...overrides,
  };
}

function contract(overrides: Partial<DelegationContract> = {}): DelegationContract {
  return {
    id: 'delegation:research',
    version: CONTRACT_VERSION,
    parentRunId: 'run:parent',
    childRunId: 'run:child',
    childIntent: childIntent(),
    contextRefs: ['context:market-definition'],
    budget: {
      tokenBudget: 2_000,
      actionBudget: 5,
      wallTimeMs: 5_000,
    },
    expectedOutputSchema: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['competitor', 'source', 'evidence'],
        additionalProperties: false,
        properties: {
          competitor: { type: 'string' },
          source: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    verification: {
      minimumEvidence: 1,
      requireVerifiedCompletion: true,
    },
    ...overrides,
  };
}

function contexts(): ContextSource[] {
  return [
    {
      id: 'context:market-definition',
      title: 'Market definition',
      content: 'Monitor public pricing pages for direct competitors.',
      kind: 'decision',
      authority: 'constraint',
      validity: 'active',
      provenance: ['event:market-definition'],
      tags: ['research'],
      createdAt: now,
      priority: 100,
      semanticTag: 'constraint',
      confidence: 1,
      rebuildable: true,
    },
    {
      id: 'context:private-email',
      title: 'Private unrelated email',
      content: 'This must never enter the research child context.',
      kind: 'conversation',
      authority: 'data',
      validity: 'active',
      provenance: ['event:private-email'],
      tags: ['private'],
      createdAt: now,
      priority: 20,
      semanticTag: 'evidence',
      confidence: 1,
      rebuildable: true,
    },
  ];
}

function successfulResult(overrides: Partial<DelegationResult> = {}): DelegationResult {
  return {
    delegationId: 'delegation:research',
    childRunId: 'run:child',
    status: 'completed',
    output: [{
      competitor: 'Example',
      source: 'https://example.com/pricing',
      evidence: 'Published pricing page.',
    }],
    evidenceRefs: ['observation:pricing'],
    policyViolations: [],
    verificationPassed: true,
    budgetUsage: {
      inputTokens: 200,
      outputTokens: 100,
      actions: 2,
      wallTimeMs: 50,
    },
    childReceiptHash: 'a'.repeat(64),
    ...overrides,
  };
}

describe('delegation policy and result boundary', () => {
  test('gives a child only selected context and accepts a verified typed result', async () => {
    const ledger = new HashChainLedger();
    let receivedContext: ContextSource[] = [];
    const receipt = await new DelegationController().execute({
      parentIntent: parentIntent(),
      contract: contract(),
      parentContext: contexts(),
      remainingBudget: {
        tokenBudget: 10_000,
        actionBudget: 20,
        wallTimeMs: 30_000,
      },
      events: ledger,
      executor: {
        async run(request) {
          receivedContext = request.context;
          return successfulResult();
        },
      },
    });

    expect(receipt.authorized).toBeTrue();
    expect(receipt.accepted).toBeTrue();
    expect(receivedContext.map(source => source.id)).toEqual(['context:market-definition']);
    expect(ledger.all().map(event => event.type)).toEqual([
      'delegation.proposed',
      'delegation.decided',
      'delegation.authorized',
      'child_run.started',
      'child_result.received',
      'child_evidence.validated',
      'delegation.receipt',
    ]);
    expect(ledger.verifyIntegrity()).toEqual({ valid: true });
  });

  test('denies authority, resource, prohibition, and budget expansion before child execution', async () => {
    let executed = false;
    const expandedChild = childIntent({
      authorizedCapabilities: ['network.http.get', 'email.send'],
      authorizedResources: ['private/**'],
      prohibitedEffects: ['state.delete'],
      riskBudget: 4,
      approvalAboveRisk: 4,
    });
    const expanded = contract({
      childIntent: expandedChild,
      budget: {
        tokenBudget: 50_000,
        actionBudget: 50,
        wallTimeMs: 60_000,
      },
    });
    const receipt = await new DelegationController().execute({
      parentIntent: parentIntent(),
      contract: expanded,
      parentContext: contexts(),
      remainingBudget: {
        tokenBudget: 10_000,
        actionBudget: 20,
        wallTimeMs: 30_000,
      },
      executor: {
        async run() {
          executed = true;
          return successfulResult();
        },
      },
    });

    expect(receipt.authorized).toBeFalse();
    expect(executed).toBeFalse();
    expect(receipt.reasonCodes).toContain('CAPABILITY_AUTHORITY_EXPANDED:email.send');
    expect(receipt.reasonCodes).toContain('RESOURCE_AUTHORITY_EXPANDED:private/**');
    expect(receipt.reasonCodes).toContain('PARENT_PROHIBITION_REMOVED:state.write');
    expect(receipt.reasonCodes).toContain('TOKEN_BUDGET_EXCEEDS_PARENT');
  });

  test('does not incorporate malformed, policy-violating, or over-budget child output', () => {
    const reasons = validateDelegationResult(contract(), successfulResult({
      output: [{ competitor: 'Example' }],
      evidenceRefs: [],
      policyViolations: ['DENIED_ACTION_ATTEMPT:TARGET_OUTSIDE_SCOPE'],
      budgetUsage: {
        inputTokens: 2_000,
        outputTokens: 500,
        actions: 7,
        wallTimeMs: 8_000,
      },
    }));

    expect(reasons).toContain('CHILD_TOKEN_BUDGET_EXCEEDED');
    expect(reasons).toContain('CHILD_ACTION_BUDGET_EXCEEDED');
    expect(reasons).toContain('CHILD_TIME_BUDGET_EXCEEDED');
    expect(reasons).toContain('CHILD_POLICY_VIOLATION');
    expect(reasons).toContain('CHILD_EVIDENCE_INSUFFICIENT');
    expect(reasons.some(reason => reason.includes('CHILD_OUTPUT_SCHEMA'))).toBeTrue();
  });

  test('requires parent capability authority to be explicit', () => {
    const parent = parentIntent();
    delete parent.authorizedCapabilities;
    const decision = new DelegationPolicy().decide({
      parentIntent: parent,
      contract: contract(),
      availableContextIds: ['context:market-definition'],
      remainingBudget: {
        tokenBudget: 10_000,
        actionBudget: 20,
        wallTimeMs: 30_000,
      },
    });
    expect(decision.disposition).toBe('deny');
    expect(decision.reasonCodes).toContain('PARENT_CAPABILITIES_UNDECLARED');
  });

  test('derives context authority from the actual parent context view', async () => {
    let executed = false;
    const receipt = await new DelegationController().execute({
      parentIntent: parentIntent(),
      contract: contract({ contextRefs: ['context:not-in-parent-view'] }),
      parentContext: contexts(),
      remainingBudget: {
        tokenBudget: 10_000,
        actionBudget: 20,
        wallTimeMs: 30_000,
      },
      executor: {
        async run() {
          executed = true;
          return successfulResult();
        },
      },
    });

    expect(receipt.authorized).toBeFalse();
    expect(executed).toBeFalse();
    expect(receipt.reasonCodes).toContain(
      'CONTEXT_REFERENCE_UNAVAILABLE:context:not-in-parent-view',
    );
  });
});

describe('child workflow adapter', () => {
  test('runs the ordinary verified workflow as an independently replayable child runtime', async () => {
    const memory = new InMemoryWorkspaceCapability();
    const parent = parentIntent({
      authorizedCapabilities: ['memory.workspace.write'],
      authorizedResources: ['workspace/**'],
      prohibitedEffects: ['state.delete', 'network.request', 'process.execute'],
    });
    const child = childIntent({
      id: 'intent:child-write',
      objective: 'Write and verify a delegated artifact.',
      authorizedCapabilities: ['memory.workspace.write'],
      authorizedResources: ['workspace/delegated/**'],
      prohibitedEffects: ['state.delete', 'network.request', 'process.execute'],
      requiredConditionIds: ['condition:child-current'],
      requiredEvidence: ['delegated_artifact_observed'],
      completionCriteria: ['Delegated artifact value is observed.'],
    });
    const delegation = contract({
      id: 'delegation:write',
      childRunId: 'run:child-write',
      childIntent: child,
      expectedOutputSchema: {
        type: 'object',
        required: ['artifact', 'status'],
        additionalProperties: false,
        properties: {
          artifact: { type: 'string' },
          status: { type: 'string', enum: ['completed'] },
        },
      },
    });
    const actionProposal: ActionProposal<MemoryWriteArgs> = {
      id: 'proposal:child-write',
      intentId: child.id,
      principalId: child.principals[0]!,
      conditionIds: ['condition:child-current'],
      capabilityId: 'memory.workspace.write',
      target: 'workspace/delegated/result.txt',
      declaredEffects: ['state.write'],
      risk: 1,
      expectedEvidence: ['delegated_artifact_observed'],
      idempotencyKey: 'child-write:one',
      args: { value: 'verified child artifact', behavior: 'apply' },
    };
    const proposals: WorkflowProposal[] = [
      {
        kind: 'action',
        strategyId: 'strategy:child-write',
        hypothesis: 'The bounded write should establish the delegated artifact.',
        expectedObservation: 'The delegated target contains the requested value.',
        action: actionProposal,
      },
      {
        kind: 'complete',
        strategyId: 'strategy:child-write',
        evidenceRefs: ['delegated_artifact_observed'],
      },
    ];
    const childLedger = new HashChainLedger();
    const childExecutor = new WorkflowChildRuntimeExecutor(async () => ({
      runner: new WorkflowRunner({
        model: new ScriptedModelDriver(proposals),
        capabilities: new CapabilityRegistry().register(memory),
        ledger: childLedger,
        now: () => now,
      }),
      conditions: [{
        id: 'condition:child-current',
        statement: 'Delegated workspace state is current.',
        status: 'active',
        evidenceRefs: ['fixture:child-state'],
        source: 'test',
        observedAt: now,
        expiresAt: '2026-07-24T12:10:00.000Z',
      }] satisfies Condition[],
      constraints: ['Only write inside workspace/delegated/**.'],
      initialStrategyId: 'strategy:child-write',
      output: result => ({
        artifact: 'workspace/delegated/result.txt',
        status: result.status,
      }),
    }));
    const parentLedger = new HashChainLedger();
    const receipt = await new DelegationController().execute({
      parentIntent: parent,
      contract: delegation,
      parentContext: contexts(),
      remainingBudget: {
        tokenBudget: 10_000,
        actionBudget: 20,
        wallTimeMs: 30_000,
      },
      executor: childExecutor,
      events: parentLedger,
    });

    expect(receipt.authorized).toBeTrue();
    expect(receipt.accepted).toBeTrue();
    expect(memory.inspect('workspace/delegated/result.txt')).toBe('verified child artifact');
    expect(childLedger.verifyIntegrity()).toEqual({ valid: true });
    expect(parentLedger.verifyIntegrity()).toEqual({ valid: true });
    expect(receipt.result?.childReceiptHash).toBe(childLedger.latestHash());
  });
});
