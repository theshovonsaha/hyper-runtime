import type { LedgerEvent } from '@hyper/contracts';
import type {
  OperatorRun,
  OperatorSession,
  VerifiedMemoryRecord,
} from './operator-store';

export type RuntimeGraphNodeType =
  | 'session'
  | 'run'
  | 'message'
  | 'memory'
  | 'context'
  | 'source'
  | 'proposal'
  | 'capability'
  | 'verification'
  | 'evidence';

export interface RuntimeGraphNode {
  id: string;
  entityId: string;
  type: RuntimeGraphNodeType;
  label: string;
  detail: string;
  active: boolean;
  canonical: boolean;
  matched?: boolean;
  degree?: number;
  content?: string;
  runId?: string;
  sourceRunId?: string;
  evidenceRefs?: string[];
  supersedes?: string;
  supersededBy?: string;
  kind?: string;
  salience?: number;
  sequence?: number;
  status?: string;
}

export interface RuntimeGraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  label: string;
  canonical: boolean;
}

export interface RuntimeGraphRunInput {
  run: OperatorRun;
  events: readonly LedgerEvent[];
}

export interface RuntimeGraphProjectionInput {
  session: OperatorSession;
  runs: readonly RuntimeGraphRunInput[];
  memory: readonly VerifiedMemoryRecord[];
  query?: string;
  maxNodes?: number;
  maxEdges?: number;
}

const nodePriority: Record<RuntimeGraphNodeType, number> = {
  session: 100,
  run: 95,
  memory: 90,
  verification: 85,
  proposal: 80,
  context: 75,
  capability: 70,
  evidence: 65,
  message: 55,
  source: 50,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function evidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item === 'string' && item) return [item];
    const candidate = record(item);
    return typeof candidate?.id === 'string' && candidate.id ? [candidate.id] : [];
  });
}

function compact(value: string, limit = 110): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function graphId(type: RuntimeGraphNodeType, entityId: string): string {
  return `${type}:${entityId}`;
}

/**
 * Builds a bounded, read-only graph from the operator projection plus canonical
 * run ledgers. The graph never becomes memory, policy, or execution authority.
 */
