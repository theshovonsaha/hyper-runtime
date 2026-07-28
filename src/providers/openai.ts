/**
 * providers/openai.ts — OpenAI-compatible streaming provider.
 *
 * Works with: OpenAI, OpenRouter, Groq, LM Studio, llama.cpp, NVIDIA NIM,
 * Hugging Face Inference API, etc.
 * Uses the stateless /v1/chat/completions endpoint with streaming.
 * No SDK — raw fetch only.
 *
 * CHANGED vs original:
 *   - Previously `messages` was passed straight through to `body.messages`.
 *     A `{role:'tool', content}` message with no `tool_call_id` is REJECTED
 *     by the real OpenAI-compatible API (400 invalid_request_error) — the
 *     API requires tool messages to carry `tool_call_id`, and the preceding
 *     assistant message to carry a matching `tool_calls[].id`. `toApiMessages()`
 *     now performs that conversion explicitly instead of assuming the caller
 *     already produced OpenAI's wire shape.
 */

import type { ModelTurn, ToolCallRequest } from '../types/messages';
import type { Provider, ToolSpec, OnDelta, OnReasoning, Message } from './base';
import { ProviderError, RateLimitError, parseSSEStream, DegenerationGuard, ThinkFilter, ToolUseFormatError } from './base';

export function recoverFailedGeneration(error: Record<string, any>): ToolCallRequest | null {
  if (error.code !== 'tool_use_failed') return null;
  const raw = String(error.failed_generation || '');
  const nameMatch = raw.match(/<function=(\w+)/);
  if (!nameMatch) return null;
  
  const rest = raw.slice(nameMatch.index! + nameMatch[0].length);
  const start = rest.indexOf('{');
  if (start === -1) return null;
  
  let depth = 0;
  for (let i = start; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const args = JSON.parse(rest.slice(start, i + 1));
          if (typeof args === 'object' && args !== null) {
            return { id: 'call_recovered_0', name: nameMatch[1], args };
          }
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export class OpenAIProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(
    apiKey: string,
    model?: string,
    baseUrl?: string,
    name?: string,
  ) {
    this.apiKey = apiKey;
    this.model = model || 'gpt-4o-mini';
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.name = name || 'openai';
  }

  requestDescriptor(
    messages: Message[],
    tools: ToolSpec[],
  ): Record<string, unknown> {
    return {
      provider: this.name,
      model: this.model,
      endpoint: `${this.baseUrl}/chat/completions`,
      messages_count: messages.length,
      tools_count: tools.length,
      total_chars: messages.reduce((s, m) => s + m.content.length, 0),
    };
  }

  async streamTurn(
    messages: Message[],
    tools: ToolSpec[],
    onDelta: OnDelta,
    onReasoning?: OnReasoning,
  ): Promise<ModelTurn> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.toApiMessages(messages),
      stream: true,
    };
    if (this.name === 'openai' || this.name === 'openrouter' || this.name === 'nvidia') {
      body.stream_options = { include_usage: true };
    }
    if (tools.length > 0) body.tools = tools;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = parseFloat(response.headers.get('retry-after') || '10');
        throw new RateLimitError('Rate limited by OpenAI', this.name, retryAfter);
      }
      const errText = await response.text();
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error) {
          const recovered = recoverFailedGeneration(errJson.error);
          if (recovered) {
            return {
              text: '',
              tool_calls: [recovered],
              stop_reason: 'tool_calls',
              usage: { input_tokens: 0, output_tokens: 0 },
            };
          }
        }
      } catch {}
      throw new ProviderError(
        `OpenAI error ${response.status}: ${errText.slice(0, 300)}`,
        this.name,
      );
    }

    if (!response.body) {
      throw new ProviderError('No response body from OpenAI', this.name);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      if (payload.error) {
        const recovered = recoverFailedGeneration(payload.error);
        if (recovered) {
          return {
            text: '',
            tool_calls: [recovered],
            stop_reason: 'tool_calls',
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        }
        throw new ProviderError(`API Error: ${payload.error.message || JSON.stringify(payload.error)}`, this.name);
      }
      throw new ProviderError(`Expected stream but got JSON: ${JSON.stringify(payload).slice(0, 200)}`, this.name);
    }

    // Accumulate the response
    let text = '';
    const toolCallsMap = new Map<number, {
      id: string;
      name: string;
      arguments: string;
    }>();
    let stopReason = 'stop';
    let usage = { input_tokens: 0, output_tokens: 0 };
    
    const dGuard = new DegenerationGuard();
    const tFilter = new ThinkFilter();
    let isDegenerate = false;

    try {
      for await (const chunk of parseSSEStream(response.body)) {
        // Usage (final chunk)
        if (chunk.usage) {
          const u = chunk.usage as Record<string, number>;
          usage = {
            input_tokens: u.prompt_tokens ?? 0,
            output_tokens: u.completion_tokens ?? 0,
          };
        }

        if (chunk.error) {
          const e = chunk.error as Record<string, unknown>;
          const recovered = recoverFailedGeneration(e);
          if (recovered) {
            return {
              text: text,
              tool_calls: [recovered],
              stop_reason: 'tool_calls',
              usage: usage,
            };
          }
          throw new ProviderError(`Stream Error: ${e.message || JSON.stringify(e)}`, this.name);
        }

      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      if (!choices || choices.length === 0) continue;

      const choice = choices[0];
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      // Finish reason
      if (choice.finish_reason) {
        stopReason = String(choice.finish_reason);
      }

      // Content delta
      if (typeof delta.content === 'string' && delta.content) {
        const { visible, reason } = tFilter.feed(delta.content);
        if (visible) {
          text += visible;
          await onDelta(visible);
        }
        if (reason && onReasoning) {
          await onReasoning(reason);
        }
        
        if (dGuard.feed(delta.content)) {
          isDegenerate = true;
          stopReason = 'degeneration_abort';
          break; // break out of stream
        }
      }

      // Tool call deltas (index-based accumulation)
      const tcDeltas = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (tcDeltas) {
        for (const tc of tcDeltas) {
          const idx = (tc.index as number) ?? 0;
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, { id: '', name: '', arguments: '' });
          }
          const entry = toolCallsMap.get(idx)!;
          if (tc.id) entry.id = String(tc.id);
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn) {
            if (fn.name) entry.name = String(fn.name);
            if (typeof fn.arguments === 'string') entry.arguments += fn.arguments;
          }
        }
      }
    }
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      // Stream aborted or error, handle gracefully
    }
    
    tFilter.flush();
    if (tFilter.answer.length > 0) {
       const vis = tFilter.answer.join('');
       text += vis;
       await onDelta(vis);
    }
    if (tFilter.reasoning.length > 0 && onReasoning) {
       await onReasoning(tFilter.reasoning.join(''));
    }

    // Build tool calls
    const tool_calls: ToolCallRequest[] = [];
    for (const [, entry] of [...toolCallsMap.entries()].sort((a, b) => a[0] - b[0])) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(entry.arguments || '{}');
      } catch {
        // malformed JSON from model — pass empty args
      }
      tool_calls.push({ id: entry.id, name: entry.name, args });
    }

    return {
      text,
      tool_calls,
      stop_reason: stopReason,
      usage,
      meta: { degenerate: isDegenerate },
      reasoning: tFilter.reasoningText(),
    };
  }

  /** Convert the shared Message[] into OpenAI's chat-completion wire shape. */
  private toApiMessages(messages: Message[]): OpenAIMessage[] {
    return messages.map((msg): OpenAIMessage => {
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
          })),
        };
      }
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.tool_call_id || '',
          ...(msg.name ? { name: msg.name } : {}),
        };
      }
      return { role: msg.role, content: msg.content };
    });
  }
}
