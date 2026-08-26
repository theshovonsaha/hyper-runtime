# Architecture

## Design thesis

Intent may be probabilistic. Authority and completion are not.

Model-visible history, retrieval, and tools are selected independently per
task. See [Task-scoped connection architecture](CONNECTION_ARCHITECTURE.md) for
the minimal assistant loop and its native tool-call migration boundary.

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
  migration system. Run, timeline, context, evidence, memory, and recovery
  projections rebuild from canonical events. Linked continuation folds in
  verified post-checkpoint actions instead of replaying their effects.
- **Portability**: Ledgers can be serialized to files (e.g., `/tmp/hyper.jsonl`), replayed across processes, and trivially versioned.
- **Opt-in RDBMS**: If an integration or operator UI requires relational queries, they may project the canonical JSONL events into an RDBMS view, but the source-of-truth remains the hash chain.

### Capability adapters

A capability exposes:

- a manifest of supported effects and targets;
- a risk ceiling and approval mode;
- `execute`, `observe`, and `verify` operations.

The original evaluated adapter remains in-memory. Version 0.2 also provides:

- workspace file read and atomic write with containment and symlink rejection;
- bounded repository text search with ignored dependency/build directories,
  exact line locations, and per-file snapshot digests;
- exact stale-safe file patching that requires the digest of a previously
  inspected snapshot and rejects missing or ambiguous replacement context;
- shell-free, executable-allowlisted processes with time and UTF-8 byte bounds;
- allowlisted HTTP GET with DNS/IP, redirect, and response-size validation;
- allowlisted environment credential lookup; and
- a manifest-first remote capability boundary suitable for an MCP client;
- bounded workspace media adapters for transcription, speech synthesis,
  multimodal analysis, and image generation; and
- an ephemeral voice-session broker that keeps signed WebSocket URLs out of
  canonical events and permits one claim before expiry.

The bounded process adapter alone is not a hardened OS sandbox.
When a process sandbox backend is configured, the adapter probes it before
every invocation and fails closed if isolation is unavailable. The initial
backend is Linux bubblewrap with namespaces, no inherited network namespace,
read-only system paths, and an explicit workspace bind. An unconfigured
process adapter remains bounded but is still not an OS sandbox.
The OCI backend adds a digest-pinned disposable image, no network, a read-only
root, dropped capabilities, no-new-privileges, PID/memory limits, bounded
tmpfs, and one workspace bind. Availability is probed per call; deployment
certification remains external to the runtime.

Streamable HTTP MCP discovery is manifest-first and server-configured. A
discovered tool is unreachable until a local authority record supplies its
effects, targets, risk, approval policy, and a distinct observation tool.
Remote annotations are never authority.

Channel gateways reuse the capability boundary: outbound recipients are
allowlisted, delivery requires approval, and completion needs an observed
delivery receipt. Inbound messages require backend-held authentication and an
allowlisted sender, enter with provenance, and cannot choose their own profile.

### `@hyper/context`

Owns the raw conversation ledger, provenance-linked derived sources, relevance
and validity selection, semantic records, authority labels, token budgets, and
phase-specific context rendering. Only directive and constraint sources are
instruction-eligible. Canonical events remain durable; semantic records and
summaries are rebuildable projections.
At the model boundary, every source is text. The renderer therefore emits one
complete bounded JSON record per source with authority, provenance, and content
in separate fields. Delimiter-like tool text cannot forge a second record.
Oversized or cyclic values become explicit truncation/type envelopes while the
workflow keeps target, verification codes, and evidence IDs outside the
truncated value.

### `@hyper/delegation`

Owns the pure boundary between a parent and child runtime: authority-subset
checks, context selection, budget admission, output schema validation,
structured failure, and parent receipts. It imports contracts only and knows
nothing about providers or capabilities.
Shared budget pools reserve tokens, actions, and wall time before concurrent
children start and settle only observed usage. Cancellable worker adapters
must complete termination after abort. Contracts may require a trusted
Ed25519 attestation over the complete child result.

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

