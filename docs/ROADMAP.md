# Validation roadmap

## Current convergence skeleton

The public package graph now has one narrow seam for each responsibility:

```text
meaning -> control -> execution -> history
                 \-> recursive child runtime -> validated child receipt
```

Implemented skeleton:

- versioned intent, action, context, delegation, evidence, and receipt
  contracts;
- deterministic action and child-authority policy;
- bounded local and remote capability interfaces;
- semantic context records and phase-specific packets;
- one ordinary workflow kernel for top-level and child runs;
- causal recovery, observed-state completion, and replay;
- deterministic mechanism evals, CLI, and operator UI.

The presence of a seam is not evidence that the seam is mature. Delegation and
semantic context currently have deterministic unit coverage but not their own
ablation benchmark.

## Run 1 - deterministic foundation

Status: complete for the public v0.1.0 package boundary.

- versioned contracts;
- deterministic intent/condition/approval policy;
- capability grant;
- execute-observe-verify transition engine;
- hash-chained event sequence;
- controlled in-memory capability;
- three-condition ablation benchmark;
- compile, test, eval, and architecture gates.

Exit criterion: `bun run check` passes and the committed result matches the
versioned dataset.

## Run 2 - safe external capabilities

Status: vertical alpha implemented in v0.2.

- read-only filesystem adapter, then approval-gated writes;
- HTTP allowlists with DNS/IP and redirect enforcement;
- shell-free bounded process execution plus an optional fail-closed Linux
  bubblewrap backend; disposable deployment isolation remains required before
  a production security claim;
- idempotency and compensating-action contracts;
- credential-provider interface with no default secret;
- adapter contract tests and fault injection.

Current evidence: filesystem read/write/list, replayable clock, HTTP, process,
credential, dynamic MCP, gateway, and persistent replay paths are compile-gated.
The unconfigured process path still intentionally fails the stronger sandbox
criterion; configured bubblewrap availability is probed per call.

## Run 3 - model-integrated evaluation

Status: integration machinery, deterministic adaptive/adversarial benchmarks,
and the first credentialed multi-provider matrix are implemented.

- scripted, Anthropic Messages, and OpenAI-compatible transports produce
  canonical proposal events;
- frozen and held-out task suites;
- stale-context, prompt-injection, scope-drift, and false-success scenarios;
- repeated trials across providers and seeds;
- task success, policy compliance, latency, cost, and recovery outcomes;
- stronger harness baselines.

Current evidence: versioned context, false-completion, causal trace, recovery,
cyclic-pivot, ledger, prompt-injection authority, MCP reachability, and session
isolation fixtures pass. The current live report covers Gemini, Groq, NVIDIA,
Mistral, and OpenCode; NVIDIA inference returned 403 while the other four
providers stayed within the supplied action authority in two trials each.

## Run 4 - application and ecosystem

Status: local application and release-automation surfaces implemented; external
publication and independent validation remain pending.

- CLI and operator UI use the evaluated workflow HTTP service, canonical run
  projections, session Memory Graph, Context Inspector, and Runtime Lab;
- public workspaces versioned at 0.2.0;
- server-owned Streamable HTTP MCP discovery and bounded channel gateways added;
- CLI replay inspector added;
- external contribution and reproduction guide;
- independent security review before any production claim.

Current evidence: no default broad side effects, all public packages compile
under one strict gate, and architecture tests reject legacy imports and invalid
package dependency directions. External contribution, package registry
publication, and independent review remain.

### Multi-model pass routing

Status: local vertical slice implemented.

- Explicit provider/model pairs are persisted with each session agent.
- Fallback keeps route A preferred; ping-pong cycles two pairs; ring cycles
  three; ring-pair cycles four.
- Proposal and grounded-response calls share one deterministic pass counter.
- Every pass falls through remaining routes after transport or canonical
  proposal failure.
- Route selection and failure are canonical events; changing a model route
  never changes context authority, capability scope, policy, or verification.

Next operational experiments should measure whether mixed-provider schedules
improve verified completion after controlling for extra cost and latency. Phase
roles, health-weighted routing, and circuit breaking should be added only with
predeclared failure semantics; a structurally valid but poor proposal must not
be silently relabelled as provider failure.

## Next three polish passes

### Research wedge - representation drift

The context layer retains typed state, supersession, confidence, and a `drift`
tag. It now emits non-authorizing signals for explicit drift, contradictions,
lexical goal mismatch, and recent-history dominance. These are inspectable
proposal signals, not proof that the runtime may rewrite the goal.

The smallest admissible experiment is a frozen single-domain scenario with a
mid-run premise change:

```text
raw-history baseline
  versus
typed state + contradiction checkpoint
  -> same task and model
  -> inject the same changed premise
  -> measure stale action, detection-before-action, abstention, and overhead
```

Only after that state-layer treatment establishes an advantage should a second
experiment add abstraction snapshots and goal-mismatch detection. Semantic
distance alone is a proposal signal, never a deterministic proof of drift or
authority to rewrite the goal.

### Correction grammar wedge

