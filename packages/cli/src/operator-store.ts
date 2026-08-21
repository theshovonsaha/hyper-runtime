import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export interface OperatorMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  runId?: string;
  evidenceRefs?: string[];
  caveats?: string[];
}

export interface SessionHistoryCompaction {
  summary: string;
  sourceMessageIds: string[];
  retained: OperatorMessage[];
  digest: string;
  omittedCount: number;
}

/** Deterministic, provenance-preserving projection. The source messages remain
 * canonical and the projection can be rebuilt or audited by digest. */
export function compactSessionMessages(
  messages: OperatorMessage[],
  maxRecentMessages = 12,
  maxRecentCharacters = 8_000,
  maxSummaryCharacters = 4_000,
): SessionHistoryCompaction {
  const retained = messages.slice(-Math.max(1, maxRecentMessages));
  while (
    retained.length > 1
    && retained.reduce((total, message) => total + message.content.length, 0) > maxRecentCharacters
  ) retained.shift();
  const retainedIds = new Set(retained.map(message => message.id));
  const omitted = messages.filter(message => !retainedIds.has(message.id));
  const entries = omitted.map(message =>
    `${message.role === 'user' ? 'Operator' : 'Assistant'}: ${message.content.replace(/\s+/g, ' ').trim().slice(0, 280)}`,
  );
  let summary = entries.join('\n');
  if (summary.length > maxSummaryCharacters) {
    const head = summary.slice(0, Math.floor(maxSummaryCharacters / 2));
    const tail = summary.slice(-Math.floor(maxSummaryCharacters / 2));
    summary = `${head}\n… ${omitted.length} earlier messages compacted …\n${tail}`;
  }
  const sourceMessageIds = omitted.map(message => message.id);
  return {
    summary,
    sourceMessageIds,
    retained: retained.map(message => structuredClone(message)),
    digest: createHash('sha256').update(JSON.stringify(omitted)).digest('hex'),
    omittedCount: omitted.length,
  };
}

export interface OperatorSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: OperatorMessage[];
  agent?: OperatorSessionAgent;
  embeddingProfileId?: string;
  embeddingLockedAt?: string;
  parentSessionId?: string;
  branchedFromMessageId?: string;
}

export interface OperatorSessionAgent {
  autonomous: boolean;
  autoMode?: boolean;
  autoMaxSteps?: number;
  profile?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max';
  routingMode?: 'fallback' | 'round_robin' | 'ping_pong' | 'ring' | 'ring_pair';
  fallbackProviders: string[];
  routingRoutes?: Array<{ provider: string; model: string }>;
  instructions?: string;
  updatedAt: string;
}

export interface OperatorRun {
  id: string;
  sessionId: string;
  objective: string;
  status: string;
  profile: string;
  provider: string;
  model?: string;
  startedAt: string;
  endedAt?: string;
  receiptHash?: string;
  evidenceRefs: string[];
  resumedFromRunId?: string;
  labExperimentId?: string;
  labAgentId?: string;
  labModules?: string[];
}

export interface SessionArtifactRecord {
  id: string;
  sessionId: string;
  runId: string;
  proposalId: string;
  capabilityId: string;
  target: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  evidenceRefs: string[];
  createdAt: string;
  verified: true;
}

export interface VerifiedMemoryRecord {
  id: string;
  sourceRunId: string;
  sessionId: string;
  content: string;
  evidenceRefs: string[];
  createdAt: string;
  status: 'active' | 'superseded' | 'deleted';
  supersedes?: string;
  supersededBy?: string;
  editedByUser?: boolean;
  kind?: 'fact' | 'constraint' | 'preference' | 'procedure' | 'outcome';
  title?: string;
  salience?: number;
}

export interface MemoryRecallResult {
  record: VerifiedMemoryRecord;
  score: number;
  reasons: string[];
}

export interface CustomHttpToolDefinition {
  id: string;
  name: string;
  description: string;
  host: string;
  pathPrefix: string;
  enabled: boolean;
  createdAt: string;
}

export interface OperatorSchedule {
  id: string;
  prompt: string;
  profile: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  intervalMinutes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  lastRunId?: string;
  lastStatus?: string;
}

export interface CorrectionCandidate {
  id: string;
  observed: string;
  mismatch: string;
  correction: string;
  reusableRule: string;
  triggerCodes: string[];
  status: 'candidate' | 'accepted_for_experiment' | 'rejected';
  createdAt: string;
  updatedAt: string;
  sourceRunId?: string;
  sessionId?: string;
}

