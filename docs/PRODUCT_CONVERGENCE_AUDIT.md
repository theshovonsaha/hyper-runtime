# Product convergence audit

Status: working prototype with an evaluated kernel; not yet a production service.

## Product thesis

Hyper should not compete as another general chat interface. Its credible wedge is a
private, high-trust operator for consequential research, code, and operational work:

> State the outcome once. Hyper selects a bounded approach, uses the necessary
> tools, verifies the resulting state, and leaves the work inspectable.

The runtime is the differentiator, but it is not the first-screen product. The
operator is the product; the runtime trail, context graph, memory graph, and eval
lab are progressively disclosed proof.

An invitation-only or managed-premium launch is plausible because high-value
users buy trust, integration, saved time, and accountable outcomes. Exclusivity
alone is not a product capability. Before making private-service claims, Hyper
still needs authenticated tenant isolation, encrypted secret and artifact
storage, retention controls, audit export, operational monitoring, recovery,
support ownership, and a defined service boundary.

## What exists now

### Evaluated core

- Explicit intent, capability, effect, risk, approval, observation, verification,
  receipt, and canonical-event contracts.
- Deterministic authorization and observed-state verification.
- Provider/model discovery, bounded fallback schedules, provider dialects,
  reasoning-effort adaptation, cancellation, and per-run accounting projections.
- Session isolation, upload ingestion, lexical/temporal/relationship retrieval,
  optional pinned embedding spaces, memory projection, and typed file previews.
- Prompt editing by branching, retry, session deletion, artifacts, resumable runs,
  custom bounded tools, schedules, and runtime inspection surfaces.
- Tests and deterministic evaluations that enforce architecture and policy
  invariants.

### Product shell

- A working chat/operator surface with streaming run state and approval gates.
- The primary composer now delegates task-depth selection to the runtime.
- Expert controls and secondary products are reachable through one inspection
  entry point rather than competing with the core interaction.
- Completed answers have stronger visual priority; the full event trail is
  collapsed and inspectable.
- Outcome-led starting points demonstrate decision, build/fix, and deliverable
  work without a fake demo mode.

## What the evidence does not establish

- Best-in-class answer quality across live providers.
- Reliable long-horizon autonomous coding on real repositories.
- Semantic correctness of claims returned by external search sources.
- Production tenancy, privacy, security, uptime, or disaster recovery.
- Stable behavior under context saturation, provider degradation, cancellation
  races, concurrent sessions, or local memory pressure.
- A premium onboarding and integration experience.

These are not wording problems. They require live evaluations and operating
capabilities.

## The missing links

### Complexity budget

The runtime should pay only for the strongest primitive the current turn needs:

```text
conversation -> one response call
fresh/private read -> bounded retrieval workflow
effect -> policy + execute + observe + verify
long task -> checkpoints + compaction/reset + evaluator when justified
```

A capability existing in the system is not a reason to initialize it for every
turn. The direct conversational path therefore skips knowledge retrieval,
verified-memory retrieval, phase context compilation, full-history compaction,
and fallback-catalog network preflight. Its canonical start event records these
skips so efficiency claims remain inspectable.

The largest remaining complexity concentrations are the HTTP composition root,
the JSON operator store, the combined chat component, and the combined
stylesheet. They should be separated behind existing public contracts rather
than rewritten as a new framework:

1. Extract request classification and route preparation from the HTTP handler.
2. Extract conversation, workflow, and scheduled-run coordinators that share a
   small run/session projection interface.
3. Replace whole-state JSON rewrites with an append-oriented store plus indexed
   projections before claiming multi-user durability.
4. Split the chat shell into session rail, transcript, composer, run summary,
   settings, and artifact surfaces without moving policy into the frontend.
5. Delete legacy or duplicate presentation rules only after screenshot and
   interaction parity tests cover the replacement.

Each extraction must preserve the same input contract, canonical events,
cancellation behavior, session isolation, and test/eval gates. Lower line count
is not itself the goal; fewer unconditional code paths per user turn is.

### 0. Make the first turn reliably useful

1. Add a direct conversational path for simple questions so greetings and basic
   answers do not pay the workflow tax.
