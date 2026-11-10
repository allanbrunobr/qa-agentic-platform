// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http, { type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRuntimeApiProxy, readRuntimeToken } from '../runtime-api-proxy'

// Starts a real Vite dev server with the dashboard's proxy configuration in front of a fake API that
// records the headers it receives. If the proxy stops adding the token, these tests fail.

const TOKEN = 'ab'.repeat(32)

let workDir = ''
let tokenPath = ''
let api: http.Server
let vite: ViteDevServer
let viteUrl = ''
const seenHttp: IncomingHttpHeaders[] = []
const seenUpgrade: IncomingHttpHeaders[] = []

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'runtime-api-proxy-'))
  tokenPath = path.join(workDir, 'runtime-api.token')
  await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 })

  api = http.createServer((request, response) => {
    seenHttp.push(request.headers)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  api.on('upgrade', (request, socket) => {
    seenUpgrade.push(request.headers)
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', () => resolve()))
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`

  vite = await createServer({
    configFile: false,
    root: workDir,
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: createRuntimeApiProxy({ target: apiUrl, tokenPath }),
    },
  })
  await vite.listen()
  viteUrl = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`
}, 30_000)

afterAll(async () => {
  await vite?.close()
  await new Promise<void>((resolve) => api.close(() => resolve()))
  await rm(workDir, { recursive: true, force: true })
})

describe('dashboard proxy to the runtime API', () => {
  it('adds the local token to proxied HTTP requests', async () => {
    const response = await fetch(`${viteUrl}/api/status`)
    expect(response.status).toBe(200)
    expect(seenHttp.at(-1)?.['x-agentic-token']).toBe(TOKEN)
  })

  it('replaces a token sent by the browser with the one on disk', async () => {
    await fetch(`${viteUrl}/api/status`, { headers: { 'x-agentic-token': 'cd'.repeat(32) } })
    expect(seenHttp.at(-1)?.['x-agentic-token']).toBe(TOKEN)
  })

  it('adds the local token to the WebSocket upgrade', async () => {
    const before = seenUpgrade.length
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(`${viteUrl.replace(/^http/, 'ws')}/ws/runs/1`)
      socket.addEventListener('error', () => resolve())
      socket.addEventListener('close', () => resolve())
    })
    expect(seenUpgrade.length).toBe(before + 1)
    expect(seenUpgrade.at(-1)?.['x-agentic-token']).toBe(TOKEN)
  })
})

describe('readRuntimeToken', () => {
  it('returns null for a missing or malformed file', async () => {
    expect(readRuntimeToken(path.join(workDir, 'missing.token'))).toBeNull()
    const bad = path.join(workDir, 'bad.token')
    await writeFile(bad, 'not-a-token\n')
    expect(readRuntimeToken(bad)).toBeNull()
    expect(readRuntimeToken(tokenPath)).toBe(TOKEN)
  })
})
