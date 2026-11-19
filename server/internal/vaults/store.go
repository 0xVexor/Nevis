// Package vaults is the heart of the server: vaults, revisions and the conditional commit.
//
// Every path of a vault has a `rev`: the vault's `seq` at the moment the path last changed. `seq` only grows, so
// "everything since rev N" is simply `files WHERE rev > N`, and the order of events is the order of `seq`, never a
// device clock. A write says which rev it was based on (`base_rev`); if the path moved on in the meantime it is
// refused with the current state instead of overwriting it (compare-and-swap). A delete is a tombstone with a rev
// of its own, so that other devices learn about it; absence is never a delete.
package vaults

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/0xVexor/Nevis/server/internal/apierr"
	"github.com/0xVexor/Nevis/server/internal/auth"
	"github.com/0xVexor/Nevis/server/internal/config"
	"github.com/0xVexor/Nevis/server/internal/db"
	"github.com/0xVexor/Nevis/server/internal/storage"
)

var vaultID = regexp.MustCompile(`^[0-9a-zA-Z-]{8,64}$`)

// Store is the vault logic on top of the database and the blob store.
type Store struct {
	DB    *db.DB
	Blobs *storage.Blobs
	Cfg   config.Config
	Now   func() time.Time

	rootMu sync.Mutex
	roots  map[string]cachedRoot

	pendingMu sync.Mutex
	pending   map[string]map[string]pendingUpload // by user, then vault+blob: uploads not complete yet
}

// querier is what both the database and a transaction can do.
type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func (s *Store) ms() int64 { return s.Now().UnixMilli() }

// Vault is a row of the vaults table.
type Vault struct {
	ID, UserID, Name, Epoch string
	Seq, Compacted          int64
	DeletedAt               sql.NullInt64
}

func vaultRow(ctx context.Context, q querier, id string) (*Vault, error) {
	var v Vault
	err := q.QueryRowContext(ctx, "SELECT id, user_id, name, epoch, seq, compacted, deleted_at FROM vaults WHERE id = ?", id).
		Scan(&v.ID, &v.UserID, &v.Name, &v.Epoch, &v.Seq, &v.Compacted, &v.DeletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &v, err
}

// Owned returns the vault of this user, or a 404 (also for somebody else's vault: its existence is not revealed).
// A trashed vault is only found when includeTrashed is set.
func (s *Store) Owned(ctx context.Context, userID, id string, includeTrashed bool) (*Vault, error) {
	v, err := vaultRow(ctx, s.DB, id)
	if err != nil {
		return nil, err
	}
	if v == nil || v.UserID != userID || (v.DeletedAt.Valid && !includeTrashed) {
		return nil, apierr.New(404, "no_such_vault")
	}
	return v, nil
}

// Reload reads the vault again (its seq may have moved); nil when it is gone or trashed.
func (s *Store) Reload(ctx context.Context, id string) (*Vault, error) {
	v, err := vaultRow(ctx, s.DB, id)
	if err != nil || v == nil || v.DeletedAt.Valid {
		return nil, err
	}
	return v, nil
}

// Info is a vault as the list shows it.
type Info struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Seq       int64  `json:"seq"`
	CreatedAt int64  `json:"created_at"`
	DeletedAt *int64 `json:"deleted_at"`
	Files     int64  `json:"files"`
	Bytes     int64  `json:"bytes"`
}

