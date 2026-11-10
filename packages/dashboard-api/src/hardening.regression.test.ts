/**
 * Regression checks for the 2026-11-09 review.
 * Run with: npx tsx packages/dashboard-api/src/hardening.regression.test.ts
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, lstat, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { FileSessionStore } from '../../core/src/runtime/file-session-store.ts'
import { ensureControlPlaneToken } from './control-plane-guard.ts'
import { DiscoveryValidationError, inferDomainDiscoveryBundle } from './services/domain-specialist-service.ts'
import { assertSafeEnvValue, installLocalPackage } from './services/local-package-installer.ts'
import { sanitizeText } from './services/static-frontend-scanner.ts'
import { FrontendSurfaceMapSchema } from '../../host-sdk/src/domain-discovery-contracts.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const platformRoot = path.resolve(here, '../../..')
let failed = 0

function assert(condition: unknown, message: string) {
  if (!condition) {
    failed += 1
    console.error('FAIL:', message)
  } else {
    console.log('PASS:', message)
  }
}

async function listen(server: import("node:net").Server, host = "127.0.0.1") {
  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing listen address')
  return address
}

async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const address = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  if (!address || typeof address === 'string') throw new Error('no free port')
  return address.port
}

function boundAddress(server: Pick<import("node:net").Server, "address">) {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server is not listening')
  return address as { address: string; port: number }
}

/**
 * T-02 (b): runs the dashboard's own page script against a fake DOM that records every HTML string
 * written into the page, renders executions whose fields are HTML payloads, and checks that no payload
 * reaches the page as markup. A new interpolation without escapeHtml fails here; a grep for the string
 * "escapeHtml(...)" would not notice it.
 */
