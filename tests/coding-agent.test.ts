import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BoundedProcessCapability,
  PatchFileCapability,
  ReadFileCapability,
  RepositorySearchCapability,
} from '@hyper/capabilities';
import {
  CONTRACT_VERSION,
  type ActionProposal,
  type AgentMessage,
  type ContextPacket,
  type ContextSource,
  type Effect,
  type ModelProposalResult,
  type WorkflowProposal,
} from '@hyper/contracts';
import type { ModelDriver, ModelProposalScope } from '@hyper/model';
import { CapabilityRegistry, WorkflowRunner, type WorkflowDefinition } from '@hyper/workflow';

const roots: string[] = [];
const fixedNow = '2026-08-24T18:00:00.000Z';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'hyper-coding-agent-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a - b; // BUG_ADD\n');
  writeFileSync(join(root, 'math.test.ts'), [
    "import { add } from './src/math';",
    "const actual = add(2, 3);",
    "if (actual !== 5) { process.stderr.write('DIAGNOSTIC_ADD_EXPECTED_5\\n'); process.exit(1); }",
    "process.stdout.write('VERIFIED_ADD_RESULT_5\\n');",
    '',
  ].join('\n'));
  return root;
}

function toolResult(messages: AgentMessage[], capability: string): Record<string, unknown> | undefined {
  for (const message of [...messages].reverse()) {
    for (const block of message.content) {
      if (block.type !== 'tool_result' || block.name !== capability) continue;
      return JSON.parse(block.content) as Record<string, unknown>;
    }
  }
  return undefined;
}

function action(
  scope: ModelProposalScope,
  index: number,
  capabilityId: string,
  target: string,
  declaredEffects: Effect[],
  args: Record<string, unknown>,
): Extract<WorkflowProposal, { kind: 'action' }> {
  const proposal: ActionProposal = {
    id: `proposal:coding:${index}`,
    intentId: scope.intentId,
    principalId: scope.principalId,
    conditionIds: scope.requiredConditionIds,
    capabilityId,
    target,
    declaredEffects,
    risk: declaredEffects.includes('state.write') || declaredEffects.includes('process.execute') ? 3 : 1,
    expectedEvidence: scope.requiredEvidence,
    idempotencyKey: `coding:${index}`,
    args,
  };
  return {
    kind: 'action',
    strategyId: scope.activeStrategyId,
    hypothesis: `${capabilityId} is the next bounded step in the inspect-edit-test loop.`,
    expectedObservation: `${target} returns independently observed state.`,
    action: proposal,
  };
}

function withToolMessage(
  proposal: Extract<WorkflowProposal, { kind: 'action' }>,
  index: number,
): Omit<ModelProposalResult, 'usage' | 'model'> {
  const callId = `call:coding:${index}`;
  return {
    proposal,
    proposalToolCallId: callId,
    proposalToolName: proposal.action.capabilityId,
    assistantMessage: {
      id: `message:coding:assistant:${index}`,
      role: 'assistant',
      content: [{
        type: 'tool_call',
        callId,
        name: proposal.action.capabilityId,
        arguments: { target: proposal.action.target, ...proposal.action.args },
      }],
      createdAt: fixedNow,
    },
  };
}

class CodingLoopModel implements ModelDriver {
  calls = 0;
  sawFailedTestResult = false;
  readonly phases: ContextPacket['phase'][] = [];

