# Execution plan 001: deterministic foundation and evals

Status: completed

## Objective

Extract a minimal public core from the legacy prototype and make its safety
claim testable through explicit conditions and outcomes.

## Delivered

- canonical contracts;
- deterministic policy and grants;
- execute-observe-verify runtime;
- hash-chained ledger;
- controlled capability;
- 16-fixture, three-condition ablation benchmark;
- type, unit, architecture, and acceptance gates;
- public claim boundary and limitations.

## Decision log

- The legacy server was not made the public entrypoint because its default
  capabilities and runtime self-modification conflict with the research claim.
- The first evaluation failure exposed a recursive-target matching bug. The
  benchmark threshold remained unchanged and a regression test was added.
- Live model evaluation was deferred so deterministic enforcement semantics
  could be established first without conflating policy bugs with model variance.

## Arrow extraction

```text
research question
  -> predeclared conditions and metrics
    -> independent package core
      -> failing fixture
        -> boundary fix + regression test
          -> reproducible passing gate
```
