// Package store is the server's log: an append-only list of opaque envelopes per workspace with a server-assigned `seq`.
// All writes go through ONE connection and one transaction per push, so the order in which transactions commit is the order of
// `seq`, and a reader can never see a higher `seq` while a lower one is still to come (ADR-0005, ADR-0006). The package never
// looks inside an op's payload.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/nevis-app/nevis/server/internal/envelope"
	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, head INTEGER NOT NULL DEFAULT 0,
  min_sv INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS op (ws TEXT NOT NULL, seq INTEGER NOT NULL, op_id TEXT NOT NULL, doc TEXT NOT NULL, dev TEXT NOT NULL,
  by_account TEXT NOT NULL, sv INTEGER NOT NULL, kid INTEGER NOT NULL, size INTEGER NOT NULL,
  env_sha256 BLOB NOT NULL, env TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (ws, seq), UNIQUE (ws, op_id));
CREATE INDEX IF NOT EXISTS op_doc ON op (ws, doc, seq);
CREATE TABLE IF NOT EXISTS purged (ws TEXT NOT NULL, doc TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (ws, doc));
CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
  recovery_hash TEXT NOT NULL, created_at INTEGER NOT NULL, used_bytes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS member (ws TEXT NOT NULL, account TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
  PRIMARY KEY (ws, account));
