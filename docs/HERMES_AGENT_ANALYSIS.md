# Hermes Agent analysis and Hyper-Runtime adoption map

This is a source-based design comparison, not evidence that Hyper-Runtime has
implemented every Hermes feature. The claim boundary remains the evaluated
runtime documented in `README.md` and `docs/ARCHITECTURE.md`.

## What makes Hermes distinctive

Hermes combines a persistent agent loop with a broad operating surface:
toolsets, terminal backends, subagents, schedules, messaging gateways, provider
switching, credential pools, session search, profiles, skills, and memory. Its
most useful architectural distinction is between procedural knowledge in
skills and factual/user knowledge in memory. Skills use progressive disclosure:
the model first sees compact metadata and loads a skill and its references only
when relevant. This preserves context budget while allowing an extensible
procedural library.

Profiles isolate configuration, sessions, skills, and memory. Session search
adds full-text retrieval and summaries so earlier work can be rediscovered.
The same core loop is exposed through terminal and messaging gateways, and the
project treats completed trajectories as useful data for agent improvement.

Primary sources:

- [Hermes Agent repository](https://github.com/NousResearch/hermes-agent)
- [Working with skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/work-with-skills.md)
- [Hermes developer guide](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md)
- [Middleware/lifecycle proposal (open issue, not an implemented guarantee)](https://github.com/NousResearch/hermes-agent/issues/626)

## Where Hyper-Runtime is intentionally stricter

Hyper-Runtime already has boundaries that should not be traded for breadth:

- model output is an inert proposal until canonical parsing and policy admit it;
- reachability never grants authority;
- capabilities produce separate execution, observation, and verification facts;
- completion requires exact observed evidence, not tool success or confident prose;
- the hash-chained event ledger is durable truth and UI records are projections;
- verified memory belongs to one session agent and cannot bleed across sessions;
- fallback and round-robin provider routing do not bypass any safety boundary.

Hermes is therefore a feature and ergonomics reference, not a replacement for
Hyper's authority kernel.

## Adoption decisions

| Priority | Hermes-inspired improvement | Hyper-compatible design | Status |
|---|---|---|---|
| P0 | Provider resilience | Derive health and route scores from canonical transport/proposal failures; routing changes availability, never authority. | Fallback, round-robin, and failure events implemented; durable cross-process route scoring remains. |
| P0 | Procedural knowledge | Keep reviewed skills separate from verified factual memory. Load compact manifests first, then bounded references on demand. Never auto-execute model-authored code. | Reviewed metadata discovery and bounded explicit loading implemented; no automatic installation or execution. |
| P1 | Session retrieval | Add provenance-linked full-text retrieval over one session's canonical transcript and verified memory. Retrieved text remains untrusted evidence/data. | Persistent per-session term index and automatic bounded retrieval implemented. |
| P1 | Tool ecosystem | Discover remote tools from manifests, then intersect declared effects/resources with intent and policy before registration. | Server-owned Streamable HTTP discovery, local authority mapping, and independent observation pairing implemented. |
| P1 | Lifecycle hooks | Use ordered, typed, deterministic policy/telemetry hooks with explicit failure behavior. Reject arbitrary plugin code inside the authority kernel. | Ordered hooks with fail-closed or record-and-continue behavior implemented around the ordinary workflow. |
| P2 | Gateways | Treat each inbound/outbound channel as a capability with identity, destination scope, approval, receipt, and replayable delivery events. | Authenticated ingress and approved, allowlisted, independently observed outbound delivery implemented. |
| P2 | Crash recovery | Resume only from canonical events and idempotency receipts; repair incomplete tool-call/result pairs as explicit recovery events. | Durable effect preparation, adapter reconciliation, projection rebuilding, and linked continuation implemented; unresolved non-idempotent effects still fail closed. |
| P2 | Bounded delegation | Add subagent UX and scheduling only through the existing child-authority narrowing and result-validation boundary. | Atomic shared budgets, terminating workers, and optional signed remote receipts implemented; visual delegation scheduling remains. |

## Patterns not to copy directly

- Broad shell or filesystem reachability must not become implicit authority.
- Agent-authored skills must not be silently installed or executed.
- Credentials must remain server-owned; the model may select only exposed route
  IDs and can never read or mint provider secrets.
- Cross-profile or cross-session memory retrieval must remain impossible unless
  a future explicit sharing contract is authorized and provenance-preserving.
- A gateway delivery acknowledgement is not evidence that the user's real-world
  goal succeeded.

## Provider implications

NVIDIA NIM, DeepSeek, Mistral, and the compatible subset of OpenCode Zen are
now represented as explicit server-owned routes. Model inventories are probed
dynamically, so free catalogs can change without hardcoding the dropdown.
OpenCode currently mixes several wire protocols; Hyper exposes only families
served by the chat-completions transport it actually implements. DeepSeek's
direct API is intentionally described as low-cost/paid rather than free.

Provider sources:

- [NVIDIA NIM API reference](https://docs.nvidia.com/nim/large-language-models/1.12.0/api-reference.html)
- [Mistral free-mode setup](https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key)
- [DeepSeek API pricing and compatibility](https://api-docs.deepseek.com/quick_start/pricing)
- [OpenCode Zen model protocols and catalog](https://opencode.ai/docs/zen)
- [OpenCode provider configuration](https://opencode.ai/docs/providers)
- [GitHub Models free, rate-limited prototyping](https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models)

GitHub Models is a useful next provider experiment, but it is not claimed as
implemented here. It should be added only after its live inventory and protocol
are represented explicitly and exercised by transport tests.
