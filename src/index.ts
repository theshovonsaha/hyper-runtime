/**
 * index.ts — Server entry point using Bun.serve().
 *
 * Provides:
 *   - POST /api/chat          SSE streaming chat
 *   - GET  /api/runs/:id/gate Gate inspection
 *   - POST /api/runs/:id/gate Gate resolution
 *   - POST /api/runs/:id/cancel  Cancel a run
 *   - GET  /api/runs/:id/trail    Trail replay
 *   - GET  /api/runs/:id/events   Raw events
 *   - GET  /api/sessions          List sessions
 *   - GET  /api/sessions/:id/messages  Session history
 *   - GET  /api/memory            Memory notes
 *   - DELETE /api/memory/:id      Delete a note
 *   - GET  /api/schedules         List schedules
 *   - POST /api/schedules         Create schedule
 *   - GET  /api/config            Runtime config
 *   - POST /api/settings          Update settings
 *   - GET  /api/health            Health check
 *   - GET  /                      Serve UI
 */

import { join } from 'path';
import { loadConfig, ensureDataDirs } from './types/config';
import { parseInspectionLevel, type InspectionLevel } from './types/events';
import { Store } from './store/sqlite';
import { EventStore, AsyncQueue } from './store/events';
import { ContextAssembler } from './context/assembler';
import { TurnGate } from './context/gate';
import { ProjectionsEngine } from './core/projections';
import { ToolRegistry } from './tools/registry';
import { createBuiltinTools } from './tools/builtins';
import { RunKernel } from './core/kernel';

import type { TrailEvent } from './types/events';
import { ContextDriftHealer } from './core/heal';
import { BranchManager } from './core/branch';
import { computeAttribution } from './core/attribution';
import { evaluateScorecard } from './core/scorecard';
import { listModels } from './core/models';

const healer = new ContextDriftHealer();
const branchManager = new BranchManager();

// ---- Bootstrap ----

const config = loadConfig();
ensureDataDirs(config);

const store = new Store(join(config.dataDir, 'shovs_v2.db'));
const eventStore = new EventStore(config.dataDir);
const gate = new TurnGate();

// Build tool registry
const registry = new ToolRegistry();
registry.registerMany(createBuiltinTools());

// Build context assembler
const assembler = new ContextAssembler(config, store);

// Build kernel
const kernel = new RunKernel(config, store, eventStore, assembler, gate, registry);

// Track running tasks
const running = new Map<string, AbortController>();

// ---- SSE helper ----

