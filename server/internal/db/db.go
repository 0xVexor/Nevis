// Package db opens the SQLite file that holds everything except the contents of files: accounts, devices,
// vaults and the revision of every path. File contents live on disk as blobs named by their SHA-256 (package
// storage). The database can be rebuilt from the last backup, see backup.go.
package db

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"sync"

	_ "modernc.org/sqlite" // pure Go driver: no cgo, so the server cross-compiles from any machine
)

const schema = `
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
CREATE UNIQUE INDEX IF NOT EXISTS files_ci ON files(vault_id, path_ci);
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
`

// DB is the database plus the rule that only one transaction writes at a time.
type DB struct {
	*sql.DB
	writer sync.Mutex
}

// Open opens (and creates) the database file. The pragmas are part of the connection string because the pool opens
// new connections at will: a pragma run once would only reach one of them (foreign keys, for instance, decide
// whether deleting a vault removes its files).
func Open(path string) (*DB, error) {
	q := url.Values{}
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "busy_timeout(5000)")
	q.Set("_txlock", "immediate") // a writer takes the write lock at BEGIN, so it never fails half way through
	conn, err := sql.Open("sqlite", path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	if _, err := conn.Exec(schema); err != nil {
		conn.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	return &DB{DB: conn}, nil
}

// Write runs fn in one transaction while holding the writer lock. A commit is therefore atomic and serialized
// with every other write; reads never wait for it (WAL).
func (d *DB) Write(ctx context.Context, fn func(tx *sql.Tx) error) error {
	d.writer.Lock()
	defer d.writer.Unlock()
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}
