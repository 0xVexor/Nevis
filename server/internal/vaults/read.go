package vaults

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"

	"github.com/0xVexor/Nevis/server/internal/apierr"
)

// Meta is what the server knows about one revision of a path.
type Meta struct {
	Rev        int64  `json:"rev"`
	SHA256     string `json:"sha256"`
	MD5        string `json:"md5"`
	Size       int64  `json:"size"`
	Deleted    bool   `json:"deleted"`
	ServerTime int64  `json:"server_time"`
}

// File is a path with its Meta.
type File struct {
	Path     string `json:"path"`
	ByDevice string `json:"by_device"`
	Meta
}

// Columns of the files and revisions tables, in the order scanFile reads them.
const fileColumns = "path, rev, COALESCE(sha256, ''), COALESCE(md5, ''), size, deleted, COALESCE(by_device, ''), server_time"

type scanner interface{ Scan(dest ...any) error }

func scanFile(r scanner) (File, error) {
	var f File
	err := r.Scan(&f.Path, &f.Rev, &f.SHA256, &f.MD5, &f.Size, &f.Deleted, &f.ByDevice, &f.ServerTime)
	return f, err
}

func fileRow(ctx context.Context, q querier, vaultID, path string) (*File, error) {
	f, err := scanFile(q.QueryRowContext(ctx, "SELECT "+fileColumns+" FROM files WHERE vault_id = ? AND path = ?", vaultID, path))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &f, err
}

// File answers for one path as it is right now (a tombstone is answered as such; a path never seen is a 404).
func (s *Store) File(ctx context.Context, v *Vault, path string) (File, error) {
	f, err := fileRow(ctx, s.DB, v.ID, path)
	if err != nil {
		return File{}, err
	}
	if f == nil {
		return File{}, apierr.New(404, "no_such_file")
	}
	return *f, nil
}

func queryFiles(ctx context.Context, q querier, query string, args ...any) ([]File, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []File{}
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

type cachedRoot struct {
	seq  int64
	root string
}

// rootHash is one hash over every live (path, md5): equal on two sides means the two sides hold exactly the same
// files. It is what lets a client notice that its mirror of the server is damaged. It is cached per seq because
// computing it reads every file of the vault.
func (s *Store) rootHash(ctx context.Context, v *Vault) (string, error) {
	s.rootMu.Lock()
	hit, ok := s.roots[v.ID]
	s.rootMu.Unlock()
	if ok && hit.seq == v.Seq {
		return hit.root, nil
	}
	rows, err := s.DB.QueryContext(ctx, "SELECT path, COALESCE(md5, '') FROM files WHERE vault_id = ? AND deleted = 0 ORDER BY path", v.ID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	h := sha256.New()
	for rows.Next() {
		var path, md5 string
		if err := rows.Scan(&path, &md5); err != nil {
			return "", err
		}
		h.Write([]byte(path + "\x00" + md5 + "\n"))
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	root := hex.EncodeToString(h.Sum(nil))
	s.rootMu.Lock()
	if s.roots == nil {
		s.roots = map[string]cachedRoot{}
	}
	s.roots[v.ID] = cachedRoot{seq: v.Seq, root: root}
	s.rootMu.Unlock()
	return root, nil
}

// State is the answer to GET /state.
type State struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Epoch      string `json:"epoch"`
	Seq        int64  `json:"seq"`
	Compacted  int64  `json:"compacted"`
	Files      int64  `json:"files"`
	Root       string `json:"root"`
	ServerTime int64  `json:"server_time"`
}

// State reads the vault afresh (its seq may have moved since the caller looked).
func (s *Store) State(ctx context.Context, id string) (State, error) {
	v, err := vaultRow(ctx, s.DB, id)
	if err != nil {
		return State{}, err
	}
	if v == nil {
		return State{}, apierr.New(404, "no_such_vault")
	}
	var files int64
	if err := s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM files WHERE vault_id = ? AND deleted = 0", id).Scan(&files); err != nil {
		return State{}, err
	}
	root, err := s.rootHash(ctx, v)
	return State{ID: v.ID, Name: v.Name, Epoch: v.Epoch, Seq: v.Seq, Compacted: v.Compacted, Files: files, Root: root, ServerTime: s.ms()}, err
}

// Changes is the answer to GET /changes.
type Changes struct {
	Epoch      string `json:"epoch"`
	Head       int64  `json:"head"`
	Next       int64  `json:"next"`
	HasMore    bool   `json:"has_more"`
	Files      []File `json:"files"`
	ServerTime int64  `json:"server_time"`
}

// DefaultPage is how many changes a page holds when the client does not say; maxPage is the most it may ask for.
const (
	DefaultPage = 500
	maxPage     = 1000
)

// Changes returns what changed after rev `since`, oldest first. A `since` older than what was compacted away means
// "start over" (410).
func (s *Store) Changes(ctx context.Context, id string, since int64, limit int) (Changes, error) {
	v, err := vaultRow(ctx, s.DB, id)
	if err != nil {
		return Changes{}, err
	}
	if v == nil {
		return Changes{}, apierr.New(404, "no_such_vault")
	}
	since = max(since, 0)
	limit = min(max(limit, 1), maxPage)
	if since < v.Compacted {
		return Changes{}, apierr.With(410, "since_too_old", map[string]any{"epoch": v.Epoch, "compacted": v.Compacted})
	}
	rows, err := queryFiles(ctx, s.DB, "SELECT "+fileColumns+" FROM files WHERE vault_id = ? AND rev > ? ORDER BY rev LIMIT ?", id, since, limit+1)
	if err != nil {
		return Changes{}, err
	}
	out := Changes{Epoch: v.Epoch, Head: v.Seq, Next: v.Seq, Files: rows, ServerTime: s.ms()}
	if len(rows) > limit {
		out.Files = rows[:limit]
		out.HasMore = true
		out.Next = rows[limit-1].Rev
	}
	return out, nil
}

const revisionsShown = 50

// Revisions lists the revisions of a path, newest first.
func (s *Store) Revisions(ctx context.Context, v *Vault, path string) ([]File, error) {
	return queryFiles(ctx, s.DB, "SELECT "+fileColumns+" FROM revisions WHERE vault_id = ? AND path = ? ORDER BY rev DESC LIMIT ?", v.ID, path, revisionsShown)
}

func revisionRow(ctx context.Context, q querier, vaultID string, rev int64) (*File, error) {
	f, err := scanFile(q.QueryRowContext(ctx, "SELECT "+fileColumns+" FROM revisions WHERE vault_id = ? AND rev = ?", vaultID, rev))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &f, err
}

// Revision returns the content hash of one live revision, even if the path has moved on since.
func (s *Store) Revision(ctx context.Context, v *Vault, rev int64) (File, error) {
	f, err := revisionRow(ctx, s.DB, v.ID, rev)
	if err != nil {
		return File{}, err
	}
	if f == nil || f.Deleted || f.SHA256 == "" {
		return File{}, apierr.New(404, "no_such_revision")
	}
	return *f, nil
}