function sse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data, (_k, v) =>
    typeof v === 'bigint' ? Number(v) : v
  )}\n\n`;
}

// ---- Route matching ----

function matchRoute(
  method: string,
  pathname: string,
  pattern: string,
  targetMethod: string,
): Record<string, string> | null {
  if (method !== targetMethod) return null;

  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ---- Server ----

import { existsSync } from 'node:fs';

function resolveUiDir(): string {
  const candidates = [
    join(import.meta.dir, '..', 'ui', 'dist'),
    join(import.meta.dir, '..', 'ui'),
    join(process.cwd(), 'ui', 'dist'),
    join(process.cwd(), 'ui'),
    join(import.meta.dir, '..', '..', 'ui', 'dist'),
    join(import.meta.dir, '..', '..', 'ui'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) {
      return c;
    }
  }
  return join(import.meta.dir, '..', 'ui');
}

const UI_DIR = resolveUiDir();

const server = Bun.serve({
  port: config.port,

  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;
    let params: Record<string, string> | null;

    try {
      // ---- Standalone Microservice Endpoint: POST /api/v1/heal/assess ----
      if (method === 'POST' && pathname === '/api/v1/heal/assess') {
        const body = await req.json() as Record<string, any>;
        const result = healer.healContext(body.items || [], body.last_error);
        return jsonResponse(result as any, 200);
      }

      // ---- Standalone Microservice Endpoint: POST /api/v1/branch/fork ----
      if (method === 'POST' && pathname === '/api/v1/branch/fork') {
        const body = await req.json() as Record<string, any>;
        const node = branchManager.createBranch(String(body.parent_run_id || ''), Number(body.fork_at_turn || 0), body.note);
        return jsonResponse(node as any, 201);
      }

      // ---- Standalone Microservice Endpoint: POST /api/v1/attribution/compute ----
      if (method === 'POST' && pathname === '/api/v1/attribution/compute') {
        const body = await req.json() as Record<string, any>;
        const report = computeAttribution(String(body.run_id || ''), String(body.response_text || ''), body.items || []);
        return jsonResponse(report as any, 200);
      }

      // ---- Standalone Microservice Endpoint: POST /api/v1/scorecard/evaluate ----
      if (method === 'POST' && pathname === '/api/v1/scorecard/evaluate') {
        const body = await req.json() as Record<string, any>;
        const metrics = evaluateScorecard(body as any);
        return jsonResponse(metrics as any, 200);
      }

      // ---- POST /api/chat (SSE stream) ----
      if (method === 'POST' && pathname === '/api/chat') {
        const body = await req.json() as Record<string, unknown>;
        const message = String(body.message || '');
        if (!message.trim()) {
          return jsonResponse({ error: 'message is required' }, 400);
        }

        const sessionId = store.ensureSession(
          body.session_id ? String(body.session_id) : null,
          message,
        );

        const envelope = {
          run_id: crypto.randomUUID(),
          session_id: sessionId,
          message,
          files: Array.isArray(body.files) ? body.files.map((f: any) => ({
            name: String(f.name || ''),
            text: String(f.text || ''),
          })) : [],
          images: Array.isArray(body.images) ? body.images : [],
          provider: body.provider ? String(body.provider) : undefined,
          model: body.model ? String(body.model) : undefined,
          gate: typeof body.gate === 'boolean' ? body.gate : undefined,
          auto: !!body.auto,
          level: body.level ? String(body.level) : undefined,
          passes: typeof body.passes === 'object' && body.passes !== null ? body.passes as any : undefined,
        };

        const level = parseInspectionLevel(envelope.level, config.inspectionLevel);
        const queue = eventStore.subscribe(envelope.run_id);

        // Run the kernel in the background
        const ac = new AbortController();
        running.set(envelope.run_id, ac);

        const runPromise = (async () => {
          await kernel.run(envelope);
        })().finally(() => {
          running.delete(envelope.run_id);
        });

        // Return SSE stream
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();

            // Meta event
            controller.enqueue(encoder.encode(sse({
              kind: 'meta',
              run_id: envelope.run_id,
              session_id: sessionId,
              level: ['off', 'summary', 'normal', 'debug', 'raw'][level],
              provider: envelope.provider || config.provider,
            })));

            let done = false;
            const checkDone = () => {
              runPromise.then(() => { done = true; }).catch(() => { done = true; });
            };
            checkDone();

            while (!done) {
              try {
                const event = await Promise.race([
                  queue.get(),
                  new Promise<null>(resolve => setTimeout(() => resolve(null), 2000)),
                ]);

                if (event === null) {
                  // Keepalive
                  if (done) break;
                  controller.enqueue(encoder.encode(': keepalive\n\n'));
                  continue;
                }

                const rendered = eventStore.renderEvent(event, level);
                if (rendered !== null) {
                  controller.enqueue(encoder.encode(sse({ kind: 'event', event: rendered })));
                }

                if (event.type === 'run.end') {
                  done = true;
                }
              } catch {
                break;
              }
            }

            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // ---- Gate endpoints ----
      params = matchRoute(method, pathname, '/api/runs/:run_id/gate', 'GET');
      if (params) {
        const view = gate.pendingView(params.run_id);
        if (!view) return jsonResponse({ error: 'no pending gate for this run' }, 404);
        return jsonResponse(view);
      }

      params = matchRoute(method, pathname, '/api/runs/:run_id/gate', 'POST');
      if (params) {
        const body = await req.json() as Record<string, unknown>;
        const action = String(body.action || 'approved');
        const result = gate.resolve(
          params.run_id,
          (action === 'approved' || action === 'cancelled') ? action : 'approved',
          body.edits as any,
          body.content ? String(body.content) : undefined,
        );
        if (!result.ok) return jsonResponse({ error: result.error }, 409);
        return jsonResponse(result);
      }

      // ---- Cancel run ----
      params = matchRoute(method, pathname, '/api/runs/:run_id/cancel', 'POST');
      if (params) {
        const ac = running.get(params.run_id);
        if (gate.hasPending(params.run_id)) {
          gate.resolve(params.run_id, 'cancelled');
          return jsonResponse({ ok: true, via: 'gate' });
        }
        if (!ac) return jsonResponse({ error: 'run is not active' }, 404);
        ac.abort();
        return jsonResponse({ ok: true, via: 'task_cancel' });
      }

      // ---- Trail / Events ----
      params = matchRoute(method, pathname, '/api/runs/:run_id/trail', 'GET');
      if (params) {
        const events = eventStore.loadEvents(params.run_id);
        if (events.length === 0) return jsonResponse({ error: 'unknown run' }, 404);
        const lvl = parseInspectionLevel(url.searchParams.get('level') || 'normal');
        const rendered = events
          .map(e => eventStore.renderEvent(e, lvl))
          .filter(Boolean);
        return jsonResponse({ run_id: params.run_id, events: rendered });
      }

      params = matchRoute(method, pathname, '/api/runs/:run_id/events', 'GET');
      if (params) {
        const events = eventStore.loadEvents(params.run_id);
        if (events.length === 0) return jsonResponse({ error: 'unknown run' }, 404);
        const lvl = parseInspectionLevel(url.searchParams.get('level') || 'debug');
        const rendered = events
          .map(e => eventStore.renderEvent(e, lvl))
          .filter(Boolean);
        return jsonResponse({ run_id: params.run_id, level: ['off', 'summary', 'normal', 'debug', 'raw'][lvl], events: rendered });
      }

      // ---- Runs ----
      if (method === 'GET' && pathname === '/api/runs') {
        const limit = parseInt(url.searchParams.get('limit') || '30', 10);
        const runs = store.listRuns(limit).map(r => ({
          ...r,
          started_ts: r.started_at ? new Date(r.started_at as string).getTime() / 1000 : 0
        }));
        return jsonResponse({ runs });
      }


      params = matchRoute(method, pathname, '/api/sessions/:session_id/trail', 'GET');
      if (params) {
        const runs = store.listSessionRuns(params.session_id);
        const lvl = parseInspectionLevel(url.searchParams.get('level') || 'normal');
        let allEvents: any[] = [];
        for (const run of runs) {
          const events = eventStore.loadEvents(run.id as string);
          const rendered = events
            .map((e: any) => eventStore.renderEvent(e, lvl))
            .filter(Boolean);
          allEvents = allEvents.concat(rendered);
        }
        // Compute DAG
        const nodes = [];
        const edges = [];
        for (const ev of allEvents) {
          nodes.push({ id: ev.id, kind: ev.phase || 'unknown', title: ev.summary || ev.type });
          if (ev.parent_id) {
            edges.push({ from: ev.parent_id, to: ev.id });
          }
        }
        
        return jsonResponse({ session_id: params.session_id, events: allEvents, graph: { nodes, edges } });
      }

      // ---- Sessions ----
      if (method === 'GET' && pathname === '/api/sessions') {
        const sessions = store.listSessions().map((s: any) => ({
          ...s,
          created_ts: s.created_at ? new Date(s.created_at as string).getTime() / 1000 : 0,
          updated_ts: s.updated_at ? new Date(s.updated_at as string).getTime() / 1000 : 0
        }));
        return jsonResponse({ sessions });
      }

      params = matchRoute(method, pathname, '/api/sessions/:session_id/messages', 'GET');
      if (params) {
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);
        return jsonResponse({ messages: store.getHistory(params.session_id, limit) });
      }

      params = matchRoute(method, pathname, '/api/sessions/:session_id/branch', 'POST');
      if (params) {
        const body = await req.json() as Record<string, unknown>;
        const runId = body.run_id;
        if (!runId) return jsonResponse({ error: 'run_id required' }, 400);
        const newSessionId = store.branchSession(params.session_id, runId, require('path').join(config.dataDir, 'events'));
        return jsonResponse({ session_id: newSessionId });
      }

      // ---- Memory ----
      if (method === 'GET' && pathname === '/api/memory') {
        const sessionId = url.searchParams.get('session_id') || undefined;
        const kind = url.searchParams.get('kind') || undefined;
        const limit = parseInt(url.searchParams.get('limit') || '200', 10);
        return jsonResponse({
          notes: store.listNotes(sessionId, kind, limit).map(n => ({
            ...n,
            ts: n.created_at ? new Date(n.created_at as string).getTime() / 1000 : 0
          })),
          counts: store.noteKindCounts(sessionId),
        });
      }

      params = matchRoute(method, pathname, '/api/memory/:note_id', 'DELETE');
      if (params) {
        if (!store.deleteNote(params.note_id)) {
          return jsonResponse({ error: 'note not found' }, 404);
        }
        return jsonResponse({ ok: true, deleted: params.note_id });
      }

      // ---- Core Memory & Notes ----
      params = matchRoute(method, pathname, '/api/sessions/:session_id/notes', 'GET');
      if (params) {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const notes = store.listNotes(params.session_id, undefined, limit).map(n => ({
          ...n,
          ts: n.created_at ? new Date(n.created_at as string).getTime() / 1000 : 0
        }));
        return jsonResponse({ notes });
      }

      params = matchRoute(method, pathname, '/api/sessions/:session_id/core_memory', 'GET');
      if (params) {
        return jsonResponse({ content: store.getCoreMemory(params.session_id) });
      }

      params = matchRoute(method, pathname, '/api/sessions/:session_id/core_memory', 'PUT');
      if (params) {
        const body = await req.json() as Record<string, unknown>;
        store.setCoreMemory(params.session_id, String(body.content || '').slice(0, 1600));
        return jsonResponse({ ok: true });
      }

      if (method === 'POST' && pathname === '/api/memory/bulk_delete') {
        const body = await req.json() as Record<string, unknown>;
        const ids = (body.ids as string[]) || [];
        if (ids.length === 0) return jsonResponse({ error: 'ids required' }, 400);
        return jsonResponse({ ok: true, ...store.bulkDeleteNotes(ids) });
      }

      // ---- Schedules ----
      if (method === 'GET' && pathname === '/api/schedules') {
        return jsonResponse({ schedules: store.listSchedules() });
      }

      if (method === 'POST' && pathname === '/api/schedules') {
        const body = await req.json() as Record<string, unknown>;
        const sid = store.ensureSession(
          body.session_id ? String(body.session_id) : null,
          'scheduled: ' + String(body.message || ''),
        );
        const info = store.addSchedule(
          String(body.message || ''),
          Math.max(60, Number(body.every_s) || 3600),
          String(body.provider || ''),
          sid,
        );
        return jsonResponse({ ok: true, ...info });
      }

      params = matchRoute(method, pathname, '/api/schedules/:id/toggle', 'POST');
      if (params) {
        const body = await req.json() as { enabled?: boolean };
        const enabled = body.enabled ?? true;
        if (!store.setScheduleEnabled(params.id, enabled)) return jsonResponse({ error: 'not found' }, 404);
        return jsonResponse({ ok: true, enabled });
      }

      params = matchRoute(method, pathname, '/api/schedules/:id', 'DELETE');
      if (params) {
        if (!store.deleteSchedule(params.id)) return jsonResponse({ error: 'schedule not found' }, 404);
        return jsonResponse({ ok: true, deleted: params.id });
      }

      // ---- Custom Tools ----
      if (method === 'GET' && pathname === '/api/custom_tools') {
        return jsonResponse({ custom_tools: store.listCustomTools() });
      }
      
      if (method === 'POST' && pathname === '/api/custom_tools') {
        const body = await req.json() as Record<string, unknown>;
        if (!body.name || !body.description || !body.url) return jsonResponse({ error: 'Missing fields' }, 400);
        store.upsertCustomTool(body);
        return jsonResponse({ ok: true, name: body.name });
      }

      params = matchRoute(method, pathname, '/api/custom_tools/:name/toggle', 'POST');
      if (params) {
        const body = await req.json() as { enabled?: boolean };
        const enabled = body.enabled ?? true;
        if (!store.setCustomToolEnabled(params.name, enabled)) return jsonResponse({ error: 'not found' }, 404);
        return jsonResponse({ ok: true, enabled });
      }

      params = matchRoute(method, pathname, '/api/custom_tools/:name', 'DELETE');
      if (params) {
        if (!store.deleteCustomTool(params.name)) return jsonResponse({ error: 'not found' }, 404);
        return jsonResponse({ ok: true, deleted: params.name });
      }

      // ---- Soul (System Prompt) ----
      if (method === 'GET' && pathname === '/api/soul') {
        return jsonResponse({ content: (config as any).systemPrompt || '' });
      }

      if (method === 'PUT' && pathname === '/api/soul') {
        const body = await req.json() as Record<string, unknown>;
        (config as any).systemPrompt = String(body.content || '');
        return jsonResponse({ ok: true });
      }

      // ---- Credentials (Stub) ----
      if (method === 'GET' && pathname === '/api/credentials') {
        return jsonResponse({ credentials: [] });
      }
      if (method === 'POST' && pathname === '/api/credentials') {
        return jsonResponse({ ok: true });
      }
      params = matchRoute(method, pathname, '/api/credentials/:name', 'DELETE');
      if (params) {
        return jsonResponse({ ok: true });
      }

      // ---- Channels (Stub) ----
      if (method === 'GET' && pathname === '/api/channels') {
        return jsonResponse({ channels: {} });
      }

      // ---- Transcribe (Stub) ----
      if (method === 'POST' && pathname === '/api/transcribe') {
        return jsonResponse({ text: "" });
      }

      // ---- Blobs ----
      params = matchRoute(method, pathname, '/api/blobs/:run_id/:filename', 'GET');
      if (params) {
        const blobPath = join(eventStore.blobsDir, params.run_id, params.filename);
        if (!existsSync(blobPath)) {
          return new Response('blob not found', { status: 404 });
        }
        try {
          const file = Bun.file(blobPath);
          return new Response(file, { headers: { 'Content-Type': 'application/json' } });
        } catch (e) {
          return new Response('error reading blob', { status: 500 });
        }
      }
      
      // ---- Context Preview ----
      params = matchRoute(method, pathname, '/api/sessions/:session_id/context_preview', 'GET');
      if (params) {
        const envelope = {
          run_id: 'preview-' + Date.now(),
          session_id: params.session_id,
          timestamp: new Date().toISOString(),
          objective: '[Context Preview Dry Run]',
          constraints: [],
          requested_tools: [],
          mode: 'normal'
        };
        const packet = assembler.assemble(envelope as any);
        return jsonResponse({ 
          payload: packet.toPayload(),
          budget: packet.budgetBreakdown() 
        });
      }

      // ---- OpenTelemetry (Stub) ----
      params = matchRoute(method, pathname, '/api/runs/:run_id/otel', 'GET');
      if (params) {
        return jsonResponse({ traceId: params.run_id, spans: [] });
      }

      // ---- Attribution (Stub) ----
      params = matchRoute(method, pathname, '/api/runs/:run_id/attribution', 'GET');
      if (params) {
        return jsonResponse({ runId: params.run_id, totalItemsEvaluated: 0, attributions: [] });
      }

      // ---- Workflows ----
      if (method === 'GET' && pathname === '/api/workflows') {
        return jsonResponse({ workflows: store.listWorkflows() });
      }

      if (method === 'POST' && pathname === '/api/workflows') {
        const body = await req.json() as Record<string, unknown>;
        const rawSlug = String(body.slug || body.title || body.prompt_template || '').slice(0, 30);
        const slug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow';
        store.upsertWorkflow({ ...body, slug });
        return jsonResponse({ ok: true, slug });
      }

      params = matchRoute(method, pathname, '/api/workflows/:slug', 'DELETE');
      if (params) {
        if (!store.deleteWorkflow(params.slug)) return jsonResponse({ error: 'not found' }, 404);
        return jsonResponse({ ok: true, deleted: params.slug });
      }

      params = matchRoute(method, pathname, '/api/workflows/:slug/execute', 'POST');
      if (params) {
        const wf = store.getWorkflow(params.slug);
        if (!wf) return jsonResponse({ error: 'workflow not found' }, 404);

        const body = await req.json() as Record<string, unknown>;
        const args = (body.args || {}) as Record<string, string>;
        const sessionId = store.ensureSession(null, `Workflow: ${wf.title}`);
        
        let nodesToRun = [{ prompt: wf.prompt_template }];
        if (wf.ast) {
          try {
            const ast = typeof wf.ast === 'string' ? JSON.parse(wf.ast) : wf.ast;
            const promptNodes = (ast.nodes || []).filter((n: any) => n.type === 'promptNode');
            if (promptNodes.length > 0) {
              nodesToRun = promptNodes.map((n: any) => ({ prompt: n.data.prompt }));
            }
          } catch(e) {}
        }

        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            
            for (let i = 0; i < nodesToRun.length; i++) {
              let message = String(nodesToRun[i].prompt);
              for (const [k, v] of Object.entries(args)) {
                message = message.replaceAll(`[${k}]`, v).replaceAll(`{${k}}`, v);
              }

              const envelope = {
                run_id: crypto.randomUUID(),
                session_id: sessionId,
                message,
                files: [],
                images: [],
                provider: wf.provider ? String(wf.provider) : undefined,
                model: wf.model ? String(wf.model) : undefined,
                auto: true,
                level: 'normal',
              };

              const level = parseInspectionLevel(envelope.level, config.inspectionLevel);
              const queue = eventStore.subscribe(envelope.run_id);
              const ac = new AbortController();
              running.set(envelope.run_id, ac);

              if (i === 0) {
                controller.enqueue(encoder.encode(sse({
                  kind: 'meta', run_id: envelope.run_id, session_id: sessionId,
                  level: ['off', 'summary', 'normal', 'debug', 'raw'][level],
                  provider: envelope.provider || config.provider,
                })));
              }

              const runPromise = kernel.run(envelope).finally(() => {
                running.delete(envelope.run_id);
              });

              let done = false;
              runPromise.then(() => { done = true; }).catch(() => { done = true; });

              while (!done) {
                const result = await Promise.race([
                  queue.pop(),
                  new Promise<null>((r) => setTimeout(() => r(null), 500)),
                ]);
                if (result) {
                  const r = eventStore.renderEvent(result, level);
                  if (r) controller.enqueue(encoder.encode(sse({ kind: 'event', event: r })));
                }
              }
              while (!queue.isEmpty()) {
                const e = queue.popSync();
                if (e) {
                  const r = eventStore.renderEvent(e, level);
                  if (r) controller.enqueue(encoder.encode(sse({ kind: 'event', event: r })));
                }
              }
              eventStore.unsubscribeQueue(envelope.run_id, queue);
            }
            
            store.bumpWorkflowRuns(params!.slug);
            controller.enqueue(encoder.encode('data: [DONE]\\n\\n'));
            controller.close();
          }
        });


        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      }

      // ---- Tasks ----
      if (method === 'GET' && pathname === '/api/tasks') {
        const sessionId = url.searchParams.get('session_id');
        if (!sessionId) return jsonResponse({ error: 'session_id required' }, 400);
        const runId = url.searchParams.get('run_id') || undefined;
        return jsonResponse({ tasks: store.openTasks(sessionId, runId) });
      }

      if (method === 'POST' && pathname === '/api/tasks') {
        const body = await req.json() as Record<string, unknown>;
        if (!body.session_id || !body.text) return jsonResponse({ error: 'session_id and text required' }, 400);
        const id = store.addTask(String(body.session_id), body.run_id ? String(body.run_id) : null, String(body.text));
        return jsonResponse({ ok: true, id });
      }

      params = matchRoute(method, pathname, '/api/tasks/:id/complete', 'POST');
      if (params) {
        const body = await req.json() as { session_id: string };
        if (!body.session_id) return jsonResponse({ error: 'session_id required' }, 400);
        if (!store.completeTask(body.session_id, params.id)) return jsonResponse({ error: 'not found' }, 404);
        return jsonResponse({ ok: true, completed: params.id });
      }

      // ---- Wiki ----
      if (method === 'GET' && pathname === '/api/wiki') {
        return jsonResponse({ entries: store.listWikiEntries() });
      }

      if (method === 'POST' && pathname === '/api/wiki') {
        const body = await req.json() as { title: string; content: string; tags?: string[] };
        if (!body.title || !body.content) return jsonResponse({ error: 'title and content required' }, 400);
        const id = store.addWikiEntry(body.title, body.content, body.tags);
        return jsonResponse({ ok: true, id });
      }

      params = matchRoute(method, pathname, '/api/wiki/:id', 'PUT');
      if (params) {
        const body = await req.json() as { title: string; content: string; tags?: string[] };
        if (!body.title || !body.content) return jsonResponse({ error: 'title and content required' }, 400);
        if (!store.updateWikiEntry(params.id, body.title, body.content, body.tags)) return jsonResponse({ error: 'not found' }, 404);
        return jsonResponse({ ok: true, updated: params.id });
      }

      params = matchRoute(method, pathname, '/api/wiki/:id', 'DELETE');
      if (params) {
        if (!store.deleteWikiEntry(params.id)) return jsonResponse({ error: 'not found' }, 404);
        return jsonResponse({ ok: true, deleted: params.id });
      }

      // ---- Scores ----
      if (method === 'GET' && pathname === '/api/scorecard') {
        const runs = store.listRuns(500);
        let success = 0;
        let failCauses: Record<string, number> = {};
        for (const r of runs) {
          if (r.status === 'complete') success++;
          if (r.status === 'error') failCauses['unknown'] = (failCauses['unknown'] || 0) + 1;
        }
        return jsonResponse({
          runs: runs.length,
          success_rate: runs.length ? success / runs.length : 0,
          avg_duration_ms: 0,
          tokens: { avg_per_run: 0 },
          failure_causes: failCauses,
          recovery: { rate: 0, recovered_runs: 0, errored_runs: 0 },
          custom_metrics: store.scoreSummary()
        });
      }

      params = matchRoute(method, pathname, '/api/runs/:run_id/scores', 'GET');
      if (params) {
        return jsonResponse({ scores: store.runScores(params.run_id) });
      }

      params = matchRoute(method, pathname, '/api/runs/:run_id/scores', 'POST');
      if (params) {
        const body = await req.json() as Record<string, unknown>;
        const id = store.addScore(
          params.run_id,
          String(body.name || 'quality'),
          body.value,
          String(body.label || ''),
          String(body.source || 'human'),
          String(body.comment || '')
        );
        return jsonResponse({ ok: true, id });
      }

      // ---- Config / Settings ----
      params = matchRoute(method, pathname, '/api/models/:provider_name', 'GET');
      if (params) {
        const providers: Record<string, any> = {
          gemini: { available: !!config.geminiApiKey, model: Bun.env.SHOVS_V2_GEMINI_MODEL || 'gemini-2.5-flash' },
          openai: { available: !!config.openaiApiKey, model: Bun.env.SHOVS_V2_OPENAI_MODEL || 'gpt-4o-mini' },
          claude: { available: !!config.anthropicApiKey, model: Bun.env.SHOVS_V2_ANTHROPIC_MODEL || 'claude-3-7-sonnet-20250219' },
          openrouter: { available: !!config.openrouterApiKey, model: Bun.env.SHOVS_V2_OPENROUTER_MODEL || 'openai/gpt-4o-mini' },
          groq: { available: !!config.groqApiKey, model: Bun.env.SHOVS_V2_GROQ_MODEL || 'llama-3.3-70b-versatile' },
          ollama: { available: !!config.ollamaBaseUrl, model: Bun.env.OLLAMA_MODEL || 'llama3.1' },
          lmstudio: { available: !!config.lmstudioBaseUrl, model: Bun.env.LMSTUDIO_MODEL || 'local-model' },
        };

        const provider = providers[params.provider_name];
        if (!provider) return jsonResponse({ provider: params.provider_name, models: [], error: 'provider not found' }, 404);
        if (!provider.available) return jsonResponse({ provider: params.provider_name, models: [], error: 'provider not configured' });

        const dynamicModels = await listModels(params.provider_name, config);
        return jsonResponse({
          provider: params.provider_name,
          default: provider.model,
          models: dynamicModels,
        });
      }

      if (method === 'GET' && pathname === '/api/config') {
        // Expose full runtime state including all providers and their availability
        const providers: Record<string, any> = {
          gemini: {
            available: !!config.geminiApiKey,
            model: Bun.env.SHOVS_V2_GEMINI_MODEL || 'gemini-2.5-flash',
            models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.0-flash-exp', 'gemini-2.0-pro-exp-02-05', 'gemini-1.5-pro', 'gemini-1.5-flash'],
          },
          openai: {
            available: !!config.openaiApiKey,
            model: Bun.env.SHOVS_V2_OPENAI_MODEL || 'gpt-4o-mini',
            models: ['o3-mini', 'o1-mini', 'o1-preview', 'gpt-4.5-preview', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
          },
          claude: {
            available: !!config.anthropicApiKey,
            model: Bun.env.SHOVS_V2_ANTHROPIC_MODEL || 'claude-3-7-sonnet-20250219',
            models: ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
          },
          openrouter: {
            available: !!Bun.env.OPENROUTER_API_KEY,
            model: Bun.env.SHOVS_V2_OPENROUTER_MODEL || 'openai/gpt-4o-mini',
            models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.5-flash', 'deepseek/deepseek-r1'],
          },
          groq: {
            available: !!Bun.env.GROQ_API_KEY,
            model: Bun.env.SHOVS_V2_GROQ_MODEL || 'llama-3.3-70b-versatile',
            models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'deepseek-r1-distill-llama-70b'],
          },
          ollama: {
            available: !!Bun.env.OLLAMA_BASE_URL,
            model: Bun.env.OLLAMA_MODEL || 'llama3.1',
            models: ['llama3.1', 'qwen2.5', 'mistral', 'codestral', 'deepseek-r1'],
          },
          lmstudio: {
            available: !!Bun.env.LMSTUDIO_BASE_URL,
            model: Bun.env.LMSTUDIO_MODEL || 'local-model',
            models: [],
          },
          xai: {
            available: !!Bun.env.XAI_API_KEY,
            model: Bun.env.XAI_MODEL || 'grok-2-latest',
            models: ['grok-2-latest', 'grok-2-vision-latest', 'grok-beta'],
          },
          deepseek: {
            available: !!Bun.env.DEEPSEEK_API_KEY,
            model: Bun.env.DEEPSEEK_MODEL || 'deepseek-chat',
            models: ['deepseek-chat', 'deepseek-reasoner'],
          },
          mistral: {
            available: !!Bun.env.MISTRAL_API_KEY,
            model: Bun.env.MISTRAL_MODEL || 'mistral-large-latest',
            models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest'],
          },
          together: {
            available: !!Bun.env.TOGETHER_API_KEY,
            model: Bun.env.TOGETHER_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
            models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
          },
          cohere: {
            available: !!Bun.env.COHERE_API_KEY,
            model: Bun.env.COHERE_MODEL || 'command-r-plus',
            models: ['command-r-plus', 'command-r'],
          },
          perplexity: {
            available: !!Bun.env.PERPLEXITY_API_KEY,
            model: Bun.env.PERPLEXITY_MODEL || 'sonar-reasoning',
            models: ['sonar-reasoning', 'sonar-pro', 'sonar'],
          },
        };

        const providers_available: Record<string, boolean> = {};
        const models: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(providers)) {
          providers_available[k] = v.available;
          models[k] = v.models;
        }

        return jsonResponse({
          provider: config.provider,
          providers_available,
          models,
          levels: ['off', 'summary', 'normal', 'debug', 'raw'],
          gate_mode: config.gateMode,
          inspection_level: ['off', 'summary', 'normal', 'debug', 'raw'][config.inspectionLevel],
          loop_mode: config.loopMode,
          sub_agent: { provider: config.subAgentProvider, model: config.subAgentModel },
          search: { available: ['duckduckgo', 'tavily'], selected: 'duckduckgo' },
          fallback_chain: config.fallbackChain,
          passes: {
            plan: config.planPass,
            verify: config.verifyPass,
            memory_extraction: config.memoryExtraction,
          },
          max_steps: config.maxSteps,
          max_continuations: config.maxContinuations,
          max_auto_steps: config.maxAutoSteps,
          max_consecutive_tool_fails: config.maxConsecutiveToolFails,
          max_context_chars: config.maxContextChars,
          max_transcript_chars: config.maxTranscriptChars,
          gate_timeout_s: config.gateTimeoutS,
          economy_cooldown_s: config.economyCooldownS,
          stagnation_overlap_threshold: config.stagnationOverlapThreshold,
          stagnation_max_strikes: config.stagnationMaxStrikes,
          // System prompt (stored in memory or default)
          agent_name: (config as any).agentName || '',
          system_prompt: (config as any).systemPrompt || '',
          // Tools
          tools: registry.list(),
        });
      }

      if (method === 'POST' && pathname === '/api/settings') {
        const body = await req.json() as Record<string, unknown>;
        const mutable = config as any;

        // Basic
        if (body.provider && typeof body.provider === 'string') mutable.provider = body.provider;
        if (body.loop_mode && ['adaptive', 'driven', 'scaffolded'].includes(String(body.loop_mode))) mutable.loopMode = body.loop_mode;
        if (body.gate_mode && ['auto', 'inspect'].includes(String(body.gate_mode))) mutable.gateMode = body.gate_mode;
        if (body.inspection_level && typeof body.inspection_level === 'string') {
          mutable.inspectionLevel = parseInspectionLevel(body.inspection_level);
        }

        // Passes
        if (typeof body.plan_pass === 'boolean') mutable.planPass = body.plan_pass;
        if (typeof body.verify_pass === 'boolean') mutable.verifyPass = body.verify_pass;
        if (typeof body.memory_extraction === 'boolean') mutable.memoryExtraction = body.memory_extraction;

        // Advanced
        if (typeof body.max_steps === 'number') mutable.maxSteps = Math.max(1, Math.min(50, body.max_steps));
        if (typeof body.max_continuations === 'number') mutable.maxContinuations = Math.max(0, Math.min(10, body.max_continuations));
        if (typeof body.max_auto_steps === 'number') mutable.maxAutoSteps = Math.max(0, Math.min(20, body.max_auto_steps));
        if (typeof body.max_consecutive_tool_fails === 'number') mutable.maxConsecutiveToolFails = Math.max(1, Math.min(10, body.max_consecutive_tool_fails));
        if (typeof body.gate_timeout_s === 'number') mutable.gateTimeoutS = Math.max(10, body.gate_timeout_s);
        if (typeof body.economy_cooldown_s === 'number') mutable.economyCooldownS = Math.max(0, body.economy_cooldown_s);

        // Power
        if (typeof body.stagnation_overlap_threshold === 'number') mutable.stagnationOverlapThreshold = body.stagnation_overlap_threshold;
        if (typeof body.stagnation_max_strikes === 'number') mutable.stagnationMaxStrikes = Math.max(1, body.stagnation_max_strikes);
        if (typeof body.sub_agent_provider === 'string') mutable.subAgentProvider = body.sub_agent_provider;
        if (typeof body.sub_agent_model === 'string') mutable.subAgentModel = body.sub_agent_model;
        if (Array.isArray(body.fallback_chain)) mutable.fallbackChain = body.fallback_chain.map(String);
        if (typeof body.system_prompt === 'string') mutable.systemPrompt = body.system_prompt;
        if (typeof body.agent_name === 'string') mutable.agentName = body.agent_name;

        return jsonResponse({ ok: true, provider: config.provider, loop_mode: config.loopMode });
      }

      // ---- Health ----
      if (method === 'GET' && pathname === '/api/health') {
        return jsonResponse({ ok: true, version: '1.0.0', runtime: 'bun' });
      }

      // ---- CORS preflight ----
      if (method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          },
        });
      }

      // ---- Static UI ----
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const file = Bun.file(join(UI_DIR, 'index.html'));
        if (await file.exists()) {
          return new Response(file, { headers: { 'Content-Type': 'text/html' } });
        }
        return new Response('UI not found. Place index.html in the ui/ directory.', { status: 404 });
      }

      // Serve static files from ui/ (with automatic on-the-fly TSX transpilation)
      if (method === 'GET' && !pathname.startsWith('/api/')) {
        const filePath = join(UI_DIR, pathname);
        const file = Bun.file(filePath);
        if (await file.exists()) {
          if (pathname.endsWith('.tsx') || pathname.endsWith('.ts')) {
            const code = await file.text();
            const transpiler = new Bun.Transpiler({ loader: 'tsx' });
            const js = transpiler.transformSync(code);
            return new Response(js, { headers: { 'Content-Type': 'application/javascript' } });
          }
          return new Response(file);
        }
      }

      return jsonResponse({ error: 'not found' }, 404);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] ${method} ${pathname}: ${msg}`);
      return jsonResponse({ error: msg }, 500);
    }
  },

  error(err) {
    console.error('[SERVER ERROR]', err);
    return new Response(`Internal Server Error: ${err.message}`, { status: 500 });
  },
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

console.log(`
╔══════════════════════════════════════════════════╗
║          Bun Harness Runtime v1.0.0              ║
║──────────────────────────────────────────────────║
║  Server:    http://localhost:${String(server.port).padEnd(5)}              ║
║  Provider:  ${config.provider.padEnd(37)}║
║  Data dir:  ${config.dataDir.padEnd(37)}║
║  Runtime:   Bun ${Bun.version.padEnd(33)}║
╚══════════════════════════════════════════════════╝
`);
