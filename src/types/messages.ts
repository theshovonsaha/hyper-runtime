/**
 * @module messages
 * @description Core message and conversation types for the Bun Harness Runtime.
 *
 * These types mirror the Python agent-runtime's message structures,
 * ensuring wire-compatibility for the SSE / WebSocket event stream.
 *
 * Key concepts:
 *  - **Message**        – a single turn in the LLM conversation transcript.
 *  - **InputEnvelope**  – the frozen snapshot of a user turn at intake time.
 *  - **ModelTurn**      – everything the model returns after one inference call.
 *  - **RunResult**      – the final outcome shipped back to the client.
 */

// ---------------------------------------------------------------------------
// Message roles
// ---------------------------------------------------------------------------

/** The four roles an LLM conversation message can carry. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

/**
 * A single message in the conversation transcript.
 *
 * When `role` is `'tool'`, the `name` field carries the originating tool name
 * and `tool_call_id` links the response back to the model's request.
 */
export interface Message {
  /** Which participant produced this message. */
  role: MessageRole;

  /** The textual content of the message. */
  content: string;

  /** Tool name – populated when `role === 'tool'`. */
  name?: string;

  /** Links a tool result back to its corresponding ToolCallRequest.id. */
  tool_call_id?: string;

  /** The run that produced this message (used for provenance tracking). */
  run_id?: string;

  /** Unix-epoch milliseconds when the message was created. */
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Attached file
// ---------------------------------------------------------------------------

/** A user-supplied file attached to the input (already read to text). */
export interface AttachedFile {
  /** Original filename (basename). */
  name: string;

  /** Full text content of the file. */
  text: string;
}

// ---------------------------------------------------------------------------
// Input envelope
// ---------------------------------------------------------------------------

/**
 * The frozen user turn captured at intake.
 *
 * Once created this object is immutable for the lifetime of the run;
 * downstream phases read from it but never mutate it.
 */
export interface InputEnvelope {
  /** Unique identifier for this run (UUID v4). */
  run_id: string;

  /** Session that this run belongs to (groups multiple turns). */
  session_id: string;

  /** The user's natural-language message. */
  message: string;

  /** Files the user attached to the message. */
  files: AttachedFile[];

  /** Images the user attached (as data-URL encoded blobs). */
  images: Array<{ name: string; data_url: string }>;

  /** Override for the LLM provider (e.g. "gemini", "anthropic"). */
  provider?: string;

  /** Override for the specific model slug. */
  model?: string;

  /** If true the run starts in gated (inspect) mode. */
  gate?: boolean;

  /** When true the agent can take multiple autonomous tool-use steps. */
  auto: boolean;

  /** Inspection-level override for this run (e.g. "debug", "raw"). */
  level?: string;

  /** Granular pass settings override for this run. */
  passes?: GranularPasses;
}

/** Granular control over which execution passes run for a turn. */
export interface GranularPasses {
  /** Hold context packet before LLM inference for human review/edits. */
  gate?: boolean;
  /** Driver self-prompting JSON plan pass. */
  plan?: boolean;
  /** Draft answer verification pass. */
  verify?: boolean;
  /** Memory fact extraction & session synopsis update pass. */
  distill?: boolean;
  /** Enable private Chain-of-Thought <think> tag extraction and streaming. */
  think?: boolean;
  /** Enable Deterministic Logic Runtime System (DLRS) objective pass. */
  dlrs?: boolean;
  /** Trace context item & tool output contributions. */
  attribution?: boolean;
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

/** The final outcome of a completed (or cancelled / failed) run. */
export interface RunResult {
  /** Matches the originating InputEnvelope.run_id. */
  run_id: string;

  /** Terminal status of the run. */
  status: 'complete' | 'cancelled' | 'failed';

  /** The last assistant text produced before the run ended. */
  final_text: string;
}

// ---------------------------------------------------------------------------
// Tool call request
// ---------------------------------------------------------------------------

/** A tool invocation requested by the model. */
export interface ToolCallRequest {
  /** Unique identifier for this tool call (assigned by the model). */
  id: string;

  /** Registered name of the tool to invoke. */
  name: string;

  /** Parsed arguments for the tool. */
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Model turn
// ---------------------------------------------------------------------------

/**
 * Everything the model returns after a single inference call.
 *
 * `tool_calls` may be empty when the model chooses to respond with
 * text only. `reasoning` is populated by models that expose chain-of-
 * thought (e.g. Gemini 2.5 "thinking" or Claude extended-thinking).
 */
export interface ModelTurn {
  /** The assistant's textual response. */
  text: string;

  /** Zero or more tool calls the model wants to execute. */
  tool_calls: ToolCallRequest[];

  /** Why the model stopped generating (e.g. "end_turn", "tool_use"). */
  stop_reason: string;

  /** Token usage for billing / budget tracking. */
  usage: {
    input_tokens: number;
    output_tokens: number;
  };

  /** Optional chain-of-thought / reasoning trace. */
  reasoning?: string;

  /** Provider-specific metadata (model version, latency, etc.). */
  meta: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helper – createEnvelope
// ---------------------------------------------------------------------------

/** Options accepted by {@link createEnvelope} to override defaults. */
export interface CreateEnvelopeOptions {
  files?: AttachedFile[];
  images?: Array<{ name: string; data_url: string }>;
  provider?: string;
  model?: string;
  gate?: boolean;
  auto?: boolean;
  level?: string;
}

/**
 * Build a fully-populated {@link InputEnvelope} with sensible defaults.
 *
 * A fresh UUID v4 `run_id` is generated automatically.
 *
 * @param sessionId - The session this turn belongs to.
 * @param message   - The user's natural-language input.
 * @param opts      - Optional overrides for provider, model, etc.
 * @returns A new, immutable-by-convention InputEnvelope.
 *
 * @example
 * ```ts
 * const env = createEnvelope('sess-123', 'Summarise this PDF', {
 *   files: [{ name: 'report.pdf', text: '...' }],
 *   auto: true,
 * });
 * ```
 */
export function createEnvelope(
  sessionId: string,
  message: string,
  opts: CreateEnvelopeOptions = {},
): InputEnvelope {
  return {
    run_id: crypto.randomUUID(),
    session_id: sessionId,
    message,
    files: opts.files ?? [],
    images: opts.images ?? [],
    provider: opts.provider,
    model: opts.model,
    gate: opts.gate,
    auto: opts.auto ?? false,
    level: opts.level,
  };
}
