/**
 * core/reassembler.ts — Self-Healer + Reassembler.
 *
 * Consumes a DeltaAssessment (core/delta.ts) and decides between two
 * responses, matching the diagram's fork:
 *
 *   risk === 'stalled'    -> HEAL: inject a concrete, DIFFERENT next action
 *                            into the transcript and keep the same plan/loop
 *                            state. Cheap, in-loop, no replanning.
 *   risk === 'diverging'  -> REASSEMBLE: the approach itself looks wrong.
 *                            Re-run context assembly (optionally widened,
 *                            e.g. after an 'awareness: need_more_context'
 *                            signal) and produce a FRESH plan, rather than
 *                            continuing to patch a bad transcript.
 *
 * The PacketTrail is what keeps this from healing the same failure forever:
 * `trail.countSince('correction', 'delta')` tells you how many corrections
 * have already been tried since the current delta signal first appeared. Cap
 * it (e.g. 2) and escalate 'stalled' to a forced 'diverging' response instead
 * of heal-looping indefinitely.
 */

import type { Provider, ToolSpec } from '../providers/base';
import type { Plan } from './planner';
import { runPlanner } from './planner';
import type { DeltaAssessment } from './delta';
import type { PacketTrail } from './packet';

export interface HealAction {
  kind: 'heal';
  /** Injected as a `{role:'user'}` transcript message telling the model exactly what to try next. */
  instruction: string;
}

export interface ReassembleAction {
  kind: 'reassemble';
  /** Fresh plan built from a note that includes what went wrong, so it isn't blind. */
  plan: Plan | null;
  /** Human-readable note for the trail on why a full replan was triggered. */
  reason: string;
}

export type CorrectionAction = HealAction | ReassembleAction;

const MAX_HEALS_PER_DELTA = 2;

export async function decideCorrection(
  provider: Provider,
  assessment: DeltaAssessment,
  objective: string,
  toolNames: string[],
  trail: PacketTrail,
  deltaPacketId: string,
): Promise<CorrectionAction | null> {
  if (assessment.risk === 'ok' || assessment.distance === 'none') {
    return null; // nothing to correct
  }

  const healsSoFar = trail.countSince('correction', 'delta');

  if (assessment.risk === 'stalled' && healsSoFar < MAX_HEALS_PER_DELTA) {
    return {
      kind: 'heal',
      instruction:
        `[internal — self-heal, do not mention to the user] The last approach ` +
        `wasn't closing the gap. Do NOT repeat it. Concretely different next step: ` +
        `${assessment.next_action || 'reconsider the approach entirely'}. ` +
        (assessment.missing.length ? `Still missing: ${assessment.missing.join('; ')}.` : ''),
    };
  }

  // 'diverging', or 'stalled' that has exhausted its heal budget — reassemble.
  const reasonNote = assessment.risk === 'diverging'
    ? `delta engine flagged the approach as diverging: ${assessment.missing.join('; ') || assessment.next_action || 'no specific reason given'}`
    : `stalled ${healsSoFar} time(s) without closing the gap — escalating to a full replan`;

  const plan = await runPlanner(
    provider,
    [{ role: 'user', content: `${objective}\n\n[internal note for the planner: a previous attempt at this ` +
      `failed — ${reasonNote}. Produce a genuinely different strategy, not a variation on the same steps.]` }],
    toolNames,
  );

  return { kind: 'reassemble', plan, reason: reasonNote };
}
