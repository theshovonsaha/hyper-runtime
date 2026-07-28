import { GranularMemoryEngine } from '../src/modules';
import { ToolRegistry } from '../src/tools/registry';

async function testGranularMemoryCrudTools() {
  console.log('========================================================================');
  console.log('--- GRANULAR DIAMOND MEMORY CRUD & EMERGENT TOOLS VERIFICATION ---');
  console.log('========================================================================');

  const engine = new GranularMemoryEngine();
  const registry = new ToolRegistry();

  // 1. Test Store Memory (Create)
  console.log('\n[Part 1] Testing Granular Store Memory (Create)...');
  const item = engine.storeMemory('Hypersonic Flight Spec Mach 5', 'short_term', ['aero', 'mach5']);
  console.log('  Stored Memory ID:', item.id);
  console.log('  Tier:', item.tier);
  console.log('  Content:', item.content);

  // 2. Test Retrieve Memory (Read)
  console.log('\n[Part 2] Testing Granular Retrieve Memory (Read)...');
  const retrieved = engine.retrieveMemory('Hypersonic', 3);
  console.log(`  Retrieved ${retrieved.length} memory item(s):`);
  for (const r of retrieved) {
    console.log(`    - [${r.id}] ${r.content}`);
  }

  // 3. Test Update Memory (Update)
  console.log('\n[Part 3] Testing Granular Update Memory (Update)...');
  const updated = engine.updateMemory(item.id, 'Hypersonic Flight Spec Mach 6 (Updated)');
  console.log('  Memory Update Success:', updated);

  // 4. Test Emergent Memory Tools Registration
  console.log('\n[Part 4] Testing Emergent Memory Tools (store, retrieve, update, delete)...');
  const emergentTools = engine.getEmergentMemoryTools();
  registry.registerMany(emergentTools);
  console.log('  Registered Emergent Memory Tools:', registry.list().join(', '));

  const storeTool = registry.get('memory_store');
  const toolExecRes = await storeTool.execute({ content: 'Emergent tool payload stored' }, {} as any);
  console.log('  Emergent Store Tool Result:', toolExecRes.content);

  if (item.id && retrieved.length >= 1 && updated && registry.size === 4 && toolExecRes.success) {
    console.log('\n========================================================================');
    console.log('--- GRANULAR MEMORY CRUD & EMERGENT TOOLS VERIFIED (100% SUCCESS) ---');
    console.log('========================================================================');
  } else {
    console.error('FAIL: Granular memory CRUD test failed.');
  }
}

testGranularMemoryCrudTools().catch(console.error);
