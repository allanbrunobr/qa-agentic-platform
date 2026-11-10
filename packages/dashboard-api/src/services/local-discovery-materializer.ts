import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  BootstrapDraft,
  DiscoveryReport,
  GeneratedPersonaDraft,
  GeneratedScenarioDraft,
} from '../../../host-sdk/src/contracts.ts'
import type { CodeGraph, CodeGraphEdge, CodeGraphNode } from '../../../host-sdk/src/code-graph-contracts.ts'
import type {
  DomainDiscoveryBundle,
  PersonaCandidate,
  ScenarioCandidate,
} from '../../../host-sdk/src/domain-discovery-contracts.ts'
import { buildCodeGraph } from './code-graph-builder.ts'

type NormalizedStep = string

interface MaterializedPersona {
  id: string
  title: string
  goal: string
  allowedCapabilities: string[]
}

interface MaterializedScenario {
  id: string
  title: string
  roles: string[]
  steps: NormalizedStep[]
  expectedArtifacts: string[]
  stepDefinitions: Array<{
    id: NormalizedStep
    roleId: string
    capabilityId: string
    producesArtifacts: string[]
  }>
}

interface MaterializedRoute {
  id: string
  path: string
  purpose: string
  evidence: string[]
}

interface MaterializedCapability {
  id: string
  purpose: string
  sourceHint: string
  routeHint?: string
  graphHint?: {
    status: 'mapped' | 'ui_handler_linked' | 'unmapped'
    confidence: number
    resolver?: string
    handlers: string[]
    endpoints: string[]
    httpCalls: string[]
    handlerIds: string[]
    endpointIds: string[]
    httpCallIds: string[]
  }
}

interface MaterializedDiscoveryArtifacts {
  capabilities: MaterializedCapability[]
  personas: MaterializedPersona[]
  scenarios: MaterializedScenario[]
}

interface RuntimePlan {
  loginEntryPoint: string
  providers: string[]
  repositoryKind?: string
  runtimeMode: 'browser_model' | 'deterministic_non_browser'
  requiresBrowser: boolean
  requiresAnthropicModel: boolean
  routeCoverage: Array<{
    routeId: string
    path: string
    purpose: string
  }>
  capabilityCoverage: Array<{
    capabilityId: string
    routeHint?: string
    implementationStatus: 'stub'
    graphStatus?: string
    graphConfidence?: number
    graphResolver?: string
    handlerHints?: string[]
    endpointHints?: string[]
    httpCallHints?: string[]
    handlerNodeIds?: string[]
    endpointNodeIds?: string[]
    httpCallNodeIds?: string[]
  }>
  scenarioCoverage: Array<{
    scenarioId: string
    steps: NormalizedStep[]
  }>
}

interface ReferenceBridgeEntry {
  capabilityId: string
  modulePath: string
  exports: string[]
  type: 'direct' | 'composite'
}

function inferTargetId(repoPath: string) {
  const base = path.basename(repoPath).trim().toLowerCase()
  return base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'generated-host'
}

function normalizeConfidence(value: number) {
  if (!Number.isFinite(value)) return 0
  if (value > 1) return Math.max(0, Math.min(1, value / 10))
  return Math.max(0, Math.min(1, value))
}

function normalizeId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function toCamelCase(value: string) {
  return value.replace(/_+([a-z0-9])/g, (_, char: string) => char.toUpperCase())
}

function toTitle(value: string) {
  return normalizeId(value)
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function toLowerEvidence(value: string) {
  return value.normalize('NFKD').toLowerCase()
}

function extractRoutePathFromEvidence(evidence: string) {
  const normalized = evidence.replace(/\\/g, '/')
  const methodRouteMatch = normalized.match(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9/_:-]*)/)
  if (methodRouteMatch?.[1]) return methodRouteMatch[1]
  if (/^\/[A-Za-z0-9/_:-]*$/.test(normalized.trim())) return normalized.trim()
  const marker = '/src/app/'
  const markerIndex = normalized.indexOf(marker)
  if (markerIndex === -1) return null
  let appPath = normalized.slice(markerIndex + marker.length)
  appPath = appPath.replace(/\.(tsx|ts|js|jsx)$/, '')
  appPath = appPath.replace(/^(\(internal\)|\(auth\)|\(layout-redirect\))\//, '')
  appPath = appPath.replace(/\/page$/, '')
  appPath = appPath.replace(/\/layout$/, '')
  appPath = appPath.replace(/\/loading$/, '')
  appPath = appPath.replace(/\/error$/, '')
  if (!appPath || appPath === 'page') return '/'
  return '/' + appPath
}

function inferProducedArtifacts(stepId: NormalizedStep) {
  if (stepId === 'fill_customer_email') return ['customerEmail']
  if (stepId === 'add_cart_item') return ['cartItemId']
  if (stepId === 'submit_order') return ['orderSubmitted']
  if (stepId === 'open_primary_route') return ['routeLoaded']
  if (stepId === 'interact_with_primary_action') return ['primaryActionCompleted']
  if (stepId === 'verify_primary_feedback') return ['primaryFeedbackVisible']
  if (stepId === 'start_api_service') return ['serviceStarted']
  if (stepId === 'call_health_endpoint' || stepId === 'call_primary_endpoint') return ['apiResponse']
  if (stepId === 'verify_api_response') return ['apiContractVerified']
  if (stepId === 'run_cli_help') return ['cliHelpOutput']
  if (stepId === 'verify_cli_output') return ['cliOutputVerified']
  if (stepId === 'inspect_package_exports') return ['packageExports']
  if (stepId === 'verify_public_api_docs') return ['publicApiDocsVerified']
  if (stepId === 'inspect_repository_structure') return ['repositoryStructure']
  if (stepId === 'identify_test_entrypoints') return ['testEntrypoints']
  if (stepId.includes('verify') || stepId.includes('validate') || stepId.includes('assert')) return ['verificationResult']
  if (stepId.includes('call') || stepId.includes('request') || stepId.includes('endpoint')) return ['response']
  if (stepId.includes('inspect') || stepId.includes('identify') || stepId.includes('discover')) return ['inspectionResult']
  if (stepId.includes('run') || stepId.includes('command') || stepId.includes('cli')) return ['commandResult']
  if (
    stepId.includes('open') ||
    stepId.includes('navigate') ||
    stepId.includes('visit') ||
    stepId.includes('fill') ||
    stepId.includes('add') ||
    stepId.includes('submit') ||
    stepId.includes('interact') ||
    stepId.includes('click') ||
    stepId.includes('select') ||
    stepId.includes('start') ||
    stepId.includes('save') ||
    stepId.includes('create') ||
    stepId.includes('update')
  ) {
    return ['commandResult']
  }
  return [`${toCamelCase(normalizeId(stepId))}Result`]
}

