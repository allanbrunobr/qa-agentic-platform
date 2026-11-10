/**
 * Versioned schema migrations for the runtime's SQLite databases (A-03, docs/analise-20261109.md).
 *
 * The runtime is copied into each target repository, so a database created by an older install must
 * keep working after the runtime is updated. Before this module the schema was only
 * `CREATE TABLE IF NOT EXISTS`, which never adds a column to an existing table.
 *
 * - Versions are tracked per component in `schema_migrations`, not in `PRAGMA user_version`: the
 *   dashboard tables (db/index.ts) and the phase2 session tables (SessionService) live in the same
 *   file by default and would otherwise share one version number.
 * - Each migration runs in its own transaction and is recorded in the same transaction.
 * - A database whose recorded version is newer than this runtime knows is refused, instead of being
 *   used with a schema the code does not expect.
 * - Version 1 of each component is a baseline that also adopts databases created before versioning:
 *   it creates missing tables and adds the columns an older table lacks.
 * - Any later schema change must be a new numbered migration; the baseline never changes.
 *
 * Only `exec` and `prepare().get/all/run` are used, so the same code runs on better-sqlite3, on
 * node:sqlite and on the better-sqlite3 shim the installer writes.
 */

export interface SqliteLike {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
}

export interface Migration {
  version: number
  name: string
  up(db: SqliteLike): void
}

export class SchemaTooNewError extends Error {
  readonly code = 'schema_too_new'
  constructor(component: string, found: number, supported: number) {
    super(
      `The ${component} database schema is at version ${found}, but this runtime only knows up to version ${supported}. ` +
      'It was written by a newer runtime; update this runtime instead of using the database with it.',
    )
    this.name = 'SchemaTooNewError'
  }
}

export interface MigrationResult {
  from: number
  to: number
  applied: number[]
}

export function applyMigrations(db: SqliteLike, component: string, migrations: Migration[]): MigrationResult {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`${component} migrations must be numbered 1..n without gaps (found ${migration.version} at position ${index + 1})`)
    }
  })

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      component TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (component, version)
    )
  `)
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE component = ?').get(component) as
    | { version: number | null }
    | undefined
  const current = row?.version ?? 0
  const latest = migrations.length

  if (current > latest) throw new SchemaTooNewError(component, current, latest)

  const applied: number[] = []
  for (const migration of migrations) {
    if (migration.version <= current) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (component, version, name, applied_at) VALUES (?, ?, ?, ?)')
        .run(component, migration.version, migration.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* the failed statement may already have ended the transaction */ }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${component} migration ${migration.version} (${migration.name}) failed: ${message}`, { cause: error })
    }
    applied.push(migration.version)
  }

  return { from: current, to: Math.max(current, latest), applied }
}

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

function columnsOf(db: SqliteLike, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as ColumnInfo[]
}

/**
 * Adds to `db` every column that `reference` has and `db` lacks, table by table. Columns that SQLite
 * cannot add to an existing table (primary key, or NOT NULL without a default) fail loudly. A
 * foreign-key clause on an added column is not carried over.
 */
export function reconcileColumns(db: SqliteLike, reference: SqliteLike): string[] {
  const tables = reference
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  const added: string[] = []
  for (const { name: table } of tables) {
    const existing = new Set(columnsOf(db, table).map((column) => column.name))
    if (existing.size === 0) continue
    for (const column of columnsOf(reference, table)) {
      if (existing.has(column.name)) continue
      if (column.pk || (column.notnull && column.dflt_value === null)) {
        throw new Error(`cannot add column ${table}.${column.name} to an existing table (primary key, or NOT NULL without a default)`)
      }
      const notNull = column.notnull ? ' NOT NULL' : ''
      const defaultClause = column.dflt_value !== null ? ` DEFAULT ${column.dflt_value}` : ''
      db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column.name}" ${column.type}${notNull}${defaultClause}`)
      added.push(`${table}.${column.name}`)
    }
  }
  return added
}

/** Splits a DDL script into its CREATE INDEX statements and everything else. */
function splitIndexes(sql: string): { tables: string; indexes: string } {
  const statements = sql.split(';').map((statement) => statement.trim()).filter(Boolean)
  const isIndex = (statement: string) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(statement)
  return {
    tables: statements.filter((statement) => !isIndex(statement)).map((statement) => `${statement};`).join('\n'),
    indexes: statements.filter(isIndex).map((statement) => `${statement};`).join('\n'),
  }
}

/**
 * Migration 1 of a component: creates the schema, adopting a database written before versioning.
 * Tables first, then the columns an older table lacks, then the indexes (an index may cover a column
 * that only exists after the reconciliation).
 */
export function baselineMigration(schemaSql: string, openReference: () => SqliteLike & { close(): unknown }): Migration {
  return {
    version: 1,
    name: 'baseline',
    up(db) {
      const { tables, indexes } = splitIndexes(schemaSql)
      db.exec(tables)
      const reference = openReference()
      try {
        reference.exec(tables)
        reconcileColumns(db, reference)
      } finally {
        reference.close()
      }
      if (indexes) db.exec(indexes)
    },
  }
}
