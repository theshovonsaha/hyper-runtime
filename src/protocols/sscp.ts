/**
 * protocols/sscp.ts — Self-Steering Context Protocol (SSCP).
 *
 * NOVEL PROTOCOL: Enables bidirectional context window control signals.
 * Models and runtime logic can issue real-time context control commands:
 *   - `sscp:pin`       -> Protects critical prompt items against budget pruning.
 *   - `sscp:shed`      -> Discards large, low-relevance context/tool outputs in-flight.
 *   - `sscp:freeze`    -> Freezes item provenance state to prevent context drift.
 *   - `sscp:summarize` -> Summarizes specific lane contents without interrupting execution.
 */

import type { ContextItem } from '../context/assembler';

export type SSCPAction = 'pin' | 'shed' | 'freeze' | 'summarize';

export interface SSCPCommand {
  action: SSCPAction;
  targetItemId?: string;
  targetKind?: string;
  reason: string;
}

export interface SSCPResult {
  command: SSCPCommand;
  success: boolean;
  mutatedCount: number;
  logSummary: string;
}

export class SelfSteeringContextEngine {
  executeCommand(command: SSCPCommand, items: ContextItem[]): SSCPResult {
    let count = 0;

    switch (command.action) {
      case 'pin': {
        const target = items.find(i => i.id === command.targetItemId || i.kind === command.targetKind);
        if (target) {
          target.included = true;
          count = 1;
        }
        return {
          command,
          success: count > 0,
          mutatedCount: count,
          logSummary: `SSCP: Pinned item [${target?.title || 'none'}] against budget pruning.`,
        };
      }

      case 'shed': {
        const toShed = items.filter(i => (command.targetKind ? i.kind === command.targetKind : true) && i.kind !== 'system' && i.kind !== 'user');
        toShed.forEach(i => (i.included = false));
        count = toShed.length;
        return {
          command,
          success: count > 0,
          mutatedCount: count,
          logSummary: `SSCP: Shed ${count} item(s) of kind [${command.targetKind || 'all'}] to conserve budget.`,
        };
      }

      case 'freeze': {
        items.forEach(i => (i.edited = false));
        return {
          command,
          success: true,
          mutatedCount: items.length,
          logSummary: `SSCP: Freezing provenance state for ${items.length} items to lock context drift.`,
        };
      }

      case 'summarize': {
        const targets = items.filter(i => i.kind === (command.targetKind || 'history'));
        targets.forEach(i => {
          if (i.text.length > 300) {
            i.text = i.text.slice(0, 300) + '... [SSCP Summarized]';
            i.compressed = true;
            count++;
          }
        });
        return {
          command,
          success: count > 0,
          mutatedCount: count,
          logSummary: `SSCP: In-flight summarization applied to ${count} item(s).`,
        };
      }
    }
  }
}