export interface SessionSearchResult {
  documentId: string;
  sessionId: string;
  kind: 'message' | 'memory';
  content: string;
  score: number;
  provenance: string[];
  createdAt: string;
}

export type SessionFileStatus = 'ready' | 'limited' | 'failed';

export interface SessionFileRecord {
  id: string;
  ingestionId: string;
  sessionId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  createdAt: string;
  status: SessionFileStatus;
  retrievalMode: 'hybrid' | 'lexical' | 'metadata_only';
  chunkIds: string[];
  embeddingModel?: string;
  embeddingProfileId?: string;
  limitation?: string;
  validFrom?: string;
  validTo?: string;
}

export interface SessionKnowledgeChunk {
  id: string;
  documentId: string;
  sessionId: string;
  ordinal: number;
  content: string;
  createdAt: string;
  provenance: string[];
  terms: Record<string, number>;
  entities: string[];
  embedding?: number[];
  validFrom?: string;
  validTo?: string;
}

export interface SessionKnowledgeEdge {
  id: string;
  sessionId: string;
  sourceChunkId: string;
  targetChunkId: string;
  relation: 'shared_entity' | 'same_document' | 'follows';
  label?: string;
  evidenceRefs: string[];
  createdAt: string;
}

export interface KnowledgeSearchResult {
  chunkId: string;
  documentId: string;
  sessionId: string;
  fileName: string;
  content: string;
  score: number;
  lexicalScore: number;
  semanticScore?: number;
  temporalScore: number;
  relationshipScore: number;
  retrievalMode: 'hybrid' | 'lexical';
  reasons: string[];
  provenance: string[];
  createdAt: string;
}

interface SessionSearchDocument extends Omit<SessionSearchResult, 'score'> {
  terms: Record<string, number>;
  active: boolean;
}

interface OperatorState {
  version: 5;
  sessions: OperatorSession[];
  runs: OperatorRun[];
  memory: VerifiedMemoryRecord[];
  customTools: CustomHttpToolDefinition[];
  schedules: OperatorSchedule[];
  correctionCandidates: CorrectionCandidate[];
  searchDocuments: SessionSearchDocument[];
  searchIndex: Record<string, string[]>;
  sessionFiles: SessionFileRecord[];
  knowledgeChunks: SessionKnowledgeChunk[];
  knowledgeEdges: SessionKnowledgeEdge[];
  artifacts: SessionArtifactRecord[];
}

function initialState(): OperatorState {
  return {
    version: 5,
    sessions: [],
    runs: [],
    memory: [],
    customTools: [],
    schedules: [],
    correctionCandidates: [],
    searchDocuments: [],
    searchIndex: {},
    sessionFiles: [],
    knowledgeChunks: [],
    knowledgeEdges: [],
    artifacts: [],
  };
}

function terms(content: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const term of content.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []) {
    result[term] = (result[term] ?? 0) + 1;
  }
  return result;
}

const KNOWLEDGE_STOP_WORDS = new Set([
  'about', 'after', 'also', 'because', 'before', 'being', 'between', 'could', 'from', 'have',
  'into', 'more', 'only', 'other', 'should', 'that', 'their', 'there', 'these', 'they', 'this',
  'through', 'using', 'were', 'what', 'when', 'where', 'which', 'with', 'would', 'your',
]);

function entities(content: string): string[] {
  const frequencies = terms(content);
  return Object.entries(frequencies)
    .filter(([term]) => term.length >= 4 && !KNOWLEDGE_STOP_WORDS.has(term))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, 16)
    .map(([term]) => term);
}

function cosine(left?: number[], right?: number[]): number | undefined {
  if (!left || !right || left.length === 0 || left.length !== right.length) return undefined;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return undefined;
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

function freshness(createdAt: string, now: string): number {
  const ageDays = Math.max(0, (Date.parse(now) - Date.parse(createdAt)) / 86_400_000);
  return Number.isFinite(ageDays) ? Math.exp(-ageDays / 180) : 0;
}

function rebuildSearchIndex(documents: SessionSearchDocument[]): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const document of documents) {
    if (!document.active) continue;
    for (const term of Object.keys(document.terms)) (index[term] ??= []).push(document.documentId);
  }
  return index;
}

