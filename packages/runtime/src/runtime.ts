import type {
  ActionOutcome,
  ActionProposal,
  Approval,
  CapabilityAdapter,
  Condition,
  IntentContract,
  PolicyDecision,
  VerificationResult,
  CapabilityExecution,
} from '@hyper/contracts';
import { HashChainLedger } from './ledger';
import { DeterministicPolicyEngine } from './policy';

export interface GrantClaim {
  accepted: boolean;
  reasonCodes: string[];
}

/**
 * Capability grants are short-lived bearer objects, so the runtime consumes
 * each grant exactly once before invoking an adapter.
 */
export class OneShotGrantGuard {
  private readonly consumed = new Set<string>();

  claim(grant: { id: string; expiresAt: string }, now: string): GrantClaim {
    const nowValue = Date.parse(now);
    const expiryValue = Date.parse(grant.expiresAt);
    if (!Number.isFinite(nowValue) || !Number.isFinite(expiryValue)) {
      return { accepted: false, reasonCodes: ['GRANT_TIME_INVALID'] };
    }
    if (expiryValue <= nowValue) {
      return { accepted: false, reasonCodes: ['GRANT_EXPIRED'] };
    }
    if (this.consumed.has(grant.id)) {
      return { accepted: false, reasonCodes: ['GRANT_ALREADY_CONSUMED'] };
    }
    this.consumed.add(grant.id);
    return { accepted: true, reasonCodes: ['GRANT_CLAIMED_ONCE'] };
  }
}

export interface ExecuteActionInput {
  runId: string;
  now: string;
  intent: IntentContract;
  conditions: Condition[];
  proposal: ActionProposal;
  capability: CapabilityAdapter;
  approval?: Approval;
  verificationMode?: 'required' | 'trust_execution';
  signal?: AbortSignal;
}

function outcomeForDecision(
  runId: string,
  decision: PolicyDecision,
  ledger: HashChainLedger,
): ActionOutcome {
  const status = decision.disposition === 'require_approval' ? 'awaiting_approval' : 'denied';
  const receipt = ledger.append(runId, 'action.receipt', {
    status,
    decisionId: decision.id,
    executed: false,
    claimedSuccess: false,
  });
  return {
    runId,
    status,
    decision,
    executed: false,
    claimedSuccess: false,
    receiptHash: receipt.hash,
  };
}

export class AuthorizedRuntime {
  private readonly grants = new OneShotGrantGuard();

  constructor(
    private readonly policy = new DeterministicPolicyEngine(),
    readonly ledger = new HashChainLedger(),
  ) {}

