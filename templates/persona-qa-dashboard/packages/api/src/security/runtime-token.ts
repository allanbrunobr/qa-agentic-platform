import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Local API token for the generated runtime.
 *
 * The token lives in `<runtime>/data/runtime-api.token` (in an installed runtime:
 * `<repo>/.agentic-qa/data/runtime-api.token`). `data/` is in the runtime's .gitignore, the file is
 * created with mode 0600, and it is reused across restarts. The dashboard never sees it: the Vite
 * dev server reads it on the server side and adds it to proxied requests.
 */

export const RUNTIME_TOKEN_HEADER = 'x-agentic-token'
const TOKEN_PATTERN = /^[a-f0-9]{64}$/

const here = path.dirname(fileURLToPath(import.meta.url))
// packages/api/src/security -> runtime root (the template root, or .agentic-qa once installed)
const RUNTIME_ROOT = path.resolve(here, '../../../..')

export class RuntimeTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeTokenError'
  }
}

export function defaultRuntimeTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['AGENTIC_QA_API_TOKEN_PATH'] || path.join(RUNTIME_ROOT, 'data', 'runtime-api.token')
}

/** Creates the token file on first use (0600, never through a symlink) and returns the token. */
export async function ensureRuntimeToken(tokenPath: string = defaultRuntimeTokenPath()): Promise<string> {
  await fs.mkdir(path.dirname(tokenPath), { recursive: true })
  const existing = await fs.lstat(tokenPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing?.isSymbolicLink()) {
    throw new RuntimeTokenError(`refusing runtime token file ${tokenPath}: it is a symlink`)
  }
  if (!existing) {
    try {
      await fs.writeFile(tokenPath, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  await fs.chmod(tokenPath, 0o600)
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  if (!TOKEN_PATTERN.test(token)) {
    throw new RuntimeTokenError(`runtime token file ${tokenPath} is unusable; delete it to generate a new one`)
  }
  return token
}

/** Token from `x-agentic-token` or `Authorization: Bearer <token>`. Query strings are never read. */
export function tokenFromHeaders(headers: IncomingHttpHeaders): string {
  const header = headers[RUNTIME_TOKEN_HEADER]
  const direct = Array.isArray(header) ? header[0] : header
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const authorization = headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim())
    if (match?.[1]) return match[1]
  }
  return ''
}

/** Constant-time comparison. Different lengths fail before comparing, which leaks only the length. */
export function tokensMatch(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function assertUsableToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) throw new RuntimeTokenError('runtime API token must be 64 hex characters')
}
