import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Effect, LedgerEvent } from '@hyper/contracts';

export interface ExperienceActionStep {
  step?: number;
  phase?: string;
  packetId?: string;
  contextItemRefs: string[];
  proposalId: string;
  hypothesis?: string;
  predictedObservation?: string;
  capabilityId?: string;
  target?: string;
  declaredEffects: Effect[];
  policyDisposition?: string;
  policyReasonCodes: string[];
  executed: boolean;
  executionSucceeded?: boolean;
  actionStatus?: string;
  observationRefs: string[];
  verificationPassed?: boolean;
  verificationCodes: string[];
  failureSignature?: string;
  recoveryDecision?: string;
}

export interface ExperienceTrajectory {
  schemaVersion: '1.0.0';
  runId: string;
  objective: string;
  initialStateRefs: string[];
  contextItemRefs: string[];
  steps: ExperienceActionStep[];
  terminalOutcome: string;
  terminalReasonCodes: string[];
  usage: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    latencyMs: number;
    costUsd?: number;
  };
  sourceEventHashes: string[];
  rebuildable: true;
  authority: 'evidence_only';
  containsHiddenReasoning: false;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function evidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item === 'string') return [item];
    const evidence = record(item);
    return typeof evidence?.id === 'string' ? [evidence.id] : [];
  });
}

/** Builds a data-only trajectory from canonical events. It never reads hidden
 * model reasoning and cannot be used as a grant, policy decision, observation,
 * or verification result. */
