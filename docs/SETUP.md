# Setup Guide

Hyper-Runtime is built for developers and researchers aiming to test evidence-grounded agents.

## Prerequisites

- [Bun](https://bun.sh/) 1.3 or later.

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-org/hyper-runtime.git
cd hyper-runtime
bun install
```

## Verification

To verify that the project is set up correctly and the deterministic evaluation passes on your machine, run:

```bash
bun run check
```

This command executes:
1. Strict TypeScript checking (`tsc -p tsconfig.json --noEmit`)
2. Unit, architecture, policy, ledger, and benchmark tests (`bun test tests`)
3. The deterministic three-condition evaluation (`bun packages/evals/src/cli.ts`)

No API key or external model calls are required to pass this suite.

## Environment Variables

Hyper-Runtime's core operates without external API keys. However, if you plan to use live providers (e.g., OpenAI, Anthropic), you can copy the `.env.example` file and configure your keys.

```bash
cp .env.example .env
```

See [PROVIDERS.md](./PROVIDERS.md) for more details on integrating live models.

## Running the Examples

You can run the deterministic example workflow using the CLI:

```bash
bun run hyper -- run \
  --task examples/verified-file/task.json \
  --workspace examples/verified-file/workspace \
  --ledger /tmp/hyper-verified-file.jsonl \
  --provider scripted \
  --proposals examples/verified-file/proposals.json
```
