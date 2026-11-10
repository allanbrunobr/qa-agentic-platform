import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const REFERENCE_DOMAIN_ID_PATTERN = /^(sales_associate|fulfillment_agent|billing_clerk|store_manager)$|reference-store/
const fixtureRoot = path.join(os.tmpdir(), `agentic-platform-generic-frontend-fixture-${Date.now()}`)
const tsxLoaderCandidates = [
  path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs'),
  path.join(repoRoot, 'templates/persona-qa-dashboard/node_modules/tsx/dist/loader.mjs'),
]
const tsxLoader = tsxLoaderCandidates.find((candidate) => fs.existsSync(candidate))
const preferredNodeBin = process.env.AGENTIC_RELEASE_NODE_BIN
  ?? path.dirname(process.execPath)
const preferredNodePath = path.join(preferredNodeBin, 'node')
const nodePath = fs.existsSync(preferredNodePath) ? preferredNodePath : process.execPath
// The deterministic smoke never calls a model provider, but install-local only writes
// .agentic-qa/.env.local when a provider key resolves. Use a placeholder when none is configured.
const hasProviderKey = Boolean(
  process.env.ANTHROPIC_API_KEY_OVERRIDE
  || process.env.ANTHROPIC_API_KEY
  || process.env.ANTHROPIC_API
  || process.env.OPENAI_API_KEY
  || fs.existsSync(path.join(repoRoot, '.env.local')),
)
const verificationEnv = {
  ...process.env,
  ...(hasProviderKey ? {} : { ANTHROPIC_API_KEY: 'sk-ant-verification-placeholder' }),
  PATH: fs.existsSync(preferredNodePath)
    ? `${preferredNodeBin}${path.delimiter}${process.env.PATH ?? ''}`
    : process.env.PATH,
}
let targetPort = 0
let apiPort = 0
let webPort = 0

function log(message) {
  process.stdout.write(`[verify-generic-frontend] ${message}\n`)
}

function writeFile(relativePath, content) {
  const filePath = path.join(fixtureRoot, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, relativePath), 'utf8'))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function allocatePorts() {
  const reserved = new Set()
  targetPort = await getAvailablePort(reserved)
  reserved.add(targetPort)
  apiPort = await getAvailablePort(reserved)
  reserved.add(apiPort)
  webPort = await getAvailablePort(reserved)
}

async function getAvailablePort(reserved = new Set()) {
  while (true) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close(() => reject(new Error('failed to allocate dynamic port')))
          return
        }
        const nextPort = address.port
        server.close((error) => {
          if (error) reject(error)
          else resolve(nextPort)
        })
      })
    })

    if (!reserved.has(port)) return port
  }
}

function verifyInstalledDocs() {
  const docsDir = path.join(fixtureRoot, '.agentic-qa', 'docs')
  const readmePath = path.join(docsDir, 'README.md')
  assert(fs.existsSync(readmePath), 'generic installed docs README missing')
  const docFiles = fs.readdirSync(docsDir)
  assert(docFiles.length === 1 && docFiles[0] === 'README.md', `legacy docs copied into installed package: ${docFiles.join(', ')}`)
  const text = fs.readFileSync(readmePath, 'utf8')
  assert(!/reference-store|sales_associate|fulfillment_agent|billing_clerk|store_manager/i.test(text), 'installed docs README contains reference-domain text')
}

