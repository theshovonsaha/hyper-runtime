# Provider intelligence, budgets, and live inference evidence

Hyper-Runtime treats model metadata and model output as inputs to the runtime,
never as authority. Provider profiles can be attached to each configured model:

```ts
providers: [{
  id: 'local',
  transport: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  defaultModel: 'qwen:8b-q4',
  models: [{
    id: 'qwen:8b-q4',
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    reasoningEfforts: ['off', 'low', 'medium'],
    defaultReasoningEffort: 'low',
    tier: 'small',
    quantization: 'Q4_K_M',
    parameterBytes: 5_200_000_000,
  }],
}]
```

`GET /api/models/:provider` returns configured or provider-advertised context
limits, output limits, reasoning modes, tier, quantization, metadata source, and
explicit limitations when the endpoint does not advertise them. A configured
profile is the enforceable source: the workflow context budget reserves output
and stable-prompt headroom, while the model boundary performs a second preflight
check before transport.

Provider usage is canonical after a response. The ledger records actual input,
output, cached-input, cache-write, reasoning, and total tokens when the provider
exposes them. Cost is computed only when explicit per-million-token rates exist.
Before a request, token counts remain estimates unless the selected profile has
a tokenizer-specific counter; an estimate is never presented as provider usage.

The proposal prompt has a stable system prefix containing runtime rules and
capability schemas. Per-pass scope and context live in the dynamic user message.
OpenAI-compatible cache counters are read from usage details. Anthropic receives
an ephemeral cache marker on the stable system block and its cache-read/write
usage is recorded. Stable-prefix hashes make reuse auditable without storing
hidden model state or chain-of-thought.

When multiple configured routes advertise tiers, a deterministic complexity
assessment prefers a small model for short, reversible tasks and a strong model
for engineering, research, multi-step, and verification-heavy work. Explicit
provider/model choices remain authoritative operator preferences. The routing
decision and reasons are recorded in `operator.run_started`.

Local inference uses CPU load, system free memory, and configured GPU memory as
admission signals. It enforces concurrency, CPU-pressure, and memory-pressure
limits before a local run starts. `GET /api/runtime/resources` exposes the live
snapshot. Quantized model selection admits only candidates fitting 80% of the
available memory and then prefers the requested tier and largest fitting model.
GPU free-memory discovery is not portable, so it must be supplied by the host
integration; the runtime reports configured data rather than inventing it.

Successful fast runs and verified artifact-producing tasks skip the extra
synthesis call. Other completed runs retain grounded natural-language synthesis.
The ledger records `response.synthesis_skipped` or the ordinary synthesis event,
so saved tokens never obscure how the answer was produced.

Long sessions use a deterministic compacted projection plus bounded recent
turns. The projection records every omitted message ID and a digest, while the
canonical messages remain available to rebuild it. The stress suite currently
checks deterministic reconstruction provenance across 1,000 turns.

## Evidence

`bun run eval:live` exercises every configured provider selected through
`HYPER_LIVE_EVAL_PROVIDERS`. It measures latency, provider-observed tokens, cost
when configured, exact context-target recall, bounded answer/proposal quality,
task completion, prompt-injection resistance, and cancellation latency. Results
are live-model evidence and are written to
`evals/results/live-provider-latest.json`; they are not part of the deterministic
release gate because credentials, network conditions, and provider behavior are
external variables.

The deterministic provider-intelligence suite mocks both OpenAI-compatible and
Anthropic contracts, hostile usage fields, context overflow, resource admission,
quantization selection, routing classification, and long-session compaction.
It establishes adapter logic, not live-provider quality.
