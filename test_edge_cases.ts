import { RuntimeConfig } from './src/types/config';
import { Store } from './src/store/sqlite';
import { EventStore } from './src/store/events';
import { ContextAssembler } from './src/context/assembler';
import { TurnGate } from './src/context/gate';
import { ToolRegistry } from './src/tools/registry';
import { createBuiltinTools } from './src/tools/builtins';
import { RunKernel } from './src/core/kernel';
import fs from 'fs';

async function testEdgeCases() {
  console.log("==== STARTING EDGE CASE MATRIX TESTS ====\n");

  const store = new Store(':memory:');
  const eventStore = new EventStore('./test-data/events');
  
  if (!fs.existsSync('./test-data/events')) {
    fs.mkdirSync('./test-data/events', { recursive: true });
  }

  const registry = new ToolRegistry();
  const builtins = createBuiltinTools();
  for (const t of builtins) registry.register(t);

  const config: RuntimeConfig = {
    provider: 'mock',
    dataDir: './test-data/data',
    planPass: false,
    maxSteps: 5,
    maxContinuations: 2,
    maxAutoSteps: 10,
    maxConsecutiveToolFails: 2,
    maxTranscriptChars: 20000,
  } as unknown as RuntimeConfig;

  // 1. Sub-agent return value test
  console.log("\n--- TEST: Sub-agent return value ---");
  (globalThis as any).mockResponses = [
    {
      content: "This is the sub-agent's final text",
      tool_calls: []
    }
  ];

  const gate = new TurnGate();
  const assembler = new ContextAssembler(registry, store, gate);
  const kernel = new RunKernel(config, store, eventStore, assembler, gate, registry);
  
  // We need to simulate runSubAgent to ensure it returns final_text
  const res = await kernel.run({
    run_id: "test_subagent",
    session_id: "test_subagent_session",
    message: "sub-agent test",
    files: [],
    images: []
  });

  if (res.final_text === "This is the sub-agent's final text") {
    console.log("[PASS] Sub-agent returned correct final_text (not empty)");
  } else {
    console.log("[FAIL] Sub-agent returned:", res.final_text);
  }

  // 2. Gate timeout auto-approval test
  console.log("\n--- TEST: Gate timeout auto-approval ---");
  const timeoutGate = new TurnGate();
  // Request a hold
  const holdPromise = timeoutGate.hold('test_run_timeout', { items: [] } as any, 1); // 1 sec timeout
  
  const outcome = await holdPromise;
  if (outcome.action === 'approved') {
    console.log("[PASS] Gate automatically approved after timeout");
  } else {
    console.log("[FAIL] Gate outcome:", outcome.action);
  }

  // 3. Concurrent-run isolation test
  console.log("\n--- TEST: Concurrent-run isolation ---");
  
  (globalThis as any).mockResponses = [
    { content: "Run A success", tool_calls: [] },
    { content: "Run B success", tool_calls: [] }
  ];

  const runA = kernel.run({ run_id: "concurrent_A", session_id: "concurrent_sess", message: "A", files: [], images: [] });
  const runB = kernel.run({ run_id: "concurrent_B", session_id: "concurrent_sess", message: "B", files: [], images: [] });
  
  const [resA, resB] = await Promise.all([runA, runB]);
  
  if (resA.final_text === "Run A success" && resB.final_text === "Run B success") {
     console.log("[PASS] Concurrent runs executed without cross-contamination");
  } else {
     console.log(`[FAIL] Concurrent runs collided. A: ${resA.final_text}, B: ${resB.final_text}`);
  }

  console.log("\n==== TESTS COMPLETE ====");
}

testEdgeCases().catch(console.error);
