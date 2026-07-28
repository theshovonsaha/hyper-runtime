/**
 * Planner Engine — generates a short execution plan via a self-prompt.
 *
 * The planner is a lightweight model call that produces a structured JSON plan
 * (strategy + steps) *before* the main action loop begins. The plan is:
 *   - evented (plan.created / plan.update events in the trail)
 *   - optional (disabled via config.planPass or for "driver" models)
 *   - fail-safe (parse failure downgrades the stage, never crashes the run)
 */

import type { Provider } from '../providers/base';

/** A single planned step */
export interface PlanStep {
  id: number;
  description: string;
  tool: string | null;
  status: 'pending' | 'done' | 'failed' | 'skipped';
}

/** The full plan produced by the planner */
export interface Plan {
  strategy: string;
  steps: PlanStep[];
}

const PLAN_SYSTEM_PROMPT = `You are the planning stage of a transparent agent runtime.
You are the decisive leader and the right question asker.
Given the user objective and the available tools, produce a short plan.
If the objective is vague or dangerous, your strategy should be to ask clarifying questions.
Return STRICT JSON only:
{"strategy": "<one line>", "steps": [{"id": 1, "description": "<short>", "tool": "<tool name or null>"}]}
Max 4 steps. Name a tool ONLY when the step needs external data or action
(search, fetch, compute, file, memory-write). Reasoning, structuring, and
writing steps take "tool": null — a reasoning task often needs ZERO tools,
and unfinished tool-steps force wasteful continuations.`;

const COMPLEXITY_PROMPT = `You are a fast pre-flight classifier for an agent runtime.
Analyze the user's objective and classify its complexity.
Return STRICT JSON only:
{"complex": true|false, "signals": ["<signal>"], "suggested_fan_out": "<brief recommendation or null>"}

Signals to detect:
- "research+produce": the task requires both gathering information AND producing a deliverable
- "multiple deliverables": the user explicitly asks for multiple distinct outputs
- "multi-clause": the request has many independent sub-requirements
- "multi-domain": the task spans multiple distinct knowledge domains

Set "complex" to true only if 2+ signals are detected.`;

/**
 * Classify objective complexity via a fast LLM micro-call.
 * Returns null if the call fails or the objective is simple.
 */
async function analyzeComplexity(
  provider: Provider,
  objective: string,
): Promise<{ complex: boolean; signals: string[]; suggested_fan_out: string | null } | null> {
  try {
    const turn = await provider.streamTurn(
      [
        { role: 'system', content: COMPLEXITY_PROMPT },
        { role: 'user', content: objective },
      ],
      [],
      async () => {},
    );
    const parsed = parseJsonBlock(turn.text);
    if (!parsed || typeof parsed.complex !== 'boolean') return null;
    return {
      complex: parsed.complex,
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      suggested_fan_out: parsed.suggested_fan_out || null,
    };
  } catch {
    return null;
  }
}

/**
 * Run the planner self-prompt against the provider.
 * Returns a parsed Plan or null on parse failure (downgrade, never crash).
 */
export async function runPlanner(
  provider: Provider,
  packetMessages: Array<{ role: string; content: string }>,
  toolNames: string[],
  opts?: { economy?: boolean },
): Promise<Plan | null> {
  if (opts?.economy) return null;

  // Fast pre-flight: classify objective complexity
  const lastUserMsg = packetMessages.filter(m => m.role === 'user').pop();
  const objective = lastUserMsg?.content || '';
  const complexity = await analyzeComplexity(provider, objective);

  let complexityHint = '';
  if (complexity?.complex) {
    complexityHint = `\n\n[System note: This objective has been classified as complex (${complexity.signals.join(', ')}). `
      + `Consider whether the plan needs fan-out or parallel steps. ${complexity.suggested_fan_out || ''}]`;
  }

  const planPrompt = [
    { role: 'system', content: PLAN_SYSTEM_PROMPT },
    ...packetMessages.slice(-3), // last few messages for context
    {
      role: 'user',
      content: `Available tools: ${toolNames.join(', ') || 'none'}.${complexityHint}\nProduce the plan now.`,
    },
  ];

  try {
    const turn = await provider.streamTurn(planPrompt, [], async () => {});
    const parsed = parseJsonBlock(turn.text);
    if (!parsed || !Array.isArray(parsed.steps)) return null;

    const steps: PlanStep[] = parsed.steps.slice(0, 6).map((s: any, i: number) => ({
      id: s.id ?? i + 1,
      description: String(s.description || ''),
      tool: s.tool || null,
      status: 'pending' as const,
    }));

    return { strategy: String(parsed.strategy || ''), steps };
  } catch {
    return null; // parse-fail = skip, never crash
  }
}

/**
 * Update plan step statuses based on completed tool calls.
 */
export function updatePlanSteps(plan: Plan, toolName: string, success: boolean): void {
  for (const step of plan.steps) {
    if (step.tool === toolName && step.status === 'pending') {
      step.status = success ? 'done' : 'failed';
      return; // mark only the first matching pending step
    }
  }
}

/**
 * Get unfinished plan steps that have a tool assigned.
 */
export function unfinishedSteps(plan: Plan): PlanStep[] {
  return plan.steps.filter(s => s.status === 'pending' && s.tool);
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
