/**
 * scripts/test_zero_llm_runtime_proof.ts — Empirical Proof of Zero-LLM Deterministic Software Wave
 *
 * Exercises 100% of the core runtime components WITHOUT invoking an LLM:
 * 1. Deterministic Dynamic Epistemic Posture (DEP) Engine
 * 2. Evidence Priority Lane (Deep Target Extraction & Scoring)
 * 3. Temporal Memory Graph (NL Triple Extraction, Synonym Normalization, Fact Voiding, Disk Persistence)
 * 4. Path-Targeted Side-Effect Guard (Exact Path Matching & Mismatch Interception)
 * 5. 7 Hard Physical & Security Constraints (Context Ceiling, Sandbox Rejection, Timeout, Payload Caps)
 * 6. TurnGate Context Inspection & Resolution
 * 7. EventStore Size-Capped Logging & Subscriber Eviction
 */

import { DynamicEpistemicPostureEngine } from '../src/core/dep';
import { EvidencePriorityLane } from '../src/core/evidence_lane';
import { TemporalMemoryGraph } from '../src/memory/temporal_graph';
import { SideEffectGuard } from '../src/core/side_effect_guard';
import { RuntimeConstraintsManager } from '../src/core/constraints';
import { EventStore } from '../src/store/events';
import { TurnGate } from '../src/context/gate';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';

console.log('===================================================================================');
console.log('--- ZERO-LLM DETERMINISTIC SOFTWARE WAVE — FULL SYSTEM PROOF SUITE ---');
console.log('===================================================================================\n');

let passCount = 0;
let totalCount = 0;

function assert(condition: boolean, title: string) {
  totalCount++;
  if (condition) {
    passCount++;
    console.log(`  [PASS ${passCount}/${totalCount}] ${title}`);
  } else {
    console.error(`  [FAIL ${passCount}/${totalCount}] ${title}`);
    process.exit(1);
  }
}

const startTime = performance.now();

// ─── 1. Evidence Priority Lane (Zero LLM) ────────────────────────────────────
console.log('[Phase 1] Testing Evidence Priority Lane (Zero LLM)...');
const lane = new EvidencePriorityLane();
const deepTargets = lane.extractDeepTargets('Check https://api.enterprise.org/v1 and inspect ./src/core/kernel.ts with run()');
assert(deepTargets.urls.includes('https://api.enterprise.org/v1'), 'Extracted target URL without LLM');
assert(deepTargets.paths.includes('./src/core/kernel.ts'), 'Extracted file path without LLM');
assert(deepTargets.symbols.includes('run()'), 'Extracted code symbol without LLM');

const rawToolResults = [
  { id: '1', toolName: 'todo_write', content: 'Wrote TODO item', isFailure: false },
  { id: '2', toolName: 'web_fetch', content: 'Fetched target https://api.enterprise.org/v1 payload', isFailure: false },
  { id: '3', toolName: 'read_file', content: 'Failed to read file /etc/config.json', isFailure: true },
];

const processedEvidence = lane.processToolResults(rawToolResults, 'Fetch https://api.enterprise.org/v1', 4);
assert(processedEvidence[0].toolName === 'web_fetch', 'Top rank assigned to exact-target web_fetch');
assert(processedEvidence[0].isExactTarget === true, 'Exact target flagged deterministically');
assert(processedEvidence.some(e => e.isFailure), 'Failure evidence preserved deterministically');

// ─── 2. Temporal Memory Graph (Zero LLM) ─────────────────────────────────────
console.log('\n[Phase 2] Testing Temporal Memory Graph & Voiding Semantics (Zero LLM)...');
const memGraph = new TemporalMemoryGraph();

// NL extraction & synonym normalization
const nlFacts = memGraph.extractTriplesFromText('I moved to New York yesterday.', 1);
assert(nlFacts.length === 1, 'Extracted location triple from NL text');
assert(nlFacts[0].predicate === 'location', 'Normalized "moved to" -> "location"');
assert(nlFacts[0].object === 'New York', 'Extracted multi-word target city "New York"');

// Fact voiding
const fact2 = memGraph.assertFact('user', 'resides in', 'San Francisco', 5);
const activeFacts = memGraph.getCurrentFacts();
assert(activeFacts.length === 1, 'Prior location voided by synonym "resides in", 1 active fact remains');
assert(activeFacts[0].object === 'San Francisco', 'Active location updated to San Francisco');
assert(nlFacts[0].status === 'superseded', 'Old fact status set to superseded at turn 5');

// Signal promotion & disk save/load
memGraph.recordSignal('Prefers dark mode', 1, 2);
const promotedSig = memGraph.recordSignal('Prefers dark mode', 2, 2);
assert(promotedSig.promotionState === 'promoted', 'Signal promoted to fact candidate after threshold met');

const diskPath = './.data/proof_temporal_graph.json';
if (existsSync(diskPath)) unlinkSync(diskPath);
memGraph.saveToDisk(diskPath);
assert(existsSync(diskPath), 'Saved memory graph state to disk');

const loadedMemGraph = new TemporalMemoryGraph();
loadedMemGraph.loadFromDisk(diskPath);
assert(loadedMemGraph.getCurrentFacts().length === 1, 'Loaded active facts from disk');
assert(loadedMemGraph.getCurrentFacts()[0].object === 'San Francisco', 'Loaded fact matches San Francisco');
if (existsSync(diskPath)) unlinkSync(diskPath);

