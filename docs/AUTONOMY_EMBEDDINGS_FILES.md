# Coding-agent autonomy, embedding profiles, and file context

This increment applies current coding-agent patterns without copying a product
surface or treating model behavior as authority. The runtime remains the
policy, effect, observation, and verification boundary.

## Claude Code intelligence

Anthropic documents Claude Code as an agentic harness around a model: it gathers
context, acts through tools, verifies results, and repeats. Its effective
understanding comes from the combination of the current conversation, project
files, project instructions, memory, tool definitions/results, and an execution
environment—not from the model alone. Sessions are resumable; context compacts;
skills load on demand; subagents receive isolated context; and permissions gate
effects. The Agent SDK exposes explicit turn and cost ceilings.

Prompt quality still matters. Anthropic recommends concrete scope, named files,
constraints, examples from the repository, symptoms, and a testable definition
of fixed. Vague prompts are useful for exploration, but they demand more
course-correction. Hyper therefore preserves the operator's intent and success
criteria, supplies relevant file links as data, keeps tool schemas narrow, and
lets the model choose the next proposal inside fixed authority.

Primary references:

- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Agent loop and budgets](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)

## Bounded auto mode

Auto mode is continuation policy, not unrestricted recursion. It keeps running
when the open choice is reversible and can be resolved from the request,
repository conventions, verified state, or a safe default. It stops for:

- missing credentials, authority, or a concrete external target;
- destructive, irreversible, costly, or externally visible effects;
- material scope expansion;
- completion, abort, step exhaustion, or wall-time exhaustion.

`HYPER_AUTO_MAX_STEPS` and `HYPER_AUTO_MAX_WALL_MS` are server ceilings. A
session can request a smaller step limit. The selected limits are emitted in run
metadata and the canonical run-start record. OpenAI's current model guidance
likewise recommends explicit tool routes, output schemas, concurrency, retry,
and stopping limits, and measuring final task success rather than rewarding
fewer calls by itself.

Reference: [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)

## Session-pinned embedding spaces

An embedding profile contains a stable ID, label, model, endpoint, optional
dimension, and backend-only credential reference. The browser sees readiness
and limitations but never secrets or storage paths.

The profile is selectable until the first file ingestion. Ingestion locks it for
the session. Document and query vectors always use the same profile. Changing a
model, dimensionality, input-task adapter, normalization regime, or vector
distance requires a new index (or a new session); mixing those vectors is not a
valid fallback.

No configured embedding model is a supported state. Hyper labels it and keeps
lexical, temporal, and relationship retrieval active.

### Provider/model selection map

This is a routing map, not a universal leaderboard. Model catalogs change and
quality is corpus-specific, so additions belong in configured profiles and
representative retrieval evals.

| Need | Profile candidates | Important adapter behavior |
| --- | --- | --- |
| General text, managed API | OpenAI `text-embedding-3-small` or `text-embedding-3-large` | Large is OpenAI's most capable English/non-English embedding model; dimensions may be configured where supported. |
| Multilingual/code with task types | Google `gemini-embedding-001` | Use distinct document/query task types; supports configurable output dimensionality. |
| Text + screenshots/PDF pages | Cohere `embed-v4.0` | Use `search_document` versus `search_query`; multimodal and Matryoshka dimensions require a Cohere-native adapter. |
| Retrieval-focused hosted models | Voyage current text/code models | Pin `input_type`, dimension, and model generation in the profile. |
| General text/code API | Mistral embedding models | Keep text and code model families distinct and benchmark each corpus. |
| Private/local corpora | OpenAI-compatible local models such as Nomic/E5/BGE deployments | Record model digest, pooling, normalization, prefixes/task instructions, dimension, and license. |

Primary references:

- [OpenAI embedding model catalog](https://developers.openai.com/api/docs/models/all)
- [OpenAI text-embedding-3-large](https://developers.openai.com/api/docs/models/text-embedding-3-large)
- [Google text embeddings](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings)
- [Cohere Embed models](https://docs.cohere.com/docs/cohere-embed)
- [Voyage text embeddings](https://docs.voyageai.com/docs/embeddings)
- [Mistral embeddings](https://docs.mistral.ai/studio-api/knowledge-rag/embeddings)

### Required evaluation matrix

Evaluate profiles on the actual code, documentation, conversation, and uploaded
file distribution. Track Recall@k, nDCG@k, MRR, answer evidence precision,
cross-language retrieval, temporal correctness, relationship expansion value,
index/query latency, storage, cost, and degraded-mode behavior. Test prompt
injection in retrieved data, cross-session isolation, model/dimension mismatch,
deletion, reindex reproducibility, and unavailable credentials.

## Universal and session file context

The universal explorer is rooted at `HYPER_WORKSPACE`. Path escape and symlink
traversal fail closed. Session files are resolved only through session-owned
metadata, so their storage locations are never returned. Directory listings are
bounded to 400 entries; text previews to 512 KB; inline media to 12 MB.

Preview kinds are code, Markdown, JSON, CSV, text, image, audio, video, PDF, and
binary metadata. Linking a workspace file tells the agent which authorized read
target is relevant. Linking a session file adds bounded provenance-linked chunks
to context. A link never grants write, process, network, or cross-session access.

```text
operator file link -> bounded resolver -> typed preview / context source
                   -> existing policy -> authorized read -> observed evidence
```
