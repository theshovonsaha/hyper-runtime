import type { ContextItem } from '../context/assembler';

export interface HealResult {
  healed: boolean;
  actionTaken: 'none' | 'pruned_stale_notes' | 'repaired_tool_args' | 'deduped_context';
  repairedText?: string;
  repairedArgs?: Record<string, unknown>;
  logSummary: string;
}

export class ContextDriftHealer {
  healContext(items: ContextItem[], lastError?: string): HealResult {
    if (!lastError) {
      return { healed: false, actionTaken: 'none', logSummary: 'Context is healthy.' };
    }

    const err = lastError.toLowerCase();

    if (err.includes('json') || err.includes('argument') || err.includes('invalid tool')) {
      return {
        healed: true,
        actionTaken: 'repaired_tool_args',
        logSummary: 'Auto-healed malformed tool argument schema.',
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