/**
 * upgrade-local (A-03): applies pending migrations to an installed runtime without destroying data.
 * Run with: npx tsx packages/dashboard-api/src/upgrade-local.test.ts
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
  // A relative DATABASE_URL, as dev:api resolves it from packages/api.
  await mkdir(path.join(installed, 'packages', 'api', 'data'), { recursive: true })
  const customDbFile = path.join(installed, 'packages', 'api', 'data', 'custom.db')
  writeOldDatabase(customDbFile)
  const previousDatabaseUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'data/custom.db'
  const adapterFile = path.join(installed, 'adapter', 'personas', 'personas.generated.json')
  await writeFile(adapterFile, '[{"id":"reviewed-by-hand"}]')
  // The key has characters the launcher refuses: the upgrade replaces it and must say so.
  await writeFile(path.join(installed, '.env.local'), 'PLAYWRIGHT_BASE_URL=http://127.0.0.1:4100\nANTHROPIC_API_KEY="has spaces"\n')
  const metadataPath = path.join(installed, 'adapter', 'config', 'install-metadata.generated.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
  await writeFile(metadataPath, JSON.stringify({ ...metadata, templateVersion: '0.0.9' }))

  const result = await upgradeLocalPackage({ repoPath: repo, now: new Date('2026-11-10T12:00:00.000Z') })
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = previousDatabaseUrl
  const customUpgraded = result.databases.find((item) => item.path === path.join('packages', 'api', 'data', 'custom.db'))
  check(Boolean(customUpgraded?.backup), 'a relative DATABASE_URL is also found where dev:api opens it, and backed up')
  const upgraded = result.databases.find((item) => item.path === 'persona-qa.db')
  const db = new DatabaseSync(dbFile)
  check(columns(db, 'p2_sessions').includes('run_id') && columns(db, 'runs').includes('high_count'), 'the pending migrations added the missing columns')
  check((db.prepare("SELECT status FROM p2_sessions WHERE session_id = 'old-session'").get() as { status?: string } | undefined)?.status === 'complete', 'existing sessions are kept')
  check((db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n === 1, 'existing runs are kept')
  check(JSON.stringify(db.prepare('SELECT component, version FROM schema_migrations ORDER BY component').all()) === JSON.stringify([{ component: 'dashboard', version: 1 }, { component: 'phase2-sessions', version: 1 }, { component: 'phase2-sessions', version: 2 }]), 'both components are recorded')
  db.close()
  const backupBytes = upgraded?.backup ? await readFile(path.join(installed, upgraded.backup)).catch(() => null) : null
  check(Boolean(backupBytes?.equals(originalBytes)), 'the database was backed up, byte for byte, before migrating')
  const devUpgraded = result.databases.find((item) => item.path === path.join('packages', 'api', 'persona-qa.db'))
  const devDb = new DatabaseSync(devDbFile)
  check(Boolean(devUpgraded?.backup) && columns(devDb, 'p2_sessions').includes('run_id'), 'the dev:api database (packages/api) is backed up and migrated too')
  devDb.close()
  check(JSON.stringify(upgraded?.applied) === JSON.stringify({ dashboard: [1], 'phase2-sessions': [1, 2] }), `the applied migrations are reported (${JSON.stringify(upgraded?.applied)})`)
  check(await readFile(adapterFile, 'utf8') === '[{"id":"reviewed-by-hand"}]', 'adapter files reviewed by the user are untouched')
  check((await readFile(path.join(installed, '.env.local'), 'utf8')).includes('PLAYWRIGHT_BASE_URL=http://127.0.0.1:4100'), 'the user variables in .env.local are kept')
  check(JSON.stringify(result.envLocalReplacedKeys) === '["ANTHROPIC_API_KEY"]', `the upgrade result lists the replaced .env.local key (${JSON.stringify(result.envLocalReplacedKeys)})`)
  const after = JSON.parse(await readFile(metadataPath, 'utf8')) as { templateVersion?: string; lastUpgrade?: { previousTemplateVersion?: string; upgradedAt?: string } }
  check(after.lastUpgrade?.previousTemplateVersion === '0.0.9' && after.lastUpgrade.upgradedAt === '2026-11-10T12:00:00.000Z', 'the upgrade is recorded in the install metadata')
  check(result.previousTemplateVersion === '0.0.9' && result.templateVersion === after.templateVersion, 'the result names the versions before and after')

  // 3. Running it again changes nothing in the database and makes no new backup.
  const again = await upgradeLocalPackage({ repoPath: repo, now: new Date('2026-11-10T13:00:00.000Z') })
  const second = again.databases.find((item) => item.path === 'persona-qa.db')
  check(second?.backup === null && JSON.stringify(second?.applied) === '{}', 'a second upgrade has nothing pending and makes no backup')
  check((await readdir(installed)).filter((name) => name.includes('.pre-upgrade-')).length === 1, 'still exactly one backup of the main database')

  // 3b. Fourth pre-PR run, #1: the discover-local of earlier versions deleted the install metadata.
  //     Such an install is recognised by its runtime code and upgraded, with no previous version known.
  const noMetadata = await tempRepo('no-metadata')
  await installLocalPackage({ repoPath: noMetadata })
  const noMetadataRoot = path.join(noMetadata, '.agentic-qa')
  writeOldDatabase(path.join(noMetadataRoot, 'persona-qa.db'))
  await rm(path.join(noMetadataRoot, 'adapter', 'config', 'install-metadata.generated.json'))
  let noMetadataError = ''
  const recovered = await upgradeLocalPackage({ repoPath: noMetadata }).catch((error) => {
    noMetadataError = error instanceof Error ? error.message : String(error)
    return null
  })
  check(recovered !== null && recovered.previousTemplateVersion === null, `an install whose metadata an older discover-local deleted is still upgraded (${noMetadataError || 'ok'})`)
  check(Boolean(recovered?.databases.find((item) => item.path === 'persona-qa.db')?.backup), 'its database is backed up and migrated')
  check(await exists(path.join(noMetadataRoot, 'adapter', 'config', 'install-metadata.generated.json')), 'the install metadata is written again')

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

  // A-04 pre-PR run, #3: the copy only overwrote, so runtime files the template had removed (the legacy
  // run routes, their runner and pages) stayed in an upgraded install. Runtime code the template no
  // longer has is removed; what the copy leaves out (dependencies, builds, data, artifacts) is kept.
  const stale = await tempRepo('stale')
  await installLocalPackage({ repoPath: stale })
  const inStale = (...parts: string[]) => path.join(stale, '.agentic-qa', ...parts)
  const staleFiles = [
    inStale('packages', 'api', 'src', 'routes', 'runs.ts'),
    inStale('packages', 'api', 'src', 'services', 'runner.ts'),
    inStale('packages', 'web', 'src', 'pages', 'Runs.tsx'),
    inStale('packages', 'web', 'src', 'legacy-only', 'Old.tsx'),
  ]
  const keptFiles = [
    inStale('packages', 'web', 'node_modules', 'some-dep', 'index.js'),
    inStale('packages', 'web', 'dist', 'index.html'),
    inStale('packages', 'api', 'artifacts', 'screenshots', 's1', '1.png'),
    inStale('adapter', 'scenarios', 'scenarios.reviewed.json'),
    inStale('data', 'runtime-settings.json'),
  ]
  for (const file of [...staleFiles, ...keptFiles]) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, 'x')
  }
  const staleResult = await upgradeLocalPackage({ repoPath: stale })
  for (const file of staleFiles) check(!(await exists(file)), `upgrade removes runtime code the template no longer has: ${path.relative(stale, file)}`)
  check(!(await exists(inStale('packages', 'web', 'src', 'legacy-only'))), 'and the directory it leaves empty')
  for (const file of keptFiles) check(await exists(file), `upgrade keeps what the copy leaves out: ${path.relative(stale, file)}`)
  check(await exists(inStale('packages', 'api', 'src', 'app.ts')), 'the current runtime code is in place')
  // Pre-PR review of 0d64b8d, #3: the sweep deleted any file the template lacks, so a database the
  // upgrader accepts through DATABASE_URL under a swept directory was deleted before its migration.
  // Only runtime source files are swept; data, databases and their WAL files are never deleted.
  const dbStale = await tempRepo('stale-db')
  await installLocalPackage({ repoPath: dbStale })
  const inDbStale = (...parts: string[]) => path.join(dbStale, '.agentic-qa', ...parts)
  const sweptDb = inDbStale('packages', 'api', 'src', 'persona-qa.db')
  writeOldDatabase(sweptDb)
  const marker = new DatabaseSync(sweptDb)
  marker.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('alive')")
  marker.close()
  // Not a -wal file: SQLite itself discards an invalid WAL beside the database it opens.
  // Pre-PR review of c477db1: data in JSON or Markdown (a personas file a PERSONA_QA_* variable points
  // at, say) is not runtime code either, so it is kept too.
  const keptBeside = [
    inDbStale('packages', 'api', 'src', 'export.csv'),
    inDbStale('packages', 'web', 'local.sqlite'),
    inDbStale('packages', 'api', 'src', 'personas.custom.json'),
    inDbStale('packages', 'web', 'notes.md'),
  ]
  for (const file of keptBeside) await writeFile(file, 'x')
  const previousUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'src/persona-qa.db'
  let dbStaleResult
  try {
    dbStaleResult = await upgradeLocalPackage({ repoPath: dbStale })
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
  }
  check(await exists(sweptDb), 'a database under a swept directory survives the upgrade')
  // A deleted database is recreated empty by the migration, so a missing table means its data was lost.
  let markerRows: Array<{ v: string }> = []
  try {
    markerRows = new DatabaseSync(sweptDb).prepare('SELECT v FROM marker').all() as Array<{ v: string }>
  } catch {
    markerRows = []
  }
  check(markerRows[0]?.v === 'alive', `and keeps its data (got ${JSON.stringify(markerRows)})`)
  for (const file of keptBeside) check(await exists(file), `a data file under a swept directory is kept: ${path.relative(dbStale, file)}`)
  check(!(dbStaleResult?.removedStaleFiles ?? []).some((file) => /\.(db|sqlite)/.test(file)), 'no database is listed as removed')

  const removedReport = staleResult.removedStaleFiles ?? []
  check(removedReport.length === staleFiles.length && removedReport.every((file) => !path.isAbsolute(file)), `the upgrade result lists the removed files, relative (got ${JSON.stringify(removedReport)})`)
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
