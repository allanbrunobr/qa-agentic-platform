// Shared helpers: run the README quick start against a temp copy of
// examples/storefront and start the generated runtime (deterministic provider,
// real Chromium). Used by verify-e2e-storefront.mjs and capture-demo.mjs.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const exampleDir = path.join(repoRoot, 'examples/storefront')
const tsxLoader = path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs')
const LAUNCH_TIMEOUT_MS = Number(process.env.E2E_LAUNCH_TIMEOUT_MS ?? 15 * 60_000)
const RUN_TIMEOUT_MS = Number(process.env.E2E_RUN_TIMEOUT_MS ?? 5 * 60_000)

export function createLogger(tag) {
  return (message) => console.log(`[${tag}] ${message}`)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function serveStatic(rootDir, port) {
  const server = http.createServer((request, response) => {
    const urlPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    const filePath = path.join(rootDir, urlPath === '/' ? 'index.html' : urlPath)
    if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404).end('not found')
      return
    }
    const type = filePath.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    fs.createReadStream(filePath).pipe(response)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/**
 * Copies the storefront example to a temp dir, runs install-local and
 * discover-local, serves the app, and starts the generated launcher.
 * Returns URLs plus helpers; always call `stop()` in a finally block.
 */
export async function startStorefrontRuntime({ log, keepDir = false }) {
  if (!fs.existsSync(tsxLoader)) throw new Error('tsx is missing. Run `npm install` at the repository root first.')

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-storefront-'))
  const targetDir = path.join(workDir, 'storefront')
  const cleanups = []
  let launcherLog = ''

  const stop = async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch {
        // best effort
      }
    }
    if (keepDir) log(`kept ${workDir}`)
    else fs.rmSync(workDir, { recursive: true, force: true })
  }

  async function waitFor(description, timeoutMs, probe) {
    const deadline = Date.now() + timeoutMs
    let lastLog = 0
    while (Date.now() < deadline) {
      try {
        const value = await probe()
        if (value) return value
      } catch (error) {
        if (error?.fatal) throw error
      }
      if (Date.now() - lastLog > 30_000) {
        log(`waiting for ${description}...`)
        lastLog = Date.now()
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(`timed out waiting for ${description}\n--- launcher output (tail) ---\n${launcherLog.slice(-4000)}`)
  }

  function runCli(command) {
    log(`${command} ${targetDir}`)
    const result = spawnSync(process.execPath, ['--import', tsxLoader, 'packages/dashboard-api/src/cli.ts', command, targetDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
    })
    if (result.status !== 0) {
      throw new Error(`${command} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
    }
  }

  try {
    fs.cpSync(exampleDir, targetDir, {
      recursive: true,
      filter: (source) => !/[\\/](\.agentic-qa|node_modules|dist)([\\/]|$)/.test(path.relative(exampleDir, source)),
    })
    log(`working copy: ${targetDir}`)
    runCli('install-local')
    runCli('discover-local')

    const [appPort, apiPort, webPort] = [await freePort(), await freePort(), await freePort()]
    const appServer = await serveStatic(targetDir, appPort)
    cleanups.push(() => new Promise((resolve) => appServer.close(() => resolve())))
    const appUrl = `http://127.0.0.1:${appPort}`
    const apiUrl = `http://127.0.0.1:${apiPort}`
    const webUrl = `http://127.0.0.1:${webPort}`
    log(`app ${appUrl}, api ${apiUrl}, web ${webUrl}`)

    const launcher = spawn('bash', ['./scripts/start-local-dashboard.generated.sh', '--api-port', String(apiPort), '--web-port', String(webPort)], {
      cwd: path.join(targetDir, '.agentic-qa'),
      detached: true,
      env: {
        ...process.env,
        AGENTIC_QA_FORCE_DETERMINISTIC_RUNTIME: '1',
        PLAYWRIGHT_BASE_URL: appUrl,
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
      },
    })
    const capture = (chunk) => {
      launcherLog += chunk.toString()
      if (launcherLog.length > 200_000) launcherLog = launcherLog.slice(-100_000)
    }
    launcher.stdout.on('data', capture)
    launcher.stderr.on('data', capture)
    cleanups.push(async () => {
      try {
        process.kill(-launcher.pid, 'SIGTERM')
      } catch {
        // already gone
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    })

    await waitFor('runtime API', LAUNCH_TIMEOUT_MS, async () => {
      if (launcher.exitCode !== null) {
        const error = new Error(`launcher exited early (code ${launcher.exitCode})\n${launcherLog.slice(-4000)}`)
        error.fatal = true
        throw error
      }
      return (await fetch(`${apiUrl}/health`)).ok
    })
    await waitFor('dashboard web', 120_000, async () => (await fetch(`${webUrl}/`)).ok)
    log('runtime API and dashboard are up')

    // The runtime API requires the local token (created by the launcher in .agentic-qa/data/).
    const tokenPath = path.join(targetDir, '.agentic-qa', 'data', 'runtime-api.token')
    const token = fs.readFileSync(tokenPath, 'utf8').trim()

    async function api(route, init, { authenticated = true } = {}) {
      const response = await fetch(`${apiUrl}${route}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(authenticated ? { 'x-agentic-token': token } : {}),
          ...(init?.headers ?? {}),
        },
      })
      const body = await response.json().catch(() => null)
      return { status: response.status, body }
    }

    /** Calls the API the way the dashboard does: same origin, through the Vite proxy, no token. */
    async function viaDashboard(route) {
      const response = await fetch(`${webUrl}${route}`)
      const body = await response.json().catch(() => null)
      return { status: response.status, body }
    }

    /** Opens a WebSocket and reports whether the upgrade succeeded. */
    function websocketOpens(url) {
      return new Promise((resolve) => {
        const socket = new WebSocket(url)
        const timer = setTimeout(() => { socket.close(); resolve(false) }, 10_000)
        socket.addEventListener('open', () => { clearTimeout(timer); socket.close(); resolve(true) })
        socket.addEventListener('error', () => { clearTimeout(timer); resolve(false) })
      })
    }

    async function startScenario(scenarioId, executionContext) {
      const body = executionContext
        ? { scenario_id: scenarioId, execution_context: executionContext }
        : { scenario_id: scenarioId }
      const started = await api('/api/p2/runs', { method: 'POST', body: JSON.stringify(body) })
      if (started.status !== 202 || !started.body?.session_id) {
        throw new Error(`POST /api/p2/runs returned ${started.status}: ${JSON.stringify(started.body)}`)
      }
      return started.body.session_id
    }

    async function waitForSession(sessionId) {
      return waitFor(`session ${sessionId}`, RUN_TIMEOUT_MS, async () => {
        const { status, body } = await api(`/api/p2/sessions/${sessionId}`)
        if (status !== 200) return null
        return body.status === 'complete' || body.status === 'failed' ? body : null
      })
    }

    async function listScenarioIds() {
      const { body } = await api('/api/p2/scenarios')
      return (Array.isArray(body) ? body : body?.scenarios ?? []).map((scenario) => scenario.id)
    }

    /** Removes the success feedback from the app so place_order must fail. */
    function breakApp() {
      breakIndexHtml(targetDir)
    }

    /**
     * Serves a second, broken copy of the app on its own port and returns its URL. The launcher's
     * PLAYWRIGHT_BASE_URL keeps pointing at the healthy app, so a run aimed at this URL only fails
     * if the runtime really tests the run's target.
     */
    async function serveBrokenCopy() {
      const brokenDir = path.join(workDir, 'storefront-broken')
      fs.cpSync(targetDir, brokenDir, {
        recursive: true,
        filter: (source) => !/[\\/](\.agentic-qa|node_modules|dist)([\\/]|$)/.test(path.relative(targetDir, source)),
      })
      breakIndexHtml(brokenDir)
      const brokenPort = await freePort()
      const brokenServer = await serveStatic(brokenDir, brokenPort)
      cleanups.push(() => new Promise((resolve) => brokenServer.close(() => resolve())))
      return `http://127.0.0.1:${brokenPort}`
    }

    return { appUrl, apiUrl, webUrl, targetDir, tokenPath, api, viaDashboard, websocketOpens, startScenario, waitForSession, listScenarioIds, breakApp, serveBrokenCopy, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

function breakIndexHtml(dir) {
  const indexPath = path.join(dir, 'index.html')
  const original = fs.readFileSync(indexPath, 'utf8')
  const broken = original.replace("feedback.textContent = 'Order submitted successfully'", "feedback.textContent = ''")
  if (broken === original) throw new Error('could not inject the regression into index.html (success message not found)')
  fs.writeFileSync(indexPath, broken)
}

export function describeSession(session) {
  return `status=${session.status} verdict=${session.contractEvaluation?.verdict ?? 'none'}`
}
