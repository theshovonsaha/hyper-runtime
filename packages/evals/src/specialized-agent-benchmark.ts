import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RuntimeLabScenario } from './runtime-lab';
import { runRuntimeLabScenario } from './runtime-lab';

interface Definition {
  benchmark: string;
  version: string;
  domain: string;
  seeds: string[];
  mutations: Array<Pick<RuntimeLabScenario, 'fault' | 'expectedStatus' | 'requiredEvents' | 'forbiddenEvents'>>;
}

export interface SpecializedAgentReport {
  benchmark: string;
  version: string;
  domain: string;
  evidenceMode: 'deterministic_fixture';
  trialCount: number;
  treatment: { completionAccuracy: number; falseSuccessRate: number; authorityViolationRate: number };
  reachableOnlyBaseline: { falseSuccessRate: number; note: string };
  replayFidelity: number;
  acceptance: { passed: boolean; minimumTrials: number; maximumFalseSuccessRate: number };
}

export async function runSpecializedAgentBenchmark(): Promise<SpecializedAgentReport> {
  const definition = JSON.parse(
    readFileSync(resolve(process.cwd(), 'evals/specialized-agent.v1.json'), 'utf8'),
  ) as Definition;
  const scenarios = definition.seeds.flatMap(seed => definition.mutations.map((mutation, index) => ({
    id: `${seed}:${index + 1}`,
    ...mutation,
  })));
  const trials = await Promise.all(scenarios.map(scenario => runRuntimeLabScenario(scenario)));
  const replayed = await Promise.all(scenarios.map(scenario =>
    runRuntimeLabScenario({ ...scenario, id: `${scenario.id}:replay` }),
  ));
  const falseClaims = trials.filter(trial => trial.executionReportedSuccess && trial.actualStatus !== 'completed');
  const denied = trials.filter(trial => trial.actualStatus === 'denied' || trial.actualStatus === 'awaiting_approval');
  const replayMatches = trials.filter((trial, index) => {
    const replay = replayed[index];
    return replay?.actualStatus === trial.actualStatus
      && JSON.stringify(replay.eventTypes) === JSON.stringify(trial.eventTypes);
  }).length;
  const report: SpecializedAgentReport = {
    benchmark: definition.benchmark,
    version: definition.version,
    domain: definition.domain,
    evidenceMode: 'deterministic_fixture',
    trialCount: trials.length,
    treatment: {
      completionAccuracy: trials.filter(trial => trial.passed).length / trials.length,
      falseSuccessRate: trials.filter(trial =>
        trial.actualStatus === 'completed' && trial.expectedStatus !== 'completed',
      ).length / trials.length,
      authorityViolationRate: denied.filter(trial => trial.eventTypes.includes('action.executed')).length / Math.max(1, denied.length),
    },
    reachableOnlyBaseline: {
      falseSuccessRate: falseClaims.length / Math.max(1, trials.filter(trial => trial.executionReportedSuccess).length),
      note: 'Counterfactual structural baseline treats adapter success as task success; it is not a second live execution.',
    },
    replayFidelity: replayMatches / trials.length,
    acceptance: { passed: trials.length >= 50 && trials.every(trial => trial.passed), minimumTrials: 50, maximumFalseSuccessRate: 0 },
  };
  return report;
}

export function writeSpecializedAgentReport(report: SpecializedAgentReport, outputDirectory: string): void {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, 'specialized-agent-latest.json'), `${JSON.stringify(report, null, 2)}\n`);
}
