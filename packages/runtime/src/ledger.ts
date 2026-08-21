import type { LedgerEvent } from '@hyper/contracts';
import { CONTRACT_VERSION } from '@hyper/contracts';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, sha256 } from './canonical';

const GENESIS_HASH = '0'.repeat(64);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLedgerEvent(value: unknown, line: number): LedgerEvent {
  if (
    !isRecord(value)
    || value.version !== CONTRACT_VERSION
    || typeof value.runId !== 'string'
    || value.runId.length === 0
    || !Number.isSafeInteger(value.sequence)
    || (value.sequence as number) < 0
    || typeof value.type !== 'string'
    || value.type.length === 0
    || !isRecord(value.payload)
    || typeof value.previousHash !== 'string'
    || !HASH_PATTERN.test(value.previousHash)
    || typeof value.hash !== 'string'
    || !HASH_PATTERN.test(value.hash)
  ) {
    throw new Error(`Invalid ledger event schema at line ${line}.`);
  }
  return value as unknown as LedgerEvent;
}

export interface LedgerStore {
  load(): LedgerEvent[];
  append(event: LedgerEvent): void;
}

export class JsonlLedgerStore implements LedgerStore {
  constructor(readonly path: string) {}

  load(): LedgerEvent[] {
    if (!existsSync(this.path)) return [];
    const source = readFileSync(this.path, 'utf8').trim();
    if (!source) return [];
    return source.split('\n').map((entry, index) => {
      try {
        return parseLedgerEvent(JSON.parse(entry), index + 1);
      } catch {
        throw new Error(`Invalid ledger JSON or event schema at line ${index + 1}.`);
      }
    });
  }

  append(event: LedgerEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
  }
}

export class HashChainLedger {
  private readonly events: LedgerEvent[];

  constructor(private readonly store?: LedgerStore) {
    this.events = store?.load().map(event => structuredClone(event)) ?? [];
    const integrity = this.verifyIntegrity();
    if (!integrity.valid) {
      throw new Error(`Ledger integrity check failed at event ${integrity.brokenAt}.`);
    }
  }

  append(runId: string, type: string, payload: Record<string, unknown>): LedgerEvent {
    if (!runId) throw new Error('Ledger events require a non-empty run ID.');
    if (!type) throw new Error('Ledger events require a non-empty type.');
    const committedPayload = structuredClone(payload);
    const previousHash = this.events.at(-1)?.hash ?? GENESIS_HASH;
    const unsigned = {
      version: CONTRACT_VERSION,
      runId,
      sequence: this.events.length,
      type,
      payload: committedPayload,
      previousHash,
    };
    const event: LedgerEvent = {
      ...unsigned,
      hash: sha256(canonicalJson(unsigned)),
    };
    // Persist first so an I/O failure cannot leave the in-memory ledger ahead
    // of its durable source of truth.
    this.store?.append(event);
    this.events.push(event);
    return structuredClone(event);
  }

  all(): readonly LedgerEvent[] {
    return this.events.map(event => structuredClone(event));
  }

  latestHash(): string {
    return this.events.at(-1)?.hash ?? GENESIS_HASH;
  }

  hasRun(runId: string): boolean {
    return this.events.some(event => event.runId === runId);
  }

  forRun(runId: string): readonly LedgerEvent[] {
    return this.events
      .filter(event => event.runId === runId)
      .map(event => structuredClone(event));
  }

  verifyIntegrity(): { valid: boolean; brokenAt?: number } {
    let previousHash = GENESIS_HASH;

    for (const [index, event] of this.events.entries()) {
      const unsigned = {
        version: event.version,
        runId: event.runId,
        sequence: event.sequence,
        type: event.type,
        payload: event.payload,
        previousHash: event.previousHash,
      };
      const expected = sha256(canonicalJson(unsigned));
      if (event.sequence !== index || event.previousHash !== previousHash || event.hash !== expected) {
        return { valid: false, brokenAt: index };
      }
      previousHash = event.hash;
    }

    return { valid: true };
  }
}

export interface ReplaySummary {
  valid: boolean;
  eventCount: number;
  runIds: string[];
  eventTypes: Record<string, number>;
  latestHash: string;
  runs: Array<{
    runId: string;
    eventCount: number;
    firstSequence: number;
    lastSequence: number;
    latestHash: string;
    status?: string;
    receiptHash?: string;
  }>;
  brokenAt?: number;
}

export function inspectReplay(ledger: HashChainLedger): ReplaySummary {
  const events = ledger.all();
  const integrity = ledger.verifyIntegrity();
  const eventTypes: Record<string, number> = {};
  for (const event of events) {
    eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
  }
  const runs = [...new Set(events.map(event => event.runId))].map(runId => {
    const runEvents = events.filter(event => event.runId === runId);
    const receipt = [...runEvents].reverse().find(event =>
      event.type === 'workflow.receipt' || event.type === 'action.receipt',
    );
    const status = typeof receipt?.payload.status === 'string'
      ? receipt.payload.status
      : undefined;
    return {
      runId,
      eventCount: runEvents.length,
      firstSequence: runEvents[0]!.sequence,
      lastSequence: runEvents.at(-1)!.sequence,
      latestHash: runEvents.at(-1)!.hash,
      status,
      receiptHash: receipt?.hash,
    };
  });
  return {
    valid: integrity.valid,
    eventCount: events.length,
    runIds: [...new Set(events.map(event => event.runId))],
    eventTypes,
    latestHash: ledger.latestHash(),
    runs,
    brokenAt: integrity.brokenAt,
  };
}
