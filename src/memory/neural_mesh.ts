/**
 * memory/neural_mesh.ts — 10x Spiking Neural Thread Mesh
 *
 * Implements a true Spiking Neural Network (SNN) for context memory:
 *   - Resonance Spiking: Nodes accumulate voltage. At >0.7 they "spike", injecting context.
 *   - Hebbian Plasticity: "Neurons that fire together, wire together." Edges form between co-firing nodes.
 *   - Lateral Inhibition: Superseded facts actively suppress their prior versions (negative voltage).
 *   - Synaptic Propagation: Spiking nodes send activation shockwaves to their Hebbian neighbors.
 */

import { ThreadedMemoryStore, type MemoryThread, type MemoryNode } from './threads';
import { MemoryTieringEngine, type MemoryItem } from './tiering';
import { TemporalMemoryGraph, type TemporalFact } from './temporal_graph';

export interface NeuralNode {
  id: string;
  threadId: string;
  content: string;
  activation: number; // Voltage: -1.0 to 1.5
  tier: 'short_term' | 'long_term' | 'episodic' | 'working';
  factRef?: TemporalFact;
  lastFiredTurn: number;
  synapses: Map<string, number>; // TargetNodeId -> Synaptic Weight (0.0 to 1.0)
}

export class NeuralThreadMesh {
  public threads = new ThreadedMemoryStore();
  public tiering = new MemoryTieringEngine();
  public temporal = new TemporalMemoryGraph();

  private neuralNodes: Map<string, NeuralNode> = new Map();
  private readonly SPIKE_THRESHOLD = 0.7;
  private readonly MAX_ACTIVATION = 1.5;
  private readonly MIN_ACTIVATION = -1.0;

  constructor() {
    this.threads.createThread('Root System Thread');
  }

  /**
   * Asserts a fact triple, creates/unifies a neural node, and applies lateral inhibition to superseded nodes.
   */
  assertNeuralFact(subject: string, predicate: string, object: string, currentTurn: number): NeuralNode {
    // 1. Assert in temporal graph
    const fact = this.temporal.assertFact(subject, predicate, object, currentTurn);

    // 2. Lateral Inhibition (Suppression)
    // If this assertion voided a prior fact, actively suppress the old neural node.
    for (const node of this.neuralNodes.values()) {
      if (node.factRef && node.factRef.status === 'superseded' && node.factRef.subject === subject && node.factRef.predicate === predicate) {
        node.activation = this.MIN_ACTIVATION; // Suppress into negative voltage
      }
    }

    const rootThread = this.threads.listThreads()[0];
    const threadNode = this.threads.pushNode(rootThread.threadId, `${subject} ${predicate} ${object}`, [predicate, subject]);

    const neuralNode: NeuralNode = {
      id: threadNode?.nodeId || 'nnode_' + crypto.randomUUID().slice(0, 8),
      threadId: rootThread.threadId,
      content: `${subject} ${predicate} ${object}`,
      activation: 1.0, // Instantly spikes upon creation
      tier: 'short_term',
      factRef: fact,
      lastFiredTurn: currentTurn,
      synapses: new Map(),
    };

    this.neuralNodes.set(neuralNode.id, neuralNode);
    this.tiering.pushShortTerm(neuralNode.content, [predicate, subject]);

    return neuralNode;
  }

  /**
   * Fires the mesh: Simulates one epoch of Stimulus, Hebbian Wiring, Propagation, and Decay.
   */
  fireTurn(prompt: string, currentTurn: number): NeuralNode[] {
    const queryTerms = new Set((prompt || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
    
    // Phase 1: Stimulus (Regex Match Voltage Boost)
    const firedIds = new Set<string>();
    for (const node of this.neuralNodes.values()) {
      // Don't stimulate heavily suppressed nodes
      if (node.activation <= -0.5) continue;

      const nodeTerms = (node.content || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
      let matches = 0;
      for (const t of nodeTerms) {
        if (queryTerms.has(t)) matches++;
      }

      if (matches > 0) {
        node.activation = Math.min(this.MAX_ACTIVATION, node.activation + 0.5); // +0.5 stimulus
        node.lastFiredTurn = currentTurn;
        firedIds.add(node.id);
      }
    }

    // Phase 2: Hebbian Plasticity (Wire co-firing nodes)
    const firedArray = Array.from(firedIds);
    for (let i = 0; i < firedArray.length; i++) {
      for (let j = i + 1; j < firedArray.length; j++) {
        const nA = this.neuralNodes.get(firedArray[i])!;
        const nB = this.neuralNodes.get(firedArray[j])!;
        
        // Increase synaptic weight bidirectionally
        const wAB = nA.synapses.get(nB.id) || 0;
        nA.synapses.set(nB.id, Math.min(1.0, wAB + 0.2));
        
        const wBA = nB.synapses.get(nA.id) || 0;
        nB.synapses.set(nA.id, Math.min(1.0, wBA + 0.2));
      }
    }

    // Phase 3: Synaptic Propagation (Shockwaves)
    // Nodes that are spiking (>0.7) AND were stimulated this turn push voltage to their Hebbian neighbors
    const propagates = new Map<string, number>();
    for (const node of this.neuralNodes.values()) {
      if (firedIds.has(node.id) && node.activation >= this.SPIKE_THRESHOLD) {
        for (const [targetId, weight] of node.synapses.entries()) {
          if (!firedIds.has(targetId)) {
            // Propagate: target gains (source_voltage * weight * 0.8 dampener)
            const charge = (node.activation * weight * 0.8);
            propagates.set(targetId, (propagates.get(targetId) || 0) + charge);
          }
        }
      }
    }

    // Apply propagated charges
    for (const [targetId, charge] of propagates.entries()) {
      const target = this.neuralNodes.get(targetId);
      if (target && target.activation > -0.5) {
        target.activation = Math.min(this.MAX_ACTIVATION, target.activation + charge);
      }
    }

    // Phase 4 & 5: Global Leaky Decay & Pruning
    for (const [id, node] of Array.from(this.neuralNodes.entries())) {
      // Decay (-0.1) and clamp to MIN_ACTIVATION
      node.activation = Math.max(this.MIN_ACTIVATION, node.activation - 0.1);

      // Prune dead nodes (suppressed or completely decayed)
      if (node.activation <= -0.5) {
        this.neuralNodes.delete(id);
      }
    }

    this.temporal.updateFreshnessAndPrune(currentTurn);

    // Return all spiking nodes for logging
    const spikingNodes = Array.from(this.neuralNodes.values()).filter(n => n.activation >= this.SPIKE_THRESHOLD);
    spikingNodes.sort((a, b) => b.activation - a.activation);
    return spikingNodes;
  }

  /**
   * Only returns nodes that have breached the Resonance Spike Threshold.
   */
  getActiveNeuralContext(maxItems: number = 5): NeuralNode[] {
    const active = Array.from(this.neuralNodes.values()).filter(n => n.activation >= this.SPIKE_THRESHOLD);
    active.sort((a, b) => b.activation - a.activation);
    return active.slice(0, maxItems);
  }
}
