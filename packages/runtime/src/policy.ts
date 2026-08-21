import type {
  ActionProposal,
  Approval,
  CapabilityGrant,
  CapabilityManifest,
  Condition,
  IntentContract,
  PolicyDecision,
} from '@hyper/contracts';

export interface PolicyInput {
  now: string;
  intent: IntentContract;
  conditions: Condition[];
  proposal: ActionProposal;
  manifest: CapabilityManifest;
  approval?: Approval;
}

function matchesPattern(target: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    // Keep the trailing slash in the prefix. `workspace/**` authorizes
    // descendants such as `workspace/a.txt`, not the sibling-like string
    // `workspace-private` or the bare container name `workspace`.
    return target.startsWith(pattern.slice(0, -2));
  }
  return target === pattern;
}

function validApproval(approval: Approval | undefined, proposal: ActionProposal, now: string): boolean {
  return !!approval
    && approval.proposalId === proposal.id
    && approval.principalId === proposal.principalId
    && Date.parse(approval.issuedAt) <= Date.parse(now)
    && Date.parse(approval.expiresAt) > Date.parse(now);
}

export class DeterministicPolicyEngine {
  decide(input: PolicyInput): PolicyDecision {
    const { intent, conditions, proposal, manifest, now } = input;
    const reasons: string[] = [];

    if (proposal.intentId !== intent.id) reasons.push('INTENT_MISMATCH');
    if (!intent.principals.includes(proposal.principalId)) reasons.push('PRINCIPAL_NOT_AUTHORIZED');
    if (!intent.authorizedResources.some(pattern => matchesPattern(proposal.target, pattern))) {
      reasons.push('TARGET_OUTSIDE_SCOPE');
    }
    if (proposal.capabilityId !== manifest.id) reasons.push('CAPABILITY_MISMATCH');
    if (
      intent.authorizedCapabilities
      && !intent.authorizedCapabilities.includes(proposal.capabilityId)
    ) {
      reasons.push('CAPABILITY_OUTSIDE_INTENT');
    }
    if (!manifest.targetPatterns.some(pattern => matchesPattern(proposal.target, pattern))) {
      reasons.push('TARGET_UNSUPPORTED_BY_CAPABILITY');
    }
    if (proposal.declaredEffects.some(effect => !manifest.effects.includes(effect))) {
      reasons.push('UNDECLARED_CAPABILITY_EFFECT');
    }
    if (manifest.requiredEffects?.some(effect => !proposal.declaredEffects.includes(effect))) {
      reasons.push('REQUIRED_CAPABILITY_EFFECT_OMITTED');
    }
    if (proposal.declaredEffects.some(effect => intent.prohibitedEffects.includes(effect))) {
      reasons.push('PROHIBITED_EFFECT');
    }
    if (proposal.risk > intent.riskBudget) reasons.push('INTENT_RISK_BUDGET_EXCEEDED');
    if (proposal.risk > manifest.riskCeiling) reasons.push('CAPABILITY_RISK_CEILING_EXCEEDED');
    for (const evidenceId of proposal.expectedEvidence) {
      if (!intent.requiredEvidence.includes(evidenceId)) {
        reasons.push(`EVIDENCE_OUTSIDE_INTENT:${evidenceId}`);
      }
    }

    const conditionsById = new Map(conditions.map(condition => [condition.id, condition]));
    for (const requiredId of intent.requiredConditionIds) {
      if (!proposal.conditionIds.includes(requiredId)) {
        reasons.push(`REQUIRED_CONDITION_NOT_REFERENCED:${requiredId}`);
        continue;
      }
      const condition = conditionsById.get(requiredId);
      if (!condition) {
        reasons.push(`REQUIRED_CONDITION_MISSING:${requiredId}`);
        continue;
      }
      if (condition.status !== 'active') {
        reasons.push(`CONDITION_NOT_ACTIVE:${requiredId}:${condition.status}`);
      }
      if (condition.expiresAt && Date.parse(condition.expiresAt) <= Date.parse(now)) {
        reasons.push(`CONDITION_EXPIRED:${requiredId}`);
      }
      if (condition.evidenceRefs.length === 0) {
        reasons.push(`CONDITION_WITHOUT_EVIDENCE:${requiredId}`);
      }
    }

    const approvalRequired = manifest.approval === 'always'
      || (manifest.approval === 'risk_based' && proposal.risk >= intent.approvalAboveRisk);

    if (reasons.length > 0) {
      return {
        id: `decision:${proposal.id}`,
        proposalId: proposal.id,
        disposition: 'deny',
        reasonCodes: reasons,
        obligations: [],
      };
    }

    if (approvalRequired && !validApproval(input.approval, proposal, now)) {
      return {
        id: `decision:${proposal.id}`,
        proposalId: proposal.id,
        disposition: 'require_approval',
        reasonCodes: ['VALID_APPROVAL_REQUIRED'],
        obligations: ['Provide a proposal-scoped, unexpired approval from the acting principal.'],
      };
    }

    const grant: CapabilityGrant = {
      id: `grant:${proposal.id}`,
      proposalId: proposal.id,
      decisionId: `decision:${proposal.id}`,
      principalId: proposal.principalId,
      capabilityId: proposal.capabilityId,
      target: proposal.target,
      effects: [...proposal.declaredEffects],
      maxRisk: proposal.risk,
      expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
    };

    return {
      id: grant.decisionId,
      proposalId: proposal.id,
      disposition: 'allow',
      reasonCodes: ['AUTHORIZED_WITHIN_CONTRACT'],
      obligations: manifest.verification === 'required' ? ['VERIFY_OBSERVED_STATE'] : [],
      grant,
    };
  }
}