function testExecutionRenderingEscapes(html: string) {
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'))
  const written: string[] = []

  // A permissive fake DOM node: any property is either stored state or a callable returning another node.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake must accept every DOM access the page script makes
  const makeElement = (): any => {
    const state: Record<string | symbol, unknown> = {
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      style: {},
      dataset: {},
      value: '',
      textContent: '',
      children: [],
    }
    const element = new Proxy(state, {
      get(target, property) {
        if (property in target) return target[property]
        if (property === 'innerHTML' || property === 'outerHTML') return ''
        if (property === 'querySelectorAll' || property === 'getElementsByClassName') return () => []
        if (property === 'querySelector' || property === 'closest') return () => null
        if (property === 'then') return undefined
        return (..._args: unknown[]) => makeElement()
      },
      set(target, property, value) {
        if (property === 'innerHTML' || property === 'outerHTML') written.push(String(value))
        target[property] = value
        return true
      },
    })
    return element
  }

  const elements = new Map<string, unknown>()
  const document = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, makeElement())
      return elements.get(id)
    },
    createElement: () => makeElement(),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    addEventListener() {},
    body: makeElement(),
    documentElement: makeElement(),
  }
  const never = () => new Promise(() => {})
  const sandbox: Record<string, unknown> = {
    document,
    console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: never,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: 'http://127.0.0.1/', hash: '', search: '', pathname: '/' },
    history: { replaceState() {}, pushState() {} },
    navigator: { clipboard: { writeText: never } },
    addEventListener() {},
    URL,
    URLSearchParams,
    Intl,
    Date,
    JSON,
    Math,
    encodeURIComponent,
  }
  sandbox.window = sandbox
  const context = vm.createContext(sandbox)
  try {
    vm.runInContext(script, context, { filename: 'dashboard-page.js', timeout: 2_000 })
  } catch (error) {
    assert(false, `dashboard page script runs against the fake DOM (${error instanceof Error ? error.message : String(error)})`)
    return
  }

  const execution = {
    executionId: 'exec-<img src=x onerror=alert(11)>',
    scenarioId: '<img src=x onerror=alert(12)>',
    adapterId: '<img src=x onerror=alert(13)>',
    status: '<img src=x onerror=alert(14)>',
    hostProjectPath: '/tmp/<img src=x onerror=alert(15)>',
    createdAt: new Date(0).toISOString(),
    steps: ['<img src=x onerror=alert(16)>'],
    events: [],
    personas: [],
    findings: [],
  }
  const render = (name: string, argument: unknown) => {
    const fn = (context as Record<string, unknown>)[name]
    if (typeof fn !== 'function') {
      assert(false, `dashboard page defines ${name}`)
      return
    }
    try {
      ;(fn as (value: unknown) => unknown)(argument)
    } catch (error) {
      assert(false, `${name} renders a hostile execution (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const before = written.length
  render('renderExecutionList', { executions: [execution] })
  render('renderExecutionDetail', { execution })
  const rendered = written.slice(before).join('\n')
  // The instrument check: the payloads must have been rendered at all, escaped.
  for (const id of [12, 13, 15, 16]) {
    assert(rendered.includes(`&lt;img src=x onerror=alert(${id})&gt;`), `execution field payload ${id} is rendered, escaped`)
  }
  assert(!/<img\b/i.test(rendered), 'no execution field reaches the page as an <img> element')
}

async function request(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  const response = await fetch(`http://127.0.0.1:${port}${options.path}`, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, text }
}

async function testControlPlane() {
  const temp = await mkdtemp(path.join(tmpdir(), 'agentic-control-'))
  process.env.AGENTIC_DATA_DIR = path.join(temp, 'data')
  process.env.AGENTIC_CONTROL_PLANE_TOKEN_PATH = path.join(temp, 'data', 'control-plane.token')
  process.env.AGENTIC_PLATFORM_ROOT = temp
  const token = 'a'.repeat(64)
  const { startPlatformApi } = await import('./server.ts')
  const { startPlatformWeb } = await import('../../dashboard-web/src/server.ts')
  const apiPort = await freePort()
  const webPort = await freePort()
  // T-02: the production start functions do the bind; the test only reads where they bound.
  const api = await startPlatformApi({ token, apiPort, webPort })
  const web = await startPlatformWeb({
    token,
    apiPort,
    webPort,
    defaultRepo: '"><img src=x onerror=alert(1)>',
  })
  const apiAddress = boundAddress(api.server)
  const webAddress = boundAddress(web.server)
  try {
    assert(apiAddress.address === '127.0.0.1' && apiAddress.port === apiPort, `api binds to 127.0.0.1:${apiPort} (got ${apiAddress.address}:${apiAddress.port})`)
    assert(webAddress.address === '127.0.0.1' && webAddress.port === webPort, `web binds to 127.0.0.1:${webPort} (got ${webAddress.address}:${webAddress.port})`)
    const health = await request(apiAddress.port, { path: '/health' })
    assert(health.status === 200, 'health does not require a token')
    const missing = await request(apiAddress.port, { method: 'POST', path: '/api/install-local', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert(missing.status === 401, 'post without token is unauthorized')
    const evil = await request(apiAddress.port, { method: 'OPTIONS', path: '/api/install-local', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })
    assert(evil.status === 403 && !evil.headers.has('access-control-allow-origin'), 'foreign origin is not reflected')
    const webOrigin = `http://127.0.0.1:${webPort}`
    const localOrigin = await request(apiAddress.port, { method: 'OPTIONS', path: '/api/install-local', headers: { origin: webOrigin, 'access-control-request-method': 'POST' } })
    assert(localOrigin.status === 204 && localOrigin.headers.get('access-control-allow-origin') === webOrigin, 'local web origin is allowed')
    const invalid = await request(apiAddress.port, {
      method: 'POST',
      path: '/api/install-local',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{',
    })
    assert(invalid.status === 400 && invalid.text.includes('invalid_json'), 'invalid JSON is 400')
    const huge = await request(apiAddress.port, {
      method: 'POST',
      path: '/api/install-local',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: `{"repoPath":"${'x'.repeat(1_100_000)}"}`,
    })
    assert(huge.status === 413 && huge.text.includes('payload_too_large'), 'oversized body is 413')
    assert(!web.html.includes('<img src=x'), 'default repo is escaped in the dashboard HTML')
    assert(web.html.includes(`"authorization": "Bearer ${token}"`) === false, 'token is not logged as an object dump')
    assert(web.html.includes(token), 'dashboard page receives the local token')
    testExecutionRenderingEscapes(web.html)
  } finally {
    await new Promise((resolve) => api.server.close(resolve))
    await new Promise((resolve) => web.server.close(resolve))
    await rm(temp, { recursive: true, force: true })
  }
}

async function testTokenFileMode() {
  const temp = await mkdtemp(path.join(tmpdir(), 'agentic-token-'))
  const tokenPath = path.join(temp, 'control-plane.token')
  const token = await ensureControlPlaneToken(tokenPath)
  const info = await stat(tokenPath)
  assert(/^[a-f0-9]{64}$/.test(token), 'token is 32 bytes of hex')
  assert((info.mode & 0o777) === 0o600, 'token file is mode 0600')
  await rm(temp, { recursive: true, force: true })
}

async function testSessionStore() {
  const temp = await mkdtemp(path.join(tmpdir(), 'agentic-sessions-'))
  const store = new FileSessionStore({ dataPath: path.join(temp, 'sessions.json') })
  await Promise.all(Array.from({ length: 25 }, (_, index) => store.createSession({
    id: `session-${index}`,
    adapterId: 'fixture',
    scenarioId: 'fixture',
    status: 'pending',
    startedAt: new Date().toISOString(),
    events: [],
    findings: [],
    artifacts: {},
  } as never)))
  const raw = JSON.parse(await readFile(path.join(temp, 'sessions.json'), 'utf8')) as Array<{ id: string }>
  assert(raw.length === 25, `25 concurrent sessions are stored (got ${raw.length})`)
  await rm(temp, { recursive: true, force: true })
}

async function testRedactionAndDiscovery() {
  const redacted = sanitizeText([
    'Pay AKIAIOSFODNN7EXAMPLE1234',
    'Authorization: Bearer abcdefghijklmnop',
    '-----BEGIN RSA PRIVATE KEY-----',
    'super-secret-material',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n'))
  assert(!redacted.includes('AKIA'), 'AKIA key material is redacted')
  assert(!redacted.includes('abcdefghijklmnop'), 'bearer token is redacted')
  assert(!redacted.includes('super-secret-material'), 'private key block is redacted')

  let validationFailed = false
  try {
    inferDomainDiscoveryBundle(FrontendSurfaceMapSchema.parse({ targetId: 'empty-fixture' }))
  } catch (error) {
    validationFailed = error instanceof DiscoveryValidationError
    assert(!(error instanceof Error) || !error.stack?.includes('ZodError'), 'empty discovery does not surface a ZodError stack to callers')
  }
  assert(validationFailed, 'empty domain evidence fails closed')

  const repo = await mkdtemp(path.join(tmpdir(), 'agentic-discover-'))
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { react: '18.0.0' } }))
  await writeFile(path.join(repo, 'index.html'), `<button>Save</button>${'A'.repeat(2_000_000)}`)
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/dashboard-api/src/cli.ts', 'discover-local', repo], {
    cwd: platformRoot,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_API_KEY_OVERRIDE: '',
      ANTHROPIC_API: '',
      OPENAI_API_KEY: '',
    },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const status = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)))
  assert(!stderr.includes('ZodError'), 'discover-local stderr has no ZodError')
  assert(!stderr.includes('\n    at '), 'discover-local stderr has no stack')
  if (status !== 0) {
    const parsed = JSON.parse(stderr)
    assert(parsed.error === 'discovery_validation_failed', 'failed discovery names discovery_validation_failed')
  } else {
    const parsed = JSON.parse(stdout)
    const draftIds = (parsed.draft?.scenarios ?? []).map((scenario: { id: string }) => scenario.id)
    const disk = JSON.parse(await readFile(path.join(repo, '.agentic-qa', 'adapter', 'scenarios', 'scenarios.generated.json'), 'utf8')) as Array<{ id: string }>
    assert(JSON.stringify(draftIds) === JSON.stringify(disk.map((scenario) => scenario.id)), 'CLI draft scenarios match the file on disk')
    assert(!draftIds.includes('checkout_smoke'), 'generic draft does not emit checkout_smoke')
  }
  await rm(repo, { recursive: true, force: true })
}

