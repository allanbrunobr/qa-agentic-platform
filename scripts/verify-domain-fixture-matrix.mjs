import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { removeFixtureOnExit } from './lib/temp-fixture.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const tsxLoaderCandidates = [
  path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs'),
  path.join(repoRoot, 'templates/persona-qa-dashboard/node_modules/tsx/dist/loader.mjs'),
]
const tsxLoader = tsxLoaderCandidates.find((candidate) => fs.existsSync(candidate))
const preferredNodeBin = process.env.AGENTIC_RELEASE_NODE_BIN
  ?? path.dirname(process.execPath)
const preferredNodePath = path.join(preferredNodeBin, 'node')
const nodePath = fs.existsSync(preferredNodePath) ? preferredNodePath : process.execPath

const fixtures = [
  {
    id: 'finance_operations',
    packageJson: {
      name: 'finance-operations-fixture',
      dependencies: {
        '@vitejs/plugin-react': '^5.0.0',
        react: '^18.2.0',
        'react-dom': '^18.2.0',
        'react-router-dom': '^6.22.0',
        vite: '^6.0.0',
      },
    },
    files: {
      'src/App.tsx': [
        'import { Link, Route, Routes } from "react-router-dom"',
        '',
        'export function FinanceApp() {',
        '  return <main>',
        '    <nav><Link to="/portfolio">Portfolio</Link><Link to="/transfers">Transfers</Link></nav>',
        '    <Routes>',
        '      <Route path="/portfolio" element={<PortfolioDashboard />} />',
        '      <Route path="/transfers" element={<TransferFunds />} />',
        '    </Routes>',
        '  </main>',
        '}',
        '',
        'function PortfolioDashboard() {',
        '  return <section><h1>Portfolio balance</h1><button>Review account allocation</button></section>',
        '}',
        '',
        'function TransferFunds() {',
        '  return <form onSubmit={submitTransfer}>',
        '    <h2>Transfer funds</h2>',
        '    <label>Amount</label><input name="amount" />',
        '    <label>Destination account</label><input name="destinationAccount" />',
        '    <button>Submit transfer</button>',
        '  </form>',
        '}',
      ],
      'tests/finance.spec.ts': [
        'import { test } from "@playwright/test"',
        'test("transfer funds from portfolio dashboard", async () => {})',
      ],
    },
  },
  {
    id: 'education_learning',
    packageJson: {
      name: 'education-learning-fixture',
      dependencies: {
        next: '^15.0.0',
        react: '^19.0.0',
        'react-dom': '^19.0.0',
      },
    },
    files: {
      'src/app/courses/page.tsx': [
        'export default function CoursesPage() {',
        '  return <main>',
        '    <a href="/assignments">Assignments</a>',
        '    <h1>Course catalog</h1>',
        '    <form onSubmit={enrollStudent}>',
        '      <label>Student email</label><input name="studentEmail" />',
        '      <label>Course code</label><input name="courseCode" />',
        '      <button>Enroll student</button>',
        '    </form>',
        '  </main>',
        '}',
      ],
      'src/app/assignments/page.tsx': [
        'export default function AssignmentsPage() {',
        '  return <main><h1>Assignment queue</h1><button>Review assignment</button></main>',
        '}',
      ],
      'e2e/education.spec.ts': [
        'import { test } from "@playwright/test"',
        'test("enroll student into course catalog", async () => {})',
      ],
    },
  },
  {
    id: 'commerce_checkout',
    packageJson: {
      name: 'commerce-checkout-fixture',
      dependencies: {
        '@vitejs/plugin-vue': '^5.0.0',
        vite: '^6.0.0',
        vue: '^3.4.0',
      },
    },
    files: {
      'src/App.vue': [
        '<template>',
        '  <main>',
        '    <nav><a href="/products">Products</a><a href="/checkout">Checkout</a></nav>',
        '    <h1>Product catalog</h1>',
        '    <form @submit="submitOrder">',
        '      <h2>Checkout details</h2>',
        '      <label>Customer email</label><input name="customerEmail" />',
        '      <label>Shipping address</label><input name="shippingAddress" />',
        '      <button>Place order</button>',
        '    </form>',
        '  </main>',
        '</template>',
      ],
      'tests/commerce.spec.ts': [
        'import { test } from "vitest"',
        'test("place order from product catalog", () => {})',
      ],
    },
  },
  {
    id: 'support_service',
    packageJson: {
      name: 'support-service-fixture',
      dependencies: {
        '@sveltejs/vite-plugin-svelte': '^4.0.0',
        svelte: '^5.0.0',
        vite: '^6.0.0',
      },
    },
    files: {
      'src/App.svelte': [
        '<main>',
        '  <nav><a href="/knowledge-base">Knowledge base</a></nav>',
        '  <h1>Support ticket queue</h1>',
        '  <h2>Service level review</h2>',
        '  <form on:submit={escalateTicket}>',
        '    <label>Ticket id</label><input name="ticketId" />',
        '    <label>Priority</label><select name="priority"></select>',
        '    <label>Customer email</label><input name="customerEmail" />',
        '    <button>Escalate ticket</button>',
        '  </form>',
        '</main>',
      ],
      'tests/support.spec.ts': [
        'import { test } from "vitest"',
        'test("escalate ticket from support queue", () => {})',
      ],
    },
  },
  {
    id: 'logistics_dispatch',
    packageJson: {
      name: 'logistics-dispatch-fixture',
      dependencies: {
        '@angular/core': '^18.0.0',
        '@angular/platform-browser': '^18.0.0',
        rxjs: '^7.8.0',
      },
    },
    files: {
      'src/app/app.component.ts': [
        'import { Component } from "@angular/core"',
        '',
        '@Component({',
        '  selector: "app-root",',
        '  template: `<main>',
        '    <nav><a href="/shipments">Warehouse shipments</a></nav>',
        '    <h1>Dispatch workspace</h1>',
        '    <form (ngSubmit)="createShipment()">',
        '      <label>Recipient name</label><input name="recipientName" />',
        '      <label>Dispatch date</label><input name="dispatchDate" />',
        '      <button>Create shipment</button>',
        '    </form>',
        '  </main>`',
        '})',
        'export class AppComponent {}',
      ],
      'tests/logistics.spec.ts': [
        'import { test } from "vitest"',
        'test("create shipment from dispatch workspace", () => {})',
      ],
    },
  },
  {
    id: 'technology_delivery',
    packageJson: null,
    files: {
      'index.html': [
        '<main>',
        '  <nav><a href="/incidents">Incidents</a></nav>',
        '  <h1>Deployment control center</h1>',
        '  <section><h2>Feature flag review</h2></section>',
        '  <form>',
        '    <label>Environment</label><input name="environment" />',
        '    <label>Version</label><input name="version" />',
        '    <button>Promote release</button>',
        '  </form>',
        '</main>',
      ],
      'README.md': ['# Delivery runbook'],
    },
  },
]

