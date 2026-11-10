import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { phase2RunnerRoutes } from '../routes/runner.js'
import { setSessionService } from '../routes/sessions.js'
import { SessionService } from '../services/session-service.js'
import { parseExecutionContext, validateExecutionContext } from '../services/execution-context.js'
import { ToolRegistry } from '../services/tool-registry.js'
import { registerGeneratedAdapterTools } from '../tools/generated-adapter-tools.js'
import { resolveFindingScreenshotPath } from '../../services/screenshot-path.js'

// S-07: the QA browser followed absolute or protocol-relative route hints from the generated adapter
// to any host, and targetBaseUrl accepted any URL scheme. S-08: the finding screenshot route read
// any absolute path stored in the database. Both in docs/analise-20261109.md.

const BASE = 'http://127.0.0.1:4000'

function blankPage() {
  const visited: string[] = []
  return {
    visited,
    goto: async (url: string) => { visited.push(url) },
    url: () => 'about:blank',
  }
}

async function withCapabilities(capabilities: Array<{ id: string; routeHint: string }>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'route-confine-'))
  const file = path.join(dir, 'capabilities.generated.json')
  await writeFile(file, JSON.stringify(capabilities.map((capability) => ({ ...capability, purpose: capability.id }))))
  return { dir, file }
}

describe('S-07: browser navigation stays on the run target', () => {
  let dir = ''
  const previous = process.env.PERSONA_QA_CAPABILITIES_FILE

  beforeAll(async () => {
    const fixture = await withCapabilities([
      { id: 'openMetadata', routeHint: 'http://169.254.169.254/latest/meta-data/' },
      { id: 'openProtoRelative', routeHint: '//evil.example/x' },
      { id: 'openBackslash', routeHint: '/\\evil.example/x' },
      { id: 'openSameOrigin', routeHint: `${BASE}/orders` },
      { id: 'openCheckout', routeHint: '/checkout' },
    ])
    dir = fixture.dir
    process.env.PERSONA_QA_CAPABILITIES_FILE = fixture.file
  })
  afterAll(async () => {
    if (previous === undefined) delete process.env.PERSONA_QA_CAPABILITIES_FILE
    else process.env.PERSONA_QA_CAPABILITIES_FILE = previous
    await rm(dir, { recursive: true, force: true })
  })

  async function open(capability: string) {
    const registry = new ToolRegistry()
    registerGeneratedAdapterTools(registry)
    const page = blankPage()
    const result = await registry.execute(capability, {}, { browserAccess: true, allowedTools: [capability] }, {
      page,
      executionTarget: { baseUrl: BASE },
    })
    return { result, page }
  }

  it.each(['openMetadata', 'openProtoRelative', 'openBackslash'])('refuses %s without navigating', async (capability) => {
    const { result, page } = await open(capability)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('route_outside_target')
    expect(page.visited).toEqual([])
  })

  it('accepts a relative route and an absolute URL on the target origin', async () => {
    const relative = await open('openCheckout')
    const sameOrigin = await open('openSameOrigin')
    expect(relative.page.visited).toEqual([`${BASE}/checkout`])
    expect(sameOrigin.page.visited).toEqual([`${BASE}/orders`])
  })
})

describe('S-07: execution context accepts only http(s) targets', () => {
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'ftp://example.com'])('refuses targetBaseUrl %s', (url) => {
    expect(validateExecutionContext({ targetBaseUrl: url }).ok).toBe(false)
    expect(validateExecutionContext({ previewTargets: [{ role: 'frontend', url }] }).ok).toBe(false)
  })

  it('accepts http and https', () => {
    expect(parseExecutionContext({ targetBaseUrl: 'https://preview.example.com' })?.targetBaseUrl).toBe('https://preview.example.com')
    expect(validateExecutionContext({ targetBaseUrl: 'http://127.0.0.1:5173' }).ok).toBe(true)
  })

  it('answers 400 to a run with an invalid execution context instead of ignoring it', async () => {
    const keys = ['PERSONA_QA_USE_REFERENCE_SCENARIOS', 'AGENTIC_QA_FORCE_DETERMINISTIC_RUNTIME'] as const
    const saved = keys.map((key) => process.env[key])
    process.env.PERSONA_QA_USE_REFERENCE_SCENARIOS = '1'
    process.env.AGENTIC_QA_FORCE_DETERMINISTIC_RUNTIME = '1'
    setSessionService(new SessionService(':memory:'))
    const app = Fastify()
    await app.register(phase2RunnerRoutes)
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/p2/runs',
        payload: { scenario_id: 'first_order', execution_context: { targetBaseUrl: 'file:///etc/passwd' } },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('invalid_execution_context')
    } finally {
      await app.close()
      keys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key]
        else process.env[key] = saved[index]
      })
    }
  })
})

describe('S-08: finding screenshots are served only from inside the project', () => {
  let project = ''
  let outside = ''

  beforeAll(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'shot-project-'))
    outside = await mkdtemp(path.join(tmpdir(), 'shot-outside-'))
    await mkdir(path.join(project, 'test-results'), { recursive: true })
    await writeFile(path.join(project, 'test-results', 'failure.png'), 'png')
    await writeFile(path.join(project, 'test-results', 'notes.txt'), 'text')
    await writeFile(path.join(outside, 'id_ed25519.png'), 'secret')
    await symlink(path.join(outside, 'id_ed25519.png'), path.join(project, 'test-results', 'linked.png'))
  })
  afterAll(async () => {
    await rm(project, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('serves an image inside the project, given relative or absolute', async () => {
    expect(await resolveFindingScreenshotPath(project, 'test-results/failure.png')).toMatch(/failure\.png$/)
    expect(await resolveFindingScreenshotPath(project, path.join(project, 'test-results', 'failure.png'))).toMatch(/failure\.png$/)
  })

  it.each([
    ['an absolute path outside the project', () => path.join(outside, 'id_ed25519.png')],
    ['a relative path that climbs out', () => path.relative(project, path.join(outside, 'id_ed25519.png'))],
    ['a symlink inside the project pointing out', () => 'test-results/linked.png'],
    ['a non-image file', () => 'test-results/notes.txt'],
    ['a missing file', () => 'test-results/missing.png'],
  ])('refuses %s', async (_label, value) => {
    expect(await resolveFindingScreenshotPath(project, value())).toBeNull()
  })
})
