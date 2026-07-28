import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayLedger, runTask, type HyperTaskFile } from '@hyper/cli';
import type { WorkflowProposal } from '@hyper/contracts';

const roots: string[] = [];
const now = '2026-07-24T12:00:00.000Z';

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hyper-cli-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('practical CLI workflow', () => {
  test('runs a versioned task file, writes a real file, and persists replay', async () => {
    const root = temporaryRoot();
    const taskPath = join(root, 'task.json');
    const proposalsPath = join(root, 'proposals.json');
    const ledgerPath = join(root, 'run.jsonl');
    const task: HyperTaskFile = {
      version: '0.2.0',
      runId: 'run:cli-practical',
      intentId: 'intent:cli-practical',
      objective: 'Write and observe a verified result file.',
      principalId: 'agent:cli',
      authorizedCapabilities: ['workspace.file.read', 'workspace.file.write'],
      authorizedResources: ['workspace/**'],
      prohibitedEffects: ['state.delete', 'network.request', 'process.execute'],
      requiredEvidence: ['result_file_observed'],
      completionCriteria: ['workspace/result.txt contains practical runtime'],
      riskBudget: 2,
      approvalAboveRisk: 3,
      constraints: ['Only modify workspace/result.txt.'],
      conditions: [{
        id: 'condition:workspace-current',
        statement: 'The temporary workspace is current.',
        status: 'active',
        evidenceRefs: ['test:workspace'],
        source: 'cli-test',
        observedAt: now,
        expiresAt: '2026-07-24T12:10:00.000Z',
      }],
      sources: [{
        id: 'goal:cli',
        title: 'CLI task directive',
        content: 'Create the requested result and verify it.',
        kind: 'goal',
        authority: 'directive',
        validity: 'active',
        provenance: ['task.json'],
        tags: ['result'],
        createdAt: now,
        priority: 100,
      }],
      initialStrategyId: 'strategy:write',
      focusTags: ['result'],
      maxSteps: 4,
    };
    const proposals: WorkflowProposal[] = [
      {
        kind: 'action',
        strategyId: 'strategy:write',
        hypothesis: 'An atomic bounded write will establish the requested file.',
        expectedObservation: 'workspace/result.txt contains practical runtime',
        action: {
          id: 'proposal:cli-write',
          intentId: task.intentId,
          principalId: task.principalId,
          conditionIds: ['condition:workspace-current'],
          capabilityId: 'workspace.file.write',
          target: 'workspace/result.txt',
          declaredEffects: ['state.write'],
          risk: 1,
          expectedEvidence: ['result_file_observed'],
          idempotencyKey: 'cli-write:one',
          args: { content: 'practical runtime' },
        },
      },
      {
        kind: 'complete',
        strategyId: 'strategy:write',
        evidenceRefs: ['result_file_observed'],
      },
    ];
    writeFileSync(taskPath, JSON.stringify(task));
    writeFileSync(proposalsPath, JSON.stringify(proposals));

    const result = await runTask({
      taskPath,
      workspace: root,
      ledgerPath,
      provider: 'scripted',
      proposalsPath,
      now: () => now,
    });

    expect(result.status).toBe('completed');
    expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('practical runtime');
    expect(replayLedger(ledgerPath)).toMatchObject({
      valid: true,
      runIds: ['run:cli-practical'],
    });
  });
});
