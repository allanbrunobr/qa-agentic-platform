/**
 * upgrade-local (A-03): applies pending migrations to an installed runtime without destroying data.
 * Run with: npx tsx packages/dashboard-api/src/upgrade-local.test.ts
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { installLocalPackage } from './services/local-package-installer.ts'
import { upgradeLocalPackage } from './services/local-package-upgrader.ts'

let failed = 0
function check(condition: unknown, message: string) {
  if (condition) console.log('PASS:', message)
  else {
    failed += 1
    console.error('FAIL:', message)
  }
}

const exists = (target: string) => stat(target).then(() => true, () => false)
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)

const saved = Object.fromEntries(['ANTHROPIC_API_KEY_OVERRIDE', 'OPENAI_API_KEY_OVERRIDE', 'AGENTIC_QA_SKIP_KEY_VALIDATION'].map((key) => [key, process.env[key]]))
process.env.ANTHROPIC_API_KEY_OVERRIDE = ''
process.env.OPENAI_API_KEY_OVERRIDE = ''
process.env.AGENTIC_QA_SKIP_KEY_VALIDATION = '1'
const dirs: string[] = []
async function tempRepo(label: string) {
  const dir = await mkdtemp(path.join(tmpdir(), `agentic-upgrade-${label}-`))
  dirs.push(dir)
  return dir
}

/** A runtime database as an older install left it: columns added since then are missing. */
function writeOldDatabase(file: string) {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE p2_sessions (
      session_id TEXT PRIMARY KEY,
      scenario_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    INSERT INTO p2_sessions VALUES ('old-session', 'checkout', 'complete', '2026-01-01T00:00:00.000Z');
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id TEXT NOT NULL,
      scenario_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT NOT NULL
    );
    INSERT INTO runs (scenario_id, scenario_name, session_id, status, started_at)
      VALUES ('checkout', 'Checkout', 'old-session', 'passed', '2026-01-01T00:00:00.000Z');
  `)
  db.close()
}

try {
  // 1. Without an install there is nothing to upgrade, and nothing is created.
  const empty = await tempRepo('empty')
  let refusedEmpty = ''
  try {
    await upgradeLocalPackage({ repoPath: empty })
  } catch (error) {
    refusedEmpty = error instanceof Error ? error.message : String(error)
  }
  check(/install-local first/i.test(refusedEmpty), `upgrade without an install is refused (${refusedEmpty})`)
  check(!(await exists(path.join(empty, '.agentic-qa'))), 'a refused upgrade creates nothing')

  // 2. An older install: data, adapter files and .env.local survive; pending migrations run on a backup-first basis.
  const repo = await tempRepo('old')
  await installLocalPackage({ repoPath: repo })
  const installed = path.join(repo, '.agentic-qa')
  const dbFile = path.join(installed, 'persona-qa.db')
  writeOldDatabase(dbFile)
  const originalBytes = await readFile(dbFile)
  // `npm run dev:api` runs the API from packages/api, so its database lives there.
  const devDbFile = path.join(installed, 'packages', 'api', 'persona-qa.db')
  writeOldDatabase(devDbFile)
  const adapterFile = path.join(installed, 'adapter', 'personas', 'personas.generated.json')
  await writeFile(adapterFile, '[{"id":"reviewed-by-hand"}]')
  await writeFile(path.join(installed, '.env.local'), 'PLAYWRIGHT_BASE_URL=http://127.0.0.1:4100\n')
  const metadataPath = path.join(installed, 'adapter', 'config', 'install-metadata.generated.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
  await writeFile(metadataPath, JSON.stringify({ ...metadata, templateVersion: '0.0.9' }))

  const result = await upgradeLocalPackage({ repoPath: repo, now: new Date('2026-11-10T12:00:00.000Z') })
  const upgraded = result.databases.find((item) => item.path === 'persona-qa.db')
  const db = new DatabaseSync(dbFile)
  check(columns(db, 'p2_sessions').includes('run_id') && columns(db, 'runs').includes('high_count'), 'the pending migrations added the missing columns')
  check((db.prepare("SELECT status FROM p2_sessions WHERE session_id = 'old-session'").get() as { status?: string } | undefined)?.status === 'complete', 'existing sessions are kept')
  check((db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n === 1, 'existing runs are kept')
  check(JSON.stringify(db.prepare('SELECT component, version FROM schema_migrations ORDER BY component').all()) === JSON.stringify([{ component: 'dashboard', version: 1 }, { component: 'phase2-sessions', version: 1 }]), 'both components are recorded')
  db.close()
  const backupBytes = upgraded?.backup ? await readFile(path.join(installed, upgraded.backup)).catch(() => null) : null
  check(Boolean(backupBytes?.equals(originalBytes)), 'the database was backed up, byte for byte, before migrating')
  const devUpgraded = result.databases.find((item) => item.path === path.join('packages', 'api', 'persona-qa.db'))
  const devDb = new DatabaseSync(devDbFile)
  check(Boolean(devUpgraded?.backup) && columns(devDb, 'p2_sessions').includes('run_id'), 'the dev:api database (packages/api) is backed up and migrated too')
  devDb.close()
  check(JSON.stringify(upgraded?.applied) === JSON.stringify({ dashboard: [1], 'phase2-sessions': [1] }), `the applied migrations are reported (${JSON.stringify(upgraded?.applied)})`)
  check(await readFile(adapterFile, 'utf8') === '[{"id":"reviewed-by-hand"}]', 'adapter files reviewed by the user are untouched')
  check((await readFile(path.join(installed, '.env.local'), 'utf8')).includes('PLAYWRIGHT_BASE_URL=http://127.0.0.1:4100'), 'the user variables in .env.local are kept')
  const after = JSON.parse(await readFile(metadataPath, 'utf8')) as { templateVersion?: string; lastUpgrade?: { previousTemplateVersion?: string; upgradedAt?: string } }
  check(after.lastUpgrade?.previousTemplateVersion === '0.0.9' && after.lastUpgrade.upgradedAt === '2026-11-10T12:00:00.000Z', 'the upgrade is recorded in the install metadata')
  check(result.previousTemplateVersion === '0.0.9' && result.templateVersion === after.templateVersion, 'the result names the versions before and after')

  // 3. Running it again changes nothing in the database and makes no new backup.
  const again = await upgradeLocalPackage({ repoPath: repo, now: new Date('2026-11-10T13:00:00.000Z') })
  const second = again.databases.find((item) => item.path === 'persona-qa.db')
  check(second?.backup === null && JSON.stringify(second?.applied) === '{}', 'a second upgrade has nothing pending and makes no backup')
  check((await readdir(installed)).filter((name) => name.includes('.pre-upgrade-')).length === 1, 'still exactly one backup of the main database')

  // 4. A database from a newer runtime: refused before any write, the installed code included.
  const newer = await tempRepo('newer')
  await installLocalPackage({ repoPath: newer })
  const newerDb = path.join(newer, '.agentic-qa', 'persona-qa.db')
  const seed = new DatabaseSync(newerDb)
  seed.exec("CREATE TABLE schema_migrations (component TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (component, version)); INSERT INTO schema_migrations VALUES ('phase2-sessions', 99, 'future', 'later');")
  seed.close()
  const newerBytes = await readFile(newerDb)
  const sentinel = path.join(newer, '.agentic-qa', 'packages', 'api', 'src', 'index.ts')
  await writeFile(sentinel, `${await readFile(sentinel, 'utf8')}\n// sentinel: must survive a refused upgrade\n`)
  let refusedNewer = ''
  try {
    await upgradeLocalPackage({ repoPath: newer })
  } catch (error) {
    refusedNewer = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  check(/SchemaTooNewError/.test(refusedNewer), `a database from a newer runtime stops the upgrade (${refusedNewer.slice(0, 80)})`)
  check((await readFile(newerDb)).equals(newerBytes), 'that database is left byte for byte as it was')
  check((await readFile(sentinel, 'utf8')).includes('sentinel: must survive'), 'the installed code is not replaced either')
  check((await readdir(path.join(newer, '.agentic-qa'))).every((name) => !name.includes('.pre-upgrade-')), 'no backup is made')
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} upgrade-local check(s) failed`)
  process.exit(1)
}
console.log('\nupgrade-local checks passed')
