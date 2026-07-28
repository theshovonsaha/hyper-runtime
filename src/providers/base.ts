/**
 * providers/base.ts — Provider interface, message schema, error types, and factory.
 *
 * All providers use STATELESS completion endpoints. We send the FULL context
 * every time. The LLM has NO memory of previous turns — WE own the context.
 *
 * CHANGED vs original:
 *   - Added `Message`, a superset of the old `{role, content}` shape that can
 *     also carry `tool_calls` (on assistant messages) and `tool_call_id` /
 *     `name` (on tool-result messages). This is the same schema the Python
 *     original uses (providers.py):
 *       {"role": "assistant", "content": str, "tool_calls": [{id, name, args}]}
 *       {"role": "tool", "tool_call_id": str, "name": str, "content": str}
 *     Every provider now converts FROM this shape TO its own wire format,
 *     instead of everything being flattened to plain strings beforehand.
 *   - `streamTurn` now takes `Message[]` instead of the old loosely-typed
 *     `Array<{role, content, [k:string]: unknown}>`. This is a superset of the
 *     old shape so existing plain `{role, content}` call sites still compile.
 *   - Added `nextFallbackProvider()` for provider-fallback chain support.
 *   - Added `nvidia` and `huggingface` provider cases.
 */

import type { ModelTurn, ToolCallRequest } from '../types/messages';

// ---- Message schema (shared across all providers) ----

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  /** For assistant messages with tool_calls, content may legitimately be empty. */
  content: string;
  /** Present on assistant messages that invoked one or more tools. */
  tool_calls?: ToolCallRequest[];
  /** Present on 'tool' role messages — links the result back to its call. */
  tool_call_id?: string;
  /** Present on 'tool' role messages — the tool name (Gemini needs this). */
  name?: string;
}

// ---- Tool spec as sent to the model ----

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ---- Error hierarchy ----

