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
- hardened OS/container isolation for local processes;
- prevention of every DNS rebinding or network-stack attack;
- adaptive prompt-injection robustness;
- correctness of user-authored task contracts or completion oracles;
- protection against malicious capability implementations;
- distributed consensus, concurrent ledger writers, or remote attestation;
- provider availability and model reasoning quality; and
- production security certification.

The bounded process adapter reduces accidental command scope. It is not a
security sandbox: an allowlisted executable still inherits the operating
system authority of the Hyper-Runtime process.

## Deployment rule

Use a disposable operating-system sandbox for untrusted work, grant only
task-specific filesystem and network access, and do not treat this prototype
as the sole security boundary.
