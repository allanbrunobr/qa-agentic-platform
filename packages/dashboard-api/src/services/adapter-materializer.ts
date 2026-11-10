import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BootstrapDraft, DiscoveryReport } from '../../../host-sdk/src/contracts.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLATFORM_ROOT = path.resolve(__dirname, '../../../..')
const ADAPTERS_ROOT = process.env.AGENTIC_PLATFORM_ADAPTERS_ROOT
  ? path.resolve(process.env.AGENTIC_PLATFORM_ADAPTERS_ROOT)
  : path.join(PLATFORM_ROOT, 'adapters')

function toConstName(targetAdapterId: string, suffix: string) {
  const normalized = targetAdapterId.replace(/[-_]+(.)/g, (_, char: string) => char.toUpperCase())
  return `${normalized}${suffix}`
}

function inferTargetAdapterId(repoPath: string, explicit?: string) {
  if (explicit) return explicit
  const base = path.basename(repoPath).trim().toLowerCase()
  return base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'generated-host'
}

function print(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function toCamelCase(value: string) {
  const parts = value
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)

  return parts
    .map((part, index) => {
      const lower = part.toLowerCase()
      if (index === 0) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('')
}

function normalizeComparable(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function inferStepRole(stepId: string, fallbackRoles: string[]) {
  if (fallbackRoles.length === 1) return fallbackRoles[0]!

  const stepTokens = new Set(tokenize(stepId))
  const matchedRole = fallbackRoles.find((role) => tokenize(role).some((token) => stepTokens.has(token)))
  return matchedRole ?? fallbackRoles[0] ?? 'primary_user'
}

function inferCapabilityId(stepId: string, capabilityCandidates: string[]) {
  const comparableStepId = normalizeComparable(stepId)
  const exactMatch = capabilityCandidates.find((candidate) => normalizeComparable(candidate) === comparableStepId)
  if (exactMatch) return exactMatch

  const stepTokens = new Set(tokenize(stepId))
  const tokenMatch = capabilityCandidates.find((candidate) => tokenize(candidate).some((token) => stepTokens.has(token)))
  return tokenMatch ?? toCamelCase(stepId) ?? 'executeStep'
}

function inferProducedArtifacts(stepId: string) {
  const tokens = new Set(tokenize(stepId))

  if (tokens.has('verify') || tokens.has('validate') || tokens.has('assert')) return ['verificationResult']
  if (tokens.has('api') || tokens.has('request') || tokens.has('endpoint')) return ['response']
  if (tokens.has('inspect') || tokens.has('identify') || tokens.has('discover')) return ['inspectionResult']
  if (tokens.has('run') || tokens.has('command') || tokens.has('cli')) return ['commandResult']
  if (
    tokens.has('open') ||
    tokens.has('navigate') ||
    tokens.has('visit') ||
    tokens.has('fill') ||
    tokens.has('add') ||
    tokens.has('submit') ||
    tokens.has('interact') ||
    tokens.has('click') ||
    tokens.has('select') ||
    tokens.has('start') ||
    tokens.has('save') ||
    tokens.has('create') ||
    tokens.has('update')
  ) {
    return ['commandResult']
  }

  const artifactName = toCamelCase(`${stepId}_result`)
  return artifactName ? [artifactName] : ['stepResult']
}

export async function materializeAdapterDraft(input: {
  repoPath: string
  report: DiscoveryReport
  draft: BootstrapDraft
  targetAdapterId?: string
}) {
  const targetAdapterId = inferTargetAdapterId(input.repoPath, input.targetAdapterId)
  const outputDir = path.join(ADAPTERS_ROOT, targetAdapterId, 'src', 'model', 'generated')
  await fs.mkdir(outputDir, { recursive: true })

  const manifestConst = toConstName(targetAdapterId, 'GeneratedManifest')
  const authConst = toConstName(targetAdapterId, 'GeneratedAuth')
  const routesConst = toConstName(targetAdapterId, 'GeneratedRoutes')
  const capabilitiesConst = toConstName(targetAdapterId, 'GeneratedCapabilities')
  const personasConst = toConstName(targetAdapterId, 'GeneratedPersonas')
  const scenariosConst = toConstName(targetAdapterId, 'GeneratedScenarios')

  const manifestContent = `import type { AdapterManifestModel } from '../../../../../packages/host-sdk/src/adapter-model.ts'

export const ${manifestConst}: AdapterManifestModel = ${print({
    id: targetAdapterId,
    label: targetAdapterId,
    hostProduct: targetAdapterId,
    framework: input.report.framework ?? 'unknown',
    status: 'draft',
  })} as const
`

  const authContent = `import type { AdapterAuthModel } from '../../../../../packages/host-sdk/src/adapter-model.ts'

export const ${authConst}: AdapterAuthModel = ${print({
    loginEntryPoint: '/login',
    supportsRoleSwitch: true,
    sessionHints: ['generated bootstrap draft - review auth flow'],
  })} as const
`

  const routesContent = `import type { AdapterRouteModel } from '../../../../../packages/host-sdk/src/adapter-model.ts'

export const ${routesConst}: AdapterRouteModel[] = ${print(
    input.report.surfaces.map((surface) => ({
      id: surface.id,
      path: 'unresolved',
      purpose: `${surface.kind}: ${surface.label}`,
    })),
  )} as const
`

  const capabilitiesContent = `import type { AdapterCapabilityModel } from '../../../../../packages/host-sdk/src/adapter-model.ts'

export const ${capabilitiesConst}: AdapterCapabilityModel[] = ${print(
    input.draft.capabilityCandidates.map((capabilityId) => ({
      id: capabilityId,
      purpose: 'Generated from discovery/bootstrap draft',
      sourceHint: 'Review and map this capability to host-specific automation',
    })),
  )} as const
`

  const personasContent = `import type { AdapterPersonaModel } from '../../../../../packages/host-sdk/src/adapter-model.ts'

export const ${personasConst}: AdapterPersonaModel[] = ${print(
    input.draft.personas.map((persona) => ({
      id: persona.id,
      title: persona.title,
      goal: persona.rationale,
      allowedCapabilities: persona.allowedTools,
    })),
  )} as const
`

  const scenariosContent = `import type { AdapterScenarioModel } from '../../../../../packages/host-sdk/src/adapter-model.ts'

export const ${scenariosConst}: AdapterScenarioModel[] = ${print(
    input.draft.scenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      roles: scenario.participatingRoles,
      steps: scenario.candidateSteps,
      expectedArtifacts: scenario.candidateSteps.flatMap((stepId) => inferProducedArtifacts(stepId)),
      stepDefinitions: scenario.candidateSteps.map((stepId) => ({
        id: stepId,
        roleId: inferStepRole(stepId, scenario.participatingRoles),
        capabilityId: inferCapabilityId(stepId, input.draft.capabilityCandidates),
        producesArtifacts: inferProducedArtifacts(stepId),
      })),
    })),
  )} as const
`

  const indexContent = `export * from './manifest.generated.ts'
export * from './auth.generated.ts'
export * from './routes.generated.ts'
export * from './capabilities.generated.ts'
export * from './personas.generated.ts'
export * from './scenarios.generated.ts'
`

  const files = [
    ['manifest.generated.ts', manifestContent],
    ['auth.generated.ts', authContent],
    ['routes.generated.ts', routesContent],
    ['capabilities.generated.ts', capabilitiesContent],
    ['personas.generated.ts', personasContent],
    ['scenarios.generated.ts', scenariosContent],
    ['index.generated.ts', indexContent],
  ] as const

  await Promise.all(
    files.map(([filename, content]) => fs.writeFile(path.join(outputDir, filename), content, 'utf8')),
  )

  return {
    targetAdapterId,
    outputDir,
    files: files.map(([filename]) => path.join(outputDir, filename)),
  }
}
