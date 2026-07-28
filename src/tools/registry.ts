/**
 * ToolRegistry — central registry for all agent tools.
 *
 * Responsibilities:
 *   - Register / deregister tool definitions
 *   - Generate tool specs for model calls (with optional intent filtering + token budget)
 *   - Validate required arguments before execution
 *   - Execute tool calls with error boundaries (never crashes the run)
 *
 * Design decisions:
 *   - `intent` regex on ToolDefinition allows surfacing tools only when relevant,
 *     reducing token overhead on every model call.
 *   - `specs()` estimates token cost as chars/4 (rough GPT tokenizer approximation)
 *     and drops lower-priority tools when the budget is exceeded.
 *   - Execution always returns a ToolResult, never throws — errors are captured
 *     as `{ success: false }` results.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Schema for a single parameter in a tool definition */
export interface ToolParameterSchema {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameterSchema | { type: string };
}

/** The JSON-schema-style parameter block sent to the model */
export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParameterSchema>;
  required?: string[];
}

/** Full definition of a tool */
export interface ToolDefinition {
  /** Unique tool name (snake_case by convention) */
  name: string;
  /** Human-readable description shown to the model */
  description: string;
  /** JSON-schema-style parameter definition */
  parameters: ToolParameters;
  /**
   * Optional intent regex — when set, this tool is only surfaced in `specs()`
   * if the user's objective matches the pattern. This keeps the tool list lean
   * for turns that clearly don't need the tool.
   */
  intent?: RegExp;
  /** Whether this tool is a super tool (composite wrapper) */
  superTool?: boolean;
  /** Names of primitive tools this super tool wraps (hidden when super tool is active) */
  wrapsPrimitives?: string[];
  /** Execute the tool with the given arguments and context */
  execute: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>;
}

/** Context injected into every tool execution */
export interface ToolContext {
  /** Active session identifier */
  sessionId: string;
  /** Unique identifier for this run / turn */
  runId: string;
  /** Root directory for persisted data */
  dataDir: string;
  /** Emit a trail event during execution */
  emit: (
    type: string,
    payload: Record<string, unknown>,
    summary?: string,
  ) => void;
  /** Emit a nested super tool stage event under parent tool.call */
  emitStage?: (
    stage: string,
    payload: Record<string, unknown>,
    summary?: string,
  ) => void;
  /** Access to the SQLite store */
  store: any;
  /** Execute a sub-agent run */
  runSubAgent?: (provider: string, model: string, objective: string) => Promise<string>;
}

/** Result returned by every tool execution */
export interface ToolResult {
  /** Human-readable output text */
  content: string;
  /** Whether the tool executed successfully */
  success: boolean;
  /** Optional structured metadata (logged to trail) */
  metadata?: Record<string, unknown>;
}

/** Spec sent to the model (no execute function, no intent regex) */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  // ---- Registration -------------------------------------------------------

  /** Register a single tool. Overwrites if name already exists. */
  register(tool: ToolDefinition): void {
    if (!tool.name) throw new Error('Tool must have a name');
    this.tools.set(tool.name, tool);
  }

  /** Register an array of tools in one call. */
  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Remove a tool by name. Returns true if it existed. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  // ---- Lookup -------------------------------------------------------------

  /** Get a tool definition by name. Returns fallback tool if unknown. */
  get(name: string): ToolDefinition {
    const existing = this.tools.get(name);
    if (existing) return existing;

    // Hallucinated Tool Safeguard: Return dynamic fallback definition
    const available = Array.from(this.tools.keys()).join(', ');
    return {
      name,
      description: `Unknown tool fallback for ${name}`,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({
        success: false,
        content: `Error: Unknown tool '${name}' is not registered. Available tools in registry: [${available}]. Please use one of the available registered tools.`,
      }),
    };
  }

  /** Return all registered tool names. */
  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }

  // ---- Spec Generation ----------------------------------------------------

  /**
   * Build the tool spec array to send to the model.
   *
   * @param opts.objective — if provided, tools with an `intent` regex are only
   *   included when the objective matches.
   * @param opts.tokenBudget — approximate max tokens for the tool spec block.
   *   Tools are dropped (least relevant first) to stay under budget.
   *   Defaults to unlimited.
   */
  specs(opts?: { objective?: string; tokenBudget?: number }): ToolSpec[] {
    const { objective, tokenBudget } = opts ?? {};
    const result: ToolSpec[] = [];
    let totalChars = 0;

    for (const tool of this.tools.values()) {
      // Intent filtering: if the tool has an intent regex and an objective
      // is provided, skip tools that don't match.
      if (tool.intent && objective && !tool.intent.test(objective)) {
        continue;
      }

      const spec: ToolSpec = {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      };

      // Estimate token cost: rough chars/4 approximation
      const specChars = JSON.stringify(spec).length;
      if (tokenBudget !== undefined) {
        const estimatedTokens = Math.ceil(specChars / 4);
        if (totalChars + estimatedTokens > tokenBudget) {
          continue; // drop this tool to stay under budget
        }
        totalChars += estimatedTokens;
      }

      result.push(spec);
    }

    return result;
  }

  // ---- Validation ---------------------------------------------------------

  /**
   * Check for missing required arguments for a named tool.
   * Returns an array of missing parameter names (empty if all present).
   */
  missingRequired(
    name: string,
    args: Record<string, unknown>,
  ): string[] {
    const tool = this.tools.get(name);
    if (!tool) return [];
    const required = tool.parameters.required ?? [];
    return required.filter(
      (param) => args[param] === undefined || args[param] === null,
    );
  }

  // ---- Execution ----------------------------------------------------------

  /**
   * Execute a tool call by name.
   *
   * Never throws — errors are captured as `{ success: false }` results.
   * This is critical: a tool failure must not crash the action loop.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        content: `Unknown tool: ${name}`,
        success: false,
        metadata: { error: 'tool_not_found', requested: name },
      };
    }

    // Validate required args
    const missing = this.missingRequired(name, args);
    if (missing.length > 0) {
      return {
        content: `Missing required arguments: ${missing.join(', ')}`,
        success: false,
        metadata: { error: 'missing_args', missing },
      };
    }

    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Tool error: ${message}`,
        success: false,
        metadata: {
          error: 'execution_error',
          tool: name,
          message,
        },
      };
    }
  }
}
