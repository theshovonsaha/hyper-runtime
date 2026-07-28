import { ProactiveSeedEngine } from '../src/modules';

async function testProactiveSeedEngine() {
  console.log('========================================================================');
  console.log('--- PROACTIVE THINKING & SEED SELECTION ENGINE VERIFICATION ---');
  console.log('========================================================================');

  const engine = new ProactiveSeedEngine();

  // 1. Test Deterministic Seed Computation (Reproducibility)
  console.log('\n[Part 1] Testing Deterministic Seed Computation (Reproducible Runs)...');
  const prompt = 'Build a hypersonic AI engine with 8-lane ContextAssembler';
  const seed1 = engine.computeDeterministicSeed(prompt, 'run-100');
  const seed2 = engine.computeDeterministicSeed(prompt, 'run-100');
  console.log('  Run 1 Seed:', seed1);
  console.log('  Run 2 Seed (Same Prompt & RunId):', seed2);

  const sel1 = engine.selectSeed(prompt, 'run-100', false);
  console.log('  Selection Output:', sel1.reason);

  // 2. Test Parallel Exploration Seeds (Trajectory Branching)
  console.log('\n[Part 2] Testing Parallel Exploration Seeds (Diverse Trajectory Branching)...');
  const explorationSeeds = engine.generateExplorationSeeds(3);
  console.log('  Generated 3 Exploration Seeds for TTSP Branching:', explorationSeeds);

  if (seed1 === seed2 && explorationSeeds.length === 3 && explorationSeeds[0] !== explorationSeeds[1]) {
    console.log('\n========================================================================');
    console.log('--- ALL PROACTIVE SEED ENGINE VERIFICATION TESTS PASSED ---');
    console.log('========================================================================');
  } else {
    console.error('FAIL: Seed engine tests did not pass expectations.');
  }
}

testProactiveSeedEngine().catch(console.error);
