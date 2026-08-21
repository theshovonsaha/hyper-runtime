import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AllowlistedHttpCapability,
  AuthenticatedGatewayIngress,
  BoundedProcessCapability,
  BoundedChannelCapability,
  ListDirectoryCapability,
  ReadFileCapability,
  ReplayableClockCapability,
  RemoteCapabilityAdapter,
  SessionKnowledgeSearchCapability,
  StreamableHttpMcpClient,
  discoverMcpCapabilities,
  WebSearchCapability,
  WriteFileCapability,
  type FileReadArgs,
  type FileWriteArgs,
  type HttpGetArgs,
  type ListDirectoryArgs,
  type ClockArgs,
  type ChannelDeliveryArgs,
  type ProcessArgs,
  type WebSearchArgs,
  type KnowledgeSearchArgs,
} from '@hyper/capabilities';
import {
  CONTRACT_VERSION,
  type ActionProposal,
  type CapabilityAdapter,
  type Condition,
  type Effect,
  type IntentContract,
} from '@hyper/contracts';
import { AuthorizedRuntime, HashChainLedger, JsonlLedgerStore, inspectReplay } from '@hyper/runtime';

const temporaryRoots: string[] = [];
const now = '2026-07-24T12:00:00.000Z';

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'hyper-runtime-test-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function workflowFixture<Args extends Record<string, unknown>>(
  capability: CapabilityAdapter<Args>,
  proposal: Omit<ActionProposal<Args>, 'intentId' | 'principalId' | 'conditionIds'>,
): { intent: IntentContract; conditions: Condition[]; proposal: ActionProposal<Args> } {
  const effects = proposal.declaredEffects;
  const intent: IntentContract = {
    id: 'intent:capability-test',
    version: CONTRACT_VERSION,
    objective: 'Exercise one bounded capability.',
    principals: ['agent:test'],
    authorizedResources: [...capability.manifest.targetPatterns],
    prohibitedEffects: ([
      'state.read',
      'state.write',
      'state.delete',
      'network.request',
      'process.execute',
    ] as Effect[]).filter(effect => !effects.includes(effect)),
    requiredConditionIds: ['condition:workspace-current'],
    requiredEvidence: proposal.expectedEvidence,
    riskBudget: 3,
    approvalAboveRisk: 3,
    completionCriteria: ['Capability observation matches the requested result.'],
  };
  return {
    intent,
    conditions: [{
      id: 'condition:workspace-current',
      statement: 'Workspace fixture is current.',
      status: 'active',
      evidenceRefs: ['fixture:setup'],
      source: 'test',
      observedAt: now,
      expiresAt: '2026-07-24T12:10:00.000Z',
    }],
    proposal: {
      ...proposal,
      intentId: intent.id,
      principalId: 'agent:test',
      conditionIds: ['condition:workspace-current'],
    },
  };
}

