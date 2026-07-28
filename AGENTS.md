# Hyper-Runtime agent map

This repository contains a new evaluated package core and an older prototype.
Do not mix them.

## Start here

1. Read `README.md` for the claim boundary.
2. Read `docs/ARCHITECTURE.md` before changing dependencies.
3. Read `docs/RESEARCH.md` before changing fixtures, metrics, or thresholds.
4. Run `bun run check` before reporting completion.

## Public package dependency direction

```text
contracts <- runtime <- evals
contracts <- context <- model
contracts <- capabilities
contracts <- delegation
contracts <- planning
contracts + runtime + context + model + delegation <- workflow
all public runtime packages <- cli / evals
```

- `packages/contracts` imports no other local package.
- `packages/runtime` may import only contracts and standard-library modules.
- `packages/context` and capability packages may import contracts, not runtime internals.
- `packages/delegation` is a pure authority, isolation, budget, and result-validation boundary.
- `packages/model` may import context and contracts.
- `packages/planning` compiles language into an inert capability graph and may
  import contracts only. It never authorizes or executes its output.
- `packages/workflow` composes contracts, context, model, and runtime.
- `packages/cli` and `packages/evals` are composition surfaces.
- `packages/evals` may compose the public packages.
- no public package may import `src/`, `scripts/`, `ui/`, or `docs/legacy/`.

`tests/architecture.test.ts` enforces the legacy-import boundary.

## Research invariants

- Model or fixture output is a proposal, never authority.
- Reachability is not authorization.
- Conditions are explicit state with evidence and expiry.
- Approval cannot expand an intent contract.
- Tool success is not task success.
- Completion requires observed-state verification.
- Failed acceptance criteria are investigated, not weakened after results.
- Deterministic fixture results must not be described as live-model evidence.
- A child runtime may narrow parent authority; it may never expand capability,
  resource, effect, risk, approval, context, or budget scope.
- Child output is untrusted until its identity, receipt, evidence, verification,
  budget usage, policy record, and output schema pass the delegation boundary.
- Canonical events are durable truth. Semantic records are provenance-linked
  projections, and summaries must be rebuildable from canonical events.
- Structured decisions, hypotheses, and rejected alternatives are not hidden
  chain-of-thought and must not be represented as such.

## Commands

```bash
bun run typecheck
bun test tests
bun run eval
bun run check
bun run release:check
```

Generated benchmark results belong in `evals/results/`. Do not hand-edit them.

## Legacy boundary

`src/`, `scripts/`, and `ui/` are pre-convergence prototype material. They may
be inspected and migrated, but they are not release evidence. Preserve their
history until a migration decision is recorded in `docs/LEGACY_AUDIT.md`.

## Change handoff

End substantial changes with an arrow summary:

```text
input contract -> policy decision -> bounded effect -> observation -> outcome
```

State what changed, what the tests establish, what remains unverified, and the
smallest next experiment.
