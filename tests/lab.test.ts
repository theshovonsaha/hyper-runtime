import { describe, expect, test } from 'bun:test';
import { CONTRACT_VERSION, type LedgerEvent } from '@hyper/contracts';
import { analyzeLabRun, compareLabRuns } from '../packages/cli/src/lab';
import type { OperatorRun } from '../packages/cli/src/operator-store';
import { HashChainLedger } from '@hyper/runtime';

function event(sequence: number, type: string, payload: Record<string, unknown> = {}): LedgerEvent {
  return {
    version: CONTRACT_VERSION,
    runId: 'run:lab',
    sequence,
    type,
    payload,
    previousHash: '0'.repeat(64),
    hash: String(sequence).padStart(64, '0'),
  };
}

function run(overrides: Partial<OperatorRun> = {}): OperatorRun {
  return {
    id: 'run:lab', sessionId: 'session:lab', objective: 'Inspect README and report its heading.',
    status: 'completed', profile: 'inspect', provider: 'gemini', model: 'flash',
    startedAt: '2026-08-09T10:00:00.000Z', endedAt: '2026-08-09T10:00:02.000Z',
    evidenceRefs: ['observation:1'], labExperimentId: 'experiment:1', labAgentId: 'verified-minimal',
    labModules: ['authority_policy', 'observed_state', 'semantic_verification'],
    ...overrides,
  };
}

describe('runtime lab analysis', () => {
  test('verifies the canonical event hash chain before scoring safety', () => {
    const ledger = new HashChainLedger();
    ledger.append('run:lab', 'operator.run_started', {});
    ledger.append('run:lab', 'policy.decided', { disposition: 'deny' });
    const analysis = analyzeLabRun(run({ status: 'blocked', evidenceRefs: [] }), [...ledger.all()]);
    expect(analysis.metrics.ledgerIntegrity).toBeTrue();
    expect(analysis.detections.map(item => item.code)).not.toContain('LEDGER_INTEGRITY_FAILED');
  });

  test('detects verified completion and separates declared from exercised modules', () => {
    const analysis = analyzeLabRun(run(), [
      event(0, 'operator.run_started', {
        labModules: ['authority_policy', 'observed_state', 'semantic_verification'],
        routingMode: 'fallback',
      }),
      event(1, 'context.compiled', { audit: { contradictionCount: 0 } }),
      event(2, 'model.proposed', { usage: { inputTokens: 100, outputTokens: 20 } }),
      event(3, 'policy.decided', { disposition: 'allow' }),
      event(4, 'action.executed', { success: true, effectState: 'applied' }),
      event(5, 'state.observed'),
      event(6, 'action.verified', { passed: true, evidence: [{ id: 'observation:1' }] }),
      event(7, 'workflow.progress_assessed', { progress: { recovery: 'continue' } }),
      event(8, 'workflow.receipt', { status: 'completed' }),
    ]);
    expect(analysis.scores.outcome).toBe(100);
    expect(analysis.detections.map(item => item.code)).toContain('VERIFIED_COMPLETION');
    expect(analysis.observedModules.context_compilation).toBeTrue();
    expect(analysis.declaredModules).not.toContain('context_compilation');
    expect(analysis.metrics.modelInputTokens).toBe(100);
    expect(analysis.evidenceClass).toBe('canonical_run');
  });

  test('flags false-success prevention, unresolved effects, and retry pressure', () => {
    const analysis = analyzeLabRun(run({ status: 'verification_failed', evidenceRefs: [] }), [
      event(0, 'operator.run_started'),
      event(1, 'policy.decided', { disposition: 'allow' }),
      event(2, 'action.proposed', { proposalId: 'same' }),
      event(3, 'action.executed', { success: true, effectState: 'unknown' }),
      event(4, 'state.observed'),
      event(5, 'action.verified', { passed: false }),
      event(6, 'action.proposed', { proposalId: 'same' }),
      event(7, 'action.proposed', { proposalId: 'same' }),
    ]);
    const codes = analysis.detections.map(item => item.code);
    expect(codes).toContain('FALSE_SUCCESS_PREVENTED');
    expect(codes).toContain('UNRESOLVED_EFFECT');
    expect(codes).toContain('RETRY_PRESSURE');
    expect(analysis.scores.outcome).toBeLessThan(50);
  });

  test('comparison refuses to hide objective and configuration confounds', () => {
    const baseEvents = [
      event(0, 'operator.run_started'), event(1, 'policy.decided', { disposition: 'deny' }),
    ];
    const first = analyzeLabRun(run({ id: 'run:a', status: 'blocked' }), baseEvents);
    const second = analyzeLabRun(run({
      id: 'run:b', objective: 'Research unrelated market data.', provider: 'groq', profile: 'research',
      status: 'blocked',
    }), baseEvents);
    const comparison = compareLabRuns([first, second]);
    expect(comparison.comparable).toBeFalse();
    expect(comparison.confounds).toContain('providers differ');
    expect(comparison.confounds).toContain('authority profiles differ');
    expect(comparison.confounds).toContain('objectives are not equivalent');
  });
});
