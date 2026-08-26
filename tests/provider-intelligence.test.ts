import { describe, expect, test } from 'bun:test';
import {
  AnthropicMessagesTransport,
  CanonicalModelDriver,
  OpenAICompatibleTransport,
} from '@hyper/model';
import { DynamicContextCompiler } from '@hyper/context';
import {
  LocalInferenceAdmissionController,
  assessTaskComplexity,
  compactSessionMessages,
  selectQuantizedModel,
} from '@hyper/cli';

describe('provider intelligence and resource control', () => {
  test('converts one native provider tool call into a canonical proposal without model-authored runtime bookkeeping', async () => {
    let request: Parameters<NonNullable<ConstructorParameters<typeof CanonicalModelDriver>[0]['generate']>>[0] | undefined;
    const driver = new CanonicalModelDriver({
      id: 'native-fixture', model: 'local-tool-model', supportsNativeTools: true,
      async generate(input) {
        request = input;
        return {
          text: '',
          toolCalls: [{
            id: 'call-1',
            name: 'hyper_1_network_web_search',
            arguments: { query: 'Canada budget pressures' },
          }],
          usage: { inputTokens: 90, outputTokens: 12 },
        };
      },
    });
    const packet = new DynamicContextCompiler().compile({
      runId: 'run:native', phase: 'orient', objective: 'Search the web.', constraints: [],
      strategyId: 'strategy:native', focusTags: [], sources: [], tokenBudget: 500,
      now: '2026-08-24T12:00:00.000Z',
    });
    const result = await driver.propose(packet, [{
      id: 'network.web.search', version: '0.2.0', description: 'Search the public web.',
      effects: ['network.request', 'state.read'], requiredEffects: ['network.request'],
      targetPatterns: ['search://web'], riskCeiling: 3, approval: 'risk_based',
      idempotent: true, verification: 'required',
      inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } }, additionalProperties: false },
    }], {
      intentId: 'intent:native', principalId: 'agent:native',
      authorizedCapabilityIds: ['network.web.search'], requiredConditionIds: ['condition:request'],
      requiredEvidence: ['capability:network.web.search'], riskBudget: 3,
      activeStrategyId: 'strategy:native',
    });
    expect(request?.tools).toHaveLength(1);
    expect(request?.user).not.toContain('CURRENT_ACTION_CONTRACT_JSON');
    expect(result.proposal).toMatchObject({
      kind: 'action', strategyId: 'strategy:native',
      action: {
        intentId: 'intent:native', principalId: 'agent:native', conditionIds: ['condition:request'],
        capabilityId: 'network.web.search', target: 'search://web',
        declaredEffects: ['network.request'], risk: 2,
        expectedEvidence: ['capability:network.web.search'],
        args: { query: 'Canada budget pressures' },
      },
    });
    expect(result.requestAudit?.toolSchemaCharacters).toBeGreaterThan(0);
  });

  test('sends and parses OpenAI-compatible native tool calls', async () => {
    let body: Record<string, any> = {};
    const transport = new OpenAICompatibleTransport('local-tool-model', undefined, 'http://localhost:11434/v1', async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        choices: [{
          message: { content: null, tool_calls: [{ id: 'call-local', type: 'function', function: { name: 'clock', arguments: '{"timezone":"America/Toronto"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      });
    }, 60_000, 'ollama');
    const result = await transport.generate({
      system: 'Choose a tool.', user: 'What time is it?', format: 'text',
      tools: [{ name: 'clock', description: 'Read time.', inputSchema: { type: 'object' } }],
    });
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'clock' } });
    expect(result.toolCalls).toEqual([{
      id: 'call-local', name: 'clock', arguments: { timezone: 'America/Toronto' },
    }]);
    expect(result.text).toBe('');
  });

  test('preserves OpenAI-compatible assistant calls, tool results, and DeepSeek reasoning continuation', async () => {
    let body: Record<string, any> = {};
    const transport = new OpenAICompatibleTransport('deepseek-model', 'secret', 'https://deepseek.test/v1', async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        choices: [{ message: { content: 'The verified result is ready.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 8 },
      });
    }, 60_000, 'deepseek');
    await transport.generate({
      system: 'Use verified tool results.', user: 'unused', format: 'text',
      messages: [{
        id: 'user-1', role: 'user', createdAt: '2026-08-24T12:00:00.000Z',
        content: [{ type: 'text', text: 'Inspect the file.' }],
      }, {
        id: 'assistant-1', role: 'assistant', createdAt: '2026-08-24T12:00:00.000Z',
        providerState: { reasoningContent: 'I should inspect the requested file.' },
        content: [{ type: 'tool_call', callId: 'call-1', name: 'read_file', arguments: { path: 'README.md' } }],
      }, {
        id: 'tool-1', role: 'tool', createdAt: '2026-08-24T12:00:00.000Z',
        content: [{
          type: 'tool_result', callId: 'call-1', name: 'read_file', status: 'completed',
          summary: 'Read file.', content: '{"text":"verified"}', evidenceRefs: ['e1'], observationRefs: ['o1'],
        }],
      }],
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'Use verified tool results.' },
      { role: 'user', content: 'Inspect the file.' },
      { role: 'assistant', content: null, reasoning_content: 'I should inspect the requested file.', tool_calls: [{
        id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"text":"verified"}' },
    ]);
  });

  test('sends and parses Anthropic native tool-use blocks', async () => {
    let body: Record<string, any> = {};
    const transport = new AnthropicMessagesTransport('claude-sonnet-4-6', 'secret', 'https://anthropic.test/v1', async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'search_web', input: { query: 'current context engineering' } }],
        stop_reason: 'tool_use', usage: { input_tokens: 30, output_tokens: 8 },
      });
    });
    const result = await transport.generate({
      system: 'Choose a tool.', user: 'Research context engineering.',
      tools: [{ name: 'search_web', description: 'Search the web.', inputSchema: { type: 'object' } }],
    });
    expect(body.tools[0]).toMatchObject({ name: 'search_web', input_schema: { type: 'object' } });
    expect(result.toolCalls).toEqual([{
      id: 'toolu_1', name: 'search_web', arguments: { query: 'current context engineering' },
    }]);
  });

  test('places Anthropic tool results immediately after the matching tool use', async () => {
    let body: Record<string, any> = {};
    const transport = new AnthropicMessagesTransport('claude-sonnet-4-6', 'secret', 'https://anthropic.test/v1', async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 3 } });
    });
    await transport.generate({
      system: 'Use tools.', user: 'unused',
      messages: [{ id: 'u', role: 'user', createdAt: '2026-08-24T12:00:00.000Z', content: [{ type: 'text', text: 'Read it.' }] }, {
        id: 'a', role: 'assistant', createdAt: '2026-08-24T12:00:00.000Z',
        providerState: { anthropicThinkingBlocks: [{ type: 'thinking', thinking: 'bounded', signature: 'sig' }] },
        content: [{ type: 'tool_call', callId: 'toolu_1', name: 'read_file', arguments: { path: 'README.md' } }],
      }, {
        id: 't', role: 'tool', createdAt: '2026-08-24T12:00:00.000Z', content: [{
          type: 'tool_result', callId: 'toolu_1', name: 'read_file', status: 'completed',
          summary: 'Read.', content: '{"text":"ok"}', evidenceRefs: [], observationRefs: ['o1'],
        }],
      }],
    });
    expect(body.messages[1]).toMatchObject({
      role: 'assistant', content: [
        { type: 'thinking', thinking: 'bounded', signature: 'sig' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file' },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"text":"ok"}' }],
    });
  });

  test('uses one natural-language model call for conversation without a proposal schema', async () => {
    const requests: Array<{ system: string; user: string; format?: string }> = [];
    const driver = new CanonicalModelDriver({
      id: 'fixture', model: 'chat-model', endpoint: 'https://fixture.test/messages',
      async generate(request) {
        requests.push(request);
        return { text: 'Hello! What would you like to work on?', usage: { inputTokens: 18, outputTokens: 9 } };
      },
    });
    const result = await driver.respond({ objective: 'hi', operatorContext: 'Assistant: Welcome.' });
    expect(result.answer).toBe('Hello! What would you like to work on?');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.format).toBe('text');
    expect(requests[0]?.system).not.toContain('workflow proposal');
    expect(requests[0]?.system).toContain('not proof that a tool');
    expect(requests[0]?.system).toContain('no observed result');
    expect(requests[0]?.system).toContain('no explicit memory value was supplied');
  });

  test('rejects a truncated conversational answer so routing can recover', async () => {
    const driver = new CanonicalModelDriver({
      id: 'fixture', model: 'chat-model',
      async generate() {
        return { text: 'A partial answer', stopReason: 'max_tokens', usage: { inputTokens: 8, outputTokens: 32 } };
      },
    });
    await expect(driver.respond({ objective: 'Explain this fully.' }))
      .rejects.toThrow('MODEL_OUTPUT_TRUNCATED:max_tokens');
  });

  test('uses task-scoped output ceilings instead of reserving the model maximum', async () => {
    const requested: number[] = [];
    const driver = new CanonicalModelDriver({
      id: 'fixture', model: 'large-output-model',
      async generate(request) {
        requested.push(request.maxOutputTokens ?? 0);
        return { text: 'A useful answer.', usage: { inputTokens: 8, outputTokens: 4 } };
      },
    }, {
      profile: { contextWindow: 131_072, maxOutputTokens: 8_192, reasoningEfforts: ['off'] },
    });
    await driver.respond({ objective: 'Hello.', responseDepth: 'fast', maxOutputTokens: 768 });
    await driver.respond({ objective: 'Explain this.', responseDepth: 'reasoned' });
    expect(requested).toEqual([768, 2_048]);
  });

  test('accounts for OpenAI-compatible cache and reasoning usage and sends explicit effort', async () => {
    let body: Record<string, any> = {};
    const transport = new OpenAICompatibleTransport('reasoning-model', 'secret', 'https://provider.test/v1', async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        choices: [{ message: { content: '{"kind":"complete","strategyId":"s","evidenceRefs":[]}' } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 80 },
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      });
    }, 60_000, 'openai');
    const result = await transport.generate({ system: 'stable', user: 'dynamic', reasoningEffort: 'high', maxOutputTokens: 512 });
    expect(body).toMatchObject({ reasoning_effort: 'high', max_completion_tokens: 512 });
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 80, reasoningTokens: 20, totalTokens: 150 });
  });

  test('uses provider-native compatible fields instead of one assumed OpenAI body', async () => {
    const cases = [
      { dialect: 'gemini' as const, effort: 'off' as const, expected: { reasoning_effort: 'none', max_completion_tokens: 256 } },
      { dialect: 'groq' as const, effort: 'off' as const, expected: { reasoning_effort: 'none', max_tokens: 256 } },
      { dialect: 'ollama' as const, effort: 'max' as const, expected: { reasoning_effort: 'high', max_tokens: 256 } },
      { dialect: 'deepseek' as const, effort: 'max' as const, expected: { thinking: { type: 'enabled' }, reasoning_effort: 'max', max_tokens: 256 } },
      { dialect: 'mistral' as const, effort: 'high' as const, expected: { reasoning_effort: 'high', max_tokens: 256 } },
      { dialect: 'nvidia' as const, effort: 'high' as const, expected: { max_tokens: 256 } },
      { dialect: 'openrouter' as const, effort: 'max' as const, expected: { reasoning: { effort: 'max' }, max_tokens: 256 } },
      { dialect: 'llamacpp' as const, effort: 'off' as const, expected: { chat_template_kwargs: { enable_thinking: false }, max_tokens: 256 } },
      { dialect: 'lmstudio' as const, effort: 'high' as const, expected: { max_tokens: 256 } },
    ];
    for (const item of cases) {
      let body: Record<string, any> = {};
      const transport = new OpenAICompatibleTransport('model', 'secret', 'https://provider.test/v1', async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ message: { content: '{}' } }], usage: {} });
      }, 60_000, item.dialect);
      await transport.generate({ system: 'stable', user: 'dynamic', reasoningEffort: item.effort, maxOutputTokens: 256 });
      expect(body).toMatchObject(item.expected);
      if (item.dialect === 'nvidia' || item.dialect === 'lmstudio') expect(body.reasoning_effort).toBeUndefined();
      if (item.dialect === 'mistral') expect(body.prompt_cache_key).toStartWith('hyper:');
    }
  });

  test('retries transient provider failures but surfaces permanent provider diagnostics', async () => {
    let attempts = 0;
    const transient = new OpenAICompatibleTransport('flash', 'secret', 'https://provider.test/v1', async () => {
      attempts += 1;
      if (attempts < 3) return Response.json({ error: { message: 'temporarily overloaded' } }, { status: 503, headers: { 'retry-after': '0' } });
      return Response.json({ choices: [{ message: { content: '{}' } }], usage: {} });
    });
    expect((await transient.generate({ system: 'stable', user: 'dynamic' })).text).toBe('{}');
    expect(attempts).toBe(3);

    let permanentAttempts = 0;
    const permanent = new OpenAICompatibleTransport('bad-model', 'secret', 'https://provider.test/v1', async () => {
      permanentAttempts += 1;
      return Response.json({ error: { message: 'The model ID does not exist.' } }, { status: 400 });
    });
    await expect(permanent.generate({ system: 'stable', user: 'dynamic' }))
      .rejects.toThrow('HTTP 400: The model ID does not exist.');
    expect(permanentAttempts).toBe(1);

    const sensitive = new OpenAICompatibleTransport('bad-model', 'secret', 'https://provider.test/v1', async () =>
      Response.json({ error: { message: 'org_01secret used sk-sensitive12345678' } }, { status: 400 }));
    let message = '';
    try { await sensitive.generate({ system: 'stable', user: 'dynamic' }); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain('org_[redacted]');
    expect(message).toContain('[credential-redacted]');
    expect(message).not.toContain('org_01secret');
    expect(message).not.toContain('sk-sensitive12345678');
  });

  test('accounts for Anthropic cache usage and maps supported thinking budgets', async () => {
    let body: Record<string, any> = {};
    const transport = new AnthropicMessagesTransport('claude-test', 'secret', 'https://anthropic.test/v1', async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        content: [{ type: 'text', text: '{}' }],
        usage: { input_tokens: 90, output_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 20 },
      });
    });
    const result = await transport.generate({ system: 'stable', user: 'dynamic', reasoningEffort: 'medium', maxOutputTokens: 4_096 });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2_048 });
    expect(result.usage).toMatchObject({ inputTokens: 90, outputTokens: 10, cachedInputTokens: 60, cacheWriteTokens: 20, totalTokens: 100 });
  });

  test('uses adaptive Anthropic thinking for current Claude generations', async () => {
    let body: Record<string, any> = {};
    const transport = new AnthropicMessagesTransport('claude-sonnet-4-7', 'secret', 'https://anthropic.test/v1', async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 2, output_tokens_details: { thinking_tokens: 1 } } });
    });
    const result = await transport.generate({ system: 'stable', user: 'dynamic', reasoningEffort: 'high', maxOutputTokens: 4_096 });
    expect(body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, max_tokens: 4_096 });
    expect(body.thinking.budget_tokens).toBeUndefined();
    expect(result.usage.reasoningTokens).toBe(1);
  });

  test('fails preflight when the selected model context budget cannot hold input and output', async () => {
    const driver = new CanonicalModelDriver({
      id: 'bounded', model: 'tiny',
      async generate() { throw new Error('transport must not be reached'); },
    }, {
      profile: { contextWindow: 120, maxOutputTokens: 100, reasoningEfforts: ['off'], countTokens: text => Math.ceil(text.length / 10) },
      reasoningEffort: 'off',
    });
    const packet = new DynamicContextCompiler().compile({ runId: 'r', phase: 'orient', objective: 'Inspect.', constraints: [], strategyId: 's', focusTags: [], sources: [], tokenBudget: 20, now: '2026-01-01T00:00:00.000Z' });
    await expect(driver.propose(packet, [], { intentId: 'i', principalId: 'p', authorizedCapabilityIds: [], requiredConditionIds: [], requiredEvidence: [], riskBudget: 1, activeStrategyId: 's' }))
      .rejects.toThrow('MODEL_CONTEXT_BUDGET_EXCEEDED');
  });

  test('classifies complex work, selects a fitting quantization, and enforces concurrency', () => {
    expect(assessTaskComplexity('Implement and benchmark a multi-provider architecture with adversarial tests.').tier).toBe('strong');
    expect(assessTaskComplexity('Summarize this sentence.').tier).toBe('small');
    expect(selectQuantizedModel([
      { id: 'q4-small', bytes: 2_000, tier: 'small', quantization: 'Q4' },
      { id: 'q5-strong', bytes: 3_000, tier: 'strong', quantization: 'Q5' },
      { id: 'too-large', bytes: 9_000, tier: 'strong' },
    ], 5_000, 'strong')?.id).toBe('q5-strong');
    const admission = new LocalInferenceAdmissionController({ maxConcurrent: 1, minimumFreeMemoryBytes: 0, maximumLoadPerCpu: Number.MAX_SAFE_INTEGER });
    const first = admission.tryAcquire();
    expect(first.accepted).toBeTrue();
    expect(admission.tryAcquire()).toMatchObject({ accepted: false, reason: 'concurrency' });
    if (first.accepted) first.release();
    expect(admission.tryAcquire().accepted).toBeTrue();
  });

  test('compacts a thousand-message session deterministically with rebuild provenance', () => {
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      id: `message:${index}`,
      role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `turn ${index} ${'context '.repeat(20)}`,
      at: new Date(index * 1_000).toISOString(),
    }));
    const left = compactSessionMessages(messages);
    const right = compactSessionMessages(messages);
    expect(left.digest).toBe(right.digest);
    expect(left.omittedCount).toBeGreaterThan(980);
    expect(left.sourceMessageIds).toHaveLength(left.omittedCount);
    expect(left.summary.length).toBeLessThanOrEqual(4_100);
    expect(left.retained.at(-1)?.id).toBe('message:999');
  });
});