describe('safe external capabilities', () => {
  test('lists a bounded, sorted workspace directory and independently observes it', async () => {
    const root = temporaryWorkspace();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'b.txt'), 'b');
    writeFileSync(join(root, 'docs', 'a.txt'), 'a');
    writeFileSync(join(root, 'docs', '.secret'), 'hidden');
    const capability = new ListDirectoryCapability(root);
    const fixture = workflowFixture<ListDirectoryArgs>(capability, {
      id: 'proposal:list-directory',
      capabilityId: capability.manifest.id,
      target: 'workspace/docs',
      declaredEffects: ['state.read'],
      risk: 1,
      expectedEvidence: ['directory_entries'],
      idempotencyKey: 'list-directory:one',
      args: { maxEntries: 10 },
    });

    const outcome = await new AuthorizedRuntime().execute({ runId: 'run:list-directory', now, ...fixture, capability });

    expect(outcome.status).toBe('completed');
    expect(outcome.observation?.value).toEqual([
      { name: 'a.txt', kind: 'file' },
      { name: 'b.txt', kind: 'file' },
    ]);
  });

  test('captures an injected clock snapshot that remains stable during observation and replay', async () => {
    const capability = new ReplayableClockCapability(() => new Date(now));
    const fixture = workflowFixture<ClockArgs>(capability, {
      id: 'proposal:clock',
      capabilityId: capability.manifest.id,
      target: 'clock://now',
      declaredEffects: ['state.read'],
      risk: 1,
      expectedEvidence: ['clock_snapshot'],
      idempotencyKey: 'clock:one',
      args: { timezone: 'America/Toronto' },
    });

    const outcome = await new AuthorizedRuntime().execute({ runId: 'run:clock', now, ...fixture, capability });

    expect(outcome.status).toBe('completed');
    expect(outcome.observation?.value).toMatchObject({ instant: now, timezone: 'America/Toronto' });
  });

  test('fails closed when a configured OS sandbox backend is unavailable', async () => {
    const root = temporaryWorkspace();
    mkdirSync(join(root, 'sandbox'));
    const capability = new BoundedProcessCapability(root, {
      allowedExecutables: ['bun'],
      sandboxBackend: {
        id: 'fixture:unavailable',
        async probe() { return { available: false, detail: 'isolation service stopped' }; },
        command() { throw new Error('must not build a command'); },
      },
    });
    const fixture = workflowFixture<ProcessArgs>(capability, {
      id: 'proposal:sandbox-unavailable',
      capabilityId: capability.manifest.id,
      target: 'workspace/sandbox',
      declaredEffects: ['process.execute', 'state.read'],
      risk: 2,
      expectedEvidence: ['sandboxed_process'],
      idempotencyKey: 'sandbox:unavailable',
      args: { executable: 'bun', arguments: ['--version'] },
    });

    const outcome = await new AuthorizedRuntime().execute({ runId: 'run:sandbox-unavailable', now, ...fixture, capability });
    expect(outcome.status).toBe('execution_failed');
    expect(outcome.execution?.errorCode).toBe('SANDBOX_UNAVAILABLE');
  });

  test('authenticates gateway ingress and independently verifies allowlisted delivery', async () => {
    const ingress = new AuthenticatedGatewayIngress('ops', 'fixture-secret', ['operator:one'], () => now);
    expect(ingress.receive('fixture-secret', { sender: 'operator:one', messageId: 'm1', content: 'Run the bounded task.' }))
      .toMatchObject({ channelId: 'ops', sender: 'operator:one', provenance: ['gateway:ops', 'sender:operator:one', 'message:m1'] });
    expect(() => ingress.receive('wrong-secret', { sender: 'operator:one', messageId: 'm2', content: 'no' }))
      .toThrow('GATEWAY_AUTHENTICATION_FAILED');

    const capability = new BoundedChannelCapability({
      id: 'ops',
      allowedRecipients: ['operator:one'],
      transport: {
        async send(input) { return { deliveryId: `delivery:${input.idempotencyKey}`, recipient: input.recipient, status: 'accepted', observedAt: now }; },
        async observe(deliveryId) { return { deliveryId, recipient: 'operator:one', status: 'delivered', observedAt: now }; },
      },
    });
    const fixture = workflowFixture<ChannelDeliveryArgs>(capability, {
      id: 'proposal:channel',
      capabilityId: capability.manifest.id,
      target: 'channel://ops/operator:one',
      declaredEffects: ['network.request', 'state.write'],
      risk: 2,
      expectedEvidence: ['channel_delivery'],
      idempotencyKey: 'channel:one',
      args: { recipient: 'operator:one', content: 'Verified update.' },
    });
    const outcome = await new AuthorizedRuntime().execute({
      runId: 'run:channel', now, ...fixture, capability,
      approval: { id: 'approval:channel', proposalId: fixture.proposal.id, principalId: fixture.proposal.principalId, issuedAt: now, expiresAt: '2026-07-24T12:05:00.000Z' },
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.verification?.reasonCodes).toContain('CHANNEL_DELIVERY_OBSERVED');
  });

  test('normalizes and verifies bounded server-side web search results', async () => {
    let authorization = '';
    const capability = new WebSearchCapability({
      tavilyApiKey: 'test-search-key',
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        return Response.json({
          request_id: 'search-request:test',
          results: [{
            title: 'Budget pressures in Canada',
            url: 'https://example.ca/budget',
            content: 'Households report food and housing cost pressure.',
            score: 0.92,
          }],
        });
      },
    });
    const fixture = workflowFixture<WebSearchArgs>(capability, {
      id: 'proposal:web-search',
      capabilityId: capability.manifest.id,
      target: 'search://web',
      declaredEffects: ['network.request'],
      risk: 1,
      expectedEvidence: ['web_results_observed'],
      idempotencyKey: 'web-search:one',
      args: { query: 'recent budgeting pain points in Canada', maxResults: 5 },
    });

    const outcome = await new AuthorizedRuntime().execute({
      runId: 'run:web-search',
      now,
      ...fixture,
      capability,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.observation?.target).toBe('search://web');
    expect(outcome.verification?.reasonCodes).toContain('WEB_SEARCH_RESULTS_OBSERVED');
    expect(authorization).toBe('Bearer test-search-key');
  });

  test('reproduces session knowledge result identities and reports embedding degradation', async () => {
    let calls = 0;
    const capability = new SessionKnowledgeSearchCapability(async input => {
      calls += 1;
      return {
        sessionId: input.sessionId,
        query: input.query,
        embeddingAvailable: false,
        limitation: 'No embedding model configured.',
        results: [{
          chunkId: 'chunk:one',
          documentId: 'file:one',
          content: 'A provenance-linked runtime fact.',
          score: 0.8,
          retrievalMode: 'lexical',
          provenance: ['ingestion:one', 'file:one', 'chunk:one'],
        }],
      };
    });
    const fixture = workflowFixture<KnowledgeSearchArgs>(capability, {
      id: 'proposal:knowledge-search',
      capabilityId: capability.manifest.id,
      target: 'session://knowledge/session%3Aone',
      declaredEffects: ['state.read'],
      risk: 0,
      expectedEvidence: ['session_knowledge_observed'],
      idempotencyKey: 'knowledge-search:one',
      args: { query: 'runtime fact' },
    });
    const outcome = await new AuthorizedRuntime().execute({
      runId: 'run:knowledge-search', now, ...fixture, capability,
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.verification?.reasonCodes).toEqual([
      'SESSION_KNOWLEDGE_SEARCH_REPRODUCED',
      'EMBEDDING_UNAVAILABLE_DEGRADED_MODE',
    ]);
    expect(calls).toBe(2);
  });

  test('falls back to the next configured search provider without exposing credentials', async () => {
    const requested: string[] = [];
    const capability = new WebSearchCapability({
      tavilyApiKey: 'broken-tavily-key',
      braveApiKey: 'working-brave-key',
      fetchImpl: async (input, init) => {
        requested.push(String(input));
        if (String(input).includes('tavily')) return new Response('unavailable', { status: 503 });
        expect(new Headers(init?.headers).get('x-subscription-token')).toBe('working-brave-key');
        return Response.json({
          web: { results: [{ title: 'Canadian household budgets', url: 'https://example.ca', description: 'Current pressures.' }] },
        });
      },
    });
    const fixture = workflowFixture<WebSearchArgs>(capability, {
      id: 'proposal:web-search-fallback',
      capabilityId: capability.manifest.id,
      target: 'search://web',
      declaredEffects: ['network.request'],
      risk: 1,
      expectedEvidence: ['web_results_observed'],
      idempotencyKey: 'web-search:fallback',
      args: { query: 'Canada household budgets' },
    });

    const outcome = await new AuthorizedRuntime().execute({
      runId: 'run:web-search-fallback',
      now,
      ...fixture,
      capability,
    });

    expect(outcome.status).toBe('completed');
    expect(requested).toHaveLength(2);
    expect(outcome.observation?.value).toMatchObject({ provider: 'brave' });
  });

  test('propagates operator cancellation through an in-flight web request and commits a receipt', async () => {
    const controller = new AbortController();
    const capability = new WebSearchCapability({
      tavilyApiKey: 'test-key',
      fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        controller.abort(new DOMException('Cancelled by operator.', 'AbortError'));
      }),
    });
    const fixture = workflowFixture<WebSearchArgs>(capability, {
      id: 'proposal:web-search-cancel', capabilityId: capability.manifest.id, target: 'search://web',
      declaredEffects: ['network.request'], risk: 1, expectedEvidence: ['web_results_observed'],
      idempotencyKey: 'web-search:cancel', args: { query: 'Canada household budgets' },
    });
    const runtime = new AuthorizedRuntime();
    const outcome = await runtime.execute({
      runId: 'run:web-search-cancel', now, ...fixture, capability, signal: controller.signal,
    });
    expect(outcome).toMatchObject({ status: 'execution_failed', execution: { errorCode: 'CAPABILITY_EXECUTION_THROWN' } });
    expect(runtime.ledger.all().at(-1)?.type).toBe('action.receipt');
  });

  test('writes and independently observes a workspace file', async () => {
    const root = temporaryWorkspace();
    const capability = new WriteFileCapability(root);
    const fixture = workflowFixture<FileWriteArgs>(capability, {
      id: 'proposal:write',
      capabilityId: capability.manifest.id,
      target: 'workspace/reports/result.txt',
      declaredEffects: ['state.write'],
      risk: 1,
      expectedEvidence: ['file_content'],
      idempotencyKey: 'write:one',
      args: { content: 'verified result' },
    });

    const outcome = await new AuthorizedRuntime().execute({
      runId: 'run:file-write',
      now,
      ...fixture,
      capability,
    });

    expect(outcome.status).toBe('completed');
    expect(readFileSync(join(root, 'reports/result.txt'), 'utf8')).toBe('verified result');
  });

  test('rejects traversal and symbolic-link targets', async () => {
    const root = temporaryWorkspace();
    mkdirSync(join(root, 'inside'));
    symlinkSync(tmpdir(), join(root, 'inside/link'));
    const capability = new ReadFileCapability(root);
    const traversal = workflowFixture<FileReadArgs>(capability, {
      id: 'proposal:traversal',
      capabilityId: capability.manifest.id,
      target: 'workspace/../outside.txt',
      declaredEffects: ['state.read'],
      risk: 1,
      expectedEvidence: ['file_read'],
      idempotencyKey: 'read:traversal',
      args: {},
    });
    const linked = workflowFixture<FileReadArgs>(capability, {
      id: 'proposal:symlink',
      capabilityId: capability.manifest.id,
      target: 'workspace/inside/link/file.txt',
      declaredEffects: ['state.read'],
      risk: 1,
      expectedEvidence: ['file_read'],
      idempotencyKey: 'read:symlink',
      args: {},
    });

    const first = await new AuthorizedRuntime().execute({
      runId: 'run:traversal',
      now,
      ...traversal,
      capability,
    });
    const second = await new AuthorizedRuntime().execute({
      runId: 'run:symlink',
      now,
      ...linked,
      capability,
    });

    expect(first.status).toBe('execution_failed');
    expect(second.status).toBe('execution_failed');
  });

  test('runs only an allowlisted executable without a shell', async () => {
    const root = temporaryWorkspace();
    const capability = new BoundedProcessCapability(root, {
      allowedExecutables: ['bun'],
      environment: { PATH: process.env.PATH ?? '' },
    });
    const fixture = workflowFixture<ProcessArgs>(capability, {
      id: 'proposal:process',
      capabilityId: capability.manifest.id,
      target: 'workspace/project',
      declaredEffects: ['process.execute'],
      risk: 2,
      expectedEvidence: ['exit_code'],
      idempotencyKey: 'process:one',
      args: {
        executable: 'bun',
        arguments: ['--version'],
        expectedExitCode: 0,
      },
    });
    mkdirSync(join(root, 'project'));

    const outcome = await new AuthorizedRuntime().execute({
      runId: 'run:process',
      now,
      ...fixture,
      capability,
    });
    expect(outcome.status).toBe('completed');
  });

  test('validates every HTTP target before a mocked request', async () => {
    const capability = new AllowlistedHttpCapability({
      allowedHosts: ['example.com'],
      resolveHost: async () => ['93.184.216.34'],
      fetchImpl: async () => new Response('fresh evidence', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    });
    const fixture = workflowFixture<HttpGetArgs>(capability, {
      id: 'proposal:http',
      capabilityId: capability.manifest.id,
      target: 'https://example.com/evidence',
      declaredEffects: ['network.request'],
      risk: 1,
      expectedEvidence: ['http_response'],
      idempotencyKey: 'http:one',
      args: {
        url: 'https://example.com/evidence',
        expectedStatus: 200,
      },
    });

    const outcome = await new AuthorizedRuntime().execute({
      runId: 'run:http',
      now,
      ...fixture,
      capability,
    });
    expect(outcome.status).toBe('completed');
  });

  test('blocks an allowlisted hostname when DNS resolves privately', async () => {
    const capability = new AllowlistedHttpCapability({
      allowedHosts: ['example.com'],
      resolveHost: async () => ['127.0.0.1'],
      fetchImpl: async () => {
        throw new Error('fetch must not be reached');
      },
    });
    const fixture = workflowFixture<HttpGetArgs>(capability, {
      id: 'proposal:ssrf',
      capabilityId: capability.manifest.id,
      target: 'https://example.com/internal',
      declaredEffects: ['network.request'],
      risk: 1,
      expectedEvidence: ['http_response'],
      idempotencyKey: 'http:ssrf',
      args: { url: 'https://example.com/internal' },
    });
    const outcome = await new AuthorizedRuntime().execute({
      runId: 'run:ssrf',
      now,
      ...fixture,
      capability,
    });
    expect(outcome.status).toBe('execution_failed');
    expect(outcome.execution?.errorCode).toBe('HTTP_REQUEST_FAILED');
  });

  test('revalidates a custom HTTP path boundary after redirects', async () => {
    const requested: string[] = [];
    const capability = new AllowlistedHttpCapability({
      id: 'custom.http.status',
      allowedHosts: ['example.com'],
      pathPrefixes: { 'example.com': ['/v1/status'] },
      resolveHost: async () => ['93.184.216.34'],
      fetchImpl: async input => {
        requested.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: '/private/secrets' },
        });
      },
    });
    expect(capability.manifest.targetPatterns).toContain('https://example.com/v1/status');
    const fixture = workflowFixture<HttpGetArgs>(capability, {
      id: 'proposal:path-bounded-http',
      capabilityId: capability.manifest.id,
      target: 'https://example.com/v1/status',
      declaredEffects: ['network.request'],
      risk: 1,
      expectedEvidence: ['http_response'],
      idempotencyKey: 'http:path-boundary',
      args: { url: 'https://example.com/v1/status' },
    });

    const outcome = await new AuthorizedRuntime().execute({
      runId: 'run:path-bounded-http',
      now,
      ...fixture,
      capability,
    });

    expect(outcome.status).toBe('execution_failed');
    expect(outcome.execution?.errorCode).toBe('HTTP_REQUEST_FAILED');
    expect(requested).toEqual(['https://example.com/v1/status']);
  });
});

