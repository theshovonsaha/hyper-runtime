/**
 * protocols/rfp.ts — Reactive Failover & Healing Protocol (RFP).
 *
 * NOVEL PROTOCOL: State rewinding and error-recovery circuit breaker.
 * Detects tool schema errors, provider rate limits, and stagnation strikes,
 * rewinding execution state to a known green checkpoint and applying automatic failover.
 */

export interface RFPCheckpoint {
  checkpointId: string;
  stepIndex: number;
  messagesState: unknown[];
  createdAt: number;
}

export interface RFPRecoveryResult {
  triggered: boolean;
  action: 'rewind' | 'fallback_provider' | 'none';
  checkpoint?: RFPCheckpoint;
  targetProvider?: string;
  logSummary: string;
}

export class ReactiveFailoverEngine {
  private checkpoints: RFPCheckpoint[] = [];
  private currentStrikeCount = 0;

  saveCheckpoint(stepIndex: number, messagesState: unknown[]): RFPCheckpoint {
    const cp: RFPCheckpoint = {
      checkpointId: 'cp_' + crypto.randomUUID().slice(0, 8),
      stepIndex,
      messagesState: [...messagesState],
      createdAt: Date.now(),
    };
    this.checkpoints.push(cp);
    return cp;
  }

  handleFailure(errorMsg: string, currentProvider: string, fallbackChain: string[]): RFPRecoveryResult {
    this.currentStrikeCount++;
    const err = errorMsg.toLowerCase();

    // 1. Rate limit or provider crash -> Fallback Provider
    if (err.includes('rate') || err.includes('429') || err.includes('unavailable')) {
      const nextProvider = fallbackChain.find(p => p !== currentProvider) || 'mock';
      return {
        triggered: true,
        action: 'fallback_provider',
        targetProvider: nextProvider,
        logSummary: `RFP: Provider ${currentProvider} throttled. Failing over to ${nextProvider}.`,
      };
    }

    // 2. Tool schema or stagnation error -> Trajectory State Rewind
    if (this.checkpoints.length > 0) {
      const lastCp = this.checkpoints[this.checkpoints.length - 1];
      return {
        triggered: true,
        action: 'rewind',
        checkpoint: lastCp,
        logSummary: `RFP: Execution error detected. Rewinding state to checkpoint ${lastCp.checkpointId} (Step ${lastCp.stepIndex}).`,
      };
    }

    return {
      triggered: false,
      action: 'none',
      logSummary: 'RFP: No recovery action taken.',
    };
  }
}
