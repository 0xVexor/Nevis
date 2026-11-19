// Package storage keeps the bytes of files on disk, and the lock that keeps a second server away from the same data.
//
// A blob is named by its SHA-256 and lives at DATA_DIR/blobs/<vault>/<first two hex digits>/<sha256>. It is
// uploaded before the commit that points at it, possibly in several pieces so that a connection that dies halfway
// costs only the missing part. The pieces collect in DATA_DIR/staging; only a blob whose hash the server has
// re-computed and found equal to its name is moved into place, so a blob in blobs/ is always whole and correct.
package storage

import (
	"crypto/md5"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Errors the upload can end with besides plain I/O failures.
var (
	ErrSizeMismatch = errors.New("the pieces do not add up to the announced size")
	ErrHashMismatch = errors.New("the content does not match its hash")
)

// OutOfOrder is returned when a piece starts beyond what the server holds.
type OutOfOrder struct{ Received int64 }

func (e *OutOfOrder) Error() string {
	return fmt.Sprintf("piece starts after the %d bytes held", e.Received)
}

// Blobs is the blob store of one data directory.
type Blobs struct {
	root, staging string
	locks         [64]sync.Mutex
}

// NewBlobs prepares the folders under dataDir.
func NewBlobs(dataDir string) (*Blobs, error) {
	b := &Blobs{root: filepath.Join(dataDir, "blobs"), staging: filepath.Join(dataDir, "staging")}
	for _, d := range []string{b.root, b.staging} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	return b, nil
}

// vaultDir encodes the vault id so that two ids that differ only in letter case cannot share a folder on a
// case-insensitive disk (Windows, macOS): one vault's removal must never touch another's blobs.
func vaultDir(vault string) string {
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte(vault)))
}

// validSHA is the backstop behind the callers' own checks: a name that is not 64 lowercase hex digits never becomes
// part of a path.
func validSHA(sha string) bool {
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

// path is "" for a malformed sha, which every file operation refuses (nothing exists there, nothing can be written).
func (b *Blobs) path(vault, sha string) string {
	if !validSHA(sha) {
		return ""
	}
	return filepath.Join(b.root, vaultDir(vault), sha[:2], sha)
}

// stagingPath is "" for a malformed sha, like path.
func (b *Blobs) stagingPath(vault, sha string) string {
	if !validSHA(sha) {
		return ""
	}
	return filepath.Join(b.staging, vaultDir(vault)+"_"+sha)
}

// Lock serializes the work on one blob (two devices uploading the same content at once, a retried piece).
func (b *Blobs) Lock(vault, sha string) (unlock func()) {
	h := fnv.New32a()
	h.Write([]byte(vault + sha))
	m := &b.locks[h.Sum32()%uint32(len(b.locks))]
	m.Lock()
	return m.Unlock
}

// Received is how many bytes of a half-uploaded blob the server holds (0 when none).
func (b *Blobs) Received(vault, sha string) int64 {
	st, err := os.Stat(b.stagingPath(vault, sha))
	if err != nil {
		return 0
	}
	return st.Size()
}

// Receive stores the piece that begins at byte start. A piece sent again (a lost answer) cuts the file back to
// where it begins; one that begins beyond what is held is refused with OutOfOrder so the client can resume.
func (b *Blobs) Receive(vault, sha string, start int64, piece []byte) error {
	name := b.stagingPath(vault, sha)
	if start == 0 {
		return os.WriteFile(name, piece, 0o644)
	}
	held := b.Received(vault, sha)
	if held < start {
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
	if _, err := f.WriteAt(piece, start); err != nil {
		return err
	}
	return nil
}

// Finish checks a complete upload and moves it into place. It returns the MD5, which the sync clients use to
// compare files. A blob that fails the check is thrown away so the client starts over.
func (b *Blobs) Finish(vault, sha string, total int64) (md5Hex string, err error) {
	staged := b.stagingPath(vault, sha)
	f, err := os.Open(staged)
	if err != nil {
		return "", err
	}
	strong, weak := sha256.New(), md5.New()
	n, err := io.Copy(io.MultiWriter(strong, weak), f)
	f.Close()
	if err != nil {
		return "", err
	}
	switch {
	case n != total:
		err = ErrSizeMismatch
	case hex.EncodeToString(strong.Sum(nil)) != sha:
		err = ErrHashMismatch
	}
	if err != nil {
		_ = os.Remove(staged)
		return "", err
	}
	final := b.path(vault, sha)
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(staged, final); err != nil { // only now does the blob exist for the server
		return "", err
	}
	return hex.EncodeToString(weak.Sum(nil)), nil
}

// Open returns the blob, or an error satisfying errors.Is(err, os.ErrNotExist).
func (b *Blobs) Open(vault, sha string) (*os.File, error) { return os.Open(b.path(vault, sha)) }

// Has tells whether the blob is stored.
func (b *Blobs) Has(vault, sha string) bool {
	_, err := os.Stat(b.path(vault, sha))
	return err == nil
}

// Remove deletes one blob (a missing one is not an error).
func (b *Blobs) Remove(vault, sha string) error {
	if err := os.Remove(b.path(vault, sha)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// RemoveVault deletes every blob of a vault.
func (b *Blobs) RemoveVault(vault string) error {
	return os.RemoveAll(filepath.Join(b.root, vaultDir(vault)))
}

// SweepStaging removes half-finished uploads that nobody continued for maxAge and returns how many.
func (b *Blobs) SweepStaging(now time.Time, maxAge time.Duration) (int, error) {
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
