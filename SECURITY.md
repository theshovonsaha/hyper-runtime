# Security policy

## Supported surface

Only the packages under `packages/` are in the v0.1.0 supported research
surface. The historical `src/`, `scripts/`, and `ui/` trees are legacy
prototype material.

## AI Security Boundaries & Architecture

Hyper-Runtime enforces strict security policies to constrain AI models:
- **Non-Ambient Authority**: Models operate with zero default permissions. Capability grants are proposal-scoped, time-bounded, and narrow.
- **Natural-Language Harness Policy**: System directives and constraints are stable parts of the compiled phase context and cannot be silently dropped to satisfy a token budget.
- **Causal Recovery Boundaries**: If an adapter fails or an observation contradicts a requested outcome, the failure signature is durably recorded and requires a new grant. Retries cannot bypass the original intent's risk ceiling.
- **Credential Safety**: Core runtime code must never hardcode API keys. Production integrations should use the bounded environment credential capability instead of passing raw tokens directly to the model.

## Important limitations

Hyper-Runtime is not a production sandbox. The evaluated adapter is in-memory.
Do not use the legacy raw shell, filesystem, network, dynamic-code, credential,
or self-evolution components with untrusted input.

The event hash chain detects sequence mutation but is not a digital signature
or a defense against a process with full storage control.

## Reporting

Please report suspected vulnerabilities privately to
`theshovonsaha@gmail.com` before public disclosure. Include:

- affected package and version;
- minimal reproduction;
- expected and actual authority boundary;
- whether an external side effect occurred; and
- suggested embargo duration, if needed.

Do not include real credentials, personal data, or destructive payloads.