function inferCapabilityId(stepId: NormalizedStep) {
  if (stepId === 'fill_customer_email') return 'fillCustomerEmail'
  if (stepId === 'add_cart_item') return 'addCartItem'
  if (stepId === 'submit_order') return 'submitOrder'
  if (stepId === 'open_primary_route') return 'openPrimaryRoute'
  if (stepId === 'interact_with_primary_action') return 'interactWithPrimaryAction'
  if (stepId === 'verify_primary_feedback') return 'verifyPrimaryFeedback'
  if (stepId === 'start_api_service') return 'startApiService'
  if (stepId === 'call_health_endpoint') return 'callHealthEndpoint'
  if (stepId === 'call_primary_endpoint') return 'callPrimaryEndpoint'
  if (stepId === 'verify_api_response') return 'verifyApiResponse'
  if (stepId === 'run_cli_help') return 'runCliHelp'
  if (stepId === 'verify_cli_output') return 'verifyCliOutput'
  if (stepId === 'inspect_package_exports') return 'inspectPackageExports'
  if (stepId === 'verify_public_api_docs') return 'verifyPublicApiDocs'
  if (stepId === 'inspect_repository_structure') return 'inspectRepositoryStructure'
  if (stepId === 'identify_test_entrypoints') return 'identifyTestEntrypoints'
  return toCamelCase(normalizeId(stepId))
}

function inferStepRole(stepId: NormalizedStep, fallbackRoles: string[]) {
  if (
    stepId === 'fill_customer_email' ||
    stepId === 'add_cart_item' ||
    stepId === 'submit_order' ||
    stepId === 'open_primary_route' ||
    stepId === 'interact_with_primary_action' ||
    stepId === 'verify_primary_feedback'
  ) return 'primary_user'
  if (
    stepId === 'start_api_service' ||
    stepId === 'call_health_endpoint' ||
    stepId === 'call_primary_endpoint' ||
    stepId === 'verify_api_response'
  ) return 'api_consumer'
  if (stepId === 'run_cli_help' || stepId === 'verify_cli_output') return 'cli_user'
  if (stepId === 'inspect_package_exports' || stepId === 'verify_public_api_docs') return 'integration_developer'
  if (stepId === 'inspect_repository_structure' || stepId === 'identify_test_entrypoints') return 'repository_reviewer'
  return fallbackRoles[0] ?? 'primary_user'
}

function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return pad + '[]'
    return value
      .map((item) => {
        if (item && typeof item === 'object') {
          const nested = toYaml(item, indent + 1)
          const lines = nested.split('\n')
          return pad + '- ' + lines[0].trimStart() + (lines.length > 1 ? '\n' + lines.slice(1).join('\n') : '')
        }
        return pad + '- ' + String(item)
      })
      .join('\n')
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        if (Array.isArray(item)) {
          if (item.length === 0) return pad + key + ': []'
          return pad + key + ':\n' + toYaml(item, indent + 1)
        }
        if (item && typeof item === 'object') {
          return pad + key + ':\n' + toYaml(item, indent + 1)
        }
        return pad + key + ': ' + String(item)
      })
      .join('\n')
  }

  return pad + String(value)
}

function normalizeReport(report: DiscoveryReport): DiscoveryReport {
  return {
    framework: report.framework,
    repository: report.repository,
    domainDiscovery: report.domainDiscovery,
    surfaces: report.surfaces.map((surface) => ({
      ...surface,
      id: normalizeId(surface.id || surface.label),
    })),
    roles: report.roles.map((role) => ({
      ...role,
      id: normalizeId(role.id),
      confidence: normalizeConfidence(role.confidence),
    })),
    risks: report.risks,
  }
}

function inferRouteForSurface(surface: DiscoveryReport['surfaces'][number]) {
  if (surface.id === 'health_endpoint') return '/health'
  if (surface.id === 'api_service') return '/'
  if (
    surface.id.includes('root') ||
    surface.label.toLowerCase().includes('root') ||
    surface.evidence.some((item) => item.replace(/\\/g, '/').endsWith('index.html'))
  ) return '/'
  if (
    surface.id === 'cli_entrypoint' ||
    surface.id === 'package_api' ||
    surface.id === 'repository_structure'
  ) return 'not_applicable'

  for (const evidence of surface.evidence) {
    const route = extractRoutePathFromEvidence(evidence)
    if (route && route !== '/') return route
  }
  return 'unresolved'
}

async function readTextIfExists(filePath: string) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

async function copyFileIfExists(sourcePath: string, targetPath: string) {
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.copyFile(sourcePath, targetPath)
    return true
  } catch {
    return false
  }
}

async function copyDirRecursiveIfExists(sourceDir: string, targetDir: string): Promise<string[]> {
  const copied: string[] = []
  try {
    const entries = await fs.readdir(sourceDir, { withFileTypes: true })
    await fs.mkdir(targetDir, { recursive: true })
    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name)
      const targetPath = path.join(targetDir, entry.name)
      if (entry.isDirectory()) {
        copied.push(...await copyDirRecursiveIfExists(sourcePath, targetPath))
      } else if (entry.isFile()) {
        await fs.copyFile(sourcePath, targetPath)
        copied.push(targetPath)
      }
    }
  } catch {
    return copied
  }
  return copied
}

async function removeGeneratedFilesIfExists(directory: string) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.includes('.generated.')) return
      await fs.rm(path.join(directory, entry.name), { force: true })
    }))
  } catch {
    return
  }
}

const LOGIN_ROUTE = /(?:^|\/)(login|sign-in|signin|log-in)(?:\/|$)/i

function detectLoginRoute(report: DiscoveryReport): string | null {
  for (const surface of report.surfaces) {
    for (const evidence of surface.evidence ?? []) {
      const route = extractRoutePathFromEvidence(evidence)
      if (route && route.startsWith('/') && LOGIN_ROUTE.test(route)) return route
    }
  }
  return null
}

async function detectAuthProviders(repoPath: string): Promise<string[]> {
  const repoRoot = await fs.realpath(repoPath)
  const packageText = await readTextIfExists(path.join(repoRoot, 'package.json'))
  if (!packageText) return []
  const lower = packageText.toLowerCase()
  const providers: string[] = []
  if (lower.includes('next-auth') || lower.includes('@auth/')) providers.push('next-auth')
  if (lower.includes('keycloak')) providers.push('keycloak')
  return providers
}

async function detectAuth(repoPath: string, report: DiscoveryReport) {
  if (report.repository && report.repository.kind !== 'frontend') {
    return {
      loginEntryPoint: 'not_applicable',
      supportsRoleSwitch: false,
      detectedProviders: [],
      sessionHints: [
        `no browser login inferred for ${report.repository.kind} repository`,
        'map runtime credentials or environment manually before promoting executable scenarios',
      ],
    }
  }

  const loginEntryPoint = detectLoginRoute(report)
  const detectedProviders = await detectAuthProviders(repoPath)
  if (!loginEntryPoint) {
    return {
      loginEntryPoint: 'not_applicable',
      supportsRoleSwitch: false,
      detectedProviders,
      sessionHints: [
        'no login surface detected in repository evidence',
        detectedProviders.length > 0 ? `detected providers: ${detectedProviders.join(', ')}` : null,
      ].filter((hint): hint is string => Boolean(hint)),
    }
  }

  return {
    loginEntryPoint,
    supportsRoleSwitch: false,
    detectedProviders,
    sessionHints: [
      `login surface detected at ${loginEntryPoint}`,
      detectedProviders.length > 0 ? `detected providers: ${detectedProviders.join(', ')}` : null,
      'review cookie/session handling before activation',
    ].filter((hint): hint is string => Boolean(hint)),
  }
}