A process adapter advertises its exact executable allowlist as an enum in the
model-facing schema. A known non-zero exit remains `execution_failed`, but its
bounded exit code, stdout, and stderr are committed as a failure-diagnostic
observation and may feed the next diagnosis pass. A timeout can expose the
result observed at termination while its effect remains partially applied and
reconciliation-required. Thrown or otherwise unknown effects expose no
invented observation and still stop blind continuation.
The standalone `process:check` release gate verifies real nonzero stderr
capture and in-stream byte capping outside Bun's embedded unit-test runner;
unit fixtures separately cover timeout, cancellation, and failed-result ledger
semantics.

The package also interprets inert compositional nodes: sequence, conservative
bounded parallel, deterministic adapter, schema-bounded model operation,
choice, bounded loop, human gate, verifier, and authority-narrowed subworkflow.
Write/delete/process branches require serialization. Action leaves always enter
`AuthorizedRuntime`; a graph and model-produced fact never carry a grant.
Semantic verifiers return both what they establish and their limitations, so a
structural or freshness result cannot masquerade as general factual truth.

### `@hyper/cli`

Loads a versioned task, registers only opted-in capabilities, selects a model
driver, persists the ledger, and prints a workflow receipt. It is a composition
surface, not a policy bypass. Its local HTTP service exposes the same runner to
the operator UI and adapts canonical ledger events into display-only SSE
projections; the UI event stream is not a second source of truth. A separate
atomic operator store indexes sessions, run metadata, canonical-event-derived
verified-outcome memory, bounded HTTP-tool definitions, and schedules for local
product use. Memory edit/delete events are appended before the cache changes,
and the memory cache rebuilds from canonical run events on startup.
Run effects and verification remain canonical only in the per-run hash chain;
operator configuration cannot grant capability beyond server allowlists.
Each completed workflow pass also commits a restart checkpoint. After a crash,
a continuation is rebuilt from canonical checkpoints plus verified actions that
crossed the effect boundary afterward. Recovered effects become evidence inputs
and are not blindly replayed. A run with neither a checkpoint nor a reconstructable
verified action has no safe semantic continuation seed.

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

The composition surface may wrap configured drivers in a bounded router.
Fallback mode keeps route A first. Ping-pong, three-route ring, four-route ring
pair, and legacy round-robin modes deterministically select the preferred
provider/model pair for each model pass. Every pass retains automatic fallback
through the other routes, and selection/failure are canonical events. Route
failure never bypasses canonical proposal parsing or policy. If every route
fails only after required evidence has been
observed, completion may be derived deterministically from those canonical
observation IDs.
Transport failures are counted per route within a run. After the configured
threshold, a route is skipped for a bounded number of model passes and then
probed again. This changes call order only; it cannot change context,
capability scope, policy, or verification.

Natural response synthesis happens after verified completion. The model sees
only verified observations and must return evidence references from that set.
The response is a provenance-linked presentation layer, not a new verifier and
not authority to execute another effect. Only verified observations—not answer
prose or intermediate reasoning—are eligible for durable memory.
Verified memory is partitioned by session. Recent conversation is represented
as one bounded chronological transcript source so phase selection cannot
silently reorder individual turns; exact duplicate dynamic sources remain
collapsible by the context compiler.
Active recall selects a small set of typed, provenance-linked records with a
deterministic lexical, salience, kind, and recency score. It does not add a
memory-preprocessing model call. The `partner` profile composes this recall
with all configured manifests while retaining normal approval boundaries.

### `@hyper/evals`

Owns fixtures, condition runners, metric definitions, acceptance criteria, and
result serialization. It imports public APIs only. Evidence modes remain
explicit: deterministic fixtures exercise mechanisms with zero model passes;
stateful simulated inference exercises the real model/workflow message loop;
credentialed provider runs are reported separately. The simulated-inference
suite must never be presented as live-model quality or population coverage.

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

Interrupted effects are classified as `not_applied`, `applied`, `unknown`, or
`partially_applied`. Unknown and partial non-idempotent effects are not retryable
by default. An adapter can reconcile them using observed evidence, but
reconciliation does not convert a failed execution into task completion.

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

Typed context relations (`supports`, `contradicts`, `depends_on`,
`derived_from`, and `supersedes`) remain projection metadata. Conflict-linked
records are not deduplicated away; packet audits expose unresolved conflict IDs
and provenance coverage.

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
