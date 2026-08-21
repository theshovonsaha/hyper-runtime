#!/usr/bin/env bun
import { replayLedger, runTask } from './run';

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const candidate = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && (!candidate || candidate.startsWith('--'))) {
    throw new Error(`${name} requires a value.`);
  }
  return candidate;
}

const PROVIDERS = ['scripted', 'openai-compatible', 'anthropic', 'ollama'] as const;

function provider(value: string | undefined): typeof PROVIDERS[number] | undefined {
  if (!value) return undefined;
  if (!(PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(`Unsupported provider: ${value}.`);
  }
  return value as typeof PROVIDERS[number];
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function usage(): string {
  return `Hyper-Runtime 0.2

Run a task:
  hyper run --task task.json --workspace ./repo --ledger ./run.jsonl \\
    --provider scripted --proposals proposals.json

Live provider:
  hyper run ... --provider anthropic --model MODEL --api-key-env ANTHROPIC_API_KEY
  hyper run ... --provider openai-compatible --model MODEL --base-url URL --api-key-env API_KEY
  hyper run ... --provider ollama --model MODEL

Inspect replay:
  hyper replay --ledger ./run.jsonl
`;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  if (command === 'replay') {
    const ledger = value(args, '--ledger');
    if (!ledger) throw new Error('--ledger is required.');
    console.log(JSON.stringify(replayLedger(ledger), null, 2));
    return 0;
  }
  if (command !== 'run') {
    console.log(usage());
    return command === '--help' || command === 'help' || !command ? 0 : 1;
  }

  const taskPath = value(args, '--task');
  const workspace = value(args, '--workspace');
  const ledgerPath = value(args, '--ledger');
  const selectedProvider = provider(value(args, '--provider'));
  if (!taskPath || !workspace || !ledgerPath || !selectedProvider) {
    throw new Error('--task, --workspace, --ledger, and --provider are required.');
  }
  const result = await runTask({
    taskPath,
    workspace,
    ledgerPath,
    provider: selectedProvider,
    runId: value(args, '--run-id'),
    proposalsPath: value(args, '--proposals'),
    model: value(args, '--model'),
    baseUrl: value(args, '--base-url'),
    apiKeyEnvironmentName: value(args, '--api-key-env'),
    modelTimeoutMs: positiveInteger(value(args, '--model-timeout-ms'), '--model-timeout-ms'),
  });
  console.log(JSON.stringify(result, null, 2));
  return result.status === 'completed' ? 0 : 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
