import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, initDb } from '../index.js'
import { applyMigrations, SchemaTooNewError, type Migration } from '../migrations.js'
import { runtimeMigrations } from '../runtime-schema.js'
import { SessionService } from '../../phase2/services/session-service.js'

// A-03 (docs/analise-20261109.md): the runtime is copied into each target repository and its schema
// was only CREATE TABLE IF NOT EXISTS, so a database from an older install never got new columns.

const dirs: string[] = []
function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentic-migrations-'))
  dirs.push(dir)
  return path.join(dir, 'persona-qa.db')
}

function columns(file: string, table: string): string[] {
  const db = new Database(file)
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
  } finally {
    db.close()
  }
}

function recordedVersions(file: string): Array<{ component: string; version: number }> {
  const db = new Database(file)
  try {
    return db.prepare('SELECT component, version FROM schema_migrations ORDER BY component, version').all() as Array<{ component: string; version: number }>
  } finally {
    db.close()
  }
}

afterEach(() => {
  closeDb()
  delete process.env['DATABASE_URL']
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('applyMigrations', () => {
  const createThing: Migration = { version: 1, name: 'thing', up: (db) => { db.exec('CREATE TABLE thing (id INTEGER)') } }
  const addColumn: Migration = { version: 2, name: 'thing.label', up: (db) => { db.exec('ALTER TABLE thing ADD COLUMN label TEXT') } }

  it('applies pending migrations once and records them per component', () => {
    const db = new Database(':memory:')
    expect(applyMigrations(db, 'demo', [createThing, addColumn])).toEqual({ from: 0, to: 2, applied: [1, 2] })
    expect(applyMigrations(db, 'demo', [createThing, addColumn])).toEqual({ from: 2, to: 2, applied: [] })
    expect(applyMigrations(db, 'other', [])).toEqual({ from: 0, to: 0, applied: [] })
    db.close()
  })

  it('refuses a database written by a newer runtime', () => {
    const db = new Database(':memory:')
    applyMigrations(db, 'demo', [createThing, addColumn])
    expect(() => applyMigrations(db, 'demo', [createThing])).toThrow(SchemaTooNewError)
    db.close()
  })

  it('rolls a failing migration back, leaving the version where it was', () => {
    const db = new Database(':memory:')
    applyMigrations(db, 'demo', [createThing])
    const broken: Migration = {
      version: 2,
      name: 'broken',
      up: (inner) => {
        inner.exec('CREATE TABLE half_done (id INTEGER)')
        inner.exec('ALTER TABLE missing_table ADD COLUMN x TEXT')
      },
    }
    expect(() => applyMigrations(db, 'demo', [createThing, broken])).toThrow(/demo migration 2 \(broken\) failed/)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined()
    expect(applyMigrations(db, 'demo', [createThing])).toEqual({ from: 1, to: 1, applied: [] })
    db.close()
  })
})

describe('databases written before versioning', () => {
  it('SessionService adds the columns an older p2_sessions table lacks, keeping its rows', () => {
    const file = tempDbPath()
    const old = new Database(file)
    old.exec(`
      CREATE TABLE p2_sessions (
        session_id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      INSERT INTO p2_sessions (session_id, scenario_id, status, created_at)
        VALUES ('old-session', 'checkout', 'complete', '2026-01-01T00:00:00.000Z');
    `)
    old.close()

    const service = new SessionService(file)
    const created = service.createSession('checkout', 7)

    expect(columns(file, 'p2_sessions')).toEqual(expect.arrayContaining(['run_id', 'started_at', 'completed_at']))
    expect(service.getSession('old-session')?.status).toBe('complete')
    expect(service.getSession(created.id)?.scenarioId).toBe('checkout')
    expect(recordedVersions(file)).toContainEqual({ component: 'phase2-sessions', version: 1 })
  })

  it('SessionService adopts an older table that lacks a column one of its indexes covers', () => {
    const file = tempDbPath()
    const old = new Database(file)
    // No step_id / agent_id yet: idx_p2_l5_learning_signals_scope covers both, so the index can only
    // be created after the columns are added.
    old.exec(`
      CREATE TABLE p2_l5_learning_signals (
        signal_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        source_run_id TEXT,
        subject_type TEXT,
        subject_id TEXT,
        scenario_id TEXT,
        version TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
    `)
    old.close()

    new SessionService(file)

    expect(columns(file, 'p2_l5_learning_signals')).toEqual(expect.arrayContaining(['step_id', 'agent_id']))
    const db = new Database(file)
    const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_p2_l5_learning_signals_scope'").get()
    db.close()
    expect(index).toBeDefined()
  })

  it('a database that stopped at migration 1 gets migration 2: findings keep expected and actual', () => {
    const file = tempDbPath()
    const db = new Database(file)
    applyMigrations(db, 'phase2-sessions', runtimeMigrations(() => new Database(':memory:'))['phase2-sessions'].slice(0, 1))
    db.close()
    expect(columns(file, 'p2_session_findings')).not.toContain('expected')

    const service = new SessionService(file)
    const session = service.createSession('checkout')
    service.storeFinding(session.id, { type: 'agent_finding', severity: 'high', title: 'Total ignores the discount', expected: 'Total reduced', actual: 'Total unchanged' })

    expect(columns(file, 'p2_session_findings')).toEqual(expect.arrayContaining(['expected', 'actual']))
    expect(service.getSession(session.id)?.findings[0]).toEqual(expect.objectContaining({ expected: 'Total reduced', actual: 'Total unchanged' }))
    expect(recordedVersions(file)).toContainEqual({ component: 'phase2-sessions', version: 2 })
  })

  it('SessionService refuses a database from a newer runtime', () => {
    const file = tempDbPath()
    new SessionService(file)
    const db = new Database(file)
    db.prepare("INSERT INTO schema_migrations (component, version, name, applied_at) VALUES ('phase2-sessions', 99, 'future', 'now')").run()
    db.close()

    expect(() => new SessionService(file)).toThrow(SchemaTooNewError)
  })

  it('initDb adds the columns an older runs table lacks', () => {
    const file = tempDbPath()
    const old = new Database(file)
    old.exec(`
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_id TEXT NOT NULL,
        scenario_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT NOT NULL
      );
    `)
    old.close()

    process.env['DATABASE_URL'] = file
    initDb()

    expect(columns(file, 'runs')).toEqual(expect.arrayContaining(['high_count', 'critical_count', 'error_message', 'started_by']))
    expect(recordedVersions(file)).toContainEqual({ component: 'dashboard', version: 1 })
  })

  it('both components share one file without sharing a version', () => {
    const file = tempDbPath()
    process.env['DATABASE_URL'] = file
    initDb()
    new SessionService(file)

    expect(recordedVersions(file)).toEqual([
      { component: 'dashboard', version: 1 },
      { component: 'phase2-sessions', version: 1 },
      { component: 'phase2-sessions', version: 2 },
    ])
  })
})
