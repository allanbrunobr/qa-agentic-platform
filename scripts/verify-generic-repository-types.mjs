import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isolatedProviderEnv } from './lib/provider-isolation.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const REFERENCE_DOMAIN_ID_PATTERN = /^(sales_associate|fulfillment_agent|billing_clerk|store_manager)$|reference-store/
const fixtureRoot = path.join(os.tmpdir(), `agentic-platform-generic-repository-fixtures-${Date.now()}`)
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

function log(message) {
  process.stdout.write(`[verify-generic-repository-types] ${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function writeFile(fixtureName, relativePath, content) {
  const filePath = path.join(fixtureRoot, fixtureName, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function readGeneratedJson(fixtureName, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(
    fixtureRoot,
    fixtureName,
    '.agentic-qa/adapter',
    relativePath,
  ), 'utf8'))
}

function createFixtures() {
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
  fs.mkdirSync(fixtureRoot, { recursive: true })

  writeFile('backend-api', 'package.json', `${JSON.stringify({
    name: 'generic-backend-api-fixture',
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

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' })
})

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
  writeFile('backend-api', 'src/services/accounts.ts', `import billingClient from '../clients/billing.js'
import accountsRepository from '../repositories/accounts.js'

const accountsService = {
  buildAccountsPayload() {
    billingClient.fetchSnapshot()
    accountsRepository.listAccounts()
    return [{ id: 'acct_1' }]
  },
}

export default accountsService
`)
  writeFile('backend-api', 'src/repositories/accounts.ts', `import { prisma } from '../db/client.js'

const accountsRepository = {
  listAccounts() {
    return prisma.account.findMany()
  },
}

export default accountsRepository
`)
  writeFile('backend-api', 'src/db/client.ts', `import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()
`)
  writeFile('backend-api', 'src/clients/billing.ts', `const billingClient = {
  fetchSnapshot() {
    return fetch('https://billing.example.com/api/accounts')
  },
}

export default billingClient
`)

  writeFile('cli-tool', 'package.json', `${JSON.stringify({
    name: 'generic-cli-fixture',
    private: true,
    type: 'module',
    bin: {
      'generic-cli': './bin/generic-cli.js',
    },
    dependencies: {
      commander: '^latest',
    },
  }, null, 2)}\n`)
  writeFile('cli-tool', 'bin/generic-cli.js', `#!/usr/bin/env node
import { Command } from 'commander'

new Command()
  .name('generic-cli')
  .description('Example CLI command surface')
  .option('--format <format>', 'output format')
  .parse()
`)

  writeFile('library-package', 'package.json', `${JSON.stringify({
    name: 'generic-library-fixture',
    private: true,
    type: 'module',
    exports: {
      '.': './src/index.ts',
    },
    types: './src/index.ts',
  }, null, 2)}\n`)
  writeFile('library-package', 'src/index.ts', `export interface AccountSummary {
  id: string
  balance: number
}

export function summarizeAccount(id: string): AccountSummary {
  return { id, balance: 0 }
}
`)

  writeFile('unknown-repo', 'README.md', '# Unknown Repository\n\nDocumentation-only repository fixture.\n')
}

function runCli(command, fixtureName) {
  assert(tsxLoader, 'tsx loader not found; install dependencies before running generic repository verification')
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

function verifyFixture(fixtureName, expected) {
  const report = readGeneratedJson(fixtureName, 'config/discovery-report.generated.json')
  const auth = readGeneratedJson(fixtureName, 'auth/auth.generated.json')
  const personas = readGeneratedJson(fixtureName, 'personas/personas.generated.json')
  const scenarios = readGeneratedJson(fixtureName, 'scenarios/scenarios.generated.json')
  const capabilities = readGeneratedJson(fixtureName, 'capabilities/capabilities.generated.json')
  const codeGraph = readGeneratedJson(fixtureName, 'config/code-graph.generated.json')
  const contractsIndex = readGeneratedJson(fixtureName, 'workflow-contracts/index.generated.json')
  const runtimePlan = readGeneratedJson(fixtureName, 'runtime/runtime-plan.generated.json')

  const personaIds = personas.map((persona) => persona.id)
  const scenarioIds = scenarios.map((scenario) => scenario.id)
  const capabilityIds = capabilities.map((capability) => capability.id)
  const surfaceIds = report.surfaces.map((surface) => surface.id)

  assert(report.repository?.kind === expected.kind, `${fixtureName}: expected ${expected.kind}, got ${report.repository?.kind}`)
  assert(codeGraph.schemaVersion === 'code-graph/v1', `${fixtureName}: code graph schema missing`)
  assert(codeGraph.repositoryKind === expected.kind, `${fixtureName}: expected code graph kind ${expected.kind}, got ${codeGraph.repositoryKind}`)
  assert(codeGraph.nodes.some((node) => node.type === 'repository'), `${fixtureName}: code graph repository node missing`)
  assert(codeGraph.nodes.some((node) => node.type === 'persona_candidate'), `${fixtureName}: code graph persona candidate missing`)
  assert(codeGraph.nodes.some((node) => node.type === 'scenario_candidate'), `${fixtureName}: code graph scenario candidate missing`)
  assert(codeGraph.nodes.some((node) => node.type === 'capability_candidate'), `${fixtureName}: code graph capability candidate missing`)
  assert(codeGraph.edges.some((edge) => edge.type === 'requires_capability'), `${fixtureName}: code graph capability edges missing`)
  assert(personaIds.includes(expected.persona), `${fixtureName}: missing persona ${expected.persona}; got ${personaIds.join(', ')}`)
  assert(scenarioIds.includes(expected.scenario), `${fixtureName}: missing scenario ${expected.scenario}; got ${scenarioIds.join(', ')}`)
  for (const capabilityId of expected.capabilities) {
    assert(capabilityIds.includes(capabilityId), `${fixtureName}: missing capability ${capabilityId}; got ${capabilityIds.join(', ')}`)
  }
  assert(!personaIds.some((id) => REFERENCE_DOMAIN_ID_PATTERN.test(id)), `${fixtureName}: reference-domain personas leaked into generic adapter`)
  assert(!scenarioIds.includes('first_order') && !scenarioIds.includes('first_order_multi_role'), `${fixtureName}: reference-domain scenario leaked into generic adapter`)
  assert(!surfaceIds.includes('form_entry') && !surfaceIds.includes('checkout'), `${fixtureName}: frontend surfaces leaked into non-frontend adapter`)
  assert(auth.loginEntryPoint === 'not_applicable', `${fixtureName}: expected no browser login, got ${auth.loginEntryPoint}`)
  assert(contractsIndex.some((entry) => entry.scenarioId === expected.scenario), `${fixtureName}: workflow contract missing`)

  if (fixtureName === 'backend-api') {
    assert(surfaceIds.includes('primary_endpoint'), `${fixtureName}: primary endpoint surface missing`)
    assert(scenarioIds.includes('api_contract_smoke'), `${fixtureName}: api_contract_smoke should be generated when non-health endpoints exist`)
    assert(capabilityIds.includes('callPrimaryEndpoint'), `${fixtureName}: callPrimaryEndpoint capability missing`)
    const primaryCapability = capabilities.find((capability) => capability.id === 'callPrimaryEndpoint')
    assert(primaryCapability?.graphHint?.status === 'mapped', `${fixtureName}: callPrimaryEndpoint should be graph-mapped`)
    assert(primaryCapability?.graphHint?.endpoints?.includes('GET /api/accounts'), `${fixtureName}: primary endpoint hint missing`)
    assert(primaryCapability?.graphHint?.handlers?.some((hint) => hint.includes('listAccounts')), `${fixtureName}: imported controller handler hint missing`)
    assert(primaryCapability?.graphHint?.handlers?.some((hint) => hint.includes('buildAccountsPayload')), `${fixtureName}: service handler hint missing`)
    assert(primaryCapability?.graphHint?.handlers?.some((hint) => hint.includes('prisma.account.findMany')), `${fixtureName}: data access handler hint missing`)
    assert(primaryCapability?.graphHint?.handlers?.some((hint) => hint.includes('fetchSnapshot')), `${fixtureName}: client handler hint missing`)
    assert(primaryCapability?.graphHint?.httpCalls?.includes('GET /api/accounts'), `${fixtureName}: downstream http call hint missing`)
    assert(primaryCapability?.routeHint === '/api/accounts', `${fixtureName}: callPrimaryEndpoint should point to /api/accounts`)
    const verifyCapability = capabilities.find((capability) => capability.id === 'verifyApiResponse')
    assert(verifyCapability?.graphHint?.status === 'mapped', `${fixtureName}: verifyApiResponse should inherit graph mapping`)
    assert(runtimePlan.routeCoverage.some((route) => route.path === '/api/accounts'), `${fixtureName}: runtime route coverage missing /api/accounts`)
    const controllerNode = codeGraph.nodes.find((node) => node.label === 'listAccounts' && node.source?.filePath === 'src/controllers/accounts.ts')
    const serviceNode = codeGraph.nodes.find((node) => node.label === 'buildAccountsPayload' && node.source?.filePath === 'src/services/accounts.ts')
    const repositoryNode = codeGraph.nodes.find((node) => node.label === 'listAccounts' && node.source?.filePath === 'src/repositories/accounts.ts')
    const clientNode = codeGraph.nodes.find((node) => node.label === 'fetchSnapshot' && node.source?.filePath === 'src/clients/billing.ts')
    const dataAccessNode = codeGraph.nodes.find((node) =>
      node.label === 'prisma.account.findMany'
      && node.type === 'service'
      && node.metadata?.kind === 'data_access',
    )
    const downstreamHttpCallNode = codeGraph.nodes.find((node) =>
      node.type === 'http_call'
      && node.metadata?.url === 'https://billing.example.com/api/accounts',
    )
    assert(controllerNode && serviceNode && repositoryNode && clientNode && dataAccessNode && downstreamHttpCallNode, `${fixtureName}: controller/service/repository/data/http nodes missing in code graph`)
    assert(codeGraph.edges.some((edge) => edge.type === 'calls' && edge.from === controllerNode.id && edge.to === serviceNode.id), `${fixtureName}: controller -> service call edge missing`)
    assert(codeGraph.edges.some((edge) => edge.type === 'calls' && edge.from === serviceNode.id && edge.to === repositoryNode.id), `${fixtureName}: service -> repository call edge missing`)
    assert(codeGraph.edges.some((edge) => edge.type === 'calls' && edge.from === repositoryNode.id && edge.to === dataAccessNode.id), `${fixtureName}: repository -> data access call edge missing`)
    assert(codeGraph.edges.some((edge) => edge.type === 'calls' && edge.from === serviceNode.id && edge.to === clientNode.id), `${fixtureName}: service -> client call edge missing`)
    assert(codeGraph.edges.some((edge) => edge.type === 'calls' && edge.from === clientNode.id && edge.to === downstreamHttpCallNode.id), `${fixtureName}: client -> http call edge missing`)
  }
}

try {
  createFixtures()
  log(`fixtureRoot=${fixtureRoot}`)

  const expectations = [
    {
      fixtureName: 'backend-api',
      kind: 'backend_api',
      persona: 'api_consumer',
      scenario: 'api_health_smoke',
      capabilities: ['startApiService', 'callHealthEndpoint', 'callPrimaryEndpoint', 'verifyApiResponse'],
    },
    {
      fixtureName: 'cli-tool',
      kind: 'cli',
      persona: 'cli_user',
      scenario: 'cli_help_smoke',
      capabilities: ['runCliHelp', 'verifyCliOutput'],
    },
    {
      fixtureName: 'library-package',
      kind: 'library',
      persona: 'integration_developer',
      scenario: 'package_import_smoke',
      capabilities: ['inspectPackageExports', 'verifyPublicApiDocs'],
    },
    {
      fixtureName: 'unknown-repo',
      kind: 'unknown',
      persona: 'repository_reviewer',
      scenario: 'repository_structure_smoke',
      capabilities: ['inspectRepositoryStructure', 'identifyTestEntrypoints'],
    },
  ]

  for (const expectation of expectations) {
    runCli('install-local', expectation.fixtureName)
    runCli('discover-local', expectation.fixtureName)
    verifyFixture(expectation.fixtureName, expectation)
  }

  log('PASS generic repository type install/discovery verification')
} catch (error) {
  process.stderr.write(`[verify-generic-repository-types] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
