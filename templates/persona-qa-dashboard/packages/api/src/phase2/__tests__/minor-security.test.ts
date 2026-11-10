import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { personasRoutes } from '../../routes/personas.js'
import { ToolRegistry } from '../services/tool-registry.js'
import { registerGeneratedAdapterTools } from '../tools/generated-adapter-tools.js'

// S-14 (docs/analise-20261109.md), three of the minor security items.

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function withEnv(name: string, value: string) {
  const previous = process.env[name]
  process.env[name] = value
  cleanups.push(async () => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  })
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())))
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

describe('risk level of generated browser tools', () => {
  it('comes from the handler a capability gets, not from words in its name', async () => {
    const dir = await tempDir('risk-')
    const file = path.join(dir, 'capabilities.generated.json')
    // "verifyCheckout" contains "checkout", so it gets the submit handler; "verify" used to make it read-only.
    await writeFile(file, JSON.stringify([{ id: 'verifyCheckout', purpose: 'checkout' }, { id: 'verifyTotals', purpose: 'totals' }]))
    withEnv('PERSONA_QA_CAPABILITIES_FILE', file)

    const registry = new ToolRegistry()
    registerGeneratedAdapterTools(registry)

    expect(registry.getRiskLevel('verifyCheckout')).toBe('write')
    expect(registry.getRiskLevel('verifyTotals')).toBe('read')
    expect(registry.getRiskLevel('openPrimaryRoute')).toBe('read')
    expect(registry.getRiskLevel('submitOrder')).toBe('write')
  })
})

describe('generated API calls and redirects', () => {
  it('does not follow a redirect off the configured origin', async () => {
    const outsideHits: string[] = []
    const outside = await listen((request, response) => {
      outsideHits.push(request.url ?? '')
      response.end('secret')
    })
    const target = await listen((request, response) => {
      if (request.url === '/go-away') {
        response.writeHead(302, { location: `${outside.origin}/latest/meta-data` })
        response.end()
        return
      }
      if (request.url === '/moved') {
        response.writeHead(301, { location: '/orders' })
        response.end()
        return
      }
      response.end('orders')
    })
    const registry = new ToolRegistry()
    registerGeneratedAdapterTools(registry)
    const context = { executionTarget: { baseUrl: target.origin } }

    const offOrigin = await registry.execute('callPrimaryEndpoint', { path: '/go-away' }, { browserAccess: false, allowedTools: ['callPrimaryEndpoint'] }, context)
    expect(outsideHits).toEqual([])
    expect(offOrigin.ok && (offOrigin.output as { apiResponse: Record<string, unknown> }).apiResponse).toMatchObject({ executed: false, mode: 'refused' })

    const sameOrigin = await registry.execute('callPrimaryEndpoint', { path: '/moved' }, { browserAccess: false, allowedTools: ['callPrimaryEndpoint'] }, context)
    expect(sameOrigin.ok && (sameOrigin.output as { apiResponse: Record<string, unknown> }).apiResponse).toMatchObject({ executed: true, status: 200, url: `${target.origin}/orders` })
  })
})

describe('POST /api/personas', () => {
  it('does not overwrite a personas file it cannot read', async () => {
    const dir = await tempDir('personas-')
    const file = path.join(dir, 'personas.generated.json')
    const original = '{ "this is": "not a personas array" }'
    await writeFile(file, original)
    withEnv('PERSONA_QA_PERSONAS_FILE', file)
    const app = Fastify()
    await app.register(personasRoutes)
    cleanups.push(() => app.close())

    const response = await app.inject({
      method: 'POST',
      url: '/api/personas',
      payload: { name: 'Auditor', role: 'auditor', description: 'Checks totals', modules: ['verifyTotals'], color: '#123456' },
    })

    expect(response.statusCode).toBe(409)
    expect(await readFile(file, 'utf8')).toBe(original)
  })
})
