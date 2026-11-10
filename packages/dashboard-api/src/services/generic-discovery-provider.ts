import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  BootstrapDraft,
  DiscoveryHintsProvider,
  DiscoveryReport,
  HostProjectPointer,
  RepositoryClassification,
  RepositoryKind,
} from '../../../host-sdk/src/contracts.ts'
import { inferDomainDiscoveryBundle } from './domain-specialist-service.ts'
import { classifyRepository } from './repository-classifier.ts'
import { resolvePreferredFrontendScanRoot, scanStaticFrontend } from './static-frontend-scanner.ts'

export class GenericFrontendDiscoveryProvider implements DiscoveryHintsProvider {
  readonly id = 'generic-repository-discovery'
  private readonly cache = new Map<string, Promise<{ report: DiscoveryReport; draft: BootstrapDraft }>>()
  private lastRepoPath: string | null = null

  private analyze(pointer: HostProjectPointer) {
    this.lastRepoPath = pointer.repoPath
    if (!this.cache.has(pointer.repoPath)) {
      this.cache.set(pointer.repoPath, analyzeGenericFrontend(pointer.repoPath))
    }
    return this.cache.get(pointer.repoPath)!
  }

  async discover(pointer: HostProjectPointer): Promise<DiscoveryReport> {
    const result = await this.analyze(pointer)
    return result.report
  }

  async synthesize(_report: DiscoveryReport): Promise<BootstrapDraft> {
    if (!this.lastRepoPath) return fallbackGenericDraft()
    const cached = this.cache.get(this.lastRepoPath)
    return cached ? (await cached).draft : fallbackGenericDraft()
  }
}

async function analyzeGenericFrontend(repoPath: string): Promise<{ report: DiscoveryReport; draft: BootstrapDraft }> {
  const repository = await classifyRepository(repoPath)
  const frontendRoot = repository.kind === 'frontend'
    ? await resolvePreferredFrontendScanRoot(repoPath)
    : null
  const packageJson = frontendRoot
    ? await readJson(path.join(frontendRoot.appRoot, 'package.json'))
    : await readJson(path.join(repoPath, 'package.json'))
  const sourceFiles = await listSourceFiles(repoPath, repository, frontendRoot?.appRoot ?? null)
  const backendEndpointCandidates = repository.kind === 'backend_api'
    ? await extractBackendEndpointCandidatesFromFiles(repoPath, sourceFiles)
    : []
  const sourceText = await readSourcePreview(sourceFiles)
  const framework = detectFramework(packageJson, sourceFiles, repository)
  const surfaces = buildSurfaces(repoPath, packageJson, sourceFiles, sourceText, repository, backendEndpointCandidates)
  const domainDiscovery = repository.kind === 'frontend'
    ? inferDomainDiscoveryBundle(await scanStaticFrontend(repoPath))
    : undefined

  const report: DiscoveryReport = {
    framework,
    repository,
    ...(domainDiscovery ? { domainDiscovery } : {}),
    surfaces,
    roles: buildRoles(repoPath, sourceFiles, repository),
    risks: buildRisks(repository),
  }

  return {
    report,
    draft: buildGenericDraft(sourceText, repository, domainDiscovery?.domain.domain, backendEndpointCandidates),
  }
}

function detectFramework(
  packageJson: Record<string, unknown> | null,
  sourceFiles: string[],
  repository: RepositoryClassification,
): string {
  if (repository.frameworks.length > 0) return repository.frameworks[0]!
  const deps = {
    ...recordValue(packageJson?.['dependencies']),
    ...recordValue(packageJson?.['devDependencies']),
  }
  if ('next' in deps || sourceFiles.some((filePath) => filePath.includes('/src/app/'))) return 'nextjs'
  if ('vite' in deps) return 'vite'
  if ('react' in deps) return 'react'
  if ('vue' in deps) return 'vue'
  if (repository.kind === 'backend_api') return repository.language ? `${repository.language}-api` : 'backend-api'
  if (repository.kind === 'cli') return repository.language ? `${repository.language}-cli` : 'cli'
  if (repository.kind === 'library') return repository.language ? `${repository.language}-library` : 'library'
  if (repository.kind === 'monorepo') return 'monorepo'
  return 'unknown'
}

