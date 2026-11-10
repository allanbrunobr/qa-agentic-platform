import { upgradeLocalPackage } from '../services/local-package-upgrader.ts'

export async function runUpgradeLocalCommand(args: string[]) {
  const repoPath = args[0]
  if (!repoPath) {
    throw new Error('upgrade-local requires <repoPath>')
  }

  const result = await upgradeLocalPackage({ repoPath })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
