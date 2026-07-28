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
