# Patch notes

All 20 files are here as drop-in replacements (same filenames/paths, same exports).
10 were changed; 10 are copied through unmodified. Each changed file has inline
comments at the exact edit marked `FIXED:` or `CHANGED:` so the diff is visible
in place, not just in this doc.

I couldn't compile against your real project (providers/base.ts, tools/registry.ts,
context/assembler.ts, verifier.ts, scorecard.ts, dlrs/kernel.ts, etc. weren't
uploaded), so everything below is verified by parsing, not full type-checking.
Run `tsc --noEmit` against your real tree before merging.

---

## Changed, in priority order

### 1. `kernel.ts` — live path, highest impact
- **Fixed `runSubAgent` returning `''` always.** It read `res.text`, but
  `RunResult` only has `final_text`. Every sub-agent call silently returned
  empty regardless of what the sub-run produced. Also fixed the call site —
  `run()` takes one argument, not two (`subEnv, sessionId`); `session_id` is
  now folded into `subEnv` instead.
- **Fixed the scorecard being graded on fake data.** `evaluateScorecard(...)`
  was called with `toolCalls: []` hardcoded, so any scoring dimension tied to
  tool usage/success was always zero no matter what actually happened. Now
  passes `state.toolCallLog`, a real record populated in `loop.ts` (see below).
- **Removed the dead `runDLRS` import.** It was imported and never called —
  a second, complete, unused turn-execution engine with an incompatible event
  vocabulary (`tool.called`/`tool.completed` vs. this file's `tool.call`/
  `tool.result`). Left a comment explaining the two options: delete
  `dlrs/kernel.ts`, or make the choice of engine an explicit config flag.
  **This needs a decision from you** — I didn't delete the other file since
  it wasn't part of this upload and I don't know if anything else depends on it.
- **Wired in `active_mapping.ts`'s per-phase model routing**, which existed
  but was never called anywhere — every phase (plan, tool loop, verify) used
  one flat `provider` regardless of what the phase-to-model map recommended.
  Added `resolvePhaseProvider()`, gated behind a new `config.activeModelMapping`
  flag (**default off** — the map hardcodes specific provider/model strings
  that may not be configured in your deployment) and falls back safely to the
  default provider with a logged event on any error. Wired at the `plan` and
  `verify` call sites.
