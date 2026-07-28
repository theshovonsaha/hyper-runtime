/**
 * @module events
 * @description Event system types for the Bun Harness Runtime trail.
 *
 * Every observable action in the agent loop emits a {@link TrailEvent}.
 * Events are filtered by an {@link InspectionLevel} before being sent
 * to clients – higher levels expose progressively more internal detail.
 *
 * The {@link EVENT_MIN_LEVEL} map defines the *minimum* inspection level
 * at which each event type becomes visible.  Events whose minimum level
 * is `OFF` (0) are always emitted regardless of the user's setting.
 */

// ---------------------------------------------------------------------------
// Event type union
// ---------------------------------------------------------------------------

/**
 * All valid event types emitted by the runtime.
 *
 * Naming convention follows `<phase>.<action>` to keep the trail
 * scannable at a glance.
 */
export type EventType =
  // Run lifecycle
  | 'run.start'
  | 'run.end'
  | 'run.error'
  // Context gathering
  | 'context.source'
  | 'context.item'
  | 'context.packet'
  | 'context.budget'
  | 'context.compressed'
  // Gate (human-in-the-loop)
  | 'gate.open'
  | 'gate.resolved'
  // Planning
  | 'plan.created'
  | 'plan.update'
  // Model inference
  | 'model.request'
  | 'model.delta'
  | 'model.response'
  // Tool execution
  | 'tool.call'
  | 'tool.stage'
  | 'tool.result'
  | 'tool.result.compressed'
  | 'tool.circuit_breaker'
  // Verification
  | 'verify.verdict'
  // Final response
  | 'respond.final'
  // Memory
  | 'memory.commit'
  // Loop control
  | 'loop.continue'
  // Delta / self-heal / reassemble engine
  | 'delta.assessment'
  | 'delta.heal'
  | 'delta.reassemble'
  | 'delta.reassemble.start'
  // Capability announcements
  | 'capability'
  // Active Mapping
  | 'active_mapping.routed'
  | 'active_mapping.fallback'
  // Provider fallback
  | 'provider.fallback'
  // DEP Engine
  | 'dep.computed';

// ---------------------------------------------------------------------------
// Inspection levels
// ---------------------------------------------------------------------------

/**
 * Controls the verbosity of the event stream sent to a client.
 *
 * | Level   | Typical audience           |
 * |---------|----------------------------|
 * | OFF     | Errors & gates only        |
 * | SUMMARY | End-user facing dashboard  |
 * | NORMAL  | Developer default          |
 * | DEBUG   | Troubleshooting internals  |
 * | RAW     | Full firehose (CI / logs)  |
 */
export enum InspectionLevel {
  /** Only critical events (errors, gate prompts, streaming deltas). */
  OFF = 0,

  /** High-level progress: run start/end, plan creation, tool summaries. */
  SUMMARY = 1,

  /** Default developer view – includes context packets, model responses. */
  NORMAL = 2,

  /** Internal detail: full model requests, context items, budgets. */
  DEBUG = 3,

  /** Everything, unfiltered.  Useful for CI pipelines and log archives. */
  RAW = 4,
}

// ---------------------------------------------------------------------------
// parseInspectionLevel
// ---------------------------------------------------------------------------

/**
 * Parse a human-readable inspection-level string into its enum value.
 *
 * The match is case-insensitive.  If the input is `undefined`, empty,
 * or unrecognised the {@link fallback} value is returned.
 *
 * @param s        - The string to parse (e.g. `"debug"`).
 * @param fallback - Value to use when `s` cannot be resolved.
 *                   Defaults to {@link InspectionLevel.NORMAL}.
 * @returns The resolved {@link InspectionLevel}.
 *
 * @example
 * ```ts
 * parseInspectionLevel('raw');        // InspectionLevel.RAW  (4)
 * parseInspectionLevel(undefined);    // InspectionLevel.NORMAL (2)
 * parseInspectionLevel('bogus', InspectionLevel.OFF); // InspectionLevel.OFF (0)
 * ```
 */
export function parseInspectionLevel(
  s?: string,
  fallback: InspectionLevel = InspectionLevel.NORMAL,
): InspectionLevel {
  if (!s) return fallback;

  const map: Record<string, InspectionLevel> = {
    off: InspectionLevel.OFF,
    summary: InspectionLevel.SUMMARY,
    normal: InspectionLevel.NORMAL,
    debug: InspectionLevel.DEBUG,
    raw: InspectionLevel.RAW,
  };

  return map[s.toLowerCase()] ?? fallback;
}