function migratedSearchDocuments(candidate: Record<string, unknown>): SessionSearchDocument[] {
  if (Array.isArray(candidate.searchDocuments)) return candidate.searchDocuments as SessionSearchDocument[];
  const sessions = Array.isArray(candidate.sessions) ? candidate.sessions as OperatorSession[] : [];
  const memory = Array.isArray(candidate.memory) ? candidate.memory as VerifiedMemoryRecord[] : [];
  return [
    ...sessions.flatMap(session => session.messages.map(message => ({
      documentId: message.id,
      sessionId: session.id,
      kind: 'message' as const,
      content: message.content,
      provenance: [message.id, ...(message.runId ? [message.runId] : []), ...(message.evidenceRefs ?? [])],
      createdAt: message.at,
      terms: terms(message.content),
      active: true,
    }))),
    ...memory.map(record => ({
      documentId: record.id,
      sessionId: record.sessionId,
      kind: 'memory' as const,
      content: record.content,
      provenance: [record.sourceRunId, ...record.evidenceRefs],
      createdAt: record.createdAt,
      terms: terms(record.content),
      active: record.status === 'active',
    })),
  ];
}

function loadState(value: unknown): OperatorState {
  if (typeof value !== 'object' || value === null) return initialState();
  const candidate = value as Record<string, unknown>;
  if (![1, 2, 3, 4, 5].includes(Number(candidate.version))) return initialState();
  const searchDocuments = migratedSearchDocuments(candidate);
  return {
    version: 5,
    sessions: Array.isArray(candidate.sessions) ? candidate.sessions as OperatorSession[] : [],
    runs: Array.isArray(candidate.runs) ? candidate.runs as OperatorRun[] : [],
    memory: Array.isArray(candidate.memory) ? candidate.memory as VerifiedMemoryRecord[] : [],
    customTools: Array.isArray(candidate.customTools)
      ? candidate.customTools as CustomHttpToolDefinition[]
      : [],
    schedules: Array.isArray(candidate.schedules) ? candidate.schedules as OperatorSchedule[] : [],
    correctionCandidates: Array.isArray(candidate.correctionCandidates)
      ? candidate.correctionCandidates as CorrectionCandidate[]
      : [],
    searchDocuments,
    searchIndex: rebuildSearchIndex(searchDocuments),
    sessionFiles: Array.isArray(candidate.sessionFiles) ? candidate.sessionFiles as SessionFileRecord[] : [],
    knowledgeChunks: Array.isArray(candidate.knowledgeChunks) ? candidate.knowledgeChunks as SessionKnowledgeChunk[] : [],
    knowledgeEdges: Array.isArray(candidate.knowledgeEdges) ? candidate.knowledgeEdges as SessionKnowledgeEdge[] : [],
    artifacts: Array.isArray(candidate.artifacts) ? candidate.artifacts as SessionArtifactRecord[] : [],
  };
}

export class JsonOperatorStore {
  private state: OperatorState;
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    try {
      this.state = loadState(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      this.state = initialState();
    }
  }

