# Independent security review packet

This document defines the review Hyper-Runtime still needs. It is not a
self-issued security approval.

## Review boundary

Review the public packages, CLI HTTP service, OCI/bubblewrap process backends,
filesystem and HTTP capabilities, dynamic MCP authority mapping, gateways,
media adapters, delegation receipts and budgets, canonical ledger recovery,
and the operator UI's handling of credentials and approval state. The legacy
`src/`, `scripts/`, and `ui/index.html` prototype is outside the release claim.

## Required attacker models

- malicious task, retrieved content, model proposal, tool response, child
  result, MCP server, redirect target, file tree, and media payload;
- crash between prepare, effect, observation, checkpoint, and projection;
- concurrent child admission and non-cooperative child worker;
- compromised provider response but not a compromised runtime host; and
- operator mistakes around profiles, approvals, credentials, and container
  configuration.

## Questions the reviewer must answer

1. Can any input expand capability, resource, effect, approval, or child scope?
2. Can a side effect be repeated after uncertain interruption?
3. Can an unverifiable child result or forged receipt enter parent state?
4. Can a process escape the configured filesystem/network/container boundary?
5. Can credentials, signed media URLs, or cross-session memory reach events or
   another session?
6. Can a UI or semantic projection disagree with canonical events after crash?
7. Which assumptions fail under multiple processes or a compromised host?

## Evidence to reproduce

Run `bun run release:check`, inspect `tests/convergence-hardening.test.ts`, and
repeat the adversarial, specialized, contributed, live-provider, and live-media
experiments as their credentials or external datasets permit. Report exact
revision, operating system, container runtime/image digest, failures, and any
changed fixture or threshold.

## Acceptance boundary

A review may establish properties only for the reviewed revision and deployment
configuration. Findings must remain public or be summarized with severity,
affected boundary, reproduction, remediation, and retest status. Production
security remains unverified until an independent reviewer completes this work.
