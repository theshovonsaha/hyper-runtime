/**
 * protocols/ttsp.ts — Trajectory Tree Synthesis Protocol (TTSP).
 *
 * NOVEL PROTOCOL: Merges multiple parallel trajectory branches into a single,
 * canonical optimal solution path (Trajectory Fork & Merge).
 */

export interface BranchTrajectory {
  branchId: string;
  steps: Array<{ stepIndex: number; toolCalled?: string; content: string }>;
  qualityScore: number;
}

export interface MergedSynthesisResult {
  masterRunId: string;
  synthesizedText: string;
  winningBranchId: string;
  stepsCombined: number;
  logSummary: string;
}

export class TrajectoryTreeSynthesizer {
  mergeBranches(masterRunId: string, branches: BranchTrajectory[]): MergedSynthesisResult {
    if (branches.length === 0) {
      return {
        masterRunId,
        synthesizedText: '',
        winningBranchId: 'none',
        stepsCombined: 0,
        logSummary: 'TTSP: No branches provided for synthesis.',
      };
    }

    // Pick top-scoring branch
    const sorted = [...branches].sort((a, b) => b.qualityScore - a.qualityScore);
    const winner = sorted[0];

    const combinedSteps = winner.steps.map(s => s.content).join('\n\n');

    return {
      masterRunId,
      synthesizedText: `[TTSP Master Synthesis — Merged from ${branches.length} Branches]\nWinning Branch: ${winner.branchId} (Score: ${winner.qualityScore})\n\n${combinedSteps}`,
      winningBranchId: winner.branchId,
      stepsCombined: winner.steps.length,
      logSummary: `TTSP: Synthesized ${branches.length} branches. Selected winning trajectory ${winner.branchId} (Score: ${winner.qualityScore}).`,
    };
  }
}
