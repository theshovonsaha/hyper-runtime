# Red flags: patterns that look fine but aren't

Each of these was caught in a real audit, not invented in the abstract. They're grouped by how they present, since that's what makes them easy to miss.

## 1. Wired-but-inert: called with dummy/empty inputs

The call site is real and does execute — but the arguments passed in structurally prevent it from ever doing anything.

```ts
// Looks wired. Is not — items is always [], so nothing can ever be found/mutated.
const result = someEngine.execute({ action, reason: '...' }, []);
```

**How to catch it:** don't just confirm the call exists — read what's actually passed in. Ask "given these exact arguments, what's the range of possible outcomes?" If the answer is "always zero effect, regardless of runtime state," it's a stub wearing a wired component's clothes.

## 2. Wired-but-inert: fires unconditionally with hardcoded parameters

```ts
// Fires on every single run, same hardcoded capability name every time,
// completely ignoring what the run actually produced.
const tool = engine.synthesizeTool({
  requestedCapability: 'dynamic_analysis',
  functionName: 'auto_analysis',
  description: 'Automated analysis',
});
log.emit('engine.report', tool, { summary: 'engine proposed optimizations' });
```

**How to catch it:** check whether the inputs to the call vary based on anything about the actual run. If the same literal arguments fire every time regardless of context, the "integration" isn't reacting to anything — it's a fixed event with a plausible-sounding label.

## 3. Computed-then-discarded results

The riskiest variant, because real work does happen — it's just thrown away, which can hide something worse (see #7).

```ts
const preRes = deterministicEngine.preResolveTurn(prompt); // does real work, e.g. runs eval() on user input
const summary = `[PRE-RESOLVED] Trajectory pre-computed for tool [${preRes.toolToExecute}].`;
// preRes.deterministicOutput (the actual computed result) is never read again.
// preRes.toolToExecute / toolArgs are never used to actually skip a call or act on anything.
context.push({ text: summary }); // only the label survives
```

**How to catch it:** trace every field of a function's return value, not just whether the function got called. If half the return object is dead on arrival, the "optimization" it represents isn't happening — only its marketing text is.

## 4. Fabricated percentage/throughput claims

```ts
/**
 * Slashes token costs by 80% and quadruples throughput!
 */
return { savedTokens: 450, remainingLlmDutyPercent: 20 }; // constants, not measurements
```

**How to catch it:** ask "where does this number come from — a measurement taken this run, or a literal written into the code?" If two different inputs to the function would produce the exact same number, it's not measuring anything.

## 5. Magic constants dressed as principled formulas

```ts
const biasCount = biasWordsMatch.length || 1; // the `|| 1` is doing real work, undocumented
const ratio = factsCount / biasCount;
const verified = ratio >= 2.0; // why 2.0? nobody says
```

**How to catch it:** any bare numeric literal in a scoring/threshold calculation should have a stated justification nearby. If it doesn't, the "objective score" is an opinion with a decimal point.

## 6. Unconditional success stubs

```ts
execute: async () => ({
  success: true,
  content: `Processed capability on payload: "${payload}"`, // canned string, ignores input
})
```

or, worse, a "super tool" that claims to wrap real primitives but hardcodes its output:

```ts
// Docstring: "Wraps list_files, read_file, and run_shell..."
const files = ['package.json', 'tsconfig.json', 'README.md', 'src/index.ts']; // never actually reads the filesystem
return { success: true, content: `Inspected ${files.length} key workspace files successfully.` };
```

**How to catch it:** feed it (mentally or literally) two different inputs that should produce different outputs. If the output is identical regardless of input, it's not doing the thing its name/docstring claims.

## 7. Security-adjacent code hiding inside a "harmless optimization"

```ts
const mathMatch = trimmed.match(/^calculate\s+([\d\s\+\-\*\/\(\)\.]+)/i);
if (mathMatch) {
  const result = eval(mathMatch[1]); // eval() on a slice of raw user input
  ...
}
```

