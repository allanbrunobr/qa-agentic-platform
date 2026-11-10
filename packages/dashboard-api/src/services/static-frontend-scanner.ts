import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  DOMAIN_DISCOVERY_SCHEMA_VERSION,
  MAX_EXTRACTED_TEXT_CHARS,
  MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND,
  normalizeFrontendSurfaceMap,
  type FrontendSurfaceMap,
} from '../../../host-sdk/src/domain-discovery-contracts.ts'

interface PackageJson {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface ScannedFile {
  relativePath: string
  absolutePath: string
  content: string
}

export interface ResolvedFrontendScanRoot {
  appRoot: string
  packageJson: PackageJson | null
  packageJsonRelativePath: string
}

export interface StaticFrontendScannerOptions {
  targetId?: string
  maxFiles?: number
  maxBytesPerFile?: number
}

const DEFAULT_MAX_FILES = 250
const DEFAULT_MAX_BYTES_PER_FILE = 120_000
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.html', '.md'])
const IGNORED_DIRS = new Set([
  '.agentic-qa',
  '.git',
  '.next',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'playwright-report',
])

const FRAMEWORK_PACKAGES: Array<{ packageName: string; frameworkName: string }> = [
  { packageName: 'vite', frameworkName: 'vite' },
  { packageName: 'next', frameworkName: 'nextjs' },
  { packageName: 'react', frameworkName: 'react' },
  { packageName: 'vue', frameworkName: 'vue' },
  { packageName: 'svelte', frameworkName: 'svelte' },
  { packageName: '@angular/core', frameworkName: 'angular' },
  { packageName: '@angular/cli', frameworkName: 'angular' },
]

export class StaticFrontendScanner {
  async scan(repoPath: string, options: StaticFrontendScannerOptions = {}): Promise<FrontendSurfaceMap> {
    return scanStaticFrontend(repoPath, options)
  }
}

export async function scanStaticFrontend(
  repoPath: string,
  options: StaticFrontendScannerOptions = {},
): Promise<FrontendSurfaceMap> {
  const resolvedRoot = await resolvePreferredFrontendScanRoot(repoPath)
  const packageJson = resolvedRoot.packageJson
  const targetId = normalizeId(options.targetId ?? packageJson?.name ?? path.basename(repoPath) ?? 'frontend-target')
  const files = await listScanFiles(repoPath, resolvedRoot.appRoot, {
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxBytesPerFile: options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE,
  })
  const sourceFiles = files.filter((file) => isSourceFile(file.relativePath))
  const testFiles = files.filter((file) => isTestFile(file.relativePath))
  const docsFiles = files.filter((file) => isDocFile(file.relativePath))

  const surfaceMapInput = {
    schemaVersion: DOMAIN_DISCOVERY_SCHEMA_VERSION,
    targetId,
    repositoryRootName: path.basename(repoPath),
    generatedAt: new Date(0).toISOString(),
    routes: collectRoutes(sourceFiles),
    components: collectComponents(sourceFiles),
    forms: collectForms(sourceFiles),
    buttons: collectButtons(sourceFiles),
    texts: [
      ...collectTexts(sourceFiles),
      ...collectDocSnippets(docsFiles),
    ],
    navigation: collectNavigation(sourceFiles),
    packages: collectPackageEvidence(packageJson, resolvedRoot.packageJsonRelativePath),
    frameworks: collectFrameworkEvidence(packageJson, sourceFiles, resolvedRoot.packageJsonRelativePath),
    tests: collectTestEvidence(testFiles),
  }

  return normalizeFrontendSurfaceMap(surfaceMapInput)
}

async function readPackageJson(repoPath: string): Promise<PackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(repoPath, 'package.json'), 'utf8')
    return JSON.parse(raw) as PackageJson
  } catch {
    return null
  }
}

