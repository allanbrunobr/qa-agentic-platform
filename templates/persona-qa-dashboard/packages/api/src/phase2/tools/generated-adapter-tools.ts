import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ToolHandler, ToolMetadata, ToolResult } from '../types/tool-types.js'
import type { ToolRegistry } from '../services/tool-registry.js'
import {
  getGeneratedRepositoryKind,
  readGeneratedAdapterJson,
  resolveGeneratedTargetRepoPath,
} from '../services/generated-adapter-runtime.js'
import { confineEndpointUrl, confinePackageBin } from './endpoint-confinement.js'

interface PackageJson {
  name?: unknown
  scripts?: unknown
  bin?: unknown
  exports?: unknown
  types?: unknown
  main?: unknown
  module?: unknown
}

interface RuntimePlan {
  routeCoverage?: Array<{ path?: unknown; purpose?: unknown }>
}

interface GeneratedCapability {
  id?: unknown
  purpose?: unknown
  routeHint?: unknown
  sourceHint?: unknown
}

interface CapabilityCatalog {
  capabilities?: unknown
}

interface PageLike {
  goto?: (url: string, options?: Record<string, unknown>) => Promise<unknown>
  url?: () => string
  getByLabel?: (text: string | RegExp, options?: Record<string, unknown>) => LocatorLike
  getByPlaceholder?: (text: string | RegExp, options?: Record<string, unknown>) => LocatorLike
  getByRole?: (role: string, options?: Record<string, unknown>) => LocatorLike
  getByText?: (text: string | RegExp, options?: Record<string, unknown>) => LocatorLike
  locator?: (selector: string) => LocatorLike
  screenshot?: (options?: Record<string, unknown>) => Promise<unknown>
}

interface LocatorLike {
  first?: () => LocatorLike
  fill?: (value: string, options?: Record<string, unknown>) => Promise<unknown>
  click?: (options?: Record<string, unknown>) => Promise<unknown>
  count?: () => Promise<number>
  isVisible?: (options?: Record<string, unknown>) => Promise<boolean>
  textContent?: (options?: Record<string, unknown>) => Promise<string | null>
}

interface ProcessResult {
  command: string
  args: string[]
  cwd: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error?: string
  timedOut?: boolean
}

const IGNORED_TOP_LEVEL_NAMES = new Set([
  '.agentic-qa',
  '.git',
  '.next',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
])

export function registerGeneratedAdapterTools(registry: ToolRegistry): void {
  registry.register('startApiService', startApiServiceHandler, metadata({
    name: 'startApiService',
    description: 'Prepare the generated adapter to call the target API service',
    tags: ['generated-adapter', 'api'],
  }))
  registry.register('callHealthEndpoint', callHealthEndpointHandler, metadata({
    name: 'callHealthEndpoint',
    description: 'Call the configured or detected API health endpoint',
    inputSchema: pathInputSchema('/health'),
    tags: ['generated-adapter', 'api'],
  }))
  registry.register('callPrimaryEndpoint', callPrimaryEndpointHandler, metadata({
    name: 'callPrimaryEndpoint',
    description: 'Call the configured or detected primary API endpoint',
    inputSchema: pathInputSchema('/'),
    tags: ['generated-adapter', 'api'],
  }))
  registry.register('verifyApiResponse', verifyApiResponseHandler, metadata({
    name: 'verifyApiResponse',
    description: 'Verify the API response artifact produced by the generated adapter',
    tags: ['generated-adapter', 'api'],
  }))
  registry.register('runCliHelp', runCliHelpHandler, metadata({
    name: 'runCliHelp',
    description: 'Run the target CLI help command when a command entrypoint is available',
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'CLI arguments to pass to the command.',
        },
      },
    },
    tags: ['generated-adapter', 'cli'],
  }))
  registry.register('verifyCliOutput', verifyCliOutputHandler, metadata({
    name: 'verifyCliOutput',
    description: 'Verify CLI output, exit code, and command discovery evidence',
    tags: ['generated-adapter', 'cli'],
  }))
  registry.register('inspectPackageExports', inspectPackageExportsHandler, metadata({
    name: 'inspectPackageExports',
    description: 'Inspect package metadata and public export entrypoints',
    tags: ['generated-adapter', 'library'],
  }))
  registry.register('verifyPublicApiDocs', verifyPublicApiDocsHandler, metadata({
    name: 'verifyPublicApiDocs',
    description: 'Verify package README, types, exports, or public API documentation evidence',
    tags: ['generated-adapter', 'library'],
  }))
  registry.register('inspectRepositoryStructure', inspectRepositoryStructureHandler, metadata({
    name: 'inspectRepositoryStructure',
    description: 'Inspect target repository structure without assuming a browser runtime',
    tags: ['generated-adapter', 'repository'],
  }))
  registry.register('identifyTestEntrypoints', identifyTestEntrypointsHandler, metadata({
    name: 'identifyTestEntrypoints',
    description: 'Identify test, build, smoke, or runtime entrypoints from package scripts and files',
    tags: ['generated-adapter', 'repository'],
  }))

  registerGeneratedFrontendTools(registry)
}

