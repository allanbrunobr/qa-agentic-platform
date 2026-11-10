import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const tails = new Map<string, Promise<void>>()
const STALE_LOCK_MS = 30_000

/**
 * In-process queue plus a mkdir lock so two processes cannot lose a
 * read-modify-write. A lock older than 30s is removed so a crashed
 * writer does not block the file forever.
 */
export async function withExclusiveFileMutation<T>(filePath: string, mutate: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath)
  const previous = tails.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(async () => {
    const lockDir = `${key}.lock`
    await acquireLock(lockDir)
    try {
      return await mutate()
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
  const settled = run.then(() => undefined, () => undefined)
  tails.set(key, settled)
  return run
}

export async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  )
  await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, filePath)
}

async function acquireLock(lockDir: string): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      await fs.mkdir(lockDir)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await clearStaleLock(lockDir)
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for file lock: ${path.basename(lockDir)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }
}

async function clearStaleLock(lockDir: string): Promise<void> {
  try {
    const stat = await fs.stat(lockDir)
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
      await fs.rm(lockDir, { recursive: true, force: true })
    }
  } catch {
    // The lock disappeared between the failed mkdir and this check.
  }
}