export async function resolvePreferredFrontendScanRoot(repoPath: string): Promise<ResolvedFrontendScanRoot> {
  const candidateDirs = await listFrontendRootCandidates(repoPath)
  const scored = await Promise.all(candidateDirs.map(async (appRoot) => {
    const packageJson = await readPackageJson(appRoot)
    const score = await scoreFrontendRoot(repoPath, appRoot, packageJson)
    return {
      appRoot,
      packageJson,
      packageJsonRelativePath: normalizePath(path.relative(repoPath, path.join(appRoot, 'package.json')) || 'package.json'),
      score,
    }
  }))

  const best = scored.sort((left, right) => right.score - left.score)[0]
  if (best) {
    return {
      appRoot: best.appRoot,
      packageJson: best.packageJson,
      packageJsonRelativePath: best.packageJsonRelativePath,
    }
  }

  return {
    appRoot: repoPath,
    packageJson: await readPackageJson(repoPath),
    packageJsonRelativePath: 'package.json',
  }
}

async function listScanFiles(
  repoPath: string,
  scanRoot: string,
  options: { maxFiles: number; maxBytesPerFile: number },
): Promise<ScannedFile[]> {
  const results: ScannedFile[] = []

  async function walk(currentDir: string): Promise<void> {
    if (results.length >= options.maxFiles) return
    const entries = await safeReadDir(currentDir)
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (results.length >= options.maxFiles) return
      if (entry.name.startsWith('.env')) continue
      const absolutePath = path.join(currentDir, entry.name)
      const relativePath = normalizePath(path.relative(repoPath, absolutePath))

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(absolutePath)
        continue
      }

      if (!entry.isFile()) continue
      if (path.basename(relativePath) === 'package.json') continue
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue
      const stat = await fs.stat(absolutePath)
      if (stat.size > options.maxBytesPerFile) continue
      const content = await fs.readFile(absolutePath, 'utf8')
      results.push({ relativePath, absolutePath, content })
    }
  }

  await walk(scanRoot)
  return results
}

async function safeReadDir(dirPath: string) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

function collectPackageEvidence(packageJson: PackageJson | null, packageJsonRelativePath: string) {
  const deps = collectDependencies(packageJson)
  return deps.slice(0, MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND).map(([packageName, versionRange]) => ({
    id: makeId('pkg', packageName),
    kind: 'package' as const,
    source: { filePath: packageJsonRelativePath },
    packageName,
    versionRange,
    extractedText: packageName,
  }))
}

function collectFrameworkEvidence(packageJson: PackageJson | null, files: ScannedFile[], packageJsonRelativePath: string) {
  const deps = new Map(collectDependencies(packageJson))
  const frameworks = new Map<string, { sourcePath: string; extractedText: string }>()

  for (const framework of FRAMEWORK_PACKAGES) {
    if (deps.has(framework.packageName)) {
      frameworks.set(framework.frameworkName, {
        sourcePath: packageJsonRelativePath,
        extractedText: framework.packageName,
      })
    }
  }

  if (files.some((file) => /(^|\/)src\/app\/.+\/page\.(t|j)sx?$/.test(file.relativePath))) {
    frameworks.set('nextjs', { sourcePath: 'src/app', extractedText: 'Next.js app router files' })
  }
  if (files.some((file) => file.relativePath.endsWith('.vue'))) {
    frameworks.set('vue', { sourcePath: firstMatchingPath(files, '.vue'), extractedText: 'Vue single-file component' })
  }
  if (files.some((file) => file.relativePath.endsWith('.svelte'))) {
    frameworks.set('svelte', { sourcePath: firstMatchingPath(files, '.svelte'), extractedText: 'Svelte component' })
  }

  if (frameworks.size === 0 && files.some((file) => file.relativePath.endsWith('.html'))) {
    frameworks.set('generic_frontend', { sourcePath: firstMatchingPath(files, '.html'), extractedText: 'Static HTML frontend' })
  }

  return Array.from(frameworks.entries()).slice(0, MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND).map(([frameworkName, info]) => ({
    id: makeId('framework', frameworkName),
    kind: 'framework' as const,
    source: { filePath: info.sourcePath },
    frameworkName,
    extractedText: info.extractedText,
  }))
}