const startApiServiceHandler: ToolHandler = async (): Promise<ToolResult> => {
  const targetRepoPath = resolveGeneratedTargetRepoPath()
  const baseUrl = resolveApiBaseUrl()
  const runtimePlan = readGeneratedAdapterJson<RuntimePlan>('runtime/runtime-plan.generated.json')

  return ok({
    serviceStarted: {
      mode: baseUrl ? 'external_service_configured' : 'adapter_runtime_ready',
      repositoryKind: getGeneratedRepositoryKind(),
      targetRepoPath,
      apiBaseUrl: baseUrl,
      routeHints: runtimePlan?.routeCoverage?.map((route) => ({
        path: typeof route.path === 'string' ? route.path : null,
        purpose: typeof route.purpose === 'string' ? route.purpose : null,
      })) ?? [],
      note: baseUrl
        ? 'The adapter will call the configured API base URL.'
        : 'No API base URL was configured; endpoint calls will produce a dry-run artifact instead of failing the run.',
    },
  })
}

const callHealthEndpointHandler: ToolHandler = async (input: unknown): Promise<ToolResult> => {
  const endpointPath = normalizeEndpointPath(input, detectHealthEndpointPath())
  return ok({ apiResponse: await callEndpoint(endpointPath) })
}

const callPrimaryEndpointHandler: ToolHandler = async (input: unknown): Promise<ToolResult> => {
  const endpointPath = normalizeEndpointPath(input, detectPrimaryEndpointPath())
  return ok({ apiResponse: await callEndpoint(endpointPath) })
}

const verifyApiResponseHandler: ToolHandler = async (_input, context): Promise<ToolResult> => {
  const apiResponse = asRecord(context.artifacts?.['apiResponse'])
  const executed = apiResponse?.['executed'] === true
  const status = typeof apiResponse?.['status'] === 'number' ? apiResponse['status'] : null
  const okStatus = typeof status === 'number' && status >= 200 && status < 500

  return ok({
    apiContractVerified: {
      checked: true,
      executed,
      status,
      passed: executed ? okStatus : false,
      mode: executed ? 'http_response' : 'dry_run',
      reason: executed
        ? okStatus
          ? 'Endpoint returned an HTTP response in the accepted smoke range.'
          : 'Endpoint returned an HTTP response outside the accepted smoke range.'
        : 'No API base URL was configured for this generated adapter run.',
    },
  })
}

const runCliHelpHandler: ToolHandler = async (input: unknown): Promise<ToolResult> => {
  const targetRepoPath = resolveGeneratedTargetRepoPath()
  const args = normalizeArgs(input)
  const command = await resolveCliCommand(targetRepoPath, args)
  if (!command) {
    return ok({
      cliHelpOutput: {
        executed: false,
        reason: 'No CLI command was configured and no package.json bin entry was found.',
        targetRepoPath,
      },
    })
  }

  const result = await runProcess(command.command, command.args, targetRepoPath, 8_000)
  return ok({
    cliHelpOutput: {
      executed: true,
      command: result.command,
      args: result.args,
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutPreview: truncate(result.stdout),
      stderrPreview: truncate(result.stderr),
      error: result.error,
      timedOut: result.timedOut === true,
    },
  })
}