CREATE INDEX IF NOT EXISTS member_account ON member (account);
CREATE TABLE IF NOT EXISTS device (id TEXT PRIMARY KEY, account TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS device_account ON device (account);
CREATE TABLE IF NOT EXISTS session (token_hash TEXT PRIMARY KEY, account TEXT NOT NULL, device TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS session_device ON session (device);
CREATE TABLE IF NOT EXISTS pow_used (nonce TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blob (ws TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, account TEXT NOT NULL,
  created_at INTEGER NOT NULL, grace_from INTEGER, PRIMARY KEY (ws, hash)) WITHOUT ROWID;
`

// Errors the API turns into HTTP answers.
var (
	ErrOpConflict  = errors.New("op_conflict")
	ErrClockAhead  = errors.New("clock_ahead")
	ErrNoWorkspace = errors.New("no_such_workspace")
	ErrQuota       = errors.New("quota_exceeded")
	ErrSvTooOld    = errors.New("sv_too_old")
)

const MaxSkew = 10 * time.Minute

// SvError is a push from a writer whose schema version is below the workspace's `min_sv`.
type SvError struct{ MinSV int }

func (e *SvError) Error() string   { return ErrSvTooOld.Error() }
func (e *SvError) Is(t error) bool { return t == ErrSvTooOld }

type Store struct {
	w   *sql.DB // the one writer
	r   *sql.DB // readers
	now func() time.Time
	waiters
}

// Open opens (creating it if needed) the database in dir.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "nevis.db")
	dsn := func(extra ...string) string {
		q := url.Values{}
		q.Add("_pragma", "journal_mode(WAL)")
		q.Add("_pragma", "synchronous(NORMAL)")
		q.Add("_pragma", "busy_timeout(5000)")
		for _, e := range extra {
			q.Add("_pragma", e)
		}
		return "file:" + path + "?" + q.Encode()
	}
	w, err := sql.Open("sqlite", dsn()+"&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	if _, err := w.Exec(schema); err != nil {
		w.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	r, err := sql.Open("sqlite", dsn("query_only(1)"))
	if err != nil {
		w.Close()
		return nil, err
	}
	r.SetMaxOpenConns(8)
	return &Store{w: w, r: r, now: time.Now, waiters: waiters{m: map[string]map[chan struct{}]struct{}{}}}, nil
}

// SetClock replaces the clock (tests move it to prove the 30-day rules).
func (s *Store) SetClock(now func() time.Time) { s.now = now }

func (s *Store) Close() error { return errors.Join(s.w.Close(), s.r.Close()) }

// Status of one pushed op.
type Result struct {
	Op     string `json:"op"`
	Seq    int64  `json:"seq"`
	Status string `json:"status"`
}

// Push stores a batch atomically. `by` is the authenticated account. `create` lets an unknown workspace be created (dev mode).
// The whole batch is refused (nothing stored) on a clock too far ahead or on an op id that is already there with other bytes.
type PushOptions struct {
	// Create lets an unknown workspace be created by its first push (dev mode only).
	Create bool
	// AccountID and QuotaBytes: the pusher's account and its storage limit (0 = unlimited). The bytes of new ops are counted.
	AccountID  string
	QuotaBytes int64
}

func (s *Store) Push(ctx context.Context, ws, by string, envs []*envelope.Envelope, o PushOptions) ([]Result, int64, error) {
	create := o.Create
	limit := s.now().Add(MaxSkew).UnixMilli()
	for _, e := range envs {
		if e.HLCMs > limit {
			return nil, 0, ErrClockAhead
		}
	}
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()
	var head int64
	var minSV int
	err = tx.QueryRowContext(ctx, `SELECT head, min_sv FROM workspace WHERE id = ?`, ws).Scan(&head, &minSV)
	if errors.Is(err, sql.ErrNoRows) {
		if !create {
			return nil, 0, ErrNoWorkspace
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO workspace (id, name, head, created_at) VALUES (?, ?, 0, ?)`, ws, ws, s.now().UnixMilli()); err != nil {
			return nil, 0, err
		}
		head, minSV = 0, 1
	} else if err != nil {
		return nil, 0, err
	}
	for _, e := range envs {
		if e.SV < minSV {
			return nil, 0, &SvError{MinSV: minSV}
		}
	}
	out := make([]Result, 0, len(envs))
	var added int64
	for _, e := range envs {
		var seq int64
		var sum []byte
		err := tx.QueryRowContext(ctx, `SELECT seq, env_sha256 FROM op WHERE ws = ? AND op_id = ?`, ws, e.Op).Scan(&seq, &sum)
		switch {
		case err == nil:
			if string(sum) != string(e.SHA256[:]) {
				return nil, 0, ErrOpConflict // the same op id with other bytes: a bug in the client, never accepted silently
			}
			out = append(out, Result{Op: e.Op, Seq: seq, Status: "dup"})
			continue
		case !errors.Is(err, sql.ErrNoRows):
			return nil, 0, err
		}
		var gone int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM purged WHERE ws = ? AND doc = ?`, ws, e.Doc).Scan(&gone); err == nil {
			out = append(out, Result{Op: e.Op, Seq: 0, Status: "purged"})
			continue
		}
		head++
		if _, err := tx.ExecContext(ctx, `INSERT INTO op (ws, seq, op_id, doc, dev, by_account, sv, kid, size, env_sha256, env, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			ws, head, e.Op, e.Doc, e.Dev, by, e.SV, e.KID, len(e.P), e.SHA256[:], string(e.Raw), s.now().UnixMilli()); err != nil {
			return nil, 0, err
		}
		added += int64(len(e.P))
		out = append(out, Result{Op: e.Op, Seq: head, Status: "ok"})
	}
	if o.AccountID != "" && added > 0 {
		var used int64
		if err := tx.QueryRowContext(ctx, `SELECT used_bytes FROM account WHERE id = ?`, o.AccountID).Scan(&used); err != nil {
			return nil, 0, err
		}
		if o.QuotaBytes > 0 && used+added > o.QuotaBytes {
			return nil, 0, ErrQuota
		}
		if _, err := tx.ExecContext(ctx, `UPDATE account SET used_bytes = used_bytes + ? WHERE id = ?`, added, o.AccountID); err != nil {
			return nil, 0, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workspace SET head = ? WHERE id = ?`, head, ws); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(); err != nil {
		return nil, 0, err
	}
	if head > 0 && len(out) > 0 {
		s.notify(ws)
	}
	return out, head, nil
}

// PulledOp is one row of a pull.
type PulledOp struct {
	Seq int64
	By  string
	RT  int64
	Env string
}

// Pull returns the ops after `after`, at most `limit`, and the head, both read from ONE snapshot: `more` is exact and a
// reader never sees a gap that a later commit fills. An unknown workspace is empty when `create` is set (dev mode).
func (s *Store) Pull(ctx context.Context, ws string, after int64, limit int, create bool) ([]PulledOp, int64, bool, error) {
	tx, err := s.r.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, 0, false, err
	}
	defer tx.Rollback()
	var head int64
	if err := tx.QueryRowContext(ctx, `SELECT head FROM workspace WHERE id = ?`, ws).Scan(&head); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			if create {
				return nil, 0, false, nil
			}
			return nil, 0, false, ErrNoWorkspace
		}
		return nil, 0, false, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT seq, by_account, received_at, env FROM op WHERE ws = ? AND seq > ? ORDER BY seq LIMIT ?`, ws, after, limit)
	if err != nil {
		return nil, 0, false, err
	}
	defer rows.Close()
	var ops []PulledOp
	for rows.Next() {
		var o PulledOp
		if err := rows.Scan(&o.Seq, &o.By, &o.RT, &o.Env); err != nil {
			return nil, 0, false, err
		}
		ops = append(ops, o)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, false, err
	}
	more := len(ops) > 0 && ops[len(ops)-1].Seq < head
	return ops, head, more, nil
}