async function testInstaller() {
  const previousCwd = process.cwd()
  const previousFetch = globalThis.fetch
  const saved: Record<string, string | undefined> = {}
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_OVERRIDE', 'ANTHROPIC_API', 'OPENAI_API_KEY']) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  const work = await mkdtemp(path.join(tmpdir(), 'agentic-install-'))
  process.chdir(work)
  globalThis.fetch = (async () => {
    throw new Error('network disabled in regression test')
  }) as typeof fetch
  try {
    assertSafeEnvValue('ANTHROPIC_API_KEY', 'synthetic-test-key')
    let refused = false
    try {
      assertSafeEnvValue('ANTHROPIC_API_KEY', 'bad;value')
    } catch {
      refused = true
    }
    assert(refused, 'unsafe env values are refused')

    const outside = await mkdtemp(path.join(tmpdir(), 'agentic-outside-'))
    const linked = await mkdtemp(path.join(tmpdir(), 'agentic-linked-'))
    await symlink(outside, path.join(linked, '.agentic-qa'))
    let symlinkRefused = false
    try {
      await installLocalPackage({ repoPath: linked })
    } catch (error) {
      symlinkRefused = error instanceof Error && error.message.includes('symlink')
    }
    const outsideNames = await import('node:fs/promises').then((fs) => fs.readdir(outside))
    assert(symlinkRefused, 'symlink .agentic-qa aborts install')
    assert(!outsideNames.includes('package.json'), 'symlink target does not receive the template')

    // A symlink committed INSIDE .agentic-qa must also abort install before any write: otherwise the
    // provider key in .env.local, or the launcher in scripts/, lands wherever the link points.
    process.env.ANTHROPIC_API_KEY = 'synthetic-test-key'
    const linkVictimDir = await mkdtemp(path.join(tmpdir(), 'agentic-link-victim-'))
    const linkVictim = path.join(linkVictimDir, 'victim.txt')
    await writeFile(linkVictim, 'original content\n')
    const linkScriptsTarget = await mkdtemp(path.join(tmpdir(), 'agentic-link-scripts-'))
    const innerLinked = await mkdtemp(path.join(tmpdir(), 'agentic-inner-linked-'))
    await mkdir(path.join(innerLinked, '.agentic-qa'), { recursive: true })
    await symlink(linkVictim, path.join(innerLinked, '.agentic-qa', '.env.local'))
    await symlink(linkScriptsTarget, path.join(innerLinked, '.agentic-qa', 'scripts'))
    let innerRefused = false
    try {
      await installLocalPackage({ repoPath: innerLinked })
    } catch (error) {
      innerRefused = error instanceof Error && error.message.includes('symlink')
    }
    delete process.env.ANTHROPIC_API_KEY
    const scriptsAfter = await import('node:fs/promises').then((fs) => fs.readdir(linkScriptsTarget))
    assert(innerRefused, 'a symlink inside .agentic-qa aborts install')
    assert(await readFile(linkVictim, 'utf8') === 'original content\n', 'a symlinked .env.local does not receive the provider key')
    assert(scriptsAfter.length === 0, `a symlinked scripts/ folder receives nothing (found ${scriptsAfter.join(', ')})`)
    for (const dir of [linkVictimDir, linkScriptsTarget, innerLinked]) await rm(dir, { recursive: true, force: true })

    const planted = await mkdtemp(path.join(tmpdir(), 'agentic-planted-'))
    await mkdir(path.join(planted, '.agentic-qa'), { recursive: true })
    await writeFile(path.join(planted, '.agentic-qa', '.env.local'), 'echo PLANTED\n', { mode: 0o600 })
    await installLocalPackage({ repoPath: planted })
    const envText = await readFile(path.join(planted, '.agentic-qa', '.env.local'), 'utf8')
    const launcher = await readFile(path.join(planted, '.agentic-qa', 'scripts', 'start-local-dashboard.generated.sh'), 'utf8')
    const loadEnvScript = path.join(planted, '.agentic-qa', 'scripts', 'load-env.generated.mjs')
    const installedPackage = JSON.parse(await readFile(path.join(planted, '.agentic-qa', 'package.json'), 'utf8')) as { engines?: { node?: string } }
    assert(!envText.includes('PLANTED') && !envText.includes('echo'), 'planted .env.local is overwritten')
    // The launcher comment explains the refusal. Match the shell commands, not the word "source".
    assert(
      !launcher.includes('. "${ENV_FILE}"') && !launcher.includes('source "${ENV_FILE}"') && !/^\s*(?:source|\.)\s+/m.test(launcher),
      'launcher does not source .env.local',
    )
    // The launcher adds this launch's dashboard origins to any the user exported, instead of replacing them.
    const originLine = launcher.split('\n').find((line) => line.startsWith('export AGENTIC_QA_WEB_ORIGIN='))
    assert(originLine, 'launcher exports AGENTIC_QA_WEB_ORIGIN')
    const originsWith = spawnSync('bash', ['-euc', `${originLine}\nprintf %s "$AGENTIC_QA_WEB_ORIGIN"`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, WEB_PORT: '5176', AGENTIC_QA_WEB_ORIGIN: 'http://localhost:8080' },
    })
    assert(
      originsWith.stdout === 'http://127.0.0.1:5176,http://localhost:5176,http://localhost:8080',
      `launcher keeps the user's extra dashboard origin (got ${JSON.stringify(originsWith.stdout || originsWith.stderr)})`,
    )
    const originsWithout = spawnSync('bash', ['-euc', `${originLine}\nprintf %s "$AGENTIC_QA_WEB_ORIGIN"`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, WEB_PORT: '5176' },
    })
    assert(
      originsWithout.stdout === 'http://127.0.0.1:5176,http://localhost:5176',
      `launcher origins without a user value under set -u (got ${JSON.stringify(originsWithout.stdout || originsWithout.stderr)})`,
    )
    const loadEnvSyntax = spawnSync(process.execPath, ['--check', loadEnvScript], { encoding: 'utf8' })
    assert(loadEnvSyntax.status === 0, `load-env.generated.mjs parses: ${loadEnvSyntax.stderr}`)
    assert(installedPackage.engines?.node === '>=22.13.0', 'installed package engine matches the platform')
    const envStat = await stat(path.join(planted, '.agentic-qa', '.env.local'))
    assert((envStat.mode & 0o777) === 0o600, 'rewritten .env.local is mode 0600')

    process.env.ANTHROPIC_API_KEY = 'synthetic-test-key'
    const quoted = await mkdtemp(path.join(tmpdir(), 'agentic-quoted-'))
    await installLocalPackage({ repoPath: quoted })
    const quotedEnv = await readFile(path.join(quoted, '.agentic-qa', '.env.local'), 'utf8')
    assert(quotedEnv.includes('ANTHROPIC_API_KEY="synthetic-test-key"'), 'safe key is written quoted')
    delete process.env.ANTHROPIC_API_KEY

    process.env.ANTHROPIC_API_KEY = 'bad;value'
    const unsafeRepo = await mkdtemp(path.join(tmpdir(), 'agentic-unsafe-'))
    await mkdir(path.join(unsafeRepo, '.agentic-qa'), { recursive: true })
    const userEnv = 'PLAYWRIGHT_BASE_URL=http://127.0.0.1:4100\n'
    await writeFile(path.join(unsafeRepo, '.agentic-qa', '.env.local'), userEnv)
    let unsafeRefused = false
    try {
      await installLocalPackage({ repoPath: unsafeRepo })
    } catch (error) {
      unsafeRefused = error instanceof Error && error.message === 'refusing unsafe ANTHROPIC_API_KEY'
    }
    const unsafeEnv = await readFile(path.join(unsafeRepo, '.agentic-qa', '.env.local'), 'utf8')
    assert(unsafeRefused, 'install refuses an unsafe key')
    // B-10: the refusal happens before any write, so the install is all or nothing.
    assert(!unsafeEnv.includes('bad;value'), 'the unsafe key is not stored')
    assert(unsafeEnv === userEnv, 'a refused install leaves the existing .env.local, and the user variables in it, untouched')
    assert(!(await exists(path.join(unsafeRepo, '.agentic-qa', 'package.json'))), 'a refused install copies nothing')
  } finally {
    globalThis.fetch = previousFetch
    process.chdir(previousCwd)
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(work, { recursive: true, force: true })
  }
}

