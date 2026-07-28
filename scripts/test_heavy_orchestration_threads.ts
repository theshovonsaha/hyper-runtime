import { ThreadedMemoryStore, DynamicTeamOrchestrator } from '../src/modules';

async function testHeavyOrchestrationAndThreads() {
  console.log('========================================================================');
  console.log('--- HEAVY FLOW TEST: THREADED MEMORY NETWORK & DYNAMIC TEAM ORCHESTRATION ---');
  console.log('========================================================================');

  // --- 1. Test Threaded Memory Network (Thread-of-Threads Architecture) ---
  console.log('\n[Part 1] Testing Threaded Memory Network (Thread-of-Threads)...');
  const memStore = new ThreadedMemoryStore();

  // Create parent thread
  const parentThread = memStore.createThread('Architecture & System Specs');
  console.log('  Created Parent Thread:', parentThread.title, `(${parentThread.threadId})`);

  // Create nested sub-thread
  const subThread = memStore.createThread('Database & WAL Configurations', parentThread.threadId);
  console.log('  Created Nested Sub-Thread:', subThread.title, `(Parent: ${subThread.parentThreadId})`);

  // Push nodes
  const n1 = memStore.pushNode(parentThread.threadId, 'Use 8-lane ContextAssembler for token capping.', ['context']);
  const n2 = memStore.pushNode(subThread.threadId, 'Use bun:sqlite in WAL mode with foreign keys enabled.', ['sqlite', 'wal']);
  const n3 = memStore.pushNode(subThread.threadId, 'AES-256 encrypted credentials storage.', ['crypto']);

  console.log(`  Pushed 3 nodes across parent and sub-threads.`);

  // Update node
  if (n2) {
    memStore.updateNode(subThread.threadId, n2.nodeId, 'Use bun:sqlite in WAL mode with foreign keys ON for 10x throughput.');
    console.log('  Updated Node Content:', memStore.pullThread(subThread.threadId)?.nodes[0].content);
  }

  // Dig Thread Graph (Jaccard similarity search)
  const dugNodes = memStore.digThreadGraph('sqlite WAL throughput', 5);
  console.log('  Dug Thread Graph Nodes Found:', dugNodes.length);
  console.log('  Dug Top Match:', dugNodes[0]?.content);

  // Delete node
  if (n3) {
    const deleted = memStore.deleteNode(subThread.threadId, n3.nodeId);
    console.log('  Deleted Node Operation Status:', deleted);
  }

  // --- 2. Test Dynamic Intent-Driven Team Orchestrator ---
  console.log('\n[Part 2] Testing Dynamic Intent-Driven Multi-Agent Team Orchestrator...');
  const orchestrator = new DynamicTeamOrchestrator();

  const complexPrompt = 'Research competitor APIs, write a TypeScript script, fetch AAPL stock ticker metrics, and verify security coverage.';
  const orchRes = orchestrator.orchestrateTeam(complexPrompt);

  console.log('  Detected Prompt Intents:', orchRes.detectedIntents);
  console.log('  Assigned Sub-Agent Team Members:', orchRes.assignedAgents.map(a => a.role));
  console.log('  Orchestrated Team ID:', orchRes.teamId);

  if (dugNodes.length > 0 && orchRes.assignedAgents.length >= 4) {
    console.log('\n========================================================================');
    console.log('--- ALL HEAVY THREAD & TEAM ORCHESTRATION VERIFICATION TESTS PASSED ---');
    console.log('========================================================================');
  } else {
    console.error('FAIL: Heavy orchestration tests did not pass expectations.');
  }
}

testHeavyOrchestrationAndThreads().catch(console.error);
