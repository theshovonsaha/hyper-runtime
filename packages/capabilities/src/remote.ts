import type {
  ActionProposal,
  CapabilityAdapter,
  CapabilityExecution,
  CapabilityGrant,
  CapabilityManifest,
  Observation,
  VerificationResult,
} from '@hyper/contracts';
import { validateGrant } from './shared';

export interface RemoteCapabilityClient {
  execute(
    manifest: CapabilityManifest,
    proposal: ActionProposal,
    grant: CapabilityGrant,
  ): Promise<CapabilityExecution>;
  observe(manifest: CapabilityManifest, proposal: ActionProposal): Promise<Observation>;
  verify(
    manifest: CapabilityManifest,
    proposal: ActionProposal,
    execution: CapabilityExecution,
    observation: Observation,
  ): Promise<VerificationResult>;
}

export class RemoteCapabilityAdapter implements CapabilityAdapter {
  constructor(
    readonly manifest: CapabilityManifest,
    private readonly client: RemoteCapabilityClient,
  ) {
    if (manifest.effects.length === 0 || manifest.targetPatterns.length === 0) {
      throw new Error('Remote capability manifests require explicit effects and target patterns.');
    }
  }

  async execute(
    proposal: ActionProposal,
    grant: CapabilityGrant,
  ): Promise<CapabilityExecution> {
    const requiredEffect = proposal.declaredEffects[0];
    if (!requiredEffect) {
      return {
        success: false,
        summary: 'Remote proposal declares no effect.',
        errorCode: 'MISSING_DECLARED_EFFECT',
        evidence: [],
      };
    }
    const invalid = validateGrant(proposal, grant, this.manifest, requiredEffect);
    if (invalid) return invalid;
    return this.client.execute(this.manifest, proposal, grant);
  }

  async observe(proposal: ActionProposal): Promise<Observation> {
    return this.client.observe(this.manifest, proposal);
  }

  async verify(
    proposal: ActionProposal,
    execution: CapabilityExecution,
    observation: Observation,
  ): Promise<VerificationResult> {
    return this.client.verify(this.manifest, proposal, execution, observation);
  }
}