const verifyCliOutputHandler: ToolHandler = async (_input, context): Promise<ToolResult> => {
  const cliHelpOutput = asRecord(context.artifacts?.['cliHelpOutput'])
  const executed = cliHelpOutput?.['executed'] === true
  const exitCode = typeof cliHelpOutput?.['exitCode'] === 'number' ? cliHelpOutput['exitCode'] : null
  const stdout = typeof cliHelpOutput?.['stdoutPreview'] === 'string' ? cliHelpOutput['stdoutPreview'] : ''
  const stderr = typeof cliHelpOutput?.['stderrPreview'] === 'string' ? cliHelpOutput['stderrPreview'] : ''

  return ok({
    cliOutputVerified: {
      checked: true,
      executed,
      exitCode,
      hasOutput: stdout.length > 0 || stderr.length > 0,
      passed: executed && exitCode === 0,
      reason: executed
        ? exitCode === 0
          ? 'CLI help command exited successfully.'
          : 'CLI command was discovered but did not exit successfully; install target dependencies or map the command manually.'
        : 'No CLI command artifact was produced.',
    },
  })
}

const inspectPackageExportsHandler: ToolHandler = async (): Promise<ToolResult> => {
  const targetRepoPath = resolveGeneratedTargetRepoPath()
  const packageJson = await readPackageJson(targetRepoPath)

  return ok({
    packageExports: {
      targetRepoPath,
      packageName: typeof packageJson?.name === 'string' ? packageJson.name : null,
      exports: packageJson?.exports ?? null,
      main: packageJson?.main ?? null,
      module: packageJson?.module ?? null,
      types: packageJson?.types ?? null,
      hasPackageJson: Boolean(packageJson),
    },
  })
}

const verifyPublicApiDocsHandler: ToolHandler = async (_input, context): Promise<ToolResult> => {
  const targetRepoPath = resolveGeneratedTargetRepoPath()
  const packageExports = asRecord(context.artifacts?.['packageExports'])
  const hasExports = packageExports?.['exports'] !== null && packageExports?.['exports'] !== undefined
  const hasTypes = packageExports?.['types'] !== null && packageExports?.['types'] !== undefined
  const readmePath = await findFirstExisting([
    path.join(targetRepoPath, 'README.md'),
    path.join(targetRepoPath, 'readme.md'),
    path.join(targetRepoPath, 'docs', 'README.md'),
  ])

  return ok({
    publicApiDocsVerified: {
      checked: true,
      hasReadme: Boolean(readmePath),
      readmePath,
      hasExports,
      hasTypes,
      passed: Boolean(readmePath) || hasExports || hasTypes,
    },
  })
}

const inspectRepositoryStructureHandler: ToolHandler = async (): Promise<ToolResult> => {
  const targetRepoPath = resolveGeneratedTargetRepoPath()
  const entries = await listTopLevelEntries(targetRepoPath)

  return ok({
    repositoryStructure: {
      targetRepoPath,
      repositoryKind: getGeneratedRepositoryKind(),
      entries,
      hasPackageJson: entries.some((entry) => entry.name === 'package.json'),
      hasSourceDirectory: entries.some((entry) => ['src', 'app', 'apps', 'packages'].includes(entry.name)),
    },
  })
}

const identifyTestEntrypointsHandler: ToolHandler = async (): Promise<ToolResult> => {
  const targetRepoPath = resolveGeneratedTargetRepoPath()
  const packageJson = await readPackageJson(targetRepoPath)
  const scripts = asStringRecord(packageJson?.scripts)
  const interestingScripts = Object.entries(scripts).filter(([name]) => (
    /test|spec|e2e|smoke|verify|build|dev|start/i.test(name)
  ))
  const files = await findFirstExisting([
    path.join(targetRepoPath, 'vitest.config.ts'),
    path.join(targetRepoPath, 'vitest.config.js'),
    path.join(targetRepoPath, 'playwright.config.ts'),
    path.join(targetRepoPath, 'jest.config.js'),
    path.join(targetRepoPath, 'pytest.ini'),
    path.join(targetRepoPath, 'go.mod'),
    path.join(targetRepoPath, 'Cargo.toml'),
  ])

  return ok({
    testEntrypoints: {
      targetRepoPath,
      scripts: Object.fromEntries(interestingScripts),
      configFile: files,
      hasEntrypoint: interestingScripts.length > 0 || Boolean(files),
    },
  })
}

