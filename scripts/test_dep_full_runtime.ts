/**
 * scripts/test_dep_full_runtime.ts — Deep Production Verification for DEP Engine & Governance Runtime
 */

import { EvidencePriorityLane } from '../src/core/evidence_lane';
import { TemporalMemoryGraph } from '../src/memory/temporal_graph';
import { SideEffectGuard } from '../src/core/side_effect_guard';
import { DynamicEpistemicPostureEngine } from '../src/core/dep';
import { unlinkSync, existsSync } from 'fs';

console.log('========================================================================');
console.log('--- PRODUCTION DYNAMIC EPISTEMIC POSTURE (DEP) & GOVERNANCE SUITE ---');
console.log('========================================================================\n');

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

// 1. Evidence Priority Lane Test
console.log('[Test 1] Evidence Priority Lane Deep Extraction & Scoring...');
const lane = new EvidencePriorityLane();
const rawResults = [
  { id: '1', toolName: 'todo_update', content: 'Updated item status', isFailure: false },
  { id: '2', toolName: 'web_fetch', content: 'Fetched https://example.com/api target data', isFailure: false },
  { id: '3', toolName: 'file_view', content: 'Failed to read file /etc/config.json', isFailure: true },
  { id: '4', toolName: 'query_memory', content: 'Retrieved memory fact', isFailure: false },
];

const processed = lane.processToolResults(rawResults, 'Fetch data from example.com/api and inspect /etc/config.json', 4);
assert(processed[0].toolName === 'web_fetch', 'Highest priority assigned to exact-target web_fetch');
assert(processed[0].isExactTarget === true, 'Exact target detected correctly');
assert(processed.some(p => p.isFailure), 'Failure result retained in priority set');

// Deep Extraction check
const deepTargets = lane.extractDeepTargets('Check https://api.site.com/v1 and inspect ./src/index.ts with main()');
assert(deepTargets.urls.includes('https://api.site.com/v1'), 'URL target extracted');
assert(deepTargets.paths.includes('./src/index.ts'), 'File path target extracted');
assert(deepTargets.symbols.includes('main()'), 'Code symbol target extracted');

// 2. Temporal Memory Graph Voiding & NL Extraction Test
console.log('\n[Test 2] Temporal Memory Graph NL Extraction, Voiding & Disk Persistence...');
const graph = new TemporalMemoryGraph();

// Natural language triple extraction + Predicate synonym normalization
const extractedFacts = graph.extractTriplesFromText('I moved to Toronto yesterday.', 1);
assert(extractedFacts.length === 1, 'Extracted location triple from NL text');
assert(extractedFacts[0].predicate === 'location', 'Normalized "moved to" -> "location"');
assert(extractedFacts[0].object === 'Toronto', 'Extracted target city Toronto');

// Supersede fact with new location triple
const fact2 = graph.assertFact('user', 'resides in', 'New York', 5);
const activeFacts = graph.getCurrentFacts();
assert(activeFacts.length === 1, 'Prior location fact voided by synonym "resides in", 1 active fact remains');
assert(activeFacts[0].object === 'New York', 'New location object is New York');
assert(extractedFacts[0].status === 'superseded' && extractedFacts[0].supersededTurn === 5, 'Fact 1 marked as superseded');

// Candidate Signal Lifecycle & Prune Test
const sig = graph.recordSignal('Prefers dark mode', 1, 2);
assert(sig.promotionState === 'candidate', 'Initial signal is candidate');
graph.recordSignal('Prefers dark mode', 2, 2);
assert(sig.promotionState === 'promoted', 'Signal promoted to fact candidate');

// Disk Persistence Test
const testDiskFile = './.data/test_temporal_graph.json';
if (existsSync(testDiskFile)) unlinkSync(testDiskFile);
graph.saveToDisk(testDiskFile);
assert(existsSync(testDiskFile), 'Saved temporal memory graph to disk');

const loadedGraph = new TemporalMemoryGraph();
loadedGraph.loadFromDisk(testDiskFile);
assert(loadedGraph.getCurrentFacts().length === 1, 'Loaded active facts from disk');
assert(loadedGraph.getCurrentFacts()[0].object === 'New York', 'Loaded fact object matches New York');
if (existsSync(testDiskFile)) unlinkSync(testDiskFile);

// 3. Side-Effect Guard Path-Matching Test
console.log('\n[Test 3] Side-Effect Guard Path-Matching Pre-Verification Pass...');
const guard = new SideEffectGuard();

// Unverified claim (No tool executed)
const resUnverified = guard.inspectResponse('I have created the file config.json successfully.', []);
assert(!resUnverified.passed, 'Flagged unverified past-tense file creation claim');
assert(resUnverified.annotatedText.includes('SIDE-EFFECT GUARD WARNING'), 'Annotated response with warning banner');

// Verified claim with matching path
const resVerified = guard.inspectResponse('I have created the file config.json successfully.', [
  { toolName: 'write_file', isFailure: false, args: { TargetFile: '/app/config.json' }, content: 'File created' }
]);
assert(resVerified.passed, 'Verified past-tense file creation claim with matching path passed');

// Path Mismatch Flagging (Claimed config.json, but tool operated on other.json)
const resMismatch = guard.inspectResponse('I have created the file config.json successfully.', [
  { toolName: 'write_file', isFailure: false, args: { TargetFile: '/app/other.json' }, content: 'File created' }
]);
assert(!resMismatch.passed, 'Flagged path mismatch claim (claimed config.json, tool operated on other.json)');
assert(resMismatch.unsupportedClaims[0].reason.includes("Claimed path 'config.json' does not match"), 'Specific path mismatch reason recorded');

// 4. Deterministic DEP Fallback Test
console.log('\n[Test 4] Deterministic Dynamic Epistemic Posture Engine Fallback...');
const dep = new DynamicEpistemicPostureEngine();
const snapshot = dep.computeDeterministicPosture(
  'Fetch data from example.com',
  processed,
  activeFacts,
  2
);

assert(snapshot.planDiscipline === 'REPLAN', 'Plan discipline computed as REPLAN when tool failure is present');

const cleanProcessed = processed.filter(p => !p.isFailure);
const snapshotClean = dep.computeDeterministicPosture(
  'Fetch data from example.com',
  cleanProcessed,
  activeFacts,
  2
);
assert(snapshotClean.planDiscipline === 'STRICT', 'Plan discipline computed as STRICT for clean verified facts');
assert(snapshotClean.toolEconomy === 0, 'Tool economy set to 0 when exact target evidence exists');
assert(snapshotClean.verificationPosture.includes('Regime 1'), 'Verification posture correctly mapped to Regime 1');

console.log('\n========================================================================');
console.log(`--- DEP & GOVERNANCE FULL INTEGRATION PASSED (${passCount}/${totalCount} TESTS - 100% SUCCESS) ---`);
console.log('========================================================================\n');