// S-02 (docs/analise-20261109.md): the target repository is untrusted and can commit symlinks inside
// .agentic-qa/ or in the folders discovery copies. discover-local must never write, delete, or copy
// through them. Every case runs the real CLI on a copy of examples/storefront, which reaches the
// materializer; the clean case proves that, so a symlink case cannot pass just because discovery failed.
async function runDiscoverLocal(repo: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/dashboard-api/src/cli.ts', 'discover-local', repo], {
    cwd: platformRoot,
    env: { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_API_KEY_OVERRIDE: '', ANTHROPIC_API: '', OPENAI_API_KEY: '' },
  })
  let stderr = ''
  child.stdout.resume()
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const status = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)))
  return { status, stderr }
}

async function storefrontCopy(label: string) {
  const repo = await mkdtemp(path.join(tmpdir(), `agentic-confine-${label}-`))
  await cp(path.join(platformRoot, 'examples', 'storefront'), repo, { recursive: true })
  return repo
}

async function exists(target: string) {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

async function testDiscoveryConfinement() {
  const created: string[] = []
  const temp = async (label: string) => {
    const dir = await mkdtemp(path.join(tmpdir(), `agentic-confine-${label}-`))
    created.push(dir)
    return dir
  }
  try {
    // Clean copy: discovery reaches the materializer and writes the adapter.
    const clean = await storefrontCopy('clean')
    created.push(clean)
    const cleanRun = await runDiscoverLocal(clean)
    assert(cleanRun.status === 0, `clean storefront discovery succeeds (status ${cleanRun.status})`)
    assert(
      await exists(path.join(clean, '.agentic-qa', 'adapter', 'manifest', 'adapter-manifest.generated.json')),
      'clean storefront discovery writes the adapter manifest',
    )

    // Directory symlink: .agentic-qa/adapter/config -> a folder outside the repository.
    const outsideDir = await temp('outside-dir')
    await writeFile(path.join(outsideDir, 'victim.generated.keep'), 'keep me\n')
    const dirRepo = await storefrontCopy('dirlink')
    created.push(dirRepo)
    await mkdir(path.join(dirRepo, '.agentic-qa', 'adapter'), { recursive: true })
    await symlink(outsideDir, path.join(dirRepo, '.agentic-qa', 'adapter', 'config'))
    const dirRun = await runDiscoverLocal(dirRepo)
    const outsideAfter = await readdir(outsideDir)
    assert(dirRun.status !== 0, 'discover-local fails when an adapter folder is a symlink')
    assert(dirRun.stderr.includes('local_confinement_refused'), 'symlinked adapter folder is reported as a confinement refusal')
    assert(!dirRun.stderr.includes('\n    at '), 'confinement refusal is reported without a stack')
    assert(outsideAfter.includes('victim.generated.keep'), 'a *.generated.* file outside the repository is not deleted')
    assert(
      JSON.stringify(outsideAfter) === JSON.stringify(['victim.generated.keep']),
      `nothing is written outside the repository through a symlinked folder (found ${outsideAfter.join(', ')})`,
    )

    // File symlink: the manifest path itself points to a file outside the repository.
    const outsideFileDir = await temp('outside-file')
    const victim = path.join(outsideFileDir, 'victim.txt')
    await writeFile(victim, 'original content\n')
    const fileRepo = await storefrontCopy('filelink')
    created.push(fileRepo)
    await mkdir(path.join(fileRepo, '.agentic-qa', 'adapter', 'manifest'), { recursive: true })
    await symlink(victim, path.join(fileRepo, '.agentic-qa', 'adapter', 'manifest', 'adapter-manifest.generated.json'))
    const fileRun = await runDiscoverLocal(fileRepo)
    assert(fileRun.status !== 0, 'discover-local fails when a generated file is a symlink')
    assert(await readFile(victim, 'utf8') === 'original content\n', 'a file outside the repository is not overwritten through a symlink')

    // Source symlink: a folder discovery snapshots points outside the repository.
    const outsideSource = await temp('outside-source')
    await writeFile(path.join(outsideSource, 'secret.ts'), 'export const SECRET = "outside"\n')
    const sourceRepo = await storefrontCopy('srclink')
    created.push(sourceRepo)
    await mkdir(path.join(sourceRepo, 'integration-test', 'persona-tests'), { recursive: true })
    await symlink(outsideSource, path.join(sourceRepo, 'integration-test', 'persona-tests', 'support'))
    const sourceRun = await runDiscoverLocal(sourceRepo)
    const snapshotSecret = path.join(
      sourceRepo, '.agentic-qa', 'adapter', 'runtime', 'host-source-snapshot', 'integration-test', 'persona-tests', 'support', 'secret.ts',
    )
    assert(sourceRun.status === 0, `discovery still succeeds when a snapshot source is a symlink (status ${sourceRun.status})`)
    assert(!(await exists(snapshotSecret)), 'files outside the repository are not copied into the snapshot')
  } finally {
    for (const dir of created) await rm(dir, { recursive: true, force: true })
  }
}

// S-15 (docs/analise-20261109.md): the dashboard page embeds the control-plane token, so a DNS-rebinding
// page could read it under its own domain and then call the API with it. Both servers must refuse a
// non-loopback Host, and the API must refuse a foreign Origin on every method, not only on OPTIONS.
function rawRequest(port: number, options: { method?: string; path: string; headers: Record<string, string> }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function testControlPlaneRebinding() {
  const temp = await mkdtemp(path.join(tmpdir(), 'agentic-rebinding-'))
  process.env.AGENTIC_DATA_DIR = path.join(temp, 'data')
  process.env.AGENTIC_CONTROL_PLANE_TOKEN_PATH = path.join(temp, 'data', 'control-plane.token')
  const token = 'b'.repeat(64)
  const { createPlatformApiServer } = await import('./server.ts')
  const { createPlatformWebServer } = await import('../../dashboard-web/src/server.ts')
  const api = await createPlatformApiServer({ token, webPort: 4177 })
  const web = await createPlatformWebServer({ token, apiPort: 3101, webPort: 4177 })
  const apiPort = (await listen(api.server)).port
  const webPort = (await listen(web.server)).port
  try {
    const rebound = await rawRequest(webPort, { path: '/', headers: { host: `evil.example:${webPort}` } })
    assert(rebound.status === 403, `dashboard page refuses a rebound Host (got ${rebound.status})`)
    assert(!rebound.body.includes(token), 'dashboard page does not hand the token to a rebound Host')
    const local = await rawRequest(webPort, { path: '/', headers: { host: `127.0.0.1:${webPort}` } })
    assert(local.status === 200 && local.body.includes(token), 'dashboard page still serves the token on a loopback Host')
    const localhostName = await rawRequest(webPort, { path: '/', headers: { host: `localhost:${webPort}` } })
    assert(localhostName.status === 200, 'dashboard page accepts localhost as Host')

    const apiRebound = await rawRequest(apiPort, { path: '/api/adapters', headers: { host: `evil.example:${apiPort}`, 'x-agentic-token': token } })
    assert(apiRebound.status === 403, `control-plane API refuses a rebound Host even with the token (got ${apiRebound.status})`)
    const apiForeignOrigin = await rawRequest(apiPort, {
      path: '/api/adapters',
      headers: { host: `127.0.0.1:${apiPort}`, origin: 'http://evil.example', 'x-agentic-token': token },
    })
    assert(apiForeignOrigin.status === 403, `control-plane API refuses a foreign Origin on GET, not only on OPTIONS (got ${apiForeignOrigin.status})`)
    const apiLocal = await rawRequest(apiPort, {
      path: '/api/adapters',
      headers: { host: `127.0.0.1:${apiPort}`, origin: 'http://127.0.0.1:4177', 'x-agentic-token': token },
    })
    assert(apiLocal.status === 200, `control-plane API still serves the dashboard origin with the token (got ${apiLocal.status})`)
  } finally {
    await new Promise((resolve) => api.server.close(resolve))
    await new Promise((resolve) => web.server.close(resolve))
    await rm(temp, { recursive: true, force: true })
  }
}

/**
 * T-06: the release gate must not validate a provider key over the network, and no developer key (from
 * the platform .env.local or the environment) may reach the throwaway fixture it installs into.
 */
async function testProviderKeyIsolation() {
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_API', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY_OVERRIDE', 'OPENAI_API_KEY_OVERRIDE', 'AGENTIC_QA_SKIP_KEY_VALIDATION']
  const savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const previousFetch = globalThis.fetch
  const previousCwd = process.cwd()
  const fetched: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    fetched.push(String(input))
    return new Response('{}', { status: 401 })
  }) as typeof fetch
  // A stand-in for the platform checkout, with a developer key in its .env.local (the real one is never read).
  const platformDir = await mkdtemp(path.join(tmpdir(), 'agentic-platform-env-'))
  await writeFile(path.join(platformDir, '.env.local'), 'ANTHROPIC_API_KEY=sk-ant-from-platform-file\nOPENAI_API_KEY=sk-openai-from-platform-file\n')
  const isolated = await mkdtemp(path.join(tmpdir(), 'agentic-isolated-'))
  const validated = await mkdtemp(path.join(tmpdir(), 'agentic-validated-'))
  try {
    process.chdir(platformDir)
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-environment'
    process.env.OPENAI_API_KEY = 'sk-openai-from-environment'
    process.env.ANTHROPIC_API_KEY_OVERRIDE = 'sk-ant-verification-placeholder'
    process.env.OPENAI_API_KEY_OVERRIDE = ''
    process.env.AGENTIC_QA_SKIP_KEY_VALIDATION = '1'

    const result = await installLocalPackage({ repoPath: isolated })
    const envLocal = await readFile(path.join(isolated, '.agentic-qa', '.env.local'), 'utf8')
    assert(fetched.length === 0, `install with AGENTIC_QA_SKIP_KEY_VALIDATION=1 makes no network call (got ${JSON.stringify(fetched)})`)
    assert(/skipped/i.test(result.anthropicEnvValidationMessage), `install reports the validation as skipped (got ${JSON.stringify(result.anthropicEnvValidationMessage)})`)
    assert(envLocal.includes('ANTHROPIC_API_KEY="sk-ant-verification-placeholder"'), 'the Anthropic override wins over the platform .env.local and the environment')
    assert(!envLocal.includes('from-platform-file') && !envLocal.includes('from-environment'), 'no developer key reaches the installed .env.local, including the OpenAI one')

    // Instrument check: without the skip flag the same stub does see the validation request.
    delete process.env.AGENTIC_QA_SKIP_KEY_VALIDATION
    await installLocalPackage({ repoPath: validated })
    assert(fetched.length === 1 && fetched[0]!.startsWith('https://api.anthropic.com/'), `without the flag the key is validated (stubbed) once (got ${JSON.stringify(fetched)})`)
  } finally {
    process.chdir(previousCwd)
    globalThis.fetch = previousFetch
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    for (const dir of [platformDir, isolated, validated]) await rm(dir, { recursive: true, force: true })
  }
}

