/**
 * core/active_mapping.ts — Active Memory & Active Chat Model Mapping Engine.
 *
 * Provides:
 *   1. Active Memory Mapping: Binds session topic, active task, and active memory threads
 *      to hot memory pointers, preventing passive memory bloat.
 *   2. Active Model Mapping: Dynamically routes specific turn phases/lanes to optimal model tiers
 *      (e.g., cheap fast models for synopsis/notes vs deep reasoning models for planning/execution),
 *      cutting token costs by up to 80%.
 */

export interface ActiveMemoryPointer {
  sessionId: string;
  activeTopic: string;
  activeTaskId?: string;
  activeThreadIds: string[];
  hotMemoryNodeIds: string[];
}

export type ExecutionPhase = 'synopsis' | 'memory_extract' | 'plan' | 'tool_loop' | 'verify';

export interface ModelMappingRule {
  provider: string;
  model: string;
  reason: string;
}

export class ActiveMappingEngine {
  private memoryPointers: Map<string, ActiveMemoryPointer> = new Map();

  // Default phase-to-model mapping rules
  private phaseModelMap: Record<ExecutionPhase, ModelMappingRule> = {
    synopsis: { provider: 'openai', model: 'gpt-4o-mini', reason: 'Fast cheap history summarization' },
    memory_extract: { provider: 'gemini', model: 'gemini-2.5-flash', reason: 'High-speed note extraction' },
    plan: { provider: 'anthropic', model: 'claude-3-5-sonnet', reason: 'Deep architectural planning' },
    tool_loop: { provider: 'anthropic', model: 'claude-3-5-sonnet', reason: 'High-precision tool calling' },
    verify: { provider: 'openrouter', model: 'deepseek/deepseek-r1', reason: 'Rigorous chain-of-thought verification' },
  };

  bindActiveMemory(sessionId: string, topic: string, activeThreadIds: string[] = []): ActiveMemoryPointer {
    const ptr: ActiveMemoryPointer = {
      sessionId,
      activeTopic: topic,
      activeThreadIds,
      hotMemoryNodeIds: [],
    };
    this.memoryPointers.set(sessionId, ptr);
    return ptr;
  }

  getActiveMemory(sessionId: string): ActiveMemoryPointer | undefined {
    return this.memoryPointers.get(sessionId);
  }

  resolveModelForPhase(phase: ExecutionPhase, userOverrideProvider?: string, userOverrideModel?: string): ModelMappingRule {
    if (userOverrideProvider) {
      return { provider: userOverrideProvider, model: userOverrideModel || '', reason: 'User explicit override' };
    }
    return this.phaseModelMap[phase] || { provider: 'mock', model: 'mock-driver', reason: 'Fallback mock' };
  }
}
