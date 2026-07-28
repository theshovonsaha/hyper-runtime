import type { ContextItem } from '../context/assembler';

export interface HealResult {
  healed: boolean;
  actionTaken: 'none' | 'pruned_stale_notes' | 'repaired_tool_args' | 'deduped_context';
  repairedText?: string;
  repairedArgs?: Record<string, unknown>;
  logSummary: string;
}

export class ContextDriftHealer {
  /**
   * `rawArgs` (optional): the raw string the model emitted for tool args,
   * when the failure was a JSON/argument-schema error. Previously this
   * method returned `healed: true, actionTaken: 'repaired_tool_args'` on
   * *any* json/argument/invalid-tool error string, without ever producing
   * a `repairedArgs` value — callers trusting `healed: true` had no actual
   * fix to use. Now it only claims success when it produces a value that
   * genuinely parses; otherwise it's honest that detection fired but no
   * concrete repair was made.
   */
  healContext(items: ContextItem[], lastError?: string, rawArgs?: string): HealResult {
    if (!lastError) {
      return { healed: false, actionTaken: 'none', logSummary: 'Context is healthy.' };
    }

    const err = lastError.toLowerCase();

    if (err.includes('json') || err.includes('argument') || err.includes('invalid tool')) {
      const repaired = rawArgs ? tryRepairJsonArgs(rawArgs) : null;
      if (repaired) {
        return {
          healed: true,
          actionTaken: 'repaired_tool_args',
          repairedArgs: repaired,
          logSummary: 'Auto-healed malformed tool argument JSON (trailing commas / smart quotes / unbalanced braces).',
        };
      }
      // Detected the error class but had nothing to repair, or the repair
      // attempt still didn't parse — don't claim success on nothing.
      return {
        healed: false,
        actionTaken: 'none',
        logSummary: rawArgs
          ? 'Detected a tool-argument schema error but the repair attempt still failed to parse; needs a fresh model call, not a patch.'
          : 'Detected a tool-argument schema error but no raw args were provided to repair.',
      };
    }

    const staleItems = items.filter(i => i.kind === 'memory' && i.text.length > 500);
    if (staleItems.length > 0) {
      staleItems.forEach(i => (i.included = false));
      return {
        healed: true,
        actionTaken: 'pruned_stale_notes',
        logSummary: `Pruned ${staleItems.length} oversized/drifting memory notes.`,
      };
    }

    return { healed: false, actionTaken: 'none', logSummary: 'No auto-healing action required.' };
  }
}

/**
 * Attempt a handful of common, mechanical JSON repairs (not a general parser
 * fix). Returns the parsed object only if a fix actually makes it valid JSON
 * — never fabricates a value.
 */
function tryRepairJsonArgs(raw: string): Record<string, unknown> | null {
  const candidates = [
    raw,
    raw.replace(/,\s*([}\]])/g, '$1'),                 // trailing commas
    raw.replace(/'([^']*)'/g, '"$1"'),                 // single -> double quotes
    raw.replace(/,\s*([}\]])/g, '$1').replace(/'([^']*)'/g, '"$1"'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}
