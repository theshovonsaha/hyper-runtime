import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runRuntimeLabScenario, type RuntimeLabScenario, type RuntimeLabTrial } from './runtime-lab';

interface ContributedDataset {
  benchmark: string;
  version: string;
  license: string;
  authorship: {
    kind: 'independent';
    contributor: string;
    affiliation?: string;
    contributedAt: string;
    conflictStatement: string;
  };
  scenarios: RuntimeLabScenario[];
}

export interface ContributedEvaluationReport {
  evidenceClass: 'independently_contributed_fixture';
  benchmark: string;
  version: string;
  datasetSha256: string;
  contributor: string;
  treatment: { passRate: number; trials: RuntimeLabTrial[] };
  authorizationOnlyBaseline: { falseSuccessRate: number; trials: RuntimeLabTrial[] };
  acceptancePassed: boolean;
}

export function validateContributedDataset(value: unknown): ContributedDataset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Contributed dataset must be an object.');
  const dataset = value as Partial<ContributedDataset>;
  if (!dataset.benchmark || !dataset.version || !dataset.license) throw new Error('Dataset identity and license are required.');
  if (dataset.authorship?.kind !== 'independent' || !dataset.authorship.contributor?.trim() || !dataset.authorship.conflictStatement?.trim()) {
    throw new Error('Independent contributor identity and conflict statement are required.');
  }
  if (!Array.isArray(dataset.scenarios) || dataset.scenarios.length < 5) throw new Error('At least five held-out scenarios are required.');
  const ids = new Set<string>();
  for (const scenario of dataset.scenarios) {
    if (!scenario.id || ids.has(scenario.id) || !Array.isArray(scenario.requiredEvents) || !Array.isArray(scenario.forbiddenEvents)) {
      throw new Error('Scenario IDs must be unique and event expectations explicit.');
    }
    ids.add(scenario.id);
  }
  return structuredClone(dataset as ContributedDataset);
}

export async function runContributedExperiment(path: string): Promise<ContributedEvaluationReport> {
  const source = readFileSync(resolve(path), 'utf8');
  const dataset = validateContributedDataset(JSON.parse(source));
  const treatment = await Promise.all(dataset.scenarios.map(scenario => runRuntimeLabScenario(scenario)));
  const baseline = await Promise.all(dataset.scenarios.map(scenario => runRuntimeLabScenario(scenario, 'trust_execution')));
  const passRate = treatment.filter(trial => trial.passed).length / treatment.length;
  const falseSuccessCases = baseline.filter(trial => trial.executionReportedSuccess && trial.actualStatus === 'completed'
    && (trial.fault === 'false_success' || trial.fault === 'stale_observation'));
  return {
    evidenceClass: 'independently_contributed_fixture',
    benchmark: dataset.benchmark,
    version: dataset.version,
    datasetSha256: createHash('sha256').update(source).digest('hex'),
    contributor: dataset.authorship.contributor,
    treatment: { passRate, trials: treatment },
    authorizationOnlyBaseline: {
      falseSuccessRate: baseline.length ? falseSuccessCases.length / baseline.length : 0,
      trials: baseline,
    },
    acceptancePassed: passRate === 1,
  };
}

if (import.meta.main) {
  const path = process.env.HYPER_CONTRIBUTED_EVAL;
  if (!path) throw new Error('Set HYPER_CONTRIBUTED_EVAL to an independently authored fixture file.');
  const report = await runContributedExperiment(path);
  const output = resolve(process.cwd(), 'evals/results/contributed-latest.json');
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Contributed Evals: pass_rate=${report.treatment.passRate.toFixed(3)} contributor=${report.contributor}`);
  if (!report.acceptancePassed) process.exitCode = 1;
}