  private commit(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.path);
  }

  ensureSession(id: string, now: string, firstMessage?: string): OperatorSession {
    let session = this.state.sessions.find(item => item.id === id);
    if (!session) {
      session = {
        id,
        title: firstMessage?.trim().slice(0, 60) || 'New chat',
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      this.state.sessions.unshift(session);
      this.commit();
    }
    return structuredClone(session);
  }

  appendMessage(sessionId: string, message: OperatorMessage): void {
    const session = this.state.sessions.find(item => item.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}.`);
    if (session.messages.some(item => item.id === message.id)) return;
    session.messages.push(structuredClone(message));
    this.indexDocument({
      documentId: message.id,
      sessionId,
      kind: 'message',
      content: message.content,
      provenance: [message.id, ...(message.runId ? [message.runId] : []), ...(message.evidenceRefs ?? [])],
      createdAt: message.at,
      terms: terms(message.content),
      active: true,
    });
    session.updatedAt = message.at;
    if (message.role === 'user' && session.messages.filter(item => item.role === 'user').length === 1) {
      session.title = message.content.trim().slice(0, 60) || session.title;
    }
    this.commit();
  }

  listSessions(): Array<Omit<OperatorSession, 'messages'> & { messageCount: number }> {
    return this.state.sessions
      .map(({ messages, ...session }) => ({ ...session, messageCount: messages.length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  session(sessionId: string): OperatorSession | undefined {
    const session = this.state.sessions.find(item => item.id === sessionId);
    return session ? structuredClone(session) : undefined;
  }

  messages(sessionId: string): OperatorMessage[] | undefined {
    return structuredClone(this.state.sessions.find(item => item.id === sessionId)?.messages);
  }

  recentMessages(
    sessionId: string,
    options: { maxMessages?: number; maxCharacters?: number; excludeRunId?: string } = {},
  ): OperatorMessage[] {
    const session = this.state.sessions.find(item => item.id === sessionId);
    if (!session) return [];
    const maxMessages = Math.max(1, options.maxMessages ?? 12);
    const maxCharacters = Math.max(1, options.maxCharacters ?? 8_000);
    const retained: OperatorMessage[] = [];
    let characters = 0;
    for (let index = session.messages.length - 1; index >= 0 && retained.length < maxMessages; index -= 1) {
      const message = session.messages[index]!;
      if (options.excludeRunId && message.runId === options.excludeRunId) continue;
      if (retained.length > 0 && characters + message.content.length > maxCharacters) break;
      retained.unshift(message);
      characters += message.content.length;
    }
    return structuredClone(retained);
  }

  branchSession(input: {
    sourceSessionId: string;
    messageId: string;
    newSessionId: string;
    now: string;
  }): OperatorSession {
    const source = this.state.sessions.find(item => item.id === input.sourceSessionId);
    if (!source) throw new Error(`Unknown session ${input.sourceSessionId}.`);
    const messageIndex = source.messages.findIndex(message => message.id === input.messageId);
    if (messageIndex < 0) throw new Error(`Unknown message ${input.messageId}.`);
    const priorMessages = source.messages.slice(0, messageIndex).map(message => structuredClone(message));
    const session: OperatorSession = {
      id: input.newSessionId,
      title: source.title,
      createdAt: input.now,
      updatedAt: input.now,
      messages: priorMessages,
      parentSessionId: source.id,
      branchedFromMessageId: input.messageId,
      ...(source.agent ? { agent: structuredClone(source.agent) } : {}),
      ...(source.embeddingProfileId ? { embeddingProfileId: source.embeddingProfileId } : {}),
    };
    this.state.sessions.unshift(session);
    for (const message of priorMessages) this.indexDocument({
      documentId: `${message.id}:branch:${input.newSessionId}`,
      sessionId: input.newSessionId,
      kind: 'message',
      content: message.content,
      provenance: [message.id, input.messageId, ...(message.runId ? [message.runId] : [])],
      createdAt: message.at,
      terms: terms(message.content),
      active: true,
    });
    this.commit();
    return structuredClone(session);
  }

  deleteSession(sessionId: string): {
    session: OperatorSession;
    files: SessionFileRecord[];
    runIds: string[];
  } | undefined {
    const session = this.state.sessions.find(item => item.id === sessionId);
    if (!session) return undefined;
    const files = this.state.sessionFiles.filter(file => file.sessionId === sessionId);
    const fileIds = new Set(files.map(file => file.id));
    const chunkIds = new Set(this.state.knowledgeChunks
      .filter(chunk => chunk.sessionId === sessionId || fileIds.has(chunk.documentId))
      .map(chunk => chunk.id));
    const runIds = this.state.runs.filter(run => run.sessionId === sessionId).map(run => run.id);
    this.state.sessions = this.state.sessions.filter(item => item.id !== sessionId);
    this.state.runs = this.state.runs.filter(run => run.sessionId !== sessionId);
    this.state.memory = this.state.memory.filter(record => record.sessionId !== sessionId);
    this.state.searchDocuments = this.state.searchDocuments.filter(document => document.sessionId !== sessionId);
    this.state.searchIndex = rebuildSearchIndex(this.state.searchDocuments);
    this.state.sessionFiles = this.state.sessionFiles.filter(file => file.sessionId !== sessionId);
    this.state.knowledgeChunks = this.state.knowledgeChunks.filter(chunk => chunk.sessionId !== sessionId);
    this.state.knowledgeEdges = this.state.knowledgeEdges.filter(edge =>
      edge.sessionId !== sessionId
      && !chunkIds.has(edge.sourceChunkId)
      && !chunkIds.has(edge.targetChunkId),
    );
    this.state.artifacts = this.state.artifacts.filter(artifact => artifact.sessionId !== sessionId);
    this.commit();
    return { session: structuredClone(session), files: structuredClone(files), runIds };
  }

  configureSessionAgent(sessionId: string, agent: OperatorSessionAgent): OperatorSessionAgent {
    const session = this.state.sessions.find(item => item.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}.`);
    session.agent = structuredClone(agent);
    session.updatedAt = agent.updatedAt;
    this.commit();
    return structuredClone(agent);
  }

  configureSessionEmbedding(sessionId: string, profileId: string, at: string, lock = false): OperatorSession {
    const session = this.state.sessions.find(item => item.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}.`);
    session.embeddingProfileId = profileId;
    if (lock) session.embeddingLockedAt ??= at;
    session.updatedAt = at;
    this.commit();
    return structuredClone(session);
  }

  recordRun(run: OperatorRun): void {
    const index = this.state.runs.findIndex(item => item.id === run.id);
    if (index >= 0) this.state.runs[index] = structuredClone(run);
    else this.state.runs.unshift(structuredClone(run));
    this.commit();
  }

  addArtifact(record: SessionArtifactRecord): SessionArtifactRecord {
    const existing = this.state.artifacts.find(item => item.id === record.id);
    if (existing) return structuredClone(existing);
    if (!this.state.sessions.some(session => session.id === record.sessionId)) {
      throw new Error(`Unknown session ${record.sessionId}.`);
    }
    this.state.artifacts.unshift(structuredClone(record));
    this.commit();
    return structuredClone(record);
  }

  listArtifacts(sessionId: string): SessionArtifactRecord[] {
    return structuredClone(this.state.artifacts
      .filter(artifact => artifact.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  listRuns(sessionId?: string): OperatorRun[] {
    return structuredClone(this.state.runs.filter(run => !sessionId || run.sessionId === sessionId));
  }

  run(runId: string): OperatorRun | undefined {
    return structuredClone(this.state.runs.find(run => run.id === runId));
  }

  commitMemory(record: VerifiedMemoryRecord): void {
    if (this.state.memory.some(item => item.id === record.id)) return;
    this.state.memory.unshift(structuredClone(record));
    this.indexDocument({
      documentId: record.id,
      sessionId: record.sessionId,
      kind: 'memory',
      content: record.content,
      provenance: [record.sourceRunId, ...record.evidenceRefs],
      createdAt: record.createdAt,
      terms: terms(record.content),
      active: true,
    });
    this.commit();
  }

  listMemory(sessionId?: string, includeDeleted = false): VerifiedMemoryRecord[] {
    return structuredClone(this.state.memory.filter(item =>
      (!sessionId || item.sessionId === sessionId)
      && (includeDeleted || item.status === 'active'),
    ));
  }

  /** Deterministic, session-local active recall. It combines lexical relevance
   * with explicit salience and a small recency prior; it never asks a model to
   * preprocess memory and never returns another session's records. */
  recallMemory(sessionId: string, query: string, limit = 8): MemoryRecallResult[] {
    const lexical = new Map(
      this.searchSession(sessionId, query, 50)
        .filter(result => result.kind === 'memory')
        .map(result => [result.documentId, result.score]),
    );
    const active = this.state.memory.filter(record => record.sessionId === sessionId && record.status === 'active');
    return active.map((record, index) => {
      const lexicalScore = lexical.get(record.id) ?? 0;
      const salience = Math.min(1, Math.max(0, record.salience ?? 0.5));
      const recency = 1 / (index + 1);
      const durableKind = record.kind === 'constraint' || record.kind === 'preference' || record.kind === 'procedure';
      const score = lexicalScore * 2 + salience + recency * 0.35 + (durableKind ? 0.35 : 0);
      const reasons = [
        ...(lexicalScore > 0 ? ['query-match'] : []),
        ...(salience >= 0.75 ? ['high-salience'] : []),
        ...(durableKind ? ['standing-memory'] : []),
        ...(index < 3 ? ['recent'] : []),
      ];
      return { record: structuredClone(record), score, reasons };
    }).filter(result => result.score > 0.7 || lexical.has(result.record.id))
      .sort((a, b) => b.score - a.score || b.record.createdAt.localeCompare(a.record.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 24));
  }

  /** Replaces the cache from canonical memory events. This store remains a
   * query projection; it is not the durable semantic source of truth. */
  rebuildMemoryProjection(records: VerifiedMemoryRecord[]): void {
    this.state.memory = structuredClone(records);
    this.state.searchDocuments = this.state.searchDocuments.filter(document => document.kind !== 'memory');
    for (const record of records) {
      this.state.searchDocuments.push({
        documentId: record.id,
        sessionId: record.sessionId,
        kind: 'memory',
        content: record.content,
        provenance: [record.sourceRunId, ...(record.supersedes ? [record.supersedes] : []), ...record.evidenceRefs],
        createdAt: record.createdAt,
        terms: terms(record.content),
        active: record.status === 'active',
      });
    }
    this.state.searchIndex = rebuildSearchIndex(this.state.searchDocuments);
    this.commit();
  }

  deleteMemory(id: string): boolean {
    const record = this.state.memory.find(item => item.id === id && item.status === 'active');
    if (!record) return false;
    record.status = 'deleted';
    const document = this.state.searchDocuments.find(item => item.documentId === id);
    if (document) document.active = false;
    this.state.searchIndex = rebuildSearchIndex(this.state.searchDocuments);
    this.commit();
    return true;
  }

  supersedeMemory(id: string, replacement: VerifiedMemoryRecord): VerifiedMemoryRecord | undefined {
    const current = this.state.memory.find(item => item.id === id && item.status === 'active');
    if (!current || replacement.sessionId !== current.sessionId) return undefined;
    current.status = 'superseded';
    current.supersededBy = replacement.id;
    const currentDocument = this.state.searchDocuments.find(item => item.documentId === id);
    if (currentDocument) currentDocument.active = false;
    const next = { ...structuredClone(replacement), supersedes: id };
    this.state.memory.unshift(next);
    this.indexDocument({
      documentId: next.id,
      sessionId: next.sessionId,
      kind: 'memory',
      content: next.content,
      provenance: [next.sourceRunId, id, ...next.evidenceRefs],
      createdAt: next.createdAt,
      terms: terms(next.content),
      active: true,
    });
    this.state.searchIndex = rebuildSearchIndex(this.state.searchDocuments);
    this.commit();
    return structuredClone(next);
  }

  private indexDocument(document: SessionSearchDocument): void {
    const index = this.state.searchDocuments.findIndex(item => item.documentId === document.documentId);
    if (index >= 0) this.state.searchDocuments[index] = structuredClone(document);
    else this.state.searchDocuments.push(structuredClone(document));
    this.state.searchIndex = rebuildSearchIndex(this.state.searchDocuments);
  }

  searchSession(sessionId: string, query: string, limit = 8): SessionSearchResult[] {
    const queryTerms = Object.keys(terms(query));
    if (queryTerms.length === 0) return [];
    const documentIds = new Set(queryTerms.flatMap(term => this.state.searchIndex[term] ?? []));
    const documents = this.state.searchDocuments.filter(document =>
      document.active && document.sessionId === sessionId && documentIds.has(document.documentId),
    );
    const total = Math.max(this.state.searchDocuments.filter(document => document.active && document.sessionId === sessionId).length, 1);
    return documents.map(document => {
      const score = queryTerms.reduce((sum, term) => {
        const frequency = document.terms[term] ?? 0;
        const documentFrequency = (this.state.searchIndex[term] ?? []).length;
        return sum + frequency * Math.log(1 + total / Math.max(documentFrequency, 1));
      }, 0);
      const { terms: _terms, active: _active, ...result } = document;
      return { ...result, score };
    }).sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(Math.max(limit, 1), 50));
  }

  addSessionFile(
    record: SessionFileRecord,
    chunks: Array<Omit<SessionKnowledgeChunk, 'terms' | 'entities'>>,
  ): SessionFileRecord {
    if (!this.state.sessions.some(session => session.id === record.sessionId)) {
      throw new Error(`Unknown session ${record.sessionId}.`);
    }
    if (this.state.sessionFiles.some(file => file.id === record.id)) {
      return structuredClone(this.state.sessionFiles.find(file => file.id === record.id)!);
    }
    const normalized = chunks.slice(0, 2_000).map(chunk => ({
      ...structuredClone(chunk),
      terms: terms(chunk.content),
      entities: entities(chunk.content),
    }));
    const prior = this.state.knowledgeChunks
      .filter(chunk => chunk.sessionId === record.sessionId)
      .slice(-256);
    const edges: SessionKnowledgeEdge[] = [];
    for (const chunk of normalized) {
      if (chunk.ordinal > 0) {
        const previous = normalized.find(item => item.ordinal === chunk.ordinal - 1);
        if (previous) edges.push({
          id: `edge:${previous.id}:${chunk.id}:follows`,
          sessionId: record.sessionId,
          sourceChunkId: previous.id,
          targetChunkId: chunk.id,
          relation: 'follows',
          evidenceRefs: [record.id, previous.id, chunk.id],
          createdAt: record.createdAt,
        });
      }
      for (const candidate of [...prior, ...normalized.filter(item => item.ordinal < chunk.ordinal)]) {
        const shared = chunk.entities.filter(entity => candidate.entities.includes(entity)).slice(0, 3);
        for (const label of shared) edges.push({
          id: `edge:${candidate.id}:${chunk.id}:${label}`,
          sessionId: record.sessionId,
          sourceChunkId: candidate.id,
          targetChunkId: chunk.id,
          relation: candidate.documentId === chunk.documentId ? 'same_document' : 'shared_entity',
          label,
          evidenceRefs: [candidate.documentId, record.id, candidate.id, chunk.id],
          createdAt: record.createdAt,
        });
        if (edges.length >= 4_000) break;
      }
    }
    this.state.sessionFiles.unshift(structuredClone(record));
    this.state.knowledgeChunks.push(...normalized);
    const knownEdgeIds = new Set(this.state.knowledgeEdges.map(edge => edge.id));
    this.state.knowledgeEdges.push(...edges.filter(edge => !knownEdgeIds.has(edge.id)));
    this.commit();
    return structuredClone(record);
  }

  listSessionFiles(sessionId: string): SessionFileRecord[] {
    return structuredClone(this.state.sessionFiles
      .filter(file => file.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  deleteSessionFile(sessionId: string, fileId: string): SessionFileRecord | undefined {
    const record = this.state.sessionFiles.find(file => file.id === fileId && file.sessionId === sessionId);
    if (!record) return undefined;
    const chunkIds = new Set(record.chunkIds);
    this.state.sessionFiles = this.state.sessionFiles.filter(file => file.id !== fileId);
    this.state.knowledgeChunks = this.state.knowledgeChunks.filter(chunk => !chunkIds.has(chunk.id));
    this.state.knowledgeEdges = this.state.knowledgeEdges.filter(edge =>
      !chunkIds.has(edge.sourceChunkId) && !chunkIds.has(edge.targetChunkId),
    );
    this.commit();
    return structuredClone(record);
  }

  knowledgeGraph(sessionId: string): {
    files: SessionFileRecord[];
    chunks: SessionKnowledgeChunk[];
    edges: SessionKnowledgeEdge[];
  } {
    return structuredClone({
      files: this.state.sessionFiles.filter(file => file.sessionId === sessionId),
      chunks: this.state.knowledgeChunks.filter(chunk => chunk.sessionId === sessionId),
      edges: this.state.knowledgeEdges.filter(edge => edge.sessionId === sessionId),
    });
  }

  searchKnowledge(
    sessionId: string,
    query: string,
    options: { queryEmbedding?: number[]; limit?: number; now?: string } = {},
  ): KnowledgeSearchResult[] {
    const queryTerms = Object.keys(terms(query));
    const queryEntities = entities(query);
    const chunks = this.state.knowledgeChunks.filter(chunk => chunk.sessionId === sessionId);
    if (chunks.length === 0 || (queryTerms.length === 0 && !options.queryEmbedding)) return [];
    const rawLexical = new Map(chunks.map(chunk => [chunk.id, queryTerms.reduce((score, term) =>
      score + (chunk.terms[term] ?? 0), 0)]));
    const maxLexical = Math.max(1, ...rawLexical.values());
    const seeds = new Set([...rawLexical.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id));
    const relationship = new Map<string, number>();
    for (const edge of this.state.knowledgeEdges.filter(item => item.sessionId === sessionId)) {
      if (seeds.has(edge.sourceChunkId)) relationship.set(edge.targetChunkId, (relationship.get(edge.targetChunkId) ?? 0) + 0.25);
      if (seeds.has(edge.targetChunkId)) relationship.set(edge.sourceChunkId, (relationship.get(edge.sourceChunkId) ?? 0) + 0.25);
    }
    const now = options.now ?? new Date().toISOString();
    const temporalIntent = /\b(latest|recent|current|today|newest|previous|before|after|during|since)\b/i.test(query);
    const fileById = new Map(this.state.sessionFiles.map(file => [file.id, file]));
    return chunks.map(chunk => {
      const lexicalScore = (rawLexical.get(chunk.id) ?? 0) / maxLexical;
      const semanticScore = cosine(options.queryEmbedding, chunk.embedding);
      const referenceTime = Date.parse(now);
      const validFrom = chunk.validFrom ? Date.parse(chunk.validFrom) : undefined;
      const validTo = chunk.validTo ? Date.parse(chunk.validTo) : undefined;
      const hasInterval = validFrom !== undefined || validTo !== undefined;
      const intervalMatches = (!validFrom || referenceTime >= validFrom) && (!validTo || referenceTime <= validTo);
      const temporalScore = hasInterval ? (intervalMatches ? 1 : 0.05) : freshness(chunk.createdAt, now);
      const directRelationships = queryEntities.length
        ? chunk.entities.filter(entity => queryEntities.includes(entity)).length / queryEntities.length
        : 0;
      const relationshipScore = Math.min(1, directRelationships * 0.6 + (relationship.get(chunk.id) ?? 0));
      const hybrid = semanticScore !== undefined;
      const score = hybrid
        ? lexicalScore * 0.42 + semanticScore * 0.4 + temporalScore * (temporalIntent ? 0.12 : 0.06) + relationshipScore * (temporalIntent ? 0.06 : 0.12)
        : lexicalScore * 0.7 + temporalScore * (temporalIntent ? 0.2 : 0.1) + relationshipScore * (temporalIntent ? 0.1 : 0.2);
      const file = fileById.get(chunk.documentId);
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        sessionId,
        fileName: file?.name ?? chunk.documentId,
        content: chunk.content,
        score,
        lexicalScore,
        ...(semanticScore !== undefined ? { semanticScore } : {}),
        temporalScore,
        relationshipScore,
        retrievalMode: hybrid ? 'hybrid' as const : 'lexical' as const,
        reasons: [
          ...(lexicalScore > 0 ? ['lexical-match'] : []),
          ...(semanticScore !== undefined && semanticScore >= 0.5 ? ['semantic-match'] : []),
          ...(temporalIntent && temporalScore >= 0.5 ? ['temporal-match'] : []),
          ...(relationshipScore > 0 ? ['relationship-expansion'] : []),
        ],
        provenance: [file?.ingestionId ?? chunk.documentId, chunk.documentId, chunk.id, ...chunk.provenance],
        createdAt: chunk.createdAt,
      };
    }).filter(result => result.lexicalScore > 0 || (result.semanticScore ?? 0) >= 0.2 || result.relationshipScore > 0)
      .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(options.limit ?? 8, 1), 24));
  }

  upsertCustomTool(tool: CustomHttpToolDefinition): void {
    const index = this.state.customTools.findIndex(item => item.id === tool.id);
    if (index >= 0) this.state.customTools[index] = structuredClone(tool);
    else this.state.customTools.push(structuredClone(tool));
    this.commit();
  }

  listCustomTools(): CustomHttpToolDefinition[] {
    return structuredClone(this.state.customTools);
  }

  deleteCustomTool(id: string): boolean {
    const before = this.state.customTools.length;
    this.state.customTools = this.state.customTools.filter(item => item.id !== id);
    if (this.state.customTools.length === before) return false;
    this.commit();
    return true;
  }

  upsertSchedule(schedule: OperatorSchedule): void {
    const index = this.state.schedules.findIndex(item => item.id === schedule.id);
    if (index >= 0) this.state.schedules[index] = structuredClone(schedule);
    else this.state.schedules.push(structuredClone(schedule));
    this.commit();
  }

  listSchedules(): OperatorSchedule[] {
    return structuredClone(this.state.schedules);
  }

  deleteSchedule(id: string): boolean {
    const before = this.state.schedules.length;
    this.state.schedules = this.state.schedules.filter(item => item.id !== id);
    if (this.state.schedules.length === before) return false;
    this.commit();
    return true;
  }

  upsertCorrectionCandidate(candidate: CorrectionCandidate): void {
    const index = this.state.correctionCandidates.findIndex(item => item.id === candidate.id);
    if (index >= 0) this.state.correctionCandidates[index] = structuredClone(candidate);
    else this.state.correctionCandidates.unshift(structuredClone(candidate));
    this.commit();
  }

  correctionCandidate(id: string): CorrectionCandidate | undefined {
    return structuredClone(this.state.correctionCandidates.find(item => item.id === id));
  }

  listCorrectionCandidates(): CorrectionCandidate[] {
    return structuredClone(this.state.correctionCandidates)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
