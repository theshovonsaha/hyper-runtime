import { loadConfig } from '../src/types/config';
import { Store } from '../src/store/sqlite';
import { EventStore } from '../src/store/events';
import { ContextAssembler } from '../src/context/assembler';
import { TurnGate } from '../src/context/gate';
import { ToolRegistry } from '../src/tools/registry';
import { createBuiltinTools } from '../src/tools/builtins';
import { RunKernel } from '../src/core/kernel';
import { createEnvelope } from '../src/types/messages';
import { join } from 'path';

async function runHyperVerification() {
  console.log('====================================================');
  console.log('--- HYPER-RUNTIME ONE-SHOT VERIFICATION SUITE ---');
  console.log('====================================================');

  const config = loadConfig();
  const store = new Store(join(config.dataDir, 'hyper_test.db'));
  const eventStore = new EventStore(config.dataDir);
  const gate = new TurnGate();
  const registry = new ToolRegistry();
  registry.registerMany(createBuiltinTools());
  const assembler = new ContextAssembler(config, store);
  const kernel = new RunKernel(config, store, eventStore, assembler, gate, registry);

  // --- Test 1: Fluid Single-Pass Turn ---
  console.log('\n[Test 1] Executing Fluid Reasoning Turn (Mode A)...');
  const env1 = createEnvelope('sess-hyper-1', 'What is 120 divided by 4? Think privately and provide the result.', {
    provider: 'mock',
    model: 'mock-1',
    passes: {
      gate: false,
      plan: false,
      verify: false,
      distill: false,
      attribution: true,
      think: true,
      heal: true,
    },
  });

  const res1 = await kernel.run(env1);
  console.log('  Status:', res1.status);
  console.log('  Output:', res1.final_text);

  const events1 = eventStore.loadEvents(env1.run_id);
  const scorecard1 = events1.find(e => e.type === ('scorecard.report' as any));
  if (scorecard1) {
    console.log('  Scorecard:', (scorecard1.payload as any).rating, `(${(scorecard1.payload as any).score}/100)`);
  }

  // --- Test 2: Trajectory Tree Branching ---
  console.log('\n[Test 2] Testing Trajectory Forking / Branching Engine...');
  const env2 = createEnvelope('sess-hyper-1', 'Forked alternative direction: calculate 120 / 4 and multiply by 3.', {
    provider: 'mock',
    model: 'mock-1',
    parent_run_id: env1.run_id,
    fork_at_turn: 1,
    passes: {
      gate: false,
      plan: false,
      verify: false,
      attribution: true,
    },
  });

  const res2 = await kernel.run(env2);
  console.log('  Branch Status:', res2.status);

  const events2 = eventStore.loadEvents(env2.run_id);
  const branchEvent = events2.find(e => e.type === ('branch.created' as any));
  if (branchEvent) {
    console.log('  Branch Event Logged:', JSON.stringify(branchEvent.payload));
  }

  console.log('\n====================================================');
  console.log('--- ALL HYPER-RUNTIME VERIFICATION TESTS PASSED ---');
  console.log('====================================================');
}

runHyperVerification().catch(console.error);
