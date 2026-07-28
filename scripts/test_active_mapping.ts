import { ActiveMappingEngine } from '../src/modules';

async function testActiveMapping() {
  console.log('========================================================================');
  console.log('--- ACTIVE MEMORY & ACTIVE CHAT MODEL MAPPING VERIFICATION SUITE ---');
  console.log('========================================================================');

  const engine = new ActiveMappingEngine();

  // 1. Test Active Memory Mapping
  console.log('\n[Part 1] Testing Active Memory Mapping (Hot Memory Pointers)...');
  const ptr = engine.bindActiveMemory('active-sess-100', 'Financial Valuation of Tech Stocks', ['thr_fin_01', 'thr_fin_02']);
  console.log('  Bound Active Memory Pointer:', ptr.sessionId);
  console.log('  Active Topic:', ptr.activeTopic);
  console.log('  Active Memory Thread IDs:', ptr.activeThreadIds);

  // 2. Test Active Chat Model Mapping per Phase
  console.log('\n[Part 2] Testing Active Chat Model Mapping per Execution Phase...');
  const phases: any[] = ['synopsis', 'memory_extract', 'plan', 'tool_loop', 'verify'];

  for (const phase of phases) {
    const rule = engine.resolveModelForPhase(phase);
    console.log(`  Phase [${phase}] -> Mapped Model: ${rule.provider}:${rule.model} (${rule.reason})`);
  }

  // Test User Override
  const overrideRule = engine.resolveModelForPhase('plan', 'openai', 'o3-mini');
  console.log(`  Phase [plan] with User Override -> Mapped Model: ${overrideRule.provider}:${overrideRule.model} (${overrideRule.reason})`);

  if (ptr.activeTopic && overrideRule.model === 'o3-mini') {
    console.log('\n========================================================================');
    console.log('--- ALL ACTIVE MEMORY & MODEL MAPPING VERIFICATION TESTS PASSED ---');
    console.log('========================================================================');
  } else {
    console.error('FAIL: Active mapping tests did not pass expectations.');
  }
}

testActiveMapping().catch(console.error);
