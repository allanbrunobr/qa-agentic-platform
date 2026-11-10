import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { applyMigrations } from './migrations.js';
import { runtimeMigrations } from './runtime-schema.js';

// Resolved on every initDb() call, not at import time: tests set DATABASE_URL
// after imports are hoisted and must never touch the on-disk database.
function resolveDbPath(): string {
  return process.env['DATABASE_URL'] ?? './persona-qa.db';
}

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database.Database | null = null;

export function getDb() {
  if (!_db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return _db;
}

export function initDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (_db) return _db;

  const dbPath = resolveDbPath();
  _sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');

  _db = drizzle(_sqlite, { schema });

  // Versioned migrations (A-03). The baseline creates the tables with raw SQL (no drizzle-kit push at
  // runtime) and adds the columns a table from an older install lacks.
  applyMigrations(_sqlite, 'dashboard', runtimeMigrations(() => new Database(':memory:')).dashboard);

  console.log(`[db] Initialized SQLite database at ${dbPath}`);
  return _db;
}

export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

export { schema };
