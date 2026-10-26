// SQLite storage with numbered migrations. One writer process (single-instance reference deployment); WAL mode for readers.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MIGRATIONS: string[] = [
  // 1: tokens, publications, versions, submissions
  `CREATE TABLE tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
   CREATE TABLE publications (
     id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revoked_at INTEGER);
   CREATE TABLE publication_versions (
     publication_id TEXT NOT NULL, version INTEGER NOT NULL, form_json TEXT NOT NULL, form_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
     PRIMARY KEY (publication_id, version));
   CREATE TABLE submissions (
     id TEXT PRIMARY KEY, publication_id TEXT NOT NULL, version INTEGER NOT NULL, submission_id TEXT NOT NULL, content_hash TEXT NOT NULL,
     answers_json TEXT NOT NULL, receipt TEXT NOT NULL UNIQUE, ack_token TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT,
     created_at INTEGER NOT NULL, leased_until INTEGER NOT NULL DEFAULT 0, applied_at INTEGER, seq INTEGER NOT NULL,
     UNIQUE (publication_id, submission_id));
   CREATE INDEX submissions_pending ON submissions (publication_id, status, seq);`,
  // 2: jobs, runs, leases, outbox
  `CREATE TABLE jobs (
     id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, definition_json TEXT NOT NULL, time_zone TEXT NOT NULL, status TEXT NOT NULL,
     context_published_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE job_runs (
     job_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER,
     error TEXT, started_at INTEGER, finished_at INTEGER, PRIMARY KEY (job_id, occurrence_id));
   CREATE TABLE leases (domain TEXT NOT NULL, key TEXT NOT NULL, holder TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (domain, key));
   CREATE TABLE outbox (
     idempotency_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     retry_at INTEGER, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  // 3: audit trail that survives revocation (retention is the owner's call)
  `CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT, detail TEXT);`,
]

export type Db = DatabaseSync

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const done = new Set((db.prepare('SELECT version FROM migrations').all() as { version: number }[]).map((r) => r.version))
  MIGRATIONS.forEach((sql, i) => {
    const v = i + 1
    if (done.has(v)) return
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(v, Date.now())
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  })
  return db
}

export function tx<T>(db: Db, f: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = f()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export const audit = (db: Db, actor: string, action: string, subject: string | null, detail?: unknown) =>
  void db.prepare('INSERT INTO audit (at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?)').run(Date.now(), actor, action, subject, detail === undefined ? null : JSON.stringify(detail))
