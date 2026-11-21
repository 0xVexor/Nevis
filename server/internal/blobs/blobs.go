// Package blobs keeps the bytes of attachments on disk (ADR-0006 §6, ROADMAP M9). Adapted from the old server's storage package.
//
// A blob is named by its SHA-256 and lives at DATA_DIR/blobs/<workspace>/<first two hex digits>/<sha256>. It is uploaded in pieces
// (a connection that dies halfway costs only the missing part) into DATA_DIR/staging; only a blob whose hash the server has
// re-computed and found equal to its name is moved into place, so a file in blobs/ is always whole and correct. The package knows
// nothing about accounts or quota: the database row that makes a blob visible is written by the caller AFTER Finish.
package blobs

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	ErrSizeMismatch = errors.New("the pieces do not add up to the announced size")
	ErrHashMismatch = errors.New("the content does not match its hash")
)

// OutOfOrder is returned when a piece starts beyond what the server holds.
type OutOfOrder struct{ Received int64 }

func (e *OutOfOrder) Error() string {
	return fmt.Sprintf("piece starts after the %d bytes held", e.Received)
}

type Store struct {
	root, staging string
	locks         [64]sync.Mutex
}

func New(dataDir string) (*Store, error) {
	b := &Store{root: filepath.Join(dataDir, "blobs"), staging: filepath.Join(dataDir, "staging")}
	for _, d := range []string{b.root, b.staging} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	return b, nil
}

// ValidHash: 64 lowercase hex digits. The backstop behind the callers' own checks: nothing else ever becomes part of a path.
func ValidHash(sha string) bool {
	if len(sha) != 64 {
		return false
	}
	for _, c := range sha {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// ws is a UUID the API has validated; it is checked again here so a bad one can never escape the folder.
func validWS(ws string) bool {
	if len(ws) != 36 {
		return false
	}
	for _, c := range ws {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && c != '-' {
			return false
		}
	}
	return true
}

func (b *Store) path(ws, sha string) string {
	if !validWS(ws) || !ValidHash(sha) {
		return ""
	}
	return filepath.Join(b.root, ws, sha[:2], sha)
}

func (b *Store) stagingPath(ws, sha string) string {
	if !validWS(ws) || !ValidHash(sha) {
		return ""
	}
	return filepath.Join(b.staging, ws+"_"+sha)
}

// Lock serializes the work on one blob (two devices uploading the same content at once, a retried piece).
func (b *Store) Lock(ws, sha string) (unlock func()) {
	h := fnv.New32a()
	h.Write([]byte(ws + sha))
	m := &b.locks[h.Sum32()%uint32(len(b.locks))]
	m.Lock()
	return m.Unlock
}

// Received is how many bytes of a half-uploaded blob the server holds (0 when none).
func (b *Store) Received(ws, sha string) int64 {
	p := b.stagingPath(ws, sha)
	if p == "" {
		return 0
	}
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.Size()
}

// Receive stores the piece that begins at byte start. A piece sent again (a lost answer) cuts the file back to where it begins; one
// that begins beyond what is held is refused with OutOfOrder so the client can resume from `Received`.
func (b *Store) Receive(ws, sha string, start int64, piece []byte) error {
	name := b.stagingPath(ws, sha)
	if name == "" {
		return os.ErrInvalid
	}
	if start == 0 {
		return os.WriteFile(name, piece, 0o644)
	}
	if held := b.Received(ws, sha); held < start {
		return &OutOfOrder{Received: held}
	}
	f, err := os.OpenFile(name, os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := f.Truncate(start); err != nil {
		return err
	}
	_, err = f.WriteAt(piece, start)
	return err
}

// Finish checks a complete upload and moves it into place. A blob that fails the check is thrown away so the client starts over.
func (b *Store) Finish(ws, sha string, total int64) error {
	staged := b.stagingPath(ws, sha)
	if staged == "" {
		return os.ErrInvalid
	}
	f, err := os.Open(staged)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(h, f)
	f.Close()
	if err != nil {
		return err
	}
	switch {
	case n != total:
		err = ErrSizeMismatch
	case hex.EncodeToString(h.Sum(nil)) != sha:
		err = ErrHashMismatch
	}
	if err != nil {
		_ = os.Remove(staged)
		return err
	}
	final := b.path(ws, sha)
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		return err
	}
	return os.Rename(staged, final) // only now does the blob exist for the server
}

// Open returns the blob, or an error satisfying errors.Is(err, os.ErrNotExist).
func (b *Store) Open(ws, sha string) (*os.File, error) {
	p := b.path(ws, sha)
	if p == "" {
		return nil, os.ErrNotExist
	}
	return os.Open(p)
}

// Remove deletes one blob (a missing one is not an error).
func (b *Store) Remove(ws, sha string) error {
	p := b.path(ws, sha)
	if p == "" {
		return os.ErrInvalid
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// DropStaging forgets a half-uploaded blob.
func (b *Store) DropStaging(ws, sha string) {
	if p := b.stagingPath(ws, sha); p != "" {
		_ = os.Remove(p)
	}
}

// SweepStaging removes half-finished uploads that nobody continued for maxAge and returns how many.
func (b *Store) SweepStaging(now time.Time, maxAge time.Duration) (int, error) {
	entries, err := os.ReadDir(b.staging)
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || now.Sub(info.ModTime()) <= maxAge {
			continue
		}
		if os.Remove(filepath.Join(b.staging, e.Name())) == nil {
			removed++
		}
	}
	return removed, nil
}
