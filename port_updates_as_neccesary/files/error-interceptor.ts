/**
 * core/error-interceptor.ts — Catastrophic Error Interceptor & HTML/JSON Recovery.
 *
 * CHANGED: the previous version kept exactly one module-level
 * `lastCapturedError` slot shared by the whole process. In a server
 * handling multiple sessions/runs concurrently, two unhandled errors
 * arriving close together would silently overwrite each other, and
 * `consumeLastCapturedError()` had no way to know which run an error
 * actually belonged to.
 *
 * Now uses AsyncLocalStorage to tag each captured error with the run_id
 * active in that async context, and keeps a small per-run map (with the
 * same TTL eviction as before) instead of one global variable. Callers
 * that don't wrap their work in `withRunContext` still work exactly as
 * before, falling into a shared '__global__' bucket — this is additive,
 * not a breaking change.
 */

import { AsyncLocalStorage } from 'async_hooks';

const TTL_MS = 5_000;
const GLOBAL_BUCKET = '__global__';

const runContext = new AsyncLocalStorage<{ runId: string }>();
const capturedByRun = new Map<string, { error: unknown; at: number }>();

/** Wrap a run's work so any error captured during it is tagged with `runId`. */
export function withRunContext<T>(runId: string, fn: () => T): T {
  return runContext.run({ runId }, fn);
}

function currentRunId(): string {
  return runContext.getStore()?.runId ?? GLOBAL_BUCKET;
}

function record(error: unknown) {
  capturedByRun.set(currentRunId(), { error, at: Date.now() });
}

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('error', (event) => record((event as any).error ?? event));
  globalThis.addEventListener('unhandledrejection', (event) =>
    record((event as any).reason),
  );
}

/** Consume (destructive read) the last captured error for a given run, or the shared bucket if omitted. */
export function consumeLastCapturedError(runId?: string): unknown {
  const key = runId ?? GLOBAL_BUCKET;
  const entry = capturedByRun.get(key);
  if (!entry) return undefined;
  capturedByRun.delete(key);
  if (Date.now() - entry.at > TTL_MS) return undefined;
  return entry.error;
}

export function renderErrorPage(errorMsg = 'Internal Server Error'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Hyper-Runtime Error Fallback</title>
  <style>
    body { background: #0a0a0c; color: #f3f4f6; font-family: monospace; padding: 2rem; }
    .card { border: 1px solid #ef4444; border-radius: 8px; padding: 1.5rem; background: #18181b; }
    h1 { color: #ef4444; margin-top: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Runtime Execution Error</h1>
    <p>${errorMsg}</p>
    <small>The Hyper-Runtime error boundary intercepted an unhandled exception cleanly.</small>
  </div>
</body>
</html>`;
}
