import fs from 'node:fs'
import process from 'node:process'

// T-07 (docs/analise-20261109.md): the verifiers created fixtures under the system temp dir with a
// timestamp in the name and never removed them, about 350 MB per release-gate run. A fixture
// registered here is removed when the verifier's process exits, whether it passed or failed.
// KEEP_VERIFY_FIXTURES=1 keeps it for debugging; the path is printed so it can be found.
export function removeFixtureOnExit(dir, label = 'verify') {
  process.on('exit', () => {
    if (process.env.KEEP_VERIFY_FIXTURES === '1') {
      process.stderr.write(`[${label}] kept fixture ${dir} (KEEP_VERIFY_FIXTURES=1)\n`)
      return
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      process.stderr.write(`[${label}] could not remove fixture ${dir}\n`)
    }
  })
}