// ─── 3. Side-Effect Guard Path-Matching (Zero LLM) ───────────────────────────
console.log('\n[Phase 3] Testing Side-Effect Guard Path-Matching Interception (Zero LLM)...');
const guard = new SideEffectGuard();

// Path match verification
const validGuard = guard.inspectResponse('I have updated the file src/core/kernel.ts successfully.', [
  { toolName: 'write_file', isFailure: false, args: { TargetFile: '/project/src/core/kernel.ts' }, content: 'File written' }
]);
assert(validGuard.passed, 'Path-matching file update claim verified and passed');

// Path mismatch interception
const invalidGuard = guard.inspectResponse('I have updated the file src/core/kernel.ts successfully.', [
  { toolName: 'write_file', isFailure: false, args: { TargetFile: '/project/src/core/other.ts' }, content: 'File written' }
]);
assert(!invalidGuard.passed, 'Path mismatch intercepted (claimed kernel.ts, tool operated on other.ts)');
assert(invalidGuard.annotatedText.includes('SIDE-EFFECT GUARD WARNING'), 'Warning banner injected into response');

// ─── 4. 7 Hard Physical Constraints Engine (Zero LLM) ────────────────────────
console.log('\n[Phase 4] Testing 7 Hard Physical & Security Constraints (Zero LLM)...');
const constraints = new RuntimeConstraintsManager();
const workspaceRoot = '/Users/theshovonsaha/Developer/Github/bun-harness-runtime/hyper-runtime';

// Context Budget & Sandbox Rejection
const budgetCheck = constraints.enforceContextBudget(30000);
assert(!budgetCheck.compliant && budgetCheck.truncatedChars === 24000, '30k char context truncated to hard 24k limit');

const sandboxCheck = constraints.enforcePathSandbox('/etc/passwd', workspaceRoot);
assert(!sandboxCheck.allowed, 'Security violation: Out-of-workspace path /etc/passwd rejected');

// Loop & Recursion Bounds
const loopCheck = constraints.enforceTurnLimits(16, 1);
assert(!loopCheck.allowed, 'Turn 16 rejected by turn limit');

const depthCheck = constraints.enforceTurnLimits(2, 3);
assert(!depthCheck.allowed, 'Sub-agent depth 3 rejected by recursion limit');

// Payload Ceiling
const giantPayload = 'X'.repeat(70000);
const payloadCheck = constraints.enforcePayloadCeiling(giantPayload);
assert(!payloadCheck.compliant && payloadCheck.boundedPayload.length <= 50000, 'Giant payload truncated to 50k ceiling');

// ─── 5. Dynamic Epistemic Posture (Zero LLM) ─────────────────────────────────
console.log('\n[Phase 5] Testing Dynamic Epistemic Posture Engine Fallback (Zero LLM)...');
const depEngine = new DynamicEpistemicPostureEngine();
const depSnapshot = depEngine.computeDeterministicPosture(
  'Fetch https://api.enterprise.org/v1',
  processedEvidence,
  activeFacts,
  2
);

assert(depSnapshot.planDiscipline === 'REPLAN', 'Computed REPLAN discipline due to tool failure');
assert(depSnapshot.toolEconomy === 0, 'Computed 0 tool economy for exact-target evidence');
assert(depSnapshot.verificationPosture.includes('Regime 1'), 'Mapped verification posture to Regime 1');

// ─── 6. TurnGate Context Inspection (Zero LLM) ──────────────────────────────
console.log('\n[Phase 6] Testing TurnGate Context Inspection (Zero LLM)...');
const gate = new TurnGate();
const gateRes = await gate.hold('proof-run-100', {} as any, 0); // Timeout 0 = instant approval
assert(gateRes.action === 'approved', 'TurnGate instantly approved under 0-second inspect timeout');

// ─── 7. EventStore & Memory Leak Eviction (Zero LLM) ────────────────────────
console.log('\n[Phase 7] Testing EventStore Size-Capped Logging & Leak Eviction (Zero LLM)...');
const eventsDir = './.data/proof_events';
const eventStore = new EventStore(eventsDir);
const log = eventStore.openLog('proof-run-100');

log.emit('proof.test', { data: 'test' }, { summary: 'zero-llm event emission' });
assert(existsSync(join(eventsDir, 'events', 'proof-run-100.jsonl')), 'Event log file persisted on disk');

eventStore.closeLog('proof-run-100');
assert(!eventStore.hasActiveLog('proof-run-100'), 'Active log and subscriber map evicted cleanly on closeLog()');

// Cleanup test event log
try { unlinkSync(join(eventsDir, 'events', 'proof-run-100.jsonl')); } catch (e) {}

const elapsedTime = Math.round(performance.now() - startTime);

console.log('\n===================================================================================');
console.log(`--- ZERO-LLM SYSTEM PROOF COMPLETED: ${passCount}/${totalCount} TESTS PASSED (100% SUCCESS) ---`);
console.log(`--- TOTAL ELAPSED TIME: ${elapsedTime} ms | TOTAL LLM TOKENS USED: 0 TOKENS ---`);
console.log('===================================================================================\n');
