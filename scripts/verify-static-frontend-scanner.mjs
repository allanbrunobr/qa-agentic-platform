import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { removeFixtureOnExit } from './lib/temp-fixture.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const fixtureRoot = path.join(os.tmpdir(), `agentic-platform-static-frontend-scanner-${Date.now()}`)
const tsxLoaderCandidates = [
  path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs'),
  path.join(repoRoot, 'templates/persona-qa-dashboard/node_modules/tsx/dist/loader.mjs'),
]
const tsxLoader = tsxLoaderCandidates.find((candidate) => fs.existsSync(candidate))
const preferredNodeBin = process.env.AGENTIC_RELEASE_NODE_BIN
  ?? path.dirname(process.execPath)
const preferredNodePath = path.join(preferredNodeBin, 'node')
const nodePath = fs.existsSync(preferredNodePath) ? preferredNodePath : process.execPath

function log(message) {
  process.stdout.write(`[verify-static-frontend-scanner] ${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function writeFile(fixtureName, relativePath, content) {
  const filePath = path.join(fixtureRoot, fixtureName, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function writePackage(fixtureName, packageJson) {
  writeFile(fixtureName, 'package.json', `${JSON.stringify(packageJson, null, 2)}\n`)
}

function createFixtures() {
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
  fs.mkdirSync(fixtureRoot, { recursive: true })
  removeFixtureOnExit(fixtureRoot, 'verify-static-frontend-scanner')

  writePackage('vite-finance', {
    name: 'vite-finance-fixture',
    private: true,
    dependencies: {
      '@vitejs/plugin-react': '^latest',
      react: '^18.0.0',
      vite: '^6.0.0',
    },
    devDependencies: {
      '@playwright/test': '^1.0.0',
    },
  })
  writeFile('vite-finance', 'index.html', '<div id="root"></div>\n')
  writeFile('vite-finance', 'src/App.tsx', `export function App() {
  return (
    <main>
      <h1>Portfolio dashboard</h1>
      <nav><a href="/accounts">Accounts</a></nav>
      <form onSubmit={submitTransfer}>
        <label>Amount</label>
        <input name="amount" placeholder="Amount" />
        <label>API_KEY=fake-test-secret-value-1234567890</label>
        <button aria-label="Submit transfer">Transfer</button>
        <button>{isOpen)}</button>
        <button className="text-lg">text-lg</button>
      </form>
    </main>
  )
}
`)
  writeFile('vite-finance', 'src/services/SessionStateManager.tsx', `export function SessionStateManager() {
  return null
}
export const API_BASE_URL = 'http://example.test'
`)
  writeFile('vite-finance', 'tests/transfer.spec.ts', `import { test } from '@playwright/test'
test('account holder transfers funds', async () => {})
`)
  writeFile('vite-finance', 'README.md', '# Finance dashboard fixture\n')

  writePackage('next-app', {
    name: 'next-app-fixture',
    dependencies: {
      next: '^15.0.0',
      react: '^19.0.0',
    },
  })
  writeFile('next-app', 'src/app/dashboard/page.tsx', `export default function DashboardPage() {
  return <h1>Dashboard</h1>
}
`)
  writeFile('next-app', 'src/app/(auth)/login/page.tsx', `export default function LoginPage() {
  return <button>Sign in</button>
}
`)
  writeFile('next-app', 'src/pages/reports/[id].tsx', `export default function ReportPage() {
  return <h1>Report detail</h1>
}
`)

  writePackage('vue-app', {
    name: 'vue-app-fixture',
    dependencies: { vue: '^3.0.0' },
  })
  writeFile('vue-app', 'src/App.vue', `<template><button>Save customer</button></template>\n`)

  writePackage('svelte-app', {
    name: 'svelte-app-fixture',
    dependencies: { svelte: '^5.0.0' },
  })
  writeFile('svelte-app', 'src/App.svelte', `<button>Enroll student</button>\n`)

  writePackage('angular-app', {
    name: 'angular-app-fixture',
    dependencies: { '@angular/core': '^19.0.0' },
  })
  writeFile('angular-app', 'src/app/app.component.html', `<button>Approve request</button>\n`)

  writeFile('static-html', 'index.html', `<main>
  <h1>Public landing page</h1>
  <a href="/pricing">Pricing</a>
  <button>Start now</button>
</main>
`)
}

try {
  assert(tsxLoader, 'tsx loader not found; install dependencies before running static frontend scanner verification')
  createFixtures()
  log(`fixtureRoot=${fixtureRoot}`)

  const verificationCode = `
    import path from 'node:path'
    import { scanStaticFrontend } from './packages/dashboard-api/src/services/static-frontend-scanner.ts'

    const fixtureRoot = process.env.FIXTURE_ROOT

    function assert(condition, message) {
      if (!condition) throw new Error(message)
    }

    function byId(list, id) {
      return list.find((item) => item.id === id)
    }

    function frameworkNames(surfaceMap) {
      return surfaceMap.frameworks.map((item) => item.frameworkName)
    }

    const finance = await scanStaticFrontend(path.join(fixtureRoot, 'vite-finance'))
    assert(frameworkNames(finance).includes('vite'), 'vite fixture should detect Vite')
    assert(frameworkNames(finance).includes('react'), 'vite fixture should detect React')
    assert(byId(finance.routes, 'route_root'), 'vite fixture should include root route from index.html')
    assert(finance.forms.some((form) => form.fields.some((field) => field.toLowerCase() === 'amount')), 'vite fixture should extract form fields')
    assert(finance.buttons.some((button) => button.buttonText === 'Submit transfer'), 'vite fixture should extract aria button text')
    assert(!finance.buttons.some((button) => button.buttonText === 'isOpen)'), 'scanner should ignore code-like button labels')
    assert(!finance.buttons.some((button) => button.buttonText === 'text-lg'), 'scanner should ignore utility-class button labels')
    assert(finance.navigation.some((nav) => nav.targetPath === '/accounts'), 'vite fixture should extract navigation href')
    assert(finance.tests.some((test) => test.testName === 'account holder transfers funds' && test.tool === 'playwright'), 'vite fixture should extract Playwright test names')
    assert(!finance.components.some((component) => component.componentName === 'SessionStateManager'), 'scanner should ignore service-like component files')
    assert(!finance.components.some((component) => component.componentName === 'API_BASE_URL'), 'scanner should ignore constant-like exported names')
    assert(!JSON.stringify(finance).includes('fake-test-secret'), 'scanner output should redact key-like values')

    const next = await scanStaticFrontend(path.join(fixtureRoot, 'next-app'))
    assert(frameworkNames(next).includes('nextjs'), 'next fixture should detect Next.js')
    assert(next.routes.some((route) => route.path === '/dashboard'), 'next app router route should be extracted')
    assert(next.routes.some((route) => route.path === '/login'), 'next route groups should be removed')
    assert(next.routes.some((route) => route.path === '/reports/:id'), 'next dynamic pages route should be extracted')

    const vue = await scanStaticFrontend(path.join(fixtureRoot, 'vue-app'))
    assert(frameworkNames(vue).includes('vue'), 'vue fixture should detect Vue')
    assert(vue.buttons.some((button) => button.buttonText === 'Save customer'), 'vue fixture should extract button')

    const svelte = await scanStaticFrontend(path.join(fixtureRoot, 'svelte-app'))
    assert(frameworkNames(svelte).includes('svelte'), 'svelte fixture should detect Svelte')
    assert(svelte.buttons.some((button) => button.buttonText === 'Enroll student'), 'svelte fixture should extract button')

    const angular = await scanStaticFrontend(path.join(fixtureRoot, 'angular-app'))
    assert(frameworkNames(angular).includes('angular'), 'angular fixture should detect Angular')
    assert(angular.buttons.some((button) => button.buttonText === 'Approve request'), 'angular fixture should extract template button')

    const html = await scanStaticFrontend(path.join(fixtureRoot, 'static-html'))
    assert(frameworkNames(html).includes('generic_frontend'), 'static fixture should fallback to generic frontend')
    assert(html.navigation.some((nav) => nav.targetPath === '/pricing'), 'static fixture should extract anchor navigation')
    assert(html.buttons.some((button) => button.buttonText === 'Start now'), 'static fixture should extract button')
  `

  log('START scanner fixtures')
  const result = spawnSync(nodePath, ['--import', tsxLoader, '--input-type=module', '-e', verificationCode], {
    cwd: repoRoot,
    env: {
      ...process.env,
      FIXTURE_ROOT: fixtureRoot,
    },
    encoding: 'utf8',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert(result.status === 0, `scanner fixture verification failed with status ${result.status}`)
  log('PASS static frontend scanner verification')
} catch (error) {
  process.stderr.write(`[verify-static-frontend-scanner] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
