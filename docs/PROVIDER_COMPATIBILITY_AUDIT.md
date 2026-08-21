# Provider compatibility audit

Audited against official provider documentation on 2026-08-20. “OpenAI
compatible” is treated as an endpoint family, not a claim that request fields,
reasoning controls, caching, models, or response shapes are identical.

| Provider | Native runtime dialect | Verified implementation boundary |
| --- | --- | --- |
| OpenAI | `openai` | Chat completions, `max_completion_tokens`, reasoning effort, exact-prefix cache key, cached/reasoning usage. |
| Google Gemini | `gemini` | OpenAI chat endpoint; maps `off` to `none`, uses `max_completion_tokens`; model profiles restrict unsupported thinking levels. |
| Groq | `groq` | OpenAI chat endpoint; maps `off` to `none`, uses `max_tokens`, reads model catalog before using a fallback. Reasoning remains model-specific. |
| Ollama | `ollama` | OpenAI chat endpoint; `max_tokens`; reasoning `none/low/medium/high`; local catalog, quantization metadata, memory admission, and connectivity preflight. Context length is host/model configuration rather than an OpenAI request field. |
| DeepSeek | `deepseek` | OpenAI chat endpoint with native `thinking.enabled/disabled`; effort is normalized to `high/max`; `max_tokens`. |
| Mistral | `mistral` | Chat completions, `max_tokens`, native `reasoning_effort`, and `prompt_cache_key`. |
| NVIDIA NIM | `nvidia` | OpenAI chat endpoint and catalog. No universal reasoning field is assumed because capability is model-specific. |
| OpenRouter | `openrouter` | OpenAI chat endpoint with its normalized `reasoning: {effort}` object; catalog metadata remains the source for mandatory/supported efforts. |
| OpenCode Zen | `opencode` | Only catalog entries documented for `/chat/completions` are exposed by the current adapter. Zen GPT models use `/responses` and are intentionally excluded until a Responses transport exists. |
| LM Studio | `lmstudio` | OpenAI chat endpoint for stateless runtime proposals. No model-independent reasoning field is assumed; richer load/context telemetry belongs to its native `/api/v1` integration. |
| llama.cpp | `llamacpp` | OpenAI chat endpoint, schema-constrained JSON, standard usage/cache counters, and template-level `enable_thinking`; actual reasoning depends on the loaded chat template. |
| Anthropic | native Messages API | Cacheable system block, cache usage, explicit stop-reason handling, and separate natural conversation/proposal prompts. Claude 4.5 and earlier use bounded manual thinking; Claude 4.6+ uses adaptive thinking plus `output_config.effort`. Exact preflight token counting and provider-native multi-turn message projection remain pending. |

Model profiles can override `reasoningMode` (`effort`, `toggle`, `budget`, or
`adaptive`) and `structuredOutput` (`json_object` or `prompt_only`). This is
required for provider models whose endpoint supports a feature but the selected
model does not.

Official references:

- [Anthropic Messages, thinking, token counting, and prompt caching](https://platform.claude.com/docs/en/api/messages)
- [Anthropic extended-to-adaptive thinking migration](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Gemini OpenAI compatibility and thinking mapping](https://ai.google.dev/gemini-api/docs/openai)
- [Groq OpenAI compatibility](https://console.groq.com/docs/openai), [API fields](https://console.groq.com/docs/api-reference), and [live models](https://console.groq.com/docs/models)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [thinking](https://docs.ollama.com/capabilities/thinking), and [context allocation](https://docs.ollama.com/context-length)
- [DeepSeek chat and thinking controls](https://api-docs.deepseek.com/api/create-chat-completion)
- [Mistral Chat API, reasoning, and prompt caching](https://docs.mistral.ai/api)
- [NVIDIA NIM LLM APIs](https://docs.api.nvidia.com/nim/reference/llm-apis)
- [OpenRouter reasoning and per-model discovery](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [OpenCode Zen endpoint/model matrix](https://opencode.ai/docs/zen/) and [provider/model compatibility rules](https://opencode.ai/v2/docs/models)
- [LM Studio native and compatibility endpoints](https://lmstudio.ai/docs/developer/rest)
- [llama.cpp server API, structured output, cache timing, and reasoning controls](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

## Remaining live evidence requirement

Adapter contract tests prove emitted request shapes and parsed usage. They do not
prove that a credential, account permission, quota, regional endpoint, model
deployment, or local daemon is currently usable. `bun run eval:live` is the
separate credentialed experiment. A provider/model pair becomes production-ready
only after its live trial passes proposal validity, context recall, cancellation,
latency, token accounting, and adversarial scenarios.