function registerGeneratedFrontendTools(registry: ToolRegistry): void {
  const generatedCapabilities = readGeneratedCapabilities()
  const capabilityIds = new Set([
    ...generatedCapabilities.map((capability) => capability.id),
    'openPrimaryRoute',
    'fillCustomerEmail',
    'addCartItem',
    'submitOrder',
    'captureScreenshot',
    'interactWithPrimaryAction',
    'verifyPrimaryFeedback',
  ].filter((id): id is string => typeof id === 'string' && id.length > 0))

  for (const capabilityId of capabilityIds) {
    const handler = frontendHandlerForCapability(capabilityId, generatedCapabilities)
    if (!handler || registry.has(capabilityId)) continue

    registry.register(capabilityId, handler, metadata({
      name: capabilityId,
      description: `Execute generated browser capability ${capabilityId}`,
      requiresBrowser: true,
      riskLevel: isReadOnlyFrontendCapability(capabilityId) ? 'read' : 'write',
      tags: ['generated-adapter', 'frontend', 'browser'],
    }))
  }
}

function frontendHandlerForCapability(
  capabilityId: string,
  generatedCapabilities: Array<{ id: string; routeHint?: string; purpose?: string; sourceHint?: string }>,
): ToolHandler | null {
  const capability = generatedCapabilities.find((item) => item.id === capabilityId)
  const normalizedId = capabilityId.toLowerCase()
  if (capabilityId === 'openPrimaryRoute' || normalizedId.includes('open') || normalizedId.includes('navigate')) {
    return async (_input, context) => openPrimaryRouteHandler(capability, context)
  }
  if (capabilityId === 'fillCustomerEmail' || normalizedId.includes('fill')) {
    return async (input, context) => fillCustomerEmailHandler(input, capability, context)
  }
  if (capabilityId === 'addCartItem' || normalizedId.includes('add') || normalizedId.includes('cart')) {
    return async (_input, context) => addCartItemHandler(capability, context)
  }
  if (capabilityId === 'submitOrder' || normalizedId.includes('submit') || normalizedId.includes('checkout')) {
    return async (_input, context) => submitOrderHandler(capability, context)
  }
  if (capabilityId === 'captureScreenshot' || normalizedId.includes('screenshot')) {
    return async (_input, context) => captureScreenshotHandler(capability, context)
  }
  if (capabilityId === 'verifyPrimaryFeedback' || normalizedId.includes('verify') || normalizedId.includes('assert')) {
    return async (_input, context) => verifyPrimaryFeedbackHandler(capability, context)
  }
  if (capabilityId === 'interactWithPrimaryAction' || normalizedId.includes('click') || normalizedId.includes('interact')) {
    return async (_input, context) => interactWithPrimaryActionHandler(capability, context)
  }
  return null
}

const openPrimaryRouteHandler = async (
  capability: { id?: string; routeHint?: string } | undefined,
  context: { page?: unknown },
): Promise<ToolResult> => {
  const page = requirePage(context.page)
  const route = normalizeRouteHint(capability?.routeHint)
  await page.goto?.(route, { waitUntil: 'domcontentloaded' })

  return ok({
    commandResult: buildCommandResult('navigate', capability, {
      route,
      currentUrl: safeCurrentUrl(page),
    }),
    routeLoaded: {
      route,
      currentUrl: safeCurrentUrl(page),
    },
    pageLoaded: {
      route,
      currentUrl: safeCurrentUrl(page),
    },
  })
}

const fillCustomerEmailHandler = async (
  input: unknown,
  capability: { id?: string; routeHint?: string; purpose?: string } | undefined,
  context: { page?: unknown },
): Promise<ToolResult> => {
  const page = requirePage(context.page)
  await ensurePageReady(page, capability?.routeHint)
  const inputRecord = asRecord(input)
  const fieldLabel = extractQuotedLabel(capability?.purpose)
  const wantsEmail = !capability || /e-?mail/i.test(`${capability.id ?? ''} ${fieldLabel ?? ''}`)
  const providedValue = typeof inputRecord?.['value'] === 'string'
    ? inputRecord['value']
    : typeof inputRecord?.['email'] === 'string'
      ? inputRecord['email']
      : null
  const value = providedValue ?? (wantsEmail ? 'agentic.qa@example.com' : 'Agentic QA')
  const factories: Array<() => LocatorLike | undefined> = []
  if (fieldLabel) {
    factories.push(
      () => page.getByLabel?.(fieldLabel),
      () => page.getByPlaceholder?.(fieldLabel),
    )
  }
  if (wantsEmail) {
    factories.push(
      () => page.locator?.('input[type="email"]'),
      () => page.locator?.('input[name*="email" i]'),
      () => page.getByLabel?.(/customer\s*email|email|e-mail/i),
      () => page.getByPlaceholder?.(/customer\s*email|email|e-mail/i),
    )
  }
  factories.push(() => page.locator?.('input:not([type]), input[type="text"], input[type="email"], textarea'))
  await fillFirst(factories, value, fieldLabel ?? (wantsEmail ? 'email' : 'text'))
  const target = fieldLabel ?? (wantsEmail ? 'email' : 'text_input')

  return ok({
    commandResult: buildCommandResult('fill', capability, {
      target,
      valueProvided: true,
    }),
    ...(wantsEmail ? { customerEmail: value } : {}),
    filledValue: value,
    interactionResult: {
      type: 'fill',
      target,
      valueProvided: true,
    },
  })
}

