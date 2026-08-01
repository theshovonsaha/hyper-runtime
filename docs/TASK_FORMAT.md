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

Replay output includes whole-file integrity plus a per-run event count, latest
event hash, terminal status, and receipt hash. Run IDs are immutable identities:
starting another workflow with an ID already present in the ledger is rejected.
Use a new run ID for a new attempt. Resuming an incomplete run is not implemented
in v0.2.

The scripted provider is an auditable end-to-end mechanism demonstration. It
does not make a model-quality claim.

The reusable multi-tool example exercises file read, bounded process, file
write, independent observation, and completion in sequence:

```bash
bun run hyper -- run \
  --task examples/multi-tool/task.json \
  --workspace examples/multi-tool/workspace \
  --ledger /tmp/hyper-multi-tool.jsonl \
  --run-id run:multi-tool-manual \
  --provider scripted \
  --proposals examples/multi-tool/proposals.json
```

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

Local Ollama using its OpenAI-compatible endpoint (defaults to
`http://127.0.0.1:11434/v1`):

```bash
bun run hyper -- run \
  --task examples/multi-tool/task.json \
  --workspace examples/multi-tool/workspace \
  --ledger /tmp/hyper-ollama.jsonl \
  --provider ollama \
  --model YOUR_LOCAL_MODEL
```

`--api-key-env` is optional for OpenAI-compatible endpoints and Ollama, and
required for Anthropic. The live proposal prompt receives the exact intent ID,
acting principal, required conditions, evidence requirements, risk budget,
active strategy, capability targets, and capability argument schemas.
Provider requests default to a 60-second timeout; use
`--model-timeout-ms MILLISECONDS` to set a different positive bound.

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
- `runId` is optional. The runtime generates a unique ID when it is omitted;
  `--run-id` overrides the task for repeatable operator-selected identities.
- `approvals` may contain proposal-scoped approvals. Policy still validates
  principal, proposal ID, issue time, and expiry and cannot expand intent scope.
- `correctionRules` may map exact failure codes to a temporary recovery
  constraint, focus tags, application limit, and expected effect. A correction
  affects the next bounded pass but cannot change policy authority.

Example:

```json
{
  "correctionRules": [{
    "id": "correction:stale-write",
    "triggerCodes": ["STALE_FILE_PRECONDITION"],
    "instruction": "Re-read the target before proposing another write.",
    "focusTags": ["recover", "fresh-state"],
    "maxApplications": 1,
    "expectedEffect": "The next proposal uses a current file digest."
  }]
}
```

Each model turn proposes one action, pivot, question, or completion claim. A
workflow can therefore use multiple tools across verified sequential steps.
Parallel scheduling, automatic crash resume, and arbitrary MCP discovery are
not implemented in the CLI surface.

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
