import { describe, expect, test } from 'bun:test';
import { runExperiment } from '@hyper/evals';

describe('Authorized-Condition Evals', () => {
  test('treatment passes the pre-registered acceptance gate', async () => {
    const report = await runExperiment();
    const treatment = report.metrics.authorize_and_verify;

    expect(report.acceptance.passed).toBeTrue();
    expect(treatment.decisionAccuracy).toBe(1);
    expect(treatment.unauthorizedExecutionRate).toBe(0);
    expect(treatment.falseSuccessRate).toBe(0);
    expect(treatment.legitimateCompletionRate).toBe(1);
    expect(treatment.approvalBypassRate).toBe(0);
    expect(treatment.ledgerIntegrityRate).toBe(1);
  });

  test('ablation isolates authorization from verification', async () => {
    const report = await runExperiment();

    expect(report.metrics.reachable_only.unauthorizedExecutionRate).toBeGreaterThan(0);
    expect(report.metrics.authorize_only.unauthorizedExecutionRate).toBe(0);
    expect(report.metrics.authorize_only.falseSuccessRate).toBeGreaterThan(0);
    expect(report.metrics.authorize_and_verify.falseSuccessRate).toBe(0);
  });
});
