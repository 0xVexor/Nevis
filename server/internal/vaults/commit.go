package vaults

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"regexp"

	"github.com/0xVexor/Nevis/server/internal/apierr"
	"github.com/0xVexor/Nevis/server/internal/storage"
)

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

const maxOps = 200

// Result is the answer for one op of a commit: `{ok: true, rev, ...}` or `{ok: false, error, ...}`.
type Result map[string]any

func (r Result) ok() bool { ok, _ := r["ok"].(bool); return ok }

func conflict(current *File) Result {
	r := Result{"ok": false, "error": "conflict", "current": nil}
	if current != nil {
		r["current"] = current.Meta
	}
	return r
}

func refuse(code, detail string) Result {
	r := Result{"ok": false, "error": code}
	if detail != "" {
		r["detail"] = detail
	}
	return r
}

func putResult(m Meta, noop bool) Result {
	r := Result{"ok": true, "rev": m.Rev, "sha256": m.SHA256, "md5": m.MD5, "size": m.Size, "deleted": m.Deleted, "server_time": m.ServerTime}
	if noop {
		r["noop"] = true
	}
	return r
}

// CommitIn is the body of a commit. Ops stay raw so that one malformed op is answered with bad_op instead of
// failing the whole request.
type CommitIn struct {
	OpID        string            `json:"op_id"`
	Ops         []json.RawMessage `json:"ops"`
	Atomic      bool              `json:"atomic"`
	ConfirmBulk bool              `json:"confirm_bulk"`
}

// CommitOut is the answer to a commit. Replay is set when the op_id was answered before.
type CommitOut struct {
	Results    []Result `json:"results"`
	Seq        int64    `json:"seq"`
	ServerTime int64    `json:"server_time"`
	Replay     bool     `json:"replay,omitempty"`
	// Changed tells the caller whether the vault moved (wake the waiting devices, schedule a backup).
	Changed bool `json:"-"`
}

type opIn struct {
	Op      string `json:"op"`
	Path    string `json:"path"`
	SHA256  string `json:"sha256"`
	BaseRev any    `json:"base_rev"`
}

// base is the rev the client based its write on; anything that is not a non-negative integer means "none" (0).
func (o opIn) base() int64 {
	f, ok := o.BaseRev.(float64)
	if !ok || f < 0 || f != math.Trunc(f) {
		return 0
	}
	return int64(f)
}

const upsertFile = `INSERT INTO files (vault_id, path, path_ci, rev, sha256, md5, size, deleted, by_device, server_time)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (vault_id, path) DO UPDATE SET rev = excluded.rev, sha256 = excluded.sha256, md5 = excluded.md5, size = excluded.size,
    deleted = excluded.deleted, by_device = excluded.by_device, server_time = excluded.server_time`

