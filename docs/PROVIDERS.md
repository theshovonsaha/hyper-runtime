# Providers Guide

Hyper-Runtime is designed to operate primarily with **scripted, deterministic providers** to ensure rigorous, reproducible research results without variance induced by live LLMs.

By default, the framework avoids live network calls and instead relies on `scripted` provider proposals located alongside tasks.

## Offline / Scripted Provider

This is the default mode used by `bun run check`. The model proposals are pre-recorded.

```bash
bun run hyper -- run \
  --provider scripted \
  --proposals path/to/proposals.json \
  ...
```

## Live Model Providers (Opt-in)

For experimental evaluation with live foundation models, you must configure your environment variables.

### Configuration

Copy the example template:
```bash
cp .env.example .env
```

Set the appropriate keys in `.env`:
- `OPENAI_API_KEY=sk-...`
- `ANTHROPIC_API_KEY=sk-ant-...`

### Usage

When launching the CLI or UI, specify the provider explicitly:

```bash
bun run hyper -- run \
  --provider openai \
  --model gpt-4o \
  ...
```

**Note on Live Provider Variance**: Live providers introduce non-determinism. A successful run on a live provider does not prove that the underlying architecture is sound; you should always run the core `evals` offline first to establish the deterministic baseline for reachability, authorization, and verification.

## Multi-model pass schedules

The operator settings discover models independently for each configured route:

- `fallback`: A is preferred on every pass; B/C/D are reliability fallbacks;
- `ping_pong`: A, B, A, B;
- `ring`: A, B, C, A;
- `ring_pair`: A, B, C, D, A.

The scheduled route is not a voter, critic, or source of authority. It receives
the context packet for that workflow pass and returns one untrusted proposal.
If it fails transport or proposal validation, the next route gets the same
bounded request. Policy and verification run after routing and are unchanged.
Repeated failures cool that route for a bounded number of passes; cooldown and
recovery are canonical events and never change authority.

## Media Providers

The HTTP runtime can expose a `media` authority profile without turning raw
provider APIs into unrestricted tools:

- `DEEPGRAM_API_KEY` enables bounded local-file STT and workspace TTS artifacts.
- `ELEVENLABS_API_KEY` enables Scribe STT. TTS requires
  `HYPER_ELEVENLABS_VOICE_ID`; private voice agents require explicit
  `HYPER_ELEVENLABS_AGENT_IDS`.
- A Gemini or OpenAI key enables the approval-gated vision adapter; its key,
  base URL, and model remain overrideable through `HYPER_VISION_*`.
- An OpenAI key enables the approval-gated image adapter; its key, base URL,
  and model remain overrideable through `HYPER_IMAGE_*`.

Media inputs and outputs stay under `HYPER_WORKSPACE` with type and byte
limits. Transcript and vision verification proves that a structurally valid
provider response was observed, not that every semantic claim is true. Audio
and image generation are re-read after writing and verified by digest.
