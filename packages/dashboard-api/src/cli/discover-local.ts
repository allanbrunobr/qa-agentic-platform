import { runBootstrap } from '../services/discovery-service.ts'
import { DiscoveryValidationError } from '../services/domain-specialist-service.ts'
import { materializeLocalDiscovery } from '../services/local-discovery-materializer.ts'

export async function runDiscoverLocalCommand(args: string[]) {
  const repoPath = args[0]
  const adapterHint = args[1]
  if (!repoPath) {
    throw new Error('discover-local requires <repoPath> [adapterHint]')
  }

  try {
    const bootstrap = await runBootstrap({ repoPath, adapterHint })
    const local = await materializeLocalDiscovery({
      repoPath,
      report: bootstrap.report,
      draft: bootstrap.draft,
    })

    process.stdout.write(`${JSON.stringify({ ...bootstrap, ...local }, null, 2)}\n`)
  } catch (error) {
    if (error instanceof DiscoveryValidationError) {
      process.stderr.write(`${JSON.stringify({ error: error.code, message: error.message })}\n`)
      process.exitCode = 1
      return
    }
    throw error
  }
}
