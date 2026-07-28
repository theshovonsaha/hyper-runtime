/**
 * scripts/test_neural_mesh_deep.ts
 *
 * A 100-Turn Deep Chaos Simulation for the Spiking Neural Mesh.
 * Proves that memory stabilizes natively without bloat and that 
 * lateral inhibition and decay completely clear out dead contexts.
 */

import { NeuralThreadMesh } from '../src/memory/neural_mesh';

console.log('========================================================================');
console.log('--- 100-TURN DEEP CHAOS SIMULATION: SPIKING NEURAL MESH ---');
console.log('========================================================================\n');

const mesh = new NeuralThreadMesh();
const TURN_COUNT = 100;
let maxActiveContextReached = 0;
let totalNodesCreated = 0;

for (let turn = 1; turn <= TURN_COUNT; turn++) {
  // 1. Random noise injection (to trigger global decay and occasional stray matches)
  mesh.fireTurn(`Random ambient noise generation sequence ${Math.random()}`, turn);

  // 2. Assert new facts every 5 turns
  if (turn % 5 === 0) {
    mesh.assertNeuralFact('system', `metric_${turn}`, `value_${Math.random()}`, turn);
    totalNodesCreated++;
  }

  // 3. Hebbian wiring cluster: Co-fire "cluster_A" nodes specifically
  if (turn % 10 === 0) {
    mesh.assertNeuralFact('cluster_A', `feature_${turn}`, 'active', turn);
    totalNodesCreated++;
    mesh.fireTurn('cluster_A feature is active now', turn);
  }

  // 4. Lateral Inhibition (Voiding)
  if (turn % 20 === 0) {
    // Supersede a specific fact to trigger lateral inhibition suppression
    mesh.assertNeuralFact('target_entity', 'status', `updated_at_${turn}`, turn);
    totalNodesCreated++;
  }

  // Track max active context size
  const activeCount = mesh.getActiveNeuralContext(100).length;
  if (activeCount > maxActiveContextReached) {
    maxActiveContextReached = activeCount;
  }
}

// Final Assertions after 100 turns
const finalActiveContext = mesh.getActiveNeuralContext(100);
console.log(`[RESULTS] Total Turns: ${TURN_COUNT}`);
console.log(`[RESULTS] Total Unique Nodes Created: ${totalNodesCreated}`);
console.log(`[RESULTS] Max Active Context Size Reached During Chaos: ${maxActiveContextReached}`);
console.log(`[RESULTS] Final Active Context Size At Turn 100: ${finalActiveContext.length}`);

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

console.log('\n[Validating Physics Constraints]');
assert(maxActiveContextReached < 25, 'Active context window natively clamped < 25 despite 100 chaotic turns');
assert(finalActiveContext.length < 15, 'Final active context size is stabilized (no memory bloat)');
assert(finalActiveContext.every(n => n.activation >= 0.7), 'All items in active context are actively spiking (>= 0.7)');

// Verify that the old superseded facts were garbage collected
const allNodesInMesh = Array.from((mesh as any).neuralNodes.values()) as any[];
const suppressedNodes = allNodesInMesh.filter(n => n.activation <= -0.5);
if (suppressedNodes.length > 0) {
  console.log('Suppressed Nodes Left Behind:', suppressedNodes.map(n => ({ id: n.id, act: n.activation, factStatus: n.factRef?.status })));
}
assert(suppressedNodes.length === 0, 'Suppressed nodes were successfully garbage collected from the mesh');

console.log('\n========================================================================');
console.log(`--- DEEP CHAOS SIMULATION PASSED (${passCount}/${totalCount} TESTS - 100% SUCCESS) ---`);
console.log('========================================================================\n');
