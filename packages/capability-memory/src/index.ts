import { createHash } from 'node:crypto';
import type {
  ActionProposal,
  CapabilityAdapter,
  CapabilityExecution,
  CapabilityGrant,
  CapabilityManifest,
  Observation,
  VerificationResult,
} from '@hyper/contracts';

export interface MemoryWriteArgs extends Record<string, unknown> {
  value: string;
  behavior?: 'apply' | 'false_success' | 'fail';
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class InMemoryWorkspaceCapability implements CapabilityAdapter<MemoryWriteArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'memory.workspace.write',
    version: '0.1.0',
    effects: ['state.write'],
    targetPatterns: ['workspace/**'],
    riskCeiling: 4 as const,
    approval: 'risk_based' as const,
    idempotent: true,
    verification: 'required' as const,
  };

  private readonly state = new Map<string, string>();
  private readonly idempotency = new Map<string, CapabilityExecution>();

  async execute(
    proposal: ActionProposal<MemoryWriteArgs>,
    grant: CapabilityGrant,
  ): Promise<CapabilityExecution> {
    if (
      grant.proposalId !== proposal.id
      || grant.capabilityId !== this.manifest.id
      || grant.target !== proposal.target
      || !grant.effects.includes('state.write')
    ) {
      return {
        success: false,
        summary: 'Grant does not authorize this proposal.',
        errorCode: 'INVALID_GRANT',
        evidence: [],
      };
    }

    const prior = this.idempotency.get(proposal.idempotencyKey);
    if (prior) return structuredClone(prior);

    const behavior = proposal.args.behavior ?? 'apply';
    if (behavior === 'fail') {
      const failed: CapabilityExecution = {
        success: false,
        summary: 'Injected execution failure.',
        errorCode: 'INJECTED_FAILURE',
        evidence: [],
      };
      this.idempotency.set(proposal.idempotencyKey, failed);
      return structuredClone(failed);
    }

    if (behavior === 'apply') {
      this.state.set(proposal.target, proposal.args.value);
    }

    const execution: CapabilityExecution = {
      success: true,
      summary: behavior === 'false_success'
        ? 'Adapter reported success without applying the requested state change.'
        : 'State change applied.',
      evidence: [
        {
          id: `tool:${proposal.id}`,
          kind: 'tool_result',
          source: this.manifest.id,
          digest: digest({ target: proposal.target, reportedSuccess: true }),
        },
      ],
    };
    this.idempotency.set(proposal.idempotencyKey, execution);
    return structuredClone(execution);
  }

  async observe(proposal: ActionProposal<MemoryWriteArgs>): Promise<Observation> {
    const exists = this.state.has(proposal.target);
    const value = this.state.get(proposal.target);
    return {
      target: proposal.target,
      exists,
      value,
      evidence: [
        {
          id: `observation:${proposal.id}`,
          kind: 'observation',
          source: this.manifest.id,
          digest: digest({ target: proposal.target, exists, value }),
        },
      ],
    };
  }

  async verify(
    proposal: ActionProposal<MemoryWriteArgs>,
    _execution: CapabilityExecution,
    observation: Observation,
  ): Promise<VerificationResult> {
    const passed = observation.exists && observation.value === proposal.args.value;
    return {
      passed,
      reasonCodes: passed ? ['OBSERVED_STATE_MATCHES_EXPECTED'] : ['OBSERVED_STATE_MISMATCH'],
      evidence: observation.evidence,
    };
  }

  inspect(target: string): string | undefined {
    return this.state.get(target);
  }
}
