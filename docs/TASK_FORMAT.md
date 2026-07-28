# Task and workflow format

Hyper-Runtime `0.2` accepts a versioned JSON task and obtains one canonical
proposal per step from either a scripted fixture or a live model transport.

## Minimal invocation

```bash
bun run hyper -- run \
  --task examples/verified-file/task.json \
  --workspace examples/verified-file/workspace \
  --ledger /tmp/hyper-verified-file.jsonl \
  --provider scripted \
  --proposals examples/verified-file/proposals.json
```

Inspect the replay:

```bash
bun run hyper -- replay --ledger /tmp/hyper-verified-file.jsonl
```

The scripted provider is an auditable end-to-end mechanism demonstration. It
does not make a model-quality claim.

## Live transports

Anthropic Messages:

```bash
bun run hyper -- run \
  --task task.json \
  --workspace ./workspace \
  --ledger ./run.jsonl \
  --provider anthropic \
  --model YOUR_MODEL \
  --api-key-env ANTHROPIC_API_KEY
```

OpenAI-compatible JSON endpoint:

```bash
bun run hyper -- run \
  --task task.json \
  --workspace ./workspace \
  --ledger ./run.jsonl \
  --provider openai-compatible \
  --model YOUR_MODEL \
  --base-url https://provider.example/v1 \
  --api-key-env PROVIDER_API_KEY
```

API keys are read only from the explicitly named environment variable. They
are not placed in task files, context packets, or ledger events.

## Contract fields

- `authorizedCapabilities` explicitly limits which registered capabilities may
  execute. It is optional for compatibility with early v0.2 tasks, but should
  be present in new tasks and is mandatory before authority can be delegated.
- `authorizedResources` limits targets independently of capability reachability.
- `conditions` must be active, evidenced, referenced, and unexpired.
- `requiredEvidence` names semantic evidence that must be produced by completed
  actions and referenced by the completion proposal.
- `constraints` form the stable coherence spine of every context packet.
- `sources` are provenance-linked context candidates. Only `directive` and
  `constraint` authority can be instruction-eligible. Sources may also carry a
  `semanticTag`, `confidence`, and `rebuildable` marker for phase-specific
  compilation.
- `allowedExecutables` opts into bounded, shell-free local process execution.
- `httpAllowedHosts` opts into HTTP GET for exact hostnames.

## Trust boundary

Task authors remain responsible for defining honest completion evidence. The
default oracle establishes that required evidence was produced by verified
actions; domain-specific deployments should provide stronger completion
oracles for semantic criteria.

The CLI currently launches a top-level workflow. Programmatic child runtimes
use `DelegationContract`, `DelegationController`, and
`WorkflowChildRuntimeExecutor`; the task-file surface will be extended only
after delegation scheduling has its own evaluation.

## LLM extraction

```text
registered capability -> still not authorized
  -> task capability + resource allowlists
    -> active evidenced conditions
      -> observed required evidence
        -> verified completion receipt
```