function buildGenericDraft(
  sourceText: string,
  repository: RepositoryClassification,
  _inferredDomain: string | undefined,
  backendEndpointCandidates: Array<{ method: string; path: string }>,
): BootstrapDraft {
  if (repository.kind === 'backend_api') {
    const endpointCandidates = backendEndpointCandidates.length > 0
      ? backendEndpointCandidates
      : extractBackendEndpointCandidates(sourceText)
    const hasHealth = endpointCandidates.some((candidate) => isHealthLikeRoute(candidate.path))
    const hasPrimaryEndpoint = endpointCandidates.some((candidate) => !isHealthLikeRoute(candidate.path))
    const allowedTools = [
      'startApiService',
      ...(hasHealth ? ['callHealthEndpoint'] : []),
      ...(hasPrimaryEndpoint ? ['callPrimaryEndpoint'] : []),
      'verifyApiResponse',
    ]
    const scenarios = [
      ...(hasHealth
        ? [{
            id: 'api_health_smoke',
            title: 'API health smoke flow',
            participatingRoles: ['api_consumer'],
            rationale: 'Generated from backend/API repository health endpoint signatures.',
            candidateSteps: ['start_api_service', 'call_health_endpoint', 'verify_api_response'],
          }]
        : []),
      ...(hasPrimaryEndpoint
        ? [{
            id: 'api_contract_smoke',
            title: 'API contract smoke flow',
            participatingRoles: ['api_consumer'],
            rationale: 'Generated from backend/API primary endpoint signatures.',
            candidateSteps: ['start_api_service', 'call_primary_endpoint', 'verify_api_response'],
          }]
        : []),
    ]
    const capabilityCandidates = [
      'startApiService',
      ...(hasHealth ? ['callHealthEndpoint'] : []),
      ...(hasPrimaryEndpoint ? ['callPrimaryEndpoint'] : []),
      'verifyApiResponse',
    ]

    return {
      personas: [
        {
          id: 'api_consumer',
          title: 'API Consumer',
          rationale: 'Validates the primary service contract exposed by the target API repository.',
          allowedTools,
        },
      ],
      scenarios: scenarios.length > 0
        ? scenarios
        : [{
            id: 'api_contract_smoke',
            title: 'API contract smoke flow',
            participatingRoles: ['api_consumer'],
            rationale: 'Generated from backend/API repository signatures.',
            candidateSteps: ['start_api_service', 'call_primary_endpoint', 'verify_api_response'],
          }],
      capabilityCandidates: capabilityCandidates.length > 0
        ? capabilityCandidates
        : ['startApiService', 'callPrimaryEndpoint', 'verifyApiResponse'],
      hostNotes: [
        'Backend/API adapter generated from deterministic repository classification.',
        'Generated capabilities are draft stubs until endpoint URLs, auth, seed data, and assertions are mapped.',
      ],
    }
  }

  if (repository.kind === 'cli') {
    return {
      personas: [
        {
          id: 'cli_user',
          title: 'CLI User',
          rationale: 'Validates the command-line entrypoint and its observable output contract.',
          allowedTools: ['runCliHelp', 'verifyCliOutput'],
        },
      ],
      scenarios: [
        {
          id: 'cli_help_smoke',
          title: 'CLI help smoke flow',
          participatingRoles: ['cli_user'],
          rationale: 'Generated from CLI entrypoint metadata.',
          candidateSteps: ['run_cli_help', 'verify_cli_output'],
        },
      ],
      capabilityCandidates: ['runCliHelp', 'verifyCliOutput'],
      hostNotes: [
        'CLI adapter generated from deterministic repository classification.',
        'Generated capabilities are draft stubs until command invocation, environment, and expected output are mapped.',
      ],
    }
  }

  if (repository.kind === 'library') {
    return {
      personas: [
        {
          id: 'integration_developer',
          title: 'Integration Developer',
          rationale: 'Validates package metadata and public API surfaces from a developer integration perspective.',
          allowedTools: ['inspectPackageExports', 'verifyPublicApiDocs'],
        },
      ],
      scenarios: [
        {
          id: 'package_import_smoke',
          title: 'Package import smoke flow',
          participatingRoles: ['integration_developer'],
          rationale: 'Generated from package/library metadata.',
          candidateSteps: ['inspect_package_exports', 'verify_public_api_docs'],
        },
      ],
      capabilityCandidates: ['inspectPackageExports', 'verifyPublicApiDocs'],
      hostNotes: [
        'Library adapter generated from deterministic repository classification.',
        'Generated capabilities are draft stubs until build/import commands and public API assertions are mapped.',
      ],
    }
  }

  if (repository.kind === 'unknown' || repository.kind === 'monorepo') {
    return {
      personas: [
        {
          id: 'repository_reviewer',
          title: 'Repository Reviewer',
          rationale: 'Inspects repository structure when AP cannot infer a more specific executable runtime.',
          allowedTools: ['inspectRepositoryStructure', 'identifyTestEntrypoints'],
        },
      ],
      scenarios: [
        {
          id: 'repository_structure_smoke',
          title: 'Repository structure smoke flow',
          participatingRoles: ['repository_reviewer'],
          rationale: 'Generated as a safe fallback when runtime type is ambiguous.',
          candidateSteps: ['inspect_repository_structure', 'identify_test_entrypoints'],
        },
      ],
      capabilityCandidates: ['inspectRepositoryStructure', 'identifyTestEntrypoints'],
      hostNotes: [
        'Fallback adapter generated because repository type is ambiguous or unsupported.',
        'No scenario should be promoted to runnable until a concrete runtime is selected.',
      ],
    }
  }

  const allowedTools = ['openPrimaryRoute', 'interactWithPrimaryAction', 'verifyPrimaryFeedback', 'captureScreenshot']

  return {
    personas: [
      {
        id: 'primary_user',
        title: 'Primary User',
        rationale: 'Validates the main visible user journey detected in the target frontend.',
        allowedTools,
      },
    ],
    scenarios: [
      {
        id: 'primary_user_smoke',
        title: 'Primary user smoke flow',
        participatingRoles: ['primary_user'],
        rationale: 'Generated from deterministic generic frontend discovery. Domain-specific scenario ids are written by the domain specialist.',
        candidateSteps: ['open_primary_route', 'interact_with_primary_action', 'verify_primary_feedback'],
      },
    ],
    capabilityCandidates: allowedTools,
    hostNotes: [
      'Generic frontend adapter generated from static route and UI evidence.',
      'Replace generated capability stubs with host-specific Playwright actions before certifying this adapter.',
    ],
  }
}

