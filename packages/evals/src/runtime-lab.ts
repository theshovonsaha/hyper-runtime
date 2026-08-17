import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ActionProposal,
  CapabilityAdapter,
  CapabilityExecution,
  CapabilityGrant,
  Condition,
  EffectReconciliation,
  IntentContract,
  LedgerEvent,
  Observation,
  VerificationResult,
} from '@hyper/contracts';
import { CONTRACT_VERSION } from '@hyper/contracts';
import { InMemoryWorkspaceCapability, type MemoryWriteArgs } from '@hyper/capability-memory';
import { AuthorizedRuntime } from '@hyper/runtime';

export type FaultMode = 'none' | 'throw' | 'timeout' | 'false_success' | 'stale_observation' | 'partial_effect' | 'malformed';

export interface RuntimeLabScenario {
  id: string;
  fault: FaultMode;
  target?: string;
  risk?: number;
  expectedStatus: 'denied' | 'awaiting_approval' | 'execution_failed' | 'verification_failed' | 'completed';
  requiredEvents: string[];
  forbiddenEvents: string[];
}

interface RuntimeLabFixture { benchmark: string; version: string; scenarios: RuntimeLabScenario[] }

export interface RuntimeLabTrial {
  id: string;
  fault: FaultMode;
  expectedStatus: RuntimeLabScenario['expectedStatus'];
  actualStatus: RuntimeLabScenario['expectedStatus'];
  eventTypes: string[];
  missingEvents: string[];
  forbiddenEventsObserved: string[];
  passed: boolean;
  executionReportedSuccess: boolean;
}

export interface RuntimeLabReport {
  benchmark: string;
  version: string;
  evidenceMode: 'deterministic_fixture';
  trials: RuntimeLabTrial[];
  metrics: {
    scenarioPassRate: number;
    falseSuccessPreventionRate: number;
    uncertainEffectDisclosureRate: number;
    modelCalls: 0;
  };
  acceptance: { passed: boolean; requiredRate: number };
}

class FaultInjectingCapability implements CapabilityAdapter<MemoryWriteArgs> {
  readonly manifest;
  private stale = false;

  constructor(private readonly delegate: InMemoryWorkspaceCapability, private readonly fault: FaultMode) {
    this.manifest = { ...delegate.manifest, idempotent: fault !== 'partial_effect' };
  }

  async execute(proposal: ActionProposal<MemoryWriteArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    if (this.fault === 'throw') throw new Error('INJECTED_THROW');
    if (this.fault === 'timeout') throw new DOMException('INJECTED_TIMEOUT', 'TimeoutError');
    if (this.fault === 'malformed') return {} as CapabilityExecution;
    if (this.fault === 'false_success') {
      return this.delegate.execute({ ...proposal, args: { ...proposal.args, behavior: 'false_success' } }, grant);
    }
    if (this.fault === 'stale_observation') this.stale = true;
    if (this.fault === 'partial_effect') {
      const applied = await this.delegate.execute(proposal, grant);
      return {
        success: false,
        summary: 'Connection ended after the effect may have been applied.',
        errorCode: 'INJECTED_PARTIAL_EFFECT',
        evidence: applied.evidence,
        effectState: 'partially_applied',
        effectId: proposal.idempotencyKey,
        retrySafe: false,
        reconciliationRequired: true,
      };
    }
    return this.delegate.execute(proposal, grant);
  }

  async observe(proposal: ActionProposal<MemoryWriteArgs>): Promise<Observation> {
    const observed = await this.delegate.observe(proposal);
    return this.stale ? { ...observed, exists: false, value: undefined } : observed;
  }

  verify(proposal: ActionProposal<MemoryWriteArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    return this.delegate.verify(proposal, execution, observation);
  }

  async reconcile(proposal: ActionProposal<MemoryWriteArgs>): Promise<EffectReconciliation> {
    const observation = await this.delegate.observe(proposal);
    const applied = observation.exists && observation.value === proposal.args.value;
    return {
      effectId: proposal.idempotencyKey,
      state: applied ? 'reconciled' : 'unknown',
      retrySafe: !applied,
      summary: applied ? 'Observed the requested effect after interruption.' : 'Effect remains unknown.',
      evidence: observation.evidence,
    };
  }
}

function fixture(): RuntimeLabFixture {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'evals/runtime-lab.v1.json'), 'utf8')) as RuntimeLabFixture;
}

