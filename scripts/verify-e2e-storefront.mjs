// End-to-end check of the README quick start against examples/storefront.
//
// 1. Copies examples/storefront into a temp dir (the repo copy is never touched).
// 2. Runs install-local and discover-local on the copy.
// 3. Serves the copy over HTTP and starts the generated launcher with the
//    deterministic runtime (no API key needed) and real Chromium.
// 4. Runs `place_order` and expects status=complete, verdict=contract_compliant.
// 5. Serves a broken copy on another port and runs `place_order` with
//    execution_context.targetBaseUrl pointing at it, while PLAYWRIGHT_BASE_URL still
//    points at the healthy app. Expects contract_violated: the run must test its own
//    target, not the environment default.
// 6. Breaks the app (success feedback removed) and expects the same scenario to
//    fail with verdict=contract_violated. This guards against false positives.
//
// Usage: npm run test:e2e   (KEEP_E2E_DIR=1 keeps the temp dir for debugging)

import process from 'node:process'
import { createLogger, describeSession, startStorefrontRuntime } from './lib/storefront-runtime.mjs'

const log = createLogger('e2e-storefront')
let runtime
let exitCode = 0

try {
  runtime = await startStorefrontRuntime({ log, keepDir: process.env.KEEP_E2E_DIR === '1' })

  const scenarioIds = await runtime.listScenarioIds()
  for (const expected of ['browse_products', 'place_order']) {
    if (!scenarioIds.includes(expected)) throw new Error(`scenario ${expected} not discovered (got ${scenarioIds.join(', ')})`)
  }
  log(`discovered scenarios: ${scenarioIds.join(', ')}`)

  const healthy = await runtime.waitForSession(await runtime.startScenario('place_order'))
  log(`healthy app: ${describeSession(healthy)}`)
  if (healthy.status !== 'complete' || healthy.contractEvaluation?.verdict !== 'contract_compliant') {
    throw new Error(`expected complete/contract_compliant on the healthy app, got ${describeSession(healthy)}`)
  }

  // Local API token: the API refuses requests without it, and the dashboard reaches the API through
  // its Vite proxy, which adds the token server-side (HTTP and WebSocket).
  const direct = await runtime.api('/api/p2/scenarios', undefined, { authenticated: false })
  if (direct.status !== 401) throw new Error(`expected 401 from the API without the token, got ${direct.status}`)
  const proxied = await runtime.viaDashboard('/api/p2/scenarios')
  if (proxied.status !== 200) throw new Error(`expected 200 through the dashboard proxy, got ${proxied.status}`)
  const sessionWsPath = `/ws/p2/sessions/${healthy.id ?? healthy.sessionId}`
  const wsDirect = await runtime.websocketOpens(`${runtime.apiUrl.replace(/^http/, 'ws')}${sessionWsPath}`)
  const wsProxied = await runtime.websocketOpens(`${runtime.webUrl.replace(/^http/, 'ws')}${sessionWsPath}`)
  if (wsDirect || !wsProxied) {
    throw new Error(`expected the WebSocket to open only through the dashboard proxy (direct=${wsDirect}, proxied=${wsProxied})`)
  }
  log('API token: direct request 401, dashboard proxy 200, WebSocket opens only through the proxy')

  // B-02: the launcher's PLAYWRIGHT_BASE_URL still points at the healthy app. A run aimed at a broken
  // copy through execution_context.targetBaseUrl (the dashboard's "target base URL") must test that
  // copy and fail. If the tools fell back to the environment, this would come back compliant.
  const brokenTargetUrl = await runtime.serveBrokenCopy()
  const targeted = await runtime.waitForSession(await runtime.startScenario('place_order', { targetBaseUrl: brokenTargetUrl }))
  log(`run aimed at a broken copy while the environment points at the healthy app: ${describeSession(targeted)}`)
  if (targeted.contractEvaluation?.verdict !== 'contract_violated') {
    throw new Error(`expected contract_violated when the run targets the broken copy, got ${describeSession(targeted)}`)
  }

  runtime.breakApp()
  const regressed = await runtime.waitForSession(await runtime.startScenario('place_order'))
  log(`broken app: ${describeSession(regressed)}`)
  if (regressed.contractEvaluation?.verdict !== 'contract_violated') {
    throw new Error(`expected contract_violated on the broken app, got ${describeSession(regressed)}`)
  }

  log('PASS')
} catch (error) {
  exitCode = 1
  console.error(`[e2e-storefront] FAIL: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await runtime?.stop()
}
process.exit(exitCode)