function buildRoles(
  repoPath: string,
  sourceFiles: string[],
  repository: RepositoryClassification,
): DiscoveryReport['roles'] {
  const evidence = [
    `repository kind: ${repository.kind}`,
    ...sourceFiles.slice(0, 3).map((filePath) => path.relative(repoPath, filePath)),
  ]

  const roleByKind: Record<RepositoryKind, DiscoveryReport['roles'][number]> = {
    frontend: {
      id: 'primary_user',
      confidence: 0.72,
      evidence: [
        'Generic frontend discovery inferred an end-user role from visible UI controls.',
        ...evidence,
      ],
    },
    backend_api: {
      id: 'api_consumer',
      confidence: repository.confidence,
      evidence: ['Backend/API repository signatures imply a service consumer role.', ...evidence],
    },
    cli: {
      id: 'cli_user',
      confidence: repository.confidence,
      evidence: ['CLI entrypoint metadata implies a command-line user role.', ...evidence],
    },
    library: {
      id: 'integration_developer',
      confidence: repository.confidence,
      evidence: ['Package metadata implies a developer integration role.', ...evidence],
    },
    monorepo: {
      id: 'repository_reviewer',
      confidence: repository.confidence,
      evidence: ['Monorepo metadata requires runtime selection before scenario activation.', ...evidence],
    },
    unknown: {
      id: 'repository_reviewer',
      confidence: repository.confidence,
      evidence: ['No specific runtime signature was detected.', ...evidence],
    },
  }

  return [roleByKind[repository.kind]]
}

