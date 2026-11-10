import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { removeFixtureOnExit } from './lib/temp-fixture.mjs'
import { isolatedProviderEnv } from './lib/provider-isolation.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const fixtureRoot = path.join(os.tmpdir(), `agentic-platform-generic-runtime-fixtures-${Date.now()}`)
const tsxLoaderCandidates = [
  path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs'),
  path.join(repoRoot, 'templates/persona-qa-dashboard/node_modules/tsx/dist/loader.mjs'),
]
const tsxLoader = tsxLoaderCandidates.find((candidate) => fs.existsSync(candidate))
const preferredNodeBin = process.env.AGENTIC_RELEASE_NODE_BIN
  ?? path.dirname(process.execPath)
const preferredNodePath = path.join(preferredNodeBin, 'node')
const nodePath = fs.existsSync(preferredNodePath) ? preferredNodePath : process.execPath
const verificationEnv = {
  ...process.env,
  PATH: fs.existsSync(preferredNodePath)
    ? `${preferredNodeBin}${path.delimiter}${process.env.PATH ?? ''}`
    : process.env.PATH,
  ...isolatedProviderEnv(),
}

// Ensure the host-local runtime template has its dependencies (better-sqlite3 etc.)
// so that `install-local` + materialized .agentic-qa can execute without host machine state.
const templateDir = path.join(repoRoot, 'templates/persona-qa-dashboard')
const templateNodeModules = path.join(templateDir, 'node_modules')
if (!fs.existsSync(templateNodeModules) && fs.existsSync(path.join(templateDir, 'package.json'))) {
  log('pre-installing template deps (required for generic runtime verification reproducibility)...')
  const install = spawnSync('npm', ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], {
    cwd: templateDir,
    stdio: 'inherit',
    env: process.env,
  })
  if (install.status !== 0) {
    log('warning: template npm install returned non-zero (continuing; may affect some verifiers)')
  }
}