function intent(): IntentContract {
  return {
    id: 'intent:runtime-lab', version: CONTRACT_VERSION, objective: 'Apply and verify bounded state.',
    principals: ['agent:lab'], authorizedCapabilities: ['memory.workspace.write'],
    authorizedResources: ['workspace/**'], prohibitedEffects: ['state.delete', 'network.request', 'process.execute'],
    requiredConditionIds: ['condition:current'], requiredEvidence: ['observed_state'], riskBudget: 3,
    approvalAboveRisk: 3, completionCriteria: ['Observed state matches requested state.'],
  };
}

const conditions: Condition[] = [{
  id: 'condition:current', statement: 'Fixture state is current.', status: 'active',
  evidenceRefs: ['fixture:clock'], source: 'runtime-lab', observedAt: '2026-01-15T11:59:00.000Z',
  expiresAt: '2026-01-15T12:05:00.000Z',
}];

export async function runRuntimeLabScenario(
  scenario: RuntimeLabScenario,
  verificationMode: 'required' | 'trust_execution' = 'required',
): Promise<RuntimeLabTrial> {
  const runtime = new AuthorizedRuntime();
  const capability = new FaultInjectingCapability(new InMemoryWorkspaceCapability(), scenario.fault);
  const proposal: ActionProposal<MemoryWriteArgs> = {
    id: `proposal:${scenario.id}`, intentId: 'intent:runtime-lab', principalId: 'agent:lab',
    conditionIds: ['condition:current'], capabilityId: 'memory.workspace.write',
    target: scenario.target ?? 'workspace/result.txt', declaredEffects: ['state.write'],
    risk: (scenario.risk ?? 1) as 0 | 1 | 2 | 3 | 4 | 5, expectedEvidence: ['observed_state'],
    idempotencyKey: `effect:${scenario.id}`, args: { value: 'verified' },
  };
  const outcome = await runtime.execute({
    runId: `run:${scenario.id}`, now: '2026-01-15T12:00:00.000Z', intent: intent(),
    conditions, proposal, capability, verificationMode,
  });
  const eventTypes = runtime.ledger.forRun(`run:${scenario.id}`).map((event: LedgerEvent) => event.type);
  const missingEvents = scenario.requiredEvents.filter(type => !eventTypes.includes(type));
  const forbiddenEventsObserved = scenario.forbiddenEvents.filter(type => eventTypes.includes(type));
  return {
    id: scenario.id, fault: scenario.fault, expectedStatus: scenario.expectedStatus,
    actualStatus: outcome.status, eventTypes, missingEvents, forbiddenEventsObserved,
    passed: outcome.status === scenario.expectedStatus && missingEvents.length === 0 && forbiddenEventsObserved.length === 0,
    executionReportedSuccess: outcome.execution?.success === true,
  };
}

export async function runRuntimeLab(): Promise<RuntimeLabReport> {
  const definition = fixture();
  const trials = await Promise.all(definition.scenarios.map(scenario => runRuntimeLabScenario(scenario)));
  const falseSuccessCases = trials.filter(trial => trial.fault === 'false_success' || trial.fault === 'stale_observation');
  const uncertain = trials.filter(trial => trial.fault === 'partial_effect' || trial.fault === 'throw' || trial.fault === 'timeout');
  const rate = (items: RuntimeLabTrial[], predicate: (trial: RuntimeLabTrial) => boolean) =>
    items.length ? items.filter(predicate).length / items.length : 1;
  const report: RuntimeLabReport = {
    benchmark: definition.benchmark, version: definition.version, evidenceMode: 'deterministic_fixture', trials,
    metrics: {
      scenarioPassRate: rate(trials, trial => trial.passed),
      falseSuccessPreventionRate: rate(falseSuccessCases, trial => trial.actualStatus !== 'completed'),
      uncertainEffectDisclosureRate: rate(uncertain, trial =>
        trial.eventTypes.includes('effect.reconciled') || trial.eventTypes.includes('effect.reconciliation_failed')
        || trial.eventTypes.includes('action.executed')),
      modelCalls: 0,
    },
    acceptance: { passed: trials.every(trial => trial.passed), requiredRate: 1 },
  };
  return report;
}

export function writeRuntimeLabReport(report: RuntimeLabReport, outputDirectory: string): void {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, 'runtime-lab-latest.json'), `${JSON.stringify(report, null, 2)}\n`);
}
