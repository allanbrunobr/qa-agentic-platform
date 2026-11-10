import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * File operations confined to `<repo>/.agentic-qa`.
 *
 * The target repository is untrusted (ADR 0004). It can commit symlinks anywhere, including inside
 * `.agentic-qa/`. Plain `fs.mkdir`, `fs.readdir`, `fs.writeFile` and `fs.rm` follow those symlinks, so
 * discovery could delete or overwrite files outside the repository. Every operation here:
 *
 * - resolves the repository with `realpath` once, and works under `<realRepo>/.agentic-qa`;
 * - walks every directory segment with `lstat` and refuses a segment that is a symlink or not a
 *   directory, creating missing segments one at a time;
 * - opens files with `O_NOFOLLOW` (where the platform has it) and refuses an existing symlink;
 * - reads repository sources without following symlinks and only inside the real repository.
 *
 * Refusals throw `LocalConfinementError`: discovery fails closed instead of writing somewhere else.
 *
 * Out of scope: a process running as the same user that swaps a directory for a symlink between the
 * check and the write. That process can already write those files itself.
 */

export class LocalConfinementError extends Error {
  /** Read by the control-plane server to answer 409 instead of 500. */
  readonly statusCode = 409
  readonly code = 'local_confinement_refused'

  constructor(message: string) {
    super(message)
    this.name = 'LocalConfinementError'
  }
}

const LOCAL_DIRNAME = '.agentic-qa'
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const WRITE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export class ConfinedLocalFs {
  private constructor(
    readonly repoRoot: string,
    readonly localRoot: string,
  ) {}

  /** Resolves the repository and makes sure `<repo>/.agentic-qa` is a real directory inside it. */
  static async open(repoPath: string): Promise<ConfinedLocalFs> {
    if (!repoPath || repoPath.includes('\0')) throw new LocalConfinementError('repoPath is required')
    let repoRoot: string
    try {
      repoRoot = await fs.realpath(repoPath)
    } catch {
      throw new LocalConfinementError('repoPath must be an existing directory')
    }
    const confined = new ConfinedLocalFs(repoRoot, path.join(repoRoot, LOCAL_DIRNAME))
    await confined.ensureDir(confined.localRoot)
    return confined
  }

  private relativeLabel(target: string): string {
    return path.relative(this.repoRoot, target) || '.'
  }

  private assertUnderLocalRoot(target: string): string {
    const resolved = path.resolve(target)
    if (!isInside(this.localRoot, resolved)) {
      throw new LocalConfinementError(`refusing to touch ${resolved}: outside ${this.localRoot}`)
    }
    return resolved
  }

  /**
   * Creates `dirPath` (under `.agentic-qa`) one segment at a time. Every existing segment from the
   * repository root down must be a real directory, not a symlink.
   */
  async ensureDir(dirPath: string): Promise<void> {
    const resolved = this.assertUnderLocalRoot(dirPath)
    const segments = path.relative(this.repoRoot, resolved).split(path.sep).filter(Boolean)
    let current = this.repoRoot
    for (const segment of segments) {
      current = path.join(current, segment)
      const stat = await lstatOrNull(current)
      if (!stat) {
        try {
          await fs.mkdir(current)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        const created = await fs.lstat(current)
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw new LocalConfinementError(`refusing ${this.relativeLabel(current)}: not a real directory`)
        }
        continue
      }
      if (stat.isSymbolicLink()) {
        throw new LocalConfinementError(`refusing ${this.relativeLabel(current)}: it is a symlink`)
      }
      if (!stat.isDirectory()) {
        throw new LocalConfinementError(`refusing ${this.relativeLabel(current)}: not a directory`)
      }
    }
  }

  /** Writes a file under `.agentic-qa`, refusing symlinked parents and a symlinked target. */
  async writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
    const resolved = this.assertUnderLocalRoot(filePath)
    await this.ensureDir(path.dirname(resolved))
    const existing = await lstatOrNull(resolved)
    if (existing?.isSymbolicLink()) {
      throw new LocalConfinementError(`refusing to write ${this.relativeLabel(resolved)}: it is a symlink`)
    }
    if (existing && !existing.isFile()) {
      throw new LocalConfinementError(`refusing to write ${this.relativeLabel(resolved)}: not a regular file`)
    }
    let handle: Awaited<ReturnType<typeof fs.open>>
    try {
      handle = await fs.open(resolved, WRITE_FLAGS, 0o644)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new LocalConfinementError(`refusing to write ${this.relativeLabel(resolved)}: it is a symlink`)
      }
      throw error
    }
    try {
      await handle.writeFile(content, typeof content === 'string' ? 'utf8' : undefined)
    } finally {
      await handle.close()
    }
  }

  /**
   * Removes regular files whose names contain `marker` from a directory under `.agentic-qa`.
   * A missing directory is fine. A symlinked directory is refused, never followed.
   */
  async removeFilesContaining(dirPath: string, marker: string): Promise<void> {
    const resolved = this.assertUnderLocalRoot(dirPath)
    const stat = await lstatOrNull(resolved)
    if (!stat) return
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new LocalConfinementError(`refusing to clean ${this.relativeLabel(resolved)}: not a real directory`)
    }
    // Parents must be real directories too, or the lstat above looked at a path reached through a link.
    await this.ensureDir(resolved)
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    for (const entry of entries) {
      // Dirent.isFile() is false for symlinks, so a planted link is left alone and never followed.
      if (!entry.isFile() || !entry.name.includes(marker)) continue
      await fs.rm(path.join(resolved, entry.name), { force: true })
    }
  }

  /**
   * Copies a directory tree from the repository into `.agentic-qa` without following symlinks on
   * either side. A missing or symlinked source is skipped. Paths are relative to the repository root
   * (`relativeSource`) and to `.agentic-qa` (`relativeTarget`). Returns the written paths, relative
   * to `.agentic-qa`.
   */
  async copyTreeFromRepo(relativeSource: string, relativeTarget: string): Promise<string[]> {
    const copied = await this.copyTree(
      path.resolve(this.repoRoot, relativeSource),
      path.resolve(this.localRoot, relativeTarget),
    )
    return copied.map((written) => path.relative(this.localRoot, written))
  }

  private async copyTree(sourceDir: string, targetDir: string): Promise<string[]> {
    const source = path.resolve(sourceDir)
    if (!isInside(this.repoRoot, source)) {
      throw new LocalConfinementError(`refusing to copy from ${source}: outside the repository`)
    }
    const sourceStat = await lstatOrNull(source)
    if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) return []
    // Every ancestor of the source must be a real directory as well.
    let realSource: string
    try {
      realSource = await fs.realpath(source)
    } catch {
      return []
    }
    if (realSource !== source) return []

    const copied: string[] = []
    const entries = await fs.readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      const from = path.join(source, entry.name)
      const to = path.join(targetDir, entry.name)
      if (entry.isDirectory()) {
        copied.push(...await this.copyTree(from, to))
      } else if (entry.isFile()) {
        await this.writeFile(to, await fs.readFile(from))
        copied.push(path.resolve(to))
      }
    }
    return copied
  }
}