function log(message) {
  process.stdout.write(`[verify-generic-runtime-execution] ${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function writeFile(fixtureName, relativePath, content) {
  const filePath = path.join(fixtureRoot, fixtureName, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function createFixtures() {
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
  fs.mkdirSync(fixtureRoot, { recursive: true })
  removeFixtureOnExit(fixtureRoot, 'verify-generic-runtime-execution')

  writeFile('backend-api', 'package.json', `${JSON.stringify({
    name: 'generic-backend-api-runtime-fixture',
    private: true,
    type: 'module',
    scripts: {
      'dev:api': 'tsx src/server.ts',
      test: 'node --test',
    },
    dependencies: {
      express: '^latest',
    },
  }, null, 2)}\n`)
  writeFile('backend-api', 'src/server.ts', `import express from 'express'
import accountsRouter from './routes/accounts.js'

const app = express()
app.get('/health', (_request, response) => response.json({ status: 'ok' }))
app.use('/api', accountsRouter)
app.listen(3000)
`)
  writeFile('backend-api', 'src/routes/accounts.ts', `import { Router } from 'express'
import { listAccounts } from '../controllers/accounts.js'

const router = Router()

router.get('/accounts', listAccounts)

export default router
`)
  writeFile('backend-api', 'src/controllers/accounts.ts', `import type { Request, Response } from 'express'
import accountsService from '../services/accounts.js'

export function listAccounts(_request: Request, response: Response) {
  response.json(accountsService.buildAccountsPayload())
}
`)
  writeFile('backend-api', 'src/services/accounts.ts', `const accountsService = {
  buildAccountsPayload() {
    return [{ id: 'acct_1' }]
  },
}

export default accountsService
`)

  writeFile('cli-tool', 'package.json', `${JSON.stringify({
    name: 'generic-cli-runtime-fixture',
    private: true,
    type: 'module',
    bin: {
      'generic-cli': './bin/generic-cli.js',
    },
  }, null, 2)}\n`)
  writeFile('cli-tool', 'bin/generic-cli.js', `#!/usr/bin/env node
console.log('generic-cli help')
`)

  writeFile('library-package', 'package.json', `${JSON.stringify({
    name: 'generic-library-runtime-fixture',
    private: true,
    type: 'module',
    exports: {
      '.': './src/index.ts',
    },
    types: './src/index.ts',
  }, null, 2)}\n`)
  writeFile('library-package', 'README.md', '# Generic Library Runtime Fixture\n')
  writeFile('library-package', 'src/index.ts', `export function summarizeAccount(id: string) {
  return { id, balance: 0 }
}
`)

  writeFile('unknown-repo', 'README.md', '# Unknown Runtime Fixture\n')
}

function runCli(command, fixtureName) {
  assert(tsxLoader, 'tsx loader not found; install dependencies before running generic runtime verification')
  const fixturePath = path.join(fixtureRoot, fixtureName)
  log(`START ${fixtureName} ${command}`)
  const result = spawnSync(nodePath, ['--import', tsxLoader, 'packages/dashboard-api/src/cli.ts', command, fixturePath], {
    cwd: repoRoot,
    env: verificationEnv,
    encoding: 'utf8',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert(result.status === 0, `${fixtureName} ${command} failed with status ${result.status}`)
  log(`PASS ${fixtureName} ${command}`)
}

function runGeneratedScenario(fixtureName, scenarioId, expectedArtifacts) {
  const fixturePath = path.join(fixtureRoot, fixtureName)
  const adapterRoot = path.join(fixturePath, '.agentic-qa', 'adapter')
  const runtimeCode = `
    import { createPhase2Runtime } from './templates/persona-qa-dashboard/packages/api/src/phase2/services/runtime-bootstrap.ts'
    import { loadScenario } from './templates/persona-qa-dashboard/packages/api/src/phase2/scenarios/index.ts'

    const scenario = loadScenario(process.env.SCENARIO_ID)
    const expectedArtifacts = JSON.parse(process.env.EXPECTED_ARTIFACTS)
    const runtime = createPhase2Runtime({ deterministic: true, dbPath: ':memory:' })
    const session = runtime.sessionService.createSession(scenario.id)
    const result = await runtime.orchestrator.executeRunInSession(session.id, scenario, {
      targetRepoPath: process.env.AGENTIC_QA_TARGET_REPO,
      runtimeMode: 'generated_non_browser_verify',
    })
    const sessionData = runtime.sessionService.getSession(session.id)
    const artifacts = sessionData?.artifacts ?? {}
    const events = sessionData?.events ?? []
    if (result.status !== 'complete') {
      throw new Error('scenario did not complete: ' + JSON.stringify(result))
    }
    for (const artifact of expectedArtifacts) {
      if (artifacts[artifact] === undefined || artifacts[artifact] === null) {
        throw new Error('missing expected artifact ' + artifact + ': ' + JSON.stringify(artifacts))
      }
    }
    const toolErrors = events.filter((event) => event.type === 'tool_result' && event.payload?.ok === false)
    if (toolErrors.length > 0) {
      throw new Error('tool errors: ' + JSON.stringify(toolErrors))
    }
    console.log(JSON.stringify({
      scenarioId: scenario.id,
      status: result.status,
      artifacts: Object.keys(artifacts),
      toolResultCount: events.filter((event) => event.type === 'tool_result').length,
    }))
  `

  log(`START ${fixtureName} runtime ${scenarioId}`)
  const result = spawnSync(nodePath, ['--import', tsxLoader, '--input-type=module', '-e', runtimeCode], {
    cwd: repoRoot,
    env: {
      ...verificationEnv,
      AGENTIC_QA_TARGET_REPO: fixturePath,
      PERSONA_QA_DISCOVERY_REPORT_FILE: path.join(adapterRoot, 'config', 'discovery-report.generated.json'),
      PERSONA_QA_INSTALL_METADATA_FILE: path.join(adapterRoot, 'config', 'install-metadata.generated.json'),
      PERSONA_QA_PERSONAS_FILE: path.join(adapterRoot, 'personas', 'personas.generated.json'),
      PERSONA_QA_SCENARIOS_FILE: path.join(adapterRoot, 'scenarios', 'scenarios.generated.json'),
      SCENARIO_ID: scenarioId,
      EXPECTED_ARTIFACTS: JSON.stringify(expectedArtifacts),
    },
    encoding: 'utf8',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert(result.status === 0, `${fixtureName} runtime ${scenarioId} failed with status ${result.status}`)
  log(`PASS ${fixtureName} runtime ${scenarioId}`)
}

try {
  createFixtures()
  log(`fixtureRoot=${fixtureRoot}`)

  const expectations = [
    {
      fixtureName: 'backend-api',
      scenarioId: 'api_health_smoke',
      expectedArtifacts: ['serviceStarted', 'apiResponse', 'apiContractVerified'],
    },
    {
      fixtureName: 'backend-api',
      scenarioId: 'api_contract_smoke',
      expectedArtifacts: ['serviceStarted', 'apiResponse', 'apiContractVerified'],
    },
    {
      fixtureName: 'cli-tool',
      scenarioId: 'cli_help_smoke',
      expectedArtifacts: ['cliHelpOutput', 'cliOutputVerified'],
    },
    {
      fixtureName: 'library-package',
      scenarioId: 'package_import_smoke',
      expectedArtifacts: ['packageExports', 'publicApiDocsVerified'],
    },
    {
      fixtureName: 'unknown-repo',
      scenarioId: 'repository_structure_smoke',
      expectedArtifacts: ['repositoryStructure', 'testEntrypoints'],
    },
  ]

  for (const expectation of expectations) {
    runCli('install-local', expectation.fixtureName)
    runCli('discover-local', expectation.fixtureName)
    runGeneratedScenario(expectation.fixtureName, expectation.scenarioId, expectation.expectedArtifacts)
  }

  log('PASS generic repository deterministic runtime verification')
} catch (error) {
  process.stderr.write(`[verify-generic-runtime-execution] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