const addCartItemHandler = async (
  capability: { id?: string; routeHint?: string; purpose?: string; sourceHint?: string } | undefined,
  context: { page?: unknown },
): Promise<ToolResult> => {
  const page = requirePage(context.page)
  await ensurePageReady(page, capability?.routeHint)
  const clicked = await clickFirst(page, {
    exactLabel: extractQuotedLabel(capability?.purpose),
    patterns: [/add.*cart|add.*item|comprar|adicionar/i],
    description: 'add-to-cart action',
  })

  return ok({
    commandResult: buildCommandResult('click', capability, {
      target: 'cart_action',
      clickedLabel: clicked,
      completed: true,
    }),
    cartItemId: `item-${Date.now()}`,
    interactionResult: {
      type: 'click',
      target: 'cart_action',
      completed: true,
    },
  })
}

const submitOrderHandler = async (
  capability: { id?: string; routeHint?: string; purpose?: string; sourceHint?: string } | undefined,
  context: { page?: unknown },
): Promise<ToolResult> => {
  const page = requirePage(context.page)
  await ensurePageReady(page, capability?.routeHint)
  const clicked = await clickFirst(page, {
    exactLabel: extractQuotedLabel(capability?.purpose),
    patterns: [/submit.*order|checkout|place.*order|finalizar|confirmar|enviar|submit/i],
    description: 'submit action',
  })

  return ok({
    commandResult: buildCommandResult('click', capability, {
      target: 'primary_submit',
      clickedLabel: clicked,
      completed: true,
    }),
    orderSubmitted: true,
    primaryActionCompleted: true,
    interactionResult: {
      type: 'click',
      target: 'primary_submit',
      completed: true,
    },
  })
}

const interactWithPrimaryActionHandler = async (
  capability: { id?: string; routeHint?: string; purpose?: string; sourceHint?: string } | undefined,
  context: { page?: unknown },
): Promise<ToolResult> => {
  const page = requirePage(context.page)
  await ensurePageReady(page, capability?.routeHint)
  const clicked = await clickFirst(page, {
    exactLabel: extractQuotedLabel(capability?.purpose),
    patterns: [/continue|start|save|next|primary|submit|open|iniciar|salvar|avancar/i],
    description: 'primary action',
  })

  return ok({
    commandResult: buildCommandResult('click', capability, {
      target: capability?.id ?? 'primary_action',
      clickedLabel: clicked,
      completed: true,
    }),
    primaryActionCompleted: true,
    interactionResult: {
      type: 'click',
      target: 'primary_action',
      completed: true,
    },
  })
}

const verifyPrimaryFeedbackHandler = async (
  capability: { routeHint?: string } | undefined,
  context: { page?: unknown },
): Promise<ToolResult> => {
  const page = requirePage(context.page)
  await ensurePageReady(page, capability?.routeHint)
  const feedback = await waitForVisibleText(page, SUCCESS_FEEDBACK_SELECTORS, FEEDBACK_WAIT_MS)

  if (!feedback) {
    // Never fall back to "the page has some text": that turns every run into a pass.
    const errorFeedback = await waitForVisibleText(page, ERROR_FEEDBACK_SELECTORS, 0)
    return {
      ok: false,
      error: {
        code: 'verification_failed',
        message: errorFeedback
          ? `Expected success feedback after the interaction, but the page shows an error: "${truncate(errorFeedback, 200)}".`
          : 'Expected visible success feedback after the interaction (e.g. "submitted", "success", "saved"), but none was found.',
        retryable: false,
      },
    }
  }

  return ok({
    primaryFeedbackVisible: true,
    verificationResult: {
      checked: true,
      passed: true,
      textPreview: truncate(feedback, 500),
      reason: 'Visible success feedback was found after the generated interaction.',
    },
  })
}