function buildMaterializedRoutes(report: DiscoveryReport): MaterializedRoute[] {
  return report.surfaces.map((surface) => ({
    id: surface.id,
    path: inferRouteForSurface(surface),
    purpose: `${surface.kind}: ${surface.label}`,
    evidence: surface.evidence,
  }))
}

function inferCapabilityRouteHint(capabilityId: string, routes: MaterializedRoute[]) {
  const routeMap: Record<string, string[]> = {
    fillCustomerEmail: ['/'],
    addCartItem: ['/'],
    submitOrder: ['/'],
    openPrimaryRoute: ['/'],
    interactWithPrimaryAction: ['/'],
    verifyPrimaryFeedback: ['/'],
    startApiService: ['/'],
    callHealthEndpoint: ['/health', '/ready', '/live'],
    callPrimaryEndpoint: ['/api', '/v1', '/v2', '/graphql', '/'],
    verifyApiResponse: ['/api', '/health', '/ready', '/live', '/'],
  }
  const candidates = routeMap[capabilityId] ?? []
  const route = routes.find((item) => (
    item.path !== 'unresolved' &&
    item.path !== '/TODO' &&
    candidates.some((candidate) => item.path.startsWith(candidate))
  ))
  return route?.path ?? candidates[0]
}

function buildMaterializedCapabilities(capabilityIds: string[], routes: MaterializedRoute[]): MaterializedCapability[] {
  const purposeByCapability: Record<string, string> = {
    fillCustomerEmail: 'Fill the primary customer email or identity field.',
    addCartItem: 'Add an item through the primary frontend interaction.',
    submitOrder: 'Submit the primary order or checkout form.',
    openPrimaryRoute: 'Open the primary frontend route.',
    interactWithPrimaryAction: 'Execute the main visible user action.',
    verifyPrimaryFeedback: 'Verify the primary success, feedback, or confirmation state.',
    captureScreenshot: 'Capture visual evidence from the active frontend page.',
    startApiService: 'Start or connect to the target API service.',
    callHealthEndpoint: 'Call the detected API health/readiness endpoint.',
    callPrimaryEndpoint: 'Call a primary API endpoint selected during review.',
    verifyApiResponse: 'Verify response status, schema, and core API contract expectations.',
    runCliHelp: 'Execute the CLI help command for the detected command-line entrypoint.',
    verifyCliOutput: 'Verify CLI output, exit code, and expected command contract.',
    inspectPackageExports: 'Inspect package export metadata and import surface.',
    verifyPublicApiDocs: 'Verify public API documentation or entrypoint evidence.',
    inspectRepositoryStructure: 'Inspect repository structure and classify available runtime surfaces.',
    identifyTestEntrypoints: 'Identify test commands, smoke commands, or runtime entrypoints.',
  }

  return capabilityIds.map((capabilityId) => ({
    id: capabilityId,
    purpose: purposeByCapability[capabilityId] ?? `Execute ${toTitle(capabilityId)} from the normalized discovery draft.`,
    sourceHint: 'Review and map this capability to host-specific automation',
    routeHint: inferCapabilityRouteHint(capabilityId, routes),
  }))
}

function buildMaterializedArtifactsFromDomainBundle(
  bundle: DomainDiscoveryBundle,
  routes: MaterializedRoute[],
): MaterializedDiscoveryArtifacts | null {
  if (bundle.personas.length === 0 || bundle.scenarios.length === 0 || bundle.capabilities.length === 0) return null

  const capabilities: MaterializedCapability[] = bundle.capabilities.map((capability) => ({
    id: normalizeId(capability.id),
    purpose: capability.purpose,
    sourceHint: capability.kind,
    routeHint: inferCapabilityRouteHint(normalizeId(capability.id), routes),
  }))

  const personas: MaterializedPersona[] = bundle.personas.map((persona) => ({
    id: normalizeId(persona.id),
    title: persona.title,
    goal: persona.rationale,
    allowedCapabilities: persona.allowedCapabilityIds.map(normalizeId),
  }))

  const scenarioPersonaMap = new Map(personas.map((persona) => [persona.id, persona]))
  const scenarios: MaterializedScenario[] = bundle.scenarios.map((scenario) =>
    materializeDomainScenario(scenario, bundle.personas, scenarioPersonaMap),
  )

  return { capabilities, personas, scenarios }
}

function applyCapabilityGraphHints(capabilities: MaterializedCapability[], codeGraph: CodeGraph): MaterializedCapability[] {
  const hintByCapabilityId = buildCapabilityGraphHintMap(codeGraph)
  return capabilities.map((capability) => ({
    ...capability,
    graphHint: hintByCapabilityId.get(capability.id) ?? undefined,
    routeHint: inferCapabilityRouteHintFromGraph(capability, hintByCapabilityId.get(capability.id)),
  }))
}