  async execute(input: ExecuteActionInput): Promise<ActionOutcome> {
    const { runId, proposal, capability } = input;
    this.ledger.append(runId, 'action.proposed', {
      proposalId: proposal.id,
      intentId: proposal.intentId,
      principalId: proposal.principalId,
      capabilityId: proposal.capabilityId,
      target: proposal.target,
      effects: proposal.declaredEffects,
      risk: proposal.risk,
      conditionIds: proposal.conditionIds,
    });

    const decision = this.policy.decide({
      now: input.now,
      intent: input.intent,
      conditions: input.conditions,
      proposal,
      manifest: capability.manifest,
      approval: input.approval,
    });
    this.ledger.append(runId, 'policy.decided', decision as unknown as Record<string, unknown>);

    if (decision.disposition !== 'allow' || !decision.grant) {
      return outcomeForDecision(runId, decision, this.ledger);
    }

    const grantClaim = this.grants.claim(decision.grant, input.now);
    if (!grantClaim.accepted) {
      const rejected: PolicyDecision = {
        id: `${decision.id}:grant-rejected`,
        proposalId: proposal.id,
        disposition: 'deny',
        reasonCodes: grantClaim.reasonCodes,
        obligations: [],
      };
      this.ledger.append(runId, 'capability.grant_rejected', {
        grantId: decision.grant.id,
        reasonCodes: grantClaim.reasonCodes,
      });
      return outcomeForDecision(runId, rejected, this.ledger);
    }

    this.ledger.append(runId, 'capability.granted', decision.grant as unknown as Record<string, unknown>);
    this.ledger.append(runId, 'effect.prepared', {
      proposalId: proposal.id,
      capabilityId: capability.manifest.id,
      target: proposal.target,
      idempotencyKey: proposal.idempotencyKey,
      declaredEffects: proposal.declaredEffects,
      idempotent: capability.manifest.idempotent,
    });
    let execution: CapabilityExecution;
    try {
      execution = await capability.execute(proposal, decision.grant, input.signal);
    } catch (error) {
      execution = {
        success: false,
        summary: error instanceof Error ? error.message : String(error),
        errorCode: 'CAPABILITY_EXECUTION_THROWN',
        evidence: [],
        effectState: 'unknown',
        effectId: proposal.idempotencyKey,
        retrySafe: false,
        reconciliationRequired: true,
      };
      this.ledger.append(runId, 'capability.execution_failed', {
        proposalId: proposal.id,
        capabilityId: capability.manifest.id,
        errorCode: execution.errorCode,
        summary: execution.summary,
      });
    }
    execution = {
      ...execution,
      effectId: execution.effectId ?? proposal.idempotencyKey,
      effectState: execution.effectState ?? (execution.success ? 'applied' : 'unknown'),
      retrySafe: execution.retrySafe ?? (execution.success || (
        capability.manifest.idempotent && execution.effectState !== 'partially_applied'
      )),
      reconciliationRequired: execution.reconciliationRequired ?? (
        !execution.success
        && (execution.effectState === 'unknown' || execution.effectState === 'partially_applied')
      ),
    };
    if (execution.reconciliationRequired && capability.reconcile) {
      try {
        const reconciliation = await capability.reconcile(proposal, execution);
        execution = {
          ...execution,
          effectState: reconciliation.state,
          effectId: reconciliation.effectId,
          retrySafe: reconciliation.retrySafe,
          reconciliationRequired: !reconciliation.retrySafe
            && (reconciliation.state === 'unknown' || reconciliation.state === 'partially_applied'),
          evidence: [...execution.evidence, ...reconciliation.evidence],
        };
        this.ledger.append(runId, 'effect.reconciled', {
          proposalId: proposal.id,
          capabilityId: capability.manifest.id,
          ...reconciliation,
        } as unknown as Record<string, unknown>);
      } catch (error) {
        this.ledger.append(runId, 'effect.reconciliation_failed', {
          proposalId: proposal.id,
          capabilityId: capability.manifest.id,
          effectId: execution.effectId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.ledger.append(runId, 'action.executed', {
      proposalId: proposal.id,
      capabilityId: capability.manifest.id,
      success: execution.success,
      summary: execution.summary,
      errorCode: execution.errorCode,
      evidence: execution.evidence,
      effectState: execution.effectState,
      effectId: execution.effectId,
      retrySafe: execution.retrySafe,
      reconciliationRequired: execution.reconciliationRequired,
    });

    if (!execution.success) {
      const receipt = this.ledger.append(runId, 'action.receipt', {
        status: 'execution_failed',
        decisionId: decision.id,
        executed: true,
        claimedSuccess: false,
      });
      return {
        runId,
        status: 'execution_failed',
        decision,
        executed: true,
        claimedSuccess: false,
        execution,
        receiptHash: receipt.hash,
      };
    }

    let observation;
    try {
      observation = await capability.observe(proposal);
    } catch (error) {
      const verification: VerificationResult = {
        passed: false,
        reasonCodes: ['CAPABILITY_OBSERVATION_THROWN'],
        evidence: [],
      };
      this.ledger.append(runId, 'state.observation_failed', {
        proposalId: proposal.id,
        capabilityId: capability.manifest.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      this.ledger.append(runId, 'action.verified', {
        proposalId: proposal.id,
        capabilityId: capability.manifest.id,
        ...verification,
      } as unknown as Record<string, unknown>);
      const receipt = this.ledger.append(runId, 'action.receipt', {
        status: 'verification_failed',
        decisionId: decision.id,
        executed: true,
        claimedSuccess: false,
        verification: verification.reasonCodes,
      });
      return {
        runId,
        status: 'verification_failed',
        decision,
        executed: true,
        claimedSuccess: false,
        execution,
        verification,
        receiptHash: receipt.hash,
      };
    }
    this.ledger.append(runId, 'state.observed', {
      proposalId: proposal.id,
      capabilityId: capability.manifest.id,
      ...observation,
    } as unknown as Record<string, unknown>);

    let verification: VerificationResult;
    try {
      verification = input.verificationMode === 'trust_execution'
        ? {
            passed: execution.success,
            reasonCodes: ['EXECUTION_RESULT_TRUSTED_WITHOUT_STATE_CHECK'],
            evidence: execution.evidence,
          }
        : await capability.verify(proposal, execution, observation);
    } catch (error) {
      verification = {
        passed: false,
        reasonCodes: ['CAPABILITY_VERIFICATION_THROWN'],
        evidence: observation.evidence,
      };
      this.ledger.append(runId, 'capability.verification_failed', {
        proposalId: proposal.id,
        capabilityId: capability.manifest.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    this.ledger.append(runId, 'action.verified', {
      proposalId: proposal.id,
      capabilityId: capability.manifest.id,
      ...verification,
    } as unknown as Record<string, unknown>);
    const status = verification.passed ? 'completed' : 'verification_failed';
    const receipt = this.ledger.append(runId, 'action.receipt', {
      status,
      decisionId: decision.id,
      executed: true,
      claimedSuccess: verification.passed,
      verification: verification.reasonCodes,
    });

    return {
      runId,
      status,
      decision,
      executed: true,
      claimedSuccess: verification.passed,
      execution,
      observation,
      verification,
      receiptHash: receipt.hash,
    };
  }
}