const captureScreenshotHandler = async (
  capability: { routeHint?: string } | undefined,
  context: { page?: unknown },
): Promise<ToolResult> => {
  const page = requirePage(context.page)
  await ensurePageReady(page, capability?.routeHint)
  const screenshot = await page.screenshot?.({ fullPage: true })
  const byteLength = screenshot instanceof Uint8Array ? screenshot.byteLength : null

  return ok({
    screenshotCaptured: true,
    browserEvidence: {
      type: 'screenshot',
      captured: true,
      byteLength,
    },
  })
}

function readGeneratedCapabilities(): Array<{ id: string; routeHint?: string; purpose?: string; sourceHint?: string }> {
  const parsed = readGeneratedAdapterJson<CapabilityCatalog | GeneratedCapability[]>('capabilities/capabilities.generated.json')
  const rawCapabilities = Array.isArray(parsed) ? parsed : parsed?.capabilities
  if (!Array.isArray(rawCapabilities)) return []

  return rawCapabilities.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string') return []
    return [{
      id: item.id,
      // Backend route hints such as /api/orders describe the server call behind a
      // UI action; navigating the browser there would leave the frontend.
      routeHint: typeof item.routeHint === 'string' && !isBackendRouteHint(item.routeHint) ? item.routeHint : undefined,
      purpose: typeof item.purpose === 'string' ? item.purpose : undefined,
      sourceHint: typeof item.sourceHint === 'string' ? item.sourceHint : undefined,
    }]
  })
}

function buildCommandResult(
  action: 'navigate' | 'fill' | 'click',
  capability: { id?: string } | undefined,
  details: Record<string, unknown>,
) {
  return {
    action,
    capabilityId: capability?.id ?? null,
    completed: true,
    ...details,
  }
}

function isBackendRouteHint(value: string): boolean {
  return /^\/?api(\/|$)/i.test(value)
}

function isReadOnlyFrontendCapability(capabilityId: string): boolean {
  return /verify|assert|capture|screenshot|open|navigate/i.test(capabilityId)
}

function requirePage(value: unknown): PageLike {
  if (!isRecord(value)) {
    throw new Error('Generated frontend capability requires a Playwright page context.')
  }
  return value as PageLike
}

async function ensurePageReady(page: PageLike, routeHint: string | undefined): Promise<void> {
  const currentUrl = safeCurrentUrl(page)
  if (currentUrl && currentUrl !== 'about:blank') return
  await page.goto?.(normalizeRouteHint(routeHint), { waitUntil: 'domcontentloaded' })
}

function normalizeRouteHint(value: string | undefined): string {
  const rawRoute = !value || value === '*' ? '/' : value
  if (/^https?:\/\//i.test(rawRoute)) return rawRoute
  const route = rawRoute.startsWith('/') ? rawRoute : `/${rawRoute}`
  const baseUrl = process.env['PLAYWRIGHT_BASE_URL']
  if (!baseUrl) return route

  try {
    return new URL(route, baseUrl).toString()
  } catch {
    return route
  }
}

function safeCurrentUrl(page: PageLike): string | null {
  try {
    return page.url?.() ?? null
  } catch {
    return null
  }
}

const FEEDBACK_WAIT_MS = 5_000
const SUCCESS_FEEDBACK_PATTERN = 'success|submitted|completed|confirmed|created|saved|thank you|order placed|sucesso|conclu[i\u00ed]d|salv[oa]|enviad[oa]|confirmad[oa]|criad[oa]'
const ERROR_FEEDBACK_PATTERN = 'error|failed|invalid|required|erro|falh|inv[a\u00e1]lid|obrigat[o\u00f3]ri'
// Controls (buttons, links, labels) are excluded so that a button reading
// "Complete purchase" is never mistaken for a confirmation message.
const NON_CONTROL = ':not(button):not([role="button"]):not(a):not(label):not(option):not(script):not(style):not(title)'
const SUCCESS_FEEDBACK_SELECTORS = [`${NON_CONTROL}:text-matches("${SUCCESS_FEEDBACK_PATTERN}", "i")`]
const ERROR_FEEDBACK_SELECTORS = [
  `[role="alert"]:text-matches("\\S")`,
  `${NON_CONTROL}:text-matches("${ERROR_FEEDBACK_PATTERN}", "i")`,
]

function extractQuotedLabel(value: string | undefined): string | undefined {
  const match = value?.match(/"([^"]{1,200})"/)
  return match?.[1]?.trim() || undefined
}

