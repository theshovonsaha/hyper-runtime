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