**How to catch it:** `eval`/`exec`/dynamic code execution on any value derived from user input is worth flagging regardless of how constrained the surrounding regex looks, and regardless of how minor the surrounding feature seems ("it's just a calculator pre-resolver"). Combine this with #3 — if the eval'd result is then discarded (see the eighty-twenty example above), you have a real vulnerability-shaped code path running for zero benefit, which is the worst version of this pattern: risk with no offsetting value.

## 8. Emitter/consumer schema mismatches

```ts
// emits:
log.emit('tool.call', { name, args }); // never carries `success`
// consumes, elsewhere, expecting a field that never arrives:
if (event.type === 'tool.call' && event.payload?.success === false) failures++; // always false
```

**How to catch it:** when a system has both a place that emits structured events/telemetry and a place that reads them back for stats, check the two against each other directly — the emitting code's actual payload shape vs. the field paths the reader expects. Aggregates (costs, failure rates, totals) built on a schema mismatch don't error, they just silently report zero or wrong forever, which is exactly why they get missed.

## 9. Duplicate implementations, only one of which runs

Common in codebases grown by iterative AI-assisted additions: a hand-rolled version living inline in the code that actually executes, and a separately-named, more official-sounding module implementing the same concept that's never called.

**How to catch it:** when you find a class/module with a impressive name (a "Protocol," an "Engine," a "Coordinator"), search for whether the *behavior* it claims to provide already exists somewhere else, implemented more plainly, in the actual live path. If so, you likely have two implementations competing for one job, and the plain one is usually the one that's actually running.

## 10. "Distributed"/"vector"/infrastructure-sounding classes that are pure in-process state

```ts
class DistributedStateAdapter {
  private distributedLocks: Set<string> = new Set(); // in-memory, per-process — not distributed at all
  async acquireLock(id: string) {
    if (this.distributedLocks.has(id)) return false;
    this.distributedLocks.add(id);
    ...
  }
}
```

**How to catch it:** for any class whose name promises a specific real technology or algorithm (distributed locking, HNSW vector search, a particular consensus protocol), check whether the implementation actually talks to the external system implied (Redis, a real ANN index, etc.) or is a local in-memory data structure standing in for it. This is dangerous specifically because it can pass every single-process test while providing zero actual guarantee once deployed across multiple instances — the exact scenario its name claims to solve.

## 11. Runaway or unbounded event/log payloads (the "why is this 600MB" symptom)

```ts
persistEvent(runId: string, event: TrailEvent): void {
  appendFileSync(path, JSON.stringify(event) + '\n'); // no size check, no truncation, ever
}
```

**How to catch it:** if a system reports abnormally large runtime artifacts for a single run, don't assume it's "just a lot of legitimate work" — check every call site that emits an event/log line for whether it passes full raw content (a whole tool result, a whole transcript, a whole context packet) into the payload versus a bounded excerpt. Also check for: (a) synchronous blocking I/O on every single event in a hot loop, which is a throughput problem even before size is; (b) any in-memory registry/map of active runs/logs that's never evicted when a run finishes, which leaks memory independent of the file-size issue. Ask for the actual per-event-type byte breakdown (e.g. group a real log file by event `type` and sum payload sizes) rather than guessing which subsystem is responsible.

## 12. Unanchored meta-loop (watchers watching watchers)

A system that adds layers of "evaluation," "context steering," or "self-evolution" that only ever look at their own generated events or hardcoded metrics, with zero connection to ground truth.

```ts
// Looks like a sophisticated feedback loop
const selfEvolving = new SelfEvolvingCodeEngine();
const evalResult = await selfEvolving.assessAndEvolve(provider, finalText, registry);
if (evalResult) {
  log.emit('self_evolving.report', evalResult);
}
```

**How to catch it:** Check what the loop is measuring itself against. A real improvement loop requires an anchor: a number nobody can argue with (like actual token cost or latency), a rule the optimizer can't touch (a held-out evaluation set), or a human call on what "better" means (like a UI gate operator). If a loop is just emitting events based on its own internal logic and adjusting itself based on those same events, it's a hall of mirrors — consistent, active, but touching nothing real. More layers of "watchers" don't fix an unanchored loop, they just obscure it.
