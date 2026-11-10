import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Guard for the local runtime API.
 *
 * The API listens on loopback and has no user accounts. The realistic attacker is a web page in the
 * developer's browser. Two checks stop it:
 *
 * - Host: a DNS-rebinding page reaches 127.0.0.1 under its own domain name, so its requests carry
 *   that domain in the Host header. Only loopback names are accepted.
 * - Origin: a cross-site page cannot hide its Origin on requests that change state. CORS alone only
 *   withholds the response headers; the handler still runs. This guard rejects the request before
 *   any handler runs, for every method, including the WebSocket upgrade.
 *
 * Requests without an Origin header (curl, scripts, server-side fetch) are allowed when the Host is
 * loopback. A process on the same machine can already read the runtime's files.
 */

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export const DEFAULT_WEB_PORT = 5176

export function localWebOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set([
    `http://127.0.0.1:${DEFAULT_WEB_PORT}`,
    `http://localhost:${DEFAULT_WEB_PORT}`,
    ...(env['AGENTIC_QA_WEB_ORIGIN'] ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
  ])
}

export function extraAllowedHostnames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env['AGENTIC_QA_ALLOWED_HOSTS'] ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  )
}

/** Returns the hostname of a Host header value, lowercased, without the port. IPv6 keeps brackets. */
export function hostnameFromHostHeader(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return null
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return null
    const rest = trimmed.slice(end + 1)
    if (rest && !/^:\d{1,5}$/.test(rest)) return null
    return trimmed.slice(0, end + 1)
  }
  const match = /^([a-z0-9.-]+)(?::\d{1,5})?$/.exec(trimmed)
  return match?.[1] ?? null
}

export function isAllowedHost(value: string | undefined, extraHostnames: Set<string> = new Set()): boolean {
  const hostname = hostnameFromHostHeader(value)
  if (!hostname) return false
  return LOOPBACK_HOSTNAMES.has(hostname) || extraHostnames.has(hostname)
}

export interface LocalRequestGuardOptions {
  allowedOrigins: Set<string>
  extraHostnames?: Set<string>
}

export function registerLocalRequestGuard(app: FastifyInstance, options: LocalRequestGuardOptions): void {
  const extraHostnames = options.extraHostnames ?? new Set<string>()

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAllowedHost(request.headers.host, extraHostnames)) {
      return reply.code(403).send({ error: 'host_not_allowed' })
    }

    const origin = request.headers.origin
    if (typeof origin === 'string' && origin.length > 0 && !options.allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: 'origin_not_allowed' })
    }
  })
}