  async propose(
    packet: ContextPacket,
    capabilities: Parameters<ModelDriver['propose']>[1],
    scope: ModelProposalScope,
  ): Promise<ModelProposalResult> {
    this.calls += 1;
    this.phases.push(packet.phase);
    const visible = new Set(capabilities.map(capability => capability.id));
    expect(visible).toEqual(new Set([
      'workspace.repository.search', 'workspace.file.read', 'workspace.file.patch', 'workspace.process.run',
    ]));
    let proposal: Extract<WorkflowProposal, { kind: 'action' }>;
    if (this.calls === 1) {
      proposal = action(scope, this.calls, 'workspace.repository.search', 'workspace/', ['state.read'], {
        query: 'BUG_ADD', fileExtensions: ['.ts'], maxResults: 20,
      });
    } else if (this.calls === 2) {
      const search = toolResult(scope.agentMessages ?? [], 'workspace.repository.search');
      const observation = search?.observation as { matches?: Array<{ path: string; snapshotSha256: string }> } | undefined;
      expect(observation?.matches?.[0]?.path).toBe('workspace/src/math.ts');
      expect(typeof observation?.matches?.[0]?.snapshotSha256).toBe('string');
      proposal = action(scope, this.calls, 'workspace.file.read', 'workspace/src/math.ts', ['state.read'], {
        expectedSha256: observation!.matches![0]!.snapshotSha256,
        startLine: 1,
        endLine: 1,
      });
    } else if (this.calls === 3) {
      const read = toolResult(scope.agentMessages ?? [], 'workspace.file.read');
      const observation = read?.observation as { snapshotSha256?: string; text?: string } | undefined;
      expect(observation?.text).toContain('a - b');
      proposal = action(scope, this.calls, 'workspace.file.patch', 'workspace/src/math.ts', ['state.write'], {
        expectedPreviousSha256: observation!.snapshotSha256,
        replacements: [{ oldText: 'a - b', newText: 'a * b' }],
      });
    } else if (this.calls === 4) {
      proposal = action(scope, this.calls, 'workspace.process.run', 'workspace/', ['process.execute', 'state.read'], {
        executable: process.execPath,
        arguments: ['math.test.ts'],
        timeoutMs: 10_000,
        expectedExitCode: 0,
      });
    } else if (this.calls === 5) {
      const processResult = toolResult(scope.agentMessages ?? [], 'workspace.process.run');
      const processObservation = processResult?.observation as {
        exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean;
      } | undefined;
      this.sawFailedTestResult = processResult?.status === 'failed'
        && processObservation?.exitCode === 1
        && processObservation.timedOut === false;
      if (!this.sawFailedTestResult) throw new Error('The failed test diagnostic was not connected to the next model pass.');
      const patchResult = toolResult(scope.agentMessages ?? [], 'workspace.file.patch');
      const patchObservation = patchResult?.observation as { newSha256?: string } | undefined;
      const replacement = processObservation!.exitCode === 1
        ? { oldText: 'a * b', newText: 'a + b' }
        : undefined;
      proposal = action(scope, this.calls, 'workspace.file.patch', 'workspace/src/math.ts', ['state.write'], {
        expectedPreviousSha256: patchObservation!.newSha256,
        replacements: [replacement!],
      });
    } else if (this.calls === 6) {
      proposal = action(scope, this.calls, 'workspace.process.run', 'workspace/', ['process.execute', 'state.read'], {
        executable: process.execPath,
        arguments: ['math.test.ts'],
        timeoutMs: 10_000,
        expectedExitCode: 0,
      });
    } else {
      return {
        proposal: { kind: 'complete', strategyId: scope.activeStrategyId, evidenceRefs: scope.completionEvidenceRefs ?? [] },
        assistantMessage: {
          id: 'message:coding:assistant:complete',
          role: 'assistant',
          content: [{ type: 'text', text: 'Fixed the addition implementation and verified it with the focused Bun test.' }],
          createdAt: fixedNow,
        },
        model: 'simulation:coding-loop',
        usage: { inputTokens: 120, outputTokens: 20, latencyMs: 10 },
      };
    }
    return {
      ...withToolMessage(proposal, this.calls),
      model: 'simulation:coding-loop',
      usage: { inputTokens: 100, outputTokens: 30, latencyMs: 10 },
    };
  }
}