/**
 * A-02: the installer used to patch the copied runtime with string.replace. Most patterns no longer
 * matched, one corrupted a type and one duplicated an import, so the code running in the user's repo
 * differed from the code tested in CI. The installed source must be the template source, byte for byte.
 */
async function testInstalledSourceMatchesTemplate() {
  const keys = ['ANTHROPIC_API_KEY_OVERRIDE', 'OPENAI_API_KEY_OVERRIDE', 'AGENTIC_QA_SKIP_KEY_VALIDATION']
  const savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.ANTHROPIC_API_KEY_OVERRIDE = ''
  process.env.OPENAI_API_KEY_OVERRIDE = ''
  process.env.AGENTIC_QA_SKIP_KEY_VALIDATION = '1'
  const repo = await mkdtemp(path.join(tmpdir(), 'agentic-pristine-'))
  try {
    await installLocalPackage({ repoPath: repo })
    const templateRoot = path.join(platformRoot, 'templates', 'persona-qa-dashboard')
    const installedRoot = path.join(repo, '.agentic-qa')
    const differing: string[] = []
    let compared = 0
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(path.join(templateRoot, relative), { withFileTypes: true })) {
        const child = path.join(relative, entry.name)
        if (entry.isDirectory()) {
          await walk(child)
          continue
        }
        const installed = await readFile(path.join(installedRoot, child)).catch(() => null)
        if (!installed) continue
        compared += 1
        if (!installed.equals(await readFile(path.join(templateRoot, child)))) differing.push(child)
      }
    }
    for (const pkg of ['api', 'web']) await walk(path.join('packages', pkg, 'src'))
    assert(compared > 100, `installed runtime source was compared (${compared} files)`)
    const metadata = JSON.parse(await readFile(path.join(installedRoot, 'adapter', 'config', 'install-metadata.generated.json'), 'utf8')) as { templateVersion?: unknown }
    const templateVersion = (JSON.parse(await readFile(path.join(templateRoot, 'package.json'), 'utf8')) as { version: string }).version
    assert(metadata.templateVersion === templateVersion, `install metadata records the template version (got ${JSON.stringify(metadata.templateVersion)}, want ${templateVersion})`)
    assert(differing.length === 0, `installed runtime source is the template source (differs: ${differing.join(', ') || 'none'})`)
  } finally {
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    await rm(repo, { recursive: true, force: true })
  }
}

