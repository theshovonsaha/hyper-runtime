/**
 * @module store/events
 * Trail-event system for the Bun Harness Runtime.
 *
 * Every agent run emits a stream of structured TrailEvent objects.
 * This module provides:
 *  - EventLog – a per-run event accumulator
 *  - EventStore – global registry for persistence and fan-out
 *  - AsyncQueue – lightweight async-pull primitive for subscribers
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  InspectionLevel,
  EVENT_MIN_LEVEL,
  type EventType,
  type TrailEvent,
} from '../types/events';

// ─── AsyncQueue ────────────────────────────────────────────────────────────

/**
 * A minimal unbounded async queue.
 * Producers call push(), consumers call get() which suspends if empty.
 */
export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiting: Array<(value: T) => void> = [];

  push(item: T): void {
    const resolve = this.waiting.shift();
    if (resolve) {
      resolve(item);
    } else {
      this.buffer.push(item);
    }
  }

  pop(): Promise<T> {
    return this.get();
  }

  isEmpty(): boolean {
    return this.buffer.length === 0;
  }

  popSync(): T | undefined {
    return this.buffer.shift();
  }

  async get(): Promise<T> {
    const item = this.buffer.shift();
    if (item !== undefined) return item;
    return new Promise<T>((resolve) => this.waiting.push(resolve));
  }

  get size(): number {
    return this.buffer.length;
  }
}

// ─── EventStore ────────────────────────────────────────────────────────────

export class EventStore {
  private subscribers: Map<string, Set<(event: TrailEvent) => void>> = new Map();
  private dataDir: string;
  private eventsDir: string;
  public readonly blobsDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.eventsDir = join(dataDir, 'events');
    this.blobsDir = join(dataDir, 'blobs');
    if (!existsSync(this.eventsDir)) mkdirSync(this.eventsDir, { recursive: true });
    if (!existsSync(this.blobsDir)) mkdirSync(this.blobsDir, { recursive: true });
  }

  private activeLogs: Map<string, EventLog> = new Map();

  openLog(runId: string): EventLog {
    let log = this.activeLogs.get(runId);
    if (!log) {
      log = new EventLog(runId, this);
      this.activeLogs.set(runId, log);
    }
    return log;
  }

  closeLog(runId: string): void {
    this.activeLogs.delete(runId);
    this.subscribers.delete(runId);
  }

  hasActiveLog(runId: string): boolean {
    return this.activeLogs.has(runId);
  }

  /** Append event to JSONL file */
  persistEvent(runId: string, event: TrailEvent): void {
    const filePath = join(this.eventsDir, `${runId}.jsonl`);
    let eventToLog = event;
    let line = JSON.stringify(eventToLog) + '\n';

    // Size ceiling: if an event is absurdly large (e.g. raw tool fetch), truncate its payload
    // to prevent runaway JSONL logs (e.g. 600MB bug).
    if (line.length > 50000) {
      const truncatedEvent = { ...event };
      if (typeof truncatedEvent.payload === 'object' && truncatedEvent.payload !== null) {
        truncatedEvent.payload = { ...truncatedEvent.payload, _TRUNCATED_BY_EVENTSTORE: true };
        for (const [k, v] of Object.entries(truncatedEvent.payload)) {
          if (typeof v === 'string' && v.length > 20000) {
            (truncatedEvent.payload as any)[k] = v.substring(0, 20000) + '\n... [TRUNCATED BY EVENTSTORE]';
          }
        }
      }
      line = JSON.stringify(truncatedEvent) + '\n';
    }

    appendFileSync(filePath, line, 'utf-8');
  }

  /** Load all events for a run from disk */
  loadEvents(runId: string): TrailEvent[] {
    const filePath = join(this.eventsDir, `${runId}.jsonl`);
    if (!existsSync(filePath)) return [];

    const raw = readFileSync(filePath, 'utf-8');
    const events: TrailEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as TrailEvent);
      } catch {
        // skip malformed
      }
    }
    return events;
  }

  /** Subscribe to events for a run. Returns an AsyncQueue. */
  subscribe(runId: string): AsyncQueue<TrailEvent> {
    const queue = new AsyncQueue<TrailEvent>();
    const callback = (event: TrailEvent): void => {
      queue.push(event);
    };
    (queue as any).__callback = callback;

    if (!this.subscribers.has(runId)) {
      this.subscribers.set(runId, new Set());
    }
    this.subscribers.get(runId)!.add(callback);
    return queue;
  }

  /** Unsubscribe a queue */
  unsubscribeQueue(runId: string, queue: AsyncQueue<TrailEvent>): void {
    const callback = (queue as any).__callback as ((event: TrailEvent) => void) | undefined;
    if (!callback) return;
    const subs = this.subscribers.get(runId);
    if (subs) {
      subs.delete(callback);
      if (subs.size === 0) this.subscribers.delete(runId);
    }
  }

  /** Broadcast an event to all subscribers of a run */
  notify(runId: string, event: TrailEvent): void {
    const subs = this.subscribers.get(runId);
    if (!subs) return;
    for (const cb of subs) {
      try {
        cb(event);
      } catch (err) {
        console.error(`[EventStore] subscriber error for run ${runId}:`, err);
      }
    }
  }

  /**
   * Render an event for a given inspection level.
   * Returns null if the event type is below the requested level.
   */
  renderEvent(
    event: TrailEvent,
    level: InspectionLevel,
  ): Record<string, unknown> | null {
    const requiredLevel: InspectionLevel = EVENT_MIN_LEVEL[event.type] ?? InspectionLevel.NORMAL;
    if (level < requiredLevel) return null;

    const base: Record<string, unknown> = {
      id: event.id,
      type: event.type,
      phase: event.type.split('.')[0],
      ts: event.timestamp / 1000.0,
      timestamp: event.timestamp,
      summary: event.summary,
    };
    if (event.parent_id) base.parent_id = event.parent_id;
    if (event.blob_ref) base.blob_ref = event.blob_ref;

    // Include payload at NORMAL and above
    if (level >= InspectionLevel.NORMAL) {
      base.payload = event.payload;
    }

    return base;
  }
}

