#!/usr/bin/env bun
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AllowlistedHttpCapability,
  BoundedProcessCapability,
  ReadFileCapability,
  WebSearchCapability,
  WriteFileCapability,
  type WebSearchCapabilityOptions,
} from '@hyper/capabilities';
import {
  CONTRACT_VERSION,
  type Approval,
  type ContextSource,
  type Effect,
  type IntentContract,
  type LedgerEvent,
  type WorkflowRunResult,
} from '@hyper/contracts';
import { HashChainLedger, JsonlLedgerStore, type LedgerStore } from '@hyper/runtime';
import { CapabilityRegistry, WorkflowRunner } from '@hyper/workflow';
import {
  verifyGroundedResponse,
  type GroundedClaimVerifier,
  type GroundedObservation,
  type ModelDriver,
} from '@hyper/model';
import { createModelDriver, type ModelSelectionOptions } from './run';
import {
  JsonOperatorStore,
  type CorrectionCandidate,
  type CustomHttpToolDefinition,
  type OperatorRun,
  type OperatorSchedule,
} from './operator-store';

type RuntimeProfile = 'inspect' | 'workspace' | 'research' | 'process' | 'network';
type LiveProviderTransport = Exclude<ModelSelectionOptions['provider'], 'scripted'>;
type RuntimeProviderId = string;

export interface RuntimeProviderConfiguration {
  id: RuntimeProviderId;
  label?: string;
  transport?: LiveProviderTransport;
  baseUrl?: string;
  apiKeyEnvironmentName?: string;
  defaultModel?: string;
}

export interface RuntimeHttpConfig extends Omit<ModelSelectionOptions, 'provider'> {
  provider: RuntimeProviderId;
  port: number;
  workspace: string;
  ledgerDirectory: string;
  operatorDataPath?: string;
  allowedExecutables: string[];
  allowedHosts: string[];
  schedulerPollMs?: number;
  providers?: RuntimeProviderConfiguration[];
  providerFetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  webSearch?: WebSearchCapabilityOptions;
  modelDriverFactory?: (selection?: ModelSelectionOptions) => ModelDriver | Promise<ModelDriver>;
  groundedClaimVerifier?: GroundedClaimVerifier;
}

interface RuntimeRunRequest {
  message?: unknown;
  objective?: unknown;
  session_id?: unknown;
  profile?: unknown;
  constraints?: unknown;
  required_evidence?: unknown;
  completion_criteria?: unknown;
  provider?: unknown;
  model?: unknown;
}

interface UiEvent {
  type: string;
  phase: string;
  summary: string;
  run_id: string;
  at: number;
  payload: Record<string, unknown>;
}

const PROFILE_CAPABILITIES: Record<RuntimeProfile, string[]> = {
  inspect: ['workspace.file.read'],
  workspace: ['workspace.file.read', 'workspace.file.write'],
  research: ['workspace.file.read', 'workspace.file.write', 'network.web.search'],
  process: ['workspace.file.read', 'workspace.file.write', 'workspace.process.run'],
  network: ['workspace.file.read', 'network.http.get'],
};

const ALL_EFFECTS: Effect[] = [
  'state.read',
  'state.write',
  'state.delete',
  'network.request',
  'process.execute',
];

function availableProfiles(config: RuntimeHttpConfig): RuntimeProfile[] {
  return [
    'inspect',
    'workspace',
    ...(config.webSearch ? ['research' as const] : []),
    ...(config.allowedExecutables.length > 0 ? ['process' as const] : []),
    ...(config.allowedHosts.length > 0 ? ['network' as const] : []),
  ];
}

function inferredTransport(id: string): LiveProviderTransport {
  if (id === 'ollama') return 'ollama';
  if (id === 'anthropic') return 'anthropic';
  return 'openai-compatible';
}

function providerConfigurations(config: RuntimeHttpConfig) {
  const environment = config.environment ?? process.env;
  const primary = config.provider || 'ollama';
  const definitions = new Map<RuntimeProviderId, RuntimeProviderConfiguration>();
  const add = (definition: RuntimeProviderConfiguration) => definitions.set(definition.id, definition);
  add({
    id: primary,
    transport: inferredTransport(primary),
    baseUrl: config.baseUrl,
    apiKeyEnvironmentName: config.apiKeyEnvironmentName,
    defaultModel: config.model,
  });
  for (const definition of config.providers ?? []) add(definition);
  return [...definitions.values()].map(definition => {
    const transport = definition.transport ?? inferredTransport(definition.id);
    const baseUrl = definition.baseUrl
      ?? (transport === 'ollama' ? 'http://127.0.0.1:11434/v1' : undefined)
      ?? (transport === 'anthropic' ? 'https://api.anthropic.com/v1' : undefined);
    const credentialConfigured = definition.apiKeyEnvironmentName
      ? Boolean(environment[definition.apiKeyEnvironmentName])
      : transport !== 'anthropic';
    return {
      ...definition,
      transport,
      label: definition.label ?? ({
        ollama: 'Ollama',
        'openai-compatible': 'OpenAI compatible',
        anthropic: 'Anthropic',
      })[definition.id] ?? definition.id,
      baseUrl,
      configured: Boolean(baseUrl) && credentialConfigured,
      credentialConfigured,
      defaultModel: definition.defaultModel
        ?? (transport === 'ollama' ? 'qwen3-vl:8b' : undefined),
    };
  });
}

type ProviderConfiguration = ReturnType<typeof providerConfigurations>[number];

function providerSelection(config: RuntimeHttpConfig, providerId: RuntimeProviderId, model?: string): ModelSelectionOptions {
  const provider = providerConfigurations(config).find(item => item.id === providerId);
  if (!provider?.configured) throw new Error(`Provider ${providerId} is not configured.`);
  const selectedModel = model?.trim() || provider.defaultModel;
  if (!selectedModel) throw new Error(`Provider ${providerId} has no selected model.`);
  return {
    provider: provider.transport,
    model: selectedModel,
    baseUrl: provider.baseUrl,
    apiKeyEnvironmentName: provider.apiKeyEnvironmentName,
    environment: config.environment,
    modelTimeoutMs: config.modelTimeoutMs,
  };
}

function providerModelsEndpoint(provider: ProviderConfiguration): string {
  if (!provider.baseUrl) throw new Error(`Provider ${provider.id} has no base URL.`);
  const base = provider.baseUrl.replace(/\/$/, '');
  if (provider.transport === 'ollama') {
    const value = new URL(base);
    value.pathname = `${value.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '')}/api/tags`;
    return value.toString();
  }
  return `${base}/models${provider.transport === 'anthropic' ? '?limit=100' : ''}`;
}