export function projectExperienceTrajectory(events: readonly LedgerEvent[]): ExperienceTrajectory {
  if (events.length === 0) throw new Error('Experience projection requires canonical events.');
  const runId = events[0]!.runId;
  if (events.some(event => event.runId !== runId)) throw new Error('Experience projection accepts exactly one run.');
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const started = ordered.find(event => event.type === 'workflow.started' || event.type === 'operator.run_started');
  const objective = typeof started?.payload.objective === 'string' ? started.payload.objective : '';
  const contextByPacket = new Map<string, { phase?: string; sourceIds: string[] }>();
  for (const event of ordered.filter(item => item.type === 'context.compiled')) {
    const packetId = typeof event.payload.packetId === 'string' ? event.payload.packetId : undefined;
    if (!packetId) continue;
    contextByPacket.set(packetId, {
      phase: typeof event.payload.phase === 'string' ? event.payload.phase : undefined,
      sourceIds: strings(event.payload.includedSourceIds),
    });
  }
  const steps: ExperienceActionStep[] = [];
  for (const event of ordered.filter(item => item.type === 'model.proposed')) {
    const proposal = record(event.payload.proposal);
    const action = record(proposal?.action);
    if (proposal?.kind !== 'action' || !action || typeof action.id !== 'string') continue;
    const proposalId = action.id;
    const packetId = typeof event.payload.packetId === 'string' ? event.payload.packetId : undefined;
    const context = packetId ? contextByPacket.get(packetId) : undefined;
    const policy = ordered.find(item => item.type === 'policy.decided' && item.payload.proposalId === proposalId);
    const execution = ordered.find(item => item.type === 'action.executed' && item.payload.proposalId === proposalId);
    const observation = ordered.find(item => item.type === 'state.observed' && item.payload.proposalId === proposalId);
    const verification = ordered.find(item => item.type === 'action.verified' && item.payload.proposalId === proposalId);
    const progress = ordered.find(item => item.type === 'workflow.progress_assessed'
      && record(item.payload.causal)?.actionProposalId === proposalId);
    const causal = record(progress?.payload.causal);
    const assessment = record(progress?.payload.progress);
    steps.push({
      step: typeof event.payload.step === 'number' ? event.payload.step : undefined,
      phase: context?.phase,
      packetId,
      contextItemRefs: context?.sourceIds ?? [],
      proposalId,
      hypothesis: typeof proposal.hypothesis === 'string' ? proposal.hypothesis : undefined,
      predictedObservation: typeof proposal.expectedObservation === 'string' ? proposal.expectedObservation : undefined,
      capabilityId: typeof action.capabilityId === 'string' ? action.capabilityId : undefined,
      target: typeof action.target === 'string' ? action.target : undefined,
      declaredEffects: strings(action.declaredEffects) as Effect[],
      policyDisposition: typeof policy?.payload.disposition === 'string' ? policy.payload.disposition : undefined,
      policyReasonCodes: strings(policy?.payload.reasonCodes),
      executed: execution !== undefined,
      executionSucceeded: typeof execution?.payload.success === 'boolean' ? execution.payload.success : undefined,
      actionStatus: typeof causal?.actionStatus === 'string' ? causal.actionStatus : undefined,
      observationRefs: observation
        ? evidenceIds(observation.payload.evidenceRefs).length > 0
          ? evidenceIds(observation.payload.evidenceRefs)
          : evidenceIds(observation.payload.evidence).length > 0
            ? evidenceIds(observation.payload.evidence)
            : [`event:${observation.hash}`]
        : [],
      verificationPassed: typeof verification?.payload.passed === 'boolean' ? verification.payload.passed : undefined,
      verificationCodes: strings(verification?.payload.reasonCodes ?? verification?.payload.verification),
      failureSignature: typeof causal?.failureSignature === 'string' ? causal.failureSignature : undefined,
      recoveryDecision: typeof assessment?.recovery === 'string' ? assessment.recovery : undefined,
    });
  }
  const usages = ordered.flatMap(event => {
    if (event.type !== 'model.proposed' && event.type !== 'response.synthesized') return [];
    if (event.type === 'response.synthesized' && event.payload.generated === false) return [];
    const usage = record(event.payload.usage);
    return usage ? [usage] : [];
  });
  const costs = usages.flatMap(usage => typeof usage.costUsd === 'number' ? [usage.costUsd] : []);
  const terminal = [...ordered].reverse().find(event =>
    event.type === 'workflow.receipt' || event.type === 'operator.run_finished' || event.type === 'operator.run_cancelled');
  const contextItemRefs = [...new Set([...contextByPacket.values()].flatMap(value => value.sourceIds))];
  return {
    schemaVersion: '1.0.0',
    runId,
    objective,
    initialStateRefs: contextByPacket.values().next().value?.sourceIds ?? [],
    contextItemRefs,
    steps,
    terminalOutcome: typeof terminal?.payload.status === 'string'
      ? terminal.payload.status
      : terminal?.type === 'operator.run_cancelled' ? 'cancelled' : 'unknown',
    terminalReasonCodes: strings(terminal?.payload.reasonCodes),
    usage: {
      modelCalls: usages.length,
      inputTokens: usages.reduce((total, usage) => total + number(usage.inputTokens), 0),
      outputTokens: usages.reduce((total, usage) => total + number(usage.outputTokens), 0),
      cachedInputTokens: usages.reduce((total, usage) => total + number(usage.cachedInputTokens), 0),
      reasoningTokens: usages.reduce((total, usage) => total + number(usage.reasoningTokens), 0),
      latencyMs: usages.reduce((total, usage) => total + number(usage.latencyMs), 0),
      ...(costs.length === usages.length && usages.length > 0
        ? { costUsd: costs.reduce((total, cost) => total + cost, 0) }
        : {}),
    },
    sourceEventHashes: ordered.map(event => event.hash),
    rebuildable: true,
    authority: 'evidence_only',
    containsHiddenReasoning: false,
  };
}

export function projectExperienceDataset(events: readonly LedgerEvent[]): ExperienceTrajectory[] {
  const byRun = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    const run = byRun.get(event.runId) ?? [];
    run.push(event);
    byRun.set(event.runId, run);
  }
  return [...byRun.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([, run]) => projectExperienceTrajectory(run));
}

export function writeExperienceDataset(path: string, trajectories: readonly ExperienceTrajectory[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, trajectories.map(trajectory => JSON.stringify(trajectory)).join('\n') + (trajectories.length ? '\n' : ''), 'utf8');
}
