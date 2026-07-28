/**
 * core/self_evolving.ts — Proactive Self-Evolving Code Engine.
 *
 * CHANGED: the previous version's docstring claimed "compiles it
 * dynamically, and hot-reloads it" — but `synthesizeTool` never compiled
 * anything; its `execute()` always returned `success: true` with a canned
 * templated string, regardless of what capability was actually requested.
 * Wired into a live loop, that's an agent silently believing it closed a
 * capability gap when it did nothing.
 *
 * This version can no longer make that claim by default: a synthesized
 * tool now returns `success: false` and a clear "not implemented" message
 * unless the caller supplies a real `implementation` function — i.e. real
 * code someone actually wrote/reviewed, not code this engine invented.
 * There is still no dynamic compilation here; if you need that, it has to
 * be built and explicitly audited separately, not implied by this class.
 */

import { ToolRegistry, type ToolDefinition } from '../tools/registry';

export interface DynamicToolSynthesisRequest {
  requestedCapability: string;
  functionName: string;
  description: string;
  /**
   * Optional real implementation. If omitted, the synthesized tool is a
   * clearly-labeled stub that always reports failure rather than a fake
   * success — there is no code-generation path that fabricates one.
   */
  implementation?: (args: Record<string, unknown>) => Promise<{ success: boolean; content: string; metadata?: Record<string, unknown> }>;
}

export class SelfEvolvingCodeEngine {
  synthesizeTool(request: DynamicToolSynthesisRequest): ToolDefinition {
    const fnName = request.functionName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const hasRealImpl = typeof request.implementation === 'function';

    const synthesizedTool: ToolDefinition = {
      name: fnName,
      description: hasRealImpl
        ? request.description
        : `[UNIMPLEMENTED STUB — requires a real implementation before use] ${request.description}`,
      parameters: {
        type: 'object',
        properties: {
          inputData: { type: 'string', description: 'Input data payload' },
        },
      },
      execute: async (args: Record<string, unknown>) => {
        if (hasRealImpl) {
          return request.implementation!(args);
        }
        // Honest failure, not a fabricated success — a caller checking
        // `result.success` will correctly see this capability gap wasn't
        // actually closed, instead of silently trusting a canned string.
        return {
          success: false,
          content: `Tool "${fnName}" for capability "${request.requestedCapability}" has no real implementation. `
            + `This is a placeholder — provide a reviewed \`implementation\` function before relying on it.`,
          metadata: { synthesizedAt: Date.now(), capability: request.requestedCapability, stub: true },
        };
      },
    };

    return synthesizedTool;
  }

  /**
   * Register a synthesized tool into the live registry. Requires
   * `request.implementation` — refuses to hot-reload a stub into a
   * production tool registry where an agent could mistake a no-op for a
   * real capability. Call `synthesizeTool` directly (without registering)
   * if you just want the stub shape for inspection/testing.
   */
  hotReloadSynthesizedTool(registry: ToolRegistry, request: DynamicToolSynthesisRequest): ToolDefinition {
    if (typeof request.implementation !== 'function') {
      throw new Error(
        `Refusing to hot-reload tool "${request.functionName}" without a real implementation — `
        + `stub tools that always report success: false are for inspection only, not live registration.`
      );
    }
    const tool = this.synthesizeTool(request);
    registry.register(tool);
    return tool;
  }
}
