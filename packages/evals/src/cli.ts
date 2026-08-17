import { resolve } from 'node:path';
import { runExperiment, writeReport } from './experiment';
import { runAdaptiveWorkflowExperiment, writeAdaptiveReport } from './workflow-experiment';
import { runCorrectionGrammarExperiment, writeCorrectionGrammarReport } from './correction-experiment';
import { runAdversarialExperiment, writeAdversarialReport } from './adversarial-experiment';
import { runRuntimeLab, writeRuntimeLabReport } from './runtime-lab';
import { runSpecializedAgentBenchmark, writeSpecializedAgentReport } from './specialized-agent-benchmark';

const report = await runExperiment();
const adaptiveReport = await runAdaptiveWorkflowExperiment();
const correctionReport = await runCorrectionGrammarExperiment();
const adversarialReport = await runAdversarialExperiment();
const runtimeLabReport = await runRuntimeLab();
const specializedReport = await runSpecializedAgentBenchmark();
const outputDir = resolve(process.cwd(), 'evals/results');
writeReport(report, outputDir);
writeAdaptiveReport(adaptiveReport, outputDir);
writeCorrectionGrammarReport(correctionReport, outputDir);
writeAdversarialReport(adversarialReport, outputDir);
writeRuntimeLabReport(runtimeLabReport, outputDir);
writeSpecializedAgentReport(specializedReport, outputDir);

console.log(`Authorized-Condition Evals: ${report.acceptance.passed ? 'PASS' : 'FAIL'}`);
for (const [condition, metrics] of Object.entries(report.metrics)) {
  console.log(
    `${condition.padEnd(22)} decision=${metrics.decisionAccuracy.toFixed(3)} `
    + `unauthorized=${metrics.unauthorizedExecutionRate.toFixed(3)} `
    + `false_success=${metrics.falseSuccessRate.toFixed(3)} `
    + `legitimate=${metrics.legitimateCompletionRate.toFixed(3)}`,
  );
}
console.log(
  `Adaptive Context/Workflow Evals: ${adaptiveReport.acceptance.passed ? 'PASS' : 'FAIL'} `
  + `context=${adaptiveReport.metrics.contextExpectationAccuracy.toFixed(3)} `
  + `recovery=${adaptiveReport.metrics.recoverySuccessRate.toFixed(3)} `
  + `false_completion=${adaptiveReport.metrics.falseCompletionCommitRate.toFixed(3)}`,
);
console.log(`Adversarial Runtime Evals: ${adversarialReport.acceptance.passed ? 'PASS' : 'FAIL'} pass_rate=${adversarialReport.passRate.toFixed(3)} model_calls=0`);
console.log(`Runtime Scenario Lab: ${runtimeLabReport.acceptance.passed ? 'PASS' : 'FAIL'} scenarios=${runtimeLabReport.trials.length} pass_rate=${runtimeLabReport.metrics.scenarioPassRate.toFixed(3)} evidence=deterministic_fixture`);
console.log(`Specialized Agent Benchmark: ${specializedReport.acceptance.passed ? 'PASS' : 'FAIL'} trials=${specializedReport.trialCount} completion=${specializedReport.treatment.completionAccuracy.toFixed(3)} false_success=${specializedReport.treatment.falseSuccessRate.toFixed(3)} evidence=deterministic_fixture`);
console.log(
  `Correction Grammar Ablation: ${correctionReport.acceptance.passed ? 'PASS' : 'FAIL'} `
  + `baseline=${correctionReport.baselineStatus} `
  + `treatment=${correctionReport.treatmentStatus} `
  + `assessment=${correctionReport.assessment ?? 'missing'}`,
);
console.log(`Results: ${outputDir}`);

if (
  !report.acceptance.passed
  || !adaptiveReport.acceptance.passed
  || !correctionReport.acceptance.passed
  || !adversarialReport.acceptance.passed
  || !runtimeLabReport.acceptance.passed
  || !specializedReport.acceptance.passed
) process.exitCode = 1;