export function projectRuntimeGraph(input: RuntimeGraphProjectionInput) {
  const nodes = new Map<string, RuntimeGraphNode>();
  const edges = new Map<string, RuntimeGraphEdge>();
  const aliases = new Map<string, string>();
  const addNode = (node: RuntimeGraphNode): RuntimeGraphNode => {
    const current = nodes.get(node.id);
    const next = current ? { ...current, ...node } : node;
    nodes.set(node.id, next);
    aliases.set(node.entityId, node.id);
    return next;
  };
  const addEdge = (edge: Omit<RuntimeGraphEdge, 'id'>): void => {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) return;
    const id = `edge:${edge.type}:${edge.from}:${edge.to}`;
    edges.set(id, { id, ...edge });
  };
  const evidenceNode = (id: string): RuntimeGraphNode => addNode({
    id: graphId('evidence', id),
    entityId: id,
    type: 'evidence',
    label: compact(id, 90),
    detail: 'verified reference',
    active: true,
    canonical: true,
  });

  const sessionNode = addNode({
    id: graphId('session', input.session.id),
    entityId: input.session.id,
    type: 'session',
    label: compact(input.session.title, 90),
    detail: `${input.session.messages.length} messages`,
    active: true,
    canonical: false,
  });

  for (const item of input.runs) {
    const runNode = addNode({
      id: graphId('run', item.run.id),
      entityId: item.run.id,
      type: 'run',
      label: compact(item.run.objective, 100),
      detail: item.run.status,
      status: item.run.status,
      active: item.run.status !== 'error',
      canonical: true,
      runId: item.run.id,
    });
    addEdge({ from: runNode.id, to: sessionNode.id, type: 'belongs_to', label: 'in session', canonical: false });
  }

  for (const message of input.session.messages) {
    const messageNode = addNode({
      id: graphId('message', message.id),
      entityId: message.id,
      type: 'message',
      label: compact(message.content, 90),
      detail: message.role,
      content: message.content,
      active: true,
      canonical: false,
      ...(message.runId ? { runId: message.runId } : {}),
    });
    addEdge({ from: messageNode.id, to: sessionNode.id, type: 'belongs_to', label: 'in session', canonical: false });
    if (message.runId) {
      const runId = aliases.get(message.runId);
      if (runId) addEdge({ from: messageNode.id, to: runId, type: 'from_run', label: 'from run', canonical: false });
    }
  }

  for (const memory of input.memory) {
    const memoryNode = addNode({
      id: graphId('memory', memory.id),
      entityId: memory.id,
      type: 'memory',
      label: compact(memory.title || memory.content, 90),
      detail: `${memory.kind ?? 'outcome'} · ${memory.status}`,
      content: memory.content,
      active: memory.status === 'active',
      canonical: true,
      sourceRunId: memory.sourceRunId,
      evidenceRefs: [...memory.evidenceRefs],
      supersedes: memory.supersedes,
      supersededBy: memory.supersededBy,
      kind: memory.kind,
      salience: memory.salience,
    });
    const runId = aliases.get(memory.sourceRunId);
    if (runId) addEdge({ from: memoryNode.id, to: runId, type: 'derived_from', label: 'from run', canonical: true });
    if (memory.supersedes) {
      const previous = aliases.get(memory.supersedes) ?? graphId('memory', memory.supersedes);
      if (nodes.has(previous)) addEdge({ from: memoryNode.id, to: previous, type: 'supersedes', label: 'replaces', canonical: true });
    }
    for (const reference of memory.evidenceRefs) {
      const evidence = evidenceNode(reference);
      addEdge({ from: memoryNode.id, to: evidence.id, type: 'supported_by', label: 'evidence', canonical: true });
    }
  }

  let canonicalEvents = 0;
  for (const { run, events: runEvents } of input.runs) {
    canonicalEvents += runEvents.length;
    const runNodeId = graphId('run', run.id);
    const contexts = new Map<string, string>();

    for (const event of runEvents.filter(candidate => candidate.type === 'context.compiled')) {
      const packetId = text(event.payload.packetId, `sequence:${event.sequence}`);
      const contextNode = addNode({
        id: graphId('context', `${run.id}:${packetId}`),
        entityId: packetId,
        type: 'context',
        label: `Context · ${text(event.payload.phase, 'pass')} ${event.payload.step ?? ''}`.trim(),
        detail: `${Array.isArray(event.payload.items) ? event.payload.items.length : 0} sources · ~${event.payload.estimatedTokens ?? 0} tokens`,
        content: text(event.payload.objective),
        active: true,
        canonical: true,
        runId: run.id,
        sequence: event.sequence,
      });
      contexts.set(packetId, contextNode.id);
      addEdge({ from: contextNode.id, to: runNodeId, type: 'context_for', label: 'context for', canonical: true });

      const items = Array.isArray(event.payload.items) ? event.payload.items : [];
      for (const rawItem of items) {
        const item = record(rawItem);
        if (!item) continue;
        const sourceId = text(item.sourceId, text(item.id));
        if (!sourceId) continue;
        const sourceNodeId = aliases.get(sourceId);
        const sourceNode = sourceNodeId ? nodes.get(sourceNodeId)! : addNode({
          id: graphId('source', `${run.id}:${sourceId}`),
          entityId: sourceId,
          type: 'source',
          label: compact(text(item.title, sourceId), 90),
          detail: [text(item.authority), text(item.semanticTag), text(item.validity)].filter(Boolean).join(' · ') || 'selected source',
          content: text(item.content),
          active: item.validity !== 'expired',
          canonical: true,
          runId: run.id,
        });
        addEdge({ from: contextNode.id, to: sourceNode.id, type: 'selected_source', label: 'selected', canonical: true });
      }

      for (const capabilityId of strings(event.payload.legalCapabilityIds).slice(0, 32)) {
        const capabilityNode = addNode({
          id: graphId('capability', capabilityId),
          entityId: capabilityId,
          type: 'capability',
          label: compact(capabilityId, 90),
          detail: 'authorized for this pass',
          active: true,
          canonical: true,
        });
        addEdge({ from: contextNode.id, to: capabilityNode.id, type: 'authorized_capability', label: 'may use', canonical: true });
      }
    }

    const proposalIds = new Set<string>();
    for (const event of runEvents.filter(candidate => candidate.type === 'model.proposed')) {
      const proposal = record(event.payload.proposal);
      if (!proposal) continue;
      const action = record(proposal.action);
      const entityId = text(action?.id, `${run.id}:${event.sequence}`);
      proposalIds.add(entityId);
      const kind = text(proposal.kind, 'proposal');
      const policy = runEvents.find(candidate => candidate.type === 'policy.decided' && candidate.payload.proposalId === entityId);
      const status = text(policy?.payload.disposition, kind);
      const risk = typeof action?.risk === 'number' || typeof action?.risk === 'string'
        ? String(action.risk)
        : 'unknown';
      const proposalNode = addNode({
        id: graphId('proposal', `${run.id}:${entityId}`),
        entityId,
        type: 'proposal',
        label: compact(text(proposal.hypothesis, action ? `${kind} · ${text(action.capabilityId)}` : kind), 100),
        detail: action ? `${status} · risk ${risk}` : status,
        content: action ? compact(JSON.stringify(action.args ?? {}), 300) : undefined,
        status,
        active: status !== 'deny',
        canonical: true,
        runId: run.id,
        sequence: event.sequence,
      });
      addEdge({ from: proposalNode.id, to: runNodeId, type: 'proposed_in', label: 'proposed in', canonical: true });
      const packetId = text(event.payload.packetId);
      const contextId = contexts.get(packetId);
      if (contextId) addEdge({ from: proposalNode.id, to: contextId, type: 'informed_by', label: 'informed by', canonical: true });
      const capabilityId = text(action?.capabilityId);
      if (capabilityId) {
        const capabilityNode = addNode({
          id: graphId('capability', capabilityId),
          entityId: capabilityId,
          type: 'capability',
          label: compact(capabilityId, 90),
          detail: 'runtime capability',
          active: true,
          canonical: true,
        });
        addEdge({ from: proposalNode.id, to: capabilityNode.id, type: 'invokes', label: 'invokes', canonical: true });
      }
    }

    for (const event of runEvents.filter(candidate => candidate.type === 'action.proposed')) {
      const entityId = text(event.payload.proposalId, `${run.id}:${event.sequence}`);
      if (proposalIds.has(entityId)) continue;
      const capabilityId = text(event.payload.capabilityId, 'unknown capability');
      const proposalNode = addNode({
        id: graphId('proposal', `${run.id}:${entityId}`),
        entityId,
        type: 'proposal',
        label: compact(`${capabilityId} → ${text(event.payload.target, 'target')}`, 100),
        detail: `${text(event.payload.risk, 'risk unknown')} · runtime proposal`,
        active: true,
        canonical: true,
        runId: run.id,
        sequence: event.sequence,
      });
      addEdge({ from: proposalNode.id, to: runNodeId, type: 'proposed_in', label: 'proposed in', canonical: true });
      const capabilityNode = addNode({
        id: graphId('capability', capabilityId), entityId: capabilityId, type: 'capability', label: capabilityId,
        detail: 'runtime capability', active: true, canonical: true,
      });
      addEdge({ from: proposalNode.id, to: capabilityNode.id, type: 'invokes', label: 'invokes', canonical: true });
    }

    for (const event of runEvents.filter(candidate => candidate.type === 'action.verified')) {
      const entityId = text(event.payload.proposalId, `${run.id}:${event.sequence}`);
      const passed = event.payload.passed === true;
      const verificationNode = addNode({
        id: graphId('verification', `${run.id}:${entityId}`),
        entityId: `${entityId}:verification`,
        type: 'verification',
        label: passed ? 'Outcome verified' : 'Verification failed',
        detail: strings(event.payload.reasonCodes).join(' · ') || (passed ? 'passed' : 'failed'),
        status: passed ? 'passed' : 'failed',
        active: passed,
        canonical: true,
        runId: run.id,
        sequence: event.sequence,
      });
      const proposalNodeId = graphId('proposal', `${run.id}:${entityId}`);
      if (nodes.has(proposalNodeId)) addEdge({ from: verificationNode.id, to: proposalNodeId, type: 'verifies', label: 'verifies', canonical: true });
      else addEdge({ from: verificationNode.id, to: runNodeId, type: 'verifies_run', label: 'verifies', canonical: true });
      for (const reference of evidenceIds(event.payload.evidence)) {
        const evidence = evidenceNode(reference);
        addEdge({ from: verificationNode.id, to: evidence.id, type: 'established_by', label: 'established by', canonical: true });
      }
    }

    for (const event of runEvents.filter(candidate => candidate.type === 'workflow.completion_checked')) {
      const passed = event.payload.passed === true;
      const completionNode = addNode({
        id: graphId('verification', `${run.id}:completion:${event.sequence}`),
        entityId: `completion:${event.sequence}`,
        type: 'verification',
        label: passed ? 'Completion verified' : 'Completion rejected',
        detail: strings(event.payload.reasonCodes).join(' · ') || (passed ? 'passed' : 'rejected'),
        status: passed ? 'passed' : 'failed',
        active: passed,
        canonical: true,
        runId: run.id,
        sequence: event.sequence,
      });
      addEdge({ from: completionNode.id, to: runNodeId, type: 'verifies_run', label: 'verifies run', canonical: true });
      for (const reference of evidenceIds(event.payload.evidence)) {
        const evidence = evidenceNode(reference);
        addEdge({ from: completionNode.id, to: evidence.id, type: 'established_by', label: 'established by', canonical: true });
      }
    }
  }

  const allNodes = [...nodes.values()];
  const allEdges = [...edges.values()];
  const degree = new Map<string, number>();
  for (const edge of allEdges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const query = input.query?.trim().toLocaleLowerCase() ?? '';
  const ranked = allNodes.map(node => ({
    ...node,
    degree: degree.get(node.id) ?? 0,
    matched: !query || `${node.label} ${node.detail} ${node.content ?? ''} ${node.entityId}`.toLocaleLowerCase().includes(query),
  })).sort((a, b) =>
    nodePriority[b.type] - nodePriority[a.type]
    || Number(b.active) - Number(a.active)
    || (b.degree ?? 0) - (a.degree ?? 0)
    || a.id.localeCompare(b.id),
  );
  const maxNodes = Math.min(Math.max(input.maxNodes ?? 500, 25), 1_000);
  const maxEdges = Math.min(Math.max(input.maxEdges ?? 900, 25), 2_000);
  const visibleNodes = ranked.slice(0, maxNodes);
  const visibleIds = new Set(visibleNodes.map(node => node.id));
  const visibleEdges = allEdges.filter(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to)).slice(0, maxEdges);
  const visibleDegree = new Map<string, number>();
  for (const edge of visibleEdges) {
    visibleDegree.set(edge.from, (visibleDegree.get(edge.from) ?? 0) + 1);
    visibleDegree.set(edge.to, (visibleDegree.get(edge.to) ?? 0) + 1);
  }
  const linkedCanonical = visibleNodes.filter(node => node.canonical && (visibleDegree.get(node.id) ?? 0) > 0).length;
  const canonicalNodes = visibleNodes.filter(node => node.canonical).length;

  const count = (type: RuntimeGraphNodeType): number => allNodes.filter(node => node.type === type).length;
  return {
    graph_version: '1.0',
    evidence_class: 'canonical_run_projection',
    session_id: input.session.id,
    nodes: visibleNodes.map(node => ({ ...node, degree: visibleDegree.get(node.id) ?? 0 })),
    edges: visibleEdges,
    counts: {
      memories: input.memory.length,
      active_memories: input.memory.filter(item => item.status === 'active').length,
      runs: input.runs.length,
      messages: input.session.messages.length,
      contexts: count('context'),
      sources: count('source'),
      proposals: count('proposal'),
      capabilities: count('capability'),
      verifications: count('verification'),
      evidence: count('evidence'),
    },
    integrity: {
      canonical_events: canonicalEvents,
      canonical_runs: input.runs.filter(item => item.events.length > 0).length,
      verified_paths: allNodes.filter(node => node.type === 'verification' && node.active).length,
      failed_verifications: allNodes.filter(node => node.type === 'verification' && !node.active).length,
      orphan_edges: visibleEdges.filter(edge => !visibleIds.has(edge.from) || !visibleIds.has(edge.to)).length,
      provenance_coverage: canonicalNodes === 0 ? 1 : linkedCanonical / canonicalNodes,
      truncated: visibleNodes.length < allNodes.length || visibleEdges.length < allEdges.length,
      total_nodes: allNodes.length,
      total_edges: allEdges.length,
      visible_nodes: visibleNodes.length,
      visible_edges: visibleEdges.length,
    },
  };
}