describe('coding-agent vertical slice', () => {
  test('searches, reads, patches, diagnoses a real failed test, repairs, and verifies completion', async () => {
    const root = workspace();
    const model = new CodingLoopModel();
    const runner = new WorkflowRunner({
      model,
      capabilities: new CapabilityRegistry()
        .register(new RepositorySearchCapability(root))
        .register(new ReadFileCapability(root))
        .register(new PatchFileCapability(root))
        .register(new BoundedProcessCapability(root, {
          allowedExecutables: [process.execPath],
          environment: { PATH: process.env.PATH ?? '' },
        })),
      now: () => fixedNow,
    });
    const source: ContextSource = {
      id: 'goal:coding-loop', title: 'Coding task',
      content: 'Fix BUG_ADD and run its focused test.', kind: 'goal', authority: 'directive', validity: 'active',
      provenance: ['fixture:coding-loop'], tags: ['coding'], createdAt: fixedNow, priority: 100,
      semanticTag: 'intent', confidence: 1, rebuildable: true,
    };
    const definition: WorkflowDefinition = {
      runId: 'run:coding-loop',
      intent: {
        id: 'intent:coding-loop', version: CONTRACT_VERSION,
        objective: 'Fix BUG_ADD and run its focused test.', principals: ['agent:coding'],
        authorizedCapabilities: ['workspace.repository.search', 'workspace.file.read', 'workspace.file.patch', 'workspace.process.run'],
        authorizedResources: ['workspace/**'], prohibitedEffects: ['state.delete', 'network.request'],
        requiredConditionIds: ['condition:workspace-current'],
        requiredEvidence: ['capability:workspace.file.patch', 'effect:process.execute'],
        riskBudget: 4, approvalAboveRisk: 4,
        completionCriteria: ['The implementation is patched and the focused test exits successfully.'],
      },
      conditions: [{
        id: 'condition:workspace-current', statement: 'The temporary repository is current.', status: 'active',
        evidenceRefs: ['fixture:workspace'], source: 'test', observedAt: fixedNow, expiresAt: '2026-08-24T19:00:00.000Z',
      }],
      constraints: ['Inspect before patching.', 'A passing test is required before completion.'],
      sources: [source], initialStrategyId: 'strategy:direct', tokenBudget: 2_000, maxSteps: 10,
      proposalCapabilityIds: ['workspace.repository.search', 'workspace.file.read', 'workspace.file.patch', 'workspace.process.run'],
    };
    let result;
    try {
      result = await runner.run(definition);
    } catch (error) {
      throw new Error(`Coding loop failed after ${model.calls} model call(s): ${error instanceof Error ? error.message : String(error)}`);
    }

    const modelFailures = runner.ledger.forRun(result.runId)
      .filter(event => event.type === 'model.proposal_failed').map(event => event.payload.reason);
    expect({ status: result.status, reasonCodes: result.reasonCodes, calls: model.calls, modelFailures })
      .toEqual({ status: 'completed', reasonCodes: ['COMPLETION_ORACLE_PASSED'], calls: 7, modelFailures: [] });
    expect(model.calls).toBe(7);
    expect(model.sawFailedTestResult).toBeTrue();
    expect(model.phases).toContain('diagnose');
    expect(readFileSync(join(root, 'src', 'math.ts'), 'utf8')).toContain('a + b');
    const events = runner.ledger.forRun(result.runId);
    expect(events.filter(event => event.type === 'action.verified').map(event => event.payload.passed))
      .toEqual([true, true, true, true, true]);
    expect(events.filter(event => event.type === 'state.observed').map(event => event.payload.observationPurpose ?? 'verification'))
      .toEqual(['verification', 'verification', 'verification', 'failure_diagnostic', 'verification', 'verification']);
    expect(events.filter(event => event.type === 'action.executed').map(event => event.payload.success))
      .toEqual([true, true, true, false, true, true]);
    expect(events.filter(event => event.type === 'model.tool_result_message')).toHaveLength(6);
    expect(events.at(-1)).toMatchObject({ type: 'workflow.receipt', payload: { status: 'completed' } });
    expect(runner.ledger.verifyIntegrity()).toEqual({ valid: true });
  });
});
