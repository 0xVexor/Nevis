package vaults

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"

	"github.com/0xVexor/Nevis/server/internal/apierr"
	"github.com/0xVexor/Nevis/server/internal/storage"
)

// Receiving file contents. A blob is named by its SHA-256 and is uploaded before the commit that points at it,
// possibly in several pieces (Content-Range). Nothing is visible to other devices until `commit` names the blob,
// and a blob is only recorded once the server has re-computed its hash and found it equal to the name it was
// uploaded under.

var emptySHA256 = hex.EncodeToString(func() []byte { s := sha256.Sum256(nil); return s[:] }())

// Range is a Content-Range of an upload piece: bytes Start through End (inclusive) of Total.
type Range struct{ Start, End, Total int64 }

// BlobResult is the answer to an upload piece.
type BlobResult struct {
	Complete bool
	Existed  bool // the blob was already there
	Size     int64
	MD5      string
	Received int64 // how far a partial upload has got
}

// Body is the JSON the client reads.
func (r BlobResult) Body() map[string]any {
	if !r.Complete {
		return map[string]any{"complete": false, "received": r.Received}
	}
	out := map[string]any{"complete": true, "size": r.Size, "md5": r.MD5}
	if r.Existed {
		out["existed"] = true
	}
	return out
}

// UsedBytes is the storage an account uses.
func (s *Store) UsedBytes(ctx context.Context, userID string) (n int64, err error) {
	err = s.DB.QueryRowContext(ctx,
		"SELECT COALESCE(SUM(b.size), 0) FROM blobs b JOIN vaults v ON v.id = b.vault_id WHERE v.user_id = ?", userID).Scan(&n)
	return
}

// BlobInfo is the recorded size and MD5 of a blob (nil when the vault has no such blob).
type BlobInfo struct {
	Size int64
	MD5  string
}

// Blob looks a blob up in the vault.
func (s *Store) Blob(ctx context.Context, vaultID, sha string) (*BlobInfo, error) {
	var b BlobInfo
	err := s.DB.QueryRowContext(ctx, "SELECT size, md5 FROM blobs WHERE vault_id = ? AND sha256 = ?", vaultID, sha).Scan(&b.Size, &b.MD5)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &b, err
}

// Received is how many bytes of a half-uploaded blob the server holds.
func (s *Store) Received(vaultID, sha string) int64 { return s.Blobs.Received(vaultID, sha) }

// ReceiveBlob stores one piece of a blob (the whole body when rng is nil). Once the last piece is in, the hash is
// re-computed and the blob is recorded.
func (s *Store) ReceiveBlob(ctx context.Context, userID string, v *Vault, sha string, rng *Range, body []byte) (BlobResult, error) {
	if !hex64.MatchString(sha) {
		return BlobResult{}, apierr.New(400, "bad_sha")
	}
	// one upload of a given blob at a time: the second of two devices sending the same content finds it stored
	unlock := s.Blobs.Lock(v.ID, sha)
	defer unlock()
	have, err := s.Blob(ctx, v.ID, sha)
	if err != nil {
		return BlobResult{}, err
	}
	if have != nil {
		// the upload is a sign of life: housekeeping must not take the blob before the commit that follows it
		if _, err := s.DB.ExecContext(ctx, "UPDATE blobs SET created_at = ? WHERE vault_id = ? AND sha256 = ?", s.ms(), v.ID, sha); err != nil {
			return BlobResult{}, err
		}
		return BlobResult{Complete: true, Existed: true, Size: have.Size, MD5: have.MD5}, nil
	}
	if rng == nil {
		rng = &Range{Start: 0, End: int64(len(body)) - 1, Total: int64(len(body))}
	}
	if err := s.checkPiece(sha, *rng, int64(len(body))); err != nil {
		return BlobResult{}, err
	}
	// the declared size counts against the quota from the first piece until the blob is recorded or given up
	key := v.ID + "/" + sha
	known, err := s.reserve(ctx, userID, key, rng.Total)
	if err != nil {
		return BlobResult{}, err
	}
	pending := false // true while the upload stays half-finished on purpose
	defer func() {
		if !pending {
			s.release(userID, key)
		}
	}()
	if err := s.Blobs.Receive(v.ID, sha, rng.Start, body); err != nil {
		var gap *storage.OutOfOrder
		if errors.As(err, &gap) {
			// nothing was staged by this request: only an upload that already had pieces keeps its place
			pending = known
			return BlobResult{}, apierr.With(409, "out_of_order", map[string]any{"received": gap.Received})
		}
		return BlobResult{}, err
	}
	if rng.End+1 < rng.Total {
		pending = true
		return BlobResult{Received: rng.End + 1}, nil
	}
	md5, err := s.Blobs.Finish(v.ID, sha, rng.Total)
	switch {
	case errors.Is(err, storage.ErrSizeMismatch):
		return BlobResult{}, apierr.New(422, "size_mismatch")
	case errors.Is(err, storage.ErrHashMismatch):
		return BlobResult{}, apierr.New(422, "hash_mismatch")
	case err != nil:
		return BlobResult{}, err
	}
	_, err = s.DB.ExecContext(ctx, "INSERT OR IGNORE INTO blobs (vault_id, sha256, md5, size, created_at) VALUES (?, ?, ?, ?, ?)", v.ID, sha, md5, rng.Total, s.ms())
	return BlobResult{Complete: true, Size: rng.Total, MD5: md5}, err
}

// checkPiece refuses what can be seen to be wrong before a byte is written: a piece that does not fit its range, a
// blob over the size limit, an empty body that is not the empty file. (Room in the quota is checked by reserve.)
func (s *Store) checkPiece(sha string, r Range, bodyLen int64) error {
	if r.End-r.Start+1 != bodyLen || r.Start < 0 || r.End+1 < r.Start {
		return apierr.New(400, "bad_range")
	}
	if r.Total > s.Cfg.MaxBlobBytes {
		return apierr.With(413, "too_large", map[string]any{"limit": s.Cfg.MaxBlobBytes})
	}
	if r.Total == 0 && sha != emptySHA256 {
		return apierr.New(422, "hash_mismatch")
	}
	return nil
}