export class ProviderError extends Error {
  constructor(message: string, public provider: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class RateLimitError extends ProviderError {
  constructor(message: string, provider: string, public retryAfter?: number) {
    super(message, provider);
    this.name = 'RateLimitError';
  }
}

export class ToolUseFormatError extends ProviderError {
  constructor(message: string, provider: string) {
    super(message, provider);
    this.name = 'ToolUseFormatError';
  }
}

// ---- Callback types ----

export type OnDelta = (text: string) => Promise<void>;
export type OnReasoning = (text: string) => Promise<void>;

// ---- Provider interface ----

export interface Provider {
  readonly name: string;
  readonly model: string;

  /**
   * Stream a model turn. This is the ONLY method that calls the LLM.
   * Uses stateless /chat/completions — we OWN the context, never the LLM.
   */
  streamTurn(
    messages: Message[],
    tools: ToolSpec[],
    onDelta: OnDelta,
    onReasoning?: OnReasoning,
  ): Promise<ModelTurn>;

  /** Describe the request for logging (without sending) */
  requestDescriptor(
    messages: Message[],
    tools: ToolSpec[],
  ): Record<string, unknown>;
}

// ---- SSE line parser (shared utility) ----

/**
 * Parse a ReadableStream of bytes into SSE "data:" lines.
 * Yields each parsed JSON payload from `data: {...}` lines.
 * Stops at `data: [DONE]`.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') return;
        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6);
          try {
            yield JSON.parse(jsonStr);
          } catch {
            // skip malformed JSON chunks
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---- Stream Filters & Guards ----

/**
 * Prevents local models from falling into token-repetition death spirals.
 * If the tail chunk of generated text already occurred >=3 times in the
 * recent window, the stream is aborted.
 */
export class DegenerationGuard {
  private readonly WINDOW = 1600;
  private readonly TAIL = 90;
  private readonly MIN_TOTAL = 700;
  private readonly REPEATS = 3;

  private buf = '';
  private fed = 0;
  private sinceCheck = 0;
  public tripped = false;

  feed(text: string): boolean {
    if (!text || this.tripped) return this.tripped;
    this.buf = (this.buf + text).slice(-this.WINDOW);
    this.fed += text.length;
    this.sinceCheck += text.length;
    
    if (this.fed < this.MIN_TOTAL || this.sinceCheck < 120) return false;
    this.sinceCheck = 0;
    
    const tail = this.buf.slice(-this.TAIL);
    if (tail.length < this.TAIL) return false;
    
    // Count occurrences of tail in buf
    let count = 0;
    let pos = 0;
    while ((pos = this.buf.indexOf(tail, pos)) !== -1) {
      count++;
      pos += tail.length;
    }
    
    if (count >= this.REPEATS) {
      this.tripped = true;
    }
    return this.tripped;
  }
}

/**
 * Streaming filter that separates reasoning-model <think>...</think> blocks
 * from the visible answer, across delta boundaries.
 */
export class ThinkFilter {
  public inThink = false;
  public reasoning: string[] = [];
  public answer: string[] = [];
  private buf = '';

  feed(text: string): { visible: string; reason: string } {
    this.buf += text;
    const visible: string[] = [];
    const reason: string[] = [];

    while (this.buf.length > 0) {
      const tag = this.inThink ? '</think>' : '<think>';
      const idx = this.buf.indexOf(tag);
      
      if (idx !== -1) {
        const chunk = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + tag.length);
        if (this.inThink) reason.push(chunk);
        else visible.push(chunk);
        
        this.inThink = !this.inThink;
        continue;
      }
      
      // Check if a tag might be starting at the tail
      let hold = 0;
      for (let k = 1; k <= Math.min(tag.length, this.buf.length); k++) {
        if (this.buf.endsWith(tag.slice(0, k))) {
          hold = k;
        }
      }
      
      const emit = this.buf.slice(0, this.buf.length - hold);
      this.buf = this.buf.slice(this.buf.length - hold);
      
      if (this.inThink) reason.push(emit);
      else visible.push(emit);
      
      break;
    }

    const r = reason.join('');
    if (r) this.reasoning.push(r);
    return { visible: visible.join(''), reason: r };
  }

  flush(): void {
    if (this.buf) {
      if (this.inThink) this.reasoning.push(this.buf);
      else this.answer.push(this.buf);
      this.buf = '';
    }
  }

  reasoningText(): string {
    return this.reasoning.join('').trim();
  }
}

// ---- Provider factory ----

import { OpenAIProvider } from './openai';
import { GeminiProvider } from './gemini';
import { AnthropicProvider } from './anthropic';

/** Priority order for auto-selecting the first available provider */
export const PROVIDER_PRIORITY = [
  'anthropic', 'openrouter', 'deepseek', 'xai', 'mistral', 'together', 'cohere', 'perplexity', 'openai', 'groq', 'gemini',
  'nvidia', 'huggingface', 'ollama', 'lmstudio', 'llamacpp',
] as const;

/** 10x Maxx Smart Defaults for automatic model resolution when model is omitted */
export const SMART_DEFAULTS: Record<string, string> = {
  anthropic: 'claude-3-5-sonnet-latest',
  openrouter: 'anthropic/claude-3.5-sonnet:beta',
  deepseek: 'deepseek-chat',
  xai: 'grok-2-latest',
  mistral: 'mistral-large-latest',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  cohere: 'command-r-plus',
  perplexity: 'sonar-reasoning',
  openai: 'gpt-4o',
  groq: 'llama-3.3-70b-versatile',
  gemini: 'gemini-2.5-pro',
  nvidia: 'meta/llama-3.1-70b-instruct',
  huggingface: 'meta-llama/Llama-3.1-70B-Instruct',
  ollama: 'llama3.1',
  lmstudio: 'local-model',
  llamacpp: 'local-model',
};

/**
 * Build a provider instance by name. Throws ProviderError if unconfigured.
 * Mirrors the Python runtime's _build_profiles() provider catalogue.
 */
export function buildProvider(
  providerName: string,
  model: string | undefined,
  config: {
    geminiApiKey: string;
    anthropicApiKey: string;
    openaiApiKey: string;
    // Extended — pulled directly from Bun.env
    [k: string]: string | string[] | boolean | number | undefined;
  },
): Provider {
  const env = (key: string, fallback = '') =>
    (typeof Bun !== 'undefined' ? (Bun.env[key] ?? '') : (process.env[key] ?? '')) || fallback;

  switch (providerName) {
    case 'gemini':
      if (!config.geminiApiKey) throw new ProviderError('GEMINI_API_KEY not set', 'gemini');
      return new GeminiProvider(config.geminiApiKey, model || SMART_DEFAULTS.gemini);

    case 'anthropic':
    case 'claude':
      if (!config.anthropicApiKey) throw new ProviderError('ANTHROPIC_API_KEY not set', 'anthropic');
      return new AnthropicProvider(config.anthropicApiKey, model || SMART_DEFAULTS.anthropic);

    case 'openai':
      if (!config.openaiApiKey) throw new ProviderError('OPENAI_API_KEY not set', 'openai');
      return new OpenAIProvider(config.openaiApiKey, model || SMART_DEFAULTS.openai, 'https://api.openai.com/v1', 'openai');

    case 'openrouter': {
      const key = env('OPENROUTER_API_KEY');
      if (!key) throw new ProviderError('OPENROUTER_API_KEY not set', 'openrouter');
      return new OpenAIProvider(key, model || SMART_DEFAULTS.openrouter, 'https://openrouter.ai/api/v1', 'openrouter');
    }

    case 'groq': {
      const key = env('GROQ_API_KEY');
      if (!key) throw new ProviderError('GROQ_API_KEY not set', 'groq');
      return new OpenAIProvider(key, model || SMART_DEFAULTS.groq, 'https://api.groq.com/openai/v1', 'groq');
    }

    case 'xai': {
      const key = env('XAI_API_KEY');
      if (!key) throw new ProviderError('XAI_API_KEY not set', 'xai');
      return new OpenAIProvider(key, model || SMART_DEFAULTS.xai, 'https://api.x.ai/v1', 'xai');
    }

    case 'deepseek': {
      const key = env('DEEPSEEK_API_KEY');
      if (!key) throw new ProviderError('DEEPSEEK_API_KEY not set', 'deepseek');
      return new OpenAIProvider(key, model || SMART_DEFAULTS.deepseek, 'https://api.deepseek.com', 'deepseek');
    }

    case 'mistral': {
      const key = env('MISTRAL_API_KEY');
      if (!key) throw new ProviderError('MISTRAL_API_KEY not set', 'mistral');
      return new OpenAIProvider(key, model || SMART_DEFAULTS.mistral, 'https://api.mistral.ai/v1', 'mistral');
    }

    case 'together': {
      const key = env('TOGETHER_API_KEY');
      if (!key) throw new ProviderError('TOGETHER_API_KEY not set', 'together');
      return new OpenAIProvider(key, model || SMART_DEFAULTS.together, 'https://api.together.xyz/v1', 'together');
    }

    case 'cohere': {
      const key = env('COHERE_API_KEY');
      if (!key) throw new ProviderError('COHERE_API_KEY not set', 'cohere');
      // Cohere's v1 chat API isn't fully OpenAI compatible, but they often have compatible endpoints. 
      // We will map it to the standard OpenAI interface, assuming the user proxies it or Cohere adds support.
      // (Actually, Cohere does not have a drop-in OpenAI endpoint yet, but many users use LiteLLM to proxy it).
      return new OpenAIProvider(key, model || SMART_DEFAULTS.cohere, env('COHERE_BASE_URL', 'https://api.cohere.ai/v1'), 'cohere');
    }

    case 'perplexity': {
      const key = env('PERPLEXITY_API_KEY');
      if (!key) throw new ProviderError('PERPLEXITY_API_KEY not set', 'perplexity');
      return new OpenAIProvider(key, model || SMART_DEFAULTS.perplexity, 'https://api.perplexity.ai', 'perplexity');
    }

    case 'nvidia': {
      // NVIDIA NIM — OpenAI-compatible API on build.nvidia.com
      const key = env('NVIDIA_API_KEY');
      if (!key) throw new ProviderError('NVIDIA_API_KEY not set', 'nvidia');
      return new OpenAIProvider(
        key,
        model || env('NVIDIA_MODEL', 'meta/llama-3.1-70b-instruct'),
        env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1'),
        'nvidia',
      );
    }

    case 'huggingface': {
      // Hugging Face Inference API — OpenAI-compatible endpoint
      const key = env('HF_API_KEY', env('HUGGINGFACE_API_KEY'));
      if (!key) throw new ProviderError('HF_API_KEY (or HUGGINGFACE_API_KEY) not set', 'huggingface');
      const hfModel = model || env('HF_MODEL', 'meta-llama/Llama-3.1-70B-Instruct');
      const hfBase = env('HF_BASE_URL', `https://api-inference.huggingface.co/models/${hfModel}/v1`);
      return new OpenAIProvider(key, hfModel, hfBase, 'huggingface');
    }

    case 'ollama': {
      let base = env('OLLAMA_BASE_URL', 'http://localhost:11434/v1');
      if (!base.endsWith('/v1')) base = base.replace(/\/$/, '') + '/v1';
      return new OpenAIProvider('ollama', model || env('OLLAMA_MODEL', 'llama3.1'), base, 'ollama');
    }

    case 'lmstudio': {
      const base = env('LMSTUDIO_BASE_URL');
      if (!base) throw new ProviderError('LMSTUDIO_BASE_URL not set', 'lmstudio');
      return new OpenAIProvider(env('LMSTUDIO_API_KEY', 'lmstudio'), model || env('LMSTUDIO_MODEL', 'local-model'), base, 'lmstudio');
    }

    case 'llamacpp': {
      const base = env('LLAMACPP_BASE_URL');
      if (!base) throw new ProviderError('LLAMACPP_BASE_URL not set', 'llamacpp');
      return new OpenAIProvider(env('LLAMACPP_API_KEY', 'llamacpp'), model || 'local-model', base, 'llamacpp');
    }

    case 'mock':
      return new MockProvider(model || 'mock-1');

    default:
      throw new ProviderError(`Unknown provider: ${providerName}`, providerName);
  }
}

/** MockProvider for zero-cost testing & offline development */
export class MockProvider implements Provider {
  name = 'mock';
  defaultModel: string;

