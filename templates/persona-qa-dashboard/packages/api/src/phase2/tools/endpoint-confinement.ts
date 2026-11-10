import path from 'node:path'

const UNSAFE_ENDPOINT = /[\u0000-\u001F\\@]/

/** Keep a package.bin script inside the repository. Absolute and `../` paths are refused. */
export function confinePackageBin(repoRoot: string, bin: string | null | undefined): string | null {
  if (!bin || bin.includes('\0')) return null
  const root = path.resolve(repoRoot)
  const resolved = path.resolve(root, bin)
  const relative = path.relative(root, resolved)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved
}

/**
 * Resolve an endpoint against the configured base URL and refuse anything
 * whose origin, userinfo, or protocol differs. Protocol-relative paths,
 * backslashes, and userinfo are refused before `new URL` can retarget the host.
 */
export function confineEndpointUrl(endpointPath: string, baseUrl: string): string | null {
  if (!endpointPath || UNSAFE_ENDPOINT.test(endpointPath) || endpointPath.startsWith('//')) return null
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return null
  }
  if (base.username || base.password || (base.protocol !== 'http:' && base.protocol !== 'https:')) return null
  let url: URL
  try {
    url = new URL(endpointPath, base)
  } catch {
    return null
  }
  if (url.origin !== base.origin || url.username || url.password || url.protocol !== base.protocol) return null
  return url.toString()
}
