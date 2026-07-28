import { EightyTwentyDeterministicEngine } from '../src/modules';

async function test8020DeterministicRuntime() {
  console.log('========================================================================');
  console.log('--- THE 80/20 DETERMINISTIC RUNTIME OPTIMIZATION VERIFICATION ---');
  console.log('========================================================================');

  const engine = new EightyTwentyDeterministicEngine();

  // 1. Test 80% Math Pre-Resolution (0 LLM Tokens)
  console.log('\n[Part 1] Pre-Resolving Math Calculation (0 LLM Tokens)...');
  const mathRes = engine.preResolveTurn('Calculate 50 * 4 + 10');
  console.log('  Handled Deterministically by Runtime:', mathRes.handledByRuntimeDeterministic);
  console.log('  Deterministic Output:', mathRes.deterministicOutput);
  console.log('  Saved LLM Tokens:', mathRes.savedTokens);

  // 2. Test 80% Financial Pre-Resolution (0 LLM Tokens)
  console.log('\n[Part 2] Pre-Resolving Financial Stock Query (0 LLM Tokens)...');
  const stockRes = engine.preResolveTurn('Check $AAPL fundamentals');
  console.log('  Handled Deterministically by Runtime:', stockRes.handledByRuntimeDeterministic);
  console.log('  Target Tool to Execute:', stockRes.toolToExecute);
  console.log('  Saved LLM Tokens:', stockRes.savedTokens);

  // 3. Test 20% Fluid LLM Driver Delegation
  console.log('\n[Part 3] Delegating 20% Creative Prompt to Fluid LLM Driver...');
  const fluidRes = engine.preResolveTurn('Write a sci-fi story about hypersonic space flight');
  console.log('  Handled Deterministically by Runtime:', fluidRes.handledByRuntimeDeterministic);
  console.log('  Remaining LLM Duty Percent:', fluidRes.remainingLlmDutyPercent + '%');

  if (mathRes.handledByRuntimeDeterministic && stockRes.handledByRuntimeDeterministic && !fluidRes.handledByRuntimeDeterministic) {
    console.log('\n========================================================================');
    console.log('--- THE 80/20 DETERMINISTIC RUNTIME ENGINE VERIFIED (100% SUCCESS) ---');
    console.log('========================================================================');
  } else {
    console.error('FAIL: 80/20 deterministic runtime test failed.');
  }
}

test8020DeterministicRuntime().catch(console.error);
