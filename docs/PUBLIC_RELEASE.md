# Public release guide

## Recommended repository positioning

**Name:** `hyper-runtime`

**One-line description:**

> Research prototype for deterministic authority contracts, explicit condition
> state, capability-bounded actions, and observed-state verification in
> tool-using agents.

**Topics:** `ai-agents`, `ai-safety`, `agent-evaluation`, `typescript`, `bun`,
`capability-security`, `tool-use`, `reproducible-research`

## Before publishing

Use Git rather than uploading the directory manually so `.gitignore` protects
local credentials, databases, event logs, generated UI assets, and dependencies.

```bash
bun install --frozen-lockfile
bun run check
git init
git add .
git status --short
```

Before committing, confirm that none of these appear in staged files:

- `.env`;
- `data/` or `.data/`;
- `test-data/`;
- `node_modules/`;
- `ui/dist/`;
- SQLite database, WAL, or shared-memory files.

Then create the repository, commit, and tag `v0.2.0`. Do not call the release
production-ready or security-proven.

## Short description for an Anthropic application

> I built Hyper-Runtime, an early open-source research prototype that tests a
> narrow agent-safety mechanism: a model can propose an action, but a
> deterministic runtime owns authorization, bounded execution, environmental
> observation, and the completion decision. The first benchmark compares a
> reachability-only control, an authorization-only ablation, and authorization
> plus observed-state verification across 16 versioned failure fixtures. The
> deterministic treatment blocks the fixture's unauthorized actions and
> catches a tool that reports success without changing state. I publish the raw
> trials, acceptance criteria, implementation limitations, and the initial
> failed run that exposed a path-boundary bug. This is a mechanism benchmark,
> not yet evidence about live-model or adaptive-attack robustness. The current
> engineering skeleton also treats delegated sub-agents as the same runtime
> under narrower authority, context, and budgets, but that mechanism is
> explicitly awaiting its own adversarial benchmark.

## What reviewers should open

1. `README.md` - claim and result boundary.
2. `docs/RESEARCH.md` - hypotheses, conditions, outcomes, and limitations.
3. `evals/authorized-conditions.v1.json` - versioned expected outcomes.
4. `evals/results/latest.json` - raw trial evidence.
5. `packages/runtime/src/policy.ts` - deterministic authority checks.
6. `packages/runtime/src/runtime.ts` - execute-observe-verify transitions.
7. `packages/delegation/src/index.ts` - child authority and result boundary.
8. `tests/delegation.test.ts` - deterministic child-runtime mechanism tests.
9. `tests/evals.test.ts` - release acceptance gate.

## Arrow extraction

```text
public claim
  -> inspectable contract
    -> versioned failure fixtures
      -> reproducible result
        -> explicit limitation
          -> next falsifiable experiment
```
