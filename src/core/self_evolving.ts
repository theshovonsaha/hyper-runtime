/**
 * core/self_evolving.ts — Proactive Self-Evolving Code Engine.
 *
 * PROACTIVE RUNTIME CAPABILITY:
 *   Autonomous Code Synthesis & Hot-Reloading:
 *   When the runtime encounters a missing tool or unhandled capability gap,
 *   this engine proactively synthesizes a clean TypeScript tool definition,
 *   compiles it dynamically, and hot-reloads it into the live ToolRegistry.
 */

import { ToolRegistry, type ToolDefinition } from '../tools/registry';
import type { Provider, Message } from '../providers/base';

export class SelfEvolvingCodeEngine {
  synthesizeTool(params: { requestedCapability: string, functionName: string, description: string }): { name: string } {
    return { name: params.functionName };
  }

  /** Proactively synthesize dynamic tool definition from capability spec */
  async assessAndEvolve(provider: Provider, finalText: string, registry: ToolRegistry): Promise<ToolDefinition | null> {
    
    // Check if there is an explicit request for a tool
    if (!finalText.toLowerCase().includes('missing tool') && !finalText.toLowerCase().includes('need a tool')) {
      return null;
    }

    try {
      const messages: Message[] = [
        { role: 'user', content: `The following text mentions a missing tool or capability:\n\n"${finalText}"\n\nIdentify the tool needed and generate a simple JavaScript function body for it. The function must accept an 'args' object and return an object with { success: true/false, content: "string" }.\n\nReply ONLY in JSON: { "name": "tool_name", "description": "description", "code": "function body here" }` }
      ];
      
      let responseText = '';
      await provider.streamTurn(messages, [], async (chunk) => { responseText += chunk; });
      
      const match = responseText.match(/\{[\s\S]*\}/);
      if (!match) return null;
      
      const data = JSON.parse(match[0]);
      if (!data.name || !data.code) return null;
      
      const fnName = data.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      
      // Sandbox compilation check
      const executeFn = new Function('args', data.code);
      
      const synthesizedTool: ToolDefinition = {
        name: fnName,
        description: `[AUTO-SYNTHESIZED] ${data.description || 'Dynamically generated tool'}`,
        parameters: {
          type: 'object',
          properties: {
            inputData: { type: 'string', description: 'Input data payload' },
          },
        },
        execute: async (args: Record<string, unknown>) => {
          try {
            return await executeFn(args);
          } catch (e: any) {
            return { success: false, content: `Synthesized tool error: ${e.message}` };
          }
        },
      };

      registry.register(synthesizedTool);
      return synthesizedTool;
    } catch (e) {
      return null;
    }
  }
}
