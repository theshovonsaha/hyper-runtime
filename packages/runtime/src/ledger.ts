import type { LedgerEvent } from '@hyper/contracts';
import { CONTRACT_VERSION } from '@hyper/contracts';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, sha256 } from './canonical';

const GENESIS_HASH = '0'.repeat(64);

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
    return source.split('\n').map((line, index) => {
      try {
        return JSON.parse(line) as LedgerEvent;
      } catch {
        throw new Error(`Invalid ledger JSON at line ${index + 1}.`);
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
    const previousHash = this.events.at(-1)?.hash ?? GENESIS_HASH;
    const unsigned = {
      version: CONTRACT_VERSION,
      runId,
      sequence: this.events.length,
      type,
      payload,
      previousHash,
    };
    const event: LedgerEvent = {
      ...unsigned,
      hash: sha256(canonicalJson(unsigned)),
    };
    this.events.push(event);
    this.store?.append(event);
    return event;
  }

  all(): readonly LedgerEvent[] {
    return this.events.map(event => structuredClone(event));
  }

  latestHash(): string {
    return this.events.at(-1)?.hash ?? GENESIS_HASH;
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
  brokenAt?: number;
}

export function inspectReplay(ledger: HashChainLedger): ReplaySummary {
  const events = ledger.all();
  const integrity = ledger.verifyIntegrity();
  const eventTypes: Record<string, number> = {};
  for (const event of events) {
    eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
  }
  return {
    valid: integrity.valid,
    eventCount: events.length,
    runIds: [...new Set(events.map(event => event.runId))],
    eventTypes,
    latestHash: ledger.latestHash(),
    brokenAt: integrity.brokenAt,
  };
}
