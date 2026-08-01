import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backendDir = process.env.SHOVS_BACKEND_DIR
  ? path.resolve(process.env.SHOVS_BACKEND_DIR)
  : path.resolve(frontendDir, '..', '..', 'Kitchen---Transparent-Language-Runtime')
const apiTarget = process.env.VITE_API_TARGET || 'http://127.0.0.1:8791'
const healthUrl = new URL('/api/config', apiTarget).href

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

async function backendReady() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(650) })
    return response.ok
  } catch {
    return false
  }
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
  if (await backendReady()) {
    console.log(`✓ runtime already available at ${apiTarget}`)
    return
  }

  const candidates = [
    path.join(backendDir, 'venv', 'bin', 'python'),
    path.join(backendDir, '.venv', 'bin', 'python'),
  ]
  const python = (await Promise.all(candidates.map(async file => (await exists(file, constants.X_OK)) ? file : null))).find(Boolean)
  const entrypoint = path.join(backendDir, 'start_server.py')

  if (!python || !(await exists(entrypoint))) {
    console.warn(`⚠ backend not found at ${backendDir}`)
    console.warn('  Set SHOVS_BACKEND_DIR, or run the frontend alone with: npm run dev:frontend')
    return
  }

  console.log(`→ starting transparent runtime at ${apiTarget}`)
  backend = spawn(python, [entrypoint], {
    cwd: backendDir,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: 'inherit',
  })
  backend.on('exit', code => {
    if (!stopping && code !== 0) console.error(`runtime exited with code ${code}`)
  })

  if (!(await waitForBackend())) {
    console.warn(`⚠ runtime did not become ready at ${healthUrl}; Vite will still start in demo fallback mode`)
  } else {
    console.log('✓ runtime ready')
  }
}

async function shutdown() {
  if (stopping) return
  stopping = true
  await vite?.close()
  if (backend && !backend.killed) backend.kill('SIGTERM')
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

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
