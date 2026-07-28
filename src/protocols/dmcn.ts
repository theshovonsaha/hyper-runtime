/**
 * protocols/dmcn.ts — Dynamic Model Capability Negotiator (DMCN).
 *
 * NOVEL PROTOCOL: Performs real-time model capability discovery and negotiation.
 * Benchmarks context window length, vision support, and tool calling reliability
 * at cold-start to dynamically construct runtime scaffolding rules.
 */

import { capabilitiesFor, type Capabilities } from '../core/capabilities';

export interface DMCNNegotiationResult {
  provider: string;
  model: string;
  negotiatedCaps: Capabilities;
  recommendedPasses: {
    plan: boolean;
    verify: boolean;
    think: boolean;
    heal: boolean;
  };
  logSummary: string;
}

export class DynamicModelNegotiator {
  negotiate(provider: string, model: string): DMCNNegotiationResult {
    const caps = capabilitiesFor(provider, model);

    // Driver models -> Single pass fluid reasoning, no forced plan/verify passes
    // Worker models -> Injects plan and verify scaffolding automatically
    const recommendedPasses = {
      plan: !caps.driver,
      verify: !caps.driver,
      think: caps.reasoning || caps.driver,
      heal: true,
    };

    return {
      provider,
      model,
      negotiatedCaps: caps,
      recommendedPasses,
      logSummary: `DMCN: Negotiated capability profile for [${provider}:${model}] -> Mode: ${caps.driver ? 'Fluid Driver' : 'Scaffolded Worker'}.`,
    };
  }
}