async function discoverProviderModels(config: RuntimeHttpConfig, provider: ProviderConfiguration) {
  if (!provider.configured) throw new Error(`Provider ${provider.id} is not configured.`);
  const environment = config.environment ?? process.env;
  const apiKey = provider.apiKeyEnvironmentName
    ? environment[provider.apiKeyEnvironmentName]
    : undefined;
  const response = await (config.providerFetch ?? fetch)(providerModelsEndpoint(provider), {
    method: 'GET',
    signal: AbortSignal.timeout(Math.min(config.modelTimeoutMs ?? 60_000, 5_000)),
    headers: {
      ...(provider.transport === 'anthropic' && apiKey ? {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      } : {}),
      ...(provider.transport === 'openai-compatible' && apiKey
        ? { authorization: `Bearer ${apiKey}` }
        : {}),
      accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}.`);
  const payload = await response.json() as Record<string, any>;
  const source = provider.transport === 'ollama' ? payload.models : payload.data;
  if (!Array.isArray(source)) throw new Error('Model discovery returned an invalid model list.');
  return source.flatMap((item: Record<string, unknown>) => {
    const rawId = typeof item.id === 'string'
      ? item.id
      : typeof item.name === 'string' ? item.name : undefined;
    if (!rawId) return [];
    const id = provider.id === 'gemini' ? rawId.replace(/^models\//, '') : rawId;
    const name = typeof item.display_name === 'string' ? item.display_name : id;
    if (
      provider.id === 'gemini'
      && /(embedding|imagen|veo|lyria|image|tts|audio|live|robotics|aqa|antigravity|deep-research|nano banana)/i.test(`${id} ${name}`)
    ) return [];
    return [{
      id,
      name,
      owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
      modified_at: typeof item.modified_at === 'string' ? item.modified_at : undefined,
      size: typeof item.size === 'number' ? item.size : undefined,
    }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function discoveredDefaultModel(
  provider: ProviderConfiguration,
  models: Array<{ id: string; name: string }>,
): string | undefined {
  if (provider.defaultModel && models.some(model => model.id === provider.defaultModel)) {
    return provider.defaultModel;
  }
  if (provider.id === 'gemini') {
    return models.find(model => model.id === 'gemini-flash-latest')?.id
      ?? models.find(model => /^gemini-[\d.]+-flash$/.test(model.id))?.id
      ?? models.find(model => model.id.includes('flash'))?.id
      ?? models[0]?.id;
  }
  return models[0]?.id;
}

function customCapabilityId(name: string): string {
  return `custom.http.${name}`;
}

function approvalThreshold(selectedProfile: RuntimeProfile): 3 | 4 | 5 {
  if (selectedProfile === 'workspace') return 4;
  if (selectedProfile === 'research' || selectedProfile === 'process' || selectedProfile === 'network') return 3;
  return 5;
}

function strings(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : fallback;
}

function profile(value: unknown): RuntimeProfile {
  return typeof value === 'string' && Object.hasOwn(PROFILE_CAPABILITIES, value)
    ? value as RuntimeProfile
    : 'inspect';
}

function sse(value: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
}

async function scheduledRunResult(
  response: { ok: boolean; text(): Promise<string> },
): Promise<{ runId?: string; status: string }> {
  if (!response.ok) return { status: 'error' };
  const frames = (await response.text()).split('\n')
    .filter(line => line.startsWith('data: '))
    .flatMap(line => {
      try {
        return [JSON.parse(line.slice(6)) as Record<string, any>];
      } catch {
        return [];
      }
    });
  const runId = frames.find(frame => frame.kind === 'meta')?.run_id as string | undefined;
  const terminal = frames.findLast(frame =>
    frame.kind === 'event' && ['run.end', 'run.error'].includes(frame.event?.type),
  );
  return {
    runId,
    status: terminal?.event?.type === 'run.end'
      ? String(terminal.event.payload?.status ?? 'completed')
      : 'error',
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'access-control-allow-origin': '*' },
  });
}

function summary(value: unknown, max = 220): string {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  return (rendered || '').slice(0, max);
}

function persistedEvents(config: RuntimeHttpConfig, runId: string): LedgerEvent[] {
  const safe = runId.replace(/[^a-zA-Z0-9:_-]/g, '_');
  const path = join(config.ledgerDirectory, `${safe}.jsonl`);
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as LedgerEvent);
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function projectPassMetrics(events: LedgerEvent[]) {
  const contextEvents = events.filter(event => event.type === 'context.compiled');
  const modelEvents = events.filter(event => event.type === 'model.proposed');
  const audits = contextEvents.map(event =>
    typeof event.payload.audit === 'object' && event.payload.audit
      ? event.payload.audit as Record<string, unknown>
      : {},
  );
  const requestAudits = modelEvents.flatMap(event =>
    typeof event.payload.requestAudit === 'object' && event.payload.requestAudit
      ? [event.payload.requestAudit as Record<string, unknown>]
      : [],
  );
  const usage = modelEvents.map(event =>
    typeof event.payload.usage === 'object' && event.payload.usage
      ? event.payload.usage as Record<string, unknown>
      : {},
  );
  const systemHashes = requestAudits.flatMap(audit =>
    typeof audit.systemHash === 'string' ? [audit.systemHash] : [],
  );
  const contextHashes = requestAudits.flatMap(audit =>
    typeof audit.contextHash === 'string' ? [audit.contextHash] : [],
  );
  const utilizationTotal = audits.reduce(
    (total, audit) => total + finiteNumber(audit.budgetUtilization),
    0,
  );
  return {
    passes_audited: contextEvents.length,
    prompt_requests_audited: requestAudits.length,
    sources_considered: audits.reduce(
      (total, audit) => total + finiteNumber(audit.sourcesConsidered),
      0,
    ),
    sources_included: audits.reduce(
      (total, audit) => total + finiteNumber(audit.sourcesIncluded),
      0,
    ),
    context_tokens: contextEvents.reduce(
      (total, event) => total + finiteNumber(event.payload.estimatedTokens),
      0,
    ),
    stable_context_tokens: audits.reduce(
      (total, audit) => total + finiteNumber(audit.stableTokens),
      0,
    ),
    dynamic_context_tokens: audits.reduce(
      (total, audit) => total + finiteNumber(audit.dynamicTokens),
      0,
    ),
    duplicate_tokens_removed: audits.reduce(
      (total, audit) => total + finiteNumber(audit.duplicateTokensRemoved),
      0,
    ),
    average_budget_utilization: contextEvents.length
      ? utilizationTotal / contextEvents.length
      : 0,
    model_input_tokens: usage.reduce(
      (total, item) => total + finiteNumber(item.inputTokens),
      0,
    ),
    model_output_tokens: usage.reduce(
      (total, item) => total + finiteNumber(item.outputTokens),
      0,
    ),
    model_latency_ms: usage.reduce(
      (total, item) => total + finiteNumber(item.latencyMs),
      0,
    ),
    stable_prefix_reuse_candidates: Math.max(0, systemHashes.length - new Set(systemHashes).size),
    repeated_context_packets: Math.max(0, contextHashes.length - new Set(contextHashes).size),
  };
}

export function adaptLedgerEvent(event: LedgerEvent): UiEvent[] {
  const base = { run_id: event.runId, at: Date.now() };
  const payload = event.payload;
  switch (event.type) {
    case 'workflow.started':
      return [{ ...base, type: 'run.start', phase: 'intake', summary: 'Verified workflow opened', payload }];
    case 'operator.run_started':
      return [{ ...base, type: 'capability', phase: 'intake', summary: `${String(payload.profile || 'inspect')} authority selected`, payload }];
    case 'context.compiled':
      return [{ ...base, type: 'context.packet', phase: 'context', summary: `${payload.estimatedTokens ?? 0} estimated tokens selected`, payload }];
    case 'model.proposed': {
      const proposal = payload.proposal as Record<string, unknown> | undefined;
      const events: UiEvent[] = [{
        ...base,
        type: 'model.response',
        phase: 'model',
        summary: proposal?.kind ? `Model proposed ${proposal.kind}` : 'Model proposal received',
        payload,
      }];
      const action = proposal?.action as Record<string, unknown> | undefined;
      if (proposal?.kind === 'action' && action) {
        events.push({
          ...base,
          type: 'tool.call',
          phase: 'tool',
          summary: `${String(action.capabilityId || 'capability')}(${String(action.target || '')})`,
          payload: {
            id: action.id,
            name: action.capabilityId,
            target: action.target,
            arguments: action.args,
            declaredEffects: action.declaredEffects,
            risk: action.risk,
          },
        });
      }
      return events;
    }
    case 'model.proposal_failed':
    case 'model.proposal_rejected':
      return [{ ...base, type: 'model.response', phase: 'error', summary: summary(payload.reason ?? payload.reasonCode ?? 'Proposal rejected'), payload }];
    case 'policy.decided':
      return [{
        ...base,
        type: 'verify.verdict',
        phase: 'verify',
        summary: `Policy ${String(payload.disposition || 'decided')}: ${summary(payload.reasonCodes)}`,
        payload,
      }];
    case 'action.executed':
      return [{
        ...base,
        type: 'tool.result',
        phase: 'tool',
        summary: summary(payload.summary ?? (payload.success ? 'Tool completed' : 'Tool failed')),
        payload: {
          id: payload.proposalId,
          name: payload.capabilityId,
          ok: payload.success,
          result: payload,
        },
      }];
    case 'state.observed':
      return [{ ...base, type: 'verify.verdict', phase: 'verify', summary: `Observed ${String(payload.target || 'target')}`, payload }];
    case 'action.verified':
      return [{ ...base, type: 'verify.verdict', phase: 'verify', summary: payload.passed ? 'Observed state verified' : 'Verification failed', payload }];
    case 'action.proposed':
    case 'capability.granted':
    case 'action.receipt':
      // These canonical audit events duplicate the adapted model, policy, and
      // tool rows. They remain in the ledger and raw run trail, but do not add
      // useful signal to the compact operator timeline.
      return [];
    case 'workflow.pivoted':
      return [{ ...base, type: 'plan.update', phase: 'plan', summary: `Strategy pivoted to ${String(payload.strategyId || '')}`, payload }];
    case 'workflow.progress_assessed':
      return [{ ...base, type: 'plan.update', phase: 'plan', summary: 'Causal progress assessed', payload }];
    case 'correction.applied':
      return [{ ...base, type: 'plan.update', phase: 'plan', summary: 'Bounded correction applied', payload }];
    case 'workflow.approval_requested':
      return [{ ...base, type: 'gate.open', phase: 'gate', summary: `Approval required for ${String(payload.capabilityId || 'action')}`, payload }];
    case 'workflow.approval_resolved':
      return [{ ...base, type: 'gate.resolved', phase: 'gate', summary: payload.approved ? 'Operator approved the scoped action' : 'Operator rejected the scoped action', payload }];
    case 'workflow.completion_checked':
      return [{ ...base, type: 'verify.verdict', phase: 'verify', summary: payload.passed ? 'Completion evidence accepted' : 'Completion claim rejected', payload }];
    case 'workflow.receipt':
      return [{ ...base, type: 'receipt.commit', phase: 'commit', summary: 'Evidence-linked terminal receipt committed', payload: { ...payload, receiptHash: event.hash } }];
    case 'response.synthesized':
      return [{ ...base, type: 'respond.final', phase: 'respond', summary: 'Evidence-grounded answer composed', payload }];
    case 'memory.verified_outcome_committed':
      return [{ ...base, type: 'memory.commit', phase: 'commit', summary: 'Verified outcome added to durable memory', payload }];
    case 'operator.run_finished': {
      const status = String(payload.status || 'finished');
      if (status === 'needs_input' || status === 'needs_approval') {
        return [{
          ...base,
          type: 'run.pause',
          phase: 'gate',
          summary: status === 'needs_input' ? 'Waiting for your reply' : 'Waiting for approval',
          payload,
        }];
      }
      return [{
        ...base,
        type: status === 'completed' ? 'run.end' : 'run.error',
        phase: status === 'completed' ? 'done' : 'error',
        summary: `Workflow ${status.replaceAll('_', ' ')}`,
        payload,
      }];
    }
    default:
      return [{ ...base, type: event.type, phase: 'context', summary: event.type.replaceAll('.', ' › '), payload }];
  }
}

class StreamingLedgerStore implements LedgerStore {
  private readonly durable: JsonlLedgerStore;

  constructor(path: string, private readonly emit: (event: LedgerEvent) => void) {
    this.durable = new JsonlLedgerStore(path);
  }

  load(): LedgerEvent[] {
    return this.durable.load();
  }

  append(event: LedgerEvent): void {
    this.durable.append(event);
    try {
      this.emit(event);
    } catch {
      // A disconnected UI must not invalidate an already durable event.
    }
  }
}

function capabilities(config: RuntimeHttpConfig, customTools: CustomHttpToolDefinition[] = []): CapabilityRegistry {
  const registry = new CapabilityRegistry()
    .register(new ReadFileCapability(config.workspace))
    .register(new WriteFileCapability(config.workspace));
  if (config.allowedExecutables.length > 0) {
    registry.register(new BoundedProcessCapability(config.workspace, {
      allowedExecutables: config.allowedExecutables,
      environment: { PATH: process.env.PATH ?? '' },
    }));
  }
  if (config.allowedHosts.length > 0) {
    registry.register(new AllowlistedHttpCapability({ allowedHosts: config.allowedHosts }));
  }
  if (config.webSearch) registry.register(new WebSearchCapability(config.webSearch));
  for (const tool of customTools) {
    if (!tool.enabled || !config.allowedHosts.includes(tool.host)) continue;
    registry.register(new AllowlistedHttpCapability({
      id: tool.id,
      description: tool.description,
      allowedHosts: [tool.host],
      pathPrefixes: { [tool.host]: [tool.pathPrefix] },
    }));
  }
  return registry;
}

function groundedObservations(result: WorkflowRunResult): GroundedObservation[] {
  return result.steps.flatMap(step => {
    const outcome = step.outcome;
    if (outcome?.status !== 'completed' || !outcome.verification?.passed || !outcome.observation) return [];
    return [{
      target: outcome.observation.target,
      value: outcome.observation.value,
      evidenceRefs: outcome.verification.evidence.map(item => item.id),
      verificationCodes: outcome.verification.reasonCodes,
    }];
  });
}

function finalText(result: WorkflowRunResult): string {
  if (result.status === 'completed') {
    const observations = result.steps.flatMap(step =>
      step.outcome?.observation?.value === undefined
        ? []
        : [summary(step.outcome.observation.value, 500)],
    );
    return `Completed with verified observed state.${observations.length ? `\n\nObserved:\n${observations.join('\n')}` : ''}\n\nVerification establishes the recorded state transition; it does not independently prove every semantic claim contained in external data.`;
  }
  if (result.status === 'needs_input') return result.question ?? 'The workflow needs additional input.';
  if (result.status === 'needs_approval') return 'The next action requires proposal-scoped approval.';
  return `Workflow stopped: ${result.reasonCodes.join(', ')}`;
}

async function parseBody(req: Request): Promise<RuntimeRunRequest> {
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > 1_000_000) throw new Error('Request body exceeds 1 MB.');
  return await req.json() as RuntimeRunRequest;
}

export function createRuntimeHttpHandler(config: RuntimeHttpConfig) {
  mkdirSync(config.ledgerDirectory, { recursive: true });
  const operatorStore = new JsonOperatorStore(
    config.operatorDataPath ?? join(config.ledgerDirectory, 'operator-state.json'),
  );
  const registry = () => capabilities(config, operatorStore.listCustomTools());
  const pendingApprovals = new Map<string, {
    proposalId: string;
    resolve: (approval: Approval | undefined) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      } });
    }
    if (req.method === 'GET' && (url.pathname === '/api/config' || url.pathname === '/api/health')) {
      const providers = providerConfigurations(config);
      return json({
        ok: true,
        runtime: 'hyper-evaluated',
        service_revision: 'provider-registry-v2',
        provider: config.provider,
        model: config.model,
        providers: providers.map(item => ({
          id: item.id,
          label: item.label,
          configured: item.configured,
          credential_configured: item.credentialConfigured,
          default_model: item.defaultModel,
        })),
        providers_available: Object.fromEntries(providers.map(item => [item.id, item.configured])),
        models: Object.fromEntries(providers.map(item => [item.id, item.defaultModel])),
        workspace: config.workspace,
        profiles: availableProfiles(config),
        capabilities: registry().manifests(),
        approval_thresholds: Object.fromEntries(
          availableProfiles(config).map(value => [value, approvalThreshold(value)]),
        ),
        verification: {
          structural_proposals: true,
          observed_state: true,
          completion_requires_verified_evidence: true,
          arbitrary_semantic_claims: false,
        },
        memory: {
          durable_agent_memory: true,
          terminal_receipts: true,
          commit_policy: 'verified_outcomes_only',
        },
        features: {
          grounded_responses: true,
          persistent_sessions: true,
          verified_memory: true,
          custom_http_tools: true,
          schedules: true,
          dynamic_model_discovery: true,
          web_search: !!config.webSearch,
          bounded_pass_signals: true,
          correction_candidate_review: true,
        },
        limitations: ['sequential_steps', 'no_crash_resume', 'process_is_not_os_sandbox'],
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/providers') {
      const providers = await Promise.all(providerConfigurations(config).map(async item => {
        if (!item.configured) return {
          id: item.id,
          label: item.label,
          configured: false,
          connected: false,
          default_model: item.defaultModel,
          error: item.credentialConfigured ? 'Provider endpoint is not configured.' : 'Credential is not configured.',
        };
        try {
          const models = await discoverProviderModels(config, item);
          return {
            id: item.id,
            label: item.label,
            configured: true,
            connected: true,
            default_model: discoveredDefaultModel(item, models),
            model_count: models.length,
          };
        } catch (error) {
          return {
            id: item.id,
            label: item.label,
            configured: true,
            connected: false,
            default_model: item.defaultModel,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }));
      return json({ providers });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/models/')) {
      const providerId = decodeURIComponent(url.pathname.slice('/api/models/'.length));
      const provider = providerConfigurations(config).find(item => item.id === providerId);
      if (!provider) return json({ error: 'provider is not configured' }, 404);
      try {
        const models = await discoverProviderModels(config, provider);
        return json({
          provider: provider.id,
          connected: true,
          default_model: discoveredDefaultModel(provider, models),
          models,
        });
      } catch (error) {
        return json({
          provider: provider.id,
          connected: false,
          default_model: provider.defaultModel,
          models: [],
          error: error instanceof Error ? error.message : String(error),
        }, 502);
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      return json({ sessions: operatorStore.listSessions() });
    }
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const body = await req.json().catch(() => ({})) as { id?: unknown; title?: unknown };
      const id = typeof body.id === 'string' && body.id ? body.id : `session:${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const session = operatorStore.ensureSession(
        id,
        now,
        typeof body.title === 'string' ? body.title : undefined,
      );
      return json({ session }, 201);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/messages')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/api/sessions/'.length, -'/messages'.length));
      const messages = operatorStore.messages(sessionId);
      return messages ? json({ session_id: sessionId, messages }) : json({ error: 'unknown session' }, 404);
    }
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      return json({ runs: operatorStore.listRuns(url.searchParams.get('session_id') ?? undefined) });
    }
    if (req.method === 'GET' && url.pathname === '/api/scorecard') {
      const runs = operatorStore.listRuns();
      const terminal = runs.filter(run => !!run.endedAt);
      const completed = terminal.filter(run => run.status === 'completed');
      return json({
        runs: runs.length,
        completed: completed.length,
        success_rate: terminal.length ? completed.length / terminal.length : 0,
        awaiting_or_active: runs.length - terminal.length,
        verified_memory_records: operatorStore.listMemory().length,
        custom_tools: operatorStore.listCustomTools().filter(tool => tool.enabled).length,
        correction_candidates: operatorStore.listCorrectionCandidates()
          .filter(candidate => candidate.status === 'candidate').length,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/signals') {
      const runs = operatorStore.listRuns().flatMap(run => {
        try {
          return [{
            id: run.id,
            title: run.objective,
            status: run.status,
            started_at: run.startedAt,
            ...projectPassMetrics(persistedEvents(config, run.id)),
          }];
        } catch {
          return [];
        }
      });
      const aggregate = runs.reduce((total, run) => ({
        passes_audited: total.passes_audited + run.passes_audited,
        context_tokens: total.context_tokens + run.context_tokens,
        duplicate_tokens_removed: total.duplicate_tokens_removed + run.duplicate_tokens_removed,
        model_input_tokens: total.model_input_tokens + run.model_input_tokens,
        model_latency_ms: total.model_latency_ms + run.model_latency_ms,
      }), {
        passes_audited: 0,
        context_tokens: 0,
        duplicate_tokens_removed: 0,
        model_input_tokens: 0,
        model_latency_ms: 0,
      });
      return json({ aggregate, runs });
    }
    if (req.method === 'GET' && url.pathname === '/api/memory') {
      return json({ memory: operatorStore.listMemory() });
    }
    if (req.method === 'GET' && url.pathname === '/api/corrections') {
      return json({ corrections: operatorStore.listCorrectionCandidates() });
    }
    if (req.method === 'POST' && url.pathname === '/api/corrections') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const observed = typeof body.observed === 'string' ? body.observed.trim().slice(0, 4_000) : '';
      const mismatch = typeof body.mismatch === 'string' ? body.mismatch.trim().slice(0, 4_000) : '';
      const correction = typeof body.correction === 'string' ? body.correction.trim().slice(0, 4_000) : '';
      const reusableRule = typeof body.reusable_rule === 'string'
        ? body.reusable_rule.trim().slice(0, 4_000)
        : '';
      if (!observed || !mismatch || !correction || !reusableRule) {
        return json({ error: 'observed, mismatch, correction, and reusable_rule are required' }, 400);
      }
      const createdAt = new Date().toISOString();
      const candidate: CorrectionCandidate = {
        id: `correction-candidate:${crypto.randomUUID()}`,
        observed,
        mismatch,
        correction,
        reusableRule,
        triggerCodes: strings(body.trigger_codes).slice(0, 20),
        status: 'candidate',
        createdAt,
        updatedAt: createdAt,
        ...(typeof body.source_run_id === 'string' && body.source_run_id
          ? { sourceRunId: body.source_run_id.slice(0, 500) }
          : {}),
        ...(typeof body.session_id === 'string' && body.session_id
          ? { sessionId: body.session_id.slice(0, 500) }
          : {}),
      };
      operatorStore.upsertCorrectionCandidate(candidate);
      return json({ correction: candidate }, 201);
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/api/corrections/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/corrections/'.length));
      const candidate = operatorStore.correctionCandidate(id);
      if (!candidate) return json({ error: 'unknown correction candidate' }, 404);
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const status = body.status;
      if (status !== 'candidate' && status !== 'accepted_for_experiment' && status !== 'rejected') {
        return json({ error: 'invalid correction candidate status' }, 400);
      }
      const updated: CorrectionCandidate = {
        ...candidate,
        status: status as CorrectionCandidate['status'],
        updatedAt: new Date().toISOString(),
      };
      operatorStore.upsertCorrectionCandidate(updated);
      return json({ correction: updated });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/memory/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/memory/'.length));
      return operatorStore.deleteMemory(id) ? json({ ok: true }) : json({ error: 'unknown memory record' }, 404);
    }
    if (req.method === 'GET' && url.pathname === '/api/custom_tools') {
      return json({ custom_tools: operatorStore.listCustomTools() });
    }
    if (req.method === 'POST' && url.pathname === '/api/custom_tools') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const host = typeof body.host === 'string' ? body.host.trim().toLowerCase() : '';
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      const pathPrefix = typeof body.path_prefix === 'string' ? body.path_prefix.trim() : '/';
      if (!/^[a-z][a-z0-9_-]{1,48}$/.test(name)) return json({ error: 'invalid tool name' }, 400);
      if (!config.allowedHosts.includes(host)) return json({ error: 'tool host is outside HYPER_ALLOWED_HOSTS' }, 400);
      if (!description) return json({ error: 'tool description is required' }, 400);
      if (!pathPrefix.startsWith('/') || pathPrefix.includes('..')) return json({ error: 'invalid path prefix' }, 400);
      const tool: CustomHttpToolDefinition = {
        id: customCapabilityId(name),
        name,
        description: description.slice(0, 500),
        host,
        pathPrefix: pathPrefix.slice(0, 500),
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      operatorStore.upsertCustomTool(tool);
      return json({ custom_tool: tool }, 201);
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/api/custom_tools/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/custom_tools/'.length));
      const current = operatorStore.listCustomTools().find(tool => tool.id === id);
      if (!current) return json({ error: 'unknown custom tool' }, 404);
      const body = await req.json().catch(() => ({})) as { enabled?: unknown };
      operatorStore.upsertCustomTool({ ...current, enabled: body.enabled === true });
      return json({ ok: true });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/custom_tools/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/custom_tools/'.length));
      return operatorStore.deleteCustomTool(id) ? json({ ok: true }) : json({ error: 'unknown custom tool' }, 404);
    }
    if (req.method === 'GET' && url.pathname === '/api/schedules') {
      return json({ schedules: operatorStore.listSchedules() });
    }
    if (req.method === 'POST' && url.pathname === '/api/schedules') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 20_000) : '';
      const intervalMinutes = Number(body.interval_minutes);
      const selectedProfile = profile(body.profile);
      if (!prompt || !Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
        return json({ error: 'prompt and interval_minutes >= 1 are required' }, 400);
      }
      if (!availableProfiles(config).includes(selectedProfile)) return json({ error: 'profile is unavailable' }, 400);
      const requestedProvider = typeof body.provider === 'string' ? body.provider : config.provider;
      if (!providerConfigurations(config).some(item => item.id === requestedProvider)) {
        return json({ error: 'provider is unavailable' }, 400);
      }
      let scheduleSelection: ModelSelectionOptions;
      try {
        scheduleSelection = providerSelection(
          config,
          requestedProvider,
          typeof body.model === 'string' ? body.model.slice(0, 200) : undefined,
        );
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
      const now = new Date();
      const schedule: OperatorSchedule = {
        id: `schedule:${crypto.randomUUID()}`,
        prompt,
        profile: selectedProfile,
        provider: scheduleSelection.provider,
        model: scheduleSelection.model,
        intervalMinutes,
        enabled: body.enabled !== false,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        nextRunAt: new Date(now.getTime() + intervalMinutes * 60_000).toISOString(),
      };
      operatorStore.upsertSchedule(schedule);
      return json({ schedule }, 201);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/schedules/') && url.pathname.endsWith('/run')) {
      const id = decodeURIComponent(url.pathname.slice('/api/schedules/'.length, -'/run'.length));
      const schedule = operatorStore.listSchedules().find(item => item.id === id);
      if (!schedule) return json({ error: 'unknown schedule' }, 404);
      if (schedule.lastStatus === 'running') return json({ error: 'schedule is already running' }, 409);
      operatorStore.upsertSchedule({
        ...schedule,
        updatedAt: new Date().toISOString(),
        lastStatus: 'running',
      });
      const response = await handler(new Request(new URL('/api/runtime/run', url).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          objective: schedule.prompt,
          profile: schedule.profile,
          provider: schedule.provider,
          model: schedule.model,
          session_id: `session:schedule:${schedule.id}`,
        }),
      }));
      void scheduledRunResult(response.clone()).then(result => {
        const current = operatorStore.listSchedules().find(item => item.id === id);
        if (!current) return;
        operatorStore.upsertSchedule({
          ...current,
          lastRunId: result.runId,
          lastStatus: result.status,
          updatedAt: new Date().toISOString(),
        });
      }).catch(() => {
        const current = operatorStore.listSchedules().find(item => item.id === id);
        if (current) operatorStore.upsertSchedule({ ...current, lastStatus: 'error' });
      });
      return response;
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/api/schedules/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/schedules/'.length));
      const current = operatorStore.listSchedules().find(schedule => schedule.id === id);
      if (!current) return json({ error: 'unknown schedule' }, 404);
      const body = await req.json().catch(() => ({})) as { enabled?: unknown };
      const now = new Date();
      const enabled = body.enabled === true;
      operatorStore.upsertSchedule({
        ...current,
        enabled,
        updatedAt: now.toISOString(),
        nextRunAt: enabled && !current.enabled
          ? new Date(now.getTime() + current.intervalMinutes * 60_000).toISOString()
          : current.nextRunAt,
      });
      return json({ ok: true });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/schedules/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/schedules/'.length));
      return operatorStore.deleteSchedule(id) ? json({ ok: true }) : json({ error: 'unknown schedule' }, 404);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/runs/') && url.pathname.endsWith('/events')) {
      const runId = decodeURIComponent(url.pathname.slice('/api/runs/'.length, -'/events'.length));
      try {
        const events = persistedEvents(config, runId);
        return json({ run_id: runId, events });
      } catch {
        return json({ error: 'unknown run' }, 404);
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/runs/') && url.pathname.endsWith('/pass-metrics')) {
      const runId = decodeURIComponent(url.pathname.slice('/api/runs/'.length, -'/pass-metrics'.length));
      try {
        return json({ run_id: runId, metrics: projectPassMetrics(persistedEvents(config, runId)) });
      } catch {
        return json({ error: 'unknown run' }, 404);
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/runs/') && url.pathname.endsWith('/trail')) {
      const runId = decodeURIComponent(url.pathname.slice('/api/runs/'.length, -'/trail'.length));
      try {
        return json({
          run_id: runId,
          events: persistedEvents(config, runId).flatMap(adaptLedgerEvent),
        });
      } catch {
        return json({ error: 'unknown run' }, 404);
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/runs/') && url.pathname.endsWith('/attribution')) {
      const runId = decodeURIComponent(url.pathname.slice('/api/runs/'.length, -'/attribution'.length));
      try {
        const events = persistedEvents(config, runId);
        const contextSourceIds = events
          .filter(event => event.type === 'context.compiled')
          .flatMap(event => strings(event.payload.includedSourceIds));
        const evidenceRefs = events.flatMap(event => {
          const evidence = event.payload.evidence;
          return Array.isArray(evidence)
            ? evidence.flatMap(item => typeof item === 'object' && item && 'id' in item ? [String(item.id)] : [])
            : [];
        });
        return json({
          run_id: runId,
          context_source_ids: [...new Set(contextSourceIds)],
          evidence_refs: [...new Set(evidenceRefs)],
          response: events.findLast(event => event.type === 'response.synthesized')?.payload,
          note: 'Attribution reports provenance links, not causal percentages.',
        });
      } catch {
        return json({ error: 'unknown run' }, 404);
      }
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/runs/') && url.pathname.endsWith('/approval')) {
      const runId = decodeURIComponent(url.pathname.slice('/api/runs/'.length, -'/approval'.length));
      const pending = pendingApprovals.get(runId);
      if (!pending) return json({ error: 'run is not awaiting approval' }, 409);
      const body = await req.json().catch(() => ({})) as { approved?: unknown };
      clearTimeout(pending.timeout);
      pendingApprovals.delete(runId);
      const now = new Date();
      pending.resolve(body.approved === true ? {
        id: `approval:${crypto.randomUUID()}`,
        proposalId: pending.proposalId,
        principalId: 'agent:operator-ui',
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      } : undefined);
      return json({ ok: true, approved: body.approved === true, proposal_id: pending.proposalId });
    }
    if (req.method !== 'POST' || !['/api/chat', '/api/runtime/run'].includes(url.pathname)) {
      return json({ error: 'not found' }, 404);
    }

    let body: RuntimeRunRequest;
    try {
      body = await parseBody(req);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    const objective = String(body.objective ?? body.message ?? '').trim().slice(0, 20_000);
    if (!objective) return json({ error: 'message or objective is required' }, 400);
    const selectedProvider = typeof body.provider === 'string' ? body.provider : config.provider;
    if (!providerConfigurations(config).some(item => item.id === selectedProvider)) {
      return json({ error: `Unknown provider ${selectedProvider}.` }, 400);
    }
    let selection: ModelSelectionOptions;
    try {
      selection = providerSelection(
        config,
        selectedProvider,
        typeof body.model === 'string' ? body.model.slice(0, 200) : undefined,
      );
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    const selectedModel = selection.model!;
    const selectedProfile = profile(body.profile);
    if (!availableProfiles(config).includes(selectedProfile)) {
      return json({
        error: `Profile ${selectedProfile} is not configured.`,
        available_profiles: availableProfiles(config),
      }, 400);
    }
    const runId = `run:${crypto.randomUUID()}`;
    const sessionId = typeof body.session_id === 'string' && body.session_id
      ? body.session_id
      : `session:${crypto.randomUUID()}`;
    const requiredEvidence = strings(body.required_evidence, ['runtime_outcome_observed']);
    const runRegistry = registry();
    const profileCapabilities = [
      ...PROFILE_CAPABILITIES[selectedProfile],
      ...(selectedProfile === 'network'
        ? runRegistry.manifests().filter(manifest => manifest.id.startsWith('custom.http.')).map(manifest => manifest.id)
        : []),
    ];
    const authorizedCapabilities = profileCapabilities.filter(id => runRegistry.get(id) !== undefined);
    const prohibitedEffects = ALL_EFFECTS.filter(effect => {
      if (effect === 'state.read') return false;
      if (effect === 'state.write') return !authorizedCapabilities.includes('workspace.file.write');
      if (effect === 'network.request') {
        return !authorizedCapabilities.some(id =>
          id === 'network.http.get'
          || id === 'network.web.search'
          || id.startsWith('custom.http.'),
        );
      }
      if (effect === 'process.execute') return !authorizedCapabilities.includes('workspace.process.run');
      return true;
    });
    const intent: IntentContract = {
      id: `intent:${runId.slice(4)}`,
      version: CONTRACT_VERSION,
      objective,
      principals: ['agent:operator-ui'],
      authorizedCapabilities,
      authorizedResources: [
        'workspace/**',
        ...(authorizedCapabilities.includes('network.web.search') ? ['search://web'] : []),
        ...config.allowedHosts.map(host => `https://${host}/**`),
      ],
      prohibitedEffects,
      requiredConditionIds: ['condition:operator-request'],
      requiredEvidence,
      riskBudget: selectedProfile === 'inspect' ? 2 : 4,
      approvalAboveRisk: approvalThreshold(selectedProfile),
      completionCriteria: strings(body.completion_criteria, [objective]),
    };
    const now = new Date().toISOString();
    operatorStore.ensureSession(sessionId, now, objective);
    operatorStore.appendMessage(sessionId, {
      id: `message:${runId}:user`,
      role: 'user',
      content: objective,
      at: now,
      runId,
    });
    const runProjection: OperatorRun = {
      id: runId,
      sessionId,
      objective,
      status: 'running',
      profile: selectedProfile,
      provider: selectedProvider,
      model: selectedModel,
      startedAt: now,
      evidenceRefs: [],
    };
    operatorStore.recordRun(runProjection);
    const historySources: ContextSource[] = (operatorStore.messages(sessionId) ?? [])
      .filter(message => message.runId !== runId)
      .slice(-16)
      .map((message, index) => ({
        id: `history:${sessionId}:${index}:${message.id}`,
        title: `${message.role} history`,
        content: message.content,
        kind: 'conversation',
        authority: 'data',
        validity: 'active',
        provenance: [message.id],
        tags: ['conversation', message.role, selectedProfile],
        createdAt: message.at,
        priority: 45 + index,
        semanticTag: 'evidence',
        rebuildable: true,
      }));
    const memorySources: ContextSource[] = operatorStore.listMemory()
      .slice(0, 24)
      .map((memory, index) => ({
        id: `memory:${memory.id}`,
        title: 'Verified outcome memory',
        content: memory.content,
        kind: 'evidence',
        authority: 'evidence',
        validity: 'active',
        provenance: [memory.sourceRunId, ...memory.evidenceRefs],
        tags: ['memory', 'verified', selectedProfile],
        createdAt: memory.createdAt,
        priority: 60 - Math.min(index, 20),
        semanticTag: 'evidence',
        confidence: 1,
        rebuildable: true,
      }));
    const sources: ContextSource[] = [{
      id: `goal:${runId}`,
      title: 'Operator request',
      content: objective,
      kind: 'goal',
      authority: 'directive',
      validity: 'active',
      provenance: ['operator-ui'],
      tags: ['operator', selectedProfile],
      createdAt: now,
      priority: 100,
    }, ...historySources, ...memorySources];

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (frame: Record<string, unknown>) => controller.enqueue(sse(frame));
        emit({ kind: 'meta', run_id: runId, session_id: sessionId, provider: selectedProvider, model: selectedModel, profile: selectedProfile });
        const ledgerPath = join(config.ledgerDirectory, `${runId.replace(/[^a-zA-Z0-9:_-]/g, '_')}.jsonl`);
        const ledger = new HashChainLedger(new StreamingLedgerStore(ledgerPath, event => {
          for (const adapted of adaptLedgerEvent(event)) emit({ kind: 'event', event: adapted });
        }));
        void (async () => {
          try {
            const modelDriver = config.modelDriverFactory
              ? await config.modelDriverFactory(selection)
              : await createModelDriver(selection);
            const runner = new WorkflowRunner({
              model: modelDriver,
              capabilities: runRegistry,
              ledger,
            });
            ledger.append(runId, 'operator.run_started', {
              sessionId,
              objective,
              profile: selectedProfile,
              provider: selectedProvider,
              model: selectedModel,
              authorizedCapabilities,
            });
            const result = await runner.run({
              runId,
              intent,
              conditions: [{
                id: 'condition:operator-request',
                statement: 'The current operator submitted this bounded request.',
                status: 'active',
                evidenceRefs: [`request:${runId}`],
                source: 'operator-ui',
                observedAt: now,
              }],
              constraints: [
                `Operate only under the ${selectedProfile} capability profile.`,
                'Use workspace-relative targets and perform at least one relevant verified action before completion.',
                ...strings(body.constraints),
              ],
              sources,
              initialStrategyId: 'strategy:operator-request',
              focusTags: ['operator', selectedProfile],
              maxSteps: 12,
              signal: req.signal,
              requestApprovalFor: proposalId => new Promise(resolveApproval => {
                const timeout = setTimeout(() => {
                  pendingApprovals.delete(runId);
                  resolveApproval(undefined);
                }, 5 * 60_000);
                pendingApprovals.set(runId, { proposalId, resolve: resolveApproval, timeout });
                req.signal.addEventListener('abort', () => {
                  const pending = pendingApprovals.get(runId);
                  if (!pending) return;
                  clearTimeout(pending.timeout);
                  pendingApprovals.delete(runId);
                  pending.resolve(undefined);
                }, { once: true });
              }),
            });
            const observations = groundedObservations(result);
            let response = {
              answer: finalText(result),
              evidenceRefs: observations.flatMap(item => item.evidenceRefs),
              claims: observations.map(item => ({
                text: `Observed verified state for ${item.target}.`,
                evidenceRefs: item.evidenceRefs,
              })),
              caveats: result.status === 'completed'
                ? ['External content is observed data, not independently established semantic truth.']
                : [],
              model: 'runtime:deterministic-fallback',
              usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
            };
            if (result.status === 'completed' && modelDriver.synthesize) {
              try {
                const groundedRequest = {
                  objective,
                  observations,
                  completionCriteria: intent.completionCriteria,
                  requiredEvidence: intent.requiredEvidence,
                };
                response = await verifyGroundedResponse(
                  await modelDriver.synthesize(groundedRequest),
                  groundedRequest,
                  config.groundedClaimVerifier,
                );
              } catch (error) {
                ledger.append(runId, 'response.synthesis_failed', {
                  reason: error instanceof Error ? error.message : String(error),
                });
              }
            }
            ledger.append(runId, 'response.synthesized', {
              text: response.answer,
              evidenceRefs: response.evidenceRefs,
              claims: response.claims,
              caveats: response.caveats,
              model: response.model,
              usage: response.usage,
              generated: response.model !== 'runtime:deterministic-fallback',
            });
            const endedAt = new Date().toISOString();
            operatorStore.appendMessage(sessionId, {
              id: `message:${runId}:assistant`,
              role: 'assistant',
              content: response.answer,
              at: endedAt,
              runId,
              evidenceRefs: response.evidenceRefs,
              caveats: response.caveats,
            });
            if (result.status === 'completed' && observations.length > 0) {
              const memoryId = `memory:${runId}`;
              const memoryContent = JSON.stringify({
                objective,
                verifiedObservations: observations.map(item => ({
                  target: item.target,
                  value: item.value,
                  verificationCodes: item.verificationCodes,
                })),
              });
              ledger.append(runId, 'memory.verified_outcome_committed', {
                memoryId,
                sourceRunId: runId,
                evidenceRefs: response.evidenceRefs,
                content: memoryContent,
              });
              operatorStore.commitMemory({
                id: memoryId,
                sourceRunId: runId,
                sessionId,
                content: memoryContent,
                evidenceRefs: response.evidenceRefs,
                createdAt: endedAt,
                status: 'active',
              });
            }
            ledger.append(runId, 'operator.run_finished', {
              status: result.status,
              receiptHash: result.receiptHash,
              sessionId,
            });
            operatorStore.recordRun({
              ...runProjection,
              status: result.status,
              endedAt,
              receiptHash: result.receiptHash,
              evidenceRefs: response.evidenceRefs,
            });
          } catch (error) {
            operatorStore.recordRun({
              ...runProjection,
              status: 'error',
              endedAt: new Date().toISOString(),
            });
            emit({ kind: 'event', event: {
              type: 'run.error', phase: 'error', summary: error instanceof Error ? error.message : String(error),
              run_id: runId, at: Date.now(), payload: {},
            } });
          } finally {
            controller.close();
          }
        })();
      },
    });
    return new Response(stream, { headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    } });
  };
  const poll = setInterval(() => {
    const now = new Date();
    for (const schedule of operatorStore.listSchedules()) {
      if (
        !schedule.enabled
        || schedule.lastStatus === 'running'
        || Date.parse(schedule.nextRunAt) > now.getTime()
      ) continue;
      const next: OperatorSchedule = {
        ...schedule,
        updatedAt: now.toISOString(),
        nextRunAt: new Date(now.getTime() + schedule.intervalMinutes * 60_000).toISOString(),
        lastStatus: 'running',
      };
      operatorStore.upsertSchedule(next);
      void handler(new Request('http://runtime.local/api/runtime/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          objective: schedule.prompt,
          profile: schedule.profile,
          provider: schedule.provider,
          model: schedule.model,
          session_id: `session:schedule:${schedule.id}`,
        }),
      })).then(scheduledRunResult).then(result => {
        const current = operatorStore.listSchedules().find(item => item.id === schedule.id);
        if (!current) return;
        operatorStore.upsertSchedule({
          ...current,
          lastRunId: result.runId,
          lastStatus: result.status,
          updatedAt: new Date().toISOString(),
        });
      }).catch(() => {
        const current = operatorStore.listSchedules().find(item => item.id === schedule.id);
        if (current) operatorStore.upsertSchedule({ ...current, lastStatus: 'error' });
      });
    }
  }, Math.max(1_000, config.schedulerPollMs ?? 15_000));
  poll.unref?.();
  return handler;
}

