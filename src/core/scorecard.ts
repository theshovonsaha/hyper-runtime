/**
 * core/scorecard.ts — Trajectory Quality & Execution Scorecard Evaluator.
 * Ported from python scorecard.py
 *
 * Grades agent run trajectories on tool execution efficiency, token economy,
 * verification success rate, and completion speed.
 */

export interface ScorecardMetrics {
  runId: string;
  durationMs: number;
  totalTokens: number;
  toolCallCount: number;
  failedToolCalls: number;
  verificationPassed: boolean;
  score: number;             // Overall grade from 0 to 100
  rating: 'S' | 'A' | 'B' | 'C' | 'F';
  feedback: string[];
}

export function evaluateScorecard(input: {
  runId: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: Array<{ name: string; success: boolean }>;
  verdict?: 'ok' | 'revise' | null;
}): ScorecardMetrics {
  const feedback: string[] = [];
  let points = 100;

  const totalTokens = input.inputTokens + input.outputTokens;
  const toolCallCount = input.toolCalls.length;
  const failedToolCalls = input.toolCalls.filter(t => !t.success).length;

  // 1. Tool Failure Penalty (-15 per failed tool call)
  if (failedToolCalls > 0) {
    points -= failedToolCalls * 15;
    feedback.push(`${failedToolCalls} tool call(s) failed or returned errors.`);
  }

  // 2. Token Budget Penalties (>10,000 tokens)
  if (totalTokens > 10000) {
    points -= 10;
    feedback.push(`High token usage: ${totalTokens} tokens consumed.`);
  }

  // 3. Verification Penalty
  const verificationPassed = input.verdict !== 'revise';
  if (input.verdict === 'revise') {
    points -= 20;
    feedback.push('Verification pass required internal answer revision.');
  }

  // 4. Latency Penalty (>15 seconds)
  if (input.durationMs > 15000) {
    points -= 10;
    feedback.push(`Execution duration exceeded 15s (${Math.round(input.durationMs / 1000)}s).`);
  }

  const score = Math.max(0, Math.min(100, points));

  let rating: 'S' | 'A' | 'B' | 'C' | 'F' = 'F';
  if (score >= 95) rating = 'S';
  else if (score >= 85) rating = 'A';
  else if (score >= 70) rating = 'B';
  else if (score >= 50) rating = 'C';

  if (feedback.length === 0) {
    feedback.push('Optimal execution trajectory: zero errors, fast completion.');
  }

  return {
    runId: input.runId,
    durationMs: input.durationMs,
    totalTokens,
    toolCallCount,
    failedToolCalls,
    verificationPassed,
    score,
    rating,
    feedback,
  };
}