/**
 * Clicks the control that matches the capability. There is intentionally no
 * "click any enabled button" fallback: clicking the wrong control and reporting
 * success is what produced false positives. If the matching control exists but
 * cannot be clicked (disabled, hidden, covered), the step fails.
 */
async function clickFirst(
  page: PageLike,
  target: { exactLabel?: string; patterns: RegExp[]; description: string },
): Promise<string> {
  const attempts: Array<{ label: string; factory: () => LocatorLike | undefined }> = []
  if (target.exactLabel) {
    const label = target.exactLabel
    attempts.push(
      { label, factory: () => page.getByRole?.('button', { name: label, exact: true }) },
      { label, factory: () => page.getByRole?.('link', { name: label, exact: true }) },
    )
  }
  for (const pattern of target.patterns) {
    attempts.push(
      { label: String(pattern), factory: () => page.getByRole?.('button', { name: pattern }) },
      { label: String(pattern), factory: () => page.getByRole?.('link', { name: pattern }) },
    )
  }

  for (const attempt of attempts) {
    const candidate = attempt.factory()
    const locator = candidate?.first?.() ?? candidate
    if (!locator?.click) continue
    if (locator.count && (await locator.count()) < 1) continue
    try {
      await locator.click({ timeout: 3_000 })
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
      throw new Error(
        `The ${target.description} (${attempt.label}) was found but could not be clicked; it may be disabled or hidden. ${message}`,
      )
    }
    return (await locatorText(locator))?.trim() || attempt.label
  }

  const expected = [target.exactLabel ? `"${target.exactLabel}"` : null, ...target.patterns.map(String)]
    .filter(Boolean)
    .join(' or ')
  throw new Error(`No ${target.description} matching ${expected} was found on the page.`)
}

async function fillFirst(
  factories: Array<() => LocatorLike | undefined>,
  value: string,
  description: string,
): Promise<void> {
  for (const factory of factories) {
    const candidate = factory()
    const locator = candidate?.first?.() ?? candidate
    if (!locator?.fill) continue
    if (locator.count && (await locator.count()) < 1) continue
    try {
      await locator.fill(value, { timeout: 3_000 })
      return
    } catch {
      continue
    }
  }

  throw new Error(`No fillable ${description} input was found on the page.`)
}

async function waitForVisibleText(page: PageLike, selectors: string[], timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  do {
    for (const selector of selectors) {
      const locator = page.locator?.(selector)
      const first = locator?.first?.() ?? locator
      if (!(await locatorVisible(first))) continue
      const text = (await locatorText(first))?.trim()
      if (text) return text
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() < deadline)
  return null
}

async function firstUsableLocator(factories: Array<() => LocatorLike | undefined>): Promise<LocatorLike | null> {
  for (const factory of factories) {
    const candidate = factory()
    const locator = candidate?.first?.() ?? candidate
    if (!locator) continue
    if (await locatorVisible(locator)) return locator
  }

  return null
}

async function locatorVisible(locator: LocatorLike | undefined): Promise<boolean> {
  if (!locator) return false
  try {
    if (locator.count && (await locator.count()) < 1) return false
    if (locator.isVisible) return await locator.isVisible({ timeout: 1_000 })
    return true
  } catch {
    return false
  }
}

async function locatorText(locator: LocatorLike | undefined): Promise<string | null> {
  if (!locator?.textContent) return null
  try {
    return await locator.textContent({ timeout: 1_000 })
  } catch {
    return null
  }
}

function metadata(
  input: Omit<ToolMetadata, 'requiresBrowser' | 'riskLevel'> & Partial<Pick<ToolMetadata, 'requiresBrowser' | 'riskLevel'>>,
): ToolMetadata {
  return {
    requiresBrowser: false,
    riskLevel: 'read',
    ...input,
  }
}

function pathInputSchema(defaultPath: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: `Endpoint path to call. Defaults to ${defaultPath}.`,
      },
    },
  }
}

function ok(output: Record<string, unknown>): ToolResult {
  return { ok: true, output }
}

function resolveApiBaseUrl(): string | null {
  return process.env['GENERIC_API_BASE_URL']
    ?? process.env['TARGET_API_BASE_URL']
    ?? process.env['API_BASE_URL']
    ?? null
}

function normalizeEndpointPath(input: unknown, fallback: string): string {
  const inputRecord = asRecord(input)
  const value = typeof inputRecord?.['path'] === 'string' ? inputRecord['path'] : fallback
  return value.startsWith('/') ? value : `/${value}`
}