/**
 * Reinstall keeps the user's .env.local: every variable already there stays as it is, new provider
 * keys are added only when absent, and lines that are not assignments are dropped.
 */
async function testReinstallMergesEnvLocal() {
  const keys = ['ANTHROPIC_API_KEY_OVERRIDE', 'OPENAI_API_KEY_OVERRIDE', 'AGENTIC_QA_SKIP_KEY_VALIDATION']
  const savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.AGENTIC_QA_SKIP_KEY_VALIDATION = '1'
  process.env.ANTHROPIC_API_KEY_OVERRIDE = ''
  process.env.OPENAI_API_KEY_OVERRIDE = ''
  const repo = await mkdtemp(path.join(tmpdir(), 'agentic-env-merge-'))
  try {
    await installLocalPackage({ repoPath: repo })
    const envPath = path.join(repo, '.agentic-qa', '.env.local')
    await writeFile(envPath, [
      '# my notes',
      'PLAYWRIGHT_BASE_URL=http://127.0.0.1:4100',
      'ANTHROPIC_API_KEY="sk-ant-user-chosen"',
      // Copied from .env.example: an empty key counts as missing.
      'OPENAI_API_KEY=',
      'echo PLANTED',
      '',
    ].join('\n'))

    process.env.ANTHROPIC_API_KEY_OVERRIDE = 'sk-ant-new-from-install'
    process.env.OPENAI_API_KEY_OVERRIDE = 'sk-openai-new-from-install'
    const result = await installLocalPackage({ repoPath: repo })
    const merged = await readFile(envPath, 'utf8')

    assert(merged.includes('PLAYWRIGHT_BASE_URL=http://127.0.0.1:4100'), 'reinstall keeps a user variable in .env.local')
    assert(merged.includes('# my notes'), 'reinstall keeps the user comments')
    assert(merged.includes('ANTHROPIC_API_KEY="sk-ant-user-chosen"') && !merged.includes('sk-ant-new-from-install'), 'reinstall does not overwrite a key already in .env.local')
    assert(merged.includes('OPENAI_API_KEY="sk-openai-new-from-install"'), 'reinstall adds a provider key that was missing')
    assert(!merged.includes('PLANTED'), 'a line that is not an assignment is dropped')
    assert((merged.match(/^ANTHROPIC_API_KEY=/gm) ?? []).length === 1 && (merged.match(/^OPENAI_API_KEY=/gm) ?? []).length === 1, 'each key appears once, and the empty OPENAI_API_KEY= line was replaced')
    assert(result.anthropicEnvSource === 'target/.agentic-qa/.env.local', `metadata reports the key that is in effect (got ${result.anthropicEnvSource})`)
    assert(((await stat(envPath)).mode & 0o777) === 0o600, 'merged .env.local stays mode 0600')
  } finally {
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    await rm(repo, { recursive: true, force: true })
  }
}

