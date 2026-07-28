/**
 * scripts/test_neural_mesh.ts — Verification for 10x Spiking Neural Thread Mesh Architecture
 */

import { NeuralThreadMesh } from '../src/memory/neural_mesh';

console.log('========================================================================');
console.log('--- SPIKING NEURAL THREAD MESH ATIENTIONAL MEMORY VERIFICATION SUITE ---');
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

const mesh = new NeuralThreadMesh();

// 1. Initial State
console.log('[Test 1] Resonance Spiking & Assertion...');
const nodeA = mesh.assertNeuralFact('competitor', 'pricing', '29/mo', 1);
const nodeB = mesh.assertNeuralFact('marketing', 'feature', 'unlimited sync', 1);

assert(nodeA.activation >= 0.7, 'Node A spikes immediately upon creation');
assert(nodeB.activation >= 0.7, 'Node B spikes immediately upon creation');
assert(mesh.getActiveNeuralContext(5).length === 2, 'Spiking nodes injected into active context');

// 2. Hebbian Plasticity
console.log('\n[Test 2] Hebbian Wiring & Synaptic Plasticity...');
// Co-fire Node A and Node B in the same prompt
mesh.fireTurn('marketing feature has competitor pricing', 2);
const wAB = nodeA.synapses.get(nodeB.id);
const wBA = nodeB.synapses.get(nodeA.id);
assert(wAB !== undefined && wAB > 0.0, 'Hebbian synapse formed A -> B');
assert(wBA !== undefined && wBA > 0.0, 'Hebbian synapse formed B -> A');

// 3. Synaptic Propagation (Shockwaves)
console.log('\n[Test 3] Synaptic Propagation...');
// Let's decay the nodes first
mesh.fireTurn('unrelated noise', 3);
mesh.fireTurn('more noise', 4);
const activationB_before = nodeB.activation;
// Fire ONLY Node A. Since they are wired, Node A should propagate charge to Node B.
mesh.fireTurn('competitor pricing', 5);
const activationB_after = nodeB.activation;
console.log(`  -> Node B activation before: ${activationB_before}, after: ${activationB_after}`);
assert(activationB_after > activationB_before, 'Node B received propagated shockwave charge from Node A without explicit match');

// 4. Lateral Inhibition
console.log('\n[Test 4] Lateral Inhibition...');
const nodeC = mesh.assertNeuralFact('competitor', 'pricing', '39/mo', 6);
assert(nodeA.activation < 0.0, 'Node A (29/mo) actively suppressed (negative voltage) by Lateral Inhibition');
assert(nodeC.activation >= 0.7, 'Node C (39/mo) takes over spiking dominance');
const activeContext = mesh.getActiveNeuralContext();
assert(!activeContext.some(n => n.id === nodeA.id), 'Suppressed Node A banished from active context');
assert(activeContext.some(n => n.id === nodeC.id), 'Dominant Node C injected into active context');

console.log('\n========================================================================');
console.log(`--- SPIKING NEURAL MESH VERIFICATION PASSED (${passCount}/${totalCount} TESTS - 100% SUCCESS) ---`);
console.log('========================================================================\n');
