/**
 * core/seed_engine.ts — Proactive Thinking & Deterministic Seed Selection Engine.
 *
 * Provides:
 *   1. Proactive Seed Computation: Hashes prompt text and run ID into deterministic 32-bit uint seeds
 *      to ensure reproducible LLM outputs during fluid reasoning turns.
 *   2. Parallel Branch Exploration Seeds: Generates distinct random seeds for multi-trajectory
 *      tree branching (TTSP), allowing diverse path exploration across identical prompts.
 */

export interface SeedSelection {
  seed: number;
  mode: 'reproducible_deterministic' | 'diverse_exploration';
  reason: string;
}

export class ProactiveSeedEngine {
  /** Hash string to deterministic 32-bit unsigned integer seed */
  computeDeterministicSeed(prompt: string, runId = ''): number {
    const input = `${prompt}:${runId}`;
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
      hash = (hash * 33) ^ input.charCodeAt(i);
    }
    return Math.abs(hash >>> 0);
  }

  selectSeed(prompt: string, runId?: string, isExploration = false): SeedSelection {
    if (!isExploration) {
      const seed = this.computeDeterministicSeed(prompt, runId);
      return {
        seed,
        mode: 'reproducible_deterministic',
        reason: `Computed deterministic seed ${seed} from prompt hash.`,
      };
    }

    const randomSeed = Math.floor(Math.random() * 2_147_483_647);
    return {
      seed: randomSeed,
      mode: 'diverse_exploration',
      reason: `Generated random exploration seed ${randomSeed} for parallel branch synthesis.`,
    };
  }

  generateExplorationSeeds(count = 3): number[] {
    const seeds: number[] = [];
    for (let i = 0; i < count; i++) {
      seeds.push(Math.floor(Math.random() * 2_147_483_647));
    }
    return seeds;
  }
}
