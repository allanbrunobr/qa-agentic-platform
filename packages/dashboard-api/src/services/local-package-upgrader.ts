/**
 * upgrade-local (A-03, docs/analise-20261109.md): brings an installed runtime to the current template
 * and applies the pending schema migrations to its databases. It never deletes or rewrites user data:
 *
 * 1. It requires an existing install (install metadata present); otherwise it stops before writing.
 * 2. Preflight, read-only: every runtime database under .agentic-qa is opened read-only and checked.
 *    A database written by a newer runtime stops the upgrade before anything is written.
 * 3. The runtime source is reinstalled with install-local, which copies only the runtime code and
 *    keeps the adapter files, the databases, artifacts and the user's .env.local (merged).
 * 4. Each database with pending migrations is checkpointed and copied next to itself
 *    (`<db>.pre-upgrade-<timestamp>.bak`) before its migrations run, each in its own transaction.
 * 5. The upgrade is recorded in the install metadata.
 *
 * Databases are looked for where the runtime opens them (see findRuntimeDatabases). One outside
 * .agentic-qa (a DATABASE_URL pointing elsewhere) is reported and left alone.
 */
import { copyFile, lstat, readFile, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { installLocalPackage, resolveConfinedInstallPath, resolveTemplateRoot } from './local-package-installer.ts'

type SqliteLike = {
  exec(sql: string): unknown
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }
}
type Migration = { version: number; name: string; up(db: SqliteLike): void }
type MigrationsModule = {
  applyMigrations(db: SqliteLike, component: string, migrations: Migration[]): { from: number; to: number; applied: number[] }
  SchemaTooNewError: new (component: string, found: number, supported: number) => Error
}
type RuntimeSchemaModule = {
  runtimeMigrations(openReference: () => SqliteLike & { close(): unknown }): Record<string, Migration[]>
}

export interface UpgradedDatabase {
  /** Relative to .agentic-qa. */
  path: string
  backup: string | null
  applied: Record<string, number[]>
}

export interface UpgradeLocalResult {
  installedPath: string
  previousTemplateVersion: string | null
  templateVersion: string | null
  upgradedAt: string
  databases: UpgradedDatabase[]
  skippedDatabases: Array<{ path: string; reason: string }>
}

async function loadTemplateModules(templateRoot: string) {
  const dbDir = path.join(templateRoot, 'packages', 'api', 'src', 'db')
  const migrations = await import(pathToFileURL(path.join(dbDir, 'migrations.ts')).href) as MigrationsModule
  const schema = await import(pathToFileURL(path.join(dbDir, 'runtime-schema.ts')).href) as RuntimeSchemaModule
  return { migrations, schema }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  const stat = await lstat(filePath).catch(() => null)
  return Boolean(stat?.isFile())
}

/**
 * The runtime's databases. The API opens `process.env.DATABASE_URL ?? './persona-qa.db'` relative to
 * its working directory: .agentic-qa with the launcher, .agentic-qa/packages/api with `npm run
 * dev:api`. The launcher exports only the provider keys from .env.local, so DATABASE_URL can only
 * come from the environment; run upgrade-local with the same environment as the runtime.
 */
async function findRuntimeDatabases(installedPath: string) {
  const candidates = new Set<string>([
    path.join(installedPath, 'persona-qa.db'),
    path.join(installedPath, 'packages', 'api', 'persona-qa.db'),
  ])
  const skipped: Array<{ path: string; reason: string }> = []
  const configured = process.env['DATABASE_URL']
  if (configured && configured !== ':memory:') {
    // A relative DATABASE_URL depends on where the API was started: try both working directories.
    const bases = path.isAbsolute(configured) ? [installedPath] : [installedPath, path.join(installedPath, 'packages', 'api')]
    for (const base of bases) {
      const resolved = path.resolve(base, configured)
      const relative = path.relative(installedPath, resolved)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        skipped.push({ path: configured, reason: 'DATABASE_URL points outside .agentic-qa; upgrade it by hand.' })
      } else {
        candidates.add(resolved)
      }
    }
  }
  const found: string[] = []
  for (const candidate of candidates) {
    if (await isRegularFile(candidate)) found.push(candidate)
  }
  return { found, skipped }
}

function recordedVersion(db: SqliteLike, component: string): number {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  if (!table) return 0
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE component = ?').get(component) as { version: number | null } | undefined
  return row?.version ?? 0
}

export async function upgradeLocalPackage(input: { repoPath: string; now?: Date }): Promise<UpgradeLocalResult> {
  if (!input.repoPath) throw new Error('repoPath is required')
  const installedPath = await resolveConfinedInstallPath(input.repoPath)
  const metadataPath = path.join(installedPath, 'adapter', 'config', 'install-metadata.generated.json')
  if (!(await isRegularFile(metadataPath))) {
    throw new Error(`upgrade-local: no installed runtime at ${installedPath}. Run install-local first.`)
  }
  const previous = JSON.parse(await readFile(metadataPath, 'utf8')) as { templateVersion?: unknown }

  const templateRoot = await resolveTemplateRoot()
  const { migrations, schema } = await loadTemplateModules(templateRoot)
  const openReference = () => new DatabaseSync(':memory:')
  const known = schema.runtimeMigrations(openReference)
  const { found, skipped } = await findRuntimeDatabases(installedPath)

  // Preflight, read-only: nothing is written if any database is newer than this runtime.
  const pending = new Map<string, boolean>()
  for (const file of found) {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      let hasPending = false
      for (const [component, list] of Object.entries(known)) {
        const version = recordedVersion(db, component)
        if (version > list.length) throw new migrations.SchemaTooNewError(component, version, list.length)
        if (version < list.length) hasPending = true
      }
      pending.set(file, hasPending)
    } finally {
      db.close()
    }
  }

  // Runtime source: install-local copies only the runtime code and merges .env.local.
  await installLocalPackage({ repoPath: input.repoPath })

  const upgradedAt = (input.now ?? new Date()).toISOString()
  const stamp = upgradedAt.replace(/[:.]/g, '-')
  const databases: UpgradedDatabase[] = []
  for (const file of found) {
    let backup: string | null = null
    const applied: Record<string, number[]> = {}
    if (pending.get(file)) {
      const writer = new DatabaseSync(file)
      try {
        // Fold the WAL into the main file so the backup is complete.
        writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        backup = `${file}.pre-upgrade-${stamp}.bak`
        await copyFile(file, backup, fsConstants.COPYFILE_EXCL)
        for (const [component, list] of Object.entries(schema.runtimeMigrations(openReference))) {
          applied[component] = migrations.applyMigrations(writer, component, list).applied
        }
      } finally {
        writer.close()
      }
    }
    databases.push({
      path: path.relative(installedPath, file),
      backup: backup ? path.relative(installedPath, backup) : null,
      applied,
    })
  }

  // install-local rewrote the metadata; add the upgrade record to it.
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
  const result: UpgradeLocalResult = {
    installedPath,
    previousTemplateVersion: typeof previous.templateVersion === 'string' ? previous.templateVersion : null,
    templateVersion: typeof metadata['templateVersion'] === 'string' ? metadata['templateVersion'] : null,
    upgradedAt,
    databases,
    skippedDatabases: skipped,
  }
  metadata['lastUpgrade'] = {
    upgradedAt,
    previousTemplateVersion: result.previousTemplateVersion,
    databases,
    skippedDatabases: skipped,
  }
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
  return result
}
