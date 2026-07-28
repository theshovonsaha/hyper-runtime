---
name: convergence-audit
description: Audits whether a codebase's advertised subsystems, "engines," or protocols are actually wired into the live execution path, versus orphaned, duplicated, or wired-but-functionally-inert (called, but with dummy inputs or a discarded result). Produces evidence-based WIRED/ORPHANED/DUPLICATE/STUB tables backed by file:line citations and required tests — never a narrative summary. Use whenever a user asks if a system is "fully connected end-to-end," wants a convergence/integration/dead-code audit, is reviewing a claim (from a dev agent, status update, changelog, or teammate) that something is "wired," "production-grade," or "ready to deploy," suspects duplicate implementations, or pastes an AI coding agent's summary and wants to know if it should be trusted. Also trigger for suspiciously large runtime artifacts (giant logs, ballooning data files) — a common downstream symptom of the same fake-integration patterns.
---

# Convergence Audit

This skill is for one specific, recurring failure mode: a codebase (or a report about a codebase) describes more integration than actually exists. Impressive class names, confident status updates, and docstrings that read like a changelog are not evidence. The only things that count as evidence are: a traced import path from the real entrypoint, a file:line citation that matches the actual file when you check it, and a test that asserts something specific.

This failure mode gets worse, not better, with AI-assisted development, because an LLM asked "is everything connected?" will generate a fluent, specific-sounding "yes" whether or not it actually checked. Your job using this skill is to be the check.

## Rule Zero: no claim without evidence

Before reporting any component as done, working, or connected, you need one of:

| Claim | Required evidence |
|---|---|
| "X is wired into the runtime" | A traced import chain from the real entrypoint to X, with file:line at every hop |
| "X works correctly" | A test exercising X with real (or mocked-but-realistic) inputs, asserting a specific output — not "it ran without throwing" |
| "X is fixed" | A test that failed before the fix and passes after |
| "X handles edge case Y" | A named test for Y, not a comment claiming it's handled |

If you can't produce the evidence column, the honest status is **unverified** or **not built** — not "done." Don't round up. Reasoning about what code "should" do, or how confident a docstring sounds, is not a substitute for reading the code or running it.

## The audit process

### Phase 0 — Build the real import graph, don't reason about it from memory

Read a handful of files and forming an impression of what's connected is exactly how this failure mode reproduces itself. Trace it mechanically instead.

- If you have full filesystem access to the real repo: use `scripts/audit_imports_repo.py`, which walks the actual directory tree and resolves relative imports properly (handles `../`, `index.ts` resolution, etc.).
- If you only have a flat pile of uploaded/pasted files (common when a user shares files one batch at a time across a conversation): use `scripts/audit_imports_flat.py`, which matches on basename instead of resolving paths. Less precise, but works with partial information — re-run it every time new files arrive, since your picture of what's orphaned should update as you see more of the codebase, not stay fixed from an earlier partial view.

Both scripts produce the same two outputs: a full edge list, and a list of files with zero incoming edges (candidates for orphaned/dead code). Treat every file in that second list as **ORPHANED** until proven otherwise — don't take a docstring's word that it's used somewhere you haven't seen.

### Phase 1 — Classify every component

For each module in the system (start from what the user is asking about, expand from there), assign exactly one status:

- **WIRED** — reachable from the real entrypoint, with a working call site.
- **ORPHANED** — zero importers anywhere in the real repo. Note: appearing in a barrel/re-export file (an `index.ts` that does `export * from './x'`) does NOT count as wired — a barrel file is a menu, not a wiring diagram. Trace whether anything imports *from the barrel* into the actual live path too.
- **DUPLICATE** — two or more implementations of the same concept exist, and only one (or neither) is actually invoked. This is extremely common in codebases that grew through iterative AI-assisted additions: a hand-rolled version living inline in the live path, and a separately-named "proper" class/module that sounds more official but is never called.
- **STUB / WIRED-BUT-INERT** — the most important category to catch, and the easiest to miss, because it looks like success. A component is called from the live path, so a naive check says "wired" — but it's given empty/dummy inputs, its output is discarded, or it always returns a hardcoded success value regardless of what actually happened. This also includes **Unanchored Meta-Loops** (watchers watching watchers) that emit events but have no connection to ground truth or human judgment. This is *worse* than orphaned, because it produces a log entry, an event, or a status line that looks like proof of real work when none happened. See `references/red_flags.md` for the specific patterns to check for — magic constants dressed as measured metrics, unconditional success stubs, empty-array arguments, unanchored loops, computed-then-discarded results, and more.

### Phase 2 — Verify every citation yourself, don't accept one

Whether the claim comes from a docstring, a status report, or another AI agent's summary: any time you're handed a specific file:line citation or a method signature, check it against the actual file before repeating it. A remarkable amount of fabrication in this space comes wrapped in confident, specific-looking citations — a method name that sounds plausible, a line number that sounds precise — that don't survive an actual `grep`. Do the grep. If the cited method/line doesn't exist as claimed, say so plainly and don't round the discrepancy down to a rephrasing issue.

When you're checking someone else's (human or agent's) integration claim specifically, prefer commands that produce raw, hard-to-fake output over requests for narration:
- `grep -n "methodName" path/to/file.ts` — either it's there or it isn't.
- `sed -n '390,410p' path/to/file.ts` — shows the actual code, not a description of it.
- Running the actual test suite and reading raw pass/fail output, not a summary of the run.

A written summary of what a grep "would show" is not the grep. If someone reports "here's the file:line evidence" without you having seen the raw command output, that's still a claim, not evidence — verify it.

Also check for **silent omission**: if a status table covers 6 of 10 components someone said they'd address, the 4 missing ones didn't get resolved as fine — they got skipped without saying so. Always compare the report against the full original list of what was supposed to be checked.

### Phase 3 — Decide the fate of every orphan, don't leave it ambiguous

For each ORPHANED or DUPLICATE component, force one of three explicit decisions — "maybe useful later" is how a codebase accumulates dozens of disconnected "engines" in the first place:

1. **Wire it in**, with a test proving the wiring actually does something (not just that it's imported).
2. **Merge** it into whatever already does that job in the live path, and delete the loser.
3. **Delete** it. It can come back from version control if it's ever actually needed.

### Phase 4 — Report using the standard table, every time

```
| Component | Status (WIRED / ORPHANED / DUPLICATE / STUB) | Evidence (file:line) | Test |
```

Every row needs a real citation or "none" in the test column — never leave it implied. If a status is STUB, say specifically what makes it inert (e.g., "called with `items: []`, can never mutate anything" or "returns `success: true` unconditionally, ignoring the actual input").

## A note on downstream symptoms

Sometimes what brings someone to this kind of audit isn't a direct question about wiring — it's a symptom. Runaway log/data file sizes, memory growth over a long-running process, or performance that doesn't match the architecture's claims are often caused by exactly the pattern this skill catches: a "lightweight event/telemetry system" that a docstring says is compact, but that in practice logs full uncompressed payloads on every step, or a duplicate implementation quietly double-logging the same work. When you see a symptom like this, the audit process above (trace real wiring, check for duplicates, verify claims about compression/truncation with an actual grep) is the right tool — go look at what's actually being written on each event/step rather than accepting that it "shouldn't be that big."

## References

- `references/red_flags.md` — the specific fake-implementation patterns to check for, each with a real example and how it was caught. Read this before writing off something as "probably fine" — several of these look completely normal at a glance.