function buildCapabilityGraphHintMap(codeGraph: CodeGraph) {
  const nodeById = new Map(codeGraph.nodes.map((node) => [node.id, node]))
  const edgeByType = new Map<string, CodeGraphEdge[]>()
  for (const edge of codeGraph.edges) {
    const list = edgeByType.get(edge.type) ?? []
    list.push(edge)
    edgeByType.set(edge.type, list)
  }

  const incomingEdgesByNode = new Map<string, CodeGraphEdge[]>()
  const outgoingEdgesByNode = new Map<string, CodeGraphEdge[]>()
  for (const edge of codeGraph.edges) {
    const list = incomingEdgesByNode.get(edge.to) ?? []
    list.push(edge)
    incomingEdgesByNode.set(edge.to, list)
    const outgoing = outgoingEdgesByNode.get(edge.from) ?? []
    outgoing.push(edge)
    outgoingEdgesByNode.set(edge.from, outgoing)
  }

  const hintByCapabilityId = new Map<string, MaterializedCapability['graphHint']>()
  const endpointNodes = codeGraph.nodes.filter((node) => node.type === 'endpoint')

  for (const capabilityNode of codeGraph.nodes.filter((node) => node.type === 'capability_candidate')) {
    const capabilityId = typeof capabilityNode.metadata['capabilityId'] === 'string'
      ? capabilityNode.metadata['capabilityId']
      : null
    if (!capabilityId) continue

    const supportEdges = (incomingEdgesByNode.get(capabilityNode.id) ?? []).filter((edge) => edge.type === 'supports_capability')
    const mappedSurfaceEdges = (edgeByType.get('maps_surface') ?? []).filter((edge) => edge.from === capabilityNode.id)
    const surfaceNodeIds = mappedSurfaceEdges.map((edge) => edge.to)
    const uiHandlerEdges = surfaceNodeIds.flatMap((surfaceNodeId) =>
      (incomingEdgesByNode.get(surfaceNodeId) ?? []).filter((edge) =>
        edge.type === 'handles' && edge.metadata?.['source'] === 'jsx_event_handler',
      ),
    )

    const endpointNodes = supportEdges
      .map((edge) => nodeById.get(edge.from))
      .filter((node): node is CodeGraphNode => Boolean(node?.type === 'endpoint'))
    const httpCallNodes = supportEdges
      .map((edge) => nodeById.get(edge.from))
      .filter((node): node is CodeGraphNode => Boolean(node?.type === 'http_call'))

    const handlerNodeIds = new Set<string>()
    for (const edge of uiHandlerEdges) handlerNodeIds.add(edge.from)
    for (const endpointNode of endpointNodes) {
      for (const edge of incomingEdgesByNode.get(endpointNode.id) ?? []) {
        if (edge.type === 'handles') handlerNodeIds.add(edge.from)
      }
    }
    for (const httpCallNode of httpCallNodes) {
      for (const edge of incomingEdgesByNode.get(httpCallNode.id) ?? []) {
        if (edge.type === 'calls') handlerNodeIds.add(edge.from)
      }
    }

    const downstream = collectTransitiveFunctionSupport({
      startNodeIds: [...handlerNodeIds],
      nodeById,
      outgoingEdgesByNode,
    })
    const upstreamFromHttpCalls = collectUpstreamFunctionSupport({
      startNodeIds: httpCallNodes.map((node) => node.id),
      nodeById,
      incomingEdgesByNode,
    })
    for (const handlerNodeId of downstream.handlerNodeIds) handlerNodeIds.add(handlerNodeId)
    for (const handlerNodeId of upstreamFromHttpCalls.handlerNodeIds) handlerNodeIds.add(handlerNodeId)

    const handlers = [...handlerNodeIds]
      .map((id) => nodeById.get(id))
      .filter((node): node is CodeGraphNode => Boolean(node && ['function', 'handler', 'service'].includes(node.type)))
      .map(formatGraphNodeHint)

    const endpoints = endpointNodes.map(formatEndpointHint)
    const httpCalls = uniqueStrings([
      ...httpCallNodes.map(formatHttpCallHint),
      ...downstream.httpCallNodeIds
        .map((id) => nodeById.get(id))
        .filter((node): node is CodeGraphNode => Boolean(node?.type === 'http_call'))
        .map(formatHttpCallHint),
    ])

    const rawMapping = capabilityNode.metadata['graphMapping']
    const mapping = rawMapping && typeof rawMapping === 'object' && !Array.isArray(rawMapping)
      ? rawMapping as Record<string, unknown>
      : undefined
    const mappedConfidence = typeof mapping?.['confidence'] === 'number'
      ? mapping['confidence']
      : Math.max(0, ...supportEdges.map((edge) => edge.confidence ?? 0), handlers.length > 0 ? 0.45 : 0)
    const hasMappedSupport = supportEdges.length > 0
    const mappedHandlerIds = readStringArray(mapping?.['handlerIds'])
    const mappedEndpointIds = readStringArray(mapping?.['endpointIds'])
    const mappedHttpCallIds = readStringArray(mapping?.['httpCallIds'])
    const mappedResolver = typeof mapping?.['resolver'] === 'string' ? mapping['resolver'] : undefined

    hintByCapabilityId.set(capabilityId, {
      status: hasMappedSupport ? 'mapped' : handlers.length > 0 ? 'ui_handler_linked' : 'unmapped',
      confidence: Number(mappedConfidence.toFixed(3)),
      resolver: mappedResolver,
      handlers: uniqueStrings(handlers),
      endpoints: uniqueStrings(endpoints),
      httpCalls: uniqueStrings(httpCalls),
      handlerIds: uniqueStrings([...mappedHandlerIds, ...handlerNodeIds]),
      endpointIds: uniqueStrings([...mappedEndpointIds, ...endpointNodes.map((node) => node.id)]),
      httpCallIds: uniqueStrings([...mappedHttpCallIds, ...httpCallNodes.map((node) => node.id), ...downstream.httpCallNodeIds]),
    })
  }

  if (codeGraph.repositoryKind === 'backend_api') {
    const healthEndpointNode = selectBackendHealthEndpoint(endpointNodes)
    const primaryEndpointNode = selectBackendPrimaryEndpoint(endpointNodes)
    applyBackendCapabilityFallback(hintByCapabilityId, 'callHealthEndpoint', healthEndpointNode, nodeById, incomingEdgesByNode, outgoingEdgesByNode, edgeByType)
    applyBackendCapabilityFallback(hintByCapabilityId, 'callPrimaryEndpoint', primaryEndpointNode ?? healthEndpointNode, nodeById, incomingEdgesByNode, outgoingEdgesByNode, edgeByType)
    const verificationTarget = primaryEndpointNode ?? healthEndpointNode
    applyBackendCapabilityFallback(hintByCapabilityId, 'verifyApiResponse', verificationTarget, nodeById, incomingEdgesByNode, outgoingEdgesByNode, edgeByType, 0.38)
  }

  return hintByCapabilityId
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function inferCapabilityRouteHintFromGraph(
  capability: MaterializedCapability,
  graphHint: MaterializedCapability['graphHint'] | undefined,
) {
  const currentRouteHint = capability.routeHint
  const endpointPath = selectPreferredEndpointPath(graphHint?.endpoints ?? [])
  if (!endpointPath) return currentRouteHint

  if (!currentRouteHint || currentRouteHint === '/' || currentRouteHint === '/TODO' || currentRouteHint === 'unresolved') {
    return endpointPath
  }

  if (capability.id === 'verifyApiResponse' && currentRouteHint === '/') {
    return endpointPath
  }

  return currentRouteHint
}

function selectPreferredEndpointPath(endpointHints: string[]) {
  const endpointPaths = endpointHints
    .map((hint) => extractRoutePathFromEvidence(hint))
    .filter((path): path is string => Boolean(path))
  const nonHealth = prioritizeBackendPaths(endpointPaths).find((path) => !isHealthLikeRoutePath(path) && path !== '/')
  return nonHealth ?? endpointPaths[0]
}

function isHealthLikeRoutePath(routePath: string) {
  return /health|heartbeat|readiness|liveness|ready|live/i.test(routePath)
}

function selectBackendHealthEndpoint(endpointNodes: CodeGraphNode[]) {
  return endpointNodes.find((node) => {
    const routePath = typeof node.metadata['path'] === 'string' ? node.metadata['path'] : ''
    return isHealthLikeRoutePath(routePath)
  })
}

function selectBackendPrimaryEndpoint(endpointNodes: CodeGraphNode[]) {
  return prioritizeBackendEndpointNodes(endpointNodes).find((node) => {
    const routePath = typeof node.metadata['path'] === 'string' ? node.metadata['path'] : ''
    return Boolean(routePath) && routePath !== '/' && !isHealthLikeRoutePath(routePath)
  })
}

function prioritizeBackendEndpointNodes(endpointNodes: CodeGraphNode[]) {
  return [...endpointNodes].sort((left, right) => {
    const leftPath = typeof left.metadata['path'] === 'string' ? left.metadata['path'] : left.label
    const rightPath = typeof right.metadata['path'] === 'string' ? right.metadata['path'] : right.label
    const leftMounted = left.metadata['isMountedRoute'] === true
    const rightMounted = right.metadata['isMountedRoute'] === true
    const leftMountChainLength = Array.isArray(left.metadata['mountChain']) ? left.metadata['mountChain'].length : 0
    const rightMountChainLength = Array.isArray(right.metadata['mountChain']) ? right.metadata['mountChain'].length : 0
    const leftScore = backendPathPriority(leftPath) + (leftMounted ? 25 : 0) + leftMountChainLength * 5
    const rightScore = backendPathPriority(rightPath) + (rightMounted ? 25 : 0) + rightMountChainLength * 5
    return rightScore - leftScore
  })
}

function prioritizeBackendPaths(paths: string[]) {
  return [...paths].sort((left, right) => backendPathPriority(right) - backendPathPriority(left))
}

function backendPathPriority(routePath: string) {
  const segments = routePath.split('/').filter(Boolean).length
  const apiBoost = /\/api\/|^\/api$|\/v\d+\//i.test(routePath) ? 10 : 0
  return apiBoost + segments * 2 + routePath.length / 100
}

function applyBackendCapabilityFallback(
  hintByCapabilityId: Map<string, MaterializedCapability['graphHint']>,
  capabilityId: string,
  endpointNode: CodeGraphNode | undefined,
  nodeById: Map<string, CodeGraphNode>,
  incomingEdgesByNode: Map<string, CodeGraphEdge[]>,
  outgoingEdgesByNode: Map<string, CodeGraphEdge[]>,
  edgeByType: Map<string, CodeGraphEdge[]>,
  confidence = 0.42,
) {
  const existingHint = hintByCapabilityId.get(capabilityId)
  if (existingHint && existingHint.status === 'mapped') return
  if (!endpointNode) return

  const handlerNodeIds = new Set<string>()
  for (const edge of incomingEdgesByNode.get(endpointNode.id) ?? []) {
    if (edge.type === 'handles' || edge.type === 'calls') handlerNodeIds.add(edge.from)
  }
  const linkedHttpCallIds = (edgeByType.get('calls') ?? [])
    .filter((edge) => edge.to === endpointNode.id)
    .map((edge) => edge.from)

  const handlers = [...handlerNodeIds]
    .map((id) => nodeById.get(id))
    .filter((node): node is CodeGraphNode => Boolean(node && ['function', 'handler', 'service', 'http_call'].includes(node.type)))
    .map((node) => node.type === 'http_call' ? formatHttpCallHint(node) : formatGraphNodeHint(node))

  const downstream = collectTransitiveFunctionSupport({
    startNodeIds: [...handlerNodeIds],
    nodeById,
    outgoingEdgesByNode,
  })
  const upstreamFromHttpCalls = collectUpstreamFunctionSupport({
    startNodeIds: linkedHttpCallIds,
    nodeById,
    incomingEdgesByNode,
  })

  const httpCalls = uniqueStrings([
    ...linkedHttpCallIds
    .map((id) => nodeById.get(id))
    .filter((node): node is CodeGraphNode => Boolean(node?.type === 'http_call'))
    .map(formatHttpCallHint),
    ...downstream.httpCallNodeIds
      .map((id) => nodeById.get(id))
      .filter((node): node is CodeGraphNode => Boolean(node?.type === 'http_call'))
      .map(formatHttpCallHint),
  ])

  const expandedHandlers = uniqueStrings([
    ...(existingHint?.handlers ?? []),
    ...handlers,
    ...downstream.handlerNodeIds
      .map((id) => nodeById.get(id))
      .filter((node): node is CodeGraphNode => Boolean(node && ['function', 'handler', 'service'].includes(node.type)))
      .map(formatGraphNodeHint),
    ...upstreamFromHttpCalls.handlerNodeIds
      .map((id) => nodeById.get(id))
      .filter((node): node is CodeGraphNode => Boolean(node && ['function', 'handler', 'service'].includes(node.type)))
      .map(formatGraphNodeHint),
  ])

  hintByCapabilityId.set(capabilityId, {
    status: 'mapped',
    confidence,
    handlers: expandedHandlers,
    resolver: existingHint?.resolver,
    endpoints: uniqueStrings([...(existingHint?.endpoints ?? []), formatEndpointHint(endpointNode)]),
    httpCalls: uniqueStrings([...(existingHint?.httpCalls ?? []), ...httpCalls]),
    handlerIds: uniqueStrings([...(existingHint?.handlerIds ?? []), ...handlerNodeIds, ...downstream.handlerNodeIds, ...upstreamFromHttpCalls.handlerNodeIds]),
    endpointIds: uniqueStrings([...(existingHint?.endpointIds ?? []), endpointNode.id]),
    httpCallIds: uniqueStrings([...(existingHint?.httpCallIds ?? []), ...linkedHttpCallIds, ...downstream.httpCallNodeIds]),
  })
}

function collectTransitiveFunctionSupport(input: {
  startNodeIds: string[]
  nodeById: Map<string, CodeGraphNode>
  outgoingEdgesByNode: Map<string, CodeGraphEdge[]>
  maxDepth?: number
}) {
  const handlerNodeIds = new Set<string>()
  const httpCallNodeIds = new Set<string>()
  const visited = new Set<string>()
  const maxDepth = input.maxDepth ?? 5
  const queue = input.startNodeIds
    .filter(Boolean)
    .map((id) => ({ id, depth: 0 }))

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || visited.has(current.id) || current.depth > maxDepth) continue
    visited.add(current.id)

    for (const edge of input.outgoingEdgesByNode.get(current.id) ?? []) {
      if (edge.type !== 'calls') continue
      const targetNode = input.nodeById.get(edge.to)
      if (!targetNode) continue
      if (targetNode.type === 'http_call') {
        httpCallNodeIds.add(targetNode.id)
        continue
      }
      if (!['function', 'handler', 'service'].includes(targetNode.type)) continue
      handlerNodeIds.add(targetNode.id)
      queue.push({ id: targetNode.id, depth: current.depth + 1 })
    }
  }

  return {
    handlerNodeIds: [...handlerNodeIds],
    httpCallNodeIds: [...httpCallNodeIds],
  }
}

