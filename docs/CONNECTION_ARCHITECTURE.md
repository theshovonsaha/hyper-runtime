# Task-Scoped Connection Architecture

## Purpose

Hyper-Runtime should feel like a useful assistant before it exposes its
governance machinery. A request does not become more capable when every
provider, tool, memory index, file store, graph projection, and workflow stage
is connected to every model call. It becomes harder for the model to identify
the actual task.

This document defines the model-facing connection boundary. It does not change
the authority boundary in `docs/ARCHITECTURE.md`: model output remains a
proposal, policy remains deterministic, and completion still requires observed
state.

## Reference comparison: Deep Agents

The local `deepagents-main/` example and the upstream Deep Agents documentation
show a deliberately small core:

```text
messages + model + currently available tool schemas
  -> assistant response or tool call
  -> tool result
  -> next model call
```

Filesystem access, planning, summarization, memory, skills, subagents, prompt
caching, and human approval are middleware. They are added when a task or
backend needs them. The implementation also avoids repeating long tool usage
instructions when the schemas already express them. Summarization and tool
result offloading activate under context pressure instead of being mandatory
preprocessing.

Hyper's useful differentiator is the boundary around that loop:

```text
assistant tool call
  -> canonical action proposal adapter
  -> deterministic authorization
  -> bounded effect
  -> independent observation
  -> verified tool result
  -> assistant response
```

Hyper should preserve that boundary without requiring a model to understand a
large runtime ontology before it can answer a question or choose one tool.

Upstream references:

- <https://github.com/langchain-ai/deepagents>
- <https://docs.langchain.com/oss/python/deepagents/overview>
- <https://docs.langchain.com/oss/python/deepagents/context-engineering>
- <https://docs.langchain.com/oss/python/deepagents/subagents>

## Connection decision table

| Connection | Activate when | Do not activate merely because |
|---|---|---|
| Normal response | no external observation or side effect is needed | the profile has tools |
| Recent messages | ordinary chat, or the request refers to prior turns | a session exists |
| Task tool schemas | the task clearly needs that exact external capability | the tool is authorized or configured |
| Session semantic search | the operator explicitly asks to recall older session knowledge | memory has records |
| Verified outcome memory | prior verified outcomes are relevant to explicit recall | the run is multi-step |
| Uploaded-file retrieval | a file is linked or the operator refers to an upload | the session contains files |
| Compaction/offload | the retained messages or tool results approach the model budget | every pass starts |
| Approval | the selected proposal crosses the configured risk threshold | a different model route is used |
| Observation/verification | a tool effect was attempted or completion depends on external state | a normal conversational answer was generated |
| Subagent | work is independently scoped, multi-step, and benefits from context quarantine | the request is complex-looking or long |
| Filesystem/process sandbox | the operator asks to inspect, change, build, or test a workspace | the operator asks for code in chat |
| Graph projection | the UI requests explanation, replay, or inspection | the model is choosing its next step |
| Voice/media | the input or requested output is media | a provider adapter is configured |

Reachability and authority remain separate. The connection plan narrows what is
shown to a model; the intent contract and policy still decide what may run.

## Current implementation

The HTTP composition surface now creates a `TaskConnectionPlan` before context
preparation. Its connections are independent:

- ordinary and reasoned chat use the response lane with bounded recent turns;
- only task-matched capability manifests enter proposal calls;
- history, verified memory, semantic session search, and uploaded-file RAG are
  each opt-in from the request;
- healthy knowledge-system status prose is omitted from model context;
- the objective is carried once by the context packet instead of duplicated as
  a dynamic source;
- conversational words such as "write Python snippets" and "run a reasoning
  task" no longer imply file mutation or shell execution.
- explicit deliverable language such as "create an app", "build a tracker",
  or "code it in one HTML file" selects the coding lane and its bounded
  repository/write/patch/process schemas instead of returning an untested code
  block through ordinary chat;
- terminal outcomes distinguish a conversational `answered` result from a
  verified outcome, an observed generated artifact, and an artifact with a
  passing process check.

OpenAI-compatible and Anthropic transports now receive provider-native tool
schemas. The model chooses one tool, target, and argument object. A deterministic
adapter adds the intent and principal identities, current conditions, required
effects, risk classification, evidence obligations, strategy, proposal ID, and
idempotency key before ordinary canonical validation. Tool-schema bytes are
included in request-budget and stable-prefix accounting. Scripted fixtures and
transports without native tools retain the canonical JSON proposal protocol.

## Native continuity boundary

The workflow now preserves provider-neutral user, assistant, tool-call, and
verified tool-result messages. OpenAI-compatible transports map them to
assistant/tool roles; Anthropic maps them to adjacent `tool_use`/`tool_result`
blocks. DeepSeek and Anthropic continuation payloads needed during an active
tool turn remain in memory only: hidden provider reasoning is not canonical
evidence, durable memory, or an operator-facing projection.

Complete observations remain canonical. The model receives a bounded result
projection with evidence references and an omitted-content reference when raw
data is larger. Exact file reads carry path, snapshot and slice digests, line
and byte boundaries, and the exposed text. Context-pressure compaction treats
an assistant call and its tool results as one indivisible unit.

One model response may schedule up to four tool calls. They cross policy,
execution, observation, and verification independently and are currently
committed sequentially without another planning inference. True parallel read
scheduling remains withheld until cancellation can drain all started effects
and results can be committed in original model order.

## Ordered delivery gates

### P0 — first useful loop

- Implemented: native OpenAI-compatible and Anthropic tool envelopes.
- Implemented: deterministic canonical enrichment outside the model.
- Implemented: one-call chat and one-action deterministic completion for a
  single verified read-only capability.
- Implemented: provider-reported usage plus prompt, schema, cache, reasoning,
  latency, and call-count projections.
- Implemented: durable native tool-call/result message pairs and bounded
  sequential multi-call scheduling.
- Implemented: deterministic coding lane with repository search, exact file
  slices, inspected-snapshot patching, bounded process checks, and diagnostic
  continuation after an observed non-zero exit.
- Remaining: parallel read-only execution after cancellation/order stress gates.

### P1 — context pressure

- Replace character estimates with provider token counters where available and
  label estimates where unavailable.
- Trigger summarization from measured budget pressure.
- Offload large tool results while preserving a retrievable canonical copy.
- Add long-session reconstruction and reference-resolution evals.

### P2 — specialist execution

- Add subagents only through the existing delegation boundary.
- Give each child a narrow task, tool set, context subset, and budget.
- Evaluate context isolation and final synthesis quality against the same task
  without delegation.

### P3 — product projections

- Keep graph, memory, artifact, voice, and benchmark views as projections over
  the working loop.
- Never inject UI projection terminology into a model prompt unless the user is
  explicitly asking to inspect the runtime itself.

## Acceptance scenarios

The connection layer is ready when all of these hold across configured
providers:

1. "Explain context windows" produces one response call and zero tool calls.
2. "Write commented Python snippets" responds in chat and does not write files.
3. "Search the web and cite recent sources" exposes only web search, then
   answers from its observed result.
4. "Continue that explanation" receives the bounded relevant transcript.
5. "Use the uploaded report" activates only the linked session retrieval path.
6. "Edit this repository and run tests" exposes the minimum filesystem and
   process tools, searches before broad reads, patches against an inspected
   digest, feeds a failing check into diagnosis, reruns it, and verifies
   completion from both edit and process evidence.
7. A stopped run closes transport, tool, and ledger state without emitting a
   success claim.
8. An unavailable provider falls back without changing task context or
   authority.
9. "Create a tracker and code it in one HTML file" cannot finish through the
   no-tool conversational lane.
