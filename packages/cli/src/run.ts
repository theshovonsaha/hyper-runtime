import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AllowlistedEnvironmentCredentialProvider,
  AllowlistedHttpCapability,
  BoundedProcessCapability,
  ReadFileCapability,
  WriteFileCapability,
} from '@hyper/capabilities';
import type {
  Condition,
  ContextSource,
  Effect,
  IntentContract,
  RiskLevel,
  WorkflowProposal,
  WorkflowRunResult,
} from '@hyper/contracts';
import { CONTRACT_VERSION } from '@hyper/contracts';
import {
  AnthropicMessagesTransport,
  CanonicalModelDriver,
  OpenAICompatibleTransport,
  ScriptedModelDriver,
  type ModelDriver,
} from '@hyper/model';
import { HashChainLedger, JsonlLedgerStore, inspectReplay } from '@hyper/runtime';
import { CapabilityRegistry, WorkflowRunner } from '@hyper/workflow';

export interface HyperTaskFile {
  version: '0.2.0';
  runId: string;
  intentId: string;
  objective: string;
  principalId: string;
  authorizedCapabilities?: string[];
  authorizedResources: string[];
  prohibitedEffects: Effect[];
  requiredEvidence: string[];
  completionCriteria: string[];
  riskBudget: RiskLevel;
  approvalAboveRisk: RiskLevel;
  constraints: string[];
  conditions: Condition[];
  sources?: ContextSource[];
  initialStrategyId: string;
  focusTags?: string[];
  tokenBudget?: number;
  maxSteps?: number;
  allowedExecutables?: string[];
  httpAllowedHosts?: string[];
}

export interface RunCommandOptions {
  taskPath: string;
  workspace: string;
  ledgerPath: string;
  provider: 'scripted' | 'openai-compatible' | 'anthropic';
  proposalsPath?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnvironmentName?: string;
  environment?: Record<string, string | undefined>;
  now?: () => string;
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function taskIntent(task: HyperTaskFile): IntentContract {
  return {
    id: task.intentId,
    version: CONTRACT_VERSION,
    objective: task.objective,
    principals: [task.principalId],
    authorizedCapabilities: task.authorizedCapabilities,
    authorizedResources: task.authorizedResources,
    prohibitedEffects: task.prohibitedEffects,
    requiredConditionIds: task.conditions.map(condition => condition.id),
    requiredEvidence: task.requiredEvidence,
    riskBudget: task.riskBudget,
    approvalAboveRisk: task.approvalAboveRisk,
    completionCriteria: task.completionCriteria,
  };
}

async function modelFor(options: RunCommandOptions): Promise<ModelDriver> {
  if (options.provider === 'scripted') {
    if (!options.proposalsPath) throw new Error('--proposals is required for scripted runs.');
    return new ScriptedModelDriver(loadJson<WorkflowProposal[]>(resolve(options.proposalsPath)));
  }
  if (!options.model) throw new Error('--model is required for live-provider runs.');
  if (!options.apiKeyEnvironmentName) {
    throw new Error('--api-key-env is required for live-provider runs.');
  }
  const credentials = new AllowlistedEnvironmentCredentialProvider(
    [options.apiKeyEnvironmentName],
    options.environment ?? process.env,
  );
  const apiKey = await credentials.get(options.apiKeyEnvironmentName);
  if (!apiKey) throw new Error(`Credential ${options.apiKeyEnvironmentName} is unavailable.`);

  if (options.provider === 'anthropic') {
    return new CanonicalModelDriver(new AnthropicMessagesTransport(
      options.model,
      apiKey,
      options.baseUrl,
    ));
  }
  if (!options.baseUrl) throw new Error('--base-url is required for OpenAI-compatible providers.');
  return new CanonicalModelDriver(new OpenAICompatibleTransport(
    options.model,
    apiKey,
    options.baseUrl,
  ));
}

export async function runTask(options: RunCommandOptions): Promise<WorkflowRunResult> {
  const task = loadJson<HyperTaskFile>(resolve(options.taskPath));
  if (task.version !== '0.2.0') throw new Error(`Unsupported task version: ${task.version}.`);
  const workspace = resolve(options.workspace);
  const capabilities = new CapabilityRegistry()
    .register(new ReadFileCapability(workspace))
    .register(new WriteFileCapability(workspace));
  if (task.allowedExecutables?.length) {
    capabilities.register(new BoundedProcessCapability(workspace, {
      allowedExecutables: task.allowedExecutables,
      environment: { PATH: (options.environment ?? process.env).PATH ?? '' },
    }));
  }
  if (task.httpAllowedHosts?.length) {
    capabilities.register(new AllowlistedHttpCapability({
      allowedHosts: task.httpAllowedHosts,
    }));
  }

  const ledger = new HashChainLedger(new JsonlLedgerStore(resolve(options.ledgerPath)));
  const runner = new WorkflowRunner({
    model: await modelFor(options),
    capabilities,
    ledger,
    now: options.now,
  });
  return runner.run({
    runId: task.runId,
    intent: taskIntent(task),
    conditions: task.conditions,
    constraints: task.constraints,
    sources: task.sources ?? [],
    initialStrategyId: task.initialStrategyId,
    focusTags: task.focusTags,
    tokenBudget: task.tokenBudget,
    maxSteps: task.maxSteps,
  });
}

export function replayLedger(path: string) {
  return inspectReplay(new HashChainLedger(new JsonlLedgerStore(resolve(path))));
}
