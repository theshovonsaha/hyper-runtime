/**
 * core/dep.ts — Dynamic Epistemic Posture (DEP) Engine
 *
 * Computes 6 structured epistemic properties per-turn to govern what the agent believes
 * and how it is permitted to act. Supports LLM synthesis with deterministic fallback computation.
 */

import type { Provider } from '../providers/base';
import type { ContextItem } from '../context/assembler';
import type { EvidenceItem } from './evidence_lane';
import type { TemporalFact } from '../memory/temporal_graph';

export interface MetaContextSnapshot {
  verificationPosture: string;
  falsifier: string;
  minimumProbe: string;
  planDiscipline: 'STRICT' | 'ADAPTIVE' | 'REPLAN';
  contradictionPolicy: string;
  toolEconomy: number;
}

export class DynamicEpistemicPostureEngine {
  /**
   * Deterministically computes posture snapshot without LLM (fast path / fallback)
   */
  computeDeterministicPosture(
    objective: string,
    evidenceItems: EvidenceItem[],
    currentFacts: TemporalFact[],
    toolCallCount: number
  ): MetaContextSnapshot {
    const hasExactTarget = evidenceItems.some(i => i.isExactTarget);
    const hasFailures = evidenceItems.some(i => i.isFailure);
    const hasSubstantiveEvidence = evidenceItems.length > 0 && !hasFailures;

    let verificationPosture = "Regime 4: Candidate signals only — treat as planning hints, verify before asserting.";
    if (currentFacts.length > 0) {
      verificationPosture = "Regime 1: Answer strictly from current verified temporal facts.";
    } else if (hasExactTarget) {
      verificationPosture = "Regime 2: Exact-target evidence available — treat as primary source.";
    } else if (hasSubstantiveEvidence) {
      verificationPosture = "Regime 3: Indirect evidence present — cross-verify target details before asserting.";
    }

    const falsifier = hasExactTarget
      ? "A contradicting tool result or HTTP error status on exact target."
      : "Any hard tool failure or explicit user correction signal.";

    const minimumProbe = hasExactTarget
      ? "Execute direct target query / web_fetch."
      : "Perform minimum targeted search or file inspection.";

    let planDiscipline: 'STRICT' | 'ADAPTIVE' | 'REPLAN' = 'ADAPTIVE';
    if (hasFailures) planDiscipline = 'REPLAN';
    else if (hasExactTarget || currentFacts.length > 0) planDiscipline = 'STRICT';

    const contradictionPolicy = "User corrections supersede prior temporal facts; prior facts are voided immediately.";
    const toolEconomy = hasExactTarget ? 0 : (hasSubstantiveEvidence ? 1 : 2);

    return {
      verificationPosture,
      falsifier,
      minimumProbe,
      planDiscipline,
      contradictionPolicy,
      toolEconomy,
    };
  }

  /**
   * Computes the current DEP state dynamically via LLM stream with deterministic fallback.
   */
  async computePosture(
    provider: Provider,
    objective: string,
    phase: string,
    recentToolOutputs: string,
    toolCallCount: number,
    evidenceItems: EvidenceItem[] = [],
    currentFacts: TemporalFact[] = []
  ): Promise<MetaContextSnapshot> {
    const fallback = this.computeDeterministicPosture(objective, evidenceItems, currentFacts, toolCallCount);

    const prompt = `You are the Dynamic Epistemic Posture (DEP) Engine.
Objective: "${objective}"
Current Phase: ${phase}
Recent Tool Evidence:
${recentToolOutputs || 'None'}

Compute the current epistemic posture by returning ONLY a valid JSON object matching this schema:
{
  "verificationPosture": "string describing what can be treated as true",
  "falsifier": "string describing what single observation would change the path",
  "minimumProbe": "string describing the smallest tool call to close the gap",
  "planDiscipline": "STRICT" | "ADAPTIVE" | "REPLAN",
  "contradictionPolicy": "string describing how to handle factual conflicts",
  "toolEconomy": number (0 if exact target evidence exists, otherwise 1 or more)
}`;

    let jsonStr = '{}';
    try {
      let res = '';
      await provider.streamTurn([{ role: 'user', content: prompt }], [], async (chunk) => { res += chunk; });
      const cleaned = res.trim().replace(/^```(?:json)?\s*|\s*```$/gm, '');
      const start = cleaned.indexOf('{');
      const stop = cleaned.lastIndexOf('}');
      if (start !== -1 && stop > start) {
        jsonStr = cleaned.slice(start, stop + 1);
      }
    } catch (e) {
      return fallback;
    }

    let parsed: any = {};
    try {
      parsed = JSON.parse(jsonStr);
    } catch(e) {
      return fallback;
    }

    return {
      verificationPosture: parsed.verificationPosture || fallback.verificationPosture,
      falsifier: parsed.falsifier || fallback.falsifier,
      minimumProbe: parsed.minimumProbe || fallback.minimumProbe,
      planDiscipline: ['STRICT', 'ADAPTIVE', 'REPLAN'].includes(parsed.planDiscipline) ? parsed.planDiscipline : fallback.planDiscipline,
      contradictionPolicy: parsed.contradictionPolicy || fallback.contradictionPolicy,
      toolEconomy: typeof parsed.toolEconomy === 'number' ? parsed.toolEconomy : fallback.toolEconomy,
    };
  }

  /**
   * Converts the snapshot into a contextual instruction string.
   */
  toInstructionString(snapshot: MetaContextSnapshot): string {
    return `[DYNAMIC EPISTEMIC POSTURE - CURRENT TURN]
- Verification Posture: ${snapshot.verificationPosture}
- Falsifier: ${snapshot.falsifier}
- Minimum Probe: ${snapshot.minimumProbe}
- Plan Discipline: ${snapshot.planDiscipline}
- Contradiction Policy: ${snapshot.contradictionPolicy}
- Tool Economy: ${snapshot.toolEconomy}`;
  }

  /**
   * Converts the snapshot into a structured ContextItem.
   */
  toContextItem(snapshot: MetaContextSnapshot): ContextItem {
    const text = this.toInstructionString(snapshot);
    return {
      id: 'dep_' + crypto.randomUUID().slice(0, 8),
      kind: 'runtime',
      title: 'Dynamic Epistemic Posture',
      text,
      chars: text.length,
      reason: 'Governs what the agent believes and how it may act this turn',
      source_ref: 'dep_engine',
      included: true,
      edited: false,
      partial: false,
      compressed: false,
    };
  }
}
