/**
 * context/intermediate_pipeline.ts — Dynamic Intermediate Packet & Phase Reassembly Pipeline.
 *
 * ARCHITECTURAL PURPOSE:
 *   Eliminates raw tool data bloat & blind context passing between execution steps.
 *   1. Intercepts raw verbose tool execution outputs.
 *   2. Transforms them into clean Intermediate Context Envelopes.
 *   3. Dynamically re-assembles prompt context packets tailored to the active phase
 *      ('plan', 'tool_loop', 'verify', 'synopsis'), feeding ONLY the exact packet
 *      slice needed for that pass.
 */

import { ContextItem } from './assembler';
import type { ExecutionPhase } from '../core/active_mapping';

export interface IntermediateEnvelope {
  stepIndex: number;
  phase: ExecutionPhase;
  toolName: string;
  succinctSummary: string;
  extractedKeyValues: Record<string, string>;
  rawOutputArchivedId: string;
}

export class DynamicIntermediatePacketPipeline {
  private intermediateEnvelopes: IntermediateEnvelope[] = [];

  /** Transform raw tool output into a clean Intermediate Envelope */
  createIntermediateEnvelope(
    stepIndex: number,
    phase: ExecutionPhase,
    toolName: string,
    rawOutput: string,
  ): IntermediateEnvelope {
    const rawId = 'raw_' + crypto.randomUUID().slice(0, 8);
    const summary = rawOutput.split('\n')[0].slice(0, 120);

    const env: IntermediateEnvelope = {
      stepIndex,
      phase,
      toolName,
      succinctSummary: summary,
      extractedKeyValues: { tool: toolName, status: 'success' },
      rawOutputArchivedId: rawId,
    };

    this.intermediateEnvelopes.push(env);
    return env;
  }

  /** Re-assemble context items dynamically based on active execution phase */
  reassembleForPhase(phase: ExecutionPhase, baseItems: ContextItem[]): ContextItem[] {
    const activeEnvelopes = this.intermediateEnvelopes.filter(e => e.phase === phase || phase === 'verify');
    const summaryText = activeEnvelopes
      .map(e => `[Step ${e.stepIndex} - ${e.toolName}]: ${e.succinctSummary}`)
      .join('\n');

    const dynamicPacketItem: ContextItem = {
      id: 'inter_' + crypto.randomUUID().slice(0, 8),
      kind: 'instructions',
      title: `Intermediate Context Packet (${phase.toUpperCase()} Pass)`,
      text: summaryText ? `[INTERMEDIATE PHASE PACKET - ${phase.toUpperCase()}]\n${summaryText}` : `[INTERMEDIATE PHASE PACKET - ${phase.toUpperCase()}] Initial state`,
      chars: summaryText.length + 50,
      source: 'intermediate_pipeline',
      included: true,
    };

    return [dynamicPacketItem, ...baseItems];
  }
}
