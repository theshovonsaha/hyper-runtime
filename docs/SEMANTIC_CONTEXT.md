# Semantic context and deliberation records

## The problem

Raw conversation history preserves everything but does not distinguish what
the information means. A flat summary is smaller but may collapse a decision,
an assumption, a failed approach, and an observation into one ambiguous block.

Hyper-Runtime keeps those concerns separate:

```text
canonical events
  -> provenance-linked semantic records
    -> current typed projection
      -> phase-specific context packet
        -> disposable rendered prompt
```

Canonical events remain the durable execution truth. Semantic records organize
that truth for future work. Context packets and summaries can be rebuilt.

## Semantic record types

`ContextRecord` labels information as one of:

```text
intent, current_direction, hypothesis, decision, rejected, open_question,
assumption, evidence, constraint, condition, capability, authority,
action_proposal, observation, verification, failure, repair, drift, artifact,
next_step, summary
```

Each record also has:

- canonical source event IDs;
- status and expiry;
- authority;
- confidence and priority;
- search tags;
- an optional superseded record; and
- a `rebuildable` marker.

Records are append-only. A correction appends a new record with `supersedes`;
it does not silently mutate history. `StructuredContextLedger.current()`
projects the active, non-expired, non-superseded view.

## Phase-specific compilation

Different phases need different evidence. `PHASE_CONTEXT_TAGS` supplies a
semantic profile for orient, plan, act, verify, diagnose, recover, and complete.

Examples:

- planning prioritizes decisions, conditions, capabilities, and authority;
- acting prioritizes action proposals and bounded capability state;
- verification prioritizes observations, artifacts, and verification records;
- diagnosis prioritizes failures, drift, assumptions, and evidence;
- recovery prioritizes failures, repairs, rejected approaches, and authority.

Directive and constraint sources always remain instruction-eligible and cannot
be silently dropped to fit the budget. Other sources are evidence-only,
phase-filtered, relevance-scored, and token-bounded.

Runtime-generated observations, failure diagnoses, and pivot decisions are
already tagged and marked rebuildable, so the workflow feeds its structured
history back into later phases.

## Deliberation without hidden chain-of-thought

The runtime does not request or store private model reasoning. It stores
inspectable operational records that a system needs to continue safely:

- chosen decision and stated reason;
- hypothesis and predicted observation;
- actual observation;
- rejected or superseded approach;
- failure signature and repair;
- open question, constraint, and next step.

This is a decision trail, not hidden chain-of-thought. It is suitable for audit,
replay, context compilation, and future interpretability experiments because
each record has an explicit role and provenance.

## Four-layer model

| Layer | Question | Primary objects |
|---|---|---|
| Meaning | What does this information represent now? | semantic records, context packets |
| Control | Is this action or delegation allowed? | intents, conditions, policy decisions, grants |
| Execution | What changed in the environment? | capabilities, executions, observations, verification |
| History | Can the path and outcome be reconstructed? | canonical events, causal records, receipts |

The layers interact through contracts rather than sharing one mutable prompt or
orchestration object.

## LLM extraction

```text
raw history is evidence, not working state
  -> type important meaning without erasing provenance
    -> supersede instead of overwrite
      -> compile only what the current phase needs
        -> preserve constraints and isolate untrusted data
          -> rebuild summaries from canonical events when needed
```
