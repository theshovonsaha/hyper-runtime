# Hyper-Runtime

![CI](https://github.com/your-org/hyper-runtime/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Bun](https://img.shields.io/badge/Bun-%3E%3D%201.3-black.svg?logo=bun)


Hyper-Runtime is an early working runtime and research prototype for a narrow
question:

> Can an external runtime reduce unauthorized side effects and false claims of
> completion by making authority, conditions, execution, observation, and
> verification explicit?

The model-facing idea is simple: a model may propose an action, but a
deterministic runtime decides whether that proposal is authorized. Completion
is recorded only after the environment is observed and the requested outcome
is verified.

**Status:** converged local alpha, not a certified production security boundary. Version
`0.2.0` adds real bounded filesystem, process, HTTP, persistent replay, dynamic
semantic context, canonical model proposals, causal recovery,
authority-narrowed child runtimes, CLI, and operator UI surfaces. Live-provider
quality, multi-agent scheduling quality, and adversarial robustness remain
unestablished.

## Current result

The versioned benchmark contains 16 fixtures and three experimental conditions:

| Condition | Decision accuracy | Unauthorized execution | False success | Legitimate completion |
|---|---:|---:|---:|---:|
| Reachability-only control | 25.0% | 100.0% | 7.1% | 100.0% |
| Authorization-only ablation | 100.0% | 0.0% | 33.3% | 100.0% |
| Authorization + verification | 100.0% | 0.0% | 0.0% | 100.0% |

These are deterministic fixture results, not population estimates. The control
is deliberately weak so each mechanism can be isolated. See
[Research protocol](docs/RESEARCH.md) and
[machine-readable results](evals/results/latest.json) for definitions,
acceptance thresholds, and limitations.

The additional Adaptive Context and Workflow benchmark contains five context
fixtures and three multi-step workflow fixtures:

| Metric | Result |
|---|---:|
| Context expectation accuracy | 100.0% |
| Untrusted instruction isolation | 100.0% |
| Workflow status accuracy | 100.0% |
| Causal trace coverage | 100.0% |
| Recovery success | 100.0% |
| False-completion commit | 0.0% |
| Ledger integrity | 100.0% |

These are also deterministic fixture results with zero model calls.

The convergence suite additionally runs a 10-scenario fault-injection lab and
a frozen 50-trial specialized workspace-agent benchmark. They grade terminal
state plus required and forbidden canonical events and repeat the specialized
trials to measure deterministic trace reproducibility. These are mechanism
results with zero model calls, not live-provider evidence.

## Quick start

Requirements: [Bun](https://bun.sh/) 1.3 or later.

```bash
bun install
bun run check
```

`bun run check` performs:

1. strict TypeScript checking for the public packages;
2. unit, architecture, policy, ledger, and benchmark tests;
3. the deterministic three-condition evaluation;
4. generation of `evals/results/latest.json` and `latest.md`.

No API key or model call is required.

Launch the operator UI and evaluated backend together:

```bash
bun run dev
```

The development launcher starts the runtime, waits for its health endpoint,
then starts the frontend with the `/api` proxy connected.

The Morph operator surface includes restart-persistent chats, replayable run
trails, live provider/model discovery, model/profile dropdowns,
per-pass fallback/ping-pong/three-route/four-route model schedules with route
health cooldowns, a bounded all-configured-tools Partner profile,
proposal-scoped approvals, typed active recall from verified-outcome memory,
session-scoped file uploads with explicit hybrid/degraded retrieval, a bounded
temporal/relationship knowledge graph, an evaluated coding-agent profile,
bounded custom HTTP tools,
provider-specific recurring schedules, and a deterministic scorecard. See
[HTTP service](docs/HTTP_SERVICE.md) for configuration and the remaining
local-alpha limits.

Session knowledge never becomes authority. Uploaded bytes are digest-addressed
per session, text extraction and indexing are bounded, embeddings are optional,
and `session.knowledge.search` re-observes result identities before verification.
See [agentic RAG and coding-agent scope](docs/AGENTIC_RAG.md).
Embedding profiles can be selected once per session and lock at first
ingestion; bounded auto mode has server-enforced step and wall-time ceilings;
and the operator provides a workspace/session file explorer with typed previews
and explicit chat linking. See [autonomy, embeddings, and file context](docs/AUTONOMY_EMBEDDINGS_FILES.md).

The Runtime Lab can launch two or three specialized agents against the same
objective or compare archived runs. It records each agent/module configuration
in the canonical ledger, detects false-success prevention, authority limits,
effect uncertainty, fallback recovery, contradiction and retry pressure, and
shows an evidence-weighted comparison with explicit provider/model/profile and
objective confounds. Unsafe mechanism ablations remain deterministic fixtures;
live agents cannot disable policy or verification.

The operator also includes a full-screen Runtime Graph and per-run Context
Inspector. The graph projects memory, canonical context packets, sources,
proposals, capabilities, verifications, and evidence into linked run
constellations with explicit integrity metrics. Memory edits append a
superseding record instead of rewriting verified history. Context passes show
the exact selected items, exclusions, linked tool proposal, contradictions,
representation drift, goal mismatch, and history-dominance signals.

The evaluated capability catalog also includes bounded directory listing,
replayable time snapshots, server-authorized Streamable HTTP MCP discovery,
authenticated channel gateways, per-session indexed retrieval, and linked
continuation from verified crash checkpoints. Linux process calls can require a
fail-closed bubblewrap backend. See the example MCP and gateway configurations
under `examples/`.

Optional bounded media adapters add Deepgram and ElevenLabs transcription and
speech output, one-time ElevenLabs private voice-agent sessions,
OpenAI-compatible vision, and inline image generation. Media reads and writes
remain workspace-contained; provider credentials and signed session URLs are
excluded from durable events. Deepgram realtime sessions use one-time handles
for short-lived bearer tokens under the same boundary. See
[realtime voice convergence](docs/VOICE_RUNTIME.md) and
[HTTP service](docs/HTTP_SERVICE.md).

The operator library also exposes bounded-pass signals and a correction review
queue. Correction candidates are inert records accepted for later experiments;
they never become runtime policy merely because they were entered in the UI.

Run the practical verified-file example:

```bash
bun run hyper -- run \
  --task examples/verified-file/task.json \
  --workspace examples/verified-file/workspace \
  --ledger /tmp/hyper-verified-file.jsonl \
  --provider scripted \
  --proposals examples/verified-file/proposals.json
```

See [task format and live-provider usage](docs/TASK_FORMAT.md).
See [provider intelligence, context budgets, local admission, and live inference evidence](docs/PROVIDER_INTELLIGENCE.md).
For a claim-to-contract-to-event-to-test map, see
[runtime guarantee traceability](docs/TRACEABILITY.md).

## Public package boundary

| Package | Responsibility |
|---|---|
| `@hyper/contracts` | Versioned intent, condition, proposal, policy, grant, evidence, and outcome contracts |
| `@hyper/runtime` | Deterministic authorization, transition sequencing, observed-state verification, and hash-chained events |
| `@hyper/capability-memory` | Controlled capability adapter used by tests and evals |
| `@hyper/capabilities` | Bounded filesystem, process, HTTP, credential, and remote capability adapters |
| `@hyper/context` | Provenance-aware conversation ledger and phase-specific context compiler |
| `@hyper/delegation` | Child-authority narrowing, context isolation, budget admission, and typed result validation |
| `@hyper/model` | Canonical proposal validation plus scripted and live-provider transports |
| `@hyper/workflow` | Multi-step execution, causal progress diagnosis, pivot control, and completion oracle |
| `@hyper/cli` | Versioned task runner and persistent replay inspection |
| `@hyper/evals` | Authorization, verification, context, recovery, and false-completion gates |

The public execution path is:

```text
IntentContract + Conditions
  -> ActionProposal
  -> PolicyDecision
  -> CapabilityGrant
  -> Execute
  -> Observe
  -> Verify
  -> Hash-chained receipt
```

The earlier all-in-one server remains under `src/` as a legacy prototype for
migration research. It is excluded from the public compile gate, not imported
by the new packages, and must not be described as production-ready. See the
[legacy convergence audit](docs/LEGACY_AUDIT.md).

The practical multi-step path is:

```text
goal + raw/curated sources
  -> phase-specific context packet
  -> canonical model proposal
  -> deterministic authorization
  -> bounded capability
  -> observation and verification
  -> causal progress diagnosis
  -> continue / retry / pivot / ask / complete
  -> persistent evidence-linked receipt
```

The recursive delegation path reuses that same kernel:

```text
parent intent + actual context + remaining budget
  -> child authority-subset decision
  -> selected child context
  -> ordinary verified child workflow
  -> typed output + evidence + child receipt
  -> parent acceptance or rejection
```

## What is established in v0.2.0

- Policy decisions are deterministic for the same canonical input.
- Reachability and authorization are separate contracts.
- Required conditions must be referenced, present, active, evidenced, and
  unexpired.
- Approvals are proposal-scoped and cannot expand the intent's risk budget.
- A successful adapter return does not count as completion when observed state
  disagrees.
- Event mutation is detectable through a SHA-256 hash chain.
- Public packages have a structural test preventing imports from the legacy
  prototype.
- Stable directive and constraint context cannot be silently removed to satisfy
  a token budget.
- Expired sources are excluded and irrelevant sources must clear a relevance
  gate; non-authoritative sources are rendered as evidence-only.
- Exact duplicate non-authoritative sources are represented once with merged
  provenance and explicit exclusion reasons; authoritative records remain
  distinct so conflicts and policy provenance stay visible.
- Unsupported completion claims are rejected until required evidence has been
  produced by a verified action.
- Failed actions produce causal records and repeated strategies can pivot
  without losing observed failure evidence.
- Real filesystem paths reject escape and symbolic-link traversal; HTTP targets
  validate allowlists, DNS results, redirects, and response size.
- JSONL ledgers reload across processes and retain hash-chain verification.
- The CLI completes a real file-writing workflow under the public package graph.
- Typed semantic records preserve decisions, assumptions, observations,
  failures, repairs, and supersession without treating summaries as canonical.
- A child workflow uses the same runtime kernel with a distinct run ID,
  explicitly narrower capability/resource authority, selected context, and
  bounded tokens/actions/time.
- Child results are rejected when identity, policy history, budgets, evidence,
  verified completion, receipt, or output schema fail validation.
- Live proposal prompts receive exact intent, principal, condition, evidence,
  risk, and active-strategy scope plus built-in capability argument schemas;
  malformed arguments are rejected before adapter invocation.
- Human-authored correction rules can convert exact observed failure codes into
  a bounded repair constraint whose application and next outcome are recorded.
- Human correction traces can be queued and reviewed as inert experiment
  candidates without silently activating them as policy.
- The evaluated HTTP surface persists sessions and verified-outcome memory,
  synthesizes natural answers only against verified evidence references, and
  routes custom HTTP tools and recurring jobs through the same policy,
  observation, verification, and ledger path.
- Recorded proposals replay only when context, capabilities, and authority have
  the exact same fingerprint.
- Sequence, choice, bounded loop, approval gate, semantic verifier, and
  authority-narrowed subworkflow nodes share the ordinary policy boundary.
- Unknown and partial effects carry retry-safety state and are reconciled before
  a retry can be considered.
- Context packets preserve typed support, contradiction, dependency,
  derivation, and supersession edges and report unresolved conflicts.
- Verified traces produce inert workflow candidates; passing backtests and an
  explicit human activation receipt are required for `ready` status.
- Durable effect preparation supports restart reconciliation without blindly
  repeating an interrupted effect; run projections rebuild from canonical
  events.
- Shared delegation budget pools reserve concurrent child budgets atomically,
  worker cancellation requires termination, and remote results may require a
  trusted Ed25519 receipt attestation.
- Reviewed procedural skills use metadata-first discovery and bounded loading;
  ordered lifecycle hooks cannot replace workflow state or acquire authority.
- A digest-pinned OCI backend removes network and Linux capabilities, uses a
  read-only root, and bounds PIDs, memory, temporary storage, and host mounts.

## What is not established

- Security against prompt injection or an adaptive attacker.
- Reliability with a live LLM, browser automation, MCP server, or distributed
  deployment.
- General task-quality improvement.
- Tamper resistance against a process that can rewrite both events and hashes.
- Statistical significance or external validity beyond the committed fixtures.
- Certification of the configured host/container boundary or an independent
  security review.
- Semantic correctness of arbitrary user-authored completion criteria.
- General factual truth outside the registered semantic verifier's explicitly
  declared claim boundary.
- Parallel mutation scheduling or distributed effect consensus. The local
  composer runs bounded side-effect-free branches concurrently and requires
  write/delete/process effects to be serialized.
- External validity until independently authored fixtures and third-party
  reproduction reports are actually contributed.

## Repository map

```text
packages/                 evaluated public packages
evals/                    benchmark dataset and generated results
tests/                    compile-gated tests
docs/RESEARCH.md          question, hypotheses, metrics, limitations
docs/ARCHITECTURE.md      dependency and execution boundaries
docs/DELEGATION.md        recursive child-runtime contract and limitations
docs/SEMANTIC_CONTEXT.md  typed context projection and phase compilation
docs/LOCAL_MODEL_PROBES.md local inference context, cache, RAM, and pass probes
docs/TASK_FORMAT.md       practical CLI and task contract
docs/HTTP_SERVICE.md      evaluated local HTTP service and operator UI wiring
docs/THREAT_MODEL.md      protected invariants and explicit non-goals
docs/LEGACY_AUDIT.md      evidence-based disposition of the old prototype
docs/ROADMAP.md           staged validation plan
ui/                       responsive operator chat and control surface
src/                      legacy prototype; excluded from public package graph
scripts/                  legacy exploratory scripts
```

For repository publication and a concise application-ready description, use
the [public release guide](docs/PUBLIC_RELEASE.md).

## Contributing

Read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[SECURITY.md](SECURITY.md). New mechanisms must ship with a failure fixture,
an expected outcome defined before implementation, and an ablation showing
which mechanism changes the result.

## License and citation

MIT licensed. Citation metadata is available in [CITATION.cff](CITATION.cff).
