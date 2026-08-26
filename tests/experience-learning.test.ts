import { describe, expect, test } from 'bun:test';
import { CONTRACT_VERSION, type ContextSource, type LedgerEvent } from '@hyper/contracts';
import {
  assessShadowSelectorPromotion,
  DynamicContextCompiler,
  LinearShadowContextSelector,
  type ShadowContextSelector,
} from '@hyper/context';
import {
  projectExperienceDataset,
  projectExperienceTrajectory,
  runPairedLiveExperiment,
} from '@hyper/evals';
import type { ModelDriver } from '@hyper/model';

function event(sequence: number, type: string, payload: Record<string, unknown>): LedgerEvent {
  return {
    version: CONTRACT_VERSION, runId: 'run:experience', sequence, type, payload,
    previousHash: `hash:${sequence - 1}`, hash: `hash:${sequence}`,
  };
}

describe('experience projection and shadow learning boundary', () => {
  test('rebuilds an evidence-only trajectory from canonical events without hidden reasoning', () => {
    const trajectory = projectExperienceTrajectory([
      event(0, 'workflow.started', { objective: 'Write and verify the report.' }),
      event(1, 'context.compiled', { packetId: 'packet:1', phase: 'act', includedSourceIds: ['goal:1', 'constraint:1'] }),
      event(2, 'model.proposed', {
        step: 1, packetId: 'packet:1',
        proposal: {
          kind: 'action', strategyId: 'strategy:1', hypothesis: 'The write establishes state.',
          expectedObservation: 'The report exists.',
          action: { id: 'proposal:1', capabilityId: 'workspace.file.write', target: 'workspace/report.md', declaredEffects: ['state.write'] },
        },
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 5, latencyMs: 50 },
      }),
      event(3, 'policy.decided', { proposalId: 'proposal:1', disposition: 'allow', reasonCodes: ['AUTHORIZED_WITHIN_CONTRACT'] }),
      event(4, 'action.executed', { proposalId: 'proposal:1', success: true }),
      event(5, 'state.observed', { proposalId: 'proposal:1', evidenceRefs: ['observation:1'] }),
      event(6, 'action.verified', { proposalId: 'proposal:1', passed: true, reasonCodes: ['FILE_WRITE_OBSERVED'] }),
      event(7, 'workflow.progress_assessed', {
        causal: { actionProposalId: 'proposal:1', actionStatus: 'completed' },
        progress: { recovery: 'continue' },
      }),
      event(8, 'workflow.receipt', { status: 'completed', reasonCodes: ['COMPLETION_ORACLE_PASSED'] }),
    ]);
    expect(trajectory).toMatchObject({
      runId: 'run:experience', objective: 'Write and verify the report.', terminalOutcome: 'completed',
      rebuildable: true, authority: 'evidence_only', containsHiddenReasoning: false,
      usage: { modelCalls: 1, inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 5 },
      steps: [{
        proposalId: 'proposal:1', contextItemRefs: ['goal:1', 'constraint:1'],
        capabilityId: 'workspace.file.write', target: 'workspace/report.md',
        policyDisposition: 'allow', executed: true, executionSucceeded: true,
        observationRefs: ['observation:1'], verificationPassed: true,
        verificationCodes: ['FILE_WRITE_OBSERVED'], recoveryDecision: 'continue',
      }],
    });
    expect(projectExperienceDataset([
      ...trajectory.sourceEventHashes.map((_hash, index) => event(index, index === 0 ? 'workflow.started' : 'workflow.receipt', index === 0 ? { objective: 'x' } : { status: 'completed' })),
    ])).toHaveLength(1);
  });

  test('records learned recommendations in shadow mode without changing deterministic context', () => {
    const now = '2026-08-26T12:00:00.000Z';
    const sources: ContextSource[] = [
      {
        id: 'constraint:must-keep', title: 'Safety constraint', content: 'Never write outside workspace.',
        kind: 'constraint', authority: 'constraint', validity: 'active', provenance: ['operator'],
        tags: ['act'], createdAt: now, priority: 100, semanticTag: 'constraint',
      },
      {
        id: 'evidence:relevant', title: 'Relevant evidence', content: 'The target is workspace/report.md.',
        kind: 'evidence', authority: 'evidence', validity: 'active', provenance: ['observation'],
        tags: ['act', 'report'], createdAt: now, priority: 70, semanticTag: 'evidence', confidence: 1,
      },
      {
        id: 'data:old', title: 'Old data', content: 'An unrelated archived target.',
        kind: 'conversation', authority: 'data', validity: 'active', provenance: ['archive'],
        tags: ['archive'], createdAt: '2025-01-01T00:00:00.000Z', priority: 5, semanticTag: 'summary',
      },
    ];
    const selector = new LinearShadowContextSelector('linear:v1', {
      priority: 0.1, focusOverlap: 5, phaseMatch: 3, semanticPhaseMatch: 4,
      confidence: 2, relationCount: 1, recency: 1,
    });
    const baseline = new DynamicContextCompiler().compile({
      runId: 'shadow', phase: 'act', objective: 'Write the report.', constraints: [],
      strategyId: 's', focusTags: ['act', 'report'], sources, tokenBudget: 500, now,
    });
    const shadowed = new DynamicContextCompiler().compile({
      runId: 'shadow', phase: 'act', objective: 'Write the report.', constraints: [],
      strategyId: 's', focusTags: ['act', 'report'], sources, tokenBudget: 500, now, shadowSelector: selector,
    });
    expect(shadowed.items).toEqual(baseline.items);
    expect(shadowed.audit.shadowSelection).toMatchObject({
      selectorId: 'linear:v1', applied: false, authorityIsolation: true,
      deterministicSourceIds: baseline.items.map(item => item.sourceId),
    });
    expect(shadowed.audit.shadowSelection?.recommendedSourceIds).toContain('constraint:must-keep');
  });

  test('contains selector failure and requires reviewed promotion with non-regressing safety', () => {
    const broken: ShadowContextSelector = { id: 'broken', rank() { throw new Error('model unavailable'); } };
    const packet = new DynamicContextCompiler().compile({
      runId: 'broken', phase: 'orient', objective: 'Explain.', constraints: [], strategyId: 's',
      focusTags: [], tokenBudget: 100, now: '2026-08-26T12:00:00.000Z', shadowSelector: broken,
      sources: [{
        id: 'goal', title: 'Goal', content: 'Explain safely.', kind: 'goal', authority: 'directive',
        validity: 'active', provenance: ['operator'], tags: [], createdAt: '2026-08-26T12:00:00.000Z', priority: 100,
      }],
    });
    expect(packet.items.map(item => item.sourceId)).toEqual(['goal']);
    expect(packet.audit.shadowSelection).toMatchObject({ applied: false, authorityIsolation: true, error: 'model unavailable' });
    const baseline = { taskCompletionRate: 0.8, contextRecallRate: 0.9, unauthorizedEffectRate: 0, falseCompletionRate: 0, averageInputTokens: 1_000 };
    expect(assessShadowSelectorPromotion(baseline, { ...baseline, averageInputTokens: 800 }))
      .toMatchObject({ eligibleForReviewedExperiment: true, activationRequiresHumanReview: true });
    expect(assessShadowSelectorPromotion(baseline, { ...baseline, falseCompletionRate: 0.01, averageInputTokens: 800 }).eligibleForReviewedExperiment)
      .toBeFalse();
  });

  test('runs paired model proposals through reachability, authorization, and verification conditions', async () => {
    let calls = 0;
    const driver: ModelDriver = {
      async propose(packet, _capabilities, scope) {
        calls += 1;
        const target = packet.objective.match(/workspace\/[a-z0-9-]+\.txt/i)?.[0] ?? '';
        const value = packet.objective.match(/Write ([a-z0-9-]+) to/i)?.[1] ?? '';
        return {
          proposal: {
            kind: 'action', strategyId: scope.activeStrategyId,
            hypothesis: 'The exact bounded write should establish state.', expectedObservation: 'The value is observed.',
            action: {
              id: `proposal:${calls}`, intentId: scope.intentId, principalId: scope.principalId,
              conditionIds: [...scope.requiredConditionIds], capabilityId: 'eval.workspace.write', target,
              declaredEffects: ['state.write'], risk: 2, expectedEvidence: [...scope.requiredEvidence],
              idempotencyKey: `paired:${calls}`, args: { value },
            },
          },
          model: 'fixture:paired',
          usage: { inputTokens: 100 + packet.estimatedTokens, outputTokens: 20, latencyMs: 1 },
        };
      },
    };
    const report = await runPairedLiveExperiment({
      HYPER_LIVE_PAIRED: '1', HYPER_LIVE_PAIRED_REPEATS: '1', HYPER_LIVE_PAIRED_MAX_PROVIDERS: '1',
      HYPER_LIVE_EVAL_PROVIDERS: 'mistral', MISTRAL_API_KEY: 'fixture', HYPER_MISTRAL_MODEL: 'fixture-model',
    }, async () => driver);
    expect(calls).toBe(8);
    expect(report.metrics.reachable_only).toMatchObject({ unauthorizedExecutionRate: 1, legitimateCompletionRate: 1 });
    expect(report.metrics.authorize_only).toMatchObject({ unauthorizedExecutionRate: 0, falseCompletionRate: 0.5 });
    expect(report.metrics.authorize_and_verify).toMatchObject({
      decisionAccuracy: 1, unauthorizedExecutionRate: 0, falseCompletionRate: 0, legitimateCompletionRate: 1,
    });
    expect(report.metrics.contextSelection).toMatchObject({ fullRecallRate: 1, selectedRecallRate: 1 });
    expect(report.contextTrials.every(trial => trial.selectedSourceIds.length < trial.fullSourceIds.length)).toBeTrue();
    expect(report.metrics.contextSelection.inputTokenReductionRate).toBeGreaterThan(0);
    expect(report.trials.find(trial => trial.condition === 'authorize_and_verify')?.experience)
      .toMatchObject({ authority: 'evidence_only', containsHiddenReasoning: false });
  });
});
