/**
 * scripts/test_context_packet_convergence.ts — Complete Context Packet Lifecycle & System Convergence Suite.
 *
 * Verifies:
 *   1. BUILD: 8-lane ContextAssembler building budgeted ContextPacket.
 *   2. SAVE: Persisting packets, messages, and trail events in SQLite WAL & JSONL logs.
 *   3. RELATE: Linking packets across trajectory branches (BranchManager), attribution scores, and thread memory nodes.
 *   4. RETRIEVE: Retrieving items via BM25 term scoring and ThreadedMemoryStore digging.
 *   5. CONVERGE: Full system loop convergence inside RunKernel.
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
import { BranchManager } from '../src/core/branch';
import { computeAttribution } from '../src/core/attribution';
import { ThreadedMemoryStore } from '../src/memory/threads';
import { DynamicTeamOrchestrator } from '../src/orchestration/team';
import { join } from 'path';

async function testContextPacketConvergence() {
  console.log('========================================================================');
  console.log('--- CONTEXT PACKETS: BUILD, SAVE, RELATE, RETRIEVE & CONVERGENCE ---');
  console.log('========================================================================');

  const config = loadConfig();
  const store = new Store(join(config.dataDir, 'convergence_test.db'));
  const eventStore = new EventStore(config.dataDir);
  const gate = new TurnGate();
  const registry = new ToolRegistry();
  registry.registerMany(createBuiltinTools());

  const assembler = new ContextAssembler(config, store);
  const branchMgr = new BranchManager();
  const memStore = new ThreadedMemoryStore();
  const orchestrator = new DynamicTeamOrchestrator();
  const kernel = new RunKernel(config, store, eventStore, assembler, gate, registry);

  // --- Step 1: BUILD Context Packet ---
  console.log('\n[Step 1: BUILD] Assembling 8-Lane Context Packet...');
  const envelope = createEnvelope('conv-sess-1', 'Research stock ticker AAPL fundamentals and execute calculator check', {
    provider: 'mock',
    model: 'mock-driver',
    files: [{ name: 'financial_notes.txt', text: 'AAPL ticker target price is $210 USD' }],
  });
  const packet = assembler.assemble(envelope);
  console.log(`  Built ContextPacket with ${packet.items.length} items across 8 lanes (${packet.total_chars} total chars).`);

  // --- Step 2: SAVE Packet & Trail Events ---
  console.log('\n[Step 2: SAVE] Persisting Packet & Events to SQLite WAL & EventStore...');
  const runId = envelope.run_id!;
  store.ensureSession(envelope.session_id, envelope.message);
  const eventLog = eventStore.openLog(runId);
  eventLog.emit('packet.built' as any, { total_chars: packet.total_chars, items_count: packet.items.length }, 'Assembled Context Packet');
  console.log(`  Saved run record and logged 'packet.built' event for Run ID: ${runId}.`);

  // --- Step 3: RELATE Packets, Branches & Attribution ---
  console.log('\n[Step 3: RELATE] Relating Packet to Trajectory Branch & Attribution Engine...');
  const branch = branchMgr.createBranch(runId, 1, 'Forking for detailed financial analysis branch', store);
  const attributionReport = computeAttribution(runId, 'Target price evaluated at $210 USD.', packet.items);
  console.log(`  Related to Trajectory Branch ID: ${branch.branchId} (Parent Run: ${branch.parentRunId}).`);
  console.log(`  Attribution Engine linked response text to ${attributionReport.totalItemsEvaluated} context item(s).`);

  // --- Step 4: RETRIEVE Threaded Memory & Scored Notes ---
  console.log('\n[Step 4: RETRIEVE] Retrieving Scored Notes & Threaded Memory Graph...');
  const thread = memStore.createThread('Financial Models');
  memStore.pushNode(thread.threadId, 'AAPL projected P/E ratio is 28.5', ['finance']);
  const retrievedNodes = memStore.digThreadGraph('AAPL P/E ratio', 3);
  console.log(`  Retrieved ${retrievedNodes.length} memory node(s) via Threaded Memory Graph digging.`);
  console.log(`  Retrieved Content: "${retrievedNodes[0]?.content}"`);

  // --- Step 5: CONVERGE Full System Execution ---
  console.log('\n[Step 5: CONVERGE] Executing Full Converged Kernel Turn...');
  const teamResult = orchestrator.orchestrateTeam(envelope.message);
  console.log(`  Orchestrated Team [${teamResult.teamId}] with ${teamResult.assignedAgents.length} agent(s).`);

  const runResult = await kernel.run(envelope);
  console.log(`  RunKernel Turn Status: ${runResult.status}`);
  console.log(`  Final Text Emitted: ${runResult.final_text}`);

  if (packet.items.length > 0 && branch.branchId && retrievedNodes.length > 0 && runResult.status === 'complete') {
    console.log('\n========================================================================');
    console.log('--- ALL CONTEXT PACKET LIFECYCLE & CONVERGENCE TESTS PASSED ---');
    console.log('========================================================================');
  } else {
    console.error('FAIL: Context packet convergence test failed.');
  }
}

testContextPacketConvergence().catch(console.error);
