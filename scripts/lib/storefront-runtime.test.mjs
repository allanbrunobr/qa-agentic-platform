// Run with: node scripts/lib/storefront-runtime.test.mjs
//
// Ninth pre-PR run (docs/p2-progresso.md): the e2e fixture copies examples/storefront, and the copy
// filter only matched a generated directory with a path segment before it. The top-level
// .agentic-qa of a README quick start (and its .env.local, whose key wins over the empty provider
// override) was copied into the fixture, so the release gate could read a developer's key.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixtureCopyFilter } from './storefront-runtime.mjs'

let failed = 0
function check(condition, message) {
  if (condition) console.log('PASS:', message)
  else {
    failed += 1
    console.error('FAIL:', message)
  }
}

const root = path.join(path.sep, 'tmp', 'storefront')
const copies = fixtureCopyFilter(root)
for (const generated of ['.agentic-qa', '.agentic-qa/.env.local', 'node_modules', 'dist', 'app/node_modules/x.js', 'app/dist']) {
  check(!copies(path.join(root, generated)), `does not copy ${generated}`)
}
for (const source of ['', 'index.html', 'src/app.js', 'src/agentic-qa-notes.md', 'distribution/readme.md']) {
  check(copies(path.join(root, source)), `copies ${source || 'the root itself'}`)
}

// The copy itself, as the fixture makes it: a quick start's key must not reach the fixture.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-copy-'))
try {
  const example = path.join(work, 'storefront')
  fs.mkdirSync(path.join(example, '.agentic-qa'), { recursive: true })
  fs.writeFileSync(path.join(example, '.agentic-qa', '.env.local'), 'ANTHROPIC_API_KEY="sk-ant-CANARY-123"\n')
  fs.writeFileSync(path.join(example, 'index.html'), '<main>shop</main>\n')
  const target = path.join(work, 'copy')
  fs.cpSync(example, target, { recursive: true, filter: fixtureCopyFilter(example) })
  check(fs.existsSync(path.join(target, 'index.html')), 'the copy has the app files')
  check(!fs.existsSync(path.join(target, '.agentic-qa')), 'the copy has no .agentic-qa, so no developer key from a quick start')
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} fixture copy check(s) failed`)
  process.exit(1)
}
console.log('\nFixture copy checks passed')
