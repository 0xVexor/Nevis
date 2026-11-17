package vaults

import (
	"context"
	"database/sql"
	"time"
)

// Housekeeping, run every hour. Nothing here removes data a user could still want: deleted files, old revisions
// and trashed vaults are kept for the retention period (30 days), unreferenced blobs and half-finished uploads for
// a day.
const (
	day         = 24 * time.Hour
	opsKept     = 7 * day   // how long a client may still repeat a commit and get the same answer
	powKept     = time.Hour // a challenge lives 10 minutes; its nonce only has to be remembered that long
	orphanGrace = day
)

// GCStats counts what one housekeeping run removed.
type GCStats struct {
	Tombstones int `json:"tombstones"`
	Revisions  int `json:"revisions"`
	Blobs      int `json:"blobs"`
	Vaults     int `json:"vaults"`
	Users      int `json:"users"`
	Ops        int `json:"ops"`
	Staging    int `json:"staging"`
}

// Housekeeping removes what is past its time as of `now`.
func (s *Store) Housekeeping(ctx context.Context, now time.Time) (GCStats, error) {
	var st GCStats
	keep := now.Add(-time.Duration(s.Cfg.RetentionDays) * day).UnixMilli()
	steps := []func() error{
		func() error { return s.forgetOld(ctx, &st, keep, now) },
		func() (err error) { st.Blobs, err = s.dropOrphanBlobs(ctx, now.Add(-orphanGrace).UnixMilli()); return },
		func() (err error) { st.Vaults, err = s.dropTrashedVaults(ctx, keep); return },
		func() (err error) { st.Users, err = s.dropDeletedUsers(ctx, now.UnixMilli()); return },
		func() (err error) { st.Staging, err = s.Blobs.SweepStaging(now, day); return },
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return st, err
		}
	}
	return st, nil
}

// forgetOld drops tombstones, old revisions, old op answers and used proof-of-work nonces in one transaction.
func (s *Store) forgetOld(ctx context.Context, st *GCStats, keep int64, now time.Time) error {
	return s.DB.Write(ctx, func(tx *sql.Tx) error {
		// a deleted file that every device has had the retention period to hear about is forgotten; devices that
		// are further behind start over (see `compacted`)
		vaults, err := stringsOf(ctx, tx, "SELECT DISTINCT vault_id FROM files WHERE deleted = 1 AND server_time < ?", keep)
		if err != nil {
			return err
		}
		for _, id := range vaults {
			var top int64
			if err := tx.QueryRowContext(ctx, "SELECT MAX(rev) FROM files WHERE vault_id = ? AND deleted = 1 AND server_time < ?", id, keep).Scan(&top); err != nil {
				return err
			}
			gone, err := tx.ExecContext(ctx, "DELETE FROM files WHERE vault_id = ? AND deleted = 1 AND server_time < ?", id, keep)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "UPDATE vaults SET compacted = MAX(compacted, ?) WHERE id = ?", top, id); err != nil {
				return err
			}
			n, _ := gone.RowsAffected()
			st.Tombstones += int(n)
		}
		// old revisions that are not the current one
		revs, err := tx.ExecContext(ctx, `DELETE FROM revisions WHERE server_time < ? AND NOT EXISTS
			(SELECT 1 FROM files f WHERE f.vault_id = revisions.vault_id AND f.rev = revisions.rev)`, keep)
		if err != nil {
			return err
		}
		n, _ := revs.RowsAffected()
		st.Revisions = int(n)
		ops, err := tx.ExecContext(ctx, "DELETE FROM ops WHERE created_at < ?", now.Add(-opsKept).UnixMilli())
		if err != nil {
			return err
		}
		n, _ = ops.RowsAffected()
		st.Ops = int(n)
		_, err = tx.ExecContext(ctx, "DELETE FROM pow_used WHERE at < ?", now.Add(-powKept).UnixMilli())
		return err
	})
}

// dropOrphanBlobs removes blobs that no revision refers to and that were uploaded before `before` (an upload nobody
// committed, or the content of an expired revision).
func (s *Store) dropOrphanBlobs(ctx context.Context, before int64) (int, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT b.vault_id, b.sha256 FROM blobs b WHERE b.created_at < ?
		   AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.vault_id = b.vault_id AND r.sha256 = b.sha256)
		   AND NOT EXISTS (SELECT 1 FROM files f WHERE f.vault_id = b.vault_id AND f.sha256 = b.sha256)`, before)
	if err != nil {
		return 0, err
	}
	type key struct{ vault, sha string }
	var orphans []key
	for rows.Next() {
		var k key
		if err := rows.Scan(&k.vault, &k.sha); err != nil {
			rows.Close()
			return 0, err
		}
		orphans = append(orphans, k)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	for _, o := range orphans {
		if err := s.Blobs.Remove(o.vault, o.sha); err != nil {
			return 0, err
		}
		if _, err := s.DB.ExecContext(ctx, "DELETE FROM blobs WHERE vault_id = ? AND sha256 = ?", o.vault, o.sha); err != nil {
			return 0, err
		}
	}
	return len(orphans), nil
}

func (s *Store) dropTrashedVaults(ctx context.Context, before int64) (int, error) {
	ids, err := stringsOf(ctx, s.DB, "SELECT id FROM vaults WHERE deleted_at IS NOT NULL AND deleted_at < ?", before)
	for _, id := range ids {
		if err != nil {
			break
		}
		err = s.dropVault(ctx, id)
	}
	return len(ids), err
}

func (s *Store) dropDeletedUsers(ctx context.Context, now int64) (int, error) {
	users, err := stringsOf(ctx, s.DB, "SELECT id FROM users WHERE delete_after IS NOT NULL AND delete_after < ?", now)
	for _, id := range users {
		if err != nil {
			break
		}
		var vaults []string
		if vaults, err = stringsOf(ctx, s.DB, "SELECT id FROM vaults WHERE user_id = ?", id); err != nil {
			break
		}
		for _, v := range vaults {
			if err = s.Blobs.RemoveVault(v); err != nil {
				break
			}
			if _, err = s.DB.ExecContext(ctx, "DELETE FROM blobs WHERE vault_id = ?", v); err != nil {
				break
			}
		}
		if err == nil { // vaults, devices, files and revisions go with the user (foreign keys)
			_, err = s.DB.ExecContext(ctx, "DELETE FROM users WHERE id = ?", id)
		}
	}
	return len(users), err
}

func (s *Store) dropVault(ctx context.Context, id string) error {
	if err := s.Blobs.RemoveVault(id); err != nil {
		return err
	}
	if _, err := s.DB.ExecContext(ctx, "DELETE FROM blobs WHERE vault_id = ?", id); err != nil {
		return err
	}
	_, err := s.DB.ExecContext(ctx, "DELETE FROM vaults WHERE id = ?", id)
	return err
}

func stringsOf(ctx context.Context, q querier, query string, args ...any) ([]string, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
