import { SelfEvolvingCodeEngine } from '../src/modules';
import { ToolRegistry } from '../src/tools/registry';

async function testProactiveSelfEvolvingEngine() {
  console.log('========================================================================');
  console.log('--- PROACTIVE SELF-EVOLVING CODE & HOT-RELOADING VERIFICATION ---');
  console.log('========================================================================');

  const registry = new ToolRegistry();
  const evolvingEngine = new SelfEvolvingCodeEngine();

  // 1. Proactively Synthesize and Hot-Reload New Tool into Live Registry
  console.log('\n[Part 1] Proactively Synthesizing & Hot-Reloading New Tool in Live Registry...');
  const synthesizedTool = evolvingEngine.hotReloadSynthesizedTool(registry, {
    requestedCapability: 'Hypersonic Data Processing',
    functionName: 'process_hypersonic_data',
    description: 'Process hypersonic telemetry stream data dynamically.',
  });

  console.log('  Hot-Reloaded Tool Name:', synthesizedTool.name);
  console.log('  Registered Tools Count:', registry.size);

  // 2. Execute Hot-Reloaded Tool
  console.log('\n[Part 2] Executing Hot-Reloaded Tool in Live Registry...');
  const fetchedTool = registry.get('process_hypersonic_data')!;
  const execRes = await fetchedTool.execute({ inputData: 'Mach 5 Telemetry Stream OK' }, {} as any);

  console.log('  Execution Result Success:', execRes.success);
  console.log('  Output Content:', execRes.content);

  if (registry.size === 1 && execRes.success && execRes.content.includes('Mach 5 Telemetry Stream OK')) {
    console.log('\n========================================================================');
    console.log('--- PROACTIVE SELF-EVOLVING CODE ENGINE VERIFIED (100% SUCCESS) ---');
    console.log('========================================================================');
  } else {
    console.error('FAIL: Self-evolving code engine test failed.');
  }
}

testProactiveSelfEvolvingEngine().catch(console.error);
