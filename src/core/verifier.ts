/**
 * Verifier Engine — judges draft answers before they ship.
 *
 * The verifier is a self-prompt that checks whether the draft answer:
 *   - satisfies the objective
 *   - is free of fabrication
 *   - treats tool results as grounded (not "unsourced")
 *
 * Verdicts:
 *   "ok"     → the draft ships
 *   "revise" → route one internal revision loop (max 1 revision)
 *
 * Like all self-prompt stages, this is evented, optional, and fail-safe.
 */

import type { Provider } from '../providers/base';

export interface VerifyVerdict {
  verdict: 'ok' | 'revise';
  reason: string;
  instruction: string;
}

const VERIFY_SYSTEM_PROMPT = `You are the verification stage of a transparent agent runtime.
Judge whether the draft answer satisfies the objective: complete and free of
fabrication. IMPORTANT: results returned by tools ARE valid, first-class sources —
a fact obtained from a tool (a calculation, the clock, a search, an API) is
grounded, NOT unsourced. Only flag genuine fabrication or a missed objective.
Prefer "ok" unless something is actually wrong. Return STRICT JSON only:
{"verdict": "ok" | "revise", "reason": "<short>", "instruction": "<how to fix, when revise>"}`;

/**
 * Run the verification self-prompt.
 * Returns a parsed verdict or a default "ok" on parse failure (fail-safe).
 */
export async function runVerifier(
  provider: Provider,
  objective: string,
  draft: string,
  toolEvidence: string[],
): Promise<VerifyVerdict> {
  const evidenceSection = toolEvidence.length > 0
    ? `\n\nTool evidence collected:\n${toolEvidence.map((e, i) => `[${i + 1}] ${e.slice(0, 500)}`).join('\n')}`
    : '';

  const messages = [
    { role: 'system', content: VERIFY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Objective: ${objective}\n\nDraft answer:\n${draft}${evidenceSection}\n\nJudge now.`,
    },
  ];

  try {
    const turn = await provider.streamTurn(messages, [], async () => {});
    const parsed = parseJsonBlock(turn.text);
    if (!parsed || !parsed.verdict) {
      return { verdict: 'ok', reason: 'parse failure (defaulting to ok)', instruction: '' };
    }
    return {
      verdict: parsed.verdict === 'revise' ? 'revise' : 'ok',
      reason: String(parsed.reason || ''),
      instruction: String(parsed.instruction || ''),
    };
  } catch {
    return { verdict: 'ok', reason: 'verifier call failed (defaulting to ok)', instruction: '' };
  }
}

/**
 * Completion checker for autonomous mode — decides if the objective is done.
 */
export interface CompletionCheck {
  done: boolean;
  next?: string;
}

const COMPLETION_SYSTEM_PROMPT = `You are the autonomous-mode controller for an agent.
The user gave one objective and expects the agent to finish it end-to-end
without stopping to ask. Given the objective and the work done so far (the draft
answer), decide if the ENTIRE objective is genuinely complete.
Return STRICT JSON only:
{"done": true} if fully complete and nothing useful remains to do autonomously,
or {"done": false, "next": "<the single concrete next action to take now>"}.
Be honest: if the draft only planned or partially did the work, it is NOT done.
Do not invent new scope beyond the objective.`;

export async function runCompletionCheck(
  provider: Provider,
  objective: string,
  draft: string,
): Promise<CompletionCheck> {
  const messages = [
    { role: 'system', content: COMPLETION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Objective: ${objective}\n\nWork so far:\n${draft}\n\nIs it done?`,
    },
  ];

  try {
    const turn = await provider.streamTurn(messages, [], async () => {});
    const parsed = parseJsonBlock(turn.text);
    if (!parsed) return { done: true };
    return {
      done: !!parsed.done,
      next: parsed.next ? String(parsed.next) : undefined,
    };
  } catch {
    return { done: true }; // fail-safe: don't loop on errors
  }
}

/**
 * Synopsis distiller — compresses conversation history into a rolling summary.
 */
export interface DistillResult {
  facts: string[];
  synopsis: string;
  topic: string;
  self_note: string;
}

const DISTILL_SYSTEM_PROMPT = `You maintain a chat session's memory in ONE step. Given the
previous synopsis and the newest exchange, return STRICT JSON only:
{"facts": ["<0-2 durable facts about the user/their world: identity, stable
            preferences, ongoing projects, hard constraints. THE TEST: would
            this still be true and useful NEXT WEEK in an UNRELATED
            conversation? Task instructions, one-off requests, and what the
            user asked for THIS turn are NOT facts — they belong in the
            synopsis. Usually this array is empty.>"],
 "synopsis": "<updated running synopsis, max 150 words, keep durable detail,
              drop chit-chat>",
 "topic": "<current topic, max 6 words>",
 "self_note": "<OPTIONAL, usually empty: ONE short lesson about the AGENT'S OWN
               approach worth keeping>"}
Return an empty facts array if nothing durable was learned.`;

export async function runDistiller(
  provider: Provider,
  previousSynopsis: string,
  exchange: string,
): Promise<DistillResult | null> {
  const messages = [
    { role: 'system', content: DISTILL_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Previous synopsis: ${previousSynopsis || '(none)'}\n\nNewest exchange:\n${exchange}`,
    },
  ];

  try {
    const turn = await provider.streamTurn(messages, [], async () => {});
    const parsed = parseJsonBlock(turn.text);
    if (!parsed) return null;
    return {
      facts: Array.isArray(parsed.facts) ? parsed.facts.map(String) : [],
      synopsis: String(parsed.synopsis || ''),
      topic: String(parsed.topic || ''),
      self_note: String(parsed.self_note || ''),
    };
  } catch {
    return null;
  }
}

/** Parse a JSON block from model text, tolerant of markdown fences */
function parseJsonBlock(text: string): any {
  const cleaned = (text || '').trim().replace(/^```(?:json)?\s*|\s*```$/gm, '');
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = cleaned.indexOf(open);
    const stop = cleaned.lastIndexOf(close);
    if (start !== -1 && stop > start) {
      try {
        return JSON.parse(cleaned.slice(start, stop + 1));
      } catch {
        continue;
      }
    }
  }
  return null;
}
