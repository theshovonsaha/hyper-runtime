# Local model and pass-factory probes

## Mechanism map

The proposed "bounded pass" is not a separate agent in the current public
architecture. Its implemented pieces are:

```text
canonical events + current sources
  -> DynamicContextCompiler
  -> ContextPacket (bounded local model-facing world)
  -> ModelDriver proposal
  -> policy + capability input schema
  -> execute -> observe -> verify
  -> causal/context events
  -> next ContextPacket
```

The packet currently carries objective, active strategy, phase, constraints,
selected artifacts, provenance, authority, and a token budget. The model also
receives exact proposal scope, intent-authorized capability manifests, and argument
schemas. Runtime-only grants, approvals, ledger hashes, and adapter enforcement
remain outside the prompt.

Compilation now assigns every omitted source an explicit reason and collapses
exact duplicate non-authoritative content before it spends the token budget.
The retained representation preserves the contributing source IDs and merged
provenance. Directive and constraint records are never collapsed because equal
wording can still have distinct provenance or conceal an authoritative conflict.

This establishes a pass compiler and validator. Human-authored correction rules
can now activate a one-pass repair constraint from an exact failure code and
record the following outcome. The runtime still does not learn correction
grammar from conversations, detect semantic abstraction drift, attribute
natural-language causality, or establish optimal context selection.

## Separate three kinds of stickiness

Do not interpret all retained memory as one mechanism:

1. **Runtime resend:** the application included old material in the next packet.
2. **Server session state:** the inference endpoint associated requests with a
   conversation or response identifier.
3. **Inference cache:** the engine retained prompt-prefix/KV state or allocator
   capacity.

Hyper-Runtime's OpenAI-compatible transport sends two messages per request and
does not send a conversation ID or previous-response ID. Its request audit
records `sessionIdentifier: null`. This describes the client request, not proof
that a third-party server retains no hidden state.

## Instrumentation now emitted

Every live `model.proposed` event can include:

- endpoint and null session identifier;
- message count;
- prompt character count and token estimate;
- capability-schema character count;
- system/context character counts and separate SHA-256 hashes;
- combined SHA-256 prompt hash; and
- provider-reported input/output tokens and latency.

Every `context.compiled` event includes the pass objective, strategy, legal
capability IDs, output contract, required evidence, risk budget, reasoned
exclusions, stable/dynamic token totals, budget utilization, and duplicate
tokens removed. Raw prompts are not written to the ledger because they may
contain sensitive source material. Hashes audit identity, not semantic
equivalence. Server-applied chat-template tokens are not visible through the
generic transport.

## Frozen probe matrix

| Probe | Controlled comparison | Primary observation |
|---|---|---|
| Hidden-context | independent request after a secret-bearing request | omitted secret is not recalled |
| Packet identity | logged request hash versus expected rendered request | resend/mutation detected |
| Context sweep | 1K, 2K, 4K, 8K, 16K, 32K tokens after cold restart | peak memory and prompt latency curve |
| Warm retention | same sweep without restart | retained allocation/cache delta |
| Prefix reuse | stable prefix with changed suffix, then earlier mutations | prompt-evaluation latency delta |
| Cache release | sample at 0s, 10s, 60s, and 5m | pressure/swap and resident-memory decay |
| Concurrency | one, two, and four equal-context requests | per-slot memory multiplication |
| Exact duplicates | repeated artifacts under different source IDs | collapsed IDs, provenance, and tokens removed |
| Instruction conflict | old versus new directive at controlled positions | adherence, recency, lost-middle errors |
| Runtime ablation | full accumulated history versus bounded packets | task accuracy, stale action, tokens, latency, RAM |

For macOS experiments, capture memory pressure and swap alongside process
resident memory. Retained allocation is not equivalent to active memory
pressure.

## Experiment discipline

- Keep model, quantization, server build, sampling settings, objective, and
  generated-token limit fixed.
- Restart between cold trials and randomize condition order where practical.
- Record server configuration, context limit, concurrency/slot count, and
  whether prefix caching is enabled.
- Predeclare the outcome metric and failure threshold before examining results.
- Treat provider token counts and operating-system memory readings as distinct
  measurements.
- Never describe a scripted run as live-model or memory evidence.

The first product-relevant experiment is the final row: accumulated history
versus bounded recompilation. The cache probes explain *why* resource use may
change; they do not by themselves establish better task behavior.
