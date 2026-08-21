# Threat model

## Protected invariants

The public runtime is designed to prevent these mechanism-level failures:

- capability reachability being treated as authorization;
- actions outside declared resource, effect, condition, approval, or risk scope;
- tool-return success being treated as environmental success;
- untrusted retrieved content being promoted to instruction authority;
- unsupported completion claims being committed;
- silent mutation of a persisted single-process event sequence; and
- repeated failed approaches losing their causal evidence during a pivot.

## In-scope controls

- deterministic policy decisions;
- proposal-scoped grants and approvals;
- workspace path containment with symbolic-link rejection;
- atomic bounded file writes;
- shell-free executable allowlists and timeouts;
- exact HTTP hostname allowlists, DNS private-address checks, manual redirect
  validation, and response-size limits;
- phase-specific context budgets, relevance selection, validity filtering, and
  authority labels;
- observed-state verification and evidence-linked workflow receipts; and
- append-only JSONL replay with a SHA-256 hash chain.

## Explicitly out of scope in 0.2

- defense against an attacker controlling the runtime process or ledger file;
- hardened OS/container isolation when no sandbox backend is configured;
- prevention of every DNS rebinding or network-stack attack;
- adaptive prompt-injection robustness;
- correctness of user-authored task contracts or completion oracles;
- protection against malicious capability implementations;
- distributed consensus, concurrent ledger writers, or remote attestation;
- provider availability and model reasoning quality; and
- production security certification.

The ledger also does not provide concurrent-writer serialization, distributed
effect consensus, or protection from a process that
can rewrite the complete file and recompute its hashes. Replay currently
establishes schema, sequence, hash-chain integrity, per-run projections,
interrupted-effect reconciliation, linked continuation, and terminal receipts.

The bounded process adapter alone is not a security sandbox: an allowlisted
executable still inherits the runtime process authority. When Linux bubblewrap
is configured, each invocation probes the backend and fails closed when it is
unavailable; this is a concrete isolation mechanism, not a certification of the
host or the runtime as a whole.

The OCI backend is the stronger deployment option: it requires an immutable
image digest and removes network, capabilities, writable root, and broad host
mounts. These controls are tested at command construction and fail-closed probe
boundaries; they are not an independent production certification.

## Deployment rule

Use a disposable operating-system sandbox for untrusted work, grant only
task-specific filesystem and network access, and do not treat this prototype
as the sole security boundary.
