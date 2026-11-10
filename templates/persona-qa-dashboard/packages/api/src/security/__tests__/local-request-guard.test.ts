import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { buildApp } from '../../app.js'
import { closeDb, initDb } from '../../db/index.js'
import { hostnameFromHostHeader, isAllowedHost } from '../local-request-guard.js'

// These tests build the real application (the same buildApp the launcher starts) so that a route
// registered without the guard, or a guard registered after CORS, fails here.

const WEB_ORIGIN = 'http://127.0.0.1:5176'
const ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
const TOKEN = 'ab'.repeat(32)
const WRONG_TOKEN = 'cd'.repeat(32)
const AUTH = { 'x-agentic-token': TOKEN }

// Some route plugins touch the database while registering (routes/sync.ts creates its meta table).
beforeAll(() => {
  process.env['DATABASE_URL'] = ':memory:'
  initDb()
})
afterAll(() => { closeDb() })

type App = Awaited<ReturnType<typeof buildApp>>

function testApp(env: NodeJS.ProcessEnv = ENV) {
  return buildApp({ logger: false, env, token: TOKEN })
}

describe('local request guard: Host header (DNS rebinding)', () => {
  let app: App
  beforeAll(async () => { app = await testApp() })
  afterAll(async () => { await app.close() })

  it.each(['127.0.0.1:3201', 'localhost:3201', '[::1]:3201', 'LOCALHOST', '127.0.0.1'])('accepts loopback Host %s', async (host) => {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { host } })
    expect(response.statusCode).toBe(200)
  })

  it.each(['evil.example', 'evil.example:3201', '127.0.0.1.evil.example', 'localhost.evil.example:3201', '192.168.0.10:3201'])(
    'rejects foreign Host %s before any handler runs',
    async (host) => {
      const response = await app.inject({ method: 'GET', url: '/health', headers: { host } })
      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({ error: 'host_not_allowed' })
    },
  )

  it('rejects a state-changing request that arrives under a rebound domain, even with the token', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings/runtime',
      headers: { host: 'evil.example:3201', 'content-type': 'application/json', ...AUTH },
      payload: JSON.stringify({ provider: 'openai' }),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'host_not_allowed' })
  })

  it('rejects a run start under a rebound domain even with a valid-looking body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/p2/runs',
      headers: { host: 'evil.example', 'content-type': 'application/json' },
      payload: JSON.stringify({ scenario_id: 'x', execution_context: { targetBaseUrl: 'file:///etc/passwd' } }),
    })
    expect(response.statusCode).toBe(403)
  })

  it('honours AGENTIC_QA_ALLOWED_HOSTS for an explicitly configured name', async () => {
    const custom = await testApp({ ...ENV, AGENTIC_QA_ALLOWED_HOSTS: 'qa-box.internal' })
    try {
      const allowed = await custom.inject({ method: 'GET', url: '/health', headers: { host: 'qa-box.internal:3201' } })
      const rejected = await custom.inject({ method: 'GET', url: '/health', headers: { host: 'other.internal:3201' } })
      expect(allowed.statusCode).toBe(200)
      expect(rejected.statusCode).toBe(403)
    } finally {
      await custom.close()
    }
  })
})

describe('local request guard: Origin header (cross-site requests)', () => {
  let app: App
  beforeAll(async () => { app = await testApp() })
  afterAll(async () => { await app.close() })

  it('rejects a cross-site POST before the handler runs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/p2/runs',
      headers: { host: '127.0.0.1:3201', origin: 'http://evil.example', 'content-type': 'text/plain' },
      payload: '{"scenario_id":"x"}',
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'origin_not_allowed' })
  })

  it('rejects a cross-site preflight', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/settings/runtime',
      headers: {
        host: '127.0.0.1:3201',
        origin: 'http://evil.example',
        'access-control-request-method': 'PATCH',
      },
    })
    expect(response.statusCode).toBe(403)
  })

  it('rejects the opaque "null" origin used by sandboxed frames', async () => {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { host: 'localhost:3201', origin: 'null' } })
    expect(response.statusCode).toBe(403)
  })

  it('lets the local dashboard origin with the token reach the handler', async () => {
    // The body is invalid on purpose: a 400 from the route's own validation proves the guard let it through.
    const response = await app.inject({
      method: 'POST',
      url: '/api/p2/runs',
      headers: { host: 'localhost:3201', origin: WEB_ORIGIN, 'content-type': 'application/json', ...AUTH },
      payload: JSON.stringify({}),
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('invalid_body')
    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN)
  })

  it('answers the local dashboard preflight that carries the token', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/settings/runtime',
      headers: { host: 'localhost:3201', origin: WEB_ORIGIN, 'access-control-request-method': 'PATCH', ...AUTH },
    })
    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN)
  })

  it('lets a non-browser client without Origin through when it has the token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/p2/scenarios/none/workflow-contract', headers: { host: '127.0.0.1:3201', ...AUTH } })
    expect(response.statusCode).not.toBe(401)
    expect(response.statusCode).not.toBe(403)
  })
})

