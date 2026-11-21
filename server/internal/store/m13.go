package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Snapshots, pruning and backups (ROADMAP M13, ADR-0005 "snapshot"). The server never reads a payload: a snapshot is an ordinary op whose
// envelope says `cov` (the highest seq whose effect the snapshot contains). A snapshot with the same or a newer schema version than an op
// hides that op in a compact pull, and, once the op is old enough, removes it from the log for good.

// PruneAfter is how long a covered op is kept before it is physically removed.
const PruneAfter = 30 * 24 * time.Hour

// Candidate is a document with many ops since its last snapshot.
type Candidate struct {
	Doc string `json:"doc"`
	Ops int64  `json:"ops"`
}

// SnapshotCandidates lists documents with at least `min` ops that no snapshot covers (a client makes snapshots of them).
func (s *Store) SnapshotCandidates(ctx context.Context, ws string, min int64, limit int) ([]Candidate, error) {
	rows, err := s.r.QueryContext(ctx, `
SELECT o.doc, COUNT(*) FROM op o
WHERE o.ws = ? AND o.cov IS NULL AND o.seq > COALESCE((SELECT MAX(s.cov) FROM op s WHERE s.ws = o.ws AND s.doc = o.doc AND s.cov IS NOT NULL), 0)
GROUP BY o.doc HAVING COUNT(*) >= ? ORDER BY COUNT(*) DESC LIMIT ?`, ws, min, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Candidate
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.Doc, &c.Ops); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Backup writes a consistent copy of the database (VACUUM INTO) to dir and returns its path.
func (s *Store) Backup(ctx context.Context, dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, fmt.Sprintf("nevis-%s.db", s.now().UTC().Format("20060102-150405")))
	if _, err := s.w.ExecContext(ctx, `VACUUM INTO ?`, path); err != nil {
		return "", err
	}
	return path, nil
}

// Prune physically removes the ops that a snapshot covers and that are older than PruneAfter. It removes NOTHING else: not a snapshot, not an
// op above its snapshot's `cov`, not an op written under a newer schema version than the snapshot, not an op younger than PruneAfter.
// The highest removed seq per workspace is kept in `pruned_through` (a device older than that must resync). Returns how many ops went.
func (s *Store) Prune(ctx context.Context) (int64, error) {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	cutoff := s.now().Add(-PruneAfter).UnixMilli()
	covered := `FROM op o WHERE o.cov IS NULL AND o.received_at < ? AND EXISTS (SELECT 1 FROM op s WHERE s.ws = o.ws AND s.doc = o.doc AND s.cov IS NOT NULL AND s.cov >= o.seq AND s.seq <> o.seq AND s.sv >= o.sv)`
	rows, err := tx.QueryContext(ctx, `SELECT o.ws, MAX(o.seq) `+covered+` GROUP BY o.ws`, cutoff)
	if err != nil {
		return 0, err
	}
	type pr struct {
		ws  string
		max int64
	}
	var per []pr
	for rows.Next() {
		var p pr
		if err := rows.Scan(&p.ws, &p.max); err != nil {
			rows.Close()
			return 0, err
		}
		per = append(per, p)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM op WHERE rowid IN (SELECT o.rowid `+covered+`)`, cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	for _, p := range per {
		if _, err := tx.ExecContext(ctx, `UPDATE workspace SET pruned_through = MAX(pruned_through, ?) WHERE id = ?`, p.max, p.ws); err != nil {
			return 0, err
		}
	}
	return n, tx.Commit()
}

var _ = sql.ErrNoRows
