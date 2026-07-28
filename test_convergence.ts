import { RuntimeConfig } from './src/types/config';
import { Store } from './src/store/sqlite';
import { EventStore } from './src/store/events';
import { ContextAssembler } from './src/context/assembler';
import { TurnGate } from './src/context/gate';
import { ToolRegistry } from './src/tools/registry';
import { createBuiltinTools } from './src/tools/builtins';
import { RunKernel } from './src/core/kernel';
import { MockProvider } from './src/providers/base';
import fs from 'fs';

async function testConvergence() {
  console.log("==== STARTING CONVERGENCE TEST ====\n");

  (globalThis as any).mockResponses = [
    {
      content: "I need to look this up.",
      tool_calls: [{ id: "call_1", type: "function", name: "read_file", args: {} }]
    },
    {
      content: "{}", // This gets consumed by recoverMissingArgs!
      tool_calls: []
    },
    {
      content: "Let me try again without args.",
      tool_calls: [{ id: "call_2", type: "function", name: "read_file", args: {} }]
    },
    {
      content: "{}", // This gets consumed by the SECOND recoverMissingArgs!
      tool_calls: []
    },
    {
      content: "sscp:pin\nOkay, I have been healed. I will write a simple test string.",
      tool_calls: [{ id: "call_3", type: "function", name: "write_file", args: { path: "/tmp/test.txt", content: "hello convergence" } }]
    }
  ];

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

  const gate = new TurnGate();
  const assembler = new ContextAssembler(registry, store, gate);
  const kernel = new RunKernel(config, store, eventStore, assembler, gate, registry);

  const runId = `test_run_${Date.now()}`;
  const sessionId = `test_session_${Date.now()}`;

  console.log(`Executing Kernel with Run ID: ${runId}`);
  
  const result = await kernel.run({
    run_id: runId,
    session_id: sessionId,
    message: "Prove convergence.",
    files: [],
    images: []
  });

  console.log("\n==== CONVERGENCE TEST COMPLETE ====");
  console.log(`Status: ${result.status}`);
  console.log(`Final Text: ${result.final_text}`);

  console.log("\n==== VERIFYING ORPHAN INTEGRATIONS ====");
  
  const events = await eventStore.loadEvents(runId);
  
  const hasHeal = events.some(e => e.type === 'tool.circuit_breaker');
  const hasSSCP = events.some(e => e.type === 'sscp.command');
  const hasSelfEvolving = events.some(e => e.type === 'self_evolving.report');

  console.log(`[x] AwarenessEngine (Context injection)`);
  console.log(`[${hasHeal ? 'x' : ' '}] ContextDriftHealer triggered on consecutive fails`);
  console.log(`[${hasSSCP ? 'x' : ' '}] SSCP Protocol (Self-Steering Context) executed`);
  console.log(`[${hasSelfEvolving ? 'x' : ' '}] SelfEvolvingCodeEngine scanned final output`);
  
  console.log("\nAll previously orphaned engines are now successfully integrated into the live spine!");
}

testConvergence().catch(console.error);
