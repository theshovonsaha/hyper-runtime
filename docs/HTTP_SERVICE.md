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
  `gemini`, `groq`, `openrouter`, `nvidia`, `deepseek`, `mistral`, `opencode`,
  `lmstudio`, or `llamacpp`;
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
  `ANTHROPIC_API_KEY`. Additional compatible routes use `NVIDIA_API_KEY`,
  `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, and `OPENCODE_API_KEY`, with optional
  `HYPER_NVIDIA_MODEL`, `HYPER_DEEPSEEK_MODEL`, `HYPER_MISTRAL_MODEL`, and
  `HYPER_OPENCODE_MODEL`. Provider-specific `HYPER_*` values take precedence;
- `HYPER_MODEL_TIMEOUT_MS`: positive provider-request timeout;
- `HYPER_MODEL_ROUTING_MODE`: `fallback`, `ping_pong` (two pairs), `ring`
  (three pairs), `ring_pair` (four pairs), or legacy `round_robin`;
- `HYPER_MODEL_ROUTE_SCHEDULE`: JSON array of one to four explicit
  `{ "provider": "...", "model": "..." }` pairs. Route A also supplies the
  default provider/model;
- `HYPER_MODEL_ROUTE_FAILURE_THRESHOLD` and
  `HYPER_MODEL_ROUTE_COOLDOWN_PASSES`: positive integers controlling the
  deterministic per-run route-health circuit (both default to `2`);
- `HYPER_PROVIDER_FALLBACK_CHAIN`: ordered, comma-separated model providers;
- `HYPER_SEARCH_PROVIDER_CHAIN`: ordered subset of `tavily`, `brave`, `exa`,
  and `searxng`; the associated variables are `TAVILY_API_KEY`,
  `BRAVE_SEARCH_KEY`, `EXA_API_KEY`, and `SEARXNG_URL`/`SEARXNG_BASE_URL`;
- `HYPER_ALLOWED_EXECUTABLES`: comma-separated process executable allowlist;
- `HYPER_PROCESS_SANDBOX=bubblewrap`: require a probed bubblewrap isolation
  backend for process calls; unavailable isolation fails the action closed;
- `HYPER_PROCESS_SANDBOX=oci`, `HYPER_OCI_IMAGE` (required immutable
  `sha256` digest), and optional `HYPER_OCI_RUNTIME`, `HYPER_OCI_MEMORY_MB`,
  and `HYPER_OCI_PIDS_LIMIT`: run process capabilities in a networkless,
  read-only, capability-dropped Docker or Podman container;
- `HYPER_MCP_CONFIG`: local JSON mapping allowlisted Streamable HTTP MCP
  endpoints and tools to explicit authority plus separate observation tools;
- `HYPER_GATEWAY_CONFIG`: local JSON for recipient/sender allowlists,
  backend-only credentials, and independently observed delivery;
- `DEEPGRAM_API_KEY`: enables bounded workspace-file transcription and speech
  generation, with optional `HYPER_DEEPGRAM_STT_MODEL`,
  `HYPER_DEEPGRAM_TTS_MODEL`, and `HYPER_DEEPGRAM_BASE_URL`;
- `ELEVENLABS_API_KEY`: enables Scribe transcription. Add
  `HYPER_ELEVENLABS_VOICE_ID` for TTS and comma-separated
  `HYPER_ELEVENLABS_AGENT_IDS` for allowlisted private voice-agent sessions;
- `GEMINI_API_KEY` or `OPENAI_API_KEY`: enables the approval-gated
  OpenAI-compatible vision adapter; override it with `HYPER_VISION_MODEL`,
  `HYPER_VISION_API_KEY_ENV`, or `HYPER_VISION_BASE_URL`;
- `OPENAI_API_KEY`: enables approval-gated inline image generation; override
  it with `HYPER_IMAGE_MODEL`, `HYPER_IMAGE_API_KEY_ENV`, or
  `HYPER_IMAGE_BASE_URL`. Remote result URLs
  are rejected; decoded image bytes are written inside the workspace;
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
  research models are excluded from the chat model dropdown. OpenCode Zen is
  restricted to model families currently served through its OpenAI-compatible
  chat-completions protocol; models requiring Responses, Anthropic, or Gemini
  transports are not falsely exposed as runnable.
- `POST /api/chat` and `POST /api/runtime/run` accept an objective and stream
  server-sent events. `run_mode` is `fast`, `reasoned`, or `agent`; it changes
  the bounded step budget and response-depth contract, never authority.
- `GET|POST /api/sessions`, `PUT /api/sessions/:id/agent`,
  `GET /api/sessions/:id/messages`, and
  `GET /api/runs?session_id=:id` expose restart-persistent chat history and run
  projections.
- `POST /api/sessions/:id/branches` forks immutable history before a named
  message, which is the edit/regenerate primitive. `DELETE /api/sessions/:id`
  removes the session-owned query projections and uploaded bytes after active
  work stops; per-run canonical ledgers remain available for audit.
- `GET|POST /api/sessions/:id/files` lists or ingests up to four files per
  request into that session. `DELETE /api/sessions/:id/files/:fileId` removes
  the projection and stored bytes. Public responses never expose storage paths.
- `GET /api/sessions/:id/knowledge/search?q=...&at=...` exposes bounded hybrid
  retrieval and embedding limitations. `GET
  /api/sessions/:id/knowledge/graph` returns a bounded, vector-free projection
  of files, chunks, and provenance-linked temporal/relationship edges.
- `GET /api/embedding-profiles` reports ready and unavailable embedding
  profiles. `PUT /api/sessions/:id/embedding` selects a profile until first
  ingestion locks the session vector space.
- `GET /api/filesystem`, `/api/filesystem/preview`, and
  `/api/filesystem/content` expose a bounded, workspace-rooted universal file
  explorer. Session file `/preview` and `/content` routes provide typed views
  without disclosing backing storage paths.
- Successful verified workspace mutations are projected as session artifacts.
  They appear in `GET /api/sessions/:id/files`; artifact `/preview` and
  `/content` routes re-resolve the workspace target and never trust a stored
  absolute path.
- Chat requests may contain bounded `linked_files` records. Workspace links are
  authorized-read hints; session links add provenance-linked chunks. Neither
  expands capability authority.
- Session-agent configuration accepts `auto_mode` and `auto_max_steps`. Server
  step and wall-time ceilings come from `HYPER_AUTO_MAX_STEPS` and
  `HYPER_AUTO_MAX_WALL_MS`; auto mode never bypasses approval or intent scope.
- `POST /api/runs/:runId/approval` resolves a live proposal-scoped approval
  gate with `{ "approved": true | false }`.
- `POST /api/runs/:runId/cancel` moves a live run through `cancelling` to a
  canonical `cancelled` workflow receipt. Cancellation propagates into the
  active model request; an action already across the effect boundary finishes
  observation/reconciliation before the cancelled receipt is committed.
- `GET /api/runs/:runId/events`, `/trail`, `/attribution`, and `/pass-metrics`
  expose canonical events, UI projection, provenance links, and bounded-pass
  measurements respectively.
- `GET /api/runs/:runId/projection` rebuilds the run timeline, evidence,
  context passes, memory state, checkpoint, and pending effects only from that
  run's canonical events. `GET /api/projections/rebuild` repeats this for all
  locally indexed runs.
- `GET /api/runs/:runId/context` returns the exact canonical context items,
  exclusions, audits, linked tool proposal, and detected drift/bias signals for
  the Context Inspector.
- `GET /api/memory?session_id=:id` and `DELETE /api/memory/:id` manage
  session-isolated verified-outcome memory. `PATCH /api/memory/:id` appends a
  canonical supersession rather than mutating history, and
  `GET /api/memory/graph?session_id=:id&q=...` returns the bounded Runtime
  Graph. The read-only graph joins session memory with hash-chain-validated
  context packets, selected sources, model proposals, authorized capabilities,
  verifications, and evidence. It reports orphan-link, provenance-coverage,
  canonical-event, verified-path, and truncation metrics; it remains a query
  projection and never becomes memory, policy, or execution authority.
- `GET|POST|PUT|DELETE /api/custom_tools` manages declarative HTTP GET tools.
- `GET /api/sessions/:id/search?q=...` searches the persistent per-session
  provenance index without reading another session.
- `POST /api/runs/:id/resume` starts a linked continuation from the latest
  verified checkpoint without replaying checkpointed side effects.
- `POST /api/gateways/:id/inbound` authenticates an allowlisted sender and
  submits its message under the inspect profile; ingress cannot choose scope.
- `POST /api/media/voice-sessions/:handle/claim` consumes a one-time opaque
  handle with `no-store`. ElevenLabs claims return a short-lived signed
  WebSocket URL; Deepgram claims return a temporary bearer token and the
  selected regional Voice Agent WebSocket URL. Long-lived project credentials
  never enter either response.
  The signed URL is never written to the canonical ledger.
- `GET|POST|PUT|DELETE /api/schedules` manages recurring runs, and
  `POST /api/schedules/:id/run` starts one immediately.
- `GET /api/signals` projects aggregate and per-run context/token/latency
  signals from canonical ledgers.
- `GET|POST|PUT /api/corrections` manages inert human correction candidates.
  `accepted_for_experiment` is a review status, not policy activation.
- `GET /api/scorecard` reports deterministic operator-state counts.

### Versioned operator event contract

`/api/config` advertises the canonical-event, UI-event, stream, and Runtime
Graph contract versions. The first SSE frame is stream metadata with
`stream_version`, `event_schema_version`, `evidence_class`, run/session IDs,
start time, and the selected provider/model route. Every subsequent UI event
has a stable ID derived from its canonical hash and display type, plus:

- `state` and `lens` for presentation without reinterpreting payloads;
- `canonical_event_id`, `canonical_type`, and `canonical_sequence` for direct
  provenance;
- proposal, packet, capability, and evidence correlation fields; and
- explicit `timing_source` and `provenance` fields.

Live event timestamps are projection emission times. Replay timestamps are
also projection times and are therefore labeled `replay_projection`; clients
must use canonical sequence for replay order rather than presenting those
timestamps as historical occurrence times. `GET /api/runs/:runId/trail`
verifies the hash chain before returning its versioned UI projection, integrity
record, phase counts, action/verification counts, and evidence summary. A
ledger that fails validation returns `409` and is never presented as a valid
trail.

A run request may include `provider`, `model`, `routing_mode`,
`fallback_providers`, explicit `routing_routes`, `profile`, `constraints`,
`required_evidence`, and `completion_criteria`. The provider must match the
server-configured provider registry; the model may select a discovered model or
an explicit custom model ID served by that provider. Provider base URLs and
credential environment-variable names are server-owned configuration and
cannot be supplied by a chat request. Profiles are explicit operator authority
selections:

- `inspect`: workspace reads;
- `workspace`: workspace reads and writes;
- `web`: bounded normalized public-web search only;
- `research`: public-web search plus workspace reads and writes;
- `process`: workspace reads/writes plus configured executables;
- `coder`: repository-scale reads/writes, configured executables, session
  knowledge search, stronger coherence constraints, and a longer verified run;
- `network`: workspace reads plus configured HTTP hosts;
- `media`: workspace inspection plus only the configured speech, voice-agent,
  vision, and image-generation capabilities; and
- `partner`: every capability currently registered by the server. This is an
  operator-selected authority ceiling, not a wildcard: manifest targets,
  conditions, risk policy, approval, observation, and verification still apply.

`session.knowledge.search` is a low-risk read tool, but each run authorizes only
the current session target. The model may refine a query iteratively; the
adapter re-observes retrieval and verifies stable chunk identities. See
`docs/AGENTIC_RAG.md`.

Model clarification proposals are not automatically treated as terminal user
questions. The composition layer deterministically preserves questions for a
missing concrete target, authority/credential decision, or irreversible
choice. For reversible research, explanation, comparison, and example-code
tasks, it rejects redundant preference questions when the chronological
session already answers them, delegates the choice, or supplies a broad
request such as `full`. The rejection is committed as
`workflow.clarification_rejected`, compiled into the next bounded model pass,
and never grants new authority. Two consecutive rejected clarification
proposals stop the run instead of creating an invisible retry loop.

Risk-based approval begins at risk 4 for `workspace`, risk 3 for `web`,
`research`, `process`, `network`, and `media`, risk 2 for `partner`, and is
unreachable for the read-only `inspect` profile. A gated run
stays paused on its open event stream for up to five minutes. Approval resumes
only the exact proposal ID; rejection leaves it unexecuted.

Every media-provider invocation requires proposal-scoped approval regardless
of the model-declared risk because it can disclose local media or text, consume
provider quota, or create a workspace artifact.

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
The synthesis request also receives the bounded chronological operator context
for resolving pronouns and preferences such as language, format, breadth, and
detail. That context is explicitly data rather than evidence: it can shape the
answer but cannot support factual claims or override the current objective.

`workflow.receipt` is displayed as `receipt.commit`; it is distinct from
`memory.commit`. Durable memory accepts only terminal observations from actions
whose capability verifier passed. It does not store private reasoning, failed
intermediate proposals, or unverified answer prose. Memory retrieval is scoped
to the current session; it cannot bleed into another session agent. Typed
records are ranked by lexical relevance, explicit salience, durable kind, and
recency without a memory-preprocessing model call. The recent
session transcript is compiled as one chronological, bounded, high-priority
data source, while exact duplicate dynamic sources are still collapsed.
Conversation and memory are fed back to the model as data/evidence rather than directives. The operator
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

Each session can persist a reusable agent configuration: provider/model,
routing mode, fallback chain, authority profile, and optional standing
constraints. Enabling the session as a reusable agent allows new schedules to
link to that session ID. Linked runs reuse only that session's bounded recent
transcript and verified memory; they do not read another session's memory or
gain authority beyond the saved profile.

The service adapts canonical events to the existing UI vocabulary for display.
Each projected event includes a short human title and a causal detail sentence
that explains what happened, why it matters, and whether execution occurred.
Policy admission, tool execution, state observation, action verification, and
completion verification remain distinct presentation states. The canonical
event type and raw payload stay available in the inspector. The JSONL ledger
remains the durable truth; UI titles and details are projections. A client
disconnect cannot roll back or invalidate an already persisted canonical event.

Model routing does not weaken policy. `fallback` keeps route A first and tries
later routes only after transport or proposal failure. `ping_pong` schedules
`A -> B -> A`, `ring` schedules `A -> B -> C -> A`, and `ring_pair` schedules
`A -> B -> C -> D -> A` across model passes. Legacy `round_robin` cycles any
two-to-four configured routes. Each scheduled pair is merely preferred for
that pass: after failure, the remaining routes are tried in cycle order.
Proposal and grounded-response calls share one monotonically increasing pass
counter, so the schedule describes every model invocation in the run.
`model.route_selected` and `model.route_failed` make both choices canonical and
inspectable. Repeated failures open a bounded pass cooldown, recorded as
`model.route_health_changed`, instead of spending a call on every pass. Each
returned proposal still crosses the canonical
parser, policy, capability, observation, and completion boundaries. If every
model route fails after all required evidence has already been verified, the
workflow may complete deterministically from those canonical observation IDs;
it cannot invent missing work.

## Runtime Lab API

`GET /api/lab/catalog` returns server-defined agent variants, module labels,
showcase scenarios, and sanitized summaries of generated deterministic
benchmarks. `POST /api/lab/experiments` runs two or three variants through the
ordinary `/api/runtime/run` path in isolated sessions. `POST /api/lab/compare`
analyzes two to four persisted run IDs.

The analyzer derives scores and findings from canonical events: policy
decisions, capability reports, observations, verification, recovery,
reconciliation, routing failures, context audits, tokens, retries, and terminal
evidence. Declared modules are kept separate from mechanisms actually exercised
by a run. Comparison responses report objective similarity and provider, model,
and profile confounds. They are runtime diagnostics, not claims of general
intelligence or semantic truth.

## Current limits

Steps inside a run are sequential; there is no global multi-run concurrency
admission controller. Completed sessions, messages, run indexes, verified
memory, tools, and schedules survive restart, but in-flight workflow and
approval continuation do not. The media adapters support bounded workspace
files and one-time ElevenLabs session bootstrap; browser microphone capture,
audio playback, and a server-side Deepgram WebSocket proxy are not yet exposed
as a continuous streaming UI loop. Multi-user authentication and distributed
scheduling remain unimplemented. The HTTP service is a local alpha composition
surface, not a production security boundary.