2. Evaluate the exact system prompt, selected context, tool schemas, proposal,
   synthesis, and final response for every run as one trace.
3. Define answer acceptance rubrics by task class: direct answer, research,
   repository change, artifact creation, and operational action.
4. Replace generic verified-state fallback prose with a readable result adapter
   for every capability output.
5. Ensure provider failure never becomes the user's final content when another
   safe route or a useful limitation response is available.

### 1. Make coding work end to end

1. Define a coding-agent contract: inspect, plan when necessary, edit, run focused
   checks, repair, summarize changes, and cite files.
2. Add a sandbox executor with explicit working-directory, environment, time,
   output, process, and cancellation boundaries.
3. Provide compact task-relevant file discovery and repository instructions to
   the model; do not preload the repository or every tool.
4. Add patch, test, diagnostics, and artifact result adapters with observed-state
   verification.
5. Battle-test on small bug fixes, multi-file changes, dependency failures,
   dirty worktrees, interrupted commands, and adversarial repository content.

### 2. Make context an engineered resource

1. Persist exact token usage where providers expose it and label estimates as
   estimates everywhere else.
2. Store stable-prefix fingerprints and cache hit/miss/read/write metrics per
   model pass.
3. Add context reconstruction tests after compaction, including facts, decisions,
   unresolved work, linked files, and authority.
4. Retrieve only task-relevant memory and tools, with provenance and expiry.
5. Measure context recall and instruction adherence, not merely selected-token
   counts.

### 3. Make the interface feel calm and premium

1. Group or archive empty/stale sessions and add search; keep the recent rail to
   a small useful set.
2. Turn offline state into a guided recovery card with one primary action and
   provider diagnostics on demand.
3. Render citations, files, patches, images, audio, tables, and reports as typed
   deliverables rather than plain transcript text.
4. Give each completed turn a clear result, evidence, artifacts, and “inspect
   work” hierarchy.
5. Add first-run onboarding around one real user outcome and one integration,
   not a tour of runtime primitives.
6. Complete keyboard, responsive, reduced-motion, contrast, and screen-reader
   audits.

### 4. Earn a managed premium service

1. Add identity, organizations, roles, workspace tenancy, and per-tenant keys.
2. Add encrypted secrets, configurable data residency and retention, deletion
   receipts, audit export, and incident procedures.
3. Add deployment profiles for hosted, private cloud, and local/hybrid inference.
4. Add health, queue, cost, latency, provider, storage, and policy monitoring with
   service-level objectives.
5. Build a concierge integration flow: connect one repository/data source,
   encode the user's authority and success criteria, run a benchmark task, and
   deliver an auditable baseline.

## Evaluation gate

Every supported task class needs a versioned corpus containing happy paths,
ambiguous requests, missing context, tool failure, provider failure, poisoned
content, cancellation, long sessions, and permission boundaries. Measure:

- task completion and rubric-based answer quality;
- first useful token and completed-run latency;
- model calls, input/output/cache tokens, and estimated cost;
- context recall and instruction adherence;
- tool selection precision and unnecessary-action rate;
- cancellation latency and post-cancel side effects;
- verified-artifact correctness and reproducibility;
- fallback recovery and graceful-limitation quality.

Promotion requires live-provider results to be labeled separately from fixtures.
Thresholds should be set before the run and failed criteria investigated rather
than weakened afterward.

## Product sequence

1. **Operator reliability:** direct answers, task router, response adapters,
   exact run trace, failure recovery.
2. **Coding vertical:** sandbox loop, repository context, patch/test verification,
   coding eval corpus.
3. **Research vertical:** source quality, citation rendering, claim/evidence map,
   research eval corpus.
4. **Deliverables:** typed artifacts and polished viewers.
5. **Private service:** tenancy, secrets, retention, monitoring, onboarding, and
   managed integrations.
6. **Advanced runtime:** reusable agents, schedules, delegation, tool creation,
   and graph exploration only after the core verticals pass their gates.

At the end of every slice, the system must still complete one useful task from
the main operator surface. No phase should require users to understand canonical
events, provider routing, embeddings, or authority profiles to get value.
