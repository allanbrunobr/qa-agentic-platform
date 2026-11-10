/**
 * Regression checks for the 2026-11-09 review.
 * Run with: npx tsx packages/dashboard-api/src/hardening.regression.test.ts
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

async function listen(server: { listen: Function; address: Function; close: Function }, host = '127.0.0.1') {
  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing listen address')
  return address
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
  const { createPlatformApiServer } = await import('./server.ts')
  const { createPlatformWebServer } = await import('../../dashboard-web/src/server.ts')
  const api = await createPlatformApiServer({ token, webPort: 4177 })
  const web = await createPlatformWebServer({
    token,
    apiPort: 3101,
    webPort: 4177,
    defaultRepo: '"><img src=x onerror=alert(1)>',
  })
  const apiAddress = await listen(api.server)
  const webAddress = await listen(web.server)
  try {
    assert(apiAddress.address === '127.0.0.1', 'api binds to 127.0.0.1')
    assert(webAddress.address === '127.0.0.1', 'web binds to 127.0.0.1')
    const health = await request(apiAddress.port, { path: '/health' })
    assert(health.status === 200, 'health does not require a token')
    const missing = await request(apiAddress.port, { method: 'POST', path: '/api/install-local', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert(missing.status === 401, 'post without token is unauthorized')
    const evil = await request(apiAddress.port, { method: 'OPTIONS', path: '/api/install-local', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })
    assert(evil.status === 403 && !evil.headers.has('access-control-allow-origin'), 'foreign origin is not reflected')
    const localOrigin = await request(apiAddress.port, { method: 'OPTIONS', path: '/api/install-local', headers: { origin: 'http://127.0.0.1:4177', 'access-control-request-method': 'POST' } })
    assert(localOrigin.status === 204 && localOrigin.headers.get('access-control-allow-origin') === 'http://127.0.0.1:4177', 'local web origin is allowed')
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
    assert(web.html.includes('escapeHtml(execution.scenarioId)'), 'execution scenario id is escaped')
    assert(web.html.includes('escapeHtml(execution.hostProjectPath'), 'execution path is escaped')
    assert(!web.html.includes('+ execution.scenarioId +'), 'execution scenario id is not concatenated raw')
    assert(web.html.includes(`"authorization": "Bearer ${token}"`) === false, 'token is not logged as an object dump')
    assert(web.html.includes(token), 'dashboard page receives the local token')
    const outside = createNetServer()
    let publicBindFailed = false
    try {
      await new Promise<void>((resolve, reject) => {
        api.server.once('error', reject)
        // The server is already listening; this only documents the expected host.
        resolve()
      })
    } catch {
      publicBindFailed = true
    }
    outside.close()
    assert(publicBindFailed === false && apiAddress.address === '127.0.0.1', 'api address family stays loopback')
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
    await writeFile(path.join(unsafeRepo, '.agentic-qa', '.env.local'), 'echo PLANTED\n')
    let unsafeRefused = false
    try {
      await installLocalPackage({ repoPath: unsafeRepo })
    } catch (error) {
      unsafeRefused = error instanceof Error && error.message === 'refusing unsafe ANTHROPIC_API_KEY'
    }
    const unsafeEnv = await readFile(path.join(unsafeRepo, '.agentic-qa', '.env.local'), 'utf8')
    assert(unsafeRefused, 'install refuses an unsafe key')
    assert(!unsafeEnv.includes('bad;value') && !unsafeEnv.includes('PLANTED'), 'unsafe key and planted payload are not stored')
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

console.log('Running hardening regression tests...\n')
await testControlPlane()
await testTokenFileMode()
await testSessionStore()
await testRedactionAndDiscovery()
await testInstaller()
if (failed > 0) {
  console.error(`\n${failed} hardening check(s) failed`)
  process.exit(1)
}
console.log('\nHardening regression checks passed')
