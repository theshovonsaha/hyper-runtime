import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRuntimeHttpHandler,
  replayLedger,
  runtimeHttpConfig,
  runTask,
  type HyperTaskFile,
} from '@hyper/cli';
import type { WorkflowProposal } from '@hyper/contracts';
import type { ModelDriver } from '@hyper/model';

const roots: string[] = [];
const now = '2026-07-24T12:00:00.000Z';

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hyper-cli-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('practical CLI workflow', () => {
  test('runs a versioned task file, writes a real file, and persists replay', async () => {
    const root = temporaryRoot();
    const taskPath = join(root, 'task.json');
    const proposalsPath = join(root, 'proposals.json');
    const ledgerPath = join(root, 'run.jsonl');
    const task: HyperTaskFile = {
      version: '0.2.0',
      runId: 'run:cli-practical',
      intentId: 'intent:cli-practical',
      objective: 'Write and observe a verified result file.',
      principalId: 'agent:cli',
      authorizedCapabilities: ['workspace.file.read', 'workspace.file.write'],
      authorizedResources: ['workspace/**'],
      prohibitedEffects: ['state.delete', 'network.request', 'process.execute'],
      requiredEvidence: ['result_file_observed'],
      completionCriteria: ['workspace/result.txt contains practical runtime'],
      riskBudget: 2,
      approvalAboveRisk: 3,
      constraints: ['Only modify workspace/result.txt.'],
      conditions: [{
        id: 'condition:workspace-current',
        statement: 'The temporary workspace is current.',
        status: 'active',
        evidenceRefs: ['test:workspace'],
        source: 'cli-test',
        observedAt: now,
        expiresAt: '2026-07-24T12:10:00.000Z',
      }],
      sources: [{
        id: 'goal:cli',
        title: 'CLI task directive',
        content: 'Create the requested result and verify it.',
        kind: 'goal',
        authority: 'directive',
        validity: 'active',
        provenance: ['task.json'],
        tags: ['result'],
        createdAt: now,
        priority: 100,
      }],
      initialStrategyId: 'strategy:write',
      focusTags: ['result'],
      maxSteps: 4,
    };
    const proposals: WorkflowProposal[] = [
      {
        kind: 'action',
        strategyId: 'strategy:write',
        hypothesis: 'An atomic bounded write will establish the requested file.',
        expectedObservation: 'workspace/result.txt contains practical runtime',
        action: {
          id: 'proposal:cli-write',
          intentId: task.intentId,
          principalId: task.principalId,
          conditionIds: ['condition:workspace-current'],
          capabilityId: 'workspace.file.write',
          target: 'workspace/result.txt',
          declaredEffects: ['state.write'],
          risk: 1,
          expectedEvidence: ['result_file_observed'],
          idempotencyKey: 'cli-write:one',
          args: { content: 'practical runtime' },
        },
      },
      {
        kind: 'complete',
        strategyId: 'strategy:write',
        evidenceRefs: ['result_file_observed'],
      },
    ];
    writeFileSync(taskPath, JSON.stringify(task));
    writeFileSync(proposalsPath, JSON.stringify(proposals));

    const result = await runTask({
      taskPath,
      workspace: root,
      ledgerPath,
      provider: 'scripted',
      proposalsPath,
      now: () => now,
    });

    expect(result.status).toBe('completed');
    expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('practical runtime');
    expect(replayLedger(ledgerPath)).toMatchObject({
      valid: true,
      runIds: ['run:cli-practical'],
    });
  });

  test('runs a generated-ID multi-tool workflow through read, process, and write', async () => {
    const root = temporaryRoot();
    const taskPath = join(root, 'multi-task.json');
    const proposalsPath = join(root, 'multi-proposals.json');
    const ledgerPath = join(root, 'multi-run.jsonl');
    writeFileSync(join(root, 'input.txt'), 'source evidence');
    mkdirSync(join(root, 'runtime'));
    const task: HyperTaskFile = {
      version: '0.2.0',
      intentId: 'intent:cli-multi-tool',
      objective: 'Inspect input, run a bounded diagnostic, and write a verified report.',
      principalId: 'agent:cli',
      authorizedCapabilities: [
        'workspace.file.read',
        'workspace.process.run',
        'workspace.file.write',
      ],
      authorizedResources: ['workspace/**'],
      prohibitedEffects: ['state.delete', 'network.request'],
      requiredEvidence: ['source_read', 'diagnostic_exit', 'report_observed'],
      completionCriteria: ['All three bounded capability results were observed.'],
      riskBudget: 2,
      approvalAboveRisk: 3,
      constraints: ['Use only the configured workspace capabilities.'],
      conditions: [{
        id: 'condition:workspace-current',
        statement: 'The workspace fixture is current.',
        status: 'active',
        evidenceRefs: ['test:workspace'],
        source: 'cli-test',
        observedAt: now,
        expiresAt: '2026-07-24T12:10:00.000Z',
      }],
      initialStrategyId: 'strategy:multi-tool',
      allowedExecutables: ['bun'],
      maxSteps: 5,
    };
    const common = {
      intentId: task.intentId,
      principalId: task.principalId,
      conditionIds: ['condition:workspace-current'],
      risk: 1 as const,
    };
    const proposals: WorkflowProposal[] = [{
      kind: 'action',
      strategyId: task.initialStrategyId,
      hypothesis: 'The source file is readable.',
      expectedObservation: 'The source content is observed.',
      action: {
        ...common,
        id: 'proposal:multi-read',
        capabilityId: 'workspace.file.read',
        target: 'workspace/input.txt',
        declaredEffects: ['state.read'],
        expectedEvidence: ['source_read'],
        idempotencyKey: 'multi:read',
        args: {},
      },
    }, {
      kind: 'action',
      strategyId: task.initialStrategyId,
      hypothesis: 'The bounded runtime diagnostic exits successfully.',
      expectedObservation: 'Bun reports an exit code of zero.',
      action: {
        ...common,
        id: 'proposal:multi-process',
        capabilityId: 'workspace.process.run',
        target: 'workspace/runtime',
        declaredEffects: ['process.execute'],
        expectedEvidence: ['diagnostic_exit'],
        idempotencyKey: 'multi:process',
        args: { executable: 'bun', arguments: ['--version'], expectedExitCode: 0 },
      },
    }, {
      kind: 'action',
      strategyId: task.initialStrategyId,
      hypothesis: 'A bounded write creates the final report.',
      expectedObservation: 'The report content is independently observed.',
      action: {
        ...common,
        id: 'proposal:multi-write',
        capabilityId: 'workspace.file.write',
        target: 'workspace/report.txt',
        declaredEffects: ['state.write'],
        expectedEvidence: ['report_observed'],
        idempotencyKey: 'multi:write',
        args: { content: 'multi-tool workflow verified' },
      },
    }, {
      kind: 'complete',
      strategyId: task.initialStrategyId,
      evidenceRefs: ['source_read', 'diagnostic_exit', 'report_observed'],
    }];
    writeFileSync(taskPath, JSON.stringify(task));
    writeFileSync(proposalsPath, JSON.stringify(proposals));

    const result = await runTask({
      taskPath,
      workspace: root,
      ledgerPath,
      provider: 'scripted',
      proposalsPath,
      now: () => now,
    });

    expect(result.status).toBe('completed');
    expect(result.runId).toStartWith('run:');
    expect(result.steps.filter(step => step.proposal.kind === 'action')).toHaveLength(3);
    expect(readFileSync(join(root, 'report.txt'), 'utf8')).toBe('multi-tool workflow verified');
    expect(replayLedger(ledgerPath).runs[0]).toMatchObject({
      runId: result.runId,
      status: 'completed',
    });
  });

  test('streams the evaluated runtime through the UI HTTP contract', async () => {
    const root = temporaryRoot();
    const ledgerDirectory = join(root, 'ledgers');
    writeFileSync(join(root, 'input.txt'), 'operator evidence');
    let step = 0;
    const model: ModelDriver = {
      async propose(_packet, _capabilities, scope) {
        step += 1;
        return {
          proposal: step === 1 ? {
            kind: 'action',
            strategyId: scope.activeStrategyId,
            hypothesis: 'The operator input file can be observed.',
            expectedObservation: 'workspace/input.txt contains operator evidence.',
            action: {
              id: 'proposal:http-read',
              intentId: scope.intentId,
              principalId: scope.principalId,
              conditionIds: scope.requiredConditionIds,
              capabilityId: 'workspace.file.read',
              target: 'workspace/input.txt',
              declaredEffects: ['state.read'],
              risk: 1,
              expectedEvidence: scope.requiredEvidence,
              idempotencyKey: 'http-read:one',
              args: {},
            },
          } : {
            kind: 'complete',
            strategyId: scope.activeStrategyId,
            evidenceRefs: scope.requiredEvidence,
          },
          usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 },
          model: 'test:http-driver',
        };
      },
      async synthesize(request) {
        return {
          answer: 'I inspected the requested file and verified its contents.',
          evidenceRefs: request.observations.flatMap(item => item.evidenceRefs),
          claims: [{
            text: 'The requested file was inspected.',
            evidenceRefs: request.observations.flatMap(item => item.evidenceRefs),
          }],
          caveats: [],
          model: 'test:http-response-driver',
          usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 },
        };
      },
    };
    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory,
      provider: 'ollama',
      model: 'test-model',
      allowedExecutables: [],
      allowedHosts: [],
      modelDriverFactory: () => model,
    });
    const config = await handler(new Request('http://runtime.local/api/config'));
    expect(await config.json()).toMatchObject({
      runtime: 'hyper-evaluated',
      profiles: ['inspect', 'workspace'],
      approval_thresholds: { inspect: 5, workspace: 4 },
      verification: {
        observed_state: true,
        arbitrary_semantic_claims: false,
      },
      memory: { durable_agent_memory: true, commit_policy: 'verified_outcomes_only' },
      features: { bounded_pass_signals: true, correction_candidate_review: true },
    });

    const response = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Read workspace/input.txt and verify it.',
        profile: 'inspect',
        provider: 'ollama',
        model: 'operator-selected-model',
      }),
    }));
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = (await response.text()).split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as Record<string, any>);
    const meta = frames.find(frame => frame.kind === 'meta');
    const eventTypes = frames
      .filter(frame => frame.kind === 'event')
      .map(frame => frame.event.type);

    expect(meta?.run_id).toStartWith('run:');
    expect(meta?.model).toBe('operator-selected-model');
    expect(eventTypes).toContain('tool.call');
    expect(eventTypes).toContain('tool.result');
    expect(eventTypes).toContain('respond.final');
    expect(eventTypes).toContain('receipt.commit');
    expect(eventTypes).toContain('memory.commit');
    expect(eventTypes.at(-1)).toBe('run.end');
    expect(frames.find(frame => frame.event?.type === 'context.packet')).toMatchObject({
      event: {
        payload: {
          objective: 'Read workspace/input.txt and verify it.',
          legalCapabilityIds: ['workspace.file.read'],
          outputContract: ['action', 'pivot', 'ask', 'complete'],
          audit: { sourcesConsidered: 1 },
        },
      },
    });
    expect(frames.find(frame => frame.event?.type === 'respond.final')?.event.payload.text)
      .toContain('verified its contents');
    expect(replayLedger(join(ledgerDirectory, `${meta?.run_id}.jsonl`))).toMatchObject({
      valid: true,
      runs: [{ runId: meta?.run_id, status: 'completed' }],
    });
    const sessions = await handler(new Request('http://runtime.local/api/sessions'));
    expect(((await sessions.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);
    const messages = await handler(new Request(
      `http://runtime.local/api/sessions/${encodeURIComponent(meta?.session_id)}/messages`,
    ));
    expect(((await messages.json()) as { messages: unknown[] }).messages).toHaveLength(2);
    const memory = await handler(new Request('http://runtime.local/api/memory'));
    expect(((await memory.json()) as { memory: unknown[] }).memory).toHaveLength(1);
    const passMetrics = await handler(new Request(
      `http://runtime.local/api/runs/${encodeURIComponent(meta?.run_id)}/pass-metrics`,
    ));
    expect(await passMetrics.json()).toMatchObject({
      run_id: meta?.run_id,
      metrics: { passes_audited: 2 },
    });
    const signals = await handler(new Request('http://runtime.local/api/signals'));
    expect(await signals.json()).toMatchObject({
      aggregate: { passes_audited: 2 },
      runs: [{ id: meta?.run_id }],
    });
    const restarted = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory,
      provider: 'ollama',
      model: 'test-model',
      allowedExecutables: [],
      allowedHosts: [],
      modelDriverFactory: () => model,
    });
    const resumedSessions = await restarted(new Request('http://runtime.local/api/sessions'));
    expect(((await resumedSessions.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  test('persists bounded custom tools and schedules without expanding host authority', async () => {
    const root = temporaryRoot();
    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory: join(root, 'ledgers'),
      provider: 'ollama',
      model: 'test-model',
      allowedExecutables: [],
      allowedHosts: ['api.example.com'],
      schedulerPollMs: 60_000,
      modelDriverFactory: () => ({ async propose() { throw new Error('not called'); } }),
    });
    const tool = await handler(new Request('http://runtime.local/api/custom_tools', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'status_lookup',
        description: 'Read service status.',
        host: 'api.example.com',
        path_prefix: '/v1/status',
      }),
    }));
    expect(tool.status).toBe(201);
    const config = await handler(new Request('http://runtime.local/api/config'));
    expect(((await config.json()) as { capabilities: Array<{ id: string }> }).capabilities.map(item => item.id))
      .toContain('custom.http.status_lookup');
    const denied = await handler(new Request('http://runtime.local/api/custom_tools', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'escape_host',
        description: 'Should be denied.',
        host: 'outside.example.com',
      }),
    }));
    expect(denied.status).toBe(400);
    const schedule = await handler(new Request('http://runtime.local/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Inspect workspace status.', profile: 'inspect', interval_minutes: 60 }),
    }));
    expect(schedule.status).toBe(201);
    expect(await schedule.clone().json()).toMatchObject({
      schedule: { provider: 'ollama', model: 'test-model' },
    });
    const schedules = await handler(new Request('http://runtime.local/api/schedules'));
    expect(((await schedules.json()) as { schedules: unknown[] }).schedules).toHaveLength(1);
    const correction = await handler(new Request('http://runtime.local/api/corrections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        observed: 'The result was generic.',
        mismatch: 'The answer omitted the requested implementation detail.',
        correction: 'Require concrete file and behavior references.',
        reusable_rule: 'When specificity is requested, cite the affected artifact and behavior.',
        trigger_codes: ['INTENT_ALIGNMENT_MISMATCH'],
      }),
    }));
    expect(correction.status).toBe(201);
    const correctionRecord = (await correction.json()) as { correction: { id: string } };
    const accepted = await handler(new Request(
      `http://runtime.local/api/corrections/${encodeURIComponent(correctionRecord.correction.id)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'accepted_for_experiment' }),
      },
    ));
    expect(await accepted.json()).toMatchObject({
      correction: { status: 'accepted_for_experiment' },
    });
    const corrections = await handler(new Request('http://runtime.local/api/corrections'));
    expect(await corrections.json()).toMatchObject({
      corrections: [{
        id: correctionRecord.correction.id,
        status: 'accepted_for_experiment',
      }],
    });
  });

  test('discovers only configured provider models and reports live connection state', async () => {
    const root = temporaryRoot();
    const requested: string[] = [];
    let selectedProvider: string | undefined;
    let selectedModel: string | undefined;
    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory: join(root, 'ledgers'),
      provider: 'ollama',
      model: 'llama3.2',
      providers: [{
        id: 'openai-compatible',
        label: 'Local Studio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        defaultModel: 'local-model',
      }],
      providerFetch: async input => {
        const url = String(input);
        requested.push(url);
        return url.includes('/api/tags')
          ? Response.json({ models: [{ name: 'llama3.2', size: 42 }] })
          : Response.json({ data: [{ id: 'local-model', owned_by: 'local' }] });
      },
      allowedExecutables: [],
      allowedHosts: [],
      schedulerPollMs: 60_000,
      modelDriverFactory: selection => ({
        async propose(_packet, _capabilities, scope) {
          selectedProvider = selection?.provider;
          selectedModel = selection?.model;
          return {
            proposal: {
              kind: 'ask',
              strategyId: scope.activeStrategyId,
              question: 'Provide the missing bounded target.',
              reason: 'Connection selection test.',
            },
            model: 'test:dynamic-provider',
            usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 },
          };
        },
      }),
    });

    const providers = await handler(new Request('http://runtime.local/api/providers'));
    expect(await providers.json()).toMatchObject({
      providers: [{ id: 'ollama', connected: true }, { id: 'openai-compatible', connected: true }],
    });
    const models = await handler(new Request('http://runtime.local/api/models/openai-compatible'));
    expect(await models.json()).toMatchObject({
      provider: 'openai-compatible',
      connected: true,
      models: [{ id: 'local-model', owned_by: 'local' }],
    });
    expect(requested.some(url => url === 'http://127.0.0.1:11434/api/tags')).toBeTrue();
    expect(requested.some(url => url === 'http://127.0.0.1:1234/v1/models')).toBeTrue();

    const run = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Use the selected local model.',
        provider: 'openai-compatible',
        model: 'local-model',
      }),
    }));
    await run.text();
    expect(selectedProvider).toBe('openai-compatible');
    expect(selectedModel).toBe('local-model');
  });

  test('normalizes legacy .env providers into selectable evaluated transports', async () => {
    const root = temporaryRoot();
    const requested: Array<{ url: string; authorization?: string }> = [];
    const config = runtimeHttpConfig({
      SHOVS_V2_PROVIDER: 'gemini',
      SHOVS_PROVIDER_FALLBACK_CHAIN: 'gemini,groq,ollama',
      DEFAULT_MODEL: 'llama3.2',
      OLLAMA_BASE_URL: 'http://localhost:11434',
      LMSTUDIO_BASE_URL: 'http://localhost:1234/v1',
      LLAMACPP_BASE_URL: 'http://127.0.0.1:8080/v1',
      GEMINI_API_KEY: 'test-gemini-key',
      GROQ_API_KEY: 'test-groq-key',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      OPENROUTER_API_KEY: 'test-openrouter-key',
      TAVILY_API_KEY: 'test-search-key',
      PATH: process.env.PATH,
      HYPER_WORKSPACE: root,
      HYPER_LEDGER_DIR: join(root, 'ledgers'),
      HYPER_OPERATOR_DATA: join(root, 'operator.json'),
    });
    config.providerFetch = async (input, init) => {
      requested.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      });
      return Response.json({ data: [{ id: 'gemini-2.5-flash', owned_by: 'google' }] });
    };
    config.modelDriverFactory = selection => ({
      async propose(_packet, _capabilities, scope) {
        return {
          proposal: {
            kind: 'ask',
            strategyId: scope.activeStrategyId,
            question: 'Provide the target.',
            reason: `Selected ${selection?.provider}.`,
          },
          usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 },
          model: 'test:legacy-provider-normalization',
        };
      },
    });
    const handler = createRuntimeHttpHandler(config);
    const configuration = await handler(new Request('http://runtime.local/api/config'));
    expect(await configuration.json()).toMatchObject({
      provider: 'gemini',
      profiles: ['inspect', 'workspace', 'research'],
      features: { web_search: true },
      capabilities: [{ id: 'workspace.file.read' }, { id: 'workspace.file.write' }, { id: 'network.web.search' }],
      providers: [
        { id: 'gemini', configured: true },
        { id: 'ollama', configured: true, default_model: 'llama3.2' },
        { id: 'anthropic', configured: true },
        { id: 'openai-compatible', configured: false },
        { id: 'openai', configured: false },
        { id: 'groq', configured: true },
        { id: 'openrouter', configured: true },
        { id: 'lmstudio', configured: true },
        { id: 'llamacpp', configured: true },
      ],
    });
    const models = await handler(new Request('http://runtime.local/api/models/gemini'));
    expect(await models.json()).toMatchObject({
      provider: 'gemini',
      connected: true,
      models: [{ id: 'gemini-2.5-flash' }],
    });
    expect(requested).toContainEqual({
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
      authorization: 'Bearer test-gemini-key',
    });
  });

  test('continues an HTTP run after a live proposal-scoped approval', async () => {
    const root = temporaryRoot();
    let step = 0;
    const model: ModelDriver = {
      async propose(_packet, _capabilities, scope) {
        step += 1;
        return {
          proposal: step === 1 ? {
            kind: 'action',
            strategyId: scope.activeStrategyId,
            hypothesis: 'A scoped write will create the requested artifact.',
            expectedObservation: 'workspace/approved.txt contains approved.',
            action: {
              id: 'proposal:http-approved-write',
              intentId: scope.intentId,
              principalId: scope.principalId,
              conditionIds: scope.requiredConditionIds,
              capabilityId: 'workspace.file.write',
              target: 'workspace/approved.txt',
              declaredEffects: ['state.write'],
              risk: 4,
              expectedEvidence: scope.requiredEvidence,
              idempotencyKey: 'http-approved-write:one',
              args: { content: 'approved' },
            },
          } : {
            kind: 'complete',
            strategyId: scope.activeStrategyId,
            evidenceRefs: scope.requiredEvidence,
          },
          usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 },
          model: 'test:http-approval-driver',
        };
      },
    };
    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory: join(root, 'ledgers'),
      provider: 'ollama',
      model: 'test-model',
      allowedExecutables: [],
      allowedHosts: [],
      modelDriverFactory: () => model,
    });
    const response = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Write workspace/approved.txt.', profile: 'workspace' }),
    }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames: Array<Record<string, any>> = [];
    let runId = '';
    while (!frames.some(frame => frame.event?.type === 'gate.open')) {
      const chunk = await reader.read();
      expect(chunk.done).toBeFalse();
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const line = buffer.slice(0, boundary).split('\n').find(value => value.startsWith('data: '));
        buffer = buffer.slice(boundary + 2);
        if (line) {
          const frame = JSON.parse(line.slice(6));
          frames.push(frame);
          if (frame.kind === 'meta') runId = frame.run_id;
        }
      }
    }
    expect(runId).toStartWith('run:');
    const approval = await handler(new Request(`http://runtime.local/api/runs/${encodeURIComponent(runId)}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    }));
    expect(await approval.json()).toMatchObject({ ok: true, approved: true });
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    expect(readFileSync(join(root, 'approved.txt'), 'utf8')).toBe('approved');
  });
});