function createFixture() {
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
  fs.mkdirSync(fixtureRoot, { recursive: true })
  writeFile('package.json', `${JSON.stringify({
    name: 'generic-storefront-fixture',
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite --host 127.0.0.1',
      build: 'tsc -b && vite build',
    },
    dependencies: {
      '@vitejs/plugin-react': '^latest',
      vite: '^latest',
      react: '^latest',
      'react-dom': '^latest',
      typescript: '^latest',
    },
    devDependencies: {},
  }, null, 2)}\n`)
  writeFile('index.html', '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n')
  writeFile('tsconfig.json', `${JSON.stringify({
    compilerOptions: {
      jsx: 'react-jsx',
      strict: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      skipLibCheck: true,
    },
    include: ['src'],
  }, null, 2)}\n`)
  writeFile('src/main.tsx', `import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { submitOrder } from './order-service'
import './styles.css'

function App() {
  const [email, setEmail] = useState('')
  const [items, setItems] = useState(0)
  const [message, setMessage] = useState('')

  return (
    <main>
      <h1>Generic Storefront</h1>
      <label>
        Customer email
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="customer@example.com" />
      </label>
      <button onClick={() => setItems((value) => value + 1)}>Add item to cart</button>
      <p>Cart items: {items}</p>
      <button disabled={!email || items === 0} onClick={() => void submitOrder({ email, items }).then(() => setMessage('Order submitted successfully'))}>
        Submit order
      </button>
      <output>{message}</output>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
`)
  writeFile('src/order-service.ts', `export async function submitOrder(payload: { email: string; items: number }) {
  return fetch('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}
`)
  writeFile('src/server.ts', `type Request = { body?: unknown }
type Response = { status: (code: number) => Response; json: (body: unknown) => void }
type App = { post: (path: string, handler: (request: Request, response: Response) => void) => void }

export function registerOrderRoutes(app: App) {
  app.post('/api/orders', (_request, response) => {
    response.status(201).json({ ok: true })
  })
}
`)
  writeFile('src/styles.css', 'body { font-family: system-ui, sans-serif; margin: 2rem; } main { display: grid; gap: 1rem; max-width: 32rem; }\n')
}

