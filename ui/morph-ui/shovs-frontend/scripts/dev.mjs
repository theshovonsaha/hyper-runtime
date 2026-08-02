import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer as createTcpServer } from 'node:net'
import path from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultBackendDir = path.resolve(frontendDir, '..', '..', '..')
for (const envPath of [
  path.join(defaultBackendDir, '.env'),
  path.join(defaultBackendDir, 'ui', '.env'),
  path.join(frontendDir, '.env'),
  path.join(frontendDir, '.env.local'),
]) {
  try { loadEnvFile(envPath) } catch { /* Optional environment layers. */ }
}
const backendDir = process.env.HYPER_RUNTIME_DIR
  ? path.resolve(process.env.HYPER_RUNTIME_DIR)
  : defaultBackendDir
const backendPort = process.env.HYPER_PORT || process.env.SHOVS_V2_PORT || '8791'
let apiTarget = process.env.VITE_API_TARGET || `http://127.0.0.1:${backendPort}`
const expectedServiceRevision = 'provider-registry-v2'

let backend = null
let vite = null
let stopping = false

async function exists(file, mode = constants.F_OK) {
  try {
    await access(file, mode)
    return true
  } catch {
    return false
  }
}

async function backendConfig() {
  try {
    const response = await fetch(new URL('/api/config', apiTarget), {
      signal: AbortSignal.timeout(650),
    })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

async function backendReady() {
  return (await backendConfig())?.service_revision === expectedServiceRevision
}

async function openPort(start) {
  for (let port = start; port < start + 100; port += 1) {
    const available = await new Promise(resolvePort => {
      const server = createTcpServer()
      server.once('error', () => resolvePort(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)))
    })
    if (available) return port
  }
  throw new Error(`No free runtime port found after ${start}.`)
}

async function waitForBackend(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await backendReady()) return true
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

async function startBackend() {
  const existing = await backendConfig()
  if (existing?.service_revision === expectedServiceRevision) {
    console.log(`✓ runtime already available at ${apiTarget}`)
    return
  }

  if (existing) {
    const requested = Number(new URL(apiTarget).port || 8791)
    const fallbackPort = await openPort(requested + 1)
    console.warn(`⚠ incompatible runtime already uses ${apiTarget}; starting current runtime on ${fallbackPort}`)
    apiTarget = `http://127.0.0.1:${fallbackPort}`
    process.env.VITE_API_TARGET = apiTarget
  }

  const entrypoint = path.join(backendDir, 'packages', 'cli', 'src', 'server.ts')

  if (!(await exists(entrypoint))) {
    console.warn(`⚠ backend not found at ${backendDir}`)
    console.warn('  Set HYPER_RUNTIME_DIR, or run the frontend alone with: npm run dev:frontend')
    return
  }

  console.log(`→ starting evaluated Hyper runtime at ${apiTarget}`)
  backend = spawn('bun', [entrypoint], {
    cwd: backendDir,
    env: { ...process.env, HYPER_PORT: new URL(apiTarget).port || '8791' },
    stdio: 'inherit',
  })
  backend.on('exit', code => {
    if (!stopping && code !== 0) console.error(`runtime exited with code ${code}`)
  })

  if (!(await waitForBackend())) {
    console.warn(`⚠ evaluated runtime did not become ready at ${new URL('/api/config', apiTarget)}; Vite will still start in demo fallback mode`)
  } else {
    console.log('✓ runtime ready')
  }
}

async function shutdown() {
  if (stopping) return
  stopping = true
  if (backend && !backend.killed) {
    backend.kill('SIGTERM')
    await Promise.race([
      new Promise(resolve => backend.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1_500)),
    ])
    if (backend.exitCode == null) backend.kill('SIGKILL')
  }
  await vite?.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

await startBackend()
vite = await createServer({ root: frontendDir })
await vite.listen()
vite.printUrls()
const localUrl = vite.resolvedUrls?.local?.[0]
if (localUrl) {
  try {
    const proxyCheck = await fetch(new URL('/api/config', localUrl))
    console.log(proxyCheck.ok ? '✓ /api proxy ready' : `⚠ /api proxy returned ${proxyCheck.status}`)
  } catch (error) {
    console.warn(`⚠ /api proxy check failed: ${error.message}`)
  }
}
vite.bindCLIShortcuts({ print: true })
