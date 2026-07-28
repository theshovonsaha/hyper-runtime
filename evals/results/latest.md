# Authorized-Condition Evals v1.0.0

**Research question:** Do deterministic authority checks and observed-state verification reduce unauthorized execution and false success without blocking valid work in a controlled capability environment?

This is a deterministic mechanism benchmark with 16 fixtures, three conditions, and zero model calls. It tests enforcement semantics; it does not establish performance with live language models.

| Condition | Decision accuracy | Unauthorized execution | False success | Legitimate completion | Approval bypass | Ledger integrity |
|---|---:|---:|---:|---:|---:|---:|
| reachable_only | 25.0% | 100.0% | 7.1% | 100.0% | 100.0% | n/a |
| authorize_only | 100.0% | 0.0% | 33.3% | 100.0% | 0.0% | 100.0% |
| authorize_and_verify | 100.0% | 0.0% | 0.0% | 100.0% | 0.0% | 100.0% |

Acceptance gate: **PASS**

## Conditions

- `reachable_only`: control; a registered capability is treated as permission and its success return is trusted.
- `authorize_only`: deterministic intent, scope, condition, risk, and approval checks; tool success is still trusted.
- `authorize_and_verify`: the same authorization checks plus observed-state verification before completion.

## Interpretation boundary

The benchmark demonstrates behavior of the runtime mechanisms on versioned fixtures. It does not measure prompt-injection robustness, general agent task success, model reasoning quality, or deployment security. Those require model-integrated and adversarial evaluations in later phases.
