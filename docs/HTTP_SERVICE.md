# Evaluated runtime HTTP service

The operator UI connects to `packages/cli/src/server.ts`, a composition-layer
service over the public context, model, policy, capability, workflow, and
ledger packages. It does not invoke the legacy kernel under `src/`.

## Start the complete local application

```bash
HYPER_WORKSPACE=/path/to/bounded/workspace \
HYPER_MODEL=qwen3-vl:8b \
bun run dev
```

The development launcher starts the evaluated backend on port `8791`, starts
Vite, and verifies the `/api` proxy. Start only the service with:

```bash
bun run runtime:serve
```

Configuration:

- `HYPER_WORKSPACE`: filesystem root exposed as `workspace/**`;
- `HYPER_LEDGER_DIR`: per-run JSONL ledger directory;
- `HYPER_OPERATOR_DATA`: atomic operator-session/configuration store;
- `HYPER_PROVIDER`: `ollama`, `anthropic`, `openai`, `openai-compatible`,
  `gemini`, `groq`, `openrouter`, `lmstudio`, or `llamacpp`;
- `HYPER_MODEL`, `HYPER_BASE_URL`, and `HYPER_API_KEY_ENV`: provider settings;
- `HYPER_OLLAMA_BASE_URL` and `HYPER_OLLAMA_MODEL`: Ollama connection;
- `HYPER_ANTHROPIC_BASE_URL`, `HYPER_ANTHROPIC_MODEL`, and
  `HYPER_ANTHROPIC_API_KEY_ENV`: Anthropic connection;
- `HYPER_OPENAI_BASE_URL`, `HYPER_OPENAI_MODEL`,
  `HYPER_OPENAI_API_KEY_ENV`, and `HYPER_OPENAI_LABEL`: an OpenAI-compatible
  connection such as OpenAI, OpenRouter, Groq, LM Studio, or another compatible
  endpoint;
- Existing Shovs variables are normalized for convergence:
  `SHOVS_V2_PROVIDER`, `SHOVS_PROVIDER_FALLBACK_CHAIN`, `DEFAULT_MODEL`,
  `OLLAMA_BASE_URL`, `LMSTUDIO_BASE_URL`, `LLAMACPP_BASE_URL`,
  `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, and
  `ANTHROPIC_API_KEY`. Provider-specific `HYPER_*` values take precedence;
- `HYPER_MODEL_TIMEOUT_MS`: positive provider-request timeout;
- `HYPER_ALLOWED_EXECUTABLES`: comma-separated process executable allowlist;
- `HYPER_ALLOWED_HOSTS`: comma-separated exact HTTP hostname allowlist;
- `HYPER_SCHEDULER_POLL_MS`: background schedule poll period, at least one
  second; and
- `HYPER_PORT`: service port, default `8791`.

## API

- `GET /api/config` and `GET /api/health` report the evaluated runtime,
  provider, model, capability manifests, profiles, and limitations.
- `GET /api/providers` probes every configured provider without exposing
credentials. `GET /api/models/:provider` discovers the live model inventory
  from each normalized provider. Non-chat Gemini media, embedding, audio, and
  research models are excluded from the chat model dropdown.
- `POST /api/chat` and `POST /api/runtime/run` accept an objective and stream
  server-sent events.
- `GET|POST /api/sessions`, `GET /api/sessions/:id/messages`, and
  `GET /api/runs?session_id=:id` expose restart-persistent chat history and run
  projections.
- `POST /api/runs/:runId/approval` resolves a live proposal-scoped approval
  gate with `{ "approved": true | false }`.
- `GET /api/runs/:runId/events`, `/trail`, `/attribution`, and `/pass-metrics`
  expose canonical events, UI projection, provenance links, and bounded-pass
  measurements respectively.
- `GET|DELETE /api/memory` manages active verified-outcome memory.
- `GET|POST|PUT|DELETE /api/custom_tools` manages declarative HTTP GET tools.
- `GET|POST|PUT|DELETE /api/schedules` manages recurring runs, and
  `POST /api/schedules/:id/run` starts one immediately.
- `GET /api/signals` projects aggregate and per-run context/token/latency
  signals from canonical ledgers.
- `GET|POST|PUT /api/corrections` manages inert human correction candidates.
  `accepted_for_experiment` is a review status, not policy activation.
- `GET /api/scorecard` reports deterministic operator-state counts.

A run request may include `provider`, `model`, `profile`, `constraints`,
`required_evidence`, and `completion_criteria`. The provider must match the
server-configured provider registry; the model may select a discovered model or
an explicit custom model ID served by that provider. Provider base URLs and
credential environment-variable names are server-owned configuration and
cannot be supplied by a chat request. Profiles are explicit operator authority
selections:

- `inspect`: workspace reads;
- `workspace`: workspace reads and writes;
- `process`: workspace reads/writes plus configured executables; and
- `network`: workspace reads plus configured HTTP hosts.

Risk-based approval begins at risk 4 for `workspace`, risk 3 for `process` and
`network`, and is unreachable for the read-only `inspect` profile. A gated run
stays paused on its open event stream for up to five minutes. Approval resumes
only the exact proposal ID; rejection leaves it unexecuted.

Verification checks canonical proposal structure, policy scope, tool execution,
independently observed state, capability-specific invariants, and required
evidence before completion. It catches false-success tools and unsupported
completion claims. It does not establish the truth of every semantic claim
inside an external document or HTTP response. Such claims need independently
specified evidence or a domain-specific verifier; model confidence is never
accepted as evidence.

After successful workflow verification, an optional model pass composes a
natural response from the verified observations. Its evidence references are
validated against those observations. A malformed or out-of-scope answer is
discarded in favor of a deterministic observed-state response. This grounding
boundary prevents invented evidence references; it is not a general semantic
truth prover when a response attaches a valid reference to a false claim.

`workflow.receipt` is displayed as `receipt.commit`; it is distinct from
`memory.commit`. Durable memory accepts only terminal observations from actions
whose capability verifier passed. It does not store private reasoning, failed
intermediate proposals, or unverified answer prose. Conversation and memory are
fed back to the model as data/evidence rather than directives. The operator
store is an atomic local index for sessions, current configuration, and active
memory; per-run hash-chained JSONL remains canonical execution history.

Custom tools do not expand runtime authority. They are HTTPS GET capabilities
whose host must already appear in `HYPER_ALLOWED_HOSTS`; policy and the adapter
enforce the configured path prefix on the initial request and every redirect.
They become model-reachable only in the `network` profile.

Schedules use the same `/api/runtime/run` evaluated path, session store,
capability profiles, approval rules, verifier, and ledgers as interactive
turns. A schedule is marked running before dispatch to prevent overlapping
invocations in one process. Proposal-scoped approvals still require a live
operator; a scheduled action that reaches a gate cannot silently authorize
itself.

The service adapts canonical events to the existing UI vocabulary for display.
The JSONL ledger remains the durable truth; UI events are projections. A client
disconnect cannot roll back or invalidate an already persisted canonical event.

## Current limits

Steps inside a run are sequential; there is no global multi-run concurrency
admission controller. Completed sessions, messages, run indexes, verified
memory, tools, and schedules survive restart, but in-flight workflow and
approval continuation do not. Arbitrary MCP discovery, binary/image
attachments, multi-user authentication, distributed scheduling, and hardened
process isolation remain unimplemented. The HTTP service is a local alpha
composition surface, not a production security boundary.
