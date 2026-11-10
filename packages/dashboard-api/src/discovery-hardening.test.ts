/**
 * Discovery over an untrusted repository (ADR 0004): S-09, S-10 and S-11 in docs/analise-20261109.md.
 * Run with: npx tsx packages/dashboard-api/src/discovery-hardening.test.ts
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GenericFrontendDiscoveryProvider } from './services/generic-discovery-provider.ts'
import { buildCapabilityRuntimeStub } from './services/local-discovery-materializer.ts'
import { looksLikeUtilityClassLabel, scanStaticFrontend } from './services/static-frontend-scanner.ts'

let failed = 0
function check(condition: unknown, message: string) {
  if (condition) console.log('PASS:', message)
  else {
    failed += 1
    console.error('FAIL:', message)
  }
}

const created: string[] = []
async function temp(label: string) {
  const dir = await mkdtemp(path.join(tmpdir(), `agentic-discovery-${label}-`))
  created.push(dir)
  return dir
}
async function put(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}
const reactPackage = JSON.stringify({ name: 'x', dependencies: { react: '18', vite: '5' }, scripts: { dev: 'vite' } })

// S-09: text from the target used to go through a regex with nested ambiguous quantifiers
// (exponential backtracking: 97 characters took 22.8 s in the review). It must stay fast.
async function testUtilityClassRegex() {
  check(looksLikeUtilityClassLabel('text-gray-500 bg-white px-4'), 'utility class lists are still recognized')
  check(looksLikeUtilityClassLabel('px-4 py-2'), 'short utility lists are still recognized')
  check(!looksLikeUtilityClassLabel('Place order'), 'ordinary labels are not utility classes')

  const adversarial = `a-${'aaaa-'.repeat(200)}aaaa!`
  const started = performance.now()
  looksLikeUtilityClassLabel(adversarial)
  const elapsed = performance.now() - started
  check(elapsed < 100, `a 1000-character adversarial label is checked quickly (${elapsed.toFixed(1)} ms)`)

  const repo = await temp('redos')
  await put(path.join(repo, 'package.json'), reactPackage)
  await put(path.join(repo, 'src', 'App.tsx'), `export default function App() { return <h1>${'aaaa-'.repeat(40)}aaaa !</h1> }\n`)
  const scanStarted = performance.now()
  await scanStaticFrontend(repo)
  const scanElapsed = performance.now() - scanStarted
  check(scanElapsed < 2_000, `scanning a page with an adversarial heading stays fast (${scanElapsed.toFixed(0)} ms)`)
}

// S-10: scanners followed symlinks out of the repository.
async function testSymlinkedSources() {
  const outsideRoot = await temp('outside-root')
  await put(path.join(outsideRoot, 'package.json'), reactPackage)
  await put(path.join(outsideRoot, 'src', 'Secret.tsx'), 'export const S = () => <h1>Secret from outside the repo</h1>\n')
  const repoRoot = await temp('repo-root')
  await put(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'b' }))
  await symlink(outsideRoot, path.join(repoRoot, 'frontend'))
  const surfaceMap = await scanStaticFrontend(repoRoot)
  check(!JSON.stringify(surfaceMap).includes('Secret from outside the repo'), 'a frontend root that is a symlink is not scanned')

  const outsideFile = await temp('outside-file')
  await put(path.join(outsideFile, 'notes.txt'), "app.get('/leaked-from-outside', (req, res) => res.send('x'))\n")
  const repoFile = await temp('repo-file')
  await put(path.join(repoFile, 'package.json'), JSON.stringify({ name: 'c', dependencies: { express: '4' }, scripts: { start: 'node src/server.js' } }))
  await put(path.join(repoFile, 'src', 'server.js'), "const express=require('express');const app=express();app.get('/health',(q,r)=>r.send('ok'));app.listen(3000)\n")
  await symlink(path.join(outsideFile, 'notes.txt'), path.join(repoFile, 'src', 'leak.ts'))
  const report = await new GenericFrontendDiscoveryProvider().discover({ repoPath: repoFile } as never)
  const reportText = JSON.stringify(report)
  check(reportText.includes('/health'), 'the real route of the repository is still discovered')
  check(!reportText.includes('leaked-from-outside'), 'a source file that is a symlink is not read')

  // A real Express file, so its route WOULD be discovered if the file were read: only the size limit
  // keeps it out.
  await put(
    path.join(repoFile, 'src', 'huge.js'),
    `const express=require('express');const app=express();app.get('/from-huge-file',(q,r)=>r.send('x'));app.listen(3001)\n${'//'.repeat(400_000)}\n`,
  )
  const second = JSON.stringify(await new GenericFrontendDiscoveryProvider().discover({ repoPath: repoFile } as never))
  check(!second.includes('from-huge-file'), 'a source file over the size limit is not read')
}

// S-11: target-controlled text (routes, file names, URLs) was interpolated into a single-quoted
// string inside generated TypeScript, so a quote could turn it into code.
async function testGeneratedStub() {
  const marker = '__agenticStubInjection'
  const payload = `/x')+(globalThis.${marker}=1)+('`
  const stub = buildCapabilityRuntimeStub([{
    id: 'openX',
    routeHint: payload,
    graphHint: { handlers: [`src/app/x')+(globalThis.${marker}=2)+('/page.tsx:1`], endpoints: [], httpCalls: [], supportEdges: [] },
  } as never])
  const executable = stub.replace('export const generatedCapabilityHandlers =', 'return').replace(/\}\s*as const\s*$/, '}')
  const handlers = new Function(executable)() as Record<string, () => Promise<unknown>>
  let message = ''
  try {
    await handlers['openX']!()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check(!(marker in globalThis), 'target text in the generated stub is not executed')
  check(message.includes(payload), 'the generated stub keeps the target text verbatim in its message')
}

try {
  console.log('Running discovery hardening tests...\n')
  await testUtilityClassRegex()
  await testSymlinkedSources()
  await testGeneratedStub()
} finally {
  for (const dir of created) await rm(dir, { recursive: true, force: true })
}
if (failed > 0) {
  console.error(`\n${failed} discovery hardening check(s) failed`)
  process.exit(1)
}
console.log('\nDiscovery hardening checks passed')