The first deterministic slice is implemented: a human-authored rule can map an
observed failure code to a bounded repair constraint, with application and
next-action assessment recorded in the canonical ledger. The committed
baseline-versus-treatment fixture establishes mechanism wiring only.

The operator surface can now record real human correction traces and mark them
accepted for experiment without activating them as policy. The next experiment
should evaluate those accepted candidates against generic reflection prompts on
held-out tasks. Activation must remain an explicit task input. Primary measures
are selection accuracy, verified improvement, unnecessary intervention,
transfer, tokens, and latency.

### Polish A - delegation falsification

- Freeze adversarial fixtures for capability, resource, prohibition, approval,
  context, budget, identity, evidence, receipt, and output-schema violations.
- Compare ambient child access, narrowed delegation, and narrowed delegation
  plus parent result validation.
- Measure unauthorized child execution, context leakage, false acceptance,
  valid-child completion, latency, and token/action overhead.

Exit criterion: predeclared thresholds pass without weakening fixtures.

### Polish B - operational enforcement

Status: mechanism implementation and deterministic fault tests complete.

- Atomic child-budget reservation and settlement prevent concurrent admission
  from spending the same parent balance.
- Cancellable workers require termination to finish before abort is accepted.
- Ed25519 child receipts are verified against contract-pinned trusted keys.
- Linked checkpoint continuation and prepared-effect reconciliation recover
  canonical state without blindly replaying a possibly applied effect.

Exit criterion: fault-injection tests establish no double-spend, orphaned
authority, or accepted unverifiable result in the tested failure model.

### Polish C - live-model and external validity

Status: harnesses and release pipelines implemented; independent evidence is
still pending.

- Run frozen tasks across multiple providers, models, seeds, and media routes.
- Include prompt injection, stale context, scope drift, recovery, and nested
  delegation.
- Compare against stronger contemporary harness baselines.
- Accept independently authored fixtures through the contributed-eval schema,
  and obtain an independent security review using `docs/SECURITY_REVIEW.md`.

Exit criterion: publish raw trials, uncertainty, cost/latency tradeoffs,
failures, and bounded claims.

## External benchmark ladder

No single leaderboard can establish a best-in-class runtime. The external
validation plan should keep mechanism, model, harness, environment, and product
quality results separate:

| Layer | External reference | Hyper-Runtime experiment |
|---|---|---|
| Tool choice and argument correctness | [Berkeley Function Calling Leaderboard V4](https://gorilla.cs.berkeley.edu/leaderboard) | Export a frozen manifest subset; grade correct call, abstention, hallucinated tool, parallel call, latency, and cost without granting execution authority. |
| Policy-following API work | [tau-bench](https://arxiv.org/abs/2406.12045) | Run identical retail-style state tasks through reachability, authorization, and authorization-plus-verification conditions; report end-state accuracy and repeated-run `pass^k`. |
| General web and multimodal assistance | [GAIA](https://arxiv.org/abs/2311.12983) | Measure exact answer, verified evidence coverage, tool count, model calls, latency, and cost with hidden-answer scoring. |
| Multi-turn conversational memory | [MemoryAgentBench](https://arxiv.org/abs/2507.05257) | Score accurate retrieval, abstention, update/supersession, temporal ordering, cross-session isolation, and reconstruction separately. |
| Context efficiency | [Less Context, Better Agents](https://arxiv.org/abs/2606.10209) | Compare full history, recent-tool pruning, deterministic compaction, and pruning-plus-summary across every live provider; report completion, stale-state errors, premature termination, tokens, and latency. |
| Dialogue-driven coding | [Dialogue SWE-Bench](https://arxiv.org/abs/2606.13995) | Jointly grade clarification quality, user-intent tracking, task resolution, patch correctness, turns, model calls, and cost. |
| Long-horizon repository work | [SWE-Bench Pro](https://arxiv.org/abs/2509.16941) | Run only after the focused coding suite passes; preserve the benchmark harness contract and separate model, harness, context, and runtime failures. |
| Real computer use | [OSWorld](https://arxiv.org/abs/2404.07972) | Use disposable environments and execution-based end-state checks; keep GUI grounding errors distinct from policy denials and verifier failures. |
| Long-horizon terminal work | [TUA-Bench](https://arxiv.org/abs/2606.28480) | Evaluate reusable workflows, checkpoint recovery, artifact correctness, and operator intervention across deterministic task setups. |
| Multi-hour agent work | [AgencyBench](https://arxiv.org/abs/2601.11044) | Only after shorter suites pass, measure budget settlement, context drift, recovery, and deliverable rubrics over long trajectories. |

Every external run should publish exact harness and model revisions, task and
environment versions, raw canonical traces, seeds, retries, success and policy
outcomes, token/cost/latency distributions, operator interventions, and failure
taxonomy. Third-party fixtures remain held out until the mechanism and
thresholds are frozen. A benchmark score is model-plus-harness evidence, not a
runtime security proof.

## Maturity definition

Maturity is not feature count. It is:

```text
bounded claim
  -> explicit contract
    -> enforced transition
      -> observed outcome
        -> reproducible evidence
          -> adversarial falsification
            -> honest limitation
```
