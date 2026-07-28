---
name: research-convergence
description: Verifies research claims, citations, and academic-sounding justifications before trusting or building on them — checking that cited papers actually exist with the claimed authors/findings, that a paper's own novel contribution is validated (not just well-cited), and that an implementation plan citing "the paper" is actually faithful to what it specifies rather than a paraphrase. Use whenever someone justifies a design decision, feature, or architecture with "a paper," "recent research," "the literature shows," "according to arXiv:X," or a preprint/whitepaper — including the user's own or a dev agent's writing. Also use before presenting new work as "novel" (search for prior art first) and when reviewing any preprint, whitepaper, or research-grounded implementation plan for what's actually established versus hypothesized.
---

# Research Convergence

New creation should converge with old knowledge, not float free of it — but "cites a paper" and "the paper's claim is true" and "the plan faithfully implements the paper" are three separate things that all need independent verification. This skill is for checking all three, because a confident, well-formatted citation is exactly as capable of being wrong as a confident, well-formatted status report about code — and for the same reason: fluent, specific-sounding text is not evidence.

## Core principle: citation-real, contribution-validated, and implementation-faithful are three different checks

1. **Citation-real**: does the cited work actually exist, with the claimed authors, venue, arXiv ID, and findings?
2. **Contribution-validated**: does the citing document's *own* new claim actually have evidence behind it, or is it dressed in real citations while remaining an untested hypothesis?
3. **Implementation-faithful**: if a plan says "as Section X specifies," does the plan's proposed mechanism actually match what that section says — or a rounder, more convenient paraphrase of it?

A document can pass check 1 with flying colors — every citation real, every author correct, every quoted figure accurate — while failing check 2 (its own contribution is unvalidated) or check 3 (an implementation plan built on top of it quietly deviates from what it specifies). Passing one check tells you nothing about the others. Run all three.

## Step 1 — Verify each citation actually exists

For every specific citation (a paper, an arXiv ID, a named framework with a claimed source):

- Search for the exact title plus the first author's name plus one distinctive phrase from the claimed abstract or finding. Vague searches ("agent reliability paper") return noise; specific ones resolve fast.
- Confirm the **author list matches**, the **arXiv ID or venue matches**, and any **specific figures quoted** (percentages, counts, metric names) match the real source — not just the general topic. A fabricated citation often gets the vibe right (plausible authors, plausible topic) but the specific number wrong, or invents an arXiv-ID-shaped string that doesn't resolve to anything.
- Cross-check across at least two independent sources when possible (e.g., the arXiv abstract page itself, plus another paper's reference list citing the same work) — a single search snippet can be truncated or from a low-quality mirror.
- Watch for the "adjacent real paper" trick: a real author name attached to a title they didn't write, or a real-looking arXiv ID with the digits altered.
- Self-published/solo-researcher preprints are not inherently suspicious. arXiv and similar venues allow self-submission without peer review, and a large amount of real, useful, citable work — including entire frameworks with working open-source implementations — is published exactly this way. The question is never "did a big lab publish this," it's whether Step 1 and Step 2 hold up, and that standard is the same regardless of who wrote it.

## Step 2 — Separate "grounded in real prior work" from "the new claim is validated"

A rigorous, accurate literature review is table stakes for credibility — it is not evidence for the document's own new contribution. Check specifically:

- Does the document have a limitations/future-work section, and what does it actually say about validation status? Authors who write "this is a proposed architecture; the experiment to validate it has not yet been run" are being honest, and that honesty needs to carry forward into how the claim gets used — as a hypothesis worth testing, not a proven upgrade.
- If there's no explicit limitations section, ask directly: is there a controlled comparison, an ablation, a measured result behind the headline claim — or is the claim resting entirely on "this addresses gaps that other cited work has identified"? Identifying a real gap is not the same as closing it.
- The failure mode to watch for: citing real work generously while never stating the new contribution's own validation status. Generous, accurate citation can function (whether or not it's intended to) as borrowed credibility for an unstated, unvalidated leap.

## Step 3 — Check whether an implementation or plan is actually faithful to what's cited

This is the step people skip most, and where the highest-value, most specific catches happen. When a plan says "as the paper specifies" or "Section X recommends Y" — go read the actual section. Don't accept the paraphrase.

Specifically check:
- **Mechanism fidelity**: does the source describe a deterministic rule, a lookup, a fixed procedure — while the implementation plan proposes something fancier (e.g., an LLM call) because it sounds more sophisticated? Plans routinely upgrade a source's simple, worked-example mechanism into something more expensive without justification. Read the source's actual worked examples (if/then cases, specific inputs and outputs) — they usually reveal the intended mechanism more precisely than the prose summary above them.
- **Skipped preconditions**: clean rules in a source paper are often clean *because* they assume some other well-defined structure already exists (a scored evidence set, a fact graph, a specific extraction step). Check whether the implementation plan has that structure for real, or is approximating it from something unrelated already lying around in the codebase. A rule computed against an approximate/wrong-shape input isn't implementing the source's semantics — it's implementing something else that happens to share a variable name.
- **Cherry-picked generalization**: is a worked example from the source being generalized correctly to the general case, or is the general case actually messier than the one example the plan quotes?

## Step 4 — Before calling something "novel," search for prior art

Before implementing or presenting a new "protocol," "engine," or "framework" as original, search for whether the same idea already exists — in published work, in a well-known library, or as ordinary established practice under a different name. If it does, either build on it directly (with credit) or be explicit and specific about how the new thing actually differs. This is the direct defense against inventing an impressively-named wrapper around a well-known idea and presenting the wrapper as the innovation — a pattern worth taking seriously precisely because it's so easy to do by accident, not just by intent.

## Reporting format

For any research-grounded claim under review, report all three checks explicitly — don't collapse them into one verdict:

| Citation | Exists? (search evidence) | Details match (authors/figures/venue)? | Author's own validation claim | Implementation faithfulness (if applicable) |
|---|---|---|---|---|

Silence on any column is not a pass — if you didn't check implementation faithfulness, say "not checked," not nothing.

## Reference

- `references/worked_example.md` — a full worked case from a real review: verifying a preprint's citations (all real), then finding the preprint's own honest admission that its core claim is unvalidated, then catching a specific implementation-plan deviation from what the paper's worked examples actually specified. Read this to see the four steps applied end to end, including what the search queries looked like.
