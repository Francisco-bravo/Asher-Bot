// Apertura de SQLite (node:sqlite, nativo en Node 22.5+/24) y migraciones.
// Si en prod se usa Node < 22.5, cambiar a better-sqlite3 (misma API síncrona).
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths, ensureDirs } from './config.mjs'

let db = null

export function getDb() {
  if (db) return db
  ensureDirs()
  db = new DatabaseSync(paths.db)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)
  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map(r => r.name))
  const files = readdirSync(paths.migrations).filter(f => f.endsWith('.sql')).sort()
  for (const f of files) {
    if (applied.has(f)) continue
    const sql = readFileSync(join(paths.migrations, f), 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(f, Date.now())
      db.exec('COMMIT')
      console.log(`[db] migración aplicada: ${f}`)
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`Migración ${f} falló: ${err.message}`)
    }
  }
}

export const now = () => Date.now()
