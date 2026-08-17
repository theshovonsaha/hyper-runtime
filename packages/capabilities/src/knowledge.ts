import type {
  ActionProposal,
  CapabilityAdapter,
  CapabilityExecution,
  CapabilityGrant,
  CapabilityManifest,
  Observation,
  VerificationResult,
} from '@hyper/contracts';
import { digest, validateGrant } from './shared';

export interface KnowledgeSearchArgs extends Record<string, unknown> {
  query: string;
  maxResults?: number;
  temporalReference?: string;
}

export interface KnowledgeSearchItem {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  retrievalMode: 'hybrid' | 'lexical';
  provenance: string[];
}

export interface KnowledgeSearchObservation {
  sessionId: string;
  query: string;
  results: KnowledgeSearchItem[];
  embeddingAvailable: boolean;
  limitation?: string;
}

export type KnowledgeSearchFunction = (input: {
  sessionId: string;
  query: string;
  maxResults: number;
  temporalReference?: string;
}) => Promise<KnowledgeSearchObservation>;

function targetSession(target: string): string | undefined {
  try {
    const url = new URL(target);
    if (url.protocol !== 'session:' || url.hostname !== 'knowledge') return undefined;
    const sessionId = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return sessionId || undefined;
  } catch {
    return undefined;
  }
}

export class SessionKnowledgeSearchCapability implements CapabilityAdapter<KnowledgeSearchArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'session.knowledge.search',
    version: '0.2.0',
    description: 'Search uploaded files in the authorized session using bounded hybrid, temporal, and relationship retrieval.',
    effects: ['state.read'],
    requiredEffects: ['state.read'],
    targetPatterns: ['session://knowledge/**'],
    riskCeiling: 1,
    approval: 'never',
    idempotent: true,
    verification: 'required',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'integer' },
        temporalReference: { type: 'string' },
      },
      additionalProperties: false,
    },
  };

  private readonly executions = new Map<string, KnowledgeSearchObservation>();

  constructor(private readonly search: KnowledgeSearchFunction) {}

  async execute(
    proposal: ActionProposal<KnowledgeSearchArgs>,
    grant: CapabilityGrant,
  ): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'state.read');
    if (invalid) return invalid;
    const sessionId = targetSession(proposal.target);
    const query = typeof proposal.args.query === 'string' ? proposal.args.query.trim().slice(0, 2_000) : '';
    if (!sessionId || !query) return {
      success: false,
      summary: 'Knowledge search requires a session://knowledge/{session-id} target and a non-empty query.',
      errorCode: 'KNOWLEDGE_SEARCH_INVALID',
      evidence: [],
    };
    const maxResults = typeof proposal.args.maxResults === 'number' && Number.isInteger(proposal.args.maxResults)
      ? Math.min(16, Math.max(1, proposal.args.maxResults))
      : 8;
    try {
      const observation = await this.search({
        sessionId,
        query,
        maxResults,
        ...(typeof proposal.args.temporalReference === 'string'
          ? { temporalReference: proposal.args.temporalReference.slice(0, 100) }
          : {}),
      });
      if (observation.sessionId !== sessionId || observation.query !== query) throw new Error('Search result identity mismatch.');
      this.executions.set(proposal.id, observation);
      return {
        success: true,
        summary: `Session knowledge search returned ${observation.results.length} provenance-linked chunk${observation.results.length === 1 ? '' : 's'} using ${observation.embeddingAvailable ? 'hybrid' : 'degraded lexical'} retrieval.`,
        evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: digest(observation) }],
      };
    } catch (error) {
      return {
        success: false,
        summary: error instanceof Error ? error.message : String(error),
        errorCode: 'KNOWLEDGE_SEARCH_FAILED',
        evidence: [],
      };
    }
  }

  async observe(proposal: ActionProposal<KnowledgeSearchArgs>): Promise<Observation> {
    const prior = this.executions.get(proposal.id);
    if (!prior) return { target: proposal.target, exists: false, evidence: [] };
    const observed = await this.search({
      sessionId: prior.sessionId,
      query: prior.query,
      maxResults: Math.max(1, prior.results.length || 8),
      ...(typeof proposal.args.temporalReference === 'string'
        ? { temporalReference: proposal.args.temporalReference.slice(0, 100) }
        : {}),
    });
    return {
      target: proposal.target,
      exists: true,
      value: observed,
      evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(observed) }],
    };
  }

  async verify(
    proposal: ActionProposal<KnowledgeSearchArgs>,
    execution: CapabilityExecution,
    observation: Observation,
  ): Promise<VerificationResult> {
    const executed = this.executions.get(proposal.id);
    const observed = observation.value as KnowledgeSearchObservation | undefined;
    const observedIds = new Set(observed?.results.map(result => result.chunkId) ?? []);
    const stableIdentity = executed?.results.every(result => observedIds.has(result.chunkId)) ?? false;
    const passed = execution.success && observation.exists && !!executed && !!observed
      && executed.sessionId === observed.sessionId && executed.query === observed.query && stableIdentity;
    return {
      passed,
      reasonCodes: passed
        ? ['SESSION_KNOWLEDGE_SEARCH_REPRODUCED', executed.embeddingAvailable ? 'HYBRID_RETRIEVAL_ACTIVE' : 'EMBEDDING_UNAVAILABLE_DEGRADED_MODE']
        : ['SESSION_KNOWLEDGE_SEARCH_NOT_VERIFIED'],
      evidence: observation.evidence,
      ...(passed ? { establishes: ['The authorized session knowledge index was searched and result identities were reproduced.'] } : {}),
    };
  }
}