describe('persistent replay', () => {
  test('reloads and verifies a JSONL hash chain', () => {
    const root = temporaryWorkspace();
    const path = join(root, 'run.jsonl');
    const first = new HashChainLedger(new JsonlLedgerStore(path));
    first.append('run:persistent', 'workflow.started', { objective: 'test' });
    first.append('run:persistent', 'workflow.receipt', { status: 'completed', passed: true });

    const loaded = new HashChainLedger(new JsonlLedgerStore(path));
    expect(inspectReplay(loaded)).toMatchObject({
      valid: true,
      eventCount: 2,
      runIds: ['run:persistent'],
      runs: [{
        runId: 'run:persistent',
        eventCount: 2,
        status: 'completed',
      }],
    });
  });

  test('rejects JSON values that are not ledger events', () => {
    const root = temporaryWorkspace();
    const path = join(root, 'invalid.jsonl');
    writeFileSync(path, '{"looks":"like json"}\n');
    expect(() => new HashChainLedger(new JsonlLedgerStore(path))).toThrow(
      'Invalid ledger JSON or event schema at line 1.',
    );
  });
});

describe('remote capability boundary', () => {
  test('discovers only server-authorized MCP tools with an independent observation pair', async () => {
    const methods: string[] = [];
    const client = new StreamableHttpMcpClient({
      endpoint: 'https://mcp.example.test/mcp',
      allowedEndpoints: ['https://mcp.example.test/mcp'],
      authorization: 'Bearer server-secret',
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: Record<string, unknown> };
        methods.push(request.method);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-secret');
        const result = request.method === 'initialize'
          ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : request.method === 'tools/list'
            ? { tools: [
                { name: 'ticket_create', description: 'Create a ticket', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
                { name: 'ticket_observe', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
                { name: 'dangerous_unmapped', inputSchema: { type: 'object' } },
              ] }
            : { structuredContent: { exists: true, title: 'Bounded ticket' }, content: [] };
        return Response.json({ jsonrpc: '2.0', id: request.id, result }, { headers: { 'mcp-session-id': 'fixture-session' } });
      },
    });
    const [capability] = await discoverMcpCapabilities(client, [{
      toolName: 'ticket_create',
      observationToolName: 'ticket_observe',
      effects: ['network.request', 'state.write'],
      requiredEffects: ['network.request', 'state.write'],
      targetPatterns: ['mcp://tickets/**'],
      riskCeiling: 4,
      approval: 'risk_based',
    }]);
    expect(capability).toBeDefined();
    expect(capability!.manifest.id).toBe('mcp.ticket_create');
    expect(capability!.manifest.requiredEffects).toEqual(['network.request', 'state.write']);

    const fixture = workflowFixture(capability!, {
      id: 'proposal:mcp-ticket',
      capabilityId: capability!.manifest.id,
      target: 'mcp://tickets/new',
      declaredEffects: ['network.request', 'state.write'],
      risk: 2,
      expectedEvidence: ['ticket_observed'],
      idempotencyKey: 'mcp-ticket:one',
      args: { title: 'Bounded ticket' },
    });
    const outcome = await new AuthorizedRuntime().execute({ runId: 'run:mcp', now, ...fixture, capability: capability! });

    expect(outcome.status).toBe('completed');
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'tools/call']);
  });

  test('rejects MCP endpoints outside the server allowlist', () => {
    expect(() => new StreamableHttpMcpClient({
      endpoint: 'https://untrusted.example/mcp',
      allowedEndpoints: ['https://trusted.example/mcp'],
    })).toThrow('MCP endpoint is not in the server allowlist.');
  });

  test('requires an explicit manifest and delegates only after grant validation', async () => {
    let executions = 0;
    const capability = new RemoteCapabilityAdapter({
      id: 'remote.lookup',
      version: '1.0.0',
      effects: ['state.read'],
      targetPatterns: ['workspace/**'],
      riskCeiling: 2,
      approval: 'never',
      idempotent: true,
      verification: 'required',
    }, {
      async execute() {
        executions += 1;
        return { success: true, summary: 'remote result', evidence: [] };
      },
      async observe(_manifest, proposal) {
        return {
          target: proposal.target,
          exists: true,
          value: 'remote result',
          evidence: [{
            id: 'observation:remote',
            kind: 'observation',
            source: 'remote.lookup',
          }],
        };
      },
      async verify(_manifest, _proposal, execution, observation) {
        return {
          passed: execution.success && observation.exists,
          reasonCodes: ['REMOTE_RESULT_OBSERVED'],
          evidence: observation.evidence,
        };
      },
    });
    const fixture = workflowFixture<Record<string, unknown>>(capability, {
      id: 'proposal:remote',
      capabilityId: capability.manifest.id,
      target: 'workspace/remote',
      declaredEffects: ['state.read'],
      risk: 1,
      expectedEvidence: ['remote_result'],
      idempotencyKey: 'remote:one',
      args: {},
    });
    const result = await new AuthorizedRuntime().execute({
      runId: 'run:remote',
      now,
      ...fixture,
      capability,
    });
    expect(result.status).toBe('completed');
    expect(executions).toBe(1);
  });
});
