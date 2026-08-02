# Legacy convergence audit

The historical prototype remains under `src/` for migration reference. The
table distinguishes reachability from functional enforcement.

| Component | Status | Evidence | Test / disposition |
|---|---|---|---|
| `src/index.ts` server | WIRED | `src/index.ts:32`, `src/index.ts:56`, and `src/index.ts:62` import/register built-ins and construct the old kernel | Preserve as legacy; do not expose as public default |
| `src/core/kernel.ts` | WIRED | `src/core/kernel.ts:279`, `src/core/kernel.ts:458`, `src/core/kernel.ts:482`, and `src/core/kernel.ts:493` coordinate sub-runs, post-hoc claims, scoring, and self-evolution | Do not patch into the public core; migrate bounded strategies separately |
| `src/core/constraints.ts` | STUB for comprehensive enforcement | `src/core/kernel.ts:90` and `src/core/kernel.ts:147` call depth and context checks; no live call applies its tool timeout, payload ceiling, or path rule to every capability | Replaced in public core by pre-action policy; external capability constraints remain Run 2 |
| `src/core/side_effect_guard.ts` | STUB for authority | `src/core/kernel.ts:458` calls it only after final text exists; it can annotate a claim but cannot prevent an effect | Replaced by pre-action authorization plus observation |
| `src/core/scorecard.ts` | STUB as research evidence | Defined at `src/core/scorecard.ts:21` and called at `src/core/kernel.ts:482`; the call omits a verifier verdict, which its implementation treats as passing | Excluded from research outcomes |
| `src/core/self_evolving.ts` | WIRED, unsafe | `src/core/kernel.ts:493` invokes it after completed turns; `src/core/self_evolving.ts:44` compiles generated JavaScript with `new Function` | Never migrate as live execution; redesign as offline reviewed plugin generation |
| `src/core/container_sandbox.ts` | ORPHANED security experiment | Import audit finds no live entrypoint call; `src/core/container_sandbox.ts:44` uses `new Function`, not process/container isolation | Do not present as a sandbox |
| Default filesystem/shell/network built-ins | WIRED, broad authority | Created at `src/tools/builtins.ts:51` and registered at `src/index.ts:56` | Excluded from public defaults; redesign as capability packages |
| `@hyper/contracts` | WIRED | Contracts begin at `packages/contracts/src/index.ts:8`; runtime, capability, eval, and tests import the package | `bun run typecheck`; dependency-free architecture test |
| `@hyper/runtime` | WIRED | Policy begins at `packages/runtime/src/policy.ts:38`; runtime at `packages/runtime/src/runtime.ts:46` | Policy, false-success, ledger, and eval tests |
| `@hyper/capability-memory` | WIRED | Adapter begins at `packages/capability-memory/src/index.ts:21` and is used by all eval conditions | Grant validation and observed-state tests |
| `@hyper/evals` | WIRED | Experiment entrypoint is `packages/evals/src/experiment.ts:284`; root `eval` and `check` scripts invoke its CLI | Acceptance gate and raw result generation |
| Legacy session/run UI APIs | MIGRATED WITH NARROWER SEMANTICS | `packages/cli/src/server.ts` exposes persistent sessions, canonical run trails, attribution, and a scorecard over the evaluated runner | New Morph UI consumes these APIs; legacy kernel remains isolated |
| Legacy memory writer | REPLACED | `packages/cli/src/server.ts` commits only capability-verified terminal observations through `memory.verified_outcome_committed` | No intermediate reasoning or unverified response prose is eligible |
| Legacy custom HTTP tools | REPLACED WITH BOUNDED GET | `packages/capabilities/src/http.ts` enforces preconfigured host and path prefixes on requests and redirects | Tools cannot add hosts beyond `HYPER_ALLOWED_HOSTS` and remain policy-gated |
| Legacy schedules | MIGRATED WITH SAME-KERNEL EXECUTION | `packages/cli/src/server.ts` dispatches interactive and scheduled objectives through `/api/runtime/run` | Completed state survives restart; in-flight crash resume remains unimplemented |
| Legacy workflow templates, credentials, and channels | NOT MIGRATED | These features depend on broader authority and external secret/channel contracts absent from the evaluated core | Keep isolated until each has an explicit capability, verifier, and threat-model fixture |

The mechanical import audit also identifies `knowledge/knowledge.ts`,
`knowledge/wiki.ts`, `tools/custom.ts`, `domain/career/types.ts`, and several
barrel entrypoints as zero-incoming candidates. They remain legacy until a
specific migrate, merge, or remove decision is made.

## Public boundary decision

The project is not claiming that the entire historical runtime has converged.
The claim is narrower: the packages under `packages/` form a compile-gated,
evaluated foundation that does not depend on the legacy graph.

## Arrow extraction

```text
legacy feature inventory
  -> mechanical reachability audit
    -> unsafe/inert claims isolated
      -> smallest enforceable core extracted
        -> ablation benchmark becomes release gate
```