function collectRoutes(files: ScannedFile[]) {
  const routes: Array<Record<string, unknown>> = []

  for (const file of files) {
    const scanContent = prepareScanContent(file.content)
    const nextAppRoute = inferNextAppRoute(file.relativePath)
    if (nextAppRoute) {
      routes.push({
        id: makeId('route', nextAppRoute),
        kind: 'route',
        source: { filePath: file.relativePath },
        path: nextAppRoute,
        label: humanizeRoute(nextAppRoute),
        extractedText: `Next.js app route ${nextAppRoute}`,
      })
    }

    const nextPagesRoute = inferNextPagesRoute(file.relativePath)
    if (nextPagesRoute) {
      routes.push({
        id: makeId('route', nextPagesRoute),
        kind: 'route',
        source: { filePath: file.relativePath },
        path: nextPagesRoute,
        label: humanizeRoute(nextPagesRoute),
        extractedText: `Next.js pages route ${nextPagesRoute}`,
      })
    }

    for (const match of scanContent.matchAll(/<Route\b[^>]*\bpath=["']([^"']+)["']/g)) {
      const routePath = match[1] ?? '/'
      routes.push({
        id: makeId('route', routePath),
        kind: 'route',
        source: { filePath: file.relativePath, line: lineForIndex(file.content, match.index ?? 0) },
        path: routePath,
        label: humanizeRoute(routePath),
        extractedText: `React route ${routePath}`,
      })
    }

    if (file.relativePath === 'index.html') {
      routes.push({
        id: 'route_root',
        kind: 'route',
        source: { filePath: file.relativePath },
        path: '/',
        label: 'Root',
        extractedText: 'Static root document',
      })
    }
  }

  return uniqueById(routes)
}

function collectComponents(files: ScannedFile[]) {
  const components: Array<Record<string, unknown>> = []
  for (const file of files) {
    const scanContent = prepareScanContent(file.content)
    const fileComponentName = inferComponentNameFromPath(file.relativePath)
    if (fileComponentName) {
      components.push({
        id: makeId('component', fileComponentName),
        kind: 'component',
        source: { filePath: file.relativePath },
        componentName: fileComponentName,
        extractedText: fileComponentName,
      })
    }

    for (const match of scanContent.matchAll(/(?:export\s+default\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(/g)) {
      addComponent(components, file, match[1], match.index ?? 0)
    }
    for (const match of scanContent.matchAll(/(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*=/g)) {
      addComponent(components, file, match[1], match.index ?? 0)
    }
  }
  return uniqueById(components)
}

function collectForms(files: ScannedFile[]) {
  const forms: Array<Record<string, unknown>> = []
  for (const file of files) {
    const scanContent = prepareScanContent(file.content)
    for (const match of scanContent.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
      const attrs = match[1] ?? ''
      const body = match[2] ?? ''
      const actionName = extractAttribute(attrs, 'onSubmit')?.replace(/[{}]/g, '').trim()
      const fields = extractFieldLabels(body)
      const line = lineForIndex(file.content, match.index ?? 0)
      forms.push({
        id: makeId('form', file.relativePath, line),
        kind: 'form',
        source: { filePath: file.relativePath, line },
        fields,
        actionName: actionName || undefined,
        extractedText: sanitizeText(body),
      })
    }

    const implicitForm = collectImplicitFormFields(file, scanContent)
    if (implicitForm) forms.push(implicitForm)
  }
  return uniqueById(forms)
}

const NON_TEXT_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color'])
const FIELD_TAG_PATTERN = /<(input|select|textarea)\b((?:[^>{]|\{[^}]*\})*)>/gi

/**
 * Many apps collect user input without a <form> element (inputs wired to
 * buttons through state). Those fields still have to be filled before the
 * primary action becomes meaningful, so they are reported as one implicit form
 * per file. Without this, generated scenarios skip required inputs.
 */
function collectImplicitFormFields(file: ScannedFile, scanContent: string): Record<string, unknown> | null {
  const outsideForms = scanContent.replace(/<form\b[\s\S]*?<\/form>/gi, preserveMatchShape)
  const fields: string[] = []
  let firstIndex: number | null = null

  const wrappedLabels = Array.from(outsideForms.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)).map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    text: sanitizeText((match[1] ?? '').replace(FIELD_TAG_PATTERN, ' ')),
  }))

  for (const match of outsideForms.matchAll(FIELD_TAG_PATTERN)) {
    const attrs = match[2] ?? ''
    const type = (extractAttribute(attrs, 'type') ?? 'text').toLowerCase()
    if (match[1]?.toLowerCase() === 'input' && NON_TEXT_INPUT_TYPES.has(type)) continue
    const index = match.index ?? 0
    const wrapping = wrappedLabels.find((label) => index > label.start && index < label.end)
    const label = extractFieldLabel([
      extractAttribute(attrs, 'aria-label'),
      wrapping?.text,
      extractAttribute(attrs, 'placeholder'),
      extractAttribute(attrs, 'name'),
    ])
    if (!label || fields.includes(label)) continue
    fields.push(label)
    firstIndex ??= index
  }

  if (fields.length === 0 || firstIndex === null) return null
  const line = lineForIndex(file.content, firstIndex)
  return {
    id: makeId('form', file.relativePath, line, 'implicit'),
    kind: 'form',
    source: { filePath: file.relativePath, line },
    fields: fields.slice(0, 40),
    extractedText: fields.join(', '),
    metadata: { implicit: true },
  }
}

