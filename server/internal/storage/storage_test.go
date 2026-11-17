package storage

import (
	"bytes"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func sum(content string) (sha, md string) {
	s, m := sha256.Sum256([]byte(content)), md5.Sum([]byte(content))
	return hex.EncodeToString(s[:]), hex.EncodeToString(m[:])
}

func newBlobs(t *testing.T) (*Blobs, string) {
	t.Helper()
	dir := t.TempDir()
	b, err := NewBlobs(dir)
	if err != nil {
		t.Fatal(err)
	}
	return b, dir
}

func TestBlobStoredWholeAndRead(t *testing.T) {
	b, _ := newBlobs(t)
	sha, md := sum("hello world")
	if err := b.Receive("vault-1", sha, 0, []byte("hello world")); err != nil {
		t.Fatal(err)
	}
	got, err := b.Finish("vault-1", sha, 11)
	if err != nil || got != md {
		t.Fatalf("finish: md5 %q err %v", got, err)
	}
	if !b.Has("vault-1", sha) || b.Received("vault-1", sha) != 0 {
		t.Fatal("the blob must exist and its staging file must be gone")
	}
	f, err := b.Open("vault-1", sha)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if data, _ := io.ReadAll(f); string(data) != "hello world" {
		t.Fatalf("read back %q", data)
	}
	if _, err := b.Open("vault-1", "00"+sha[2:]); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a blob that is not there: %v", err)
	}
}

func TestBlobWithTheWrongHashIsDiscarded(t *testing.T) {
	b, _ := newBlobs(t)
	sha, _ := sum("real")
	_ = b.Receive("vault-1", sha, 0, []byte("fake"))
	if _, err := b.Finish("vault-1", sha, 4); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("got %v", err)
	}
	if b.Has("vault-1", sha) || b.Received("vault-1", sha) != 0 {
		t.Fatal("nothing may be kept of a blob that does not match its name")
	}
}

func TestBlobPiecesResumeAndRepeat(t *testing.T) {
	b, _ := newBlobs(t)
	content := string(bytes.Repeat([]byte("abcdefghij"), 10))
	sha, _ := sum(content)
	piece := func(from, to int64) error { return b.Receive("v", sha, from, []byte(content[from:to])) }

	if err := piece(0, 40); err != nil || b.Received("v", sha) != 40 {
		t.Fatalf("first piece: %v, held %d", err, b.Received("v", sha))
	}
	var gap *OutOfOrder
	if err := piece(60, 100); !errors.As(err, &gap) || gap.Received != 40 {
		t.Fatalf("a piece beyond what is held: %v", err)
	}
	for _, p := range [][2]int64{{0, 40}, {40, 70}, {40, 70}} { // the first piece again, then a lost answer: the same piece twice
		if err := piece(p[0], p[1]); err != nil {
			t.Fatal(err)
		}
	}
	if err := piece(70, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Finish("v", sha, 100); err != nil {
		t.Fatal(err)
	}
}

func TestBlobOfTheWrongSizeIsDiscarded(t *testing.T) {
	b, _ := newBlobs(t)
	sha, _ := sum("abc")
	_ = b.Receive("v", sha, 0, []byte("abc"))
	if _, err := b.Finish("v", sha, 5); !errors.Is(err, ErrSizeMismatch) {
		t.Fatalf("got %v", err)
	}
}

func TestVaultsThatDifferOnlyInCaseDoNotShareFolders(t *testing.T) {
	b, _ := newBlobs(t)
	sha, _ := sum("x")
	_ = b.Receive("Abcdefgh", sha, 0, []byte("x"))
	if _, err := b.Finish("Abcdefgh", sha, 1); err != nil {
		t.Fatal(err)
	}
	if b.Has("abcdefgh", sha) {
		t.Fatal("another vault's blob is visible")
	}
	if err := b.RemoveVault("abcdefgh"); err != nil || !b.Has("Abcdefgh", sha) {
		t.Fatal("removing one vault must leave the other alone")
	}
	if err := b.RemoveVault("Abcdefgh"); err != nil || b.Has("Abcdefgh", sha) {
		t.Fatal("the vault's blobs must go")
	}
}

func TestStagingOlderThanTheLimitIsSwept(t *testing.T) {
	b, dir := newBlobs(t)
	sha, _ := sum("half")
	_ = b.Receive("v", sha, 0, []byte("ha"))
	if n, _ := b.SweepStaging(time.Now(), time.Hour); n != 0 {
		t.Fatalf("a fresh upload was swept (%d)", n)
	}
	n, err := b.SweepStaging(time.Now().Add(48*time.Hour), 24*time.Hour)
	if err != nil || n != 1 {
		t.Fatalf("swept %d, err %v", n, err)
	}
	if entries, _ := os.ReadDir(filepath.Join(dir, "staging")); len(entries) != 0 {
		t.Fatal("staging not empty")
	}
}

func TestRemoveMissingBlobIsNotAnError(t *testing.T) {
	b, _ := newBlobs(t)
	sha, _ := sum("nothing")
	if err := b.Remove("v", sha); err != nil {
		t.Fatal(err)
	}
}

func TestLockKeepsASecondInstanceOut(t *testing.T) {
	dir := t.TempDir()
	first, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(dir); !errors.Is(err, ErrLocked) {
		t.Fatalf("a second instance got in: %v", err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	second, err := Acquire(dir)
	if err != nil {
		t.Fatalf("after release: %v", err)
	}
	second.Release()
}

func TestLockFileLeftByAKilledServerDoesNotBlock(t *testing.T) {
	dir := t.TempDir()
	// what a crash leaves behind: the file, with a pid in it, and nobody holding the lock
	if err := os.WriteFile(filepath.Join(dir, "nevis.lock"), []byte("424242\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	l, err := Acquire(dir)
	if err != nil {
		t.Fatalf("a stale lock file blocked the start: %v", err)
	}
	l.Release()
}

func TestLockIsPerDataDirectory(t *testing.T) {
	a, err := Acquire(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Release()
	b, err := Acquire(t.TempDir())
	if err != nil {
		t.Fatalf("two servers on different data directories must not collide: %v", err)
	}
	b.Release()
}

func TestReleaseTwiceIsHarmless(t *testing.T) {
	l, err := Acquire(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := l.Release(); err != nil {
		t.Fatal(err)
	}
	if err := l.Release(); err != nil {
		t.Fatalf("second release: %v", err)
	}
}
