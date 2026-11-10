import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import path from 'node:path'
import { DATA_DIR } from './config/platform-paths.ts'

/** The control plane has no bind override. It listens only on loopback. */
export const CONTROL_PLANE_HOST = '127.0.0.1'
export const MAX_CONTROL_PLANE_BODY_BYTES = 1_048_576

export function controlPlaneTokenPath(): string {
  return process.env.AGENTIC_CONTROL_PLANE_TOKEN_PATH
    || path.join(DATA_DIR, 'control-plane.token')
}

export function allowedWebOrigins(webPort: number): string[] {
  return [
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${webPort}`,
  ]
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * True when the Host header names loopback. A DNS-rebinding page reaches 127.0.0.1 under its own
 * domain name, so its requests carry that domain here; refusing them keeps the dashboard page (which
 * embeds the token) and the API out of its reach.
 */
export function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim().toLowerCase()
  const match = /^(\[::1\]|[a-z0-9.-]+)(?::\d{1,5})?$/.exec(trimmed)
  return Boolean(match?.[1] && LOOPBACK_HOSTNAMES.has(match[1]))
}

export async function ensureControlPlaneToken(tokenPath = controlPlaneTokenPath()): Promise<string> {
  await fs.mkdir(path.dirname(tokenPath), { recursive: true })
  const created = randomBytes(32).toString('hex')
  try {
    await fs.writeFile(tokenPath, `${created}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await fs.chmod(tokenPath, 0o600)
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('control plane token file is unusable')
  }
  return token
}

export function tokenFromRequest(headers: IncomingHttpHeaders): string {
  const header = headers['x-agentic-token']
  const direct = Array.isArray(header) ? header[0] : header
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const authorization = headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim())
    if (match?.[1]) return match[1]
  }
  return ''
}

export function tokensMatch(presented: string, expected: string): boolean {
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export class ControlPlaneError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string) {
    super(code)
    this.name = 'ControlPlaneError'
    this.statusCode = statusCode
    this.code = code
  }
}

export async function readJsonBody(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_CONTROL_PLANE_BODY_BYTES) {
      throw new ControlPlaneError(413, 'payload_too_large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ControlPlaneError(400, 'invalid_json')
  }
}
