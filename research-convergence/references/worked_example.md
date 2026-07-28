# Worked example: reviewing a preprint used to justify a code change

This is a real case, generalized. A codebase had a stub component (a fake "bias-reduction engine" computing a magic-constant ratio) and a plan arrived proposing to replace it with a "6-property Dynamic Epistemic Posture engine described in the academic preprint" — no title, no link, no author given.

## The instinct, and why it's right

The first move was **not** to evaluate the six properties on their technical merits. It was to say: an uncited "the paper" is a bigger red flag than anything else in the plan, given everything already found in this codebase (several components with impressive names that turned out to be fake or inert). Before discussing whether six epistemic properties made sense, the citation itself needed to exist.

The plan's author then supplied the actual paper. That changed everything — but not by making the plan automatically trustworthy. It made the plan *checkable*.

## Step 1 in practice: verifying citations

The paper had eight external citations. Rather than accepting them, each load-bearing one got an individual, specific search:

```
Rabanser "Towards a science of AI agent reliability" arxiv
Arike Donoway Bartsch Hobbhahn "goal drift" language model agents arxiv 2505.02709
Bhardwaj "AgentAssert" behavioral contracts arxiv 2602.22302
Zhang "Agentic Context Engineering" ACE arxiv 2510.04618
```

Note the pattern: exact title fragment + author surname(s) + (when known) the specific arXiv ID. This is far more effective than a topic-level search ("AI agent reliability papers"), which returns broad noise instead of the one document being checked.

All four resolved to real papers, with author lists, arXiv IDs, and even specific quoted figures (a "+10.6% / +8.6%" result, a "5.2–6.8 violations per session" figure) matching exactly. That's citation-real, confirmed with actual search evidence, not assumed from the paper reading confidently.

One incidental finding worth noting: one of the cited authors turned out to be running the *exact same pattern* as the plan under review — an independent researcher self-publishing an arXiv preprint alongside an open-source implementation of their own framework. This is a real, legitimate, and increasingly common way research gets published. It was not treated as suspicious on its own; the same two checks (does it exist, is the author honest about validation) applied regardless of venue.

## Step 2 in practice: contribution-validated ≠ citation-real

The paper's own Section 9 ("Limitations") said, in the paper's own words: *"No controlled experiment yet reported... The present work is an architecture paper, not an empirical results paper."* That sentence matters more than any of the four verified citations. It means: the literature review is solid, and the new contribution being proposed is an **unvalidated hypothesis by the author's own admission**. Both things are true at once, and neither implies the other.

Practical consequence: the codebase change under review should be framed as *running the experiment the paper itself proposes*, not adopting something proven. That's a legitimate and valuable thing to do — but it changes what "verification plan" needs to mean (see the sibling `convergence-audit` skill's Rule Zero: an event firing is not evidence a component works).

## Step 3 in practice: catching an implementation deviation from the source

The plan proposed computing two of the six properties via a "lightweight LLM call" and asked whether that was the right approach. Rather than answering in the abstract, the actual source section describing those two properties was re-read closely, specifically for its worked examples:

> "When *F* already answers the objective, the minimum probe is zero. When an exact-target URL is identified and `web_fetch` is available, the minimum probe is that fetch, not a broad multi-step search."

That's an if/then rule over already-computed structured state — not a generation task. Four of the paper's six properties turned out to have the same shape: explicit conditional rules, not free-text synthesis. Only one property (a natural-language "falsifier" description) was genuinely generation-shaped. This directly contradicted the plan's proposal to use an LLM call for *two* properties — one of which the source's own examples specify as a deterministic lookup.

This is the highest-value catch in the whole review, and it only came from reading the actual worked examples in the source material instead of trusting the plan's summary of "the paper recommends an LLM call."

A second, related catch: the clean deterministic rules only make sense given two other structures the source paper specifies (a scored evidence set, a fact graph) — both of which did not exist yet in the codebase. The plan proposed approximating them from unrelated existing data. That's not implementing the source's semantics; it's implementing an approximation that happens to reuse the same field names. The recommendation was to build the smaller, self-contained real structure first (the evidence scorer had no dependency on the fact graph) rather than fake both at once.

## Step 4: nothing new was presented as novel here, but the check still applies

Since this particular case involved implementing a paper's proposal rather than inventing a new name from scratch, Step 4 wasn't the main event — but it's exactly the check that would have caught this codebase's earlier "novel protocols" (four differently-named subsystems that turned out to be common patterns — retry/failover logic, budget-based context pruning — already implemented elsewhere in the same codebase under a plainer name). The lesson generalizes: before trusting or building something presented as new, a quick search for "does this already exist under a different name, in this codebase or in the literature" is cheap and catches a very common failure mode.

## The reporting format applied to this case

| Citation | Exists? | Details match? | Author's own validation claim | Implementation faithfulness |
|---|---|---|---|---|
| Rabanser et al. 2026 | Yes (arXiv:2602.16666) | Yes — authors, twelve-metric framing confirmed | N/A (cited work, not the paper under review) | N/A |
| Arike et al. 2025 | Yes (arXiv:2505.02709, also AIES 2025) | Yes | N/A | N/A |
| Bhardwaj 2026 (AgentAssert) | Yes (arXiv:2602.22302, real GitHub repo) | Yes | N/A | N/A |
| Zhang et al. 2025 (ACE) | Yes (arXiv:2510.04618) | Yes — exact figures matched | N/A | N/A |
| The DEP paper itself | (not applicable — this is the primary document) | — | Explicitly states hypothesis, not validated result | Plan deviated on 2 of 6 properties' computation method; deviation caught and flagged |