function runCli(command) {
  assert(tsxLoader, 'tsx loader not found; install dependencies before running generic frontend verification')
  log(`START ${command}`)
  const result = spawnSync(nodePath, ['--import', tsxLoader, 'packages/dashboard-api/src/cli.ts', command, fixtureRoot], {
    cwd: repoRoot,
    env: verificationEnv,
    encoding: 'utf8',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert(result.status === 0, `${command} failed with status ${result.status}`)
  log(`PASS ${command}`)
}

function verifyGeneratedAdapter() {
  const report = readJson('.agentic-qa/adapter/config/discovery-report.generated.json')
  const domainBundle = readJson('.agentic-qa/adapter/config/domain-discovery-bundle.generated.json')
  const surfaceMap = readJson('.agentic-qa/adapter/config/frontend-surface-map.generated.json')
  const codeGraph = readJson('.agentic-qa/adapter/config/code-graph.generated.json')
  const manifest = readJson('.agentic-qa/adapter/manifest/adapter-manifest.generated.json')
  const personas = readJson('.agentic-qa/adapter/personas/personas.generated.json')
  const scenarios = readJson('.agentic-qa/adapter/scenarios/scenarios.generated.json')
  const capabilities = readJson('.agentic-qa/adapter/capabilities/capabilities.generated.json')
  const runtimePlan = readJson('.agentic-qa/adapter/runtime/runtime-plan.generated.json')
  const contractsIndex = readJson('.agentic-qa/adapter/workflow-contracts/index.generated.json')

  const personaIds = personas.map((persona) => persona.id)
  const scenarioIds = scenarios.map((scenario) => scenario.id)
  const capabilityIds = capabilities.map((capability) => capability.id)

  assert(fs.existsSync(path.join(fixtureRoot, '.agentic-qa/.env.local')), 'installer did not create .agentic-qa/.env.local')
  verifyInstalledDocs()
  assert(manifest.hostProduct === path.basename(fixtureRoot), `unexpected host product ${manifest.hostProduct}`)
  assert(report.framework === 'vite', `expected vite framework, got ${report.framework}`)
  assert(report.domainDiscovery?.domain?.domain === 'commerce', `expected commerce domain in discovery report, got ${report.domainDiscovery?.domain?.domain}`)
  assert(domainBundle.domain.domain === 'commerce', `expected commerce domain bundle, got ${domainBundle.domain.domain}`)
  assert(domainBundle.personas.some((persona) => persona.id === 'shopper'), 'shopper domain persona candidate missing')
  assert(domainBundle.scenarios.every((scenario) => scenario.status === 'needs_human_mapping'), 'domain scenarios must remain mapping gated')
  assert(surfaceMap.targetId === 'generic_storefront_fixture', `unexpected surface map target ${surfaceMap.targetId}`)
  assert(codeGraph.schemaVersion === 'code-graph/v1', `unexpected code graph schema ${codeGraph.schemaVersion}`)
  assert(codeGraph.repositoryKind === 'frontend', `unexpected code graph repository kind ${codeGraph.repositoryKind}`)
  assert(codeGraph.nodes.some((node) => node.type === 'repository'), 'code graph repository node missing')
  assert(codeGraph.nodes.some((node) => node.type === 'button' && /submit order/i.test(node.label)), 'code graph submit button evidence missing')
  assert(codeGraph.nodes.some((node) => node.type === 'persona_candidate'), 'code graph persona candidate missing')
  assert(codeGraph.nodes.some((node) => node.type === 'scenario_candidate'), 'code graph scenario candidate missing')
  assert(codeGraph.nodes.some((node) => node.type === 'capability_candidate'), 'code graph capability candidate missing')
  assert(codeGraph.nodes.some((node) => node.type === 'source_file' && node.label === 'src/server.ts'), 'code graph source file evidence missing')
  assert(codeGraph.nodes.some((node) => node.type === 'source_file' && node.label === 'src/order-service.ts'), 'code graph service source file evidence missing')
  assert(codeGraph.nodes.some((node) => node.type === 'function' && node.metadata?.name === 'submitOrder' && node.source?.filePath === 'src/order-service.ts'), 'code graph service function evidence missing')
  assert(codeGraph.nodes.some((node) => node.type === 'function' && node.metadata?.name === 'registerOrderRoutes' && node.source?.filePath === 'src/server.ts'), 'code graph endpoint registration function evidence missing')
  assert(codeGraph.nodes.some((node) => node.type === 'endpoint' && node.metadata?.method === 'POST' && node.metadata?.path === '/api/orders'), 'code graph endpoint evidence missing')
  assert(codeGraph.nodes.some((node) => node.type === 'http_call' && node.metadata?.method === 'POST' && node.metadata?.normalizedPath === '/api/orders'), 'code graph HTTP call evidence missing')
  assert(codeGraph.edges.some((edge) => edge.type === 'has_evidence'), 'code graph evidence edges missing')
  assert(codeGraph.edges.some((edge) => edge.type === 'requires_capability'), 'code graph capability dependency edges missing')
  assert(codeGraph.edges.some((edge) => edge.type === 'imports'), 'code graph import edge missing')
  assert(codeGraph.edges.some((edge) => edge.type === 'handles'), 'code graph source file endpoint handler edge missing')
  assert(codeGraph.edges.some((edge) => edge.type === 'makes_http_request'), 'code graph source file HTTP call edge missing')
  assert(codeGraph.edges.some((edge) => edge.type === 'calls'), 'code graph HTTP call to endpoint edge missing')
  assert(
    codeGraph.edges.some((edge) => {
      if (edge.type !== 'calls') return false
      const from = codeGraph.nodes.find((node) => node.id === edge.from)
      const to = codeGraph.nodes.find((node) => node.id === edge.to)
      return from?.type === 'function' && from.metadata?.name === 'submitOrder' && to?.type === 'http_call'
    }),
    'code graph service function to HTTP call edge missing',
  )
  assert(
    codeGraph.edges.some((edge) => {
      if (edge.type !== 'handles') return false
      const from = codeGraph.nodes.find((node) => node.id === edge.from)
      const to = codeGraph.nodes.find((node) => node.id === edge.to)
      return from?.type === 'function' && from.metadata?.name === 'registerOrderRoutes' && to?.type === 'endpoint'
    }),
    'code graph route registration function to endpoint edge missing',
  )
  assert(
    codeGraph.edges.some((edge) => {
      if (edge.type !== 'handles' || edge.metadata?.source !== 'jsx_event_handler') return false
      const from = codeGraph.nodes.find((node) => node.id === edge.from)
      const to = codeGraph.nodes.find((node) => node.id === edge.to)
      return from?.type === 'function' && from.metadata?.name === 'submitOrder' && to?.type === 'button' && /submit order/i.test(to?.label ?? '')
    }),
    'code graph JSX event handler edge for submitOrder button missing',
  )
  assert(
    codeGraph.edges.some((edge) => {
      if (edge.type !== 'supports_capability') return false
      const capability = codeGraph.nodes.find((node) => node.id === edge.to)
      return capability?.metadata?.capabilityId === 'click_submit_order'
    }),
    'code graph click_submit_order capability support edge missing',
  )
  assert(
    codeGraph.edges.some((edge) => {
      if (edge.type !== 'supports_capability') return false
      const capability = codeGraph.nodes.find((node) => node.id === edge.to)
      return capability?.metadata?.capabilityId === 'click_submit_order'
        && String(edge.metadata?.matchedBy ?? '').startsWith('frontend_surface_')
    }),
    'code graph click_submit_order structural surface support edge missing',
  )
  assert(
    codeGraph.nodes.some((node) => node.type === 'capability_candidate'
      && node.metadata?.capabilityId === 'click_submit_order'
      && node.metadata?.graphMapping?.status === 'mapped'
      && node.metadata?.graphMapping?.resolver === 'capability_surface_graph_v2'
      && node.metadata?.graphMapping?.handlerIds?.length >= 1),
    'code graph click_submit_order capability structural mapping metadata missing',
  )
  assert(
    codeGraph.nodes.some((node) => node.type === 'scenario_candidate'
      && node.metadata?.scenarioId === 'place_order'
      && ['partially_mapped', 'fully_mapped'].includes(node.metadata?.graphReadiness?.status)
      && node.metadata?.graphReadiness?.mappedCapabilityIds?.includes('click_submit_order')),
    'code graph place_order scenario readiness metadata missing',
  )
  assert(
    codeGraph.nodes.some((node) => node.type === 'scenario_step_candidate'
      && /^step_\d+_click_submit_order$/.test(String(node.metadata?.stepId ?? ''))
      && node.metadata?.graphReadiness?.status === 'fully_mapped'
      && node.metadata?.graphReadiness?.supportSourceTypes?.includes('http_call')),
    'code graph click_submit_order step readiness metadata missing',
  )
  assert(
    codeGraph.edges.some((edge) => {
      if (edge.type !== 'related_to' || edge.metadata?.relation !== 'graph_readiness_support') return false
      const from = codeGraph.nodes.find((node) => node.id === edge.from)
      const to = codeGraph.nodes.find((node) => node.id === edge.to)
      return from?.type === 'scenario_candidate' && from.metadata?.scenarioId === 'place_order' && ['http_call', 'endpoint'].includes(to?.type)
    }),
    'code graph scenario readiness support edge missing',
  )
  const submitOrderCapability = capabilities.find((capability) => capability.id === 'click_submit_order')
  assert(submitOrderCapability, 'click_submit_order capability materialization missing')
  assert(submitOrderCapability.graphHint?.status === 'mapped', 'click_submit_order capability graph hint should be mapped')
  assert(submitOrderCapability.graphHint?.handlers?.some((hint) => hint.includes('submitOrder')), 'click_submit_order capability graph hint should expose handler')
  assert(submitOrderCapability.graphHint?.endpoints?.includes('POST /api/orders'), 'click_submit_order capability graph hint should expose endpoint')
  assert(submitOrderCapability.graphHint?.httpCalls?.includes('POST /api/orders'), 'click_submit_order capability graph hint should expose http call')
  const submitOrderCoverage = runtimePlan.capabilityCoverage.find((capability) => capability.capabilityId === 'click_submit_order')
  assert(submitOrderCoverage?.graphStatus === 'mapped', 'runtime plan capability coverage should expose mapped graph status')
  assert(submitOrderCoverage?.graphResolver === 'capability_surface_graph_v2', 'runtime plan capability coverage should expose frontend graph resolver')
  assert(typeof submitOrderCoverage?.graphConfidence === 'number' && submitOrderCoverage.graphConfidence > 0.4, 'runtime plan capability coverage should expose graph confidence')
  assert(submitOrderCoverage?.endpointHints?.includes('POST /api/orders'), 'runtime plan capability coverage should expose endpoint hint')
  assert(submitOrderCoverage?.handlerNodeIds?.length >= 1, 'runtime plan capability coverage should expose handler node ids')
  assert(submitOrderCoverage?.endpointNodeIds?.length >= 1, 'runtime plan capability coverage should expose endpoint node ids')
  assert(submitOrderCoverage?.httpCallNodeIds?.length >= 1, 'runtime plan capability coverage should expose http call node ids')
  assert(personaIds.includes('shopper'), `shopper persona missing: ${personaIds.join(', ')}`)
  assert(personaIds.includes('store_operator'), `store_operator persona missing: ${personaIds.join(', ')}`)
  assert(!personaIds.some((id) => REFERENCE_DOMAIN_ID_PATTERN.test(id)), `reference-domain personas leaked into generic adapter: ${personaIds.join(', ')}`)
  assert(scenarioIds.includes('place_order'), `place_order scenario missing: ${scenarioIds.join(', ')}`)
  assert(!scenarioIds.includes('first_order') && !scenarioIds.includes('first_order_multi_role'), `reference-domain scenario leaked into generic adapter: ${scenarioIds.join(', ')}`)
  assert(capabilityIds.includes('click_submit_order'), `click_submit_order capability missing: ${capabilityIds.join(', ')}`)
  assert(capabilityIds.includes('click_add_item_to_cart'), `click_add_item_to_cart capability missing: ${capabilityIds.join(', ')}`)
  assert(contractsIndex.some((entry) => entry.scenarioId === 'place_order'), 'place_order workflow contract missing')
}

function writeRuntimeHtml() {
  writeFile('index.html', `<!doctype html>
<html lang="en">
  <body>
    <main>
      <h1>Generic Storefront</h1>
      <label>
        Customer email
        <input id="customer-email" placeholder="customer@example.com" />
      </label>
      <button id="add-item">Add item to cart</button>
      <p id="cart-count">Cart items: 0</p>
      <button id="submit-order" disabled>Submit order</button>
      <output id="feedback"></output>
    </main>
    <script>
      let items = 0
      const email = document.querySelector('#customer-email')
      const addItem = document.querySelector('#add-item')
      const submit = document.querySelector('#submit-order')
      const count = document.querySelector('#cart-count')
      const feedback = document.querySelector('#feedback')
      function refresh() {
        submit.disabled = !email.value || items === 0
      }
      email.addEventListener('input', refresh)
      addItem.addEventListener('click', () => {
        items += 1
        count.textContent = 'Cart items: ' + items
        refresh()
      })
      submit.addEventListener('click', () => {
        feedback.textContent = 'Order submitted successfully'
      })
    </script>
  </body>
</html>
`)
}

function startStaticTargetServer() {
  const script = `
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
const root = process.argv[1]
const port = Number(process.argv[2])
const server = http.createServer((request, response) => {
  const file = path.join(root, request.url === '/' ? 'index.html' : request.url.slice(1))
  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    response.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/plain' })
    response.end(data)
  })
})
server.listen(port, '127.0.0.1', () => console.log('target-ready'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`
  const child = spawn(nodePath, ['--input-type=module', '-e', script, fixtureRoot, String(targetPort)], {
    env: verificationEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return waitForProcessReady(child, `http://127.0.0.1:${targetPort}/`, 'target')
}

function startDashboard() {
  const launcher = path.join(fixtureRoot, '.agentic-qa', 'scripts', 'start-local-dashboard.generated.sh')
  const child = spawn(launcher, ['--api-port', String(apiPort), '--web-port', String(webPort)], {
    cwd: path.join(fixtureRoot, '.agentic-qa'),
    detached: true,
    env: {
      ...verificationEnv,
      PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${targetPort}`,
      AGENTIC_QA_FORCE_DETERMINISTIC_RUNTIME: '1',
      HEADLESS: 'true',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return waitForHttpReady(child, `http://127.0.0.1:${apiPort}/health`, 'dashboard')
}

async function verifyRuntimeRun() {
  writeRuntimeHtml()
  let targetServer
  let dashboard
  try {
    await allocatePorts()
    log(`ports target=${targetPort} api=${apiPort} web=${webPort}`)
    targetServer = await startStaticTargetServer()
    dashboard = await startDashboard()

    const healthResponse = await fetch(`http://127.0.0.1:${apiPort}/health`)
    const healthText = await healthResponse.text()
    assert(healthResponse.status === 200, `dashboard health failed with status ${healthResponse.status}: ${healthText}`)
    const health = JSON.parse(healthText)
    assert(health?.status === 'ok', `dashboard health payload is invalid: ${healthText}`)

    const unauthenticated = await fetch(`http://127.0.0.1:${apiPort}/api/p2/code-graph`)
    assert(unauthenticated.status === 401, `runtime API answered ${unauthenticated.status} without the local token`)

    const graphResponse = await fetch(`http://127.0.0.1:${apiPort}/api/p2/code-graph`, { headers: runtimeAuthHeaders() })
    const graphText = await graphResponse.text()
    assert(graphResponse.status === 200, `code graph endpoint failed with status ${graphResponse.status}: ${graphText}`)
    const graphBody = JSON.parse(graphText)
    assert(graphBody.available === true, 'dashboard code graph endpoint did not expose generated graph')
    assert(graphBody.summary.endpointCount >= 1, 'dashboard code graph summary has no endpoints')
    assert(graphBody.summary.httpCallCount >= 1, 'dashboard code graph summary has no HTTP calls')
    assert(graphBody.summary.linkedHttpCallCount >= 1, 'dashboard code graph summary has no linked HTTP calls')
    assert(graphBody.summary.capabilitySupportEdgeCount >= 1, 'dashboard code graph summary has no capability support edges')
    assert(graphBody.summary.mappedCapabilityCount >= 1, 'dashboard code graph summary has no mapped capabilities')
    assert(
      graphBody.summary.capabilityMappings.some((mapping) => mapping.capabilityId === 'click_submit_order' && mapping.mappingStatus === 'mapped'),
      'dashboard code graph summary does not expose click_submit_order as mapped',
    )
    assert(graphBody.graph.nodes.length >= graphBody.summary.nodeCount, 'dashboard code graph payload is inconsistent')

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/p2/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...runtimeAuthHeaders() },
      body: JSON.stringify({ scenario_id: 'place_order' }),
    })
    const responseText = await response.text()
    assert(response.status === 202, `runtime run start failed with status ${response.status}: ${responseText}`)
    const started = JSON.parse(responseText)
    const sessionId = started.session_id
    assert(typeof sessionId === 'string' && sessionId.length > 0, 'runtime run did not return a session id')

    const session = await pollSession(sessionId)
    assert(session.status === 'complete', `runtime run did not complete: ${session.status} ${session.lastError ?? ''}`)
    assert(session.contractEvaluation?.verdict === 'contract_compliant', `runtime run did not finish contract compliant: ${session.contractEvaluation?.verdict ?? 'missing'}`)
    assert(session.artifacts?.commandResult, 'runtime run did not produce commandResult')
    assert(session.artifacts?.verificationResult?.passed === true, 'runtime run did not produce a passing verificationResult')
    log(`PASS generic frontend runtime smoke session=${sessionId}`)
  } finally {
    stopProcessGroup(dashboard)
    stopProcess(targetServer)
  }
}

/** The launcher creates the local API token in .agentic-qa/data/; every request but /health needs it. */
function runtimeAuthHeaders() {
  const tokenPath = path.join(fixtureRoot, '.agentic-qa', 'data', 'runtime-api.token')
  return { 'x-agentic-token': fs.readFileSync(tokenPath, 'utf8').trim() }
}

async function pollSession(sessionId) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/p2/sessions/${sessionId}`, { headers: runtimeAuthHeaders() })
    if (response.ok) {
      const session = await response.json()
      if (session.status === 'complete' || session.status === 'failed') return session
    }
    await sleep(1_000)
  }

  throw new Error(`runtime run timed out waiting for session ${sessionId}`)
}

async function waitForProcessReady(child, url, label) {
  await waitForHttp(url, 15_000, label)
  return child
}

async function waitForHttpReady(child, url, label) {
  await waitForHttp(url, 120_000, label)
  return child
}

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // keep polling
    }
    await sleep(500)
  }
  throw new Error(`${label} did not become ready at ${url}`)
}

function stopProcess(child) {
  if (!child?.pid) return
  child.kill('SIGTERM')
}

function stopProcessGroup(child) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

try {
  createFixture()
  log(`fixture=${fixtureRoot}`)
  runCli('install-local')
  runCli('discover-local')
  verifyGeneratedAdapter()
  await verifyRuntimeRun()
  log('PASS generic frontend install/discovery/runtime verification')
} catch (error) {
  process.stderr.write(`[verify-generic-frontend] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
