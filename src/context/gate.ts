/**
 * TurnGate — human-in-the-loop gating for context packets and tool results.
 *
 * CHANGED vs original:
 *   - `PendingGate` now retains the live `ContextPacket` (not just a snapshot
 *     `GateView`). `resolve()` calls `packet.applyEdits(edits)` directly on it
 *     before resolving the held promise — so by the time `hold()` returns,
 *     the SAME packet object the kernel is holding already reflects the
 *     operator's edits. This mirrors gate.py: apply_edits happens at resolve
 *     time, not as a separate step the kernel has to remember to run.
 *   - `GateEdit` now matches `ContextEdit` from assembler.ts (`{id, included?,
 *     text?}`) instead of the old `{id, changed, new_text?}` shape, so it can
 *     be passed straight into `applyEdits`.
 *   - `GateResolution.diff` is now `ContextEditDiff[]` (actual change records)
 *     instead of `GateEdit[]` (input intentions).
 *   - `GateResolution.action` gains the 'edited' case so the kernel can log
 *     whether the gate actually changed anything vs just approved it.
 *
 * Flow:
 *   1. Action loop calls `gate.hold(runId, packet, timeout)`
 *   2. Gate emits a pending view (via SSE / WebSocket / API polling)
 *   3. Operator reviews and calls `gate.resolve(runId, action, edits?)`
 *      — or the gate auto-approves after `timeout` seconds
 *   4. The hold() promise resolves with a GateResolution (packet already edited)
 *
 * Design notes:
 *   - One pending gate per runId — calling hold() again for the same runId
 *     replaces the previous pending gate.
 *   - Timeout auto-approval prevents the system from hanging when no operator
 *     is connected. Default is typically 30s, configurable per-call.
 *   - The gate is entirely optional — in 'normal' mode the action loop skips it.
 */

import type { ContextPacket, ContextItem, ContextEdit, ContextEditDiff } from './assembler';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A view of the pending gate, suitable for sending to the UI */
export interface GateView {
  /** The run this gate belongs to */
  run_id: string;
  /** What kind of gate: pre-inference packet or post-tool result */
  kind: 'packet' | 'tool_result';
  /** The context items available for review */
  items: Array<{
    id: string;
    kind: string;
    title: string;
    text: string;
    included: boolean;
  }>;
  /** If kind is 'tool_result', the raw tool output */
  tool_result?: string;
  /** When this gate was created */
  created_at: string;
  /** How many seconds until auto-approval */
  timeout_s: number;
}

/**
 * A single edit applied to a context item during gate review.
 * Matches ContextEdit from assembler.ts so it can be passed straight to applyEdits().
 */
export type GateEdit = ContextEdit;

/** The resolution of a gate hold */
export interface GateResolution {
  /** 'approved' — no edits or auto-timeout; 'edited' — edits applied; 'cancelled' — run aborted */
  action: 'approved' | 'edited' | 'cancelled';
  /** The actual changes applied to the packet (empty for approved/cancelled) */
  diff: ContextEditDiff[];
  /** Optional replacement content for tool-result gates */
  content?: string;
}

// ---------------------------------------------------------------------------
// Internal pending state
// ---------------------------------------------------------------------------

interface PendingGate {
  resolve: (result: GateResolution) => void;
  view: GateView;
  packet?: ContextPacket;      // only set for kind === 'packet'
  toolResult?: string;          // only set for kind === 'tool_result'
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// TurnGate
// ---------------------------------------------------------------------------

export class TurnGate {
  private pending: Map<string, PendingGate> = new Map();

  /**
   * Hold execution until the gate is resolved or times out.
   *
   * @param runId — unique run identifier
   * @param packet — the LIVE context packet to gate (mutated in place on edit)
   * @param timeoutS — seconds before auto-approval (0 = instant approval)
   * @returns GateResolution when approved/edited/cancelled
   */
  async hold(
    runId: string,
    packet: ContextPacket,
    timeoutS: number,
  ): Promise<GateResolution> {
    this.cancelPending(runId);

    if (timeoutS <= 0) {
      return { action: 'approved', diff: [] };
    }

    return new Promise<GateResolution>((resolve) => {
      const view: GateView = {
        run_id: runId,
        kind: 'packet',
        items: packet.items.map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          text: item.text.slice(0, 500) + (item.text.length > 500 ? '\n... [TRUNCATED FOR GATE VIEW]' : ''),
          included: item.included,
        })),
        created_at: new Date().toISOString(),
        timeout_s: timeoutS,
      };

