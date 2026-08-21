import type { WorkflowBacktestReport, WorkflowCandidate } from '@hyper/contracts';

export interface WorkflowMutation {
  id: string;
  apply(candidate: WorkflowCandidate): WorkflowCandidate;
}

export async function backtestWorkflowCandidate(
  candidate: WorkflowCandidate,
  scenarios: Array<(candidate: WorkflowCandidate) => boolean | Promise<boolean>>,
  mutations: WorkflowMutation[] = [],
): Promise<WorkflowBacktestReport> {
  if (candidate.status !== 'candidate') throw new Error('BACKTEST_REQUIRES_INERT_CANDIDATE');
  if (scenarios.length === 0) throw new Error('BACKTEST_REQUIRES_SCENARIOS');
  const outcomes = await Promise.all(scenarios.map(scenario => scenario(structuredClone(candidate))));
  let mutationsSurvived = 0;
  for (const mutation of mutations) {
    const mutated = mutation.apply(structuredClone(candidate));
    const mutationOutcomes = await Promise.all(scenarios.map(scenario => scenario(mutated)));
    if (mutationOutcomes.every(Boolean)) mutationsSurvived += 1;
  }
  const passed = outcomes.filter(Boolean).length;
  return {
    candidateId: candidate.id,
    scenarioCount: outcomes.length,
    passed,
    failed: outcomes.length - passed,
    mutationsSurvived,
    acceptancePassed: passed === outcomes.length && mutationsSurvived === mutations.length,
  };
}