function collectUpstreamFunctionSupport(input: {
  startNodeIds: string[]
  nodeById: Map<string, CodeGraphNode>
  incomingEdgesByNode: Map<string, CodeGraphEdge[]>
  maxDepth?: number
}) {
  const handlerNodeIds = new Set<string>()
  const visited = new Set<string>()
  const maxDepth = input.maxDepth ?? 5
  const queue = input.startNodeIds
    .filter(Boolean)
    .map((id) => ({ id, depth: 0 }))

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || visited.has(current.id) || current.depth > maxDepth) continue
    visited.add(current.id)

    for (const edge of input.incomingEdgesByNode.get(current.id) ?? []) {
      if (edge.type !== 'calls') continue
      const sourceNode = input.nodeById.get(edge.from)
      if (!sourceNode || !['function', 'handler', 'service', 'http_call'].includes(sourceNode.type)) continue
      if (sourceNode.type === 'http_call') {
        queue.push({ id: sourceNode.id, depth: current.depth + 1 })
        continue
      }
      handlerNodeIds.add(sourceNode.id)
      queue.push({ id: sourceNode.id, depth: current.depth + 1 })
    }
  }

  return {
    handlerNodeIds: [...handlerNodeIds],
  }
}

function formatGraphNodeHint(node: CodeGraphNode) {
  const filePath = node.source?.filePath
  const line = node.source?.line
  if (filePath && line) return `${node.label} (${filePath}:${line})`
  if (filePath) return `${node.label} (${filePath})`
  return node.label
}