function collectButtons(files: ScannedFile[]) {
  const buttons: Array<Record<string, unknown>> = []
  for (const file of files) {
    const scanContent = prepareScanContent(file.content)
    for (const match of scanContent.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const attrs = match[1] ?? ''
      const body = match[2] ?? ''
      const text = extractButtonText(attrs, body)
      if (!text || !shouldKeepButtonText(text)) continue
      const line = lineForIndex(file.content, match.index ?? 0)
      buttons.push({
        id: makeId('button', file.relativePath, line, text),
        kind: 'button',
        source: { filePath: file.relativePath, line },
        buttonText: text,
        extractedText: text,
      })
    }

    for (const match of scanContent.matchAll(/<input\b([^>]*\btype=["']submit["'][^>]*)>/gi)) {
      const attrs = match[1] ?? ''
      const text = extractPreferredUiText([
        extractAttribute(attrs, 'aria-label'),
        extractAttribute(attrs, 'title'),
        extractAttribute(attrs, 'value'),
        'Submit',
      ])
      if (!text || !shouldKeepButtonText(text)) continue
      const line = lineForIndex(file.content, match.index ?? 0)
      buttons.push({
        id: makeId('button', file.relativePath, line, text),
        kind: 'button',
        source: { filePath: file.relativePath, line },
        buttonText: text,
        extractedText: text,
      })
    }
  }
  return uniqueById(buttons)
}

function collectTexts(files: ScannedFile[]) {
  const texts: Array<Record<string, unknown>> = []
  for (const file of files) {
    const scanContent = prepareScanContent(file.content)
    for (const match of scanContent.matchAll(/<(h[1-3]|label)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const tag = (match[1] ?? '').toLowerCase()
      const text = sanitizeText(match[2] ?? '')
      if (!text || !shouldKeepVisibleText(text)) continue
      const line = lineForIndex(file.content, match.index ?? 0)
      texts.push({
        id: makeId('text', file.relativePath, line, text),
        kind: 'text',
        source: { filePath: file.relativePath, line },
        textRole: tag === 'label' ? 'label' : 'heading',
        extractedText: text,
      })
    }
  }
  return uniqueById(texts)
}

function collectDocSnippets(files: ScannedFile[]) {
  const snippets: Array<Record<string, unknown>> = []
  for (const file of files) {
    const heading = file.content.match(/^#\s+(.+)$/m)
    const text = sanitizeText(heading?.[1] ?? file.content.split('\n').slice(0, 3).join(' '))
    if (!text) continue
    snippets.push({
      id: makeId('text_doc', file.relativePath),
      kind: 'text',
      source: { filePath: file.relativePath },
      textRole: 'body',
      extractedText: text,
    })
  }
  return uniqueById(snippets)
}

function collectNavigation(files: ScannedFile[]) {
  const navigation: Array<Record<string, unknown>> = []
  for (const file of files) {
    const scanContent = prepareScanContent(file.content)
    for (const match of scanContent.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      addNavigation(navigation, file, match[1], match[2], match.index ?? 0)
    }
    for (const match of scanContent.matchAll(/<Link\b([^>]*)>([\s\S]*?)<\/Link>/gi)) {
      addNavigation(navigation, file, match[1], match[2], match.index ?? 0)
    }
  }
  return uniqueById(navigation)
}

function collectTestEvidence(files: ScannedFile[]) {
  const tests: Array<Record<string, unknown>> = []
  for (const file of files) {
    const scanContent = prepareScanContent(file.content)
    for (const match of scanContent.matchAll(/\b(?:test|it|describe)\s*\(\s*["'`]([^"'`]{1,240})["'`]/g)) {
      const testName = sanitizeText(match[1] ?? '')
      if (!testName) continue
      const line = lineForIndex(file.content, match.index ?? 0)
      tests.push({
        id: makeId('test', file.relativePath, line, testName),
        kind: 'test',
        source: { filePath: file.relativePath, line },
        testName,
        tool: inferTestTool(file.relativePath, file.content),
        extractedText: testName,
      })
    }
  }
  return uniqueById(tests)
}

function addComponent(components: Array<Record<string, unknown>>, file: ScannedFile, name: string | undefined, index: number) {
  if (!name || !shouldKeepComponentName(name, file.relativePath)) return
  components.push({
    id: makeId('component', name),
    kind: 'component',
    source: { filePath: file.relativePath, line: lineForIndex(file.content, index) },
    componentName: name,
    extractedText: name,
  })
}

function addNavigation(
  navigation: Array<Record<string, unknown>>,
  file: ScannedFile,
  attrs: string | undefined,
  body: string | undefined,
  index: number,
) {
  const targetPath = extractAttribute(attrs ?? '', 'href') ?? extractAttribute(attrs ?? '', 'to')
  const text = sanitizeText(body ?? targetPath ?? '')
  if (!text && !targetPath) return
  const line = lineForIndex(file.content, index)
  navigation.push({
    id: makeId('nav', file.relativePath, line, targetPath ?? text),
    kind: 'navigation',
    source: { filePath: file.relativePath, line },
    targetPath: targetPath || undefined,
    extractedText: text || targetPath,
  })
}

function collectDependencies(packageJson: PackageJson | null): Array<[string, string]> {
  return Object.entries({
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  }).sort(([a], [b]) => a.localeCompare(b))
}

function inferNextAppRoute(relativePath: string): string | null {
  const match = relativePath.match(/^(?:src\/)?app\/(.+)\/page\.(?:t|j)sx?$/)
  if (!match?.[1]) return null
  return normalizeRoutePath(match[1])
}

function inferNextPagesRoute(relativePath: string): string | null {
  const match = relativePath.match(/^(?:src\/)?pages\/(.+)\.(?:t|j)sx?$/)
  const rawRoute = match?.[1]
  if (!rawRoute || rawRoute.startsWith('api/') || rawRoute.startsWith('_')) return null
  return normalizeRoutePath(rawRoute.replace(/\/index$/, ''))
}

function normalizeRoutePath(value: string) {
  const segments = value
    .split('/')
    .filter(Boolean)
    .filter((segment) => !segment.startsWith('(') || !segment.endsWith(')'))
    .map((segment) => segment.replace(/\[([^\]]+)\]/g, ':$1'))
  return segments.length === 0 ? '/' : '/' + segments.join('/')
}

function inferComponentNameFromPath(relativePath: string): string | null {
  if (!isLikelyUiComponentFile(relativePath)) return null
  const base = path.basename(relativePath, path.extname(relativePath))
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(base)) return null
  if (!shouldKeepComponentName(base, relativePath)) return null
  return base
}

function extractAttribute(attrs: string, name: string): string | null {
  const regex = new RegExp(`${name}=["']([^"']+)["']|${name}=\\{([^}]+)\\}`, 'i')
  const match = attrs.match(regex)
  return match?.[1] ?? match?.[2] ?? null
}

function extractFieldLabels(body: string) {
  const labels = new Set<string>()
  for (const match of body.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const attrs = match[2] ?? ''
    const label = extractFieldLabel([
      extractAttribute(attrs, 'aria-label'),
      extractAttribute(attrs, 'placeholder'),
      extractAttribute(attrs, 'name'),
    ])
    if (label) labels.add(sanitizeText(label))
  }
  for (const match of body.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) {
    const label = extractFieldLabel([match[1] ?? ''])
    if (label) labels.add(label)
  }
  return Array.from(labels).filter(Boolean).slice(0, 40)
}

function extractButtonText(attrs: string, body: string) {
  return extractPreferredUiText([
    extractAttribute(attrs, 'aria-label'),
    extractAttribute(attrs, 'title'),
    extractAttribute(attrs, 'value'),
    body,
  ])
}

function extractPreferredUiText(values: Array<string | null | undefined>) {
  const candidates = values.flatMap((value) => extractUiTextCandidates(value))
  const ranked = Array.from(new Set(candidates))
    .map((candidate) => ({ candidate, score: scoreUiText(candidate) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.length - right.candidate.length)

  return ranked[0]?.candidate ?? null
}

function extractFieldLabel(values: Array<string | null | undefined>) {
  for (const value of values) {
    const candidate = sanitizeText(value ?? '')
    if (candidate && shouldKeepVisibleText(candidate)) return candidate
  }
  return null
}

function extractUiTextCandidates(value: string | null | undefined): string[] {
  if (!value) return []
  const raw = value.replace(/\r/g, ' ')
  const candidates = new Set<string>()

  const direct = sanitizeText(raw)
  if (direct) candidates.add(direct)

  for (const match of raw.matchAll(/["'`]([^"'`\n]{2,120})["'`]/g)) {
    const candidate = sanitizeText(match[1] ?? '')
    if (candidate) candidates.add(candidate)
  }

  const expressionNormalized = raw
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')

  for (const match of expressionNormalized.matchAll(/[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9'’()+/-]*(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9'’()+/-]*){0,5}/g)) {
    const candidate = sanitizeText(match[0] ?? '')
    if (candidate) candidates.add(candidate)
  }

  return Array.from(candidates)
}

function scoreUiText(value: string) {
  const normalized = value.toLowerCase()
  if (!normalized) return -100
  if (/[={}]/.test(value) || /\bclass(name)?\b|\bonclick\b|\bonchange\b|\bonsubmit\b|=>/.test(normalized)) return -100
  if (/\b[a-zA-Z_][A-Za-z0-9_]*\([^)]*\)/.test(value)) return -100
  if (looksLikeCodeOnlyLabel(value)) return -100
  if (looksLikeUtilityClassLabel(normalized)) return -100

  let score = 0

  if (/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(value)) score += 2
  if (value.length >= 3 && value.length <= 48) score += 2
  if (/\s/.test(value)) score += 1
  if (/^[A-ZÀ-Ö]/.test(value)) score += 1
  if (/[À-ÖØ-öø-ÿ]/.test(value)) score += 1

  const codeTokens = [
    'classname',
    'hover',
    'transition',
    'justify',
    'items',
    'center',
    'rounded',
    'disabled',
    'onclick',
    'onsubmit',
    'setactive',
    'setisopen',
    'idx',
    'ml',
    'mr',
    'px',
    'py',
    'gap',
    'true',
    'false',
  ]

  for (const token of codeTokens) {
    if (normalized.includes(token)) score -= 4
  }

  if (/^[a-z0-9_:-]+$/.test(normalized)) score -= 2
  if (value.split(/\s+/).length > 6) score -= 3

  return score
}

function prepareScanContent(content: string) {
  return content
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, preserveMatchShape)
    .replace(/\/\*[\s\S]*?\*\//g, preserveMatchShape)
    .replace(/<!--[\s\S]*?-->/g, preserveMatchShape)
}

function preserveMatchShape(match: string) {
  return match.replace(/[^\n]/g, ' ')
}

export function looksLikeUtilityClassLabel(value: string) {
  if (!value) return false
  if (/^(?:[a-z]+-\d+(?:\.\d+)?\s*)+$/.test(value)) return true
  // S-09: this used to be /^(?:[a-z]+-[a-z0-9/.[\]]+\s*){2,}$/, whose nested ambiguous quantifiers
  // backtrack exponentially on target text (97 characters took 22.8 s). Checking whitespace-separated
  // tokens one by one is linear, and labels this long are not utility class lists anyway.
  if (value.length <= 300) {
    const classTokens = value.trim().split(/\s+/)
    if (classTokens.length >= 2 && classTokens.every((token) => /^[a-z]+(?:-[a-z0-9/.[\]]+)+$/.test(token))) return true
  }

  const tokens = value.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  const utilityTokenCount = tokens.filter((token) => /^(?:w|h|p|px|py|m|mx|my|mt|mb|ml|mr|gap|rounded|text|bg|border|shadow|flex|items|justify|hover|transition|slate|gray|red|green|blue|amber|primary|secondary)-/.test(token) || /^(?:italic|underline|uppercase|lowercase|hidden|block|inline|truncate)$/.test(token)).length
  return utilityTokenCount >= Math.max(2, tokens.length - 1)
}

function looksLikeUtilityTokenSequence(value: string) {
  const tokens = value.split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return false
  const utilityLike = tokens.filter((token) => /^(?:hover:|focus:|active:|disabled:)?(?:text|bg|font|tracking|leading|rounded|border|shadow|flex|items|justify|gap|space|w|h|min-w|min-h|max-w|max-h|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr)-/.test(token) || /^(?:uppercase|lowercase|truncate|whitespace-nowrap)$/.test(token)).length
  return utilityLike >= Math.max(2, tokens.length - 1)
}

function isLikelyUiComponentFile(relativePath: string) {
  const normalized = relativePath.toLowerCase()
  if (!/\.(tsx|jsx|vue|svelte|html)$/.test(normalized)) return false
  if (/(^|\/)(services?|hooks?|config|utils?|lib|store|types?|constants?)\//.test(normalized)) return false
  return true
}

function shouldKeepComponentName(name: string, relativePath: string) {
  if (!isLikelyUiComponentFile(relativePath)) return false
  if (/^[A-Z0-9_]{3,}$/.test(name)) return false
  const normalized = name.toLowerCase()
  if (/(class|contextclass)$/.test(normalized)) return false
  if (/(^|_)(default|min|max|api|base|url|key|prefix|version|threshold|delay|class|context|manager|service|handler|processor|config|state)(_|$)/.test(normalized)) {
    return false
  }
  return true
}

function shouldKeepButtonText(text: string) {
  if (!shouldKeepVisibleText(text)) return false
  const normalized = text.toLowerCase()
  if (looksLikeUtilityTokenSequence(normalized)) return false
  if (/\b(settings|reload page|try again|selecionar idioma|language|download|print|imprimir|dismiss|close|cancel|entendido)\b/.test(normalized)) {
    return false
  }
  return true
}

function shouldKeepVisibleText(text: string) {
  if (text.length < 2) return false
  if (looksLikeCodeOnlyLabel(text)) return false
  const normalized = text.toLowerCase()
  if (looksLikeUtilityClassLabel(normalized)) return false
  if (/\b(?:isopen|setisopen|onclick|onchange|onsubmit|classname|text-lg|text-sm|text-xl)\b/.test(normalized)) return false
  return true
}

function looksLikeCodeOnlyLabel(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return true
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\)?$/.test(trimmed)) return true
  if (/[_$.]/.test(trimmed)) return true
  if (/[(){}[\]=><]/.test(trimmed) && !/[À-ÖØ-öø-ÿ]/.test(trimmed)) return true
  if (/^[a-z0-9-:]+$/.test(trimmed) && !/\s/.test(trimmed) && trimmed === trimmed.toLowerCase() && trimmed.length >= 4) {
    return true
  }
  return false
}

export function sanitizeText(value: string) {
  return stripTags(value)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[^"'\s]+/gi, '$1=[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_CHARS)
}

function stripTags(value: string) {
  return value
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function lineForIndex(content: string, index: number) {
  return content.slice(0, index).split('\n').length
}

function humanizeRoute(routePath: string) {
  if (routePath === '/') return 'Root'
  return routePath
    .replace(/^\//, '')
    .replace(/[:/_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function normalizeId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item'
}

function makeId(prefix: string, ...parts: Array<string | number | undefined | null>) {
  return normalizeId([prefix, ...parts.filter((part) => part !== undefined && part !== null)].join('_')).slice(0, 120)
}

function normalizePath(value: string) {
  return value.split(path.sep).join('/')
}

function uniqueById<T extends Record<string, unknown>>(items: T[]): T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const item of items) {
    const id = String(item['id'])
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(item)
  }
  return unique.slice(0, MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND)
}

function isSourceFile(relativePath: string) {
  if (isDocFile(relativePath)) return false
  return /\.(ts|tsx|js|jsx|vue|svelte|html)$/.test(relativePath)
}

function isTestFile(relativePath: string) {
  return /(^|\/)(tests?|__tests__|e2e)\//.test(relativePath)
    || /\.(spec|test|cy)\.(ts|tsx|js|jsx)$/.test(relativePath)
}

function isDocFile(relativePath: string) {
  return /(^|\/)(readme|docs\/.+)\.md$/i.test(relativePath)
}

function inferTestTool(relativePath: string, content: string) {
  if (/playwright/i.test(content) || /playwright/i.test(relativePath)) return 'playwright'
  if (/cypress|cy\./i.test(content) || /\.cy\./.test(relativePath)) return 'cypress'
  if (/vitest|vi\./i.test(content)) return 'vitest'
  return 'unknown'
}

function firstMatchingPath(files: ScannedFile[], extension: string) {
  return files.find((file) => file.relativePath.endsWith(extension))?.relativePath ?? extension
}

async function listFrontendRootCandidates(repoPath: string): Promise<string[]> {
  const directCandidates = ['.', 'frontend', 'web', 'client', 'ui', 'app'].map((entry) => path.join(repoPath, entry))
  const appsDir = path.join(repoPath, 'apps')
  const appEntries = await safeReadDir(appsDir)
  const nestedApps = appEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(appsDir, entry.name))

  const uniqueCandidates = Array.from(new Set([...directCandidates, ...nestedApps]))
  const existing: string[] = []

  for (const candidate of uniqueCandidates) {
    try {
      // lstat, not stat: a candidate root that is a symlink could point outside the repository (S-10).
      const stat = await fs.lstat(candidate)
      if (stat.isDirectory() && !stat.isSymbolicLink()) existing.push(candidate)
    } catch {
      // ignore missing candidate
    }
  }

  return existing
}

async function scoreFrontendRoot(repoPath: string, appRoot: string, packageJson: PackageJson | null): Promise<number> {
  let score = appRoot === repoPath ? 0 : 20
  const deps = new Set(collectDependencies(packageJson).map(([name]) => name))
  const relativeRoot = normalizePath(path.relative(repoPath, appRoot) || '.')

  if (['frontend', 'web', 'client', 'ui'].some((segment) => relativeRoot === segment || relativeRoot.startsWith(`${segment}/`))) {
    score += 30
  }

  if (['vite', 'react', 'next', 'vue', 'svelte', '@angular/core', '@angular/cli'].some((dep) => deps.has(dep))) {
    score += 60
  }

  if (Object.keys(packageJson?.scripts ?? {}).some((scriptName) => ['dev', 'build', 'start', 'preview'].includes(scriptName))) {
    score += 10
  }

  if (await exists(path.join(appRoot, 'index.html'))) score += 25
  if (await exists(path.join(appRoot, 'src', 'main.tsx'))) score += 25
  if (await exists(path.join(appRoot, 'src', 'main.jsx'))) score += 25
  if (await exists(path.join(appRoot, 'src', 'App.tsx'))) score += 20
  if (await exists(path.join(appRoot, 'src', 'App.jsx'))) score += 20
  if (await exists(path.join(appRoot, 'vite.config.ts'))) score += 25
  if (await exists(path.join(appRoot, 'vite.config.js'))) score += 25
  if (await exists(path.join(appRoot, 'pages'))) score += 10
  if (await exists(path.join(appRoot, 'app'))) score += 10

  return score
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}
