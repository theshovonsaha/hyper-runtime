# stateful-agent-execution-simulation

Evidence: `simulated_inference`

Stateful deterministic model doubles exercise real workflow/model/capability boundaries; results do not establish live-model answer quality or population coverage.

Acceptance: **PASS**

| Metric | Result |
|---|---:|
| Stories | 18 |
| Archetype coverage | 100.0% |
| Scenario pass rate | 100.0% |
| Tool continuity | 100.0% |
| Recovery | 100.0% |
| Structurally grounded answers | 100.0% |
| False completion | 0.0% |
| Unauthorized execution | 0.0% |
| Ledger integrity | 100.0% |
| Total simulated model calls | 39 |

| Story | Category | Status | Calls | Result |
|---|---|---|---:|---|
| ordinary-chat-no-tool | conversation | completed | 1 | PASS |
| coding-inspect-edit-test | coding | completed | 4 | PASS |
| coding-multi-file-native-batch | multi_tool | completed | 2 | PASS |
| web-research-grounded-answer | research | completed | 2 | PASS |
| session-knowledge-retrieval | retrieval | completed | 2 | PASS |
| execution-failure-pivot-repair | recovery | completed | 4 | PASS |
| false-success-observed-and-repaired | recovery | completed | 3 | PASS |
| malformed-model-pass-repair | recovery | completed | 3 | PASS |
| premature-completion-rejected | adversarial | completed | 3 | PASS |
| provider-fallback-preserves-authority | provider_resilience | completed | 2 | PASS |
| avoidable-clarification-rejected | human_gate | completed | 3 | PASS |
| material-clarification-pauses | human_gate | needs_input | 1 | PASS |
| high-risk-action-needs-approval | human_gate | needs_approval | 1 | PASS |
| out-of-scope-target-denied | adversarial | blocked | 2 | PASS |
| repeated-provider-failure-blocks | provider_resilience | blocked | 2 | PASS |
| operator-cancels-model-pass | cancellation | cancelled | 1 | PASS |
| strategy-mismatch-fails-closed | adversarial | blocked | 1 | PASS |
| long-context-remains-bounded | retrieval | completed | 2 | PASS |

