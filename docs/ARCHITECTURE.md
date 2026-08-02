# Architecture

## Design thesis

Intent may be probabilistic. Authority and completion are not.

Hyper-Runtime therefore separates five concerns that the legacy prototype
mixed inside one orchestration loop:

```text
proposal formation
  -> deterministic authorization
  -> capability-bounded execution
  -> environmental observation
  -> outcome verification and receipt
```

The evaluated v0.1.0 core begins at the proposal boundary. Version 0.2 wraps
that core with semantic context compilation, canonical model proposals, causal
workflow control, real capability adapters, recursive delegation, persistent
replay, a CLI, and an operator UI.

The architecture is organized into four layers:

```text
Meaning    -> typed, provenance-linked context for the current phase
Control    -> deterministic intent, condition, approval, and delegation policy
Execution  -> capability-bounded effects, observation, and verification
History    -> canonical events, causal records, child links, and receipts
```

## Package boundaries

### `@hyper/contracts`

Owns stable data shapes only. It has no runtime, provider, storage, or tool
dependency. The central contracts are:

- `IntentContract`: who may do what, to which resources, under which risk and
  completion constraints.
- `Condition`: an explicit prerequisite with state, source, evidence, and
  expiry.
- `ActionProposal`: a requested capability invocation with declared effects.
- `PolicyDecision` and `CapabilityGrant`: the authorization result and its
  narrow, expiring authority.
- `Observation` and `VerificationResult`: environmental evidence and the
  outcome decision.
- `LedgerEvent` and `ActionOutcome`: replayable state transition records.

### `@hyper/runtime`

Owns deterministic transitions. `DeterministicPolicyEngine` checks principal,
intent, resource, capability, effect, risk, conditions, and approvals before a
grant can exist. `AuthorizedRuntime` executes only with that grant, then
observes and verifies the result.

`HashChainLedger` commits canonicalized events with a previous-hash link. This
detects accidental or post-hoc mutation in the stored sequence. It is not a
signature system and does not protect against an attacker who controls the
entire process and storage.

#### Persistence Layer (JSONL vs RDBMS)

Hyper-Runtime deliberately avoids a centralized Relational Database Management System (RDBMS) for its core evaluation and event processing. Instead, state persistence and verification rely on append-only **JSONL (JSON Lines) Hash-Chained Ledgers**.

- **Stateless Integrity Verification**: The runtime verifies event order and
  hashes directly from the canonical event ledger, requiring no SQL schema or
  migration system. End-to-end semantic projection rebuilding and crash/resume
  are not implemented yet.
- **Portability**: Ledgers can be serialized to files (e.g., `/tmp/hyper.jsonl`), replayed across processes, and trivially versioned.
- **Opt-in RDBMS**: If an integration or operator UI requires relational queries, they may project the canonical JSONL events into an RDBMS view, but the source-of-truth remains the hash chain.

### Capability adapters

A capability exposes:

- a manifest of supported effects and targets;
- a risk ceiling and approval mode;
- `execute`, `observe`, and `verify` operations.

The original evaluated adapter remains in-memory. Version 0.2 also provides:

- workspace file read and atomic write with containment and symlink rejection;
- shell-free, executable-allowlisted processes with time and output bounds;
- allowlisted HTTP GET with DNS/IP, redirect, and response-size validation;
- allowlisted environment credential lookup; and
- a manifest-first remote capability boundary suitable for an MCP client.

The process adapter is not a hardened OS sandbox.

### `@hyper/context`

Owns the raw conversation ledger, provenance-linked derived sources, relevance
and validity selection, semantic records, authority labels, token budgets, and
phase-specific context rendering. Only directive and constraint sources are
instruction-eligible. Canonical events remain durable; semantic records and
summaries are rebuildable projections.

### `@hyper/delegation`

Owns the pure boundary between a parent and child runtime: authority-subset
checks, context selection, budget admission, output schema validation,
structured failure, and parent receipts. It imports contracts only and knows
nothing about providers or capabilities.

### `@hyper/model`

Owns canonical workflow-proposal parsing and provider transports. Provider
output is untrusted structured input to the workflow and policy layers.

### `@hyper/planning`

Compiles bounded natural language into an inert executable workflow plan:
steps, dependencies, conditions, evidence targets, and idempotency keys. It
imports contracts only. A compiled plan has no authority and cannot call an
adapter.

### `@hyper/workflow`

Composes context, model, runtime, and capability manifests. It records
hypothesis, predicted observation, actual observation, failure signature, and
recovery decision for every action step. Strategy pivots cannot silently change
the goal contract. `WorkflowChildRuntimeExecutor` adapts this same runner to the
delegation boundary; a child is a normal workflow under a narrower contract,
not a separate agent implementation.

