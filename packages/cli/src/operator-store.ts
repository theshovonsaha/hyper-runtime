import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

export interface OperatorSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: OperatorMessage[];
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
}

export interface VerifiedMemoryRecord {
  id: string;
  sourceRunId: string;
  sessionId: string;
  content: string;
  evidenceRefs: string[];
  createdAt: string;
  status: 'active' | 'deleted';
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

interface OperatorState {
  version: 2;
  sessions: OperatorSession[];
  runs: OperatorRun[];
  memory: VerifiedMemoryRecord[];
  customTools: CustomHttpToolDefinition[];
  schedules: OperatorSchedule[];
  correctionCandidates: CorrectionCandidate[];
}

function initialState(): OperatorState {
  return {
    version: 2,
    sessions: [],
    runs: [],
    memory: [],
    customTools: [],
    schedules: [],
    correctionCandidates: [],
  };
}

function loadState(value: unknown): OperatorState {
  if (typeof value !== 'object' || value === null) return initialState();
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 && candidate.version !== 2) return initialState();
  return {
    version: 2,
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

  messages(sessionId: string): OperatorMessage[] | undefined {
    return structuredClone(this.state.sessions.find(item => item.id === sessionId)?.messages);
  }

  recordRun(run: OperatorRun): void {
    const index = this.state.runs.findIndex(item => item.id === run.id);
    if (index >= 0) this.state.runs[index] = structuredClone(run);
    else this.state.runs.unshift(structuredClone(run));
    this.commit();
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
    this.commit();
  }

  listMemory(includeDeleted = false): VerifiedMemoryRecord[] {
    return structuredClone(this.state.memory.filter(item => includeDeleted || item.status === 'active'));
  }

  deleteMemory(id: string): boolean {
    const record = this.state.memory.find(item => item.id === id && item.status === 'active');
    if (!record) return false;
    record.status = 'deleted';
    this.commit();
    return true;
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