function buildRisks(repository: RepositoryClassification): string[] {
  const common = [
    'Generic repository discovery used deterministic static analysis; review generated personas and scenarios before activation.',
    'Capability handlers are generated as host-specific stubs until mapped to real automation.',
  ]
  if (repository.kind === 'frontend') return common
  if (repository.kind === 'backend_api') {
    return [
      ...common,
      'Backend/API scenarios require endpoint, auth, environment, and seed data mapping before becoming runnable.',
    ]
  }
  if (repository.kind === 'cli') {
    return [
      ...common,
      'CLI scenarios require command invocation, working directory, environment, and output assertions before becoming runnable.',
    ]
  }
  if (repository.kind === 'library') {
    return [
      ...common,
      'Library scenarios require build/import commands and public API assertions before becoming runnable.',
    ]
  }
  return [
    ...common,
    'Repository type is ambiguous; generated scenarios are structure review drafts only.',
  ]
}

function buildSurfaces(
  repoPath: string,
  packageJson: Record<string, unknown> | null,
  sourceFiles: string[],
  sourceText: string,
  repository: RepositoryClassification,
  backendEndpointCandidates: Array<{ method: string; path: string }>,
): DiscoveryReport['surfaces'] {
  const surfaces: DiscoveryReport['surfaces'] = []
  const relativeSources = sourceFiles.map((filePath) => path.relative(repoPath, filePath))
  const hasPackageScripts = Object.keys(recordValue(packageJson?.['scripts'])).length > 0
  const hasMainEntry = relativeSources.some((filePath) => /(^|\/)main\.[jt]sx?$/.test(filePath))

  if (repository.kind === 'backend_api') {
    const endpointCandidates = backendEndpointCandidates.length > 0
      ? backendEndpointCandidates
      : extractBackendEndpointCandidates(sourceText)
    surfaces.push({
      id: 'api_service',
      kind: 'module',
      label: 'API Service',
      evidence: repository.evidence,
    })
    const healthEndpoint = endpointCandidates.find((candidate) => isHealthLikeRoute(candidate.path))
    if (healthEndpoint) {
      surfaces.push({
        id: 'health_endpoint',
        kind: 'route',
        label: 'Health Endpoint',
        evidence: [
          `${healthEndpoint.method} ${healthEndpoint.path}`,
          ...matchingEvidence(relativeSources, sourceText, ['health', 'heartbeat', 'readiness', 'liveness']),
        ],
      })
    }
    const primaryEndpoint = endpointCandidates.find((candidate) => !isHealthLikeRoute(candidate.path))
    if (primaryEndpoint) {
      surfaces.push({
        id: 'primary_endpoint',
        kind: 'route',
        label: 'Primary Endpoint',
        evidence: [
          `${primaryEndpoint.method} ${primaryEndpoint.path}`,
          ...matchingEvidence(relativeSources, sourceText, ['api', 'route', 'endpoint', primaryEndpoint.path]),
        ],
      })
    }
  } else if (repository.kind === 'cli') {
    surfaces.push({
      id: 'cli_entrypoint',
      kind: 'module',
      label: 'CLI Entrypoint',
      evidence: matchingEvidence(relativeSources, sourceText, ['cli', 'command', 'bin']),
    })
  } else if (repository.kind === 'library') {
    surfaces.push({
      id: 'package_api',
      kind: 'module',
      label: 'Package API',
      evidence: ['package.json', ...matchingEvidence(relativeSources, sourceText, ['export', 'public', 'index'])],
    })
  } else if (repository.kind === 'unknown' || repository.kind === 'monorepo') {
    surfaces.push({
      id: 'repository_structure',
      kind: 'module',
      label: 'Repository Structure',
      evidence: repository.evidence.length > 0 ? repository.evidence : relativeSources.slice(0, 5),
    })
  } else if (hasPackageScripts || hasMainEntry) {
    surfaces.push({
      id: 'root_app',
      kind: 'route',
      label: 'Root App',
      evidence: ['index.html', ...relativeSources.filter((filePath) => /src\/main\.[jt]sx?$/.test(filePath)).slice(0, 1)],
    })
  }

  if (repository.kind === 'frontend' && /\bcart\b|\bcheckout\b|\bcustomer\b|\bshipping\b|\bproduct\b/.test(sourceText.toLowerCase())) {
    surfaces.push({
      id: 'checkout',
      kind: 'feature',
      label: 'Checkout',
      evidence: matchingEvidence(relativeSources, sourceText, ['checkout', 'cart', 'customer', 'shipping', 'product']),
    })
  }

  if (repository.kind === 'frontend' && /email|input|form/i.test(sourceText)) {
    surfaces.push({
      id: 'form_entry',
      kind: 'feature',
      label: 'Form Entry',
      evidence: matchingEvidence(relativeSources, sourceText, ['email', 'input', 'form']),
    })
  }

  if (surfaces.length === 0) {
    surfaces.push({
      id: 'frontend_shell',
      kind: 'module',
      label: 'Frontend Shell',
      evidence: relativeSources.slice(0, 5),
    })
  }

  if (packageJson?.['name']) {
    surfaces[0] = {
      ...surfaces[0],
      evidence: [`package:${String(packageJson['name'])}`, ...surfaces[0].evidence],
    }
  }

  return surfaces
}

