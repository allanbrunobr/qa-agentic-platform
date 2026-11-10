import fs from 'node:fs'
import type { ClientRequest } from 'node:http'
import type { ProxyOptions } from 'vite'

/**
 * Dev-server proxy from the dashboard to the runtime API.
 *
 * Runs in Node, inside the Vite dev server, never in the browser. It forwards /api and /ws to the API
 * and sets the local API token header on every proxied request, including the WebSocket upgrade.
 * The token is read from the runtime's data/ folder on each request, so a token created by the API
 * after the dev server started is picked up.
 *
 * Why this is safe: the dev server listens on 127.0.0.1 and Vite rejects foreign Host headers; the
 * proxy keeps the browser's Origin header, and the API rejects any Origin other than the dashboard.
 */

export const RUNTIME_TOKEN_HEADER = 'x-agentic-token'
const TOKEN_PATTERN = /^[a-f0-9]{64}$/

export function readRuntimeToken(tokenPath: string): string | null {
  try {
    const token = fs.readFileSync(tokenPath, 'utf8').trim()
    return TOKEN_PATTERN.test(token) ? token : null
  } catch {
    return null
  }
}

interface ProxyEvents {
  on(event: 'proxyReq' | 'proxyReqWs', listener: (proxyReq: ClientRequest) => void): unknown
}

/** Adds the token to every outgoing proxied request. Exported for tests. */
export function attachRuntimeToken(proxy: ProxyEvents, tokenPath: string): void {
  const addToken = (proxyReq: ClientRequest) => {
    // Whatever the browser sent is replaced: the only valid value is the one on disk.
    proxyReq.removeHeader(RUNTIME_TOKEN_HEADER)
    const token = readRuntimeToken(tokenPath)
    if (token) proxyReq.setHeader(RUNTIME_TOKEN_HEADER, token)
  }
  proxy.on('proxyReq', addToken)
  proxy.on('proxyReqWs', addToken)
}

export function createRuntimeApiProxy(options: { target: string; tokenPath: string }): Record<string, ProxyOptions> {
  const configure: ProxyOptions['configure'] = (proxy) => attachRuntimeToken(proxy as unknown as ProxyEvents, options.tokenPath)
  return {
    '/api': { target: options.target, changeOrigin: true, configure },
    '/ws': { target: options.target.replace(/^http/, 'ws'), ws: true, changeOrigin: true, configure },
  }
}