function detectHealthEndpointPath(): string {
  const runtimePlan = readGeneratedAdapterJson<RuntimePlan>('runtime/runtime-plan.generated.json')
  const route = runtimePlan?.routeCoverage?.find((item) => (
    typeof item.path === 'string' && /health|ready|live/i.test(item.path)
  ))
  return typeof route?.path === 'string' ? route.path : '/health'
}

function detectPrimaryEndpointPath(): string {
  const runtimePlan = readGeneratedAdapterJson<RuntimePlan>('runtime/runtime-plan.generated.json')
  const routeCoverage = runtimePlan?.routeCoverage ?? []
  const preferredRoute = routeCoverage.find((item) => (
    typeof item.path === 'string'
      && item.path.length > 0
      && item.path !== '/'
      && !/health|heartbeat|readiness|liveness|ready|live/i.test(item.path)
  ))
  if (typeof preferredRoute?.path === 'string') return preferredRoute.path

  const nonRootRoute = routeCoverage.find((item) => (
    typeof item.path === 'string' && item.path.length > 0 && item.path !== '/'
  ))
  return typeof nonRootRoute?.path === 'string' ? nonRootRoute.path : '/'
}

async function callEndpoint(endpointPath: string): Promise<Record<string, unknown>> {
  const baseUrl = resolveApiBaseUrl()
  if (!baseUrl) {
    return {
      executed: false,
      mode: 'dry_run',
      endpointPath,
      status: null,
      reason: 'GENERIC_API_BASE_URL, TARGET_API_BASE_URL, or API_BASE_URL was not configured.',
    }
  }

  const url = confineEndpointUrl(endpointPath, baseUrl)
  if (!url) {
    return {
      executed: false,
      mode: 'refused',
      endpointPath,
      status: null,
      reason: 'Endpoint path is outside the configured origin.',
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)

  try {
    const response = await fetch(url, { signal: controller.signal })
    const body = await response.text()
    return {
      executed: true,
      mode: 'http',
      url,
      endpointPath,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      bodyPreview: truncate(body),
    }
  } catch (error) {
    return {
      executed: false,
      mode: 'http_error',
      url,
      endpointPath,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function resolveCliCommand(
  targetRepoPath: string,
  args: string[],
): Promise<{ command: string; args: string[] } | null> {
  const configured = process.env['GENERIC_CLI_COMMAND'] ?? process.env['TARGET_CLI_COMMAND']
  if (configured) {
    const parts = configured.split(/\s+/).filter(Boolean)
    const command = parts[0]
    if (!command) return null
    return { command, args: [...parts.slice(1), ...args] }
  }

  const packageJson = await readPackageJson(targetRepoPath)
  const bin = confinePackageBin(targetRepoPath, resolvePackageBin(packageJson))
  if (!bin) return null

  return {
    command: process.execPath,
    args: [bin, ...args],
  }
}

function resolvePackageBin(packageJson: PackageJson | null): string | null {
  if (typeof packageJson?.bin === 'string') return packageJson.bin
  if (!isRecord(packageJson?.bin)) return null

  const firstBin = Object.values(packageJson.bin).find((value): value is string => typeof value === 'string')
  return firstBin ?? null
}

function normalizeArgs(input: unknown): string[] {
  const inputRecord = asRecord(input)
  const args = Array.isArray(inputRecord?.['args']) ? inputRecord['args'] : ['--help']
  return args.filter((arg): arg is string => typeof arg === 'string')
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        command,
        args,
        cwd,
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error: error.message,
        timedOut,
      })
    })

    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        command,
        args,
        cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}

async function readPackageJson(targetRepoPath: string): Promise<PackageJson | null> {
  const packageJsonPath = path.join(targetRepoPath, 'package.json')
  try {
    const parsed = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as unknown
    return isRecord(parsed) ? parsed as PackageJson : null
  } catch {
    return null
  }
}

async function listTopLevelEntries(targetRepoPath: string): Promise<Array<{ name: string; type: string }>> {
  try {
    const entries = await fs.readdir(targetRepoPath, { withFileTypes: true })
    return entries
      .filter((entry) => !IGNORED_TOP_LEVEL_NAMES.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    return []
  }
}

async function findFirstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      continue
    }
  }

  return null
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(value: string, maxLength = 4000): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}...[truncated]`
}
