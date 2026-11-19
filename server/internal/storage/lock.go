package storage

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// ErrLocked means another server already runs on the data directory.
var ErrLocked = errors.New("another nevis-server is already using this data directory")

// Lock keeps a second server away from the same data: two of them would not see each other's commits (writes are
// serialized inside one process) and would hand out the same sequence numbers. The operating system releases the
// lock when the process ends, however it ends, so a crash never leaves a stale lock behind.
type Lock struct{ f *os.File }

// Acquire takes the lock on DATA_DIR/nevis.lock.
func Acquire(dataDir string) (*Lock, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	name := filepath.Join(dataDir, "nevis.lock")
	f, err := os.OpenFile(name, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	if err := lockFile(f); err != nil {
		f.Close()
		return nil, fmt.Errorf("%w (%s)", ErrLocked, name)
	}
	_ = f.Truncate(0)
	_, _ = fmt.Fprintf(f, "%d\n", os.Getpid()) // for the operator: who holds it
	return &Lock{f: f}, nil
}

// Release lets go of the lock. The file stays: removing it would race with a server that is just starting.
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	err := unlockFile(l.f)
	if cerr := l.f.Close(); err == nil {
		err = cerr
	}
	l.f = nil
	return err
}
