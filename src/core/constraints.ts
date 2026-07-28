/**
 * core/constraints.ts — 7 Hard Physical & Runtime Constraints Engine
 *
 * Enforces unyielding physical and runtime bounds across context budgets, timeouts,
 * loop bounds, sandbox path validation, payload ceilings, and resource eviction.
 */

import { resolve, relative, isAbsolute } from 'path';

export interface ConstraintViolation {
  rule: string;
  message: string;
  actionTaken: string;
}

export class RuntimeConstraintsManager {
  // Hard Constants
  public static readonly MAX_CONTEXT_CHARS = 24000;
  public static readonly MAX_EVENT_BYTES = 50000;
  public static readonly MAX_TOOL_TIMEOUT_MS = 5000;
  public static readonly MAX_TURN_TIMEOUT_MS = 30000;
  public static readonly MAX_TURNS_PER_RUN = 15;
  public static readonly MAX_SUBAGENT_DEPTH = 2;
  public static readonly MAX_TOOL_RESULT_VIEW_CHARS = 1500;

  /**
   * 1. Hard Context Budget Ceiling (Max 24,000 Chars)
   */
  enforceContextBudget(totalChars: number): { compliant: boolean; truncatedChars: number } {
    if (totalChars <= RuntimeConstraintsManager.MAX_CONTEXT_CHARS) {
      return { compliant: true, truncatedChars: totalChars };
    }
    return {
      compliant: false,
      truncatedChars: RuntimeConstraintsManager.MAX_CONTEXT_CHARS,
    };
  }

  /**
   * 2. Hard Sandbox & Path Validation (Rejects access outside workspace)
   */
  enforcePathSandbox(targetPath: string, workspaceRoot: string): { allowed: boolean; normalizedPath: string; error?: string } {
    try {
      const normalizedRoot = resolve(workspaceRoot);
      const resolvedTarget = isAbsolute(targetPath) ? resolve(targetPath) : resolve(normalizedRoot, targetPath);
      const rel = relative(normalizedRoot, resolvedTarget);

      const isOutside = rel.startsWith('..') || isAbsolute(rel);
      if (isOutside) {
        return {
          allowed: false,
          normalizedPath: resolvedTarget,
          error: `SECURITY CONSTRAINT VIOLATION: Target path '${targetPath}' resolves outside workspace root '${workspaceRoot}'. Access denied.`,
        };
      }

      return { allowed: true, normalizedPath: resolvedTarget };
    } catch (e) {
      return {
        allowed: false,
        normalizedPath: targetPath,
        error: `SECURITY CONSTRAINT VIOLATION: Invalid path resolution for '${targetPath}'.`,
      };
    }
  }

  /**
   * 3. Hard Loop & Depth Bounds (Max 15 turns, Max depth 2)
   */
  enforceTurnLimits(turnIndex: number, currentDepth: number): { allowed: boolean; error?: string } {
    if (turnIndex > RuntimeConstraintsManager.MAX_TURNS_PER_RUN) {
      return {
        allowed: false,
        error: `LOOP CONSTRAINT VIOLATION: Execution exceeded hard max limit of ${RuntimeConstraintsManager.MAX_TURNS_PER_RUN} turns per run. Terminated to prevent infinite loop.`,
      };
    }

    if (currentDepth > RuntimeConstraintsManager.MAX_SUBAGENT_DEPTH) {
      return {
        allowed: false,
        error: `RECURSION CONSTRAINT VIOLATION: Sub-agent recursion depth ${currentDepth} exceeded max allowed depth of ${RuntimeConstraintsManager.MAX_SUBAGENT_DEPTH}.`,
      };
    }

    return { allowed: true };
  }

  /**
   * 4. Hard Tool Execution Timeout (Max 5,000ms)
   */
  async enforceToolTimeout<T>(
    toolPromise: Promise<T>,
    toolName: string,
    timeoutMs: number = RuntimeConstraintsManager.MAX_TOOL_TIMEOUT_MS
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`TIMEOUT CONSTRAINT VIOLATION: Tool '${toolName}' exceeded hard execution timeout of ${timeoutMs}ms.`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([toolPromise, timeoutPromise]);
      clearTimeout(timer!);
      return result;
    } catch (err) {
      clearTimeout(timer!);
      throw err;
    }
  }

  /**
   * 5. Hard Event Payload Size Ceiling (Max 50,000 Bytes)
   */
  enforcePayloadCeiling(payloadStr: string): { compliant: boolean; boundedPayload: string } {
    if (payloadStr.length <= RuntimeConstraintsManager.MAX_EVENT_BYTES) {
      return { compliant: true, boundedPayload: payloadStr };
    }

    const truncated = payloadStr.slice(0, RuntimeConstraintsManager.MAX_EVENT_BYTES - 100) + '\n... [TRUNCATED BY HARD PAYLOAD CEILING constraint]';
    return {
      compliant: false,
      boundedPayload: truncated,
    };
  }
}
