/**
 * providers/anthropic.ts — Anthropic Claude streaming provider.
 *
 * Uses the Messages API with SSE streaming.
 * Stateless: full context sent every time.
 *
 * CHANGED vs original:
 *   - `toApiMessages()` now converts assistant messages with `tool_calls` into
 *     proper `tool_use` content blocks, and 'tool' role messages into
 *     `tool_result` blocks keyed by `tool_use_id`. Previously tool calls/
 *     results were silently flattened into plain text, so the model never saw
 *     a structured record of its own prior tool calls.
 *   - `ensureAlternation()` now merges by *concatenating content-block arrays*
 *     when either side is already block-form, instead of naive string concat.
 */

import type { ModelTurn, ToolCallRequest } from '../types/messages';
import type { Provider, ToolSpec, OnDelta, OnReasoning, Message } from './base';
import { ProviderError, RateLimitError, DegenerationGuard, ThinkFilter } from './base';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly model: string;
  private apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model || 'claude-sonnet-4-20250514';
  }

  requestDescriptor(
    messages: Message[],
    tools: ToolSpec[],
  ): Record<string, unknown> {
    return {
      provider: 'anthropic',
      model: this.model,
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
    // Extract system message (Anthropic uses a top-level `system` field)
    let system = '';
    const apiMessages: AnthropicMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        system += (system ? '\n\n' : '') + msg.content;
        continue;
      }
      apiMessages.push(this.toApiMessage(msg));
    }

    // Ensure messages alternate user/assistant (Anthropic requires this)
    const merged = this.ensureAlternation(apiMessages);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 8192,
      messages: merged,
      stream: true,
    };
    if (system) body.system = system;

    // Convert tool specs to Anthropic format
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = parseFloat(response.headers.get('retry-after') || '10');
        throw new RateLimitError('Rate limited by Anthropic', 'anthropic', retryAfter);
      }
      const errText = await response.text();
      throw new ProviderError(
        `Anthropic error ${response.status}: ${errText.slice(0, 300)}`,
        'anthropic',
      );
    }

    if (!response.body) {
      throw new ProviderError('No response body from Anthropic', 'anthropic');
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      if (payload.error) {
        throw new ProviderError(`API Error: ${payload.error.message || JSON.stringify(payload.error)}`, 'anthropic');
      }
      throw new ProviderError(`Expected stream but got JSON: ${JSON.stringify(payload).slice(0, 200)}`, 'anthropic');
    }

    // Parse Anthropic's SSE format (different from OpenAI)
    let text = '';
    const toolCallsMap = new Map<number, {
      id: string;
      name: string;
      input_json: string;
    }>();
    let currentBlockIndex = -1;
    let stopReason = 'stop';
    let usage = { input_tokens: 0, output_tokens: 0 };
    
    const dGuard = new DegenerationGuard();
    const tFilter = new ThinkFilter();
    let isDegenerate = false;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let currentEvent = '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7);
            continue;
          }
          if (!trimmed.startsWith('data: ')) continue;
          const jsonStr = trimmed.slice(6);

          let data: Record<string, unknown>;
          try {
            data = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          switch (currentEvent || data.type) {
            case 'error': {
              const err = data.error as Record<string, unknown> | undefined;
              throw new ProviderError(`Anthropic stream error: ${err?.message || JSON.stringify(err)}`, 'anthropic');
            }
            case 'message_start': {
              const msg = data.message as Record<string, unknown>;
              if (msg?.usage) {
                const u = msg.usage as Record<string, number>;
                usage.input_tokens = u.input_tokens ?? 0;
              }
              break;
            }

            case 'content_block_start': {
              currentBlockIndex = (data.index as number) ?? currentBlockIndex + 1;
              const block = data.content_block as Record<string, unknown>;
              if (block?.type === 'tool_use') {
                toolCallsMap.set(currentBlockIndex, {
                  id: String(block.id || ''),
                  name: String(block.name || ''),
                  input_json: '',
                });
              }
              break;
            }

            case 'content_block_delta': {
              const delta = data.delta as Record<string, unknown>;
              if (!delta) break;
              const idx = (data.index as number) ?? currentBlockIndex;

              if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                const { visible, reason } = tFilter.feed(delta.text);
                if (visible) {
                  text += visible;
                  await onDelta(visible);
                }
                if (reason && onReasoning) {
                  await onReasoning(reason);
                }
                
                if (dGuard.feed(delta.text)) {
                  isDegenerate = true;
                  stopReason = 'degeneration_abort';
                  // To gracefully abort, we could break completely, but Anthropic's stream might have
                  // more tools? We'll just break out.
                  break;
                }
              }

              if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                if (onReasoning) await onReasoning(delta.thinking);
              }

              if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                const entry = toolCallsMap.get(idx);
                if (entry) entry.input_json += delta.partial_json;
              }
              break;
            }

            case 'message_delta': {
              const delta = data.delta as Record<string, unknown>;
              if (delta?.stop_reason) {
                stopReason = String(delta.stop_reason) === 'end_turn' ? 'stop' : String(delta.stop_reason);
              }
              const u = data.usage as Record<string, number> | undefined;
              if (u) {
                usage.output_tokens = u.output_tokens ?? 0;
              }
              break;
            }

            case 'message_stop':
              break;
          }
        }
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      // Aborted or error
    } finally {
      reader.releaseLock();
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
        args = JSON.parse(entry.input_json || '{}');
      } catch {
        // malformed
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

  /** Convert one shared Message into Anthropic's user/assistant + block shape. */
  private toApiMessage(msg: Message): AnthropicMessage {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const blocks: AnthropicBlock[] = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      return { role: 'assistant', content: blocks };
    }

    if (msg.role === 'tool') {
      // Anthropic requires tool results to arrive as a 'user' message.
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || '',
          content: msg.content,
        }],
      };
    }

    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    return { role, content: msg.content };
  }

  /** Ensure messages alternate between user/assistant (Anthropic requirement) */
  private ensureAlternation(messages: AnthropicMessage[]): AnthropicMessage[] {
    if (messages.length === 0) return [{ role: 'user', content: '(continue)' }];

    const result: AnthropicMessage[] = [];

    // Must start with user
    if (messages[0].role !== 'user') {
      result.push({ role: 'user', content: '(continue)' });
    }

    for (const msg of messages) {
      const last = result[result.length - 1];
      if (last && last.role === msg.role) {
        last.content = this.mergeContent(last.content, msg.content);
      } else {
        result.push({ role: msg.role, content: msg.content });
      }
    }

    return result;
  }

  /** Merge two content values (string or block-array) into one block-array/string. */
  private mergeContent(
    a: string | AnthropicBlock[],
    b: string | AnthropicBlock[],
  ): string | AnthropicBlock[] {
    if (typeof a === 'string' && typeof b === 'string') {
      return a + '\n\n' + b;
    }
    const aBlocks: AnthropicBlock[] = typeof a === 'string' ? (a ? [{ type: 'text', text: a }] : []) : a;
    const bBlocks: AnthropicBlock[] = typeof b === 'string' ? (b ? [{ type: 'text', text: b }] : []) : b;
    return [...aBlocks, ...bBlocks];
  }
}
