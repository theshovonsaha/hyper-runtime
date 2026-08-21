import type { EvidenceRef, LedgerEvent } from '@hyper/contracts';
import { pendingInterruptedEffects } from './recovery';

export interface CanonicalTimelineItem {
  id: string;
  sequence: number;
  type: string;
  title: string;
  detail: string;
  provenance: string[];
}

export interface CanonicalContextPass {
  eventId: string;
  sequence: number;
  step?: number;
  packetId?: string;
  phase?: string;
  strategyId?: string;
  includedSourceIds: string[];
  excludedSourceIds: string[];
  audit?: Record<string, unknown>;
  items: unknown[];
  exclusions: unknown[];
  signals: unknown[];
}

export interface CanonicalRunProjection {
  runId: string;
  status: string;
  objective?: string;
  sessionId?: string;
  eventCount: number;
  latestHash?: string;
  timeline: CanonicalTimelineItem[];
  contextPasses: CanonicalContextPass[];
  evidence: EvidenceRef[];
  memoryCommits: Array<{
    eventId: string;
    memoryId?: string;
    content?: string;
    evidenceRefs: string[];
    status: 'active' | 'superseded' | 'deleted';
    supersedes?: string;
    supersededBy?: string;
    createdAt: string;
    kind?: 'fact' | 'constraint' | 'preference' | 'procedure' | 'outcome';
    title?: string;
    salience?: number;
  }>;
  pendingEffects: ReturnType<typeof pendingInterruptedEffects>;
  latestCheckpoint?: Record<string, unknown>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function eventTitle(event: LedgerEvent): string {
  const names: Record<string, string> = {
    'workflow.started': 'Run started',
    'context.compiled': 'Context prepared',
    'model.proposed': 'Model proposed a step',
    'policy.decided': 'Policy checked authority',
    'capability.granted': 'Tool access granted',
    'effect.prepared': 'Effect boundary prepared',
    'action.executed': 'Tool returned',
    'state.observed': 'State observed',
    'action.verified': 'Result verified',
    'workflow.checkpoint': 'Recovery checkpoint saved',
    'workflow.receipt': 'Run finished',
    'memory.verified_outcome_committed': 'Verified memory saved',
    'effect.interruption_detected': 'Interrupted effect found',
    'effect.interruption_resolved': 'Interrupted effect reconciled',
  };
  return names[event.type] ?? event.type.replaceAll('.', ' › ').replaceAll('_', ' ');
}

function eventDetail(event: LedgerEvent): string {
  const payload = event.payload;
  for (const key of ['summary', 'status', 'reason', 'reasonCode', 'capabilityId', 'target', 'phase']) {
    if (typeof payload[key] === 'string') return String(payload[key]);
  }
  return 'Canonical state transition';
}

export function rebuildCanonicalRunProjection(events: readonly LedgerEvent[]): CanonicalRunProjection {
  if (events.length === 0) throw new Error('Cannot rebuild a projection without canonical events.');
  const runId = events[0]!.runId;
  if (events.some(event => event.runId !== runId)) throw new Error('Projection input must contain one run.');
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const started = ordered.find(event => event.type === 'workflow.started' || event.type === 'operator.run_started');
  const terminal = [...ordered].reverse().find(event =>
    event.type === 'workflow.receipt' || event.type === 'operator.run_finished',
  );
  const evidence = new Map<string, EvidenceRef>();
  for (const event of ordered) {
    for (const key of ['evidence', 'evidenceRefs']) {
      const value = event.payload[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (typeof item === 'string') {
          evidence.set(item, { id: item, kind: 'diagnostic', source: event.type });
        } else {
          const candidate = record(item) as EvidenceRef | undefined;
          if (candidate && typeof candidate.id === 'string') evidence.set(candidate.id, candidate);
        }
      }
    }
  }
  const latestCheckpoint = [...ordered].reverse().find(event => event.type === 'workflow.checkpoint');
  const signalsByPacket = new Map(ordered.flatMap(event =>
    event.type === 'context.signals_detected' && typeof event.payload.packetId === 'string'
      ? [[event.payload.packetId, Array.isArray(event.payload.signals) ? event.payload.signals : []] as const]
      : [],
  ));
  const memory = new Map<string, CanonicalRunProjection['memoryCommits'][number]>();
  for (const event of ordered) {
    if (event.type === 'memory.verified_outcome_committed') {
      const memoryId = typeof event.payload.memoryId === 'string' ? event.payload.memoryId : undefined;
      if (memoryId) memory.set(memoryId, {
        eventId: event.hash, memoryId,
        content: typeof event.payload.content === 'string' ? event.payload.content : undefined,
        evidenceRefs: strings(event.payload.evidenceRefs), status: 'active',
        createdAt: typeof event.payload.createdAt === 'string' ? event.payload.createdAt : '1970-01-01T00:00:00.000Z',
        kind: event.payload.kind === 'fact' || event.payload.kind === 'constraint' || event.payload.kind === 'preference'
          || event.payload.kind === 'procedure' || event.payload.kind === 'outcome' ? event.payload.kind : undefined,
        title: typeof event.payload.title === 'string' ? event.payload.title : undefined,
        salience: typeof event.payload.salience === 'number' ? event.payload.salience : undefined,
      });
    } else if (event.type === 'memory.user_superseded') {
      const previousId = typeof event.payload.previousMemoryId === 'string' ? event.payload.previousMemoryId : undefined;
      const memoryId = typeof event.payload.memoryId === 'string' ? event.payload.memoryId : undefined;
      if (previousId && memory.has(previousId)) memory.set(previousId, {
        ...memory.get(previousId)!, status: 'superseded', supersededBy: memoryId,
      });
      if (memoryId) memory.set(memoryId, {
        eventId: event.hash, memoryId,
        content: typeof event.payload.content === 'string' ? event.payload.content : undefined,
        evidenceRefs: strings(event.payload.evidenceRefs), status: 'active', supersedes: previousId,
        createdAt: typeof event.payload.createdAt === 'string' ? event.payload.createdAt : '1970-01-01T00:00:00.000Z',
        kind: event.payload.kind === 'fact' || event.payload.kind === 'constraint' || event.payload.kind === 'preference'
          || event.payload.kind === 'procedure' || event.payload.kind === 'outcome' ? event.payload.kind : undefined,
        title: typeof event.payload.title === 'string' ? event.payload.title : undefined,
        salience: typeof event.payload.salience === 'number' ? event.payload.salience : undefined,
      });
    } else if (event.type === 'memory.user_deleted') {
      const memoryId = typeof event.payload.memoryId === 'string' ? event.payload.memoryId : undefined;
      if (memoryId && memory.has(memoryId)) memory.set(memoryId, { ...memory.get(memoryId)!, status: 'deleted' });
    }
  }
  return {
    runId,
    status: typeof terminal?.payload.status === 'string' ? terminal.payload.status : 'interrupted',
    objective: typeof started?.payload.objective === 'string' ? started.payload.objective : undefined,
    sessionId: typeof started?.payload.sessionId === 'string' ? started.payload.sessionId : undefined,
    eventCount: ordered.length,
    latestHash: ordered.at(-1)?.hash,
    timeline: ordered.map(event => ({
      id: event.hash,
      sequence: event.sequence,
      type: event.type,
      title: eventTitle(event),
      detail: eventDetail(event),
      provenance: [event.hash, event.previousHash],
    })),
    contextPasses: ordered.flatMap(event => event.type === 'context.compiled' ? [{
      eventId: event.hash,
      sequence: event.sequence,
      step: typeof event.payload.step === 'number' ? event.payload.step : undefined,
      packetId: typeof event.payload.packetId === 'string' ? event.payload.packetId : undefined,
      phase: typeof event.payload.phase === 'string' ? event.payload.phase : undefined,
      strategyId: typeof event.payload.strategyId === 'string' ? event.payload.strategyId : undefined,
      includedSourceIds: strings(event.payload.includedSourceIds),
      excludedSourceIds: strings(event.payload.excludedSourceIds),
      audit: record(event.payload.audit),
      items: Array.isArray(event.payload.items) ? structuredClone(event.payload.items) : [],
      exclusions: Array.isArray(event.payload.exclusions) ? structuredClone(event.payload.exclusions) : [],
      signals: typeof event.payload.packetId === 'string'
        ? structuredClone(signalsByPacket.get(event.payload.packetId) ?? []) : [],
    }] : []),
    evidence: [...evidence.values()],
    memoryCommits: [...memory.values()],
    pendingEffects: pendingInterruptedEffects(ordered),
    latestCheckpoint: latestCheckpoint ? structuredClone(latestCheckpoint.payload) : undefined,
  };
}
