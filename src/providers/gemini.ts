/**
 * providers/gemini.ts — Google Gemini streaming provider.
 *
 * Uses the Gemini REST API v1beta with SSE streaming.
 * Stateless: full context sent every time.
 *
 * CHANGED vs original:
 *   - `convertMessages()` now turns assistant `tool_calls` into `functionCall`
 *     parts and 'tool' role messages into `functionResponse` parts (keyed by
 *     the tool name, which Gemini requires), instead of flattening everything
 *     to plain text parts.
 */

import type { ModelTurn, ToolCallRequest } from '../types/messages';
import type { Provider, ToolSpec, OnDelta, OnReasoning, Message } from './base';
import { ProviderError, RateLimitError, parseSSEStream, DegenerationGuard, ThinkFilter } from './base';

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { content: string } } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export class GeminiProvider implements Provider {
  readonly name = 'gemini';
  readonly model: string;
  private apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model || 'gemini-2.5-flash';
  }

  requestDescriptor(
    messages: Message[],
    tools: ToolSpec[],
  ): Record<string, unknown> {
    return {
      provider: 'gemini',
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
    // Convert standard messages to Gemini format
    const { contents, systemInstruction } = this.convertMessages(messages);

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) {
      body.system_instruction = systemInstruction;
    }

    // Convert tool specs to Gemini function declarations
    if (tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new RateLimitError('Rate limited by Gemini', 'gemini', 10);
      }
      const errText = await response.text();
      throw new ProviderError(
        `Gemini error ${response.status}: ${errText.slice(0, 300)}`,
        'gemini',
      );
    }

    if (!response.body) {
      throw new ProviderError('No response body from Gemini', 'gemini');
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      if (payload.error) {
        throw new ProviderError(`API Error: ${payload.error.message || JSON.stringify(payload.error)}`, 'gemini');
      }
      throw new ProviderError(`Expected stream but got JSON: ${JSON.stringify(payload).slice(0, 200)}`, 'gemini');
    }

    let text = '';
    const tool_calls: ToolCallRequest[] = [];
    let stopReason = 'stop';
    let usage = { input_tokens: 0, output_tokens: 0 };
    let callIndex = 0;
    
    const dGuard = new DegenerationGuard();
    const tFilter = new ThinkFilter();
    let isDegenerate = false;

    try {
      for await (const chunk of parseSSEStream(response.body)) {
      // Usage metadata
      const usageMeta = chunk.usageMetadata as Record<string, number> | undefined;
      if (usageMeta) {
        usage = {
          input_tokens: usageMeta.promptTokenCount ?? 0,
          output_tokens: usageMeta.candidatesTokenCount ?? 0,
        };
      }

      const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
      if (!candidates || candidates.length === 0) continue;

      const candidate = candidates[0];

      // Finish reason
      if (candidate.finishReason) {
        const reason = String(candidate.finishReason);
        stopReason = reason === 'STOP' ? 'stop' : reason.toLowerCase();
      }

      const content = candidate.content as { parts?: Array<Record<string, unknown>> } | undefined;
      if (!content?.parts) continue;

      for (const part of content.parts) {
        // Text part
        if (typeof part.text === 'string' && part.text) {
          const { visible, reason } = tFilter.feed(part.text);
          if (visible) {
            text += visible;
            await onDelta(visible);
          }
          if (reason && onReasoning) {
            await onReasoning(reason);
          }
          
          if (dGuard.feed(part.text)) {
            isDegenerate = true;
            stopReason = 'degeneration_abort';
            break;
          }
        }

        // Thinking/reasoning part
        if (typeof part.thought === 'string' && part.thought && onReasoning) {
          await onReasoning(part.thought);
        }

        // Function call part
        const fc = part.functionCall as { name: string; args: Record<string, unknown> } | undefined;
        if (fc) {
          tool_calls.push({
            id: `gemini_${callIndex++}`,
            name: fc.name,
            args: fc.args || {},
          });
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

    return {
      text,
      tool_calls,
      stop_reason: stopReason,
      usage,
      meta: { degenerate: isDegenerate },
      reasoning: tFilter.reasoningText(),
    };
  }

  /** Convert the shared Message[] into Gemini's contents format */
  private convertMessages(messages: Message[]): {
    contents: GeminiContent[];
    systemInstruction?: { parts: Array<{ text: string }> };
  } {
    let systemInstruction: { parts: Array<{ text: string }> } | undefined;
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Gemini uses system_instruction, not a system message
        if (!systemInstruction) {
          systemInstruction = { parts: [{ text: msg.content }] };
        } else {
          systemInstruction.parts[0].text += '\n\n' + msg.content;
        }
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const parts: GeminiPart[] = [];
        if (msg.content) parts.push({ text: msg.content });
        for (const tc of msg.tool_calls) {
          parts.push({ functionCall: { name: tc.name, args: tc.args } });
        }
        contents.push({ role: 'model', parts });
        continue;
      }

      if (msg.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: msg.name || 'unknown_tool',
              response: { content: msg.content },
            },
          }],
        });
        continue;
      }

      // Map roles: assistant -> model, everything else -> user
      const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
      contents.push({ role: geminiRole, parts: [{ text: msg.content }] });
    }

    // Gemini requires contents to start with 'user' and alternate
    // If it starts with 'model', prepend a dummy user message
    if (contents.length > 0 && contents[0].role === 'model') {
      contents.unshift({ role: 'user', parts: [{ text: '(continue)' }] });
    }

    // Merge consecutive same-role messages (Gemini requires alternation)
    const merged: GeminiContent[] = [];
    for (const c of contents) {
      const last = merged[merged.length - 1];
      if (last && last.role === c.role) {
        last.parts.push(...c.parts);
      } else {
        merged.push({ role: c.role, parts: [...c.parts] });
      }
    }

    return { contents: merged, systemInstruction };
  }
}
