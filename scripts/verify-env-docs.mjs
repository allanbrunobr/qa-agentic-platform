// M-01 (docs/analise-20261109.md): every environment variable the code reads must appear in
// docs/environment-variables.md. Deterministic: the variables are found by pattern, not by judgment.
//
// Counted as a read, in non-test source files:
//   - process.env.NAME, process.env['NAME'], env.NAME, env['NAME'];
//   - names in an envState([...]) call (routes/stats.ts);
//   - any string literal AGENTIC_*, PERSONA_QA_*, PHASE2_*, ANTHROPIC_* or OPENAI_*, which also catches names passed
//     to helpers such as readNumberEnv('...').
// A name built at run time from other parts is not seen.
// Not counted: Vite's import.meta.env, and the process-level names in IGNORED.
// Documented means the name appears in backticks in the doc.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docPath = path.join(repoRoot, 'docs', 'environment-variables.md')
const roots = [
  'packages',
  'adapters',
  'scripts',
  'templates/persona-qa-dashboard/packages/api/src',
  'templates/persona-qa-dashboard/packages/web/src',
  'templates/persona-qa-dashboard/packages/web/vite.config.ts',
]
const IGNORED = new Set(['PATH', 'NODE_ENV', 'VITEST', 'NODE_NO_WARNINGS', 'HOME', 'TMPDIR'])
const SOURCE = /\.(?:[cm]?[jt]sx?)$/
const TEST = /(?:__tests__|\.test\.[cm]?[jt]sx?$|\.regression\.test\.)/

function* files(entry) {
  const full = path.join(repoRoot, entry)
  if (!fs.existsSync(full)) return
  const stat = fs.lstatSync(full)
  if (stat.isFile()) {
    yield entry
    return
  }
  if (!stat.isDirectory()) return
  for (const child of fs.readdirSync(full)) {
    if (child === 'node_modules' || child === 'dist' || child === 'coverage') continue
    yield* files(path.join(entry, child))
  }
}

const READ = /(?<!meta\.)\benv(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\])/g
const ENV_STATE_CALL = /\benvState\(\s*\[([^\]]*)\]/g
const PREFIXED_LITERAL =/['"`]((?:AGENTIC|PERSONA_QA|PHASE2|ANTHROPIC|OPENAI)_[A-Z0-9_]+)['"`]/g

const found = new Map()
for (const root of roots) {
  for (const file of files(root)) {
    if (!SOURCE.test(file) || TEST.test(file) || file === path.join('scripts', 'verify-env-docs.mjs')) continue
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    const names = []
    for (const pattern of [READ, PREFIXED_LITERAL]) {
      for (const match of text.matchAll(pattern)) names.push(match[1] ?? match[2])
    }
    // Names read through a helper that takes a list: envState(['TEST_USER'], ...) in routes/stats.ts.
    for (const match of text.matchAll(ENV_STATE_CALL)) {
      for (const literal of match[1].matchAll(/['"`]([A-Z][A-Z0-9_]{2,})['"`]/g)) names.push(literal[1])
    }
    for (const name of names) {
      if (!name || IGNORED.has(name)) continue
      if (!found.has(name)) found.set(name, new Set())
      found.get(name).add(file)
    }
  }
}

const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : ''
const documented = new Set(Array.from(doc.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g), (match) => match[1]))
const missing = [...found.keys()].filter((name) => !documented.has(name)).sort()

console.log(`[verify-env-docs] ${found.size} variables read by the code, ${found.size - missing.length} documented`)
if (missing.length > 0) {
  console.error(`[verify-env-docs] not documented in docs/environment-variables.md:`)
  for (const name of missing) console.error(`  ${name}  (${[...found.get(name)].join(', ')})`)
  process.exit(1)
}