function formatEndpointHint(node: CodeGraphNode) {
  const method = typeof node.metadata['method'] === 'string' ? node.metadata['method'] : 'ANY'
  const routePath = typeof node.metadata['path'] === 'string' ? node.metadata['path'] : node.label
  return `${method} ${routePath}`
}

function formatHttpCallHint(node: CodeGraphNode) {
  const method = typeof node.metadata['method'] === 'string' ? node.metadata['method'] : 'GET'
  const normalizedPath = typeof node.metadata['normalizedPath'] === 'string'
    ? node.metadata['normalizedPath']
    : typeof node.metadata['url'] === 'string'
      ? node.metadata['url']
      : node.label
  return `${method} ${normalizedPath}`
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

function materializeDomainScenario(
  scenario: ScenarioCandidate,
  personas: PersonaCandidate[],
  personaMap: Map<string, MaterializedPersona>,
): MaterializedScenario {
  const roles = scenario.participatingPersonaIds.map(normalizeId)
  const stepDefinitions = scenario.steps.map((step) => {
    const capabilityId = normalizeId(step.capabilityId ?? step.id)
    const roleId = inferRoleForDomainStep(capabilityId, roles, personas)
    return {
      id: normalizeId(step.id),
      roleId,
      capabilityId,
      producesArtifacts: inferProducedArtifacts(capabilityId),
    }
  })

  const allowedRoleSet = new Set(roles.filter((roleId) => personaMap.has(roleId)))

  return {
    id: normalizeId(scenario.id),
    title: scenario.title,
    roles: allowedRoleSet.size > 0 ? [...allowedRoleSet] : roles,
    steps: stepDefinitions.map((step) => step.id),
    expectedArtifacts: [...new Set(stepDefinitions.flatMap((step) => step.producesArtifacts))],
    stepDefinitions,
  }
}

function inferRoleForDomainStep(
  capabilityId: string,
  scenarioRoleIds: string[],
  personas: PersonaCandidate[],
) {
  const normalizedCapabilityId = normalizeId(capabilityId)
  const normalizedRoles = scenarioRoleIds.map(normalizeId)

  if (/(assert|verify|review|report|copy)/.test(normalizedCapabilityId)) {
    const reviewerRole = normalizedRoles.find((roleId) => roleId.includes('reviewer'))
    if (reviewerRole) return reviewerRole
  }

  const matchingPersona = personas.find((persona) => (
    scenarioRoleIds.includes(normalizeId(persona.id))
      && persona.allowedCapabilityIds.map(normalizeId).includes(normalizedCapabilityId)
  ))

  return normalizeId(matchingPersona?.id ?? scenarioRoleIds[0] ?? 'primary_user')
}

function buildRuntimePlan(input: {
  auth: Awaited<ReturnType<typeof detectAuth>>
  routes: MaterializedRoute[]
  capabilities: MaterializedCapability[]
  scenarios: MaterializedScenario[]
  repositoryKind?: string
  codeGraph?: CodeGraph
}): RuntimePlan {
  const requiresBrowser = !input.repositoryKind || input.repositoryKind === 'frontend'

  return {
    loginEntryPoint: input.auth.loginEntryPoint,
    providers: input.auth.detectedProviders,
    repositoryKind: input.repositoryKind,
    runtimeMode: requiresBrowser ? 'browser_model' : 'deterministic_non_browser',
    requiresBrowser,
    requiresAnthropicModel: requiresBrowser,
    routeCoverage: buildRuntimeRouteCoverage(input.routes, input.codeGraph),
    capabilityCoverage: input.capabilities.map((capability) => ({
      capabilityId: capability.id,
      routeHint: capability.routeHint,
      implementationStatus: 'stub',
      graphStatus: capability.graphHint?.status,
      graphConfidence: capability.graphHint?.confidence,
      graphResolver: capability.graphHint?.resolver,
      handlerHints: capability.graphHint?.handlers ?? [],
      endpointHints: capability.graphHint?.endpoints ?? [],
      httpCallHints: capability.graphHint?.httpCalls ?? [],
      handlerNodeIds: capability.graphHint?.handlerIds ?? [],
      endpointNodeIds: capability.graphHint?.endpointIds ?? [],
      httpCallNodeIds: capability.graphHint?.httpCallIds ?? [],
    })),
    scenarioCoverage: input.scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      steps: scenario.steps,
    })),
  }
}

function buildRuntimeRouteCoverage(routes: MaterializedRoute[], codeGraph?: CodeGraph) {
  const routeCoverage = new Map<string, { routeId: string; path: string; purpose: string }>()

  for (const route of routes) {
    routeCoverage.set(`${route.id}:${route.path}`, {
      routeId: route.id,
      path: route.path,
      purpose: route.purpose,
    })
  }

  for (const endpointNode of codeGraph?.nodes.filter((node) => node.type === 'endpoint') ?? []) {
    const routePath = typeof endpointNode.metadata['path'] === 'string' ? endpointNode.metadata['path'] : null
    if (!routePath) continue
    const method = typeof endpointNode.metadata['method'] === 'string' ? endpointNode.metadata['method'] : 'ANY'
    routeCoverage.set(`graph:${method}:${routePath}`, {
      routeId: `graph_${normalizeId(`${method}_${routePath}`)}`,
      path: routePath,
      purpose: `endpoint: ${method} ${routePath}`,
    })
  }

  return [...routeCoverage.values()]
}

function buildAuthRuntimeStub(auth: Awaited<ReturnType<typeof detectAuth>>) {
  if (auth.loginEntryPoint === 'not_applicable') {
    return `export const generatedAuthRuntime = {
  loginEntryPoint: ${JSON.stringify(auth.loginEntryPoint)},
  supportsRoleSwitch: false,
  detectedProviders: ${JSON.stringify(auth.detectedProviders)},
  sessionHints: ${JSON.stringify(auth.sessionHints, null, 2)},
} as const

export async function performHostLogin() {
  throw new Error('Browser login is not applicable for this generated adapter type.')
}

export async function switchHostRole() {
  throw new Error('Role switching is not applicable for this generated adapter type.')
}
`
  }

  const providerComment = auth.detectedProviders.length > 0
    ? auth.detectedProviders.join(', ')
    : 'none detected'
  return `export const generatedAuthRuntime = {
  loginEntryPoint: ${JSON.stringify(auth.loginEntryPoint)},
  supportsRoleSwitch: ${auth.supportsRoleSwitch ? 'true' : 'false'},
  detectedProviders: ${JSON.stringify(auth.detectedProviders)},
  sessionHints: ${JSON.stringify(auth.sessionHints, null, 2)},
} as const

export async function performHostLogin() {
  throw new Error('TODO: implement host login flow. Detected providers: ${providerComment}.')
}

export async function switchHostRole() {
  throw new Error('TODO: implement role switching / tenant switching for this host.')
}
`
}