// ---------------------------------------------------------------------------
// Minimum level required to emit each event type
// ---------------------------------------------------------------------------

/**
 * Maps each {@link EventType} to the *minimum* {@link InspectionLevel}
 * at which it becomes visible to the client.
 *
 * An event is emitted when `currentLevel >= EVENT_MIN_LEVEL[event.type]`.
 *
 * Events mapped to `OFF` (0) are **always** visible – they represent
 * critical information the user must never miss (errors, gate prompts,
 * streaming deltas, final responses).
 */
export const EVENT_MIN_LEVEL: Record<EventType, InspectionLevel> = {
  // Run lifecycle – visible at SUMMARY and above
  'run.start': InspectionLevel.SUMMARY,
  'run.end': InspectionLevel.SUMMARY,
  'run.error': InspectionLevel.OFF, // always visible

  // Context gathering
  'context.source': InspectionLevel.NORMAL,
  'context.item': InspectionLevel.DEBUG,
  'context.packet': InspectionLevel.NORMAL,
  'context.budget': InspectionLevel.DEBUG,
  'context.compressed': InspectionLevel.SUMMARY,

  // Gate – always visible (user must act on these)
  'gate.open': InspectionLevel.OFF,
  'gate.resolved': InspectionLevel.OFF,

  // Planning
  'plan.created': InspectionLevel.SUMMARY,
  'plan.update': InspectionLevel.NORMAL,

  // Model inference
  'model.request': InspectionLevel.DEBUG,
  'model.delta': InspectionLevel.OFF, // always stream token deltas
  'model.response': InspectionLevel.NORMAL,

  // Tool execution
  'tool.call': InspectionLevel.SUMMARY,
  'tool.stage': InspectionLevel.NORMAL,
  'tool.result': InspectionLevel.SUMMARY,
  'tool.result.compressed': InspectionLevel.NORMAL,
  'tool.circuit_breaker': InspectionLevel.SUMMARY,

  // Verification
  'verify.verdict': InspectionLevel.SUMMARY,

  // Final response – always visible
  'respond.final': InspectionLevel.OFF,

  // Memory
  'memory.commit': InspectionLevel.NORMAL,

  // Loop control
  'loop.continue': InspectionLevel.SUMMARY,

  // Delta / self-heal / reassemble
  'delta.assessment': InspectionLevel.NORMAL,
  'delta.heal': InspectionLevel.SUMMARY,
  'delta.reassemble': InspectionLevel.SUMMARY,
  'delta.reassemble.start': InspectionLevel.SUMMARY,

  // Capability announcements
  capability: InspectionLevel.DEBUG,

  // Active Mapping
  'active_mapping.routed': InspectionLevel.DEBUG,
  'active_mapping.fallback': InspectionLevel.SUMMARY,

  // Provider fallback
  'provider.fallback': InspectionLevel.NORMAL,

  // DEP Engine
  'dep.computed': InspectionLevel.NORMAL,
} as const;

// ---------------------------------------------------------------------------
// Trail event
// ---------------------------------------------------------------------------

/**
 * A single, immutable event in the inspection trail.
 *
 * Events form a flat list (optionally linked via `parent_id`) that
 * the client renders as a timeline.  The `persist` flag tells the
 * storage layer whether the event should survive session compaction.
 */
export interface TrailEvent {
  /** Unique identifier for this event (UUID v4). */
  id: string;

  /** Categorises the event – see {@link EventType}. */
  type: EventType;

  /** Arbitrary structured data attached to the event. */
  payload: Record<string, unknown>;

  /** One-line human-readable description for the UI. */
  summary: string;

  /** Unix-epoch milliseconds when the event was recorded. */
  timestamp: number;

  /** Optional link to a parent event (e.g. tool.result -> tool.call). */
  parent_id?: string;

  /**
   * Whether this event should be persisted across session compaction.
   * Ephemeral events (deltas, debug noise) set this to `false`.
   */
  persist: boolean;

  /**
   * Optional relative path to the full JSON payload blob if the event was too large.
   */
  blob_ref?: string;
}
