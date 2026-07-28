/**
 * domain/career/types.ts — Career Subsystem Types.
 * Ported from deterministic-ai-kernel-main/src/lib/career/types.ts
 */

export interface CareerGoal {
  targetRole: string;
  targetLevel: string;
  timeframeMonths: number;
  keySkillsRequired: string[];
}

export interface SkillGapAnalysis {
  currentSkills: string[];
  missingSkills: string[];
  recommendedActions: string[];
}

export interface CareerTrajectoryPlan {
  goal: CareerGoal;
  gapAnalysis: SkillGapAnalysis;
  milestones: Array<{ month: number; title: string; outcome: string }>;
}
