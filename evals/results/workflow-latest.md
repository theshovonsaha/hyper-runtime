# Adaptive Context and Workflow Evals v1.0.0

**Research question:** Does phase-specific context curation preserve authoritative constraints and isolate stale or untrusted material, while causal workflow control rejects false completion and recovers through bounded pivots?

This is a deterministic mechanism benchmark with 4 context fixtures, 3 workflow fixtures, and zero model calls.

| Metric | Result |
|---|---:|
| Context expectation accuracy | 100.0% |
| Untrusted instruction isolation | 100.0% |
| Workflow status accuracy | 100.0% |
| Causal trace coverage | 100.0% |
| Recovery success | 100.0% |
| False-completion commit | 0.0% |
| Ledger integrity | 100.0% |

Acceptance gate: **PASS**

## Interpretation boundary

The benchmark establishes deterministic fixture behavior only. It does not establish live-model planning quality, resistance to adaptive prompt injection, hardened process isolation, or general recovery performance.