- **Wired `withRunContext` from the patched `error-interceptor.ts`** around
  the run body, so captured global errors get correlated to the right run
  (see that file's notes).
- **New config field required:** `RuntimeConfig` needs an `activeModelMapping: boolean`
  field for this to compile — add it to `types/config.ts` (not uploaded, so I
  couldn't edit it directly).

### 2. `loop.ts` — live path
- **Added `toolCallLog` to `LoopState`** (`{name, success, cached}[]`),
  populated at all three tool-result sites (cache hit, success, failure).
  This is what makes the `kernel.ts` scorecard fix possible — nothing
  previously captured structured call outcomes anywhere.
- **Fixed the dedup/cache key** (`sig = ...JSON.stringify(call.args)`) being
  argument-order-dependent. Two calls with identical args in different key
  order used to miss the cache and get treated as distinct signatures for
  failure tracking. Added a `sortedArgs()` helper and used it in the sig.
- **Separated "global" vs. "per-tool" circuit breaker semantics in the log.**
  Both used to emit the same `tool.circuit_breaker` event name for two
  different mechanisms (temporary loop-wide nudge vs. permanent per-tool
  disablement for the rest of the run) — now tagged with `scope: 'global' | 'per_tool'`
  and distinct summaries, so the trail is actually legible after the fact.
- **Changed `fails === config.maxConsecutiveToolFails` to `fails >= ...`**
  in both places it appeared (strict equality was a footgun for any future
  change to the increment logic).
- **Fixed `recoverMissingArgs`'s JSON extraction.** It used a raw greedy
  `/\{[\s\S]*\}/` match from the first `{` to the *last* `}` in the whole
  response, which breaks if the model wraps the JSON in a fenced code block
  or adds any trailing text containing braces. Now strips fences first, same
  pattern used elsewhere in this codebase (`delta.ts`, `planner.ts`).

### 3. `projections.ts`
- **Fixed token/cost tallying being permanently zero.** It read
  `ev.payload?.input_tokens` / `output_tokens` flat, but `loop.ts` actually
  emits `usage` nested (`payload.usage.input_tokens`). Given the real event
  shape, `tokensUsed` — and therefore `estimatedCostUsd` — could never be
  anything but 0.
- **Fixed `totalToolFailures` always being 0.** It checked `success === false`
  on `tool.call` events, but `tool.call` never carries a `success` field
  (only `tool.result` does; `tool.call` only carries `error` for the
  missing-args-failure path). Now checks the right event/field for each path.
- **Fixed `totalModelTurns` double-counting.** `ev.type.startsWith('model.')`
  matched both `model.request` and `model.response` per step. Now counts
  `model.response` only.
- Left the flat $0.15/M-token rate in place but commented it as a rough
  order-of-magnitude placeholder, not per-model pricing — there's no pricing
  table anywhere in this upload to draw real per-model rates from.

### 4. `heal.ts`
- **Stopped claiming `healed: true` with nothing to show for it.** The
  JSON/argument-error branch used to unconditionally report success without
  ever populating the declared `repairedArgs` field. Now takes an optional
  `rawArgs: string`, attempts a small set of mechanical JSON repairs
  (trailing commas, single→double quotes), and only reports `healed: true`
  when the repair actually produces something that parses. Otherwise it's
  honest that detection fired but nothing was fixed.

### 5. `understanding.ts`
- **`confidenceScore` was a hardcoded `0.95` regardless of input** — now
  derived from how many recognizable signals actually matched, capped at 0.9
  so it can't imply false certainty from a heuristic.
- **`missingRequirements` was declared but never populated** — added three
  concrete checks (ticker-trigger-words without a resolved ticker, code-intent
  without a resolved path, multi-agent request that's suspiciously short).

### 6. `bias_less_reasoning.ts`
- **`generateCounterfactuals` did no synthesis at all** — it spliced the
  conclusion into three fixed template strings. Now takes an optional
  `Provider` and, if given, makes a real model call for genuinely different
  hypotheses; falls back to the old templates without one. Return value now
  carries `mode: 'synthesized' | 'templated'` so callers can't mistake one
  for the other.
  **API change:** `evaluateEpistemicReasoning` and `generateCounterfactuals`
  are now `async` (they weren't before) — update call sites.
- Named the `MIN_BIAS_COUNT = 1` smoothing constant that was previously an
  unexplained `|| 1` in a ternary, and documented that the GBR is a lexical
  heuristic over a caller-supplied fact count, not a verified epistemic audit.

### 7. `self_evolving.ts` — biggest gap between claim and behavior
- **The docstring claimed dynamic compilation and hot-reloading; the code
  did neither** — `execute()` always returned `success: true` with a canned
  string regardless of the requested capability. Wired into a live loop,
  this is an agent believing it closed a capability gap when it did nothing.
- Now: a synthesized tool without a real `implementation` function returns
  `success: false` and a labeled "unimplemented stub" message — it can't
  fabricate success anymore. `hotReloadSynthesizedTool` now **throws** if
  called without a real implementation, refusing to register a stub into a
  live tool registry where an agent could mistake it for working.
  **This narrows behavior** — anything currently relying on the stub
  auto-succeeding will need to pass a real `implementation`, which is the point.

### 8. `error-interceptor.ts`
- **Replaced the single global mutable `lastCapturedError` slot** (which let
  concurrent runs clobber each other's captured error) with an
  `AsyncLocalStorage`-based per-run map. Added `withRunContext(runId, fn)`,
  wired into `kernel.ts`'s `run()`. Calls that don't use `withRunContext`
  still work unchanged, falling into a shared bucket — this is additive.

### 9. `ascii_transform.ts`
- Renamed the framing from "AST Transformation Engine" to what it actually
  is — a regex-based rename utility. There's no parser here; a real AST
  transform needs one per target language, which is out of scope for a
  drop-in patch.
- **Fixed unescaped regex metacharacters in variable names** — a rename key
  like `$foo` or `a.b` used to build a broken or misbehaving `RegExp`.
  Documented (not silently pretended away) that it still can't tell an
  identifier from the same text inside a string/comment.

---

## Not changed — here for completeness, decision needed from you

- **`../kernel/dlrs/kernel.ts` (the `runDLRS` file from earlier in this
  conversation)** — not part of this upload, not touched. Still dead code as
  far as `kernel.ts` is concerned. Delete it or explicitly branch on it.
- **`fifty_fifty.ts`** — imports `./eighty_twenty`, which was never uploaded,
  so I can't verify it exists or safely edit around it. The "doubles
  throughput to >400 turns/sec" claim is still a static label, not a
  measurement — flagging again since I didn't touch this file.
- **`active_mapping.ts`, `branch.ts`, `seed_engine.ts`, `awareness.ts`,
  `attribution.ts`, `capabilities.ts`, `delta.ts`, `packet.ts`, `planner.ts`,
  `reassembler.ts`** — copied through unmodified. These were already
  reasonable, bug-free code as written (`active_mapping.ts` is now actually
  wired in via `kernel.ts`, see above); the rest remain unwired but don't
  need repair, just an integration decision.

## Things you still need to supply for this to compile
`types/config.ts` needs `activeModelMapping: boolean` added to `RuntimeConfig`.
Everything else (`providers/base.ts`, `tools/registry.ts`, `context/assembler.ts`,
`context/gate.ts`, `verifier.ts`, `scorecard.ts`, `store/*.ts`, `types/*.ts`)
wasn't part of this upload — I worked strictly from the shapes visible in the
files you gave me, so double-check the `evaluateScorecard`/`ToolResult`/
`Provider` signatures against your real versions before merging.