function buildCapabilityRuntimeStub(capabilities: MaterializedCapability[]) {
  const handlers = capabilities
    .map((capability) => `  ${JSON.stringify(capability.id)}: async () => {
    throw new Error('TODO: implement ${capability.id}${capability.routeHint ? ` using route ${capability.routeHint}` : ''}${formatCapabilityGraphHintMessage(capability)}.')
  },`)
    .join('\n')

  return `export const generatedCapabilityHandlers = {
${handlers}
} as const
`
}

function formatCapabilityGraphHintMessage(capability: MaterializedCapability) {
  const graphHint = capability.graphHint
  if (!graphHint) return ''
  const parts: string[] = []
  if (graphHint.handlers.length > 0) parts.push(`handlers: ${graphHint.handlers.join(', ')}`)
  if (graphHint.endpoints.length > 0) parts.push(`endpoints: ${graphHint.endpoints.join(', ')}`)
  if (graphHint.httpCalls.length > 0) parts.push(`http calls: ${graphHint.httpCalls.join(', ')}`)
  if (parts.length === 0) return ''
  return `; graph hints -> ${parts.join(' | ')}`
}

function buildAssertionsStub(scenarios: MaterializedScenario[]) {
  const assertions = scenarios
    .map((scenario) => {
      const functionName = `assert_${scenario.id}`
      return `export async function ${functionName}() {
  throw new Error('TODO: implement assertions for ${scenario.id} (${scenario.steps.join(' -> ')}).')
}`
    })
    .join('\n\n')

  return `${assertions}
`
}

function buildReferenceBridge(_capabilities: MaterializedCapability[]): ReferenceBridgeEntry[] {
  return []
}

function appendUnique<T extends string>(items: T[], value: T | null | undefined) {
  if (!value) return
  if (!items.includes(value)) items.push(value)
}

function buildNormalizedPersonas(_report: DiscoveryReport, draft: BootstrapDraft): GeneratedPersonaDraft[] {
  return draft.personas.map((persona) => ({
    id: normalizeId(persona.id),
    title: persona.title,
    rationale: persona.rationale,
    allowedTools: persona.allowedTools,
  }))
}

function buildNormalizedScenarios(_report: DiscoveryReport, draft: BootstrapDraft, _personas: GeneratedPersonaDraft[]): GeneratedScenarioDraft[] {
  return draft.scenarios.map((scenario) => ({
    id: normalizeId(scenario.id),
    title: scenario.title,
    participatingRoles: scenario.participatingRoles.map(normalizeId),
    rationale: scenario.rationale,
    candidateSteps: normalizeFallbackSteps(scenario.candidateSteps),
  }))
}

function normalizeFallbackSteps(steps: string[]): string[] {
  const normalized: string[] = []
  for (const step of steps) {
    const candidate = classifyFallbackStep(step)
    appendUnique(normalized, candidate ?? normalizeId(step))
  }
  return normalized
}

function classifyFallbackStep(step: string): NormalizedStep | null {
  const text = toLowerEvidence(step)
  if (text.includes('email')) return 'fill_customer_email'
  if (text.includes('cart') || text.includes('item')) return 'add_cart_item'
  if (text.includes('order') || text.includes('submit') || text.includes('checkout')) return 'submit_order'
  if (text.includes('open') && (text.includes('route') || text.includes('page'))) return 'open_primary_route'
  if (text.includes('action') || text.includes('button') || text.includes('interact')) return 'interact_with_primary_action'
  if (text.includes('feedback') || text.includes('confirmation') || text.includes('success')) return 'verify_primary_feedback'
  if (text.includes('health') || text.includes('readiness') || text.includes('liveness')) return 'call_health_endpoint'
  if (text.includes('api') && (text.includes('call') || text.includes('request') || text.includes('endpoint'))) return 'call_primary_endpoint'
  if (text.includes('response') || text.includes('schema') || text.includes('contract')) return 'verify_api_response'
  if (text.includes('cli') && text.includes('help')) return 'run_cli_help'
  if (text.includes('cli') || text.includes('output') || text.includes('exit code')) return 'verify_cli_output'
  if (text.includes('export') || text.includes('import') || text.includes('package')) return 'inspect_package_exports'
  if (text.includes('docs') || text.includes('public api')) return 'verify_public_api_docs'
  if (text.includes('repository') || text.includes('structure')) return 'inspect_repository_structure'
  if (text.includes('test') || text.includes('entrypoint')) return 'identify_test_entrypoints'
  return null
}

function buildNormalizedDraft(report: DiscoveryReport, draft: BootstrapDraft): BootstrapDraft {
  const personas = buildNormalizedPersonas(report, draft)
  const scenarios = buildNormalizedScenarios(report, draft, personas)
  const capabilities = new Set<string>()

  for (const persona of personas) {
    for (const tool of persona.allowedTools) capabilities.add(tool)
  }

  for (const scenario of scenarios) {
    for (const step of scenario.candidateSteps) {
      const normalizedStep = step as NormalizedStep
      if (normalizedStep) {
        capabilities.add(inferCapabilityId(normalizedStep))
      }
    }
  }

  return {
    personas,
    scenarios,
    capabilityCandidates: [...capabilities],
    hostNotes: [
      ...draft.hostNotes,
      'Normalized from product surfaces and roles into agentic QA personas and executable scenario steps.',
    ],
  }
}

function buildMaterializedScenarios(scenarios: GeneratedScenarioDraft[]): MaterializedScenario[] {
  return scenarios.map((scenario) => {
    const normalizedSteps = scenario.candidateSteps as NormalizedStep[]
    return {
      id: scenario.id,
      title: scenario.title,
      roles: scenario.participatingRoles,
      steps: normalizedSteps,
      expectedArtifacts: normalizedSteps.flatMap((stepId) => inferProducedArtifacts(stepId)),
      stepDefinitions: normalizedSteps.map((stepId) => ({
        id: stepId,
        roleId: inferStepRole(stepId, scenario.participatingRoles),
        capabilityId: inferCapabilityId(stepId),
        producesArtifacts: inferProducedArtifacts(stepId),
      })),
    }
  })
}

