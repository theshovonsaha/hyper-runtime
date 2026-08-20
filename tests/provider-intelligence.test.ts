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
    });
    const result = await transport.generate({ system: 'stable', user: 'dynamic', reasoningEffort: 'high', maxOutputTokens: 512 });
    expect(body).toMatchObject({ reasoning_effort: 'high', max_completion_tokens: 512 });
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 80, reasoningTokens: 20, totalTokens: 150 });
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
