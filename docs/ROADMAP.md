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
- shell-free bounded process execution; hardened disposable OS isolation remains
  required before a security claim;
- idempotency and compensating-action contracts;
- credential-provider interface with no default secret;
- adapter contract tests and fault injection.

Current evidence: filesystem, HTTP, process, credential, remote-manifest, and
persistent replay paths are compile-gated. The process path intentionally fails
the stronger "security sandbox" criterion.

## Run 3 - model-integrated evaluation

Status: integration machinery and deterministic adaptive benchmark implemented;
live-model trials remain pending.

- scripted, Anthropic Messages, and OpenAI-compatible transports produce
  canonical proposal events;
- frozen and held-out task suites;
- stale-context, prompt-injection, scope-drift, and false-success scenarios;
- repeated trials across providers and seeds;
- task success, policy compliance, latency, cost, and recovery outcomes;
- stronger harness baselines.

Current evidence: versioned context, false-completion, causal trace, recovery,
cyclic-pivot, and ledger fixtures pass. No live-model claim is made.

## Run 4 - application and ecosystem

Status: local application surface implemented; external ecosystem validation
remains pending.

- CLI and operator UI added around public concepts; the UI still consumes the
  existing local SSE API until the new workflow HTTP service is exposed;
- public workspaces versioned at 0.2.0;
- remote capability manifest boundary added; a production MCP client remains;
- CLI replay inspector added;
- external contribution and reproduction guide;
- independent security review before any production claim.

Current evidence: no default broad side effects, all public packages compile
under one strict gate, and architecture tests reject legacy imports and invalid
package dependency directions. External contribution, package registry
publication, and independent review remain.

## Next three polish passes

### Research wedge - representation drift

The current context layer can retain typed state, supersession, confidence,
and a `drift` tag. It does not yet determine that an internally consistent
representation has become the wrong abstraction for the current goal. That is
distinct from fact recall and direct contradiction detection.

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

The next experiment should extract candidate rules from real human correction
traces, require human acceptance before activation, and compare accepted rules
against generic reflection prompts on held-out tasks. Primary measures are
selection accuracy, verified improvement, unnecessary intervention, transfer,
tokens, and latency.

### Polish A - delegation falsification

- Freeze adversarial fixtures for capability, resource, prohibition, approval,
  context, budget, identity, evidence, receipt, and output-schema violations.
- Compare ambient child access, narrowed delegation, and narrowed delegation
  plus parent result validation.
- Measure unauthorized child execution, context leakage, false acceptance,
  valid-child completion, latency, and token/action overhead.

Exit criterion: predeclared thresholds pass without weakening fixtures.

### Polish B - operational enforcement

- Add atomic budget reservation and settlement for concurrent children.
- Add cancellable isolated workers for non-cooperative wall-time enforcement.
- Add signed or independently verifiable remote child receipts.
- Add crash/resume and parent-child replay reconstruction.

Exit criterion: fault-injection tests establish no double-spend, orphaned
authority, or accepted unverifiable result in the tested failure model.

### Polish C - live-model and external validity

- Run frozen tasks across multiple providers, models, and seeds.
- Include prompt injection, stale context, scope drift, recovery, and nested
  delegation.
- Compare against stronger contemporary harness baselines.
- Invite external fixtures and an independent security review.

Exit criterion: publish raw trials, uncertainty, cost/latency tradeoffs,
failures, and bounded claims.

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