/**
 * After upgrade-local the runtime code is new but node_modules was installed for the old
 * package-lock.json. The launcher must reinstall then, and only then. Runs the launcher's own
 * ensure_workspace_deps with a stub npm that records each call.
 */
async function testLauncherReinstallsDepsWhenLockChanges() {
  const keys = ['ANTHROPIC_API_KEY_OVERRIDE', 'OPENAI_API_KEY_OVERRIDE', 'AGENTIC_QA_SKIP_KEY_VALIDATION']
  const savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.ANTHROPIC_API_KEY_OVERRIDE = ''
  process.env.OPENAI_API_KEY_OVERRIDE = ''
  process.env.AGENTIC_QA_SKIP_KEY_VALIDATION = '1'
  const repo = await mkdtemp(path.join(tmpdir(), 'agentic-deps-'))
  const stubBin = await mkdtemp(path.join(tmpdir(), 'agentic-npm-stub-'))
  try {
    await installLocalPackage({ repoPath: repo })
    const root = path.join(repo, '.agentic-qa')
    const launcher = await readFile(path.join(root, 'scripts', 'start-local-dashboard.generated.sh'), 'utf8')
    const fnStart = launcher.indexOf('ensure_workspace_deps() {')
    const fn = launcher.slice(fnStart, launcher.indexOf('\n}\n', fnStart) + 2)
    const calls = path.join(stubBin, 'calls.log')
    // A stub npm: records the call and "installs" by creating node_modules.
    await writeFile(path.join(stubBin, 'npm'), `#!/bin/sh\necho "$*" >> "${calls}"\nmkdir -p node_modules\n`, { mode: 0o755 })
    const runDeps = () => spawnSync('bash', ['-euc', `ROOT_DIR="${root}"\n${fn}\nensure_workspace_deps`], {
      encoding: 'utf8',
      env: { PATH: `${stubBin}:${process.env.PATH}` },
    })
    const npmCalls = async () => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean).length

    const first = runDeps()
    assert(first.status === 0 && await npmCalls() === 1, `launcher installs dependencies when node_modules is missing (${first.stderr})`)
    runDeps()
    assert(await npmCalls() === 1, 'launcher does not reinstall when package-lock.json is the one it installed')
    await writeFile(path.join(root, 'package-lock.json'), `${await readFile(path.join(root, 'package-lock.json'), 'utf8')}\n`)
    runDeps()
    assert(await npmCalls() === 2, 'launcher reinstalls when package-lock.json changed (after upgrade-local)')
  } finally {
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    await rm(repo, { recursive: true, force: true })
    await rm(stubBin, { recursive: true, force: true })
  }
}

