import { runBootstrapCommand } from './cli/bootstrap.ts'
import { runDiscoverCommand } from './cli/discover.ts'
import { runReviewCommand } from './cli/review.ts'
import { runInstallLocalCommand } from './cli/install-local.ts'
import { runDiscoverLocalCommand } from './cli/discover-local.ts'
import { runUpgradeLocalCommand } from './cli/upgrade-local.ts'

const [, , command, ...args] = process.argv
const repoPath = args[0]

if (!command || !repoPath) {
  console.error('Usage: node packages/dashboard-api/src/cli.ts <discover|bootstrap|review|install-local|upgrade-local|discover-local> <repoPath>')
  process.exit(1)
}

if (command === 'discover') {
  await runDiscoverCommand(args)
} else if (command === 'bootstrap') {
  await runBootstrapCommand(args)
} else if (command === 'review') {
  await runReviewCommand(repoPath)
} else if (command === 'install-local') {
  await runInstallLocalCommand(args)
} else if (command === 'upgrade-local') {
  await runUpgradeLocalCommand(args)
} else if (command === 'discover-local') {
  await runDiscoverLocalCommand(args)
} else {
  console.error(`Unknown command: ${command}`)
  process.exit(1)
}
