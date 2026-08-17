# Session knowledge, agentic RAG, and coding-agent scope

## Claim boundary

Hyper-Runtime now supports bounded, session-owned file ingestion and a
provenance-first retrieval loop. It does not claim that vector similarity,
graph reachability, an LLM-produced relation, or retrieved prose establishes
truth or authority.

```text
uploaded bytes + digest
  -> bounded text extraction
    -> session-isolated chunks
      -> optional embeddings + lexical terms + time interval + graph edges
        -> fused retrieval proposal
          -> context data or authorized knowledge-search capability
            -> observed result identities + verification
```

Uploaded bytes are stored outside the operator-state JSON. The state file holds
rebuildable metadata, chunks, vectors, and relationship projections. Every
ingestion has a hash-chained canonical event trail containing the session, file
digest, projection status, retrieval mode, chunk identities, and limitations.

## Retrieval modes

When `HYPER_EMBEDDING_MODEL` and a usable OpenAI-compatible embedding endpoint
are configured, ingestion embeds chunks and queries. Ranking fuses lexical
match, cosine similarity, temporal relevance, and relationship expansion.

When embeddings are unavailable, fail, or have incompatible dimensions, the
system remains operational with lexical, temporal, and relationship ranking.
The API, file record, tool observation, and UI expose this degraded mode. The
runtime must never label degraded retrieval as hybrid.

Current bounded extraction supports UTF-8 text and common source/configuration
formats. Other bytes are retained with `metadata_only` status and a visible
extractor limitation. Each file is at most 8 MB; at most 200,000 extracted
characters and 128 chunks are indexed; each session holds at most 32 files; and
one request accepts at most four.

## Agentic retrieval

The model sees a small automatic recall set during context compilation. It can
also propose `session.knowledge.search` for iterative queries. The intent
contract authorizes only `session://knowledge/{current-session}`. The adapter
executes the search, observes it again, and verifies stable result identities.

Retrieval output is always data. Prompt injection in an uploaded document
cannot expand capability, effect, resource, risk, approval, context, or budget
scope. Completion still requires observed-state verification.

## Coding-agent profile

The `coder` profile combines bounded workspace reads/writes, an allowlisted
process runner, the session knowledge tool, and a longer verified workflow. Its
constraints require repository-instruction discovery, coherent cross-file
changes, dependency-boundary preservation, and strong authorized checks before
completion.

`coder` is available only when at least one executable is allowlisted. If no OS
sandbox backend is configured, the product says that execution is allowlisted
and workspace-bounded—not container isolated. Bubblewrap or a pinned OCI
configuration adds OS isolation without changing authority.

This is an evaluated coding-agent scope. Model quality, repository-task success,
and performance parity with Codex or Claude Code require separate live-model
benchmarks; mechanism tests alone do not establish those product-level claims.

## Translating the JARVIS interaction metaphor

Marvel describes JARVIS as a natural-language user interface that helps build
and operate armor. The useful runtime translation is:

| Fictional interaction quality | Hyper-Runtime primitive |
|---|---|
| remembers the active project | session transcript, verified memory, files |
| sees connected systems | capability manifests and observations |
| works while the operator watches | streamed canonical projections |
| warns before dangerous state | policy decisions and approval gates |
| relates design objects | provenance-linked knowledge graph |
| understands “current” state | validity intervals, clocks, observations |
| builds and tests | `coder` profile with bounded process execution |
| accepts interruption | abort signals, checkpoints, effect reconciliation |

The metaphor does not justify ambient surveillance, unbounded initiative,
hidden actions, biometric inference, impersonation, or fabricated certainty.
Proactive behavior should be limited to material risk, verified drift, a
blocked objective, or completion—not generic conversational interruptions.

## Research basis

- [OpenAI API overview](https://developers.openai.com/api/reference/overview):
  Responses for tool use and stateful interactions, server-held credentials,
  request IDs, pinned versions, and evals.
- [OpenAI vector-store files](https://platform.openai.com/docs/api-reference/vector-stores-files):
  uploaded files, configurable chunking, attributes, and file-search resources.
- [From Local to Global: A Graph RAG Approach](https://arxiv.org/abs/2404.16130):
  graph-local retrieval and community/global summarization address different
  corpus questions.
- [Agentic Retrieval-Augmented Generation: A Survey](https://arxiv.org/abs/2501.09136):
  planning, tool use, reflection, and iterative retrieval add adaptability and
  additional reliability requirements.
- [TimeR4](https://aclanthology.org/2024.emnlp-main.394/): time-aware retrieval
  should model temporal relevance rather than treating every fact as current.
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing): coding
  autonomy depends on filesystem/network isolation and permission boundaries.
- [Marvel's Vision on-screen profile](https://www.marvel.com/characters/vision/on-screen):
  the official description identifies JARVIS as Stark's user interface and an
  operating aid for armor development and use.

These sources motivate mechanisms. They are not benchmark evidence for this
implementation.

Embedding selection is session-pinned. The operator may select a configured
profile before the first ingestion; ingestion then locks the vector space.
Changing a model, dimension, task adapter, or normalization regime requires a
new session or an explicit future reindex operation. See
`docs/AUTONOMY_EMBEDDINGS_FILES.md` for the provider and evaluation map.