// ─── EventLog ──────────────────────────────────────────────────────────────

export class EventLog {
  readonly runId: string;
  private events: TrailEvent[] = [];
  private store: EventStore;

  constructor(runId: string, store: EventStore) {
    this.runId = runId;
    this.store = store;
  }

  /**
   * Emit a new trail event.
   */
  emit(
    type: EventType,
    payload: Record<string, unknown>,
    opts: {
      summary?: string;
      persist?: boolean;
      parent_id?: string;
    } = {},
  ): TrailEvent {
    let finalPayload = payload;
    let blobRef: string | undefined;

    const encoded = JSON.stringify(payload);
    if (encoded.length > 2048) {
      const runBlobsDir = join(this.store.blobsDir, this.runId);
      if (!existsSync(runBlobsDir)) mkdirSync(runBlobsDir, { recursive: true });
      const blobName = `${Date.now()}_${type.replace('.', '_')}.json`;
      const blobPath = join(runBlobsDir, blobName);
      appendFileSync(blobPath, encoded, 'utf-8');
      
      blobRef = `blobs/${this.runId}/${blobName}`;
      finalPayload = {
        preview: encoded.substring(0, 2048),
        omitted_keys: Object.keys(payload)
      };
    }

    const event: TrailEvent = {
      id: crypto.randomUUID(),
      type,
      payload: finalPayload,
      summary: opts.summary ?? '',
      timestamp: Date.now(),
      parent_id: opts.parent_id,
      persist: opts.persist !== false,
      blob_ref: blobRef,
    };

    this.events.push(event);

    if (opts.persist !== false) {
      this.store.persistEvent(this.runId, event);
    }

    this.store.notify(this.runId, event);
    return event;
  }

  getEvents(): readonly TrailEvent[] {
    return this.events;
  }

  get length(): number {
    return this.events.length;
  }
}
