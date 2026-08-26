import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessOperatorClarification,
  classifyModelRouteFailure,
  adaptLedgerEvent,
  createRuntimeHttpHandler,
  JsonOperatorStore,
  ingestSessionFile,
  projectRunTrail,
  projectRuntimeGraph,
  replayLedger,
  runtimeHttpConfig,
  runTask,
  finalText,
  deriveOutcomeEvidence,
  extractExplicitMemoryStatement,
  inferRunMode,
  planTaskConnections,
  projectSessionContinuity,
  synthesisDecision,
  selectProposalCapabilityIds,
  type HyperTaskFile,
} from '@hyper/cli';
import { CONTRACT_VERSION, type LedgerEvent, type WorkflowProposal, type WorkflowRunResult } from '@hyper/contracts';
import type { ModelDriver } from '@hyper/model';

const roots: string[] = [];
const now = '2026-07-24T12:00:00.000Z';

function canonicalEvent(type: string, payload: Record<string, unknown>): LedgerEvent {
  return {
    version: CONTRACT_VERSION,
    runId: 'run:display-test',
    sequence: 1,
    type,
    payload,
    previousHash: 'previous',
    hash: 'current',
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hyper-cli-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('practical CLI workflow', () => {
  test('classifies provider failures for durable route cooldowns', () => {
    expect(classifyModelRouteFailure('HTTP 403 forbidden')).toMatchObject({
      failureClass: 'authentication_or_access', retryable: false,
    });
    expect(classifyModelRouteFailure('HTTP 413 TPM limit 8000 requested 10361')).toMatchObject({
      failureClass: 'request_budget', retryable: false,
    });
    expect(classifyModelRouteFailure('Unable to connect to Ollama')).toMatchObject({
      failureClass: 'provider_unreachable', retryable: true,
    });
  });
  test('infers task depth when the client leaves execution strategy automatic', () => {
    expect(inferRunMode('What time is it in Toronto?')).toBe('fast');
    expect(inferRunMode('Research and compare current context engineering approaches with sources.')).toBe('reasoned');
    expect(inferRunMode('Implement the fix, update the files, and run tests.')).toBe('agent');
  });

  test('derives task-specific evidence instead of accepting any successful action', () => {
    const codingManifests = [
      { id: 'workspace.file.read' },
      { id: 'workspace.file.write' },
      { id: 'workspace.process.run' },
    ];
    expect(deriveOutcomeEvidence('Implement the code fix and run tests.', codingManifests)).toEqual([
      'effect:state.write',
      'effect:process.execute',
    ]);
    expect(deriveOutcomeEvidence('Search the web and return a sourced summary.', [{ id: 'network.web.search' }]))
      .toEqual(['capability:network.web.search']);
    expect(deriveOutcomeEvidence('Inspect the repository without changing files.', [{ id: 'workspace.file.read' }]))
      .toEqual(['capability:workspace.file.read']);
  });

  test('narrows the stateless proposal model to task-relevant tools without expanding authority', () => {
    const manifests = [
      { id: 'network.web.search', description: 'Search the public web.', effects: ['network.request'], requiredEffects: ['network.request'] },
      { id: 'workspace.file.write', description: 'Write a workspace file.', effects: ['state.write'], requiredEffects: ['state.write'] },
      { id: 'media.image.analyze', description: 'Analyze an image.', effects: ['state.read'], requiredEffects: ['state.read'] },
    ] as unknown as Parameters<typeof selectProposalCapabilityIds>[1];
    expect(selectProposalCapabilityIds(
      'Search the web for recent Canadian budgeting pain points and do not write files.', manifests,
    )).toEqual(['network.web.search']);
    expect(selectProposalCapabilityIds('Hello, can you explain what you can help with?', manifests)).toEqual([]);
    expect(selectProposalCapabilityIds('Write Python code snippets with comments.', manifests)).toEqual([]);
    expect(selectProposalCapabilityIds('Run a multi-step reasoning task.', manifests)).toEqual([]);
    expect(selectProposalCapabilityIds('Write the implementation to a project file.', manifests))
      .toContain('workspace.file.write');
    expect(planTaskConnections('Continue that explanation with more detail.', manifests)).toMatchObject({
      capabilityIds: [],
      needsRecentHistory: true,
      needsSessionSearch: false,
      needsVerifiedMemory: false,
      needsUploadedFiles: false,
    });
    expect(planTaskConnections('Recall what we decided earlier in this chat.', manifests)).toMatchObject({
      needsRecentHistory: true,
      needsSessionSearch: true,
      needsVerifiedMemory: true,
    });
    expect(planTaskConnections('Summarize the uploaded document.', manifests, { hasLinkedSessionFile: true }))
      .toMatchObject({ needsUploadedFiles: true });
    expect(planTaskConnections('Fix it and run the tests.', manifests, {
      recentConversation: 'The repository file contains a broken implementation.',
    })).toMatchObject({
      capabilityIds: expect.arrayContaining(['workspace.file.write']),
      needsRecentHistory: true,
      reasons: expect.arrayContaining(['continued-task-connections']),
    });
    const codingManifests = [
      { id: 'workspace.file.read' }, { id: 'workspace.repository.search' },
      { id: 'workspace.file.patch' }, { id: 'workspace.file.write' }, { id: 'workspace.process.run' },
    ] as unknown as Parameters<typeof planTaskConnections>[1];
    expect(planTaskConnections('Fix the bug in this repository and run the focused tests.', codingManifests))
      .toMatchObject({
        lane: 'coding',
        capabilityIds: expect.arrayContaining([
          'workspace.file.read', 'workspace.repository.search', 'workspace.file.patch', 'workspace.process.run',
        ]),
      });
    expect(planTaskConnections('Read workspace/input.txt and verify it.', codingManifests))
      .toMatchObject({ lane: 'workspace', capabilityIds: ['workspace.file.read'] });
    expect(planTaskConnections('Write a commented Python snippet in chat.', codingManifests))
      .toMatchObject({ lane: 'conversation', capabilityIds: [] });
    expect(planTaskConnections(
      'Create a routine maker and tracker and code it in one HTML with all functionality.', codingManifests,
    )).toMatchObject({
      lane: 'coding',
      capabilityIds: expect.arrayContaining([
        'workspace.repository.search', 'workspace.file.write', 'workspace.file.patch', 'workspace.process.run',
      ]),
    });
  });

  test('separates operator memory from uploaded-file knowledge retrieval', () => {
    const manifests = [
      { id: 'session.knowledge.search', description: 'Search uploaded session files.', effects: ['state.read'], requiredEffects: ['state.read'] },
    ] as unknown as Parameters<typeof selectProposalCapabilityIds>[1];
    expect(selectProposalCapabilityIds('Remember that my favorite color is blue.', manifests)).toEqual([]);
    expect(selectProposalCapabilityIds('Search the uploaded document for my favorite color.', manifests))
      .toEqual(['session.knowledge.search']);
    expect(planTaskConnections("What's my name?", manifests)).toMatchObject({
      capabilityIds: [], needsRecentHistory: true, needsVerifiedMemory: true,
    });
    expect(planTaskConnections('List every prompt I said so far in this chat exactly.', manifests))
      .toMatchObject({ needsRecentHistory: true });
    expect(extractExplicitMemoryStatement('use memory tool to store my name')).toBeUndefined();
    expect(extractExplicitMemoryStatement('Remember that my favorite color is blue.'))
      .toBe('Remember that my favorite color is blue.');
    expect(extractExplicitMemoryStatement('its von from now on, remember and store it'))
      .toBe('its von from now on, remember and store it');
  });

  test('projects one bounded continuity contract with active direction and correction precedence', () => {
    const messages = [
      { id: 'u1', role: 'user' as const, content: 'Evaluate generic chat agents.', at: now },
      { id: 'a1', role: 'assistant' as const, content: 'Here are generic benchmarks.', at: now },
      { id: 'u2', role: 'user' as const, content: 'No, focus on our Hyper runtime rather than generic agents.', at: now },
      { id: 'a2', role: 'assistant' as const, content: 'I will focus on Hyper.', at: now },
      { id: 'u3', role: 'user' as const, content: 'Show how its verified execution differs.', at: now },
    ];
    const projection = projectSessionContinuity(messages, 'standard');
    expect(projection.context).toContain('Active operator direction');
    expect(projection.context).toContain('focus on our Hyper runtime');
    expect(projection.context).toContain('Operator corrections and boundaries');
    expect(projection.context).toContain('Recent exchange (chronological)');
    expect(projection.retained.map(message => message.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3']);
  });

  test('synthesizes verified web research even in fast mode and keeps a readable evidence fallback', () => {
    const result = {
      runId: 'run:web', status: 'completed', activeStrategyId: 'direct', reasonCodes: [], receiptHash: 'receipt:web',
      steps: [{
        step: 1, phase: 'verify', strategyId: 'direct', packetId: 'packet:web',
        proposal: {
          kind: 'action', strategyId: 'direct', hypothesis: 'Current sources expose the requested evidence',
          expectedObservation: 'A bounded set of recent Canadian budgeting sources',
          action: { capabilityId: 'web.search', input: { query: 'budgeting Canada' }, declaredEffects: ['network.request', 'state.read'] },
        },
        usage: { inputTokens: 10, outputTokens: 5, latencyMs: 1 },
        outcome: {
          status: 'completed', reasonCodes: [],
          observation: {
            id: 'observation:web', target: 'search://web', observedAt: now,
            value: { query: 'budgeting Canada', results: [{ title: 'Bank of Canada', url: 'https://example.test/report', snippet: 'Household budgets remain strained.' }] },
          },
          verification: { passed: true, reasonCodes: [], evidence: [{ id: 'evidence:web', kind: 'observation', source: 'search://web', capturedAt: now }] },
        },
      }],
    } as unknown as WorkflowRunResult;

    expect(synthesisDecision(result, 'Search the web and summarize the evidence.', 'fast')).toEqual({
      synthesize: true,
      reason: 'natural_language_synthesis_required',
    });
    expect(finalText(result)).toContain('- Bank of Canada — https://example.test/report');
    expect(finalText(result)).not.toContain('{"query"');
  });

  test('skips redundant synthesis only for verified artifacts or explicit operator answers', () => {
    const base = {
      runId: 'run:answer', status: 'completed', activeStrategyId: 'direct', reasonCodes: [], receiptHash: 'receipt:answer',
      steps: [{
        step: 1, phase: 'verify', strategyId: 'direct', packetId: 'packet:answer',
        proposal: {
          kind: 'action', strategyId: 'direct', hypothesis: 'The capability can produce the requested answer',
          expectedObservation: 'A complete operator-facing answer',
          action: { capabilityId: 'answer.generate', input: {}, declaredEffects: ['state.read'] },
        },
        usage: { inputTokens: 10, outputTokens: 5, latencyMs: 1 },
        outcome: {
          status: 'completed', reasonCodes: [],
          observation: { id: 'observation:answer', target: 'answer://final', observedAt: now, value: { answer: 'This is a complete, verified operator-facing answer with sufficient detail.' } },
          verification: { passed: true, reasonCodes: [], evidence: [{ id: 'evidence:answer', kind: 'observation', source: 'answer://final', capturedAt: now }] },
        },
      }],
    } as unknown as WorkflowRunResult;
    expect(synthesisDecision(base, 'Answer the question.', 'fast').reason).toBe('verified_observation_contains_operator_answer');

    const artifact = structuredClone(base) as WorkflowRunResult;
    const step = artifact.steps[0]!;
    if (step.proposal.kind === 'action') step.proposal.action.declaredEffects = ['state.write'];
    if (step.outcome?.observation) step.outcome.observation.value = { path: 'workspace/report.md' };
    expect(synthesisDecision(artifact, 'Create and save a report.', 'fast').reason).toBe('verified_artifact_is_primary_answer');
  });

  test('branches immutable prompt history, projects verified artifacts, and deletes session-owned projections', () => {
    const root = temporaryRoot();
    const store = new JsonOperatorStore(join(root, 'operator.json'));
    store.ensureSession('session:source', now, 'Original prompt');
    store.appendMessage('session:source', { id: 'message:one', role: 'user', content: 'First prompt', at: now });
    store.appendMessage('session:source', { id: 'message:two', role: 'assistant', content: 'First answer', at: now });
    store.appendMessage('session:source', { id: 'message:three', role: 'user', content: 'Prompt to edit', at: now });
    store.recordRun({
      id: 'run:source', sessionId: 'session:source', objective: 'Prompt to edit', status: 'completed',
      profile: 'workspace', provider: 'scripted', startedAt: now, endedAt: now, evidenceRefs: [],
    });
    store.addArtifact({
      id: 'artifact:source', sessionId: 'session:source', runId: 'run:source', proposalId: 'proposal:write',
      capabilityId: 'workspace.file.write', target: 'workspace/report.md', name: 'report.md',
      mediaType: 'text/markdown', sizeBytes: 12, sha256: 'abc', evidenceRefs: ['verification:write'],
      createdAt: now, verified: true,
    });

    const branch = store.branchSession({
      sourceSessionId: 'session:source', messageId: 'message:three', newSessionId: 'session:branch', now,
    });
    expect(branch).toMatchObject({
      parentSessionId: 'session:source', branchedFromMessageId: 'message:three',
      messages: [{ id: 'message:one' }, { id: 'message:two' }],
    });
    expect(store.messages('session:source')).toHaveLength(3);
    expect(store.listArtifacts('session:source')).toEqual([expect.objectContaining({ id: 'artifact:source', verified: true })]);

    const removed = store.deleteSession('session:source');
    expect(removed).toMatchObject({ runIds: ['run:source'] });
    expect(store.session('session:source')).toBeUndefined();
    expect(store.listRuns('session:source')).toEqual([]);
    expect(store.listArtifacts('session:source')).toEqual([]);
    expect(store.session('session:branch')).toBeDefined();
  });

  test('ingests session files and fuses semantic, temporal, relationship, and lexical retrieval without cross-session bleed', async () => {
    const root = temporaryRoot();
    const store = new JsonOperatorStore(join(root, 'operator.json'));
    store.ensureSession('session:a', now, 'A');
    store.ensureSession('session:b', now, 'B');
    const embeddingProvider = {
      model: 'test-embedding',
      async embed(inputs: string[]) {
        return inputs.map(input => input.includes('policy') || input.includes('authorization')
          ? [1, 0, 0]
          : [0, 1, 0]);
      },
    };
    const ingested = await ingestSessionFile({
      sessionId: 'session:a',
      ingestionId: 'ingestion:a',
      file: new File([
        'Runtime policy requires authorization evidence before effects.\n\n'
        + 'Runtime context connects policy decisions to verified observations.',
      ], 'runtime.md', { type: 'text/markdown' }),
      storageRoot: join(root, 'files'),
      createdAt: now,
      embeddingProvider,
    });
    store.addSessionFile(ingested.record, ingested.chunks);
    expect(ingested.record).toMatchObject({ status: 'ready', retrievalMode: 'hybrid', embeddingModel: 'test-embedding' });
    const results = store.searchKnowledge('session:a', 'authorization policy', {
      queryEmbedding: [1, 0, 0],
      now,
    });
    expect(results[0]).toMatchObject({
      fileName: 'runtime.md',
      retrievalMode: 'hybrid',
      reasons: expect.arrayContaining(['lexical-match', 'semantic-match', 'relationship-expansion']),
    });
    expect(results[0]!.provenance).toContain('ingestion:a');
    expect(store.searchKnowledge('session:b', 'authorization policy', { queryEmbedding: [1, 0, 0], now })).toEqual([]);

    const degraded = await ingestSessionFile({
      sessionId: 'session:b',
      ingestionId: 'ingestion:b',
      file: new File(['Lexical fallback remains available.'], 'fallback.txt', { type: 'text/plain' }),
      storageRoot: join(root, 'files'),
      createdAt: now,
    });
    expect(degraded.record).toMatchObject({ status: 'limited', retrievalMode: 'lexical' });
    expect(degraded.record.limitation).toContain('No embedding model is configured');
  });

  test('uploads, searches, graphs, and deletes session-owned files through the HTTP boundary', async () => {
    const root = temporaryRoot();
    const ledgerDirectory = join(root, 'ledgers');
    mkdirSync(ledgerDirectory, { recursive: true });
    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory,
      sessionFileDirectory: join(root, 'session-files'),
      provider: 'ollama',
      model: 'test-model',
      allowedExecutables: [],
      allowedHosts: [],
      embeddingProvider: {
        model: 'fixture-embedding',
        async embed(inputs) { return inputs.map(() => [1, 0]); },
      },
    });
    await handler(new Request('http://runtime.local/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'session:upload' }),
    }));
    const form = new FormData();
    form.append('files', new File(['Temporal graph memory for the coding runtime.'], 'knowledge.md', { type: 'text/markdown' }));
    const upload = await handler(new Request('http://runtime.local/api/sessions/session%3Aupload/files', { method: 'POST', body: form }));
    expect(upload.status).toBe(201);
    const uploaded = await upload.json() as { files: Array<{ id: string; ingestionId: string; retrievalMode: string; sha256: string; storagePath?: string }> };
    expect(uploaded.files[0]).toMatchObject({ retrievalMode: 'hybrid' });
    expect(uploaded.files[0]!.storagePath).toBeUndefined();
    expect(readFileSync(join(ledgerDirectory, `${uploaded.files[0]!.ingestionId}.jsonl`), 'utf8')).toContain('knowledge.index_projected');

    const search = await handler(new Request('http://runtime.local/api/sessions/session%3Aupload/knowledge/search?q=graph%20runtime'));
    expect(await search.json()).toMatchObject({
      embeddingAvailable: true,
      results: [{ fileName: 'knowledge.md', retrievalMode: 'hybrid' }],
    });
    const graph = await handler(new Request('http://runtime.local/api/sessions/session%3Aupload/knowledge/graph'));
    expect(await graph.json()).toMatchObject({
      session_id: 'session:upload',
      files: [{ name: 'knowledge.md' }],
      chunks: [{ content: 'Temporal graph memory for the coding runtime.' }],
    });
    const remove = await handler(new Request(
      `http://runtime.local/api/sessions/session%3Aupload/files/${encodeURIComponent(uploaded.files[0]!.id)}`,
      { method: 'DELETE' },
    ));
    expect(await remove.json()).toMatchObject({ deleted: true });
    const listed = await handler(new Request('http://runtime.local/api/sessions/session%3Aupload/files'));
    expect(await listed.json()).toMatchObject({ files: [] });
  });

  test('pins one embedding space per session and serves bounded universal and session previews', async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, 'runtime.ts'), 'export const runtime = "coherent";\n');
    const provider = (model: string) => ({ model, async embed(inputs: string[]) { return inputs.map(() => [1, 0, 0]); } });
    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory: join(root, 'ledgers'),
      operatorDataPath: join(root, 'operator.json'),
      sessionFileDirectory: join(root, 'session-files'),
      provider: 'ollama', model: 'fixture', allowedExecutables: [], allowedHosts: [],
      embeddingProfiles: [
        { id: 'quality', label: 'Quality', model: 'embed-quality', provider: provider('embed-quality'), dimensions: 3 },
        { id: 'fast', label: 'Fast', model: 'embed-fast', provider: provider('embed-fast'), dimensions: 3 },
      ],
    });
    await handler(new Request('http://runtime.local/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'session:pinned' }),
    }));
    const select = await handler(new Request('http://runtime.local/api/sessions/session%3Apinned/embedding', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: 'quality' }),
    }));
    expect(select.status).toBe(200);
    const form = new FormData();
    form.append('files', new File(['Pinned vector space.'], 'notes.md', { type: 'text/markdown' }));
    const upload = await handler(new Request('http://runtime.local/api/sessions/session%3Apinned/files', { method: 'POST', body: form }));
    const uploaded = await upload.json() as { files: Array<{ id: string; embeddingProfileId: string }> };
    expect(uploaded.files[0]?.embeddingProfileId).toBe('quality');
    const change = await handler(new Request('http://runtime.local/api/sessions/session%3Apinned/embedding', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: 'fast' }),
    }));
    expect(change.status).toBe(409);
    expect(await change.json()).toMatchObject({ code: 'EMBEDDING_PROFILE_LOCKED' });

    const workspace = await handler(new Request('http://runtime.local/api/filesystem?path=workspace%2F'));
    const workspaceBody = await workspace.json() as { entries: Array<{ name: string; previewKind?: string; path: string }> };
    expect(workspaceBody.entries.find(item => item.name === 'runtime.ts')).toMatchObject({ previewKind: 'code', path: 'workspace/runtime.ts' });
    const preview = await handler(new Request('http://runtime.local/api/filesystem/preview?path=workspace%2Fruntime.ts'));
    expect(await preview.json()).toMatchObject({ previewKind: 'code', content: 'export const runtime = "coherent";\n' });
    const sessionPreview = await handler(new Request(`http://runtime.local/api/sessions/session%3Apinned/files/${encodeURIComponent(uploaded.files[0]!.id)}/preview`));
    expect(await sessionPreview.json()).toMatchObject({ scope: 'session', previewKind: 'markdown', content: 'Pinned vector space.' });
  });

  test('projects canonical context, proposals, capabilities, and verification as one linked graph', () => {
    const session = {
      id: 'session:graph',
      title: 'Graph session',
      createdAt: now,
      updatedAt: now,
      messages: [{ id: 'message:graph', role: 'user' as const, content: 'Inspect the report.', at: now, runId: 'run:graph' }],
    };
    const run = {
      id: 'run:graph', sessionId: session.id, objective: 'Inspect the report.', status: 'completed',
      profile: 'inspect', provider: 'scripted', startedAt: now, endedAt: now, evidenceRefs: ['evidence:report'],
    };
    const event = (sequence: number, type: string, payload: Record<string, unknown>): LedgerEvent => ({
      ...canonicalEvent(type, payload), runId: run.id, sequence, hash: `hash:${sequence}`,
    });
    const events = [
      event(0, 'context.compiled', {
        packetId: 'packet:graph', phase: 'act', step: 1, objective: run.objective,
        legalCapabilityIds: ['workspace.file.read'], estimatedTokens: 84,
        items: [{ sourceId: 'source:directive', title: 'Inspection rule', content: 'Read before completion.', authority: 'directive', validity: 'active' }],
      }),
      event(1, 'model.proposed', {
        packetId: 'packet:graph',
        proposal: { kind: 'action', hypothesis: 'Read the report.', action: { id: 'proposal:graph', capabilityId: 'workspace.file.read', target: 'workspace/report.txt', risk: 0, args: {} } },
      }),
      event(2, 'policy.decided', { proposalId: 'proposal:graph', disposition: 'allow' }),
      event(3, 'action.verified', {
        proposalId: 'proposal:graph', capabilityId: 'workspace.file.read', passed: true,
        reasonCodes: ['OBSERVED_VALUE_MATCH'], evidence: [{ id: 'evidence:report', source: 'observation' }],
      }),
      event(4, 'workflow.completion_checked', {
        passed: true, reasonCodes: ['REQUIRED_EVIDENCE_PRESENT'], evidence: [{ id: 'evidence:report', source: 'observation' }],
      }),
    ];
    const graph = projectRuntimeGraph({
      session,
      runs: [{ run, events }],
      memory: [{
        id: 'memory:graph', sourceRunId: run.id, sessionId: session.id, content: 'The report was inspected.',
        evidenceRefs: ['evidence:report'], createdAt: now, status: 'active', kind: 'outcome',
      }],
      query: 'workspace.file.read',
    });
    const types = new Set(graph.nodes.map(node => node.type));
    expect(types).toEqual(new Set(['session', 'run', 'message', 'memory', 'context', 'source', 'proposal', 'capability', 'verification', 'evidence']));
    expect(graph.counts).toMatchObject({ contexts: 1, proposals: 1, capabilities: 1, verifications: 2, evidence: 1 });
    expect(graph.integrity).toMatchObject({ canonical_events: 5, canonical_runs: 1, verified_paths: 2, orphan_edges: 0, truncated: false });
    expect(graph.integrity.provenance_coverage).toBe(1);
    expect(graph.nodes.find(node => node.type === 'capability')).toMatchObject({ matched: true, entityId: 'workspace.file.read' });
    expect(graph.edges.some(edge => edge.type === 'informed_by')).toBeTrue();
    expect(graph.edges.some(edge => edge.type === 'established_by')).toBeTrue();
    const ids = new Set(graph.nodes.map(node => node.id));
    expect(graph.edges.every(edge => ids.has(edge.from) && ids.has(edge.to))).toBeTrue();
  });

  test('projects canonical events into distinct human-readable titles and causal details', () => {
    const started = adaptLedgerEvent(canonicalEvent('workflow.started', {
      objective: 'Inspect the report and verify its result.',
      maxSteps: 6,
    }))[0];
    expect(started).toMatchObject({
      schema_version: '1.0',
      id: 'current:run.start',
      type: 'run.start',
      state: 'info',
      lens: 'input',
      title: 'Run started',
      timing_source: 'replay_projection',
      provenance: 'canonical_ledger',
      canonical_event_id: 'current',
      canonical_sequence: 1,
    });
    expect(started.detail).toContain('Inspect the report');
    expect(started.detail).toContain('6 bounded steps');

    const policy = adaptLedgerEvent(canonicalEvent('policy.decided', {
      disposition: 'deny',
      reasonCodes: ['TARGET_OUTSIDE_INTENT'],
    }))[0];
    expect(policy.title).toBe('Action blocked by policy');
    expect(policy.state).toBe('blocked');
    expect(policy.lens).toBe('policy');
    expect(policy.detail).toBe('target outside intent');

    const proposed = adaptLedgerEvent(canonicalEvent('model.proposed', {
      proposal: {
        kind: 'action',
        hypothesis: 'The report can be inspected safely.',
        action: {
          id: 'proposal:read',
          capabilityId: 'workspace.file.read',
          target: 'workspace/report.txt',
          args: {},
          declaredEffects: ['state.read'],
          risk: 1,
        },
      },
    }));
    expect(proposed.map(event => event.title)).toEqual([
      'Model chose the next action',
      'Reading a workspace file',
    ]);
    expect(proposed[1]?.detail).toContain('report.txt');
    expect(proposed[1]).toMatchObject({
      id: 'current:tool.call',
      correlation: { proposal_id: 'proposal:read', capability_id: 'workspace.file.read' },
    });

    const verified = adaptLedgerEvent(canonicalEvent('action.verified', {
      capabilityId: 'workspace.file.read',
      passed: true,
      reasonCodes: ['OBSERVED_STATE_MATCHES'],
    }))[0];
    expect(verified).toMatchObject({
      title: 'Action outcome verified',
      detail: 'observed state matches',
      state: 'success',
      lens: 'verification',
    });
  });

  test('uses conversation context for reversible defaults but preserves material clarification gates', () => {
    const redundant = assessOperatorClarification({
      objective: 'full',
      question: 'What programming language and specific aspect would you like?',
      reason: 'Clarify preferences.',
      transcript: 'Operator: Research agent context implementations with commented code.\nOperator: python\nOperator: use your own thinking based on my intent',
      authorizedCapabilityIds: ['network.web.search'],
    });
    expect(redundant).toMatchObject({ allowed: false, reasonCode: 'PREFERENCE_ALREADY_ANSWERED' });

    const material = assessOperatorClarification({
      objective: 'Inspect the requested file.',
      question: 'Which file path should I inspect?',
      reason: 'No target was supplied.',
      transcript: '',
      authorizedCapabilityIds: ['workspace.file.read'],
    });
    expect(material).toEqual({ allowed: true, reasonCode: 'MATERIAL_OPERATOR_DECISION_REQUIRED' });
  });

  test('keeps an avoidable clarification inside the live run and continues to verified work', async () => {
    const root = temporaryRoot();
    const ledgerDirectory = join(root, 'ledgers');
    writeFileSync(join(root, 'context.txt'), 'context implementation evidence');
    let pass = 0;
    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory,
      provider: 'ollama',
      model: 'test-model',
      allowedExecutables: [],
      allowedHosts: [],
      modelDriverFactory: () => ({
        async propose(_packet, _capabilities, scope) {
          pass += 1;
          const proposal: WorkflowProposal = pass === 1 ? {
            kind: 'ask',
            strategyId: scope.activeStrategyId,
            question: 'What specific aspect and programming language should I use?',
            reason: 'Preferences may be missing.',
          } : pass === 2 ? {
            kind: 'action',
            strategyId: scope.activeStrategyId,
            hypothesis: 'The bounded context example can be inspected.',
            expectedObservation: 'The context fixture is observed.',
            action: {
              id: 'proposal:context-read', intentId: scope.intentId, principalId: scope.principalId,
              conditionIds: scope.requiredConditionIds, capabilityId: 'workspace.file.read',
              target: 'workspace/context.txt', declaredEffects: ['state.read'], risk: 1,
              expectedEvidence: scope.requiredEvidence, idempotencyKey: 'context-read:one', args: {},
            },
          } : {
            kind: 'complete', strategyId: scope.activeStrategyId, evidenceRefs: scope.requiredEvidence,
          };
          return { proposal, usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 }, model: 'test:clarification-guard' };
        },
        async synthesize(request) {
          const evidenceRefs = request.observations.flatMap(item => item.evidenceRefs);
          return {
            answer: 'Python context example prepared from the verified fixture.', evidenceRefs,
            claims: [{ text: 'The context fixture was inspected.', evidenceRefs }], caveats: [],
            model: 'test:clarification-synthesis', usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 },
          };
        },
      }),
    });
    const response = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Research agent context implementations with full commented Python examples; use your own thinking.',
        profile: 'partner',
        required_evidence: ['runtime_outcome_observed'],
      }),
    }));
    const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as Record<string, any>);
    const displayEvents = frames.filter(frame => frame.kind === 'event').map(frame => frame.event);

    expect(displayEvents.some(event => event.title === 'Skipped an unnecessary clarification')).toBeTrue();
    expect(displayEvents.some(event => event.type === 'run.pause')).toBeFalse();
    expect(displayEvents.at(-1)?.type).toBe('run.end');
    expect(displayEvents.find(event => event.type === 'respond.final')?.payload.text).toContain('Python');
    const meta = frames.find(frame => frame.kind === 'meta');
    const canonical = replayLedger(join(ledgerDirectory, `${meta?.run_id}.jsonl`));
    expect(canonical).toMatchObject({ valid: true, runs: [{ status: 'completed' }] });
  });

  test('summarizes a replayable UI trail without treating projection time as event time', () => {
    const events = [
      canonicalEvent('action.proposed', { proposalId: 'proposal:read' }),
      canonicalEvent('action.executed', { proposalId: 'proposal:read', capabilityId: 'workspace.file.read', success: true }),
      canonicalEvent('action.verified', { proposalId: 'proposal:read', passed: true, evidence: [{ id: 'evidence:read' }] }),
      canonicalEvent('workflow.completion_checked', { passed: true, evidence: [{ id: 'evidence:read' }] }),
      canonicalEvent('operator.run_finished', { status: 'completed' }),
    ].map((event, sequence) => ({ ...event, sequence, hash: `event-${sequence}` }));
    const trail = projectRunTrail(events);
    expect(trail).toMatchObject({
      schema_version: '1.0',
      evidence_class: 'canonical_run_projection',
      run_id: 'run:display-test',
      summary: {
        status: 'completed',
        canonical_events: 5,
        actions_proposed: 1,
        effects_attempted: 1,
        verified_actions: 1,
        evidence_refs: 1,
        completion_verified: true,
      },
    });
    expect(trail.events.every(event => event.timing_source === 'replay_projection')).toBeTrue();
    expect(trail.events.map(event => event.id)).toEqual([
      'event-1:tool.result', 'event-2:verify.verdict', 'event-3:verify.verdict', 'event-4:run.end',
    ]);
  });

  test('keeps a disconnected event stream from crashing the runtime', async () => {
    const root = temporaryRoot();
    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory: join(root, 'ledgers'),
      operatorDataPath: join(root, 'operator.json'),
      provider: 'ollama',
      model: 'slow-test-model',
      allowedExecutables: [],
      allowedHosts: [],
      modelDriverFactory: () => ({
        async propose(_packet, _capabilities, scope) {
          await new Promise(resolve => setTimeout(resolve, 20));
          return {
            proposal: {
              kind: 'ask',
              strategyId: scope.activeStrategyId,
              question: 'What should I inspect?',
              reason: 'disconnect fixture',
            },
            usage: { inputTokens: 1, outputTokens: 1, latencyMs: 20 },
            model: 'test:slow-stream',
          };
        },
      }),
    });
    const response = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Start, then disconnect.' }),
    }));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.cancel();
    await new Promise(resolve => setTimeout(resolve, 40));

    const health = await handler(new Request('http://runtime.local/api/health'));
    expect(health.status).toBe(200);
  });

  test('isolates verified memory by session and always includes one recent transcript source', async () => {
    const root = temporaryRoot();
    const operatorPath = join(root, 'operator.json');
    const store = new JsonOperatorStore(operatorPath);
    store.ensureSession('session:a', now, 'Agent A');
    store.ensureSession('session:b', now, 'Agent B');
    store.appendMessage('session:b', {
      id: 'message:b:user',
      role: 'user',
      content: 'Keep this recent direction coherent.',
      at: now,
      runId: 'run:b:prior',
    });
    store.appendMessage('session:b', {
      id: 'message:b:assistant',
      role: 'assistant',
      content: 'I will preserve this direction.',
      at: now,
      runId: 'run:b:prior',
    });
    expect(store.recentMessages('session:b', { maxMessages: 1 })).toMatchObject([
      { role: 'assistant', content: 'I will preserve this direction.' },
    ]);
    expect(store.recentMessages('session:b', { excludeRunId: 'run:b:prior' })).toEqual([]);
    store.commitMemory({
      id: 'verified:a',
      sourceRunId: 'run:a',
      sessionId: 'session:a',
      content: 'Private verified memory for agent A.',
      evidenceRefs: ['observation:a'],
      createdAt: now,
      status: 'active',
      kind: 'outcome',
      salience: 0.9,
    });
    expect(store.listMemory('session:a')).toHaveLength(1);
    expect(store.listMemory('session:b')).toHaveLength(0);
    expect(store.recallMemory('session:a', 'private verified')).toMatchObject([
      { record: { id: 'verified:a', sessionId: 'session:a' }, reasons: expect.arrayContaining(['query-match']) },
    ]);
    expect(store.recallMemory('session:b', 'private verified')).toEqual([]);
    expect(store.searchSession('session:b', 'recent direction')).toContainEqual(
      expect.objectContaining({
        documentId: 'message:b:user', sessionId: 'session:b', provenance: ['message:b:user', 'run:b:prior'],
      }),
    );
    expect(store.searchSession('session:a', 'recent direction')).toEqual([]);

    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory: join(root, 'ledgers'),
      operatorDataPath: operatorPath,
      provider: 'ollama',
      model: 'test-model',
      allowedExecutables: [],
      allowedHosts: [],
      modelDriverFactory: () => ({
        async propose(_packet, _capabilities, scope) {
          return {
            proposal: {
              kind: 'ask',
              strategyId: scope.activeStrategyId,
              question: 'What should I inspect next?',
              reason: 'fixture pause',
            },
            usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 },
            model: 'test:session-context',
          };
        },
      }),
    });
    const response = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Continue that direction.', session_id: 'session:b' }),
    }));
    const frames = (await response.text()).split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as Record<string, any>);
    const compiled = frames.find(frame => frame.event?.type === 'context.packet');
    expect(compiled?.event.payload.includedSourceIds)
      .toContain('history:session:b:continuity');
    expect(compiled?.event.payload.includedSourceIds)
      .not.toContain('memory:verified:a');
    expect(frames.at(-1)?.event.type).toBe('run.pause');
    const search = await handler(new Request('http://runtime.local/api/sessions/session%3Ab/search?q=recent%20direction'));
    const searchBody = await search.json() as { results: Array<{ sessionId: string; provenance: string[] }> };
    expect(searchBody.results.length).toBeGreaterThan(0);
    expect(searchBody.results.every(result => result.sessionId === 'session:b')).toBeTrue();
    expect(searchBody.results.some(result => result.provenance.includes('run:b:prior'))).toBeTrue();
  });

  test('answers ordinary chat in one model call without entering the action workflow', async () => {
    const root = temporaryRoot();
    let responseCalls = 0;
    let proposalCalls = 0;
    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory: join(root, 'ledgers'),
      operatorDataPath: join(root, 'operator.json'),
      provider: 'ollama',
      model: 'test-model',
      allowedExecutables: [],
      allowedHosts: [],
      modelDriverFactory: () => ({
        async propose() {
          proposalCalls += 1;
          throw new Error('ordinary chat must not enter proposal planning');
        },
        async respond(request) {
          responseCalls += 1;
          expect(request.objective).toBe('Hi, what can you help me with?');
          expect(request.responseDepth).toBe('reasoned');
          expect(request.maxOutputTokens).toBe(2_048);
          return {
            answer: 'I can help you research, build, explain, and create polished deliverables.',
            model: 'test:conversation',
            usage: { inputTokens: 12, outputTokens: 10, latencyMs: 1 },
          };
        },
      }),
    });
    const response = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hi, what can you help me with?', run_mode: 'reasoned' }),
    }));
    const frames = (await response.text()).split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as Record<string, any>);
    expect(responseCalls).toBe(1);
    expect(proposalCalls).toBe(0);
    expect(frames.some(frame => frame.event?.type === 'context.packet')).toBeFalse();
    expect(frames.find(frame => frame.event?.type === 'respond.final')?.event.payload.text)
      .toContain('research, build, explain');
    const runId = frames.find(frame => frame.kind === 'meta')?.run_id as string;
    const ledger = readFileSync(join(root, 'ledgers', `${runId}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(ledger.find(event => event.type === 'operator.run_started')?.payload.preparation).toMatchObject({
      history: 'bounded_recent_only',
      knowledgeRetrieval: 'skipped',
      memoryRetrieval: 'skipped',
      contextCompilation: 'skipped',
    });
    expect(ledger.find(event => event.type === 'operator.run_finished')?.payload.responseLane).toBe('conversation');
    expect(ledger.find(event => event.type === 'operator.run_finished')?.payload.outcomeKind).toBe('answered');
  });

  test('routes a requested single-file app into coding tools instead of conversational HTML output', async () => {
    const root = temporaryRoot();
    let visibleCapabilities: string[] = [];
    let responseCalls = 0;
    const handler = createRuntimeHttpHandler({
      port: 0, workspace: root, ledgerDirectory: join(root, 'ledgers'),
      operatorDataPath: join(root, 'operator.json'), provider: 'ollama', model: 'test-model',
      allowedExecutables: ['bun'], allowedHosts: [],
      modelDriverFactory: () => ({
        async propose(_packet, capabilities) {
          visibleCapabilities = capabilities.map(capability => capability.id);
          throw new Error('fixture stops after connection selection');
        },
        async respond() {
          responseCalls += 1;
          return { answer: 'incorrect direct response', model: 'fixture', usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 } };
        },
      }),
    });
    const response = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Create a routine maker and tracker and code it in one HTML with all functionality.',
        profile: 'coder', run_mode: 'agent',
      }),
    }));
    const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as Record<string, any>);
    expect(responseCalls).toBe(0);
    expect(visibleCapabilities).toEqual(expect.arrayContaining([
      'workspace.repository.search', 'workspace.file.write', 'workspace.file.patch', 'workspace.process.run',
    ]));
    const runId = String(frames.find(frame => frame.kind === 'meta')?.run_id);
    const ledger = readFileSync(join(root, 'ledgers', `${runId}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(ledger.find(event => event.type === 'operator.run_started')?.payload).toMatchObject({
      responseLane: 'workflow',
      connectionPlan: { lane: 'coding' },
    });
  });

  test('commits explicit operator memory and supplies it to a later direct response', async () => {
    const root = temporaryRoot();
    const operatorPath = join(root, 'operator.json');
    const contexts: string[] = [];
    const handler = createRuntimeHttpHandler({
      port: 0, workspace: root, ledgerDirectory: join(root, 'ledgers'), operatorDataPath: operatorPath,
      provider: 'ollama', model: 'test-model', allowedExecutables: [], allowedHosts: [],
      modelDriverFactory: () => ({
        async propose() { throw new Error('operator memory must not be routed to uploaded-file search'); },
        async respond(request) {
          contexts.push(request.operatorContext ?? '');
          return {
            answer: request.objective.includes('Remember') ? 'I will remember that.' : 'Your favorite color is blue.',
            model: 'test:memory-conversation', usage: { inputTokens: 10, outputTokens: 5, latencyMs: 1 },
          };
        },
      }),
    });
    const vague = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'use memory tool to store my name', session_id: 'session:memory' }),
    }));
    expect(await vague.text()).toContain('What exact value should I remember?');
    const emptyMemory = await handler(new Request('http://runtime.local/api/memory?session_id=session%3Amemory'));
    expect(await emptyMemory.json()).toMatchObject({ memory: [] });

    const first = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Remember that my favorite color is blue.', session_id: 'session:memory' }),
    }));
    const firstFrames = (await first.text()).split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as Record<string, any>);
    expect(firstFrames.some(frame => frame.event?.type === 'memory.commit')).toBeTrue();
    const memoryResponse = await handler(new Request('http://runtime.local/api/memory?session_id=session%3Amemory'));
    expect(await memoryResponse.json()).toMatchObject({
      memory: [{ content: 'Remember that my favorite color is blue.', kind: 'fact', evidenceRefs: [expect.stringContaining('request:run:')] }],
    });

    const second = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: "What's my favorite color?", session_id: 'session:memory' }),
    }));
    const secondText = await second.text();
    expect(secondText).toContain('Your favorite color is blue.');
    expect(contexts.at(-1)).toContain('Verified session memory (runtime-supplied');
    expect(contexts.at(-1)).toContain('favorite color is blue');

    const stored = await handler(new Request('http://runtime.local/api/memory?session_id=session%3Amemory'));
    const storedBody = await stored.json() as { memory: Array<{ id: string }> };
    const memoryId = storedBody.memory[0]!.id;
    const deleted = await handler(new Request(
      `http://runtime.local/api/memory/${encodeURIComponent(memoryId)}`,
      { method: 'DELETE' },
    ));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ ok: true, status: 'deleted', already_deleted: false });
    const retriedDelete = await handler(new Request(
      `http://runtime.local/api/memory/${encodeURIComponent(memoryId)}`,
      { method: 'DELETE' },
    ));
    expect(retriedDelete.status).toBe(200);
    expect(await retriedDelete.json()).toMatchObject({ ok: true, status: 'deleted', already_deleted: true });
    const afterDelete = await handler(new Request('http://runtime.local/api/memory?session_id=session%3Amemory'));
    expect(await afterDelete.json()).toEqual({ memory: [] });
  });

  test('supplies a wider operator-only transcript for exact prompt-history requests', async () => {
    const root = temporaryRoot();
    const operatorPath = join(root, 'operator.json');
    const store = new JsonOperatorStore(operatorPath);
    store.ensureSession('session:transcript', now, 'Transcript');
    for (let index = 0; index < 12; index += 1) {
      store.appendMessage('session:transcript', { id: `message:${index}:user`, role: 'user', content: `exact prompt ${index}`, at: now, runId: `run:${index}` });
      store.appendMessage('session:transcript', { id: `message:${index}:assistant`, role: 'assistant', content: `generic answer ${index}`, at: now, runId: `run:${index}` });
    }
    let suppliedContext = '';
    const handler = createRuntimeHttpHandler({
      port: 0, workspace: root, ledgerDirectory: join(root, 'ledgers'), operatorDataPath: operatorPath,
      provider: 'ollama', model: 'test-model', allowedExecutables: [], allowedHosts: [],
      modelDriverFactory: () => ({
        async propose() { throw new Error('exact transcript chat must remain on the direct lane'); },
        async respond(request) {
          suppliedContext = request.operatorContext ?? '';
          return { answer: 'Listed.', model: 'test:transcript', usage: { inputTokens: 10, outputTokens: 2, latencyMs: 1 } };
        },
      }),
    });
    await (await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'List every prompt I said so far in this chat exactly.', session_id: 'session:transcript' }),
    }))).text();
    expect(suppliedContext).toContain('Operator: exact prompt 0');
    expect(suppliedContext).toContain('Operator: exact prompt 11');
    expect(suppliedContext).not.toContain('generic answer');
  });

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
      service_revision: 'product-v10',
      contracts: { canonical_event: CONTRACT_VERSION, ui_event: '1.0', stream: '1.0', runtime_graph: '1.0' },
      profiles: ['inspect', 'workspace', 'partner'],
      approval_thresholds: { inspect: 5, workspace: 4, partner: 2 },
      verification: {
        observed_state: true,
        arbitrary_semantic_claims: false,
      },
      memory: { durable_agent_memory: true, commit_policy: 'verified_outcomes_only' },
      profile_details: {
        partner: {
          label: 'Partner · all configured tools',
          capabilities: ['workspace.file.read', 'workspace.directory.list', 'workspace.repository.search', 'system.clock.read', 'workspace.file.write', 'workspace.file.patch', 'session.knowledge.search'],
        },
      },
      model_routing: {
        modes: ['fallback', 'ping_pong', 'ring', 'ring_pair', 'round_robin'],
        route_counts: { ping_pong: 2, ring: 3, ring_pair: 4 },
      },
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
    expect(meta).toMatchObject({
      stream_version: '1.0',
      event_schema_version: '1.0',
      evidence_class: 'canonical_run',
    });
    expect(frames.find(frame => frame.kind === 'event')?.event).toMatchObject({
      schema_version: '1.0',
      timing_source: 'live_projection',
      provenance: 'canonical_ledger',
    });
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
          audit: { sourcesConsidered: 0 },
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
    const memoryBody = (await memory.json()) as { memory: Array<{ id: string; content: string }> };
    expect(memoryBody.memory).toHaveLength(1);
    const projection = await handler(new Request(
      `http://runtime.local/api/runs/${encodeURIComponent(meta?.run_id)}/projection`,
    ));
    expect(await projection.json()).toMatchObject({ projection: { status: 'completed', pendingEffects: [] } });
    const contextView = await handler(new Request(
      `http://runtime.local/api/runs/${encodeURIComponent(meta?.run_id)}/context`,
    ));
    const contextBody = await contextView.json() as { packets: Array<{ items: unknown[]; tool_call?: unknown }> };
    expect(contextBody.packets.length).toBe(1);
    expect(contextBody.packets[0]?.items).toHaveLength(0);
    expect(contextBody.packets.some(packet => !!packet.tool_call)).toBeTrue();
    const inferenceView = await handler(new Request(
      `http://runtime.local/api/runs/${encodeURIComponent(meta?.run_id)}/inference`,
    ));
    expect(await inferenceView.json()).toMatchObject({
      run_id: meta?.run_id,
      evidence_class: 'canonical_inference_projection',
      passes: [{ model: 'test:http-driver', prompt: { system_content: 'excluded_by_default' } }],
    });
    const memoryGraph = await handler(new Request(
      `http://runtime.local/api/memory/graph?session_id=${encodeURIComponent(meta?.session_id)}`,
    ));
    expect(await memoryGraph.clone().json()).toMatchObject({
      evidence_class: 'canonical_run_projection',
      counts: { memories: 1, active_memories: 1, runs: 1, contexts: 1 },
      integrity: { canonical_runs: 1, orphan_edges: 0, truncated: false },
    });
    const edited = await handler(new Request(
      `http://runtime.local/api/memory/${encodeURIComponent(memoryBody.memory[0]!.id)}`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'User-corrected verified memory.' }) },
    ));
    expect(await edited.json()).toMatchObject({ memory: { content: 'User-corrected verified memory.', editedByUser: true } });
    const passMetrics = await handler(new Request(
      `http://runtime.local/api/runs/${encodeURIComponent(meta?.run_id)}/pass-metrics`,
    ));
    expect(await passMetrics.json()).toMatchObject({
      run_id: meta?.run_id,
      metrics: { passes_audited: 1 },
    });
    const trail = await handler(new Request(
      `http://runtime.local/api/runs/${encodeURIComponent(meta?.run_id)}/trail`,
    ));
    const trailBody = await trail.json() as Record<string, any>;
    expect(trailBody).toMatchObject({
      schema_version: '1.0',
      evidence_class: 'canonical_run_projection',
      run_id: meta?.run_id,
      integrity: { valid: true },
      summary: {
        status: 'completed',
        effects_attempted: 1,
        verified_actions: 1,
        completion_verified: true,
      },
    });
    expect(trailBody.events.every((event: Record<string, unknown>) => event.timing_source === 'replay_projection')).toBeTrue();
    expect(new Set(trailBody.events.map((event: Record<string, unknown>) => event.id)).size).toBe(trailBody.events.length);
    const signals = await handler(new Request('http://runtime.local/api/signals'));
    expect(await signals.json()).toMatchObject({
      aggregate: { passes_audited: 1 },
      runs: [{ id: meta?.run_id }],
    });
    const labCatalog = await handler(new Request('http://runtime.local/api/lab/catalog'));
    expect(await labCatalog.json()).toMatchObject({
      agents: [{ id: 'verified-minimal' }, { id: 'resilient-operator' }, { id: 'research-specialist' }],
      evidence_policy: { live_runs: 'canonical_run', benchmarks: 'deterministic_fixture' },
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
    const rebuiltMemoryResponse = await restarted(new Request(
      `http://runtime.local/api/memory?session_id=${encodeURIComponent(meta?.session_id)}`,
    ));
    expect(await rebuiltMemoryResponse.json()).toMatchObject({
      memory: [{ content: 'User-corrected verified memory.', editedByUser: true, status: 'active' }],
    });
    const rebuiltEvents = await restarted(new Request(
      `http://runtime.local/api/runs/${encodeURIComponent(meta?.run_id)}/events`,
    ));
    expect(((await rebuiltEvents.json()) as { events: Array<{ type: string }> }).events.some(
      event => event.type === 'memory.user_superseded',
    )).toBeTrue();
  });

  test('cancels an active HTTP model request through the durable run controller', async () => {
    const root = temporaryRoot();
    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory: join(root, 'ledgers'),
      operatorDataPath: join(root, 'operator.json'),
      provider: 'ollama',
      model: 'test-model',
      allowedExecutables: [],
      allowedHosts: [],
      modelDriverFactory: () => ({
        async propose(_packet, _capabilities, _scope, signal) {
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          throw new Error('unreachable');
        },
      }),
    });
    const response = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Wait for cancellation.' }),
    }));
    const reader = response.body!.getReader();
    const first = await reader.read();
    const initial = new TextDecoder().decode(first.value);
    const metaLine = initial.split('\n').find(line => line.startsWith('data: '));
    const meta = JSON.parse(metaLine!.slice(6)) as { run_id: string; session_id: string };

    const cancelled = await handler(new Request(
      `http://runtime.local/api/runs/${encodeURIComponent(meta.run_id)}/cancel`,
      { method: 'POST' },
    ));
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toMatchObject({ run_id: meta.run_id, status: 'cancelling' });
    while (!(await reader.read()).done) { /* drain terminal cancellation events */ }

    const runs = await handler(new Request(`http://runtime.local/api/runs?session_id=${encodeURIComponent(meta.session_id)}`));
    expect(await runs.json()).toMatchObject({ runs: [expect.objectContaining({ id: meta.run_id, status: 'cancelled' })] });
    const events = readFileSync(join(root, 'ledgers', `${meta.run_id}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: 'operator.run_cancelled' });
  });

  test('projects a verified generated file into the session artifact viewer', async () => {
    const root = temporaryRoot();
    let step = 0;
    const handler = createRuntimeHttpHandler({
      port: 0, workspace: root, ledgerDirectory: join(root, 'ledgers'),
      operatorDataPath: join(root, 'operator.json'), provider: 'ollama', model: 'test-model',
      allowedExecutables: [], allowedHosts: [],
      modelDriverFactory: () => ({
        async propose(_packet, _capabilities, scope) {
          step += 1;
          return {
            proposal: step === 1 ? {
              kind: 'action', strategyId: scope.activeStrategyId,
              hypothesis: 'A report can be written.', expectedObservation: 'The report is observed.',
              action: {
                id: 'proposal:artifact-write', intentId: scope.intentId, principalId: scope.principalId,
                conditionIds: scope.requiredConditionIds, capabilityId: 'workspace.file.write',
                target: 'workspace/generated-report.md', declaredEffects: ['state.write'], risk: 2,
                expectedEvidence: scope.requiredEvidence, idempotencyKey: 'artifact-write:one',
                args: { content: '# Verified report\n\nGenerated by the bounded runtime.\n' },
              },
            } : {
              kind: 'complete', strategyId: scope.activeStrategyId, evidenceRefs: scope.requiredEvidence,
            },
            usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 }, model: 'test:artifact-driver',
          };
        },
      }),
    });
    const response = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Create a verified report.', profile: 'workspace', run_mode: 'agent' }),
    }));
    const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as Record<string, any>);
    const meta = frames.find(frame => frame.kind === 'meta');
    expect(meta).toBeDefined();
    const sessionId = String(meta!.session_id);
    expect(frames.some(frame => frame.event?.type === 'artifact.ready')).toBeTrue();
    expect(frames.find(frame => frame.event?.type === 'run.end')?.event).toMatchObject({
      title: 'Artifact created', payload: { outcomeKind: 'artifact_created', artifactCount: 1 },
    });

    const files = await handler(new Request(`http://runtime.local/api/sessions/${encodeURIComponent(sessionId)}/files`));
    const body = await files.json() as { artifacts: Array<{ id: string; target: string; verified: boolean }> };
    expect(body.artifacts).toEqual([expect.objectContaining({ target: 'workspace/generated-report.md', verified: true })]);
    const preview = await handler(new Request(
      `http://runtime.local/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(body.artifacts[0]!.id)}/preview`,
    ));
    expect(await preview.json()).toMatchObject({
      previewKind: 'markdown', content: '# Verified report\n\nGenerated by the bounded runtime.\n',
      provenance: { proposalId: 'proposal:artifact-write' },
    });
  });

  test('runs a persisted ping-pong provider/model schedule with automatic fallback', async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, 'input.txt'), 'scheduled evidence');
    let primaryCalls = 0;
    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory: join(root, 'ledgers'),
      operatorDataPath: join(root, 'operator.json'),
      provider: 'ollama',
      model: 'model-a',
      providers: [{ id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: 'model-b' }],
      allowedExecutables: [],
      allowedHosts: [],
      modelDriverFactory: selection => ({
        async propose(_packet, _capabilities, scope) {
          if (selection?.model === 'model-b') throw new Error('route B unavailable');
          primaryCalls += 1;
          return {
            proposal: primaryCalls === 1 ? {
              kind: 'action', strategyId: scope.activeStrategyId,
              hypothesis: 'The bounded input file is readable.', expectedObservation: 'Its content is observed.',
              action: {
                id: 'proposal:ping-read', intentId: scope.intentId, principalId: scope.principalId,
                conditionIds: scope.requiredConditionIds, capabilityId: 'workspace.file.read',
                target: 'workspace/input.txt', declaredEffects: ['state.read'], risk: 1,
                expectedEvidence: scope.requiredEvidence, idempotencyKey: 'ping-read:1', args: {},
              },
            } : {
              kind: 'complete', strategyId: scope.activeStrategyId,
              evidenceRefs: ['observation:proposal:ping-read'],
            },
            usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 },
            model: `fixture:${selection?.provider}/${selection?.model}`,
          };
        },
      }),
    });
    const session = await handler(new Request('http://runtime.local/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Ping pong' }),
    }));
    const sessionId = ((await session.json()) as { session: { id: string } }).session.id;
    const routes = [
      { provider: 'ollama', model: 'model-a' },
      { provider: 'lmstudio', model: 'model-b' },
    ];
    const saved = await handler(new Request(`http://runtime.local/api/sessions/${encodeURIComponent(sessionId)}/agent`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        provider: 'ollama', model: 'model-a', profile: 'inspect', routing_mode: 'ping_pong', routing_routes: routes,
      }),
    }));
    expect(await saved.json()).toMatchObject({ agent: { routingMode: 'ping_pong', routingRoutes: routes } });
    const invalidRing = await handler(new Request(`http://runtime.local/api/sessions/${encodeURIComponent(sessionId)}/agent`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        provider: 'ollama', model: 'model-a', routing_mode: 'ring', routing_routes: routes,
      }),
    }));
    expect(invalidRing.status).toBe(400);
    expect(await invalidRing.json()).toMatchObject({ error: 'ring routing requires exactly 3 provider/model routes.' });
    const response = await handler(new Request('http://runtime.local/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        message: 'Inspect the workspace directory and read workspace/input.txt.', session_id: sessionId,
      }),
    }));
    const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as Record<string, any>);
    expect(frames.find(frame => frame.kind === 'meta')).toMatchObject({
      routing_mode: 'ping_pong', routing_routes: routes,
    });
    const routeEvents = frames.filter(frame => frame.event?.type === 'model.request' && frame.event?.payload?.routeId);
    expect(routeEvents.map(frame => ({ route: frame.event.payload.routeId, pass: frame.event.payload.pass, preferred: frame.event.payload.preferred }))).toEqual([
      { route: '1:ollama/model-a', pass: 1, preferred: true },
      { route: '2:lmstudio/model-b', pass: 2, preferred: true },
      { route: '1:ollama/model-a', pass: 2, preferred: false },
    ]);
    expect(frames.some(frame => frame.event?.type === 'model.response' && frame.event?.payload?.routeId === '2:lmstudio/model-b')).toBeTrue();
    expect(frames.some(frame => frame.event?.type === 'run.end')).toBeTrue();
  });

  test('cools an authentication-failed route across runs and uses the healthy fallback', async () => {
    const root = temporaryRoot();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const handler = createRuntimeHttpHandler({
      port: 0, workspace: root, ledgerDirectory: join(root, 'ledgers'),
      operatorDataPath: join(root, 'operator.json'), provider: 'ollama', model: 'model-a',
      providers: [{ id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: 'model-b' }],
      modelRouteSchedule: [
        { provider: 'ollama', model: 'model-a' },
        { provider: 'lmstudio', model: 'model-b' },
      ],
      allowedExecutables: [], allowedHosts: [],
      modelDriverFactory: selection => ({
        async propose() { throw new Error('proposal path is not expected'); },
        async respond() {
          if (selection?.model === 'model-a') {
            primaryCalls += 1;
            throw new Error('HTTP 403 forbidden');
          }
          fallbackCalls += 1;
          return { answer: 'Fallback answer.', model: 'fixture:fallback', usage: { inputTokens: 4, outputTokens: 2, latencyMs: 1 } };
        },
      }),
    });
    const run = async () => handler(new Request('http://runtime.local/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello there.', routing_mode: 'fallback' }),
    })).then(response => response.text());
    expect(await run()).toContain('Fallback answer.');
    expect(await run()).toContain('Fallback answer.');
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(2);
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
      NVIDIA_API_KEY: 'test-nvidia-key',
      DEEPSEEK_API_KEY: 'test-deepseek-key',
      MISTRAL_API_KEY: 'test-mistral-key',
      OPENCODE_API_KEY: 'test-opencode-key',
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
      profiles: ['inspect', 'workspace', 'web', 'research', 'media', 'partner'],
      features: { web_search: true },
      capabilities: [
        { id: 'workspace.file.read' },
        { id: 'workspace.directory.list' },
        { id: 'workspace.repository.search' },
        { id: 'system.clock.read' },
        { id: 'workspace.file.write' },
        { id: 'workspace.file.patch' },
        { id: 'session.knowledge.search' },
        { id: 'network.web.search' },
        { id: 'media.image.analyze' },
      ],
      providers: [
        { id: 'gemini', configured: true },
        { id: 'ollama', configured: true, default_model: 'llama3.2' },
        { id: 'anthropic', configured: true },
        { id: 'openai-compatible', configured: false },
        { id: 'openai', configured: false },
        { id: 'groq', configured: true },
        { id: 'openrouter', configured: true },
        { id: 'nvidia', configured: true },
        { id: 'deepseek', configured: true, default_model: 'deepseek-chat' },
        { id: 'mistral', configured: true, default_model: 'mistral-small-latest' },
        { id: 'opencode', configured: true },
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

  test('loads an explicit environment model route schedule with route A as primary', () => {
    const root = temporaryRoot();
    const routes = [
      { provider: 'anthropic', model: 'claude-route-a' },
      { provider: 'groq', model: 'llama-route-b' },
    ];
    const config = runtimeHttpConfig({
      HYPER_MODEL_ROUTING_MODE: 'ping_pong',
      HYPER_MODEL_ROUTE_SCHEDULE: JSON.stringify(routes),
      ANTHROPIC_API_KEY: 'test-a', GROQ_API_KEY: 'test-b',
      HYPER_WORKSPACE: root, HYPER_LEDGER_DIR: join(root, 'ledgers'),
    });
    expect(config).toMatchObject({
      provider: 'anthropic', model: 'claude-route-a', modelRoutingMode: 'ping_pong', modelRouteSchedule: routes,
    });
    expect(() => runtimeHttpConfig({ HYPER_MODEL_ROUTE_SCHEDULE: 'not-json' })).toThrow('JSON array');
  });

  test('shows only OpenCode Zen models compatible with the current chat transport', async () => {
    const root = temporaryRoot();
    const config = runtimeHttpConfig({
      OPENCODE_API_KEY: 'test-opencode-key',
      HYPER_WORKSPACE: root,
      HYPER_LEDGER_DIR: join(root, 'ledgers'),
      HYPER_OPERATOR_DATA: join(root, 'operator.json'),
    });
    const authorizations: Array<string | null> = [];
    config.providerFetch = async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization'));
      return Response.json({
        data: [
          { id: 'gpt-5.6' },
          { id: 'claude-opus-4-6' },
          { id: 'gemini-3.1-pro' },
          { id: 'deepseek-v4-flash-free' },
          { id: 'nemotron-3-ultra-free' },
        ],
      });
    };
    const handler = createRuntimeHttpHandler(config);
    const response = await handler(new Request('http://runtime.local/api/models/opencode'));

    expect(await response.json()).toMatchObject({
      provider: 'opencode',
      connected: true,
      models: [
        { id: 'deepseek-v4-flash-free' },
        { id: 'nemotron-3-ultra-free' },
      ],
    });
    expect(authorizations).toEqual(['Bearer test-opencode-key']);
  });

  test('registers only authority-mapped MCP tools discovered from configured endpoints', async () => {
    const root = temporaryRoot();
    const methods: string[] = [];
    const handler = createRuntimeHttpHandler({
      port: 0,
      workspace: root,
      ledgerDirectory: join(root, 'ledgers'),
      operatorDataPath: join(root, 'operator.json'),
      provider: 'ollama',
      model: 'fixture',
      allowedExecutables: [],
      allowedHosts: [],
      mcpServers: [{
        id: 'fixture-mcp',
        endpoint: 'https://mcp.fixture.test/mcp',
        authorities: [{
          toolName: 'lookup', observationToolName: 'lookup_observe', effects: ['state.read'],
          targetPatterns: ['mcp://lookup/**'], riskCeiling: 2, approval: 'never',
        }],
      }],
      providerFetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id?: number; method: string };
        methods.push(request.method);
        const result = request.method === 'initialize'
          ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
          : { tools: [
              { name: 'lookup', inputSchema: { type: 'object' } },
              { name: 'lookup_observe', inputSchema: { type: 'object' } },
              { name: 'unmapped_delete', inputSchema: { type: 'object' } },
            ] };
        return Response.json({ jsonrpc: '2.0', id: request.id, result });
      },
    });
    const response = await handler(new Request('http://runtime.local/api/config'));
    const config = await response.json() as { capabilities: Array<{ id: string }> };

    expect(config.capabilities.map(item => item.id)).toContain('mcp.lookup');
    expect(config.capabilities.map(item => item.id)).not.toContain('mcp.unmapped_delete');
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
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

  test('discovers configured media capabilities without exposing provider credentials', async () => {
    const root = temporaryRoot();
    const config = runtimeHttpConfig({
      HYPER_WORKSPACE: root,
      HYPER_LEDGER_DIR: join(root, 'ledgers'),
      HYPER_OPERATOR_DATA: join(root, 'operator.json'),
      HYPER_PROVIDER: 'ollama',
      DEEPGRAM_API_KEY: 'deepgram-secret',
      ELEVENLABS_API_KEY: 'eleven-secret',
      HYPER_ELEVENLABS_VOICE_ID: 'voice_fixture',
      HYPER_ELEVENLABS_AGENT_IDS: 'agent_fixture',
      GEMINI_API_KEY: 'gemini-secret',
      OPENAI_API_KEY: 'openai-secret',
      HYPER_VISION_MODEL: 'gemini-flash-latest',
      HYPER_IMAGE_MODEL: 'gpt-image-2',
    });
    const handler = createRuntimeHttpHandler(config);
    const response = await handler(new Request('http://runtime.local/api/config'));
    const payload = await response.json() as {
      profiles: string[];
      capabilities: Array<{ id: string }>;
      features: Record<string, unknown>;
    };
    const capabilityIds = payload.capabilities.map(item => item.id);

    expect(payload.profiles).toContain('media');
    expect(capabilityIds).toEqual(expect.arrayContaining([
      'media.audio.transcribe.deepgram',
      'media.audio.synthesize.deepgram',
      'media.voice.session.deepgram',
      'media.audio.transcribe.elevenlabs',
      'media.audio.synthesize.elevenlabs',
      'media.voice.session.elevenlabs',
      'media.image.analyze',
      'media.image.generate',
    ]));
    expect(payload.features).toMatchObject({ bounded_media: true, ephemeral_voice_sessions: true });
    expect(JSON.stringify(payload)).not.toContain('deepgram-secret');
    expect(JSON.stringify(payload)).not.toContain('eleven-secret');
    expect(JSON.stringify(payload)).not.toContain('gemini-secret');
    expect(JSON.stringify(payload)).not.toContain('openai-secret');

    const issued = config.voiceSessionBroker!.issue('wss://api.elevenlabs.io/v1/convai/conversation?token=single-use');
    const claim = await handler(new Request(`http://runtime.local/api/media/voice-sessions/${issued.handle}/claim`, { method: 'POST' }));
    expect(claim.headers.get('cache-control')).toBe('no-store');
    expect(await claim.json()).toEqual({
      provider: 'elevenlabs',
      signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?token=single-use',
      expires_at: issued.expiresAt,
    });
    const replayedClaim = await handler(new Request(`http://runtime.local/api/media/voice-sessions/${issued.handle}/claim`, { method: 'POST' }));
    expect(replayedClaim.status).toBe(410);
  });
});