/**
 * Third pre-PR run, findings #2/#3: a key the installer keeps must be one the launcher's loader can
 * read, or the runtime starts without it while the install reports it as kept.
 */
async function testKeptKeyIsReadByLauncher() {
  const keys = ['ANTHROPIC_API_KEY_OVERRIDE', 'OPENAI_API_KEY_OVERRIDE', 'AGENTIC_QA_SKIP_KEY_VALIDATION']
  const savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.AGENTIC_QA_SKIP_KEY_VALIDATION = '1'
  process.env.ANTHROPIC_API_KEY_OVERRIDE = ''
  process.env.OPENAI_API_KEY_OVERRIDE = ''
  const repo = await mkdtemp(path.join(tmpdir(), 'agentic-kept-key-'))
  try {
    await installLocalPackage({ repoPath: repo })
    const root = path.join(repo, '.agentic-qa')
    const envPath = path.join(root, '.env.local')
    const loader = path.join(root, 'scripts', 'load-env.generated.mjs')
    process.env.ANTHROPIC_API_KEY_OVERRIDE = 'sk-ant-from-install'
    for (const [label, line, expected] of [
      ['export prefix', 'export ANTHROPIC_API_KEY="sk-ant-user123"', 'sk-ant-user123'],
      ['single quotes', "ANTHROPIC_API_KEY='sk-ant-user456'", 'sk-ant-user456'],
      ['a value the loader refuses', 'ANTHROPIC_API_KEY="has spaces and !"', 'sk-ant-from-install'],
    ] as const) {
      await writeFile(envPath, `${line}\n`)
      const reinstalled = await installLocalPackage({ repoPath: repo })
      const loaded = spawnSync(process.execPath, [loader, envPath], { encoding: 'utf8' })
      assert(
        loaded.status === 0 && loaded.stdout.includes(`export ANTHROPIC_API_KEY='${expected}'`),
        `${label}: the key in effect after reinstall is the one the launcher loads (${expected}; got ${JSON.stringify(loaded.stdout.trim() || loaded.stderr.trim())})`,
      )
      // Fourth pre-PR run, #5: a replaced key is reported, not swapped in silence.
      const replaced = reinstalled.envLocalReplacedKeys ?? []
      const wasReplaced = expected === 'sk-ant-from-install'
      assert(replaced.includes('ANTHROPIC_API_KEY') === wasReplaced, `${label}: envLocalReplacedKeys ${wasReplaced ? 'reports' : 'does not report'} the key (got ${JSON.stringify(replaced)})`)
    }

    // Fourth pre-PR run, #2/#3: upgrade-local backups stay out of the host repository's git.
    const gitInit = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' })
    const ignored = spawnSync('git', ['check-ignore', '-q', '.agentic-qa/persona-qa.db.pre-upgrade-2026-11-10T12-00-00-000Z.bak'], { cwd: repo, encoding: 'utf8' })
    assert(gitInit.status === 0 && ignored.status === 0, `the generated .gitignore ignores upgrade-local database backups (check-ignore exit ${ignored.status})`)
  } finally {
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    await rm(repo, { recursive: true, force: true })
  }
}

/** B-10: discover-local cleared every *.generated.* file in adapter/config, the install metadata too. */
async function testDiscoveryKeepsInstallMetadata() {
  const keys = ['ANTHROPIC_API_KEY_OVERRIDE', 'OPENAI_API_KEY_OVERRIDE', 'AGENTIC_QA_SKIP_KEY_VALIDATION']
  const savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.ANTHROPIC_API_KEY_OVERRIDE = ''
  process.env.OPENAI_API_KEY_OVERRIDE = ''
  process.env.AGENTIC_QA_SKIP_KEY_VALIDATION = '1'
  const repo = await storefrontCopy('metadata')
  try {
    await installLocalPackage({ repoPath: repo })
    const metadataPath = path.join(repo, '.agentic-qa', 'adapter', 'config', 'install-metadata.generated.json')
    assert(await exists(metadataPath), 'install writes install-metadata.generated.json')
    const discovered = await runDiscoverLocal(repo)
    assert(discovered.status === 0, `discover-local succeeds on the installed copy: ${discovered.stderr.slice(-300)}`)
    assert(await exists(metadataPath), 'discover-local keeps install-metadata.generated.json')
    assert(await exists(path.join(repo, '.agentic-qa', 'adapter', 'config', 'discovery-report.generated.json')), 'discover-local still rewrites its own generated config')
  } finally {
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    await rm(repo, { recursive: true, force: true })
  }
}

console.log('Running hardening regression tests...\n')
await testControlPlane()
await testControlPlaneRebinding()
await testTokenFileMode()
await testSessionStore()
await testRedactionAndDiscovery()
await testInstaller()
await testDiscoveryConfinement()
await testProviderKeyIsolation()
await testInstalledSourceMatchesTemplate()
await testDiscoveryKeepsInstallMetadata()
await testReinstallMergesEnvLocal()
await testLauncherReinstallsDepsWhenLockChanges()
await testKeptKeyIsReadByLauncher()
if (failed > 0) {
  console.error(`\n${failed} hardening check(s) failed`)
  process.exit(1)
}
console.log('\nHardening regression checks passed')
