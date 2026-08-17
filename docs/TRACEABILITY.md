# Runtime guarantee traceability

This document separates product value, architecture behavior, and code
evidence. It is a map for review, not a substitute for tests or external
validation.

## Product layer

Hyper-Runtime exists because tool-using agents can hide state changes, lose
context, repeat uncertain effects, and report success from a tool response
alone. The product makes authority, model input, execution, observation,
verification, recovery, and memory inspectable in the operator UI.

The accepted tradeoff is more schemas, canonical events, projection work, and
latency at effect boundaries in exchange for narrower claims and replayable
failure evidence.

## Architecture layer

```text
request
  -> session-scoped context projection
  -> workflow or bounded model proposal
  -> deterministic policy/gate
  -> capability grant
  -> prepared effect
  -> execution
  -> independent observation
  -> verification
  -> response
  -> verified memory event
```

Known structure belongs in semantic workflows. A reviewed `use:` adapter lowers
meaning such as `gather_evidence` into an inert node graph. Ambiguous judgment
may use a schema-bounded model node. Every effect still crosses the ordinary
policy and capability boundary.

## Code evidence layer

| Claim | Contract/module | Canonical evidence | Test or evaluation |
|---|---|---|---|
| Reachability is not authority | `IntentContract`, runtime policy | `policy.decided`, `capability.granted` | `tests/runtime.test.ts`, authorized-condition eval |
| Tool success is not task success | `AuthorizedRuntime` | `action.executed` -> `state.observed` -> `action.verified` | false-success fixtures and runtime lab |
| Model input is explicit | `DynamicContextCompiler` | `context.compiled` with exact items and exclusions | context tests and Context Inspector API test |
| Uncertain effects are not blindly repeated | recovery contract and adapter reconciliation | `effect.prepared`, interruption detection/resolution | `tests/convergence-hardening.test.ts` |
| Child authority cannot expand | delegation contract and policy | delegation decision, child validation, signed receipt | delegation and hardening tests |
| Memory is session-scoped and rebuildable | operator projection plus canonical memory events | commit, supersede, delete | CLI restart/rebuild test |
| Reusable procedures remain reviewed | planning config compiler and reviewed skill registry | candidate/backtest/activation records | convergence hardening and workflow backtest tests |

## Complete example traces

### Verified workspace action

```text
ActionProposal
  -> PolicyDecision
  -> CapabilityGrant
  -> effect.prepared
  -> CapabilityExecution
  -> Observation
  -> VerificationResult
  -> ActionOutcome
```

Failure behavior: denied proposals never execute; thrown tools become failed
receipts; false-success output fails observation; unknown effects require
reconciliation; missing evidence blocks completion.

### Research workflow

```text
semantic use config
  -> reviewed operation adapters
  -> bounded parallel searches
  -> normalized evidence facts
  -> conflict route
  -> synthesis model operation
  -> citation verifier
  -> report capability
  -> observed artifact
```

The model can interpret or choose among declared branches. It cannot add a host,
credential, capability, effect, or completion fact.

### Delegated child

```text
parent intent + selected context + atomic budget reservation
  -> narrower child intent
  -> isolated cancellable worker
  -> child verified receipt
  -> Ed25519 attestation validation
  -> schema/evidence/budget/policy validation
  -> parent accepts or rejects result
```

Failure behavior: timeout terminates the isolated worker; malformed usage is
charged conservatively and rejected; an untrusted key or altered result cannot
enter parent state.

## Explanation checklist

For every new major component, record:

1. problem and failure of the ordinary approach;
2. chosen design and accepted tradeoff;
3. input and output contracts;
4. state read and written;
5. canonical events;
6. failure and recovery routes;
7. tests, evaluation class, and remaining unverified claim.
