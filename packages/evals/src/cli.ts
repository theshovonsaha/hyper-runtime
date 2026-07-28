import { resolve } from 'node:path';
import { runExperiment, writeReport } from './experiment';
import { runAdaptiveWorkflowExperiment, writeAdaptiveReport } from './workflow-experiment';

const report = await runExperiment();
const adaptiveReport = await runAdaptiveWorkflowExperiment();
const outputDir = resolve(process.cwd(), 'evals/results');
writeReport(report, outputDir);
writeAdaptiveReport(adaptiveReport, outputDir);

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
console.log(`Results: ${outputDir}`);

if (!report.acceptance.passed || !adaptiveReport.acceptance.passed) process.exitCode = 1;