// List returns the live vaults of a user, or the trashed ones.
func (s *Store) List(ctx context.Context, userID string, trashed bool) ([]Info, error) {
	cond := "v.deleted_at IS NULL"
	if trashed {
		cond = "v.deleted_at IS NOT NULL"
	}
	rows, err := s.DB.QueryContext(ctx,
		`SELECT v.id, v.name, v.seq, v.created_at, v.deleted_at,
		        (SELECT COUNT(*) FROM files f WHERE f.vault_id = v.id AND f.deleted = 0),
		        (SELECT COALESCE(SUM(size), 0) FROM blobs b WHERE b.vault_id = v.id)
		   FROM vaults v WHERE v.user_id = ? AND `+cond+` ORDER BY v.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Info{}
	for rows.Next() {
		var i Info
		var deleted sql.NullInt64
		if err := rows.Scan(&i.ID, &i.Name, &i.Seq, &i.CreatedAt, &deleted, &i.Files, &i.Bytes); err != nil {
			return nil, err
		}
		if deleted.Valid {
			i.DeletedAt = &deleted.Int64
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// CountLive is the number of vaults a user has that are not in the trash.
func (s *Store) CountLive(ctx context.Context, userID string) (int, error) {
	return countLive(ctx, s.DB, userID)
}

func countLive(ctx context.Context, q querier, userID string) (n int, err error) {
	err = q.QueryRowContext(ctx, "SELECT COUNT(*) FROM vaults WHERE user_id = ? AND deleted_at IS NULL", userID).Scan(&n)
	return
}

func cleanName(name string) (string, error) {
	n := strings.TrimSpace(name)
	if r := []rune(n); len(r) > 120 {
		n = string(r[:120])
	}
	if n == "" || !utf8.ValidString(n) {
		return "", apierr.New(400, "bad_name")
	}
	return n, nil
}

// Created is the answer to creating a vault.
type Created struct {
	Created bool   `json:"created"`
	ID      string `json:"id"`
	Name    string `json:"name"`
	Epoch   string `json:"epoch"`
}

// Create makes the vault, or confirms that it is already this user's (so a retried request is harmless).
func (s *Store) Create(ctx context.Context, userID, id, name string) (Created, error) {
	if id == "" {
		id = auth.NewID()
	}
	if !vaultID.MatchString(id) {
		return Created{}, apierr.New(400, "bad_id")
	}
	var out Created
	err := s.DB.Write(ctx, func(tx *sql.Tx) error {
		have, err := vaultRow(ctx, tx, id)
		if err != nil {
			return err
		}
		if have != nil {
			if have.UserID != userID {
				return apierr.New(409, "vault_taken")
			}
			if have.DeletedAt.Valid {
				return apierr.New(409, "vault_deleted")
			}
			out = Created{ID: have.ID, Name: have.Name, Epoch: have.Epoch}
			return nil
		}
		n, err := countLive(ctx, tx, userID)
		if err != nil {
			return err
		}
		if n >= s.Cfg.MaxVaults {
			return apierr.With(403, "too_many_vaults", map[string]any{"limit": s.Cfg.MaxVaults})
		}
		clean, err := cleanName(name)
		if err != nil {
			return err
		}
		out = Created{Created: true, ID: id, Name: clean, Epoch: db.NewEpoch()}
		_, err = tx.ExecContext(ctx, "INSERT INTO vaults (id, user_id, name, epoch, seq, compacted, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
			id, userID, clean, out.Epoch, s.ms())
		return err
	})
	return out, err
}

// Rename changes the name of a vault.
func (s *Store) Rename(ctx context.Context, v *Vault, name string) error {
	clean, err := cleanName(name)
	if err != nil {
		return err
	}
	_, err = s.DB.ExecContext(ctx, "UPDATE vaults SET name = ? WHERE id = ?", clean, v.ID)
	return err
}

// Trash hides a vault; housekeeping removes it after the retention period.
func (s *Store) Trash(ctx context.Context, v *Vault) error {
	_, err := s.DB.ExecContext(ctx, "UPDATE vaults SET deleted_at = ? WHERE id = ?", s.ms(), v.ID)
	return err
}

// Untrash brings a trashed vault back.
func (s *Store) Untrash(ctx context.Context, v *Vault) error {
	_, err := s.DB.ExecContext(ctx, "UPDATE vaults SET deleted_at = NULL WHERE id = ?", v.ID)
	return err
}

// Purged is what a permanent deletion removed.
type Purged struct {
	Files int64 `json:"files"`
	Bytes int64 `json:"bytes"`
}

// Purge removes a vault of this user that is already in the trash, for good. A live vault is refused (409), an
// unknown or somebody else's vault is a 404. The check and the deletion of the rows are one transaction under the
// writer lock, so a vault restored in between is not removed; the blob files go after the rows (see dropVault).
func (s *Store) Purge(ctx context.Context, userID, id string) (Purged, error) {
	var out Purged
	err := s.DB.Write(ctx, func(tx *sql.Tx) error {
		v, err := vaultRow(ctx, tx, id)
		if err != nil {
			return err
		}
		if v == nil || v.UserID != userID {
			return apierr.New(404, "no_such_vault")
		}
		if !v.DeletedAt.Valid {
			return apierr.New(409, "not_in_trash")
		}
		if err := tx.QueryRowContext(ctx,
			`SELECT (SELECT COUNT(*) FROM files WHERE vault_id = ? AND deleted = 0),
			        (SELECT COALESCE(SUM(size), 0) FROM blobs WHERE vault_id = ?)`, id, id).Scan(&out.Files, &out.Bytes); err != nil {
			return err
		}
		return dropVaultRows(ctx, tx, id)
	})
	if err != nil {
		return Purged{}, err
	}
	s.releaseVault(userID, id)
	return out, s.Blobs.RemoveVault(id)
}
