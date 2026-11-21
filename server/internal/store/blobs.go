package store

import (
	"context"
	"database/sql"
	"errors"
)

// BlobGrace is how long a blob stays after it was last seen unreferenced (ROADMAP M9).
const BlobGraceMs = int64(30 * 24 * 3600 * 1000)

// The `blob` table is the server's memory of which files exist and whose quota they cost. A file on disk without a row here does not
// exist for the API (a crash between the two leaves harmless orphan bytes).
//
// grace_from is the garbage-collection clock. NULL = the last accepted reference report listed this blob (it is referenced). A time =
// the blob is on probation since then: a fresh upload starts it, and so does every HEAD and every re-upload (a device that is about to
// push an op that points at it), and a report that no longer lists it. Only a blob on probation for longer than BlobGraceMs is removed.

// BlobSize is the size of a stored blob, ok=false when there is none.
func (s *Store) BlobSize(ctx context.Context, ws, hash string) (size int64, ok bool, err error) {
	err = s.r.QueryRowContext(ctx, `SELECT size FROM blob WHERE ws = ? AND hash = ?`, ws, hash).Scan(&size)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return size, err == nil, err
}

// TouchBlob restarts the probation of a blob that is on probation (a referenced one is left alone).
func (s *Store) TouchBlob(ctx context.Context, ws, hash string) error {
	_, err := s.w.ExecContext(ctx, `UPDATE blob SET grace_from = ? WHERE ws = ? AND hash = ? AND grace_from IS NOT NULL`, s.ms(), ws, hash)
	return err
}

// AddBlob records a finished upload and charges the uploader's quota. A blob the workspace already has costs nothing (and restarts
// its probation). ErrQuota when the account's storage would pass quotaBytes (0 = unlimited).
func (s *Store) AddBlob(ctx context.Context, ws, hash string, size int64, account string, quotaBytes int64) (created bool, err error) {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var have int64
	switch err := tx.QueryRowContext(ctx, `SELECT size FROM blob WHERE ws = ? AND hash = ?`, ws, hash).Scan(&have); {
	case err == nil:
		if _, err := tx.ExecContext(ctx, `UPDATE blob SET grace_from = ? WHERE ws = ? AND hash = ? AND grace_from IS NOT NULL`, s.ms(), ws, hash); err != nil {
			return false, err
		}
		return false, tx.Commit()
	case !errors.Is(err, sql.ErrNoRows):
		return false, err
	}
	if account != "" {
		var used int64
		if err := tx.QueryRowContext(ctx, `SELECT used_bytes FROM account WHERE id = ?`, account).Scan(&used); err != nil {
			return false, err
		}
		if quotaBytes > 0 && used+size > quotaBytes {
			return false, ErrQuota
		}
		if _, err := tx.ExecContext(ctx, `UPDATE account SET used_bytes = used_bytes + ? WHERE id = ?`, size, account); err != nil {
			return false, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO blob (ws, hash, size, account, created_at, grace_from) VALUES (?,?,?,?,?,?)`, ws, hash, size, account, s.ms(), s.ms()); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// QuotaRoom tells whether `size` more bytes fit in the account's quota (so a hopeless upload is refused before it starts).
func (s *Store) QuotaRoom(ctx context.Context, account string, size, quotaBytes int64) (bool, error) {
	if account == "" || quotaBytes <= 0 {
		return true, nil
	}
	var used int64
	if err := s.r.QueryRowContext(ctx, `SELECT used_bytes FROM account WHERE id = ?`, account).Scan(&used); err != nil {
		return false, err
	}
	return used+size <= quotaBytes, nil
}

// ReportRefs applies a client's list of the blob hashes its workspace still points at, read when the client had pulled up to `cursor`.
//   - A listed blob is referenced (grace cleared). This is always safe.
//   - A blob NOT listed starts its probation only if the report was complete: cursor >= the workspace head. A device that has not
//     pulled everything cannot know what the ops it has not seen refer to, so its omissions mean nothing; `applied` says which case it was.
func (s *Store) ReportRefs(ctx context.Context, ws string, cursor int64, refs []string) (applied bool, err error) {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var head int64
	if err := tx.QueryRowContext(ctx, `SELECT head FROM workspace WHERE id = ?`, ws).Scan(&head); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, ErrNoWorkspace
		}
		return false, err
	}
	listed := make(map[string]bool, len(refs))
	for _, h := range refs {
		listed[h] = true
	}
	rows, err := tx.QueryContext(ctx, `SELECT hash, grace_from IS NULL FROM blob WHERE ws = ?`, ws)
	if err != nil {
		return false, err
	}
	type row struct {
		hash       string
		referenced bool
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.hash, &r.referenced); err != nil {
			rows.Close()
			return false, err
		}
		all = append(all, r)
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	applied = cursor >= head
	for _, r := range all {
		switch {
		case listed[r.hash]:
			if !r.referenced {
				if _, err := tx.ExecContext(ctx, `UPDATE blob SET grace_from = NULL WHERE ws = ? AND hash = ?`, ws, r.hash); err != nil {
					return false, err
				}
			}
		case applied && r.referenced:
			if _, err := tx.ExecContext(ctx, `UPDATE blob SET grace_from = ? WHERE ws = ? AND hash = ?`, s.ms(), ws, r.hash); err != nil {
				return false, err
			}
		}
	}
	return applied, tx.Commit()
}

// RemovedBlob is one blob the collection took out of the database; its file is removed by the caller.
type RemovedBlob struct {
	WS, Hash string
	Size     int64
}

// CollectBlobs removes the rows of blobs that have been on probation for longer than BlobGraceMs and gives their bytes back to the
// uploader's quota, all in one transaction. A referenced blob (grace_from NULL) is never selected.
func (s *Store) CollectBlobs(ctx context.Context) ([]RemovedBlob, error) {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT ws, hash, size, account FROM blob WHERE grace_from IS NOT NULL AND grace_from < ?`, s.ms()-BlobGraceMs)
	if err != nil {
		return nil, err
	}
	var out []RemovedBlob
	var accounts []string
	for rows.Next() {
		var b RemovedBlob
		var acc string
		if err := rows.Scan(&b.WS, &b.Hash, &b.Size, &acc); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, b)
		accounts = append(accounts, acc)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for i, b := range out {
		if _, err := tx.ExecContext(ctx, `DELETE FROM blob WHERE ws = ? AND hash = ? AND grace_from IS NOT NULL`, b.WS, b.Hash); err != nil {
			return nil, err
		}
		if accounts[i] != "" {
			if _, err := tx.ExecContext(ctx, `UPDATE account SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?`, b.Size, accounts[i]); err != nil {
				return nil, err
			}
		}
	}
	return out, tx.Commit()
}
