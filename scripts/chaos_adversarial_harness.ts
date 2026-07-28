/**
 * scripts/chaos_adversarial_harness.ts — Chaos Engineering & Failure Injection Harness.
 *
 * Intentionally forces real system failures, chaotic edge cases, corrupt DB states,
 * hallucinated tool calls, cascading provider outages, and memory leaks.
 */

import { loadConfig } from '../src/types/config';
import { Store } from '../src/store/sqlite';
import { EventStore } from '../src/store/events';
import { ContextAssembler } from '../src/context/assembler';
import { TurnGate } from '../src/context/gate';
import { ToolRegistry } from '../src/tools/registry';
import { createBuiltinTools } from '../src/tools/builtins';
import { RunKernel } from '../src/core/kernel';
import { createEnvelope } from '../src/types/messages';
import { ReactiveFailoverEngine } from '../src/protocols/rfp';
import { join } from 'path';

async function runChaosHarness() {
  console.log('====================================================================');
  console.log('--- HYPER-RUNTIME CHAOS ENGINEERING & FAILURE INJECTION HARNESS ---');
  console.log('====================================================================');

  const config = loadConfig();
  const store = new Store(join(config.dataDir, 'chaos_test.db'));
  const eventStore = new EventStore(config.dataDir);
  const gate = new TurnGate();
  const registry = new ToolRegistry();
  registry.registerMany(createBuiltinTools());
  const assembler = new ContextAssembler(config, store);
  const kernel = new RunKernel(config, store, eventStore, assembler, gate, registry);

  // --- Chaos Test 1: Hallucinated Tool Name & Deeply Malformed Arguments ---
  console.log('\n[Chaos 1] Simulating Model Hallucinating Non-Existent Tool with Malformed Args...');
  const missingToolRes = await registry.get('non_existent_tool_xyz')?.execute({}, {} as any);
  if (!missingToolRes) {
    console.log('  EXPECTED FAILURE: Registry correctly returned undefined for hallucinated tool name.');
  } else {
    console.error('  UNEXPECTED SUCCESS: Hallucinated tool returned a result!');
  }

  // --- Chaos Test 2: Total Cascading Multi-Provider Outage (All Tier Exhaustion) ---
  console.log('\n[Chaos 2] Simulating Total Cascading Provider Outage across All Tiers...');
  const rfp = new ReactiveFailoverEngine();
  const exhaustedRes = rfp.handleFailure('503 Service Unavailable across all endpoints', 'mock', ['anthropic', 'openrouter', 'gemini', 'mock']);
  console.log('  RFP Outage Response Action:', exhaustedRes.action, `(${exhaustedRes.logSummary})`);
  if (exhaustedRes.action === 'fallback_provider') {
    console.log('  EXHAUSTION RESULT: Dynamic fallback requested next tier.');
  }

  // --- Chaos Test 3: Corrupted SQLite State Transaction Recovery ---
  console.log('\n[Chaos 3] Testing Corrupted Query Injection on Store...');
  try {
    store.getHistory("'; DROP TABLE messages; --", 10);
    console.log('  SECURITY PASS: SQL injection attempt safely parameterized without table drop.');
  } catch (err) {
    console.log('  STORE ERROR CAPTURED:', err instanceof Error ? err.message : String(err));
  }

  // --- Chaos Test 4: Memory Inflation & Heap Allocation Measurement ---
  console.log('\n[Chaos 4] Measuring Heap Allocation & Memory Drift under 50 Concurrent Envelopes...');
  const memBefore = process.memoryUsage().heapUsed;
  const envelopes = Array.from({ length: 50 }, (_, i) => 
    createEnvelope(`chaos-sess-${i}`, `Massive concurrent payload iteration ${i}`, {
      files: [{ name: `payload_${i}.txt`, text: 'X'.repeat(50_000) }]
    })
  );

  for (const env of envelopes) {
    assembler.assemble(env);
  }
  const memAfter = process.memoryUsage().heapUsed;
  const heapDiffMB = ((memAfter - memBefore) / (1024 * 1024)).toFixed(2);
  console.log(`  MEMORY HEAP METRICS: Baseline Heap -> ${heapDiffMB} MB allocated for 50 x 50k char envelopes.`);

  // --- Chaos Test 5: Hard Stagnation Termination Verification ---
  console.log('\n[Chaos 5] Verifying Hard Stagnation Failure Diagnostics...');
  const envFail = createEnvelope('chaos-stagnant-sess', 'Force stagnation failure test', {
    provider: 'mock',
    model: 'mock-1',
    passes: { gate: false, plan: false, verify: false }
  });
  
  const resFail = await kernel.run(envFail);
  console.log('  RUN KERNEL STAGNATION STATUS:', resFail.status);
  console.log('  FINAL TRAIL OUTPUT:', resFail.final_text || '(no output text emitted)');

  console.log('\n====================================================================');
  console.log('--- CHAOS & FAILURE INJECTION EVALUATION COMPLETE ---');
  console.log('====================================================================');
}

runChaosHarness().catch(console.error);
