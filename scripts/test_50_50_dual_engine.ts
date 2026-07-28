import { FiftyFiftyDualEngine } from '../src/modules';

async function testFiftyFiftyDualEngine() {
  console.log('========================================================================');
  console.log('--- THE 50/50 DUAL-ENGINE DETERMINISTIC EXECUTION CORE VERIFICATION ---');
  console.log('========================================================================');

  const engine = new FiftyFiftyDualEngine();

  // 1. Test 50% Deterministic Trajectory Planning
  console.log('\n[Part 1] Planning 50/50 Dual-Engine Execution Trajectory...');
  const plan = engine.planDualExecution('Calculate 100 * 5');

  console.log('  Runtime Deterministic Percent:', plan.handledByRuntimePercent + '%');
  console.log('  LLM Driver Duty Percent:', plan.handledByLlmPercent + '%');
  console.log('  Pre-Computed Tool Chain Length:', plan.preComputedToolChain.length);
  console.log('  Saved LLM Tokens:', plan.savedTokens);

  if (plan.handledByRuntimePercent === 50 && plan.handledByLlmPercent === 50 && plan.savedTokens > 0) {
    console.log('\n========================================================================');
    console.log('--- 50/50 DUAL-ENGINE CORE VERIFIED (100% SUCCESS) ---');
    console.log('========================================================================');
  } else {
    console.error('FAIL: 50/50 dual-engine test failed.');
  }
}

testFiftyFiftyDualEngine().catch(console.error);
