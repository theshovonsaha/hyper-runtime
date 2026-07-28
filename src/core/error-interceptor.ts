/**
 * core/error-interceptor.ts — Catastrophic Error Interceptor & HTML/JSON Recovery.
 * Ported from deterministic-ai-kernel-main/src/lib/error-capture.ts & error-page.ts
 */

let lastCapturedError: { error: unknown; at: number } | undefined;
const TTL_MS = 5_000;

function record(error: unknown) {
  lastCapturedError = { error, at: Date.now() };
}

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('error', (event) => record((event as any).error ?? event));
  globalThis.addEventListener('unhandledrejection', (event) =>
    record((event as any).reason),
  );
}

export function consumeLastCapturedError(): unknown {
  if (!lastCapturedError) return undefined;
  if (Date.now() - lastCapturedError.at > TTL_MS) {
    lastCapturedError = undefined;
    return undefined;
  }
  const { error } = lastCapturedError;
  lastCapturedError = undefined;
  return error;
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
