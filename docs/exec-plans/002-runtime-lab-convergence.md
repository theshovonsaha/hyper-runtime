# Runtime Lab Convergence

Status: executing

## Objective

Converge the evaluated runtime around one inspectable path from proposal through
policy, bounded effect, observation, semantic verification, recovery, and
completion. The prototype UI consumes projections of that path; it is not an
alternate source of truth.

## Dependency-safe delivery order

1. Extend contracts with effect certainty, context relations, verifier results,
   compositional workflow nodes, scenario assertions, and workflow candidates.
2. Add exact model recording/replay without bypassing proposal validation.
3. Preserve contradictions and provenance in context compilation.
4. Add verifier composition and a bounded compositional workflow interpreter.
5. Reconcile uncertain or partial effects before any retry is considered.
6. Add a declarative scenario lab, fault injection, event-trace grading, and
   runtime-contribution metrics.
7. Crystallize only verified traces into inert candidates; require backtest and
   explicit human activation before they become ready plans.
8. Project the canonical trace into the UI and run deterministic, adversarial,
   replay, mutation, and live-provider checks separately.

## Invariants

- Model, replay cassette, scenario fixture, and crystallized workflow are
  proposals, never authority.
- Every action leaf crosses the existing policy and one-shot grant boundary.
- A loop has a declared maximum and a subworkflow cannot widen its parent intent.
- Unknown or partial effects are never blindly retried.
- Verification states what it establishes and what it does not establish.
- Conflicting context remains visible and provenance-linked.
- Deterministic results are labelled deterministic; live evidence is reported
  only by the opt-in live suite.

## Acceptance gates

- Exact replay rejects a mismatched request fingerprint.
- Structural success cannot satisfy semantic verifiers by itself.
- Sequence, choice, bounded loop, gate, verify, and subworkflow nodes have tests.
- Injected timeout, throw, false-success, stale observation, and partial-effect
  scenarios have ordered and forbidden event assertions.
- A partially applied non-idempotent action cannot execute twice without a
  successful reconciliation record.
- Context packets report unresolved contradictions without merging them away.
- Candidates require verified source outcomes, passing backtests, and an explicit
  human activation receipt.
- `bun run check` passes; opt-in provider tests remain separately identified.

## Non-goals for this increment

- Parallel execution, distributed consensus, and provider claims inferred from
  fixtures.
- Treating the legacy application as release evidence.
