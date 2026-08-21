import type {
  CapabilityAdapter,
  EffectReconciliation,
  InterruptedEffect,
  LedgerEvent,
} from '@hyper/contracts';
import { HashChainLedger } from './ledger';

export interface InterruptedEffectRegistry {
  get(id: string): CapabilityAdapter | undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function pendingInterruptedEffects(events: readonly LedgerEvent[]): InterruptedEffect[] {
  const executed = new Set(events
    .filter(event => event.type === 'action.executed')
    .map(event => text(event.payload.proposalId))
    .filter((value): value is string => !!value));
  const resolved = new Set(events
    .filter(event => event.type === 'effect.interruption_resolved')
    .map(event => text(event.payload.proposalId))
    .filter((value): value is string => !!value));

  return events.flatMap(event => {
    if (event.type !== 'effect.prepared') return [];
    const proposalId = text(event.payload.proposalId);
    const capabilityId = text(event.payload.capabilityId);
    const target = text(event.payload.target);
    const idempotencyKey = text(event.payload.idempotencyKey);
    if (!proposalId || !capabilityId || !target || !idempotencyKey) return [];
    if (executed.has(proposalId) || resolved.has(proposalId)) return [];
    return [{
      runId: event.runId,
      proposalId,
      capabilityId,
      target,
      idempotencyKey,
      declaredEffects: strings(event.payload.declaredEffects) as InterruptedEffect['declaredEffects'],
      idempotent: event.payload.idempotent === true,
      preparedEventHash: event.hash,
    }];
  });
}

export interface InterruptedEffectRecoveryResult {
  effect: InterruptedEffect;
  resolution?: EffectReconciliation;
  recovered: boolean;
  reasonCode: string;
}

/**
 * Reconciles effects whose durable prepare record exists without a durable
 * execution outcome. Recovery observes; it never repeats the original effect.
 */
export async function recoverInterruptedEffects(input: {
  runId: string;
  ledger: HashChainLedger;
  capabilities: InterruptedEffectRegistry;
}): Promise<InterruptedEffectRecoveryResult[]> {
  const pending = pendingInterruptedEffects(input.ledger.forRun(input.runId));
  const results: InterruptedEffectRecoveryResult[] = [];
  for (const effect of pending) {
    input.ledger.append(input.runId, 'effect.interruption_detected', {
      proposalId: effect.proposalId,
      capabilityId: effect.capabilityId,
      target: effect.target,
      idempotencyKey: effect.idempotencyKey,
      preparedEventHash: effect.preparedEventHash,
    });
    const capability = input.capabilities.get(effect.capabilityId);
    if (!capability?.recoverInterrupted) {
      input.ledger.append(input.runId, 'effect.interruption_unresolved', {
        proposalId: effect.proposalId,
        capabilityId: effect.capabilityId,
        reasonCode: 'CAPABILITY_RECOVERY_UNAVAILABLE',
      });
      results.push({ effect, recovered: false, reasonCode: 'CAPABILITY_RECOVERY_UNAVAILABLE' });
      continue;
    }
    try {
      const resolution = await capability.recoverInterrupted(effect);
      const recovered = resolution.state === 'applied'
        || resolution.state === 'not_applied'
        || resolution.state === 'reconciled';
      input.ledger.append(input.runId, 'effect.interruption_resolved', {
        proposalId: effect.proposalId,
        capabilityId: effect.capabilityId,
        recovered,
        ...resolution,
      } as unknown as Record<string, unknown>);
      results.push({
        effect,
        resolution,
        recovered,
        reasonCode: recovered ? 'INTERRUPTED_EFFECT_RECONCILED' : 'INTERRUPTED_EFFECT_STILL_UNCERTAIN',
      });
    } catch (error) {
      input.ledger.append(input.runId, 'effect.interruption_unresolved', {
        proposalId: effect.proposalId,
        capabilityId: effect.capabilityId,
        reasonCode: 'CAPABILITY_RECOVERY_FAILED',
        detail: error instanceof Error ? error.message : String(error),
      });
      results.push({ effect, recovered: false, reasonCode: 'CAPABILITY_RECOVERY_FAILED' });
    }
  }
  return results;
}
