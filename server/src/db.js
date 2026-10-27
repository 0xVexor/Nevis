// SQLite (node:sqlite, no native add-on to compile) holds everything except file contents:
// accounts, devices, vaults, and the revision of every path. File contents live in the storage (S3) as blobs
// named by their SHA-256. The database can be rebuilt from nothing worse than the last backup, see backup.js.

import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass TEXT NOT NULL,
  recovery TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delete_after INTEGER
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  epoch TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  compacted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS files (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  path_ci TEXT NOT NULL,
  rev INTEGER NOT NULL,
  sha256 TEXT,
  md5 TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  by_device TEXT,
  server_time INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path)
);
CREATE UNIQUE INDEX IF NOT EXISTS files_ci ON files(vault_id, path_ci) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS files_rev ON files(vault_id, rev);
CREATE TABLE IF NOT EXISTS revisions (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT,
  md5 TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  by_device TEXT,
  server_time INTEGER NOT NULL,
  PRIMARY KEY (vault_id, rev)
);
CREATE INDEX IF NOT EXISTS revisions_path ON revisions(vault_id, path);
CREATE TABLE IF NOT EXISTS blobs (
  vault_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  md5 TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, sha256)
);
CREATE TABLE IF NOT EXISTS ops (
  vault_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, op_id)
);
CREATE TABLE IF NOT EXISTS invite_uses (code TEXT PRIMARY KEY, uses INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS pow_used (nonce TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  // Additive migrations preserve existing accounts, vaults and object hashes.
  for (const table of ['users', 'vaults', 'blobs']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'deleting')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0`)
    }
  }
  db.exec(`DROP INDEX IF EXISTS files_ci;
    CREATE UNIQUE INDEX files_ci ON files(vault_id, path_ci) WHERE deleted = 0;
    CREATE TABLE IF NOT EXISTS deletion_windows (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL, started_at INTEGER NOT NULL, initial_live INTEGER NOT NULL, deleted INTEGER NOT NULL,
      PRIMARY KEY (vault_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS upload_reservations (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL, size INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (vault_id, sha256)
    );`)
  return db
}

/**
 * Runs `fn` in one transaction. Everything here is synchronous and Node is single threaded, so no other request
 * can run in the middle: a commit is atomic and serialized without any locking of our own.
 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // the transaction is already gone
    }
    throw e
  }
}
