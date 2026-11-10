import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultRuntimeTokenPath, ensureRuntimeToken, tokenFromHeaders, tokensMatch } from '../runtime-token.js'

const created: string[] = []
async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'runtime-token-'))
  created.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('ensureRuntimeToken', () => {
  it('creates a 64-hex token in a 0600 file and reuses it afterwards', async () => {
    const tokenPath = path.join(await tempDir(), 'data', 'runtime-api.token')
    const first = await ensureRuntimeToken(tokenPath)
    const second = await ensureRuntimeToken(tokenPath)

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(second).toBe(first)
    expect((await readFile(tokenPath, 'utf8')).trim()).toBe(first)
    if (process.platform !== 'win32') {
      expect((await lstat(tokenPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('creates different tokens for different runtimes', async () => {
    const a = await ensureRuntimeToken(path.join(await tempDir(), 'runtime-api.token'))
    const b = await ensureRuntimeToken(path.join(await tempDir(), 'runtime-api.token'))
    expect(a).not.toBe(b)
  })

  it('refuses an unusable token file instead of trusting it', async () => {
    const tokenPath = path.join(await tempDir(), 'runtime-api.token')
    await writeFile(tokenPath, 'password\n')
    await expect(ensureRuntimeToken(tokenPath)).rejects.toThrow(/unusable/)
  })

  it('refuses a token file that is a symlink', async () => {
    const dir = await tempDir()
    const outside = path.join(await tempDir(), 'elsewhere.token')
    await writeFile(outside, `${'ef'.repeat(32)}\n`)
    const tokenPath = path.join(dir, 'runtime-api.token')
    await symlink(outside, tokenPath)
    await expect(ensureRuntimeToken(tokenPath)).rejects.toThrow(/symlink/)
  })

  it('refuses a token folder that is a symlink', async () => {
    const outside = await tempDir()
    const runtime = await tempDir()
    await symlink(outside, path.join(runtime, 'data'))
    await expect(ensureRuntimeToken(path.join(runtime, 'data', 'runtime-api.token'))).rejects.toThrow(/symlink/)
    expect(await readdir(outside)).toEqual([])
  })

  it('keeps the token inside the runtime data folder, which the runtime .gitignore excludes', () => {
    const tokenPath = defaultRuntimeTokenPath({})
    expect(path.basename(path.dirname(tokenPath))).toBe('data')
    expect(defaultRuntimeTokenPath({ AGENTIC_QA_API_TOKEN_PATH: '/x/y.token' })).toBe('/x/y.token')
  })
})

describe('tokenFromHeaders and tokensMatch', () => {
  const token = 'ab'.repeat(32)

  it('reads x-agentic-token and Authorization: Bearer', () => {
    expect(tokenFromHeaders({ 'x-agentic-token': token })).toBe(token)
    expect(tokenFromHeaders({ authorization: `Bearer ${token}` })).toBe(token)
    expect(tokenFromHeaders({ authorization: `Basic ${token}` })).toBe('')
    expect(tokenFromHeaders({})).toBe('')
  })

  it('matches only the exact token', () => {
    expect(tokensMatch(token, token)).toBe(true)
    expect(tokensMatch('cd'.repeat(32), token)).toBe(false)
    expect(tokensMatch(token.slice(0, 63), token)).toBe(false)
    expect(tokensMatch('', token)).toBe(false)
    expect(tokensMatch('', '')).toBe(false)
  })
})