function matchingEvidence(relativeSources: string[], sourceText: string, tokens: string[]): string[] {
  const matched = relativeSources.filter((filePath) => tokens.some((token) => filePath.toLowerCase().includes(token)))
  if (matched.length > 0) return matched.slice(0, 5)
  const textToken = tokens.find((token) => sourceText.toLowerCase().includes(token))
  return textToken ? [`source contains "${textToken}"`] : relativeSources.slice(0, 3)
}

function extractBackendEndpointCandidates(sourceText: string) {
  const endpoints: Array<{ method: string; path: string }> = []
  const expressLike = /\b(?:app|router|fastify|server)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi
  for (const match of sourceText.matchAll(expressLike)) {
    const method = String(match[1] ?? 'get').toUpperCase()
    const routePath = normalizeBackendRoutePath(String(match[2] ?? '/'))
    if (!routePath) continue
    endpoints.push({ method, path: routePath })
  }
  const seen = new Set<string>()
  return endpoints.filter((endpoint) => {
    const key = `${endpoint.method} ${endpoint.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function extractBackendEndpointCandidatesFromFiles(repoPath: string, sourceFiles: string[]) {
  const fileEntries: Array<{
    relativePath: string
    content: string
    imports: Array<{ binding: string; targetRelativePath: string | null }>
    endpoints: Array<{ method: string; path: string; routerName: string }>
    routeMounts: Array<{ prefix: string; routerIdentifier: string; targetRelativePath: string | null }>
  }> = []
  const existingRelativePaths = new Set(sourceFiles.map((filePath) => normalizeRepoRelativePath(repoPath, filePath)))

  for (const filePath of sourceFiles) {
    const content = await readBoundedSourceFile(filePath)
    if (content === null) continue
    const relativePath = normalizeRepoRelativePath(repoPath, filePath)
    const imports = extractBackendImports(relativePath, content, existingRelativePaths)
    const endpoints = extractBackendEndpointsFromContent(content)
    const routeMounts = extractBackendRouteMounts(content, imports)
    fileEntries.push({ relativePath, content, imports, endpoints, routeMounts })
  }

  const endpointPool = fileEntries.flatMap((entry) =>
    entry.endpoints.map((endpoint) => ({
      ...endpoint,
      relativePath: entry.relativePath,
      mountChain: [] as string[],
    })),
  )
  const composed: typeof endpointPool = []
  const seen = new Set(endpointPool.map((endpoint) => `${endpoint.method} ${endpoint.path}`))

  for (let iteration = 0; iteration < 4; iteration += 1) {
    let added = 0
    for (const entry of fileEntries) {
      for (const routeMount of entry.routeMounts) {
        const matchingEndpoints = endpointPool.filter((endpoint) => {
          if (endpoint.mountChain.includes(`${entry.relativePath}:${routeMount.prefix}:${routeMount.routerIdentifier}`)) return false
          if (endpoint.relativePath === entry.relativePath && endpoint.routerName === routeMount.routerIdentifier) return true
          return Boolean(routeMount.targetRelativePath && endpoint.relativePath === routeMount.targetRelativePath)
        })
        for (const endpoint of matchingEndpoints) {
          const prefixedPath = normalizeBackendRoutePath(`${routeMount.prefix}/${endpoint.path}`)
          if (!prefixedPath) continue
          const key = `${endpoint.method} ${prefixedPath}`
          if (seen.has(key)) continue
          seen.add(key)
          const mountedId = `${entry.relativePath}:${routeMount.prefix}:${routeMount.routerIdentifier}`
          const composedEndpoint = {
            ...endpoint,
            path: prefixedPath,
            mountChain: [...endpoint.mountChain, mountedId],
          }
          endpointPool.push(composedEndpoint)
          composed.push(composedEndpoint)
          added += 1
        }
      }
    }
    if (added === 0) break
  }

  return [...endpointPool, ...composed]
    .map((endpoint) => ({ method: endpoint.method, path: endpoint.path }))
    .filter((endpoint, index, list) => list.findIndex((candidate) => candidate.method === endpoint.method && candidate.path === endpoint.path) === index)
    .sort((left, right) => backendEndpointPriority(right.path) - backendEndpointPriority(left.path))
}

function extractBackendImports(relativePath: string, sourceText: string, existingRelativePaths: Set<string>) {
  const imports: Array<{ binding: string; targetRelativePath: string | null }> = []
  const importStatement = /\bimport\s+([^;]+?)\s+from\s+["'`]([^"'`]+)["'`]/g
  for (const match of sourceText.matchAll(importStatement)) {
    const clause = String(match[1] ?? '')
    const specifier = String(match[2] ?? '')
    const targetRelativePath = resolveBackendRelativeImport(relativePath, specifier, existingRelativePaths)
    const bindings = clause
      .replace(/[{}]/g, '')
      .split(',')
      .map((item) => item.trim().split(/\s+as\s+/i).pop() ?? '')
      .filter(Boolean)
    for (const binding of bindings) imports.push({ binding, targetRelativePath })
  }
  return imports
}

function extractBackendEndpointsFromContent(sourceText: string) {
  const endpoints: Array<{ method: string; path: string; routerName: string }> = []
  const routeCall = /\b([A-Za-z_$][A-Za-z0-9_$]*)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g
  for (const match of sourceText.matchAll(routeCall)) {
    const routerName = String(match[1] ?? '')
    const method = String(match[2] ?? 'get').toUpperCase()
    const routePath = normalizeBackendRoutePath(String(match[3] ?? '/'))
    if (!routerName || !routePath) continue
    endpoints.push({ method, path: routePath, routerName })
  }
  return endpoints
}

function extractBackendRouteMounts(
  sourceText: string,
  imports: Array<{ binding: string; targetRelativePath: string | null }>,
) {
  const mounts: Array<{ prefix: string; routerIdentifier: string; targetRelativePath: string | null }> = []
  const routeMount = /\b([A-Za-z_$][A-Za-z0-9_$]*)\.(?:use|register)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)/g
  for (const match of sourceText.matchAll(routeMount)) {
    const prefix = normalizeBackendRoutePath(String(match[2] ?? ''))
    const routerIdentifier = String(match[3] ?? '')
    if (!prefix || prefix === '/' || !routerIdentifier) continue
    const targetRelativePath = imports.find((item) => item.binding === routerIdentifier)?.targetRelativePath ?? null
    mounts.push({ prefix, routerIdentifier, targetRelativePath })
  }
  return mounts
}

function resolveBackendRelativeImport(fromRelativePath: string, specifier: string, existingRelativePaths: Set<string>) {
  if (!specifier.startsWith('.')) return null
  const fromDir = path.posix.dirname(fromRelativePath.split(path.sep).join('/'))
  const raw = path.posix.normalize(path.posix.join(fromDir, specifier))
  const withoutExplicitJsExt = raw.replace(/\.(?:c|m)?jsx?$/i, '')
  const candidates = [
    raw,
    withoutExplicitJsExt,
    `${withoutExplicitJsExt}.ts`,
    `${withoutExplicitJsExt}.tsx`,
    `${withoutExplicitJsExt}.js`,
    `${withoutExplicitJsExt}.jsx`,
    `${withoutExplicitJsExt}.mjs`,
    `${withoutExplicitJsExt}/index.ts`,
    `${withoutExplicitJsExt}/index.tsx`,
    `${withoutExplicitJsExt}/index.js`,
    `${withoutExplicitJsExt}/index.jsx`,
    `${raw}.ts`,
    `${raw}.tsx`,
    `${raw}.js`,
    `${raw}.jsx`,
    `${raw}.mjs`,
    `${raw}/index.ts`,
    `${raw}/index.tsx`,
    `${raw}/index.js`,
    `${raw}/index.jsx`,
  ]
  return candidates.find((candidate) => existingRelativePaths.has(candidate)) ?? null
}

function normalizeRepoRelativePath(repoPath: string, filePath: string) {
  return path.relative(repoPath, filePath).split(path.sep).join('/')
}

function normalizeBackendRoutePath(routePath: string) {
  const trimmed = routePath.trim()
  if (!trimmed) return null
  const cleaned = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/')
  const withLeadingSlash = cleaned.startsWith('/') ? cleaned : `/${cleaned}`
  return withLeadingSlash.replace(/\/$/, '') || '/'
}

function isHealthLikeRoute(routePath: string) {
  return /health|heartbeat|readiness|liveness|ready|live/i.test(routePath)
}

function backendEndpointPriority(routePath: string) {
  const segments = routePath.split('/').filter(Boolean).length
  const apiBoost = /\/api\/|^\/api$|\/v\d+\//i.test(routePath) ? 10 : 0
  return apiBoost + segments * 2 + routePath.length / 100
}

async function listSourceFiles(
  repoPath: string,
  repository: RepositoryClassification,
  preferredFrontendRoot: string | null,
): Promise<string[]> {
  const rootEntries = repository.kind === 'frontend'
    ? preferredFrontendRoot
      ? [preferredFrontendRoot]
      : [
          path.join(repoPath, 'frontend'),
          path.join(repoPath, 'web'),
          path.join(repoPath, 'client'),
          path.join(repoPath, 'ui'),
          path.join(repoPath, 'src'),
          path.join(repoPath, 'app'),
          path.join(repoPath, 'pages'),
          path.join(repoPath, 'routes'),
          path.join(repoPath, 'apps'),
          path.join(repoPath, 'packages'),
        ]
    : ['src', 'app', 'pages', 'routes', 'server', 'lib', 'bin', 'cmd', 'apps', 'packages', 'frontend', 'web', 'client', 'backend']
        .map((entry) => path.join(repoPath, entry))

  const roots = Array.from(new Set(rootEntries.filter((entry): entry is string => Boolean(entry))))
  const files: string[] = []
  for (const root of roots) {
    files.push(...await walkSource(root))
  }
  return Array.from(new Set(files)).slice(0, 250)
}

// S-10: the repository is untrusted. The walk never follows symlinks (Dirent.isFile/isDirectory are
// false for links), skips a root that is itself a link, ignores VCS and generated folders, and stops
// at a file count; reads skip files over a size limit instead of loading them whole.
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.agentic-qa'])
const MAX_WALKED_FILES = 2_000
const MAX_SOURCE_FILE_BYTES = 256 * 1024

async function walkSource(root: string, files: string[] = []): Promise<string[]> {
  if (files.length >= MAX_WALKED_FILES) return files
  const rootStat = await fs.lstat(root).catch(() => null)
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return files
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    if (files.length >= MAX_WALKED_FILES) break
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      await walkSource(entryPath, files)
    } else if (entry.isFile() && /\.(tsx|ts|jsx|js|mjs|cjs|vue|svelte|html|css|py|go|rs)$/.test(entry.name)) {
      files.push(entryPath)
    }
  }
  return files
}

/** Reads a source file the walk returned, or null when it is not a small regular file. */
async function readBoundedSourceFile(filePath: string): Promise<string | null> {
  const stat = await fs.lstat(filePath).catch(() => null)
  if (!stat || !stat.isFile() || stat.size > MAX_SOURCE_FILE_BYTES) return null
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

async function readSourcePreview(sourceFiles: string[]): Promise<string> {
  const chunks: string[] = []
  for (const filePath of sourceFiles.slice(0, 30)) {
    const content = await readBoundedSourceFile(filePath)
    if (content !== null) chunks.push(content)
  }
  return chunks.join('\n').slice(0, 80_000)
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function fallbackGenericDraft(): BootstrapDraft {
  return buildGenericDraft('', {
    kind: 'unknown',
    secondaryKinds: [],
    language: null,
    frameworks: [],
    packageManager: null,
    confidence: 0.2,
    evidence: ['fallback repository classification'],
    runtimeHints: [],
  }, undefined, [])
}