export async function materializeLocalDiscovery(input: {
  repoPath: string
  report: DiscoveryReport
  draft: BootstrapDraft
}) {
  const localRoot = path.join(input.repoPath, '.agentic-qa')
  const adapterRoot = path.join(localRoot, 'adapter')
  const hostId = inferTargetId(input.repoPath)
  const normalizedReport = normalizeReport(input.report)
  const normalizedDraft = buildNormalizedDraft(normalizedReport, input.draft)
  const codeGraph = await buildCodeGraph({
    targetId: hostId,
    report: normalizedReport,
    draft: normalizedDraft,
    repoPath: input.repoPath,
  })
  const routes = buildMaterializedRoutes(normalizedReport)
  const auth = await detectAuth(input.repoPath, normalizedReport)

  const manifest = {
    id: hostId,
    label: hostId,
    hostProduct: hostId,
    framework: normalizedReport.framework ?? 'unknown',
    status: 'draft',
  }
  const domainArtifacts = normalizedReport.domainDiscovery
    ? buildMaterializedArtifactsFromDomainBundle(normalizedReport.domainDiscovery, routes)
    : null
  const baseCapabilities = domainArtifacts?.capabilities ?? buildMaterializedCapabilities(normalizedDraft.capabilityCandidates, routes)
  const capabilities = applyCapabilityGraphHints(baseCapabilities, codeGraph)

  const personas: MaterializedPersona[] = domainArtifacts?.personas ?? normalizedDraft.personas.map((persona) => ({
    id: persona.id,
    title: persona.title,
    goal: persona.rationale,
    allowedCapabilities: persona.allowedTools,
  }))

  const scenarios = domainArtifacts?.scenarios ?? buildMaterializedScenarios(normalizedDraft.scenarios)
  const publishedDraft: BootstrapDraft = {
    personas: personas.map((persona) => ({
      id: persona.id,
      title: persona.title,
      rationale: persona.goal,
      allowedTools: persona.allowedCapabilities,
    })),
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      participatingRoles: scenario.roles,
      rationale: normalizedDraft.scenarios.find((item) => item.id === scenario.id)?.rationale ?? scenario.title,
      candidateSteps: scenario.steps,
    })),
    capabilityCandidates: capabilities.map((capability) => capability.id),
    hostNotes: normalizedDraft.hostNotes,
  }
  const runtimePlan = buildRuntimePlan({
    auth,
    routes,
    capabilities,
    scenarios,
    repositoryKind: normalizedReport.repository?.kind,
    codeGraph,
  })
  const authRuntimeStub = buildAuthRuntimeStub(auth)
  const capabilityRuntimeStub = buildCapabilityRuntimeStub(capabilities)
  const assertionsRuntimeStub = buildAssertionsStub(scenarios)
  const referenceBridge = buildReferenceBridge(capabilities)

  const workflowContracts = scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    version: '1.0',
    deterministic: true,
    steps: scenario.stepDefinitions.map((step, index) => ({
      id: step.id,
      order: index,
      roleId: step.roleId,
      capabilityId: step.capabilityId,
      expectedArtifacts: [],
      producedArtifacts: step.producesArtifacts ?? [],
    })),
  }))

  await Promise.all([
    removeGeneratedFilesIfExists(path.join(adapterRoot, 'manifest')),
    removeGeneratedFilesIfExists(path.join(adapterRoot, 'auth')),
    removeGeneratedFilesIfExists(path.join(adapterRoot, 'routes')),
    removeGeneratedFilesIfExists(path.join(adapterRoot, 'capabilities')),
    removeGeneratedFilesIfExists(path.join(adapterRoot, 'personas')),
    removeGeneratedFilesIfExists(path.join(adapterRoot, 'scenarios')),
    removeGeneratedFilesIfExists(path.join(adapterRoot, 'config')),
    removeGeneratedFilesIfExists(path.join(adapterRoot, 'runtime')),
    removeGeneratedFilesIfExists(path.join(adapterRoot, 'assertions')),
    removeGeneratedFilesIfExists(path.join(adapterRoot, 'workflow-contracts')),
  ])

  const outputFiles: Array<readonly [string, unknown]> = [
    [path.join(adapterRoot, 'manifest', 'adapter-manifest.generated.json'), manifest],
    [path.join(adapterRoot, 'auth', 'auth.generated.json'), auth],
    [path.join(adapterRoot, 'routes', 'routes.generated.json'), routes],
    [path.join(adapterRoot, 'capabilities', 'capabilities.generated.json'), capabilities],
    [path.join(adapterRoot, 'personas', 'personas.generated.json'), personas],
    [path.join(adapterRoot, 'scenarios', 'scenarios.generated.json'), scenarios],
    [path.join(adapterRoot, 'config', 'discovery-report.generated.json'), normalizedReport],
    [path.join(adapterRoot, 'config', 'bootstrap-draft.generated.json'), publishedDraft],
    [path.join(adapterRoot, 'config', 'code-graph.generated.json'), codeGraph],
  ]

  if (normalizedReport.domainDiscovery) {
    outputFiles.push(
      [path.join(adapterRoot, 'config', 'domain-discovery-bundle.generated.json'), normalizedReport.domainDiscovery],
      [path.join(adapterRoot, 'config', 'frontend-surface-map.generated.json'), normalizedReport.domainDiscovery.surfaceMap],
    )
  }

  const writtenFiles: string[] = []
  for (const [filePath, payload] of outputFiles) {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
    writtenFiles.push(filePath)
  }

  const runtimeFiles: Array<[string, string]> = [
    [path.join(adapterRoot, 'runtime', 'runtime-plan.generated.json'), JSON.stringify(runtimePlan, null, 2)],
    [path.join(adapterRoot, 'runtime', 'auth-runtime.generated.ts'), authRuntimeStub],
    [path.join(adapterRoot, 'runtime', 'capability-handlers.generated.ts'), capabilityRuntimeStub],
    [path.join(adapterRoot, 'assertions', 'assertions.generated.ts'), assertionsRuntimeStub],
  ]

  for (const [filePath, content] of runtimeFiles) {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf8')
    writtenFiles.push(filePath)
  }

  const referenceBridgePath = path.join(adapterRoot, 'runtime', 'reference-bridge.generated.json')
  await fs.writeFile(referenceBridgePath, JSON.stringify(referenceBridge, null, 2), 'utf8')
  writtenFiles.push(referenceBridgePath)

  const snapshotRoot = path.join(adapterRoot, 'runtime', 'host-source-snapshot')
  const supportSource = path.join(input.repoPath, 'integration-test', 'persona-tests', 'support')
  const supportTarget = path.join(snapshotRoot, 'integration-test', 'persona-tests', 'support')
  writtenFiles.push(...await copyDirRecursiveIfExists(supportSource, supportTarget))

  const personaUtilsSource = path.join(input.repoPath, 'integration-test', 'persona-tests', 'utils')
  const personaUtilsTarget = path.join(snapshotRoot, 'integration-test', 'persona-tests', 'utils')
  writtenFiles.push(...await copyDirRecursiveIfExists(personaUtilsSource, personaUtilsTarget))

  const integrationUtilsSource = path.join(input.repoPath, 'integration-test', 'utils')
  const integrationUtilsTarget = path.join(snapshotRoot, 'integration-test', 'utils')
  writtenFiles.push(...await copyDirRecursiveIfExists(integrationUtilsSource, integrationUtilsTarget))

  const workflowIndex = workflowContracts.map((contract) => ({
    scenarioId: contract.scenarioId,
    file: path.join('workflow-contracts', contract.scenarioId + '.generated.yaml'),
  }))
  const workflowIndexPath = path.join(adapterRoot, 'workflow-contracts', 'index.generated.json')
  await fs.mkdir(path.dirname(workflowIndexPath), { recursive: true })
  await fs.writeFile(workflowIndexPath, JSON.stringify(workflowIndex, null, 2), 'utf8')
  writtenFiles.push(workflowIndexPath)

  for (const contract of workflowContracts) {
    const filePath = path.join(adapterRoot, 'workflow-contracts', contract.scenarioId + '.generated.yaml')
    await fs.writeFile(filePath, toYaml(contract) + '\n', 'utf8')
    writtenFiles.push(filePath)
  }

  return {
    repoPath: input.repoPath,
    localPackagePath: localRoot,
    adapterRoot,
    hostId,
    files: writtenFiles,
    report: normalizedReport,
    draft: publishedDraft,
  }
}