  constructor(model = 'mock-1') {
    this.defaultModel = model;
  }

  get model(): string {
    return this.defaultModel;
  }

  async complete(messages: Message[], options?: unknown): Promise<ModelTurn> {
    if ((globalThis as any).mockResponses && (globalThis as any).mockResponses.length > 0) {
      const step = (globalThis as any).mockResponses.shift();
      return {
        text: step.content,
        tool_calls: step.tool_calls || [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 20 },
        meta: { provider: 'mock' },
      };
    }
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    return {
      text: `[Mock Response] I processed your request: "${lastUserMsg.slice(0, 50)}"`,
      tool_calls: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 20 },
      meta: { provider: 'mock' },
    };
  }

  requestDescriptor(messages: Message[], tools?: unknown): Record<string, unknown> {
    return {
      provider: 'mock',
      model: this.defaultModel,
      messages_count: messages.length,
      tools_count: Array.isArray(tools) ? tools.length : 0,
    };
  }

  async streamTurn(
    messages: Message[],
    tools?: unknown,
    onDelta?: (chunk: string) => void,
    onReasoning?: (chunk: string) => void,
  ): Promise<ModelTurn> {
    if ((globalThis as any).mockResponses && (globalThis as any).mockResponses.length > 0) {
      const step = (globalThis as any).mockResponses.shift();
      if (onDelta) onDelta(step.content);
      return {
        text: step.content,
        tool_calls: step.tool_calls || [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 20 },
        meta: { provider: 'mock' },
      };
    }

    const responseText = `[Mock Stream] Response chunk.`;
    if (onDelta) {
      onDelta(responseText);
    }
    return {
      text: responseText,
      tool_calls: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 45, output_tokens: 18 },
      reasoning: 'Performing internal calculation: 25 * 4',
      meta: { provider: 'mock' },
    };
  }
}

/**
 * Build the next provider to fail over to, given providers already tried this
 * run. Mirrors kernel.py's `_next_fallback`: walk `fallbackChain` (explicit
 * config) then PROVIDER_PRIORITY, skipping anything already tried or unable
 * to build (missing key). Returns null if nothing else is available.
 */
export function nextFallbackProvider(
  triedNames: Set<string>,
  fallbackChain: readonly string[],
  config: Parameters<typeof buildProvider>[2],
): Provider | null {
  const candidates = [...fallbackChain, ...PROVIDER_PRIORITY];
  for (const name of candidates) {
    if (triedNames.has(name)) continue;
    try {
      return buildProvider(name, undefined, config);
    } catch {
      continue; // not configured — try the next one
    }
  }
  return null;
}