function selectedProviderId(environment: Record<string, string | undefined>): string {
  const explicit = environment.HYPER_PROVIDER
    ?? environment.SHOVS_V2_PROVIDER
    ?? (environment.LLM_PROVIDER && environment.LLM_PROVIDER !== 'auto'
      ? environment.LLM_PROVIDER
      : undefined)
    ?? environment.SHOVS_PROVIDER_FALLBACK_CHAIN?.split(',').map(value => value.trim()).find(Boolean)
    ?? 'ollama';
  return ({
    'lm-studio': 'lmstudio',
    'llama.cpp': 'llamacpp',
    'open-router': 'openrouter',
  } as Record<string, string>)[explicit.toLowerCase()] ?? explicit.toLowerCase();
}

function ollamaOpenAiBaseUrl(value: string): string {
  const base = value.replace(/\/$/, '');
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

export function runtimeHttpConfig(environment = process.env): RuntimeHttpConfig {
  const provider = selectedProviderId(environment);
  const ollamaBaseUrl = environment.HYPER_OLLAMA_BASE_URL
    ?? environment.OLLAMA_BASE_URL
    ?? (provider === 'ollama' ? environment.HYPER_BASE_URL : undefined)
    ?? 'http://127.0.0.1:11434/v1';
  const anthropicBaseUrl = environment.HYPER_ANTHROPIC_BASE_URL
    ?? (provider === 'anthropic' ? environment.HYPER_BASE_URL : undefined)
    ?? 'https://api.anthropic.com/v1';
  const anthropicKeyEnvironment = environment.HYPER_ANTHROPIC_API_KEY_ENV
    ?? (provider === 'anthropic' ? environment.HYPER_API_KEY_ENV : undefined)
    ?? 'ANTHROPIC_API_KEY';
  const openaiKeyEnvironment = environment.HYPER_OPENAI_API_KEY_ENV
    ?? (provider === 'openai-compatible' ? environment.HYPER_API_KEY_ENV : undefined);
  const openaiBaseUrl = environment.HYPER_OPENAI_BASE_URL
    ?? (provider === 'openai-compatible' ? environment.HYPER_BASE_URL : undefined)
    ?? undefined;
  const selectedModel = environment.HYPER_MODEL;
  return {
    port: Number(environment.HYPER_PORT ?? environment.SHOVS_V2_PORT ?? 8791),
    workspace: resolve(environment.HYPER_WORKSPACE ?? process.cwd()),
    ledgerDirectory: resolve(environment.HYPER_LEDGER_DIR ?? join(process.cwd(), 'data', 'hyper-ledgers')),
    operatorDataPath: resolve(environment.HYPER_OPERATOR_DATA ?? join(process.cwd(), 'data', 'operator-state.json')),
    provider,
    model: selectedModel ?? (provider === 'ollama' ? environment.DEFAULT_MODEL ?? 'qwen3-vl:8b' : undefined),
    baseUrl: environment.HYPER_BASE_URL,
    apiKeyEnvironmentName: environment.HYPER_API_KEY_ENV,
    environment,
    providers: [{
      id: 'ollama',
      label: 'Ollama',
      transport: 'ollama',
      baseUrl: ollamaOpenAiBaseUrl(ollamaBaseUrl),
      defaultModel: environment.HYPER_OLLAMA_MODEL
        ?? environment.DEFAULT_MODEL
        ?? (provider === 'ollama' ? selectedModel : undefined)
        ?? 'qwen3-vl:8b',
    }, {
      id: 'anthropic',
      label: 'Anthropic',
      transport: 'anthropic',
      baseUrl: anthropicBaseUrl,
      apiKeyEnvironmentName: anthropicKeyEnvironment,
      defaultModel: environment.HYPER_ANTHROPIC_MODEL
        ?? (provider === 'anthropic' ? selectedModel : undefined),
    }, {
      id: 'openai-compatible',
      label: environment.HYPER_OPENAI_LABEL ?? 'OpenAI compatible',
      transport: 'openai-compatible',
      baseUrl: openaiBaseUrl,
      apiKeyEnvironmentName: openaiKeyEnvironment,
      defaultModel: environment.HYPER_OPENAI_MODEL
        ?? (provider === 'openai-compatible' ? selectedModel : undefined),
    }, {
      id: 'openai',
      label: 'OpenAI',
      transport: 'openai-compatible',
      baseUrl: environment.HYPER_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKeyEnvironmentName: 'OPENAI_API_KEY',
      defaultModel: environment.HYPER_OPENAI_MODEL
        ?? (provider === 'openai' ? selectedModel : undefined),
    }, {
      id: 'groq',
      label: 'Groq',
      transport: 'openai-compatible',
      baseUrl: environment.HYPER_GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
      apiKeyEnvironmentName: 'GROQ_API_KEY',
      defaultModel: environment.HYPER_GROQ_MODEL
        ?? (provider === 'groq' ? selectedModel : undefined),
    }, {
      id: 'gemini',
      label: 'Google Gemini',
      transport: 'openai-compatible',
      baseUrl: environment.HYPER_GEMINI_BASE_URL
        ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKeyEnvironmentName: 'GEMINI_API_KEY',
      defaultModel: environment.HYPER_GEMINI_MODEL
        ?? (provider === 'gemini' ? selectedModel : undefined),
    }, {
      id: 'openrouter',
      label: 'OpenRouter',
      transport: 'openai-compatible',
      baseUrl: environment.HYPER_OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
      apiKeyEnvironmentName: 'OPENROUTER_API_KEY',
      defaultModel: environment.HYPER_OPENROUTER_MODEL
        ?? (provider === 'openrouter' ? selectedModel : undefined),
    }, {
      id: 'lmstudio',
      label: 'LM Studio',
      transport: 'openai-compatible',
      baseUrl: environment.HYPER_LMSTUDIO_BASE_URL ?? environment.LMSTUDIO_BASE_URL,
      apiKeyEnvironmentName: environment.LMSTUDIO_API_KEY ? 'LMSTUDIO_API_KEY' : undefined,
      defaultModel: environment.HYPER_LMSTUDIO_MODEL
        ?? (provider === 'lmstudio' ? selectedModel : undefined),
    }, {
      id: 'llamacpp',
      label: 'llama.cpp',
      transport: 'openai-compatible',
      baseUrl: environment.HYPER_LLAMACPP_BASE_URL ?? environment.LLAMACPP_BASE_URL,
      apiKeyEnvironmentName: environment.LLAMACPP_API_KEY ? 'LLAMACPP_API_KEY' : undefined,
      defaultModel: environment.HYPER_LLAMACPP_MODEL
        ?? (provider === 'llamacpp' ? selectedModel : undefined),
    }],
    modelTimeoutMs: Number(environment.HYPER_MODEL_TIMEOUT_MS ?? 60_000),
    ...(environment.TAVILY_API_KEY ? {
      webSearch: {
        tavilyApiKey: environment.TAVILY_API_KEY,
        endpoint: environment.HYPER_TAVILY_SEARCH_URL ?? 'https://api.tavily.com/search',
        maxResults: Number(environment.HYPER_SEARCH_MAX_RESULTS ?? 8),
        timeoutMs: Number(environment.HYPER_SEARCH_TIMEOUT_MS ?? 20_000),
      },
    } : {}),
    allowedExecutables: (environment.HYPER_ALLOWED_EXECUTABLES ?? '').split(',').filter(Boolean),
    allowedHosts: (environment.HYPER_ALLOWED_HOSTS ?? '').split(',').filter(Boolean),
    schedulerPollMs: Number(environment.HYPER_SCHEDULER_POLL_MS ?? 15_000),
  };
}

if (import.meta.main) {
  const config = runtimeHttpConfig();
  Bun.serve({ port: config.port, fetch: createRuntimeHttpHandler(config) });
  console.log(`Hyper evaluated runtime listening on http://127.0.0.1:${config.port}`);
}
