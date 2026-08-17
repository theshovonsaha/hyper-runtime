/**
 * core/delta.ts — Delta engine: goal-state vs current-state divergence.
 *
 * This is the enhancement seed for the "Delta Engine" / "Self Healer" /
 * "Reassembler" boxes in the architecture sketch. It is NOT a rewrite of
 * runCompletionCheck — it's a richer signal you can use alongside it:
 * instead of a boolean "done", you get a distance + a risk classification,
 * which is enough to decide whether to (a) keep going normally, (b) trigger
 * a self-heal (retry/rollback a failed step), or (c) reassemble (replan with
 * a different strategy) rather than blindly continuing the same loop.
 *
 * Fail-safe like the other self-prompt stages: a parse failure or provider
 * error downgrades to `{distance: 'none', risk: 'ok', next_action: null}`,
 * i.e. "assume fine, don't block the run."
 */

export interface Provider {
  // streamTurn takes message turns, an options array, and a progress callback,
  // and resolves to an object with a `text` property containing the model output.
  streamTurn(
    messages: Array<{ role: string; content: string }>,
    opts: any[],
    onProgress: () => Promise<void>,
  ): Promise<{ text: string }>;
}
export interface DeltaAssessment {
  /** How far the current draft/evidence is from satisfying the objective. */
  distance: 'none' | 'small' | 'large';
  /** Concrete gaps, in the model's own words (0-3 short items). */
  missing: string[];
  /** The single next action to close the gap, or null if distance is 'none'. */
  next_action: string | null;
  /**
   * 'ok'        — proceeding normally is fine
   * 'stalled'   — repeating the same action isn't closing the gap; try a
   *               DIFFERENT approach (maps to "self-heal": retry differently)
   * 'diverging' — the approach itself looks wrong; consider replanning from
   *               scratch (maps to "reassemble": new strategy, new context)
   */
  risk: 'ok' | 'stalled' | 'diverging';
}

const DELTA_SYSTEM_PROMPT = `You are the delta-assessment stage of an agent runtime.
Compare the ORIGINAL OBJECTIVE against the CURRENT STATE (draft answer + tool
evidence gathered so far, plus a short history of recent actions taken).
Return STRICT JSON only:
{"distance": "none" | "small" | "large",
 "missing": ["<short gap, in your own words>"],
 "next_action": "<single concrete next step, or null if distance is 'none'>",
 "risk": "ok" | "stalled" | "diverging"}

Guidance:
- "stalled": the recent actions look like they're repeating without closing
  the gap (same kind of tool call, same kind of answer, no new information).
  Recommend a DIFFERENT next_action, not "try again."
- "diverging": the actions taken so far look like the wrong approach entirely
  for this objective — recommend replanning, not incrementally continuing.
- Be honest but not pedantic: "none" is fine whenever the objective is
  genuinely satisfiable from what's already gathered.`;

/**
 * Assess how far `draft` (+ `recentActions`, a short log of the last few
 * tool calls / continuations) is from satisfying `objective`.
 */
export async function runDeltaCheck(
  provider: Provider,
  objective: string,
  draft: string,
  toolEvidence: string[],
  recentActions: string[] = [],
): Promise<DeltaAssessment> {
  const evidence = toolEvidence.length
    ? `\n\nTool evidence:\n${toolEvidence.map((e, i) => `[${i + 1}] ${e.slice(0, 400)}`).join('\n')}`
    : '';
  const history = recentActions.length
    ? `\n\nRecent actions:\n${recentActions.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
    : '';

  const messages = [
    { role: 'system', content: DELTA_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Objective: ${objective}\n\nCurrent draft:\n${draft || '(none yet)'}${evidence}${history}\n\nAssess now.`,
    },
  ];

  try {
    const turn = await provider.streamTurn(messages, [], async () => {});
    const parsed = parseJsonBlock(turn.text);
    if (!parsed) return { distance: 'none', missing: [], next_action: null, risk: 'ok' };
    return {
      distance: parsed.distance === 'small' || parsed.distance === 'large' ? parsed.distance : 'none',
      missing: Array.isArray(parsed.missing) ? parsed.missing.slice(0, 3).map(String) : [],
      next_action: parsed.next_action ? String(parsed.next_action) : null,
      risk: parsed.risk === 'stalled' || parsed.risk === 'diverging' ? parsed.risk : 'ok',
    };
  } catch {
    return { distance: 'none', missing: [], next_action: null, risk: 'ok' };
  }
}

function parseJsonBlock(text: string): any {
  const cleaned = (text || '').trim().replace(/^```(?:json)?\s*|\s*```$/gm, '');
  const start = cleaned.indexOf('{');
  const stop = cleaned.lastIndexOf('}');
  if (start === -1 || stop <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, stop + 1));
  } catch {
    return null;
  }
}
