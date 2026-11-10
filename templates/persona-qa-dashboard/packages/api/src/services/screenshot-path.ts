import { promises as fs } from 'node:fs'
import path from 'node:path'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/**
 * Resolves a finding's screenshot_path to a file that may be served (S-08 in
 * docs/analise-20261109.md). screenshot_path comes from synced findings JSON, which the target
 * repository or its test suite can write, so it is not trusted:
 * - relative paths resolve against the project directory, absolute ones are taken as given;
 * - the REAL path (symlinks resolved) must stay inside the real project directory;
 * - only image files are served.
 * Returns null when the file must not be served.
 */
export async function resolveFindingScreenshotPath(projectDir: string, screenshotPath: string): Promise<string | null> {
  if (!screenshotPath || screenshotPath.includes('\0')) return null
  if (!IMAGE_EXTENSIONS.has(path.extname(screenshotPath).toLowerCase())) return null

  let realProject: string
  let realFile: string
  try {
    realProject = await fs.realpath(projectDir)
    realFile = await fs.realpath(path.resolve(projectDir, screenshotPath))
  } catch {
    return null
  }

  const relative = path.relative(realProject, realFile)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  if (!IMAGE_EXTENSIONS.has(path.extname(realFile).toLowerCase())) return null
  const stat = await fs.stat(realFile).catch(() => null)
  return stat?.isFile() ? realFile : null
}