The workflow may also apply human-authored correction rules. A rule maps an
exact observed failure code to a bounded, provenance-linked constraint for the
next action pass. Applications and subsequent outcomes are canonical events.
Rules do not grant authority, change the intent, learn themselves, or prove
that their natural-language instruction caused an improvement.

### `@hyper/cli`

Loads a versioned task, registers only opted-in capabilities, selects a model
driver, persists the ledger, and prints a workflow receipt. It is a composition
surface, not a policy bypass. Its local HTTP service exposes the same runner to
the operator UI and adapts canonical ledger events into display-only SSE
projections; the UI event stream is not a second source of truth. A separate
atomic operator store indexes sessions, run metadata, active verified-outcome
memory, bounded HTTP-tool definitions, and schedules for local product use.
Run effects and verification remain canonical only in the per-run hash chain;
operator configuration cannot grant capability beyond server allowlists.

The operator store may also hold structured correction traces in the form
`observed -> mismatch -> correction -> reusable rule`. These are inert,
reviewable experiment candidates. Even an `accepted_for_experiment` candidate
does not enter a workflow definition or gain directive authority; activation
still requires an explicit human-authored `CorrectionRule` at the task boundary.

The HTTP composition surface owns a server-configured provider registry. It
probes model inventories for Ollama, Anthropic, and one OpenAI-compatible
endpoint and exposes only sanitized connection state to the UI. A run may
select a provider and model from that registry, but cannot supply a base URL or
credential name; transport authority therefore remains server-owned. Scheduled
runs persist the same provider/model selection as interactive runs.

Natural response synthesis happens after verified completion. The model sees
only verified observations and must return evidence references from that set.
The response is a provenance-linked presentation layer, not a new verifier and
not authority to execute another effect. Only verified observations—not answer
prose or intermediate reasoning—are eligible for durable memory.

### `@hyper/evals`

Owns fixtures, condition runners, metric definitions, acceptance criteria, and
result serialization. It imports public APIs only.

## Transition semantics

| State | Entry evidence | Possible next state |
|---|---|---|
| Proposed | Intent ID, conditions, target, effects, risk | Denied, awaiting approval, granted |
| Granted | Deterministic allow decision and scoped grant | Executed |
| Executed | Capability result | Execution failed, observed |
| Observed | Independent state read | Verification failed, completed |
| Completed | Verification evidence | Receipt committed |

No transition from proposed to executed exists without a grant. No transition
from executed to completed exists without an observation in the treatment
condition.

`AuthorizedRuntime` consumes each proposal-scoped grant before adapter
execution. A crash or adapter failure does not make the same grant reusable; a
retry needs a fresh decision and grant while retaining the action's stable
idempotency key.

## Condition lifecycle

Conditions are not hidden planner text:

```text
active + evidenced + unexpired -> usable
missing | expired | superseded | disputed -> cannot authorize
```

An action must reference every condition required by its intent. This makes a
stale or silently omitted prerequisite mechanically visible.

## Default-deny integration rule

An integration is a capability contract, not a raw function:

```text
manifest -> policy -> grant -> adapter -> observation -> verifier
```

Adding an adapter directly to a model tool registry is outside the public
architecture.

## Recursive delegation rule

```text
parent authority
  -> prove child capability/resource/effect/risk/context/budget subset
    -> run child with its own identity and ledger
      -> validate child output, evidence, verification, usage, and receipt
        -> incorporate accepted result
```

The child model cannot choose its authority or context view. A child result is
not parent knowledge until the delegation controller accepts it. See
`DELEGATION.md`.

## Context projection rule

```text
canonical event -> semantic record -> current projection -> phase packet
```

Corrections append and supersede; they do not erase history. Stable directives
and constraints survive compilation. Evidence-only and untrusted records never
become instructions merely because they were retrieved. See
`SEMANTIC_CONTEXT.md`.

## Legacy isolation

The historical server under `src/` contains provider, memory, UI, raw tool, and
self-modification experiments. The public `tsconfig.json` excludes it, package
architecture tests reject imports from it, and public scripts do not start it.
Migration decisions are recorded in `LEGACY_AUDIT.md`.

## Telic product boundary

Hyper is the evaluated public kernel and research evidence. Telic is the one
human-facing product that progressively exposes these semantics. The old
Hyper UI remains legacy material; it is not a second supported runtime.

## LLM extraction

```text
reachable -> not necessarily authorized
executed -> not necessarily successful
reported success -> not necessarily observed success
observed success -> commit evidence-linked receipt
parent authority -> child may narrow, never expand
raw history -> typed projection -> phase-specific context
```