describe('local request guard: API token', () => {
  let app: App
  beforeAll(async () => { app = await testApp() })
  afterAll(async () => { await app.close() })

  const loopback = { host: '127.0.0.1:3201' }

  it('rejects a read without the token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings/runtime', headers: loopback })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'unauthorized' })
  })

  it('rejects a run start without the token, from the dashboard origin too', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/p2/runs',
      headers: { ...loopback, origin: WEB_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect(response.statusCode).toBe(401)
  })

  it('rejects a wrong token of the right length', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings/runtime', headers: { ...loopback, 'x-agentic-token': WRONG_TOKEN } })
    expect(response.statusCode).toBe(401)
  })

  it.each([TOKEN.slice(0, 63), `${TOKEN}0`, '', ' '])('rejects a malformed token %j', async (value) => {
    const response = await app.inject({ method: 'GET', url: '/api/settings/runtime', headers: { ...loopback, 'x-agentic-token': value } })
    expect(response.statusCode).toBe(401)
  })

  it('never reads the token from the query string', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/settings/runtime?token=${TOKEN}`, headers: loopback })
    expect(response.statusCode).toBe(401)
  })

  it('accepts the token as Authorization: Bearer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/p2/runs',
      headers: { ...loopback, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect(response.statusCode).toBe(400)
  })

  it('requires the token on the preflight as well', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/settings/runtime',
      headers: { ...loopback, origin: WEB_ORIGIN, 'access-control-request-method': 'PATCH' },
    })
    expect(response.statusCode).toBe(401)
  })

  it.each(['GET', 'HEAD'] as const)('leaves %s /health open for liveness probes', async (method) => {
    const response = await app.inject({ method, url: '/health', headers: loopback })
    expect(response.statusCode).toBe(200)
  })

  it('does not treat other /health methods or paths as open', async () => {
    const post = await app.inject({ method: 'POST', url: '/health', headers: loopback })
    const nested = await app.inject({ method: 'GET', url: '/health/../api/settings/runtime', headers: loopback })
    expect(post.statusCode).toBe(401)
    expect(nested.statusCode).toBe(401)
  })

  it('refuses to build without a usable token', async () => {
    await expect(buildApp({ logger: false, env: ENV, token: 'short' })).rejects.toThrow(/64 hex/)
  })
})

describe('local request guard: WebSocket upgrade', () => {
  let app: App
  let port = 0
  beforeAll(async () => {
    app = await testApp()
    await app.listen({ host: '127.0.0.1', port: 0 })
    port = (app.server.address() as AddressInfo).port
  })
  afterAll(async () => { await app.close() })

  // Resolves with the HTTP status of the upgrade. An accepted socket is left to the route, which closes
  // it (unknown run id); waiting for that close keeps app.close() from hanging on a half-closed socket.
  function upgradeStatus(headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      let status = 0
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/runs/1`, { headers })
      socket.on('upgrade', (response) => { status = response.statusCode ?? 0 })
      socket.on('close', () => resolve(status))
      socket.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0)
        socket.terminate()
      })
      socket.on('error', (error) => { if (status === 0) reject(error) })
    })
  }

  it('rejects an upgrade from a cross-site page', async () => {
    expect(await upgradeStatus({ origin: 'http://evil.example', ...AUTH })).toBe(403)
  })

  it('rejects an upgrade under a rebound domain', async () => {
    expect(await upgradeStatus({ host: `evil.example:${port}`, origin: `http://evil.example:${port}`, ...AUTH })).toBe(403)
  })

  it('rejects an upgrade from the local dashboard without the token', async () => {
    expect(await upgradeStatus({ origin: WEB_ORIGIN })).toBe(401)
  })

  it('accepts an upgrade from the local dashboard with the token', async () => {
    expect(await upgradeStatus({ origin: WEB_ORIGIN, ...AUTH })).toBe(101)
  })
})

describe('hostnameFromHostHeader', () => {
  it.each([
    ['127.0.0.1:3201', '127.0.0.1'],
    ['LocalHost:80', 'localhost'],
    ['[::1]:3201', '[::1]'],
    ['[::1]', '[::1]'],
    ['evil.example', 'evil.example'],
  ])('parses %s', (input, expected) => {
    expect(hostnameFromHostHeader(input)).toBe(expected)
  })

  it.each([undefined, '', 'a b', 'user@127.0.0.1', '127.0.0.1:port', '[::1]x', '[::1'])('refuses malformed %s', (input) => {
    expect(hostnameFromHostHeader(input)).toBeNull()
    expect(isAllowedHost(input)).toBe(false)
  })
})
