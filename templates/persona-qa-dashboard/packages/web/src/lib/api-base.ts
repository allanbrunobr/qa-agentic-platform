// The dashboard talks to the runtime API through its own origin. The Vite dev server proxies /api
// and /ws to the API and adds the local API token on the server side
// (src/server/runtime-api-proxy.ts), so the token never reaches browser code and the browser never
// sends a cross-origin preflight.
export const API_BASE = ''

/** WebSocket base for the dashboard's own origin (ws: or wss:). */
export function wsBase(location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
}
