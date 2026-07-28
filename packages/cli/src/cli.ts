#!/usr/bin/env bun
import { replayLedger, runTask } from './run';

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): string {
  return `Hyper-Runtime 0.2

Run a task:
  hyper run --task task.json --workspace ./repo --ledger ./run.jsonl \\
    --provider scripted --proposals proposals.json

Live provider:
  hyper run ... --provider anthropic --model MODEL --api-key-env ANTHROPIC_API_KEY
  hyper run ... --provider openai-compatible --model MODEL --base-url URL --api-key-env API_KEY

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
  const provider = value(args, '--provider') as
    | 'scripted'
    | 'openai-compatible'
    | 'anthropic'
    | undefined;
  if (!taskPath || !workspace || !ledgerPath || !provider) {
    throw new Error('--task, --workspace, --ledger, and --provider are required.');
  }
  const result = await runTask({
    taskPath,
    workspace,
    ledgerPath,
    provider,
    proposalsPath: value(args, '--proposals'),
    model: value(args, '--model'),
    baseUrl: value(args, '--base-url'),
    apiKeyEnvironmentName: value(args, '--api-key-env'),
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
