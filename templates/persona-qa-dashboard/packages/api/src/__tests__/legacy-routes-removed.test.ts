import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { closeDb, initDb } from '../db/index.js'

// A-04 (docs/analise-20261109.md): the legacy run model stayed registered next to the agentic one.
// POST /api/runs spawned `pnpm test:persona-qa` in the project directory, a command from the old
// monorepo, and the pages that read these routes were not reachable from the dashboard. The routes are
// gone; the read endpoints the dashboard still uses stay. Built with the real buildApp, so a route that
// is still registered answers here.

const TOKEN = 'ab'.repeat(32)
const HEADERS = { host: '127.0.0.1:3201', 'x-agentic-token': TOKEN }

beforeAll(() => {
  process.env['DATABASE_URL'] = ':memory:'
  initDb()
})
afterAll(() => { closeDb() })

describe('A-04: legacy run routes are not registered', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeAll(async () => { app = await buildApp({ logger: false, env: { NODE_ENV: 'test' }, token: TOKEN }) })
  afterAll(async () => { await app.close() })

  it.each([
    ['POST', '/api/runs'],
    ['GET', '/api/runs'],
    ['GET', '/api/runs/1'],
    ['GET', '/api/runs/1/timeline'],
    ['GET', '/api/runs/sources'],
    ['GET', '/api/runs/export'],
    ['GET', '/api/scenarios'],
    ['GET', '/api/scenarios/checkout'],
    ['GET', '/api/findings'],
    ['GET', '/api/findings/1/screenshot'],
    ['GET', '/ws/runs/1'],
  ] as const)('%s %s has no route', async (method, url) => {
    const response = await app.inject({
      method,
      url,
      headers: { ...HEADERS, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { payload: '{}' } : {}),
    })
    // Fastify's own not-found answer: a legacy handler that answers 404 for an unknown id is not enough.
    expect(response.statusCode).toBe(404)
    expect(response.json().message).toBe(`Route ${method}:${url} not found`)
  })

  it.each(['/api/stats', '/api/insights', '/api/status', '/api/suite-health', '/api/personas', '/api/p2/sessions', '/api/p2/scenarios'])(
    'keeps GET %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url, headers: HEADERS })
      expect(response.statusCode).toBe(200)
    },
  )
})
