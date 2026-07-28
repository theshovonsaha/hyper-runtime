# Delegation and child runtimes

## Design decision

A child agent is not a second orchestration system. It is another
`WorkflowRunner` invocation with its own run identity, ledger, intent, context
view, budgets, verification result, and receipt.

The parent does not give the child its ambient runtime. It delegates a
contract:

```text
parent runtime
  -> delegation contract
    -> authority-subset decision
      -> selected context view
        -> ordinary child workflow
          -> typed result + child receipt
            -> parent result validation
```

This keeps the runtime recursive without creating separate semantics for
"agents" and "sub-agents."

## Authority is monotonic

The central invariant is:

```text
child authority ⊆ parent authority
```

`DelegationPolicy` rejects a contract when the child:

- requests a capability absent from the parent's explicit capability
  allowlist;
- reaches a resource outside the parent's resource patterns;
- removes a parent prohibition;
- raises the parent's risk budget;
- weakens the parent's approval threshold;
- references context that is not present in the actual parent context view; or
- requests more tokens, actions, or wall time than the parent has available.

Parent capability authority must be explicit before it can be delegated.
Legacy intents may omit `authorizedCapabilities` for compatibility, but such an
intent cannot create an authorized child runtime.

## Contract boundary

`DelegationContract` contains:

- distinct parent and child run IDs;
- a child `IntentContract`;
- exact parent context references visible to the child;
- token, action, and wall-time ceilings;
- a minimal JSON output schema; and
- evidence and verified-completion requirements.

`DelegationController` decides the contract before calling an injected
`ChildRuntimeExecutor`. It copies only the referenced context sources. The
child cannot choose its own run ID, intent, context view, or ceilings.

`WorkflowChildRuntimeExecutor` is the standard adapter for local child work. It
runs the same `WorkflowRunner` used by a top-level task and narrows the
workflow's context token and step limits to the delegation budget.

## Result acceptance

A child result is a proposal to the parent, not an automatically trusted fact.
The parent rejects it when:

- the delegation or child run identity is different;
- reported usage exceeds any delegated budget;
- the child attempted a policy-denied action;
- the child did not reach completed status;
- verified completion is required but absent;
- evidence is below the required minimum;
- the child receipt is missing; or
- completed output does not match the expected schema.

Failures use `StructuredFailure`, including whether the child can recover and
whether escalation should go to the child, parent, human, or stop.

## Event and replay model

The parent event sequence is:

```text
delegation.proposed
  -> delegation.decided
    -> delegation.authorized
      -> child_run.started
        -> child_result.received
          -> child_evidence.validated
            -> delegation.receipt
```

The child produces its own ordinary workflow and action events. The parent
receipt links to the child's final receipt hash. Parent and child histories can
therefore be inspected separately while preserving the causal edge between
them.

## What the skeleton does not claim

- The wall-time signal is cooperatively enforced by the workflow between
  steps; it is not process termination or an OS sandbox.
- Budget admission is checked against a caller-supplied remaining balance.
  Atomic reservation across parallel or distributed children is not yet
  implemented.
- The local adapter links the child's receipt hash, but no signature or remote
  attestation protocol exists.
- The result schema validator intentionally supports a small safe subset of
  JSON Schema.
- There is no parallel scheduler, delegation UI, or live-model delegation
  benchmark yet.

These are explicit polish targets, not hidden production claims.

## LLM extraction

```text
parent intent + remaining budget + actual context
  -> prove child authority is a subset
    -> run the same kernel with a narrower view
      -> observe and verify inside the child
        -> validate identity + evidence + budget + schema at the parent
          -> accept or reject an evidence-linked child receipt
```