const insertRevision = `INSERT INTO revisions (vault_id, rev, path, sha256, md5, size, deleted, by_device, server_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

// batch is the state shared by the ops of one commit.
type batch struct {
	vault        string
	device       string
	now          int64
	seq          int64
	allowDeletes bool
	blobs        *storage.Blobs // to tell a recorded blob from one whose file is gone
}

func (b *batch) write(ctx context.Context, tx *sql.Tx, path string, m Meta) error {
	var sha, md5 any // a tombstone has no content
	if !m.Deleted {
		sha, md5 = m.SHA256, m.MD5
	}
	if _, err := tx.ExecContext(ctx, upsertFile, b.vault, path, foldCase(path), m.Rev, sha, md5, m.Size, m.Deleted, b.device, b.now); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, insertRevision, b.vault, m.Rev, path, sha, md5, m.Size, m.Deleted, b.device, b.now)
	return err
}

func (b *batch) apply(ctx context.Context, tx *sql.Tx, raw json.RawMessage) (Result, error) {
	var op opIn
	if err := json.Unmarshal(raw, &op); err != nil {
		return refuse("bad_op", ""), nil
	}
	return b.applyOp(ctx, tx, op)
}

func (b *batch) applyOp(ctx context.Context, tx *sql.Tx, op opIn) (Result, error) {
	if op.Op != "put" && op.Op != "delete" {
		return refuse("bad_op", ""), nil
	}
	if bad := checkPath(op.Path); bad != "" {
		return refuse("bad_path", bad), nil
	}
	row, err := fileRow(ctx, tx, b.vault, op.Path)
	if err != nil {
		return nil, err
	}
	if op.Op == "delete" {
		return b.applyDelete(ctx, tx, op, row)
	}
	return b.applyPut(ctx, tx, op, row)
}

func (b *batch) applyDelete(ctx context.Context, tx *sql.Tx, op opIn, row *File) (Result, error) {
	if row == nil || row.Deleted {
		var rev int64
		if row != nil {
			rev = row.Rev
		}
		return Result{"ok": true, "noop": true, "rev": rev, "deleted": true}, nil
	}
	if op.base() != row.Rev {
		return conflict(row), nil
	}
	if !b.allowDeletes {
		return refuse("bulk_delete", ""), nil
	}
	b.seq++
	m := Meta{Rev: b.seq, Deleted: true, ServerTime: b.now}
	if err := b.write(ctx, tx, op.Path, m); err != nil {
		return nil, err
	}
	return Result{"ok": true, "rev": m.Rev, "deleted": true, "server_time": b.now}, nil
}

func (b *batch) applyPut(ctx context.Context, tx *sql.Tx, op opIn, row *File) (Result, error) {
	if !hex64.MatchString(op.SHA256) {
		return refuse("bad_sha", ""), nil
	}
	var md5 string
	var size int64
	err := tx.QueryRowContext(ctx, "SELECT md5, size FROM blobs WHERE vault_id = ? AND sha256 = ?", b.vault, op.SHA256).Scan(&md5, &size)
	if errors.Is(err, sql.ErrNoRows) {
		return refuse("blob_missing", ""), nil
	}
	if err != nil {
		return nil, err
	}
	if !b.blobs.Has(b.vault, op.SHA256) { // a row restored from a backup without its file is no blob
		return refuse("blob_missing", ""), nil
	}
	var clash string
	err = tx.QueryRowContext(ctx, "SELECT path FROM files WHERE vault_id = ? AND path_ci = ? AND path <> ?", b.vault, foldCase(op.Path), op.Path).Scan(&clash)
	if err == nil {
		return refuse("path_case_clash", clash), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	base := op.base()
	switch {
	case row != nil && !row.Deleted:
		if row.SHA256 == op.SHA256 {
			return putResult(row.Meta, true), nil // the same content is already there
		}
		if base != row.Rev {
			return conflict(row), nil
		}
	case row != nil:
		if base != 0 && base != row.Rev { // deleted: a re-creation knows no rev, or knows the tombstone's
			return conflict(row), nil
		}
	case base != 0:
		return conflict(nil), nil
	}
	b.seq++
	m := Meta{Rev: b.seq, SHA256: op.SHA256, MD5: md5, Size: size, ServerTime: b.now}
	if err := b.write(ctx, tx, op.Path, m); err != nil {
		return nil, err
	}
	return putResult(m, false), nil
}

// rollback unwinds an atomic commit in which some op failed; it carries what to answer.
type rollback struct{ results []Result }

func (rollback) Error() string { return "rollback" }

// Commit applies a batch of writes, each against its base_rev. results[i] is `{ok: true, rev, ...}` or
// `{ok: false, error: "conflict", current}`. With atomic either every op is applied or none. The same op_id always
// answers the same way (replay), so a client that lost the answer can simply ask again.
func (s *Store) Commit(ctx context.Context, v *Vault, device string, in CommitIn) (CommitOut, error) {
	if l := len(in.OpID); l < 8 || l > 80 {
		return CommitOut{}, apierr.New(400, "bad_op_id")
	}
	if len(in.Ops) == 0 || len(in.Ops) > maxOps {
		return CommitOut{}, apierr.New(400, "bad_ops")
	}
	var out CommitOut
	err := s.DB.Write(ctx, func(tx *sql.Tx) error {
		if prior, found, err := s.replayOf(ctx, tx, v.ID, in.OpID); err != nil || found {
			out = prior
			return err
		}
		b := &batch{vault: v.ID, device: device, now: s.ms(), blobs: s.Blobs}
		if err := tx.QueryRowContext(ctx, "SELECT seq FROM vaults WHERE id = ?", v.ID).Scan(&b.seq); err != nil {
			return err
		}
		start := b.seq
		allow, err := s.deletesAllowed(ctx, tx, v.ID, in)
		if err != nil {
			return err
		}
		b.allowDeletes = allow
		results := make([]Result, 0, len(in.Ops))
		failed := false
		for _, raw := range in.Ops {
			r, err := b.apply(ctx, tx, raw)
			if err != nil {
				return err
			}
			failed = failed || !r.ok()
			results = append(results, r)
		}
		if in.Atomic && failed {
			return rollback{results: notApplied(results)}
		}
		if b.seq != start {
			if _, err := tx.ExecContext(ctx, "UPDATE vaults SET seq = ? WHERE id = ?", b.seq, v.ID); err != nil {
				return err
			}
		}
		out = CommitOut{Results: results, Seq: b.seq, ServerTime: b.now, Changed: b.seq != start}
		stored, err := json.Marshal(out)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO ops (vault_id, op_id, result, created_at) VALUES (?, ?, ?, ?)", v.ID, in.OpID, string(stored), b.now)
		return err
	})
	var undone rollback
	if errors.As(err, &undone) {
		cur, rerr := s.Reload(ctx, v.ID)
		if rerr != nil || cur == nil {
			return CommitOut{}, errors.Join(rerr, apierr.New(404, "no_such_vault"))
		}
		return CommitOut{Results: undone.results, Seq: cur.Seq, ServerTime: s.ms()}, nil
	}
	return out, err
}

func notApplied(results []Result) []Result {
	out := make([]Result, len(results))
	for i, r := range results {
		out[i] = r
		if r.ok() {
			out[i] = Result{"ok": false, "error": "not_applied"}
		}
	}
	return out
}

func (s *Store) replayOf(ctx context.Context, tx *sql.Tx, vaultID, opID string) (CommitOut, bool, error) {
	var stored string
	err := tx.QueryRowContext(ctx, "SELECT result FROM ops WHERE vault_id = ? AND op_id = ?", vaultID, opID).Scan(&stored)
	if errors.Is(err, sql.ErrNoRows) {
		return CommitOut{}, false, nil
	}
	if err != nil {
		return CommitOut{}, false, err
	}
	var out CommitOut
	dec := json.NewDecoder(bytes.NewReader([]byte(stored)))
	dec.UseNumber() // numbers go back out exactly as they were stored
	if err := dec.Decode(&out); err != nil {
		return CommitOut{}, false, err
	}
	out.Replay = true
	return out, true, nil
}

// deletesAllowed: a mass deletion is the most expensive kind of mistake, so it needs the client to say it means it.
func (s *Store) deletesAllowed(ctx context.Context, tx *sql.Tx, vaultID string, in CommitIn) (bool, error) {
	if in.ConfirmBulk {
		return true, nil
	}
	var live int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM files WHERE vault_id = ? AND deleted = 0", vaultID).Scan(&live); err != nil {
		return false, err
	}
	deletes := 0
	for _, raw := range in.Ops {
		var op struct {
			Op string `json:"op"`
		}
		if json.Unmarshal(raw, &op) == nil && op.Op == "delete" {
			deletes++
		}
	}
	return deletes <= max(5, live/5), nil
}

// Restore puts an earlier revision of a path back as a new revision.
func (s *Store) Restore(ctx context.Context, v *Vault, device, path string, rev int64) (Result, int64, bool, error) {
	old, err := revisionRow(ctx, s.DB, v.ID, rev)
	if err != nil {
		return nil, 0, false, err
	}
	if old == nil || old.Path != path || old.Deleted {
		return nil, 0, false, apierr.New(404, "no_such_revision")
	}
	var have int
	if err := s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM blobs WHERE vault_id = ? AND sha256 = ?", v.ID, old.SHA256).Scan(&have); err != nil {
		return nil, 0, false, err
	}
	if have == 0 {
		return nil, 0, false, apierr.New(410, "content_expired")
	}
	var res Result
	var seq int64
	changed := false
	err = s.DB.Write(ctx, func(tx *sql.Tx) error {
		row, err := fileRow(ctx, tx, v.ID, path)
		if err != nil {
			return err
		}
		b := &batch{vault: v.ID, device: device, now: s.ms(), allowDeletes: true, blobs: s.Blobs}
		if err := tx.QueryRowContext(ctx, "SELECT seq FROM vaults WHERE id = ?", v.ID).Scan(&b.seq); err != nil {
			return err
		}
		if res, err = b.applyOp(ctx, tx, opIn{Op: "put", Path: path, SHA256: old.SHA256, BaseRev: float64(revOf(row))}); err != nil {
			return err
		}
		seq = b.seq
		changed = res.ok() && res["noop"] != true
		if changed {
			_, err = tx.ExecContext(ctx, "UPDATE vaults SET seq = ? WHERE id = ?", b.seq, v.ID)
		}
		return err
	})
	return res, seq, changed, err
}

func revOf(f *File) int64 {
	if f == nil {
		return 0
	}
	return f.Rev
}