function log(message) {
  process.stdout.write(`[verify-domain-fixture-matrix] ${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function writeFixture(root, fixture) {
  const fixtureRoot = path.join(root, fixture.id)
  fs.mkdirSync(fixtureRoot, { recursive: true })
  if (fixture.packageJson) {
    fs.writeFileSync(path.join(fixtureRoot, 'package.json'), `${JSON.stringify(fixture.packageJson, null, 2)}\n`)
  }
  for (const [relativePath, lines] of Object.entries(fixture.files)) {
    const filePath = path.join(fixtureRoot, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`)
  }
}

try {
  assert(tsxLoader, 'tsx loader not found; install dependencies before running domain fixture matrix verification')
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-platform-domain-fixtures-'))
  removeFixtureOnExit(fixtureRoot, 'verify-domain-fixture-matrix')
  for (const fixture of fixtures) writeFixture(fixtureRoot, fixture)

  log(`fixtureRoot=${fixtureRoot}`)
  log('START domain fixture matrix')

  const verificationCode = `
    import fs from 'node:fs'
    import path from 'node:path'
    import {
      DOMAIN_FIXTURE_MATRIX,
      evaluateDomainFixture,
      evaluateDomainFixtureMatrix,
    } from './packages/dashboard-api/src/services/domain-fixture-matrix.ts'
    import { scanStaticFrontend } from './packages/dashboard-api/src/services/static-frontend-scanner.ts'

    function assert(condition, message) {
      if (!condition) throw new Error(message)
    }

    const fixtureRoot = process.env.AGENTIC_DOMAIN_FIXTURE_ROOT
    assert(fixtureRoot && fs.existsSync(fixtureRoot), 'fixture root should exist')

    const domains = new Set(DOMAIN_FIXTURE_MATRIX.map((fixture) => fixture.domain))
    assert(domains.size === DOMAIN_FIXTURE_MATRIX.length, 'each fixture should cover a distinct domain')
    assert(DOMAIN_FIXTURE_MATRIX.length >= 6, 'matrix should cover at least six domains')

    const surfaceMaps = {}
    const evaluations = []
    for (const expectation of DOMAIN_FIXTURE_MATRIX) {
      const repoPath = path.join(fixtureRoot, expectation.id)
      const surfaceMap = await scanStaticFrontend(repoPath, { targetId: expectation.id })
      surfaceMaps[expectation.id] = surfaceMap
      const evaluation = evaluateDomainFixture(surfaceMap, expectation)
      evaluations.push(evaluation)
      if (!evaluation.passed) {
        throw new Error(expectation.id + ' failed fixture evaluation: ' + JSON.stringify(evaluation.missing, null, 2))
      }
      assert(evaluation.matchedEvidenceRefs.length >= 3, expectation.id + ' should retain evidence refs for future candidate generation')
      assert(evaluation.expectedPersonaSeeds.length >= 2, expectation.id + ' should define persona seeds')
      assert(evaluation.expectedScenarioSeeds.length >= 2, expectation.id + ' should define scenario seeds')
      assert(evaluation.expectedCapabilityKinds.includes('form_submit'), expectation.id + ' should expect form submit capability coverage')
    }

    const matrixEvaluation = evaluateDomainFixtureMatrix(surfaceMaps)
    assert(matrixEvaluation.every((evaluation) => evaluation.passed), 'matrix aggregate should pass')
    console.log(JSON.stringify(evaluations.map((evaluation) => ({
      fixtureId: evaluation.fixtureId,
      domain: evaluation.domain,
      targetId: evaluation.targetId,
      matchedEvidenceRefs: evaluation.matchedEvidenceRefs.length,
      counts: evaluation.counts,
    })), null, 2))
  `

  const result = spawnSync(nodePath, ['--import', tsxLoader, '--input-type=module', '-e', verificationCode], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTIC_DOMAIN_FIXTURE_ROOT: fixtureRoot,
    },
    encoding: 'utf8',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert(result.status === 0, `domain fixture matrix verification failed with status ${result.status}`)
  log('PASS domain fixture matrix verification')
} catch (error) {
  process.stderr.write(`[verify-domain-fixture-matrix] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