      const timer = setTimeout(() => {
        this.pending.delete(runId);
        resolve({ action: 'approved', diff: [] });
      }, timeoutS * 1000);

      this.pending.set(runId, { resolve, view, packet, timer });
    });
  }

  /**
   * Hold execution for a tool result review.
   *
   * @param runId — unique run identifier
   * @param toolResult — the raw tool output to review
   * @param timeoutS — seconds before auto-approval
   */
  async holdToolResult(
    runId: string,
    toolResult: string,
    timeoutS: number,
  ): Promise<GateResolution> {
    this.cancelPending(runId);

    if (timeoutS <= 0) {
      return { action: 'approved', diff: [] };
    }

    return new Promise<GateResolution>((resolve) => {
      const view: GateView = {
        run_id: runId,
        kind: 'tool_result',
        items: [],
        tool_result: toolResult.slice(0, 1500) + (toolResult.length > 1500 ? '\n... [TRUNCATED FOR GATE VIEW]' : ''),
        created_at: new Date().toISOString(),
        timeout_s: timeoutS,
      };

      const timer = setTimeout(() => {
        this.pending.delete(runId);
        resolve({ action: 'approved', diff: [] });
      }, timeoutS * 1000);

      this.pending.set(runId, { resolve, view, toolResult, timer });
    });
  }

  /**
   * Resolve a pending gate.
   *
   * For a packet gate, `edits` are applied to the live packet HERE, before
   * the held promise resolves — the kernel needs no further action.
   * For a tool-result gate, `content` (if different from the original)
   * becomes the rewritten result the model sees; the kernel is responsible
   * for substituting it into the transcript.
   *
   * @param runId — the run to resolve
   * @param action — 'approved' or 'cancelled'
   * @param edits — optional array of edits to context items (packet gates only)
   * @param content — optional replacement content (tool-result gates only)
   * @returns `{ ok: true }` on success, `{ ok: false, error }` if no gate pending
   */
  resolve(
    runId: string,
    action: 'approved' | 'cancelled',
    edits?: GateEdit[],
    content?: string,
  ): { ok: boolean; error?: string } {
    const gate = this.pending.get(runId);
    if (!gate) {
      return { ok: false, error: `No pending gate for run: ${runId}` };
    }

    clearTimeout(gate.timer);
    this.pending.delete(runId);

    if (action === 'cancelled') {
      gate.resolve({ action: 'cancelled', diff: [] });
      return { ok: true };
    }

    if (gate.packet) {
      // Apply edits to the live packet NOW — kernel sees the result immediately.
      const diff = gate.packet.applyEdits(edits ?? []);
      gate.resolve({ action: diff.length > 0 ? 'edited' : 'approved', diff });
    } else {
      // Tool-result gate: diff is always empty, content substitution is up to caller.
      const original = gate.toolResult;
      const edited = content !== undefined && content !== original;
      gate.resolve({ action: edited ? 'edited' : 'approved', diff: [], content });
    }

    return { ok: true };
  }

  /**
   * Get the current view for a pending gate (for UI rendering).
   * Returns null if no gate is pending for this run.
   */
  pendingView(runId: string): GateView | null {
    return this.pending.get(runId)?.view ?? null;
  }

  /** Check if a gate is currently pending for the given run. */
  hasPending(runId: string): boolean {
    return this.pending.has(runId);
  }

  /** List all currently pending run IDs. */
  pendingRuns(): string[] {
    return Array.from(this.pending.keys());
  }

  /** Number of currently pending gates. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /** Cancel and clean up a pending gate without resolving it */
  private cancelPending(runId: string): void {
    const existing = this.pending.get(runId);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(runId);
      existing.resolve({ action: 'cancelled', diff: [] });
    }
  }
}
