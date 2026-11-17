package db

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Backups are whole, consistent copies of the database file made while the server keeps running
// (`VACUUM INTO` reads a snapshot and never blocks a writer). They are written a few seconds after the last
// write, and the newest few are kept. The blobs are not part of them: a blob is never changed after it is stored,
// so copying the blob folder is a plain file copy.
const (
	backupPrefix = "nevis-"
	backupSuffix = ".db"
	stamp        = "20060102T150405Z"
)

// Backups takes and prunes the copies in one folder.
type Backups struct {
	DB   *DB
	Dir  string
	Keep int
	Now  func() time.Time
}

// Snapshot writes one copy and removes the oldest ones beyond Keep. It returns the path of the new copy.
func (b *Backups) Snapshot(ctx context.Context) (string, error) {
	if err := os.MkdirAll(b.Dir, 0o755); err != nil {
		return "", err
	}
	final := filepath.Join(b.Dir, backupPrefix+b.Now().UTC().Format(stamp)+backupSuffix)
	tmp := final + ".tmp"
	if err := os.Remove(tmp); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	// VACUUM INTO refuses to overwrite, so the copy goes to a temporary name and is renamed once it is complete:
	// a crash never leaves a half-written file that looks like a backup.
	if _, err := b.DB.ExecContext(ctx, "VACUUM INTO ?", tmp); err != nil {
		return "", fmt.Errorf("vacuum into: %w", err)
	}
	if err := os.Rename(tmp, final); err != nil {
		return "", err
	}
	return final, b.prune()
}

func (b *Backups) prune() error {
	all, err := List(b.Dir)
	if err != nil {
		return err
	}
	for len(all) > b.Keep {
		if err := os.Remove(all[0]); err != nil {
			return err
		}
		all = all[1:]
	}
	return nil
}

// List returns the backups in a folder, oldest first (the names sort by time). A missing folder has none.
func List(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), backupPrefix) && strings.HasSuffix(e.Name(), backupSuffix) {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	sort.Strings(out)
	return out, nil
}

// Restore puts a backup in place of the database file. The write-ahead log and the shared memory file of the old
// database are removed first: replayed onto the restored file they would undo the restore.
func Restore(backup, dbFile string) error {
	if err := os.MkdirAll(filepath.Dir(dbFile), 0o755); err != nil {
		return err
	}
	// the copy comes first: a backup that cannot be read must leave the current database as it is
	tmp := dbFile + ".restore"
	if err := copyFile(backup, tmp); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(dbFile + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return os.Rename(tmp, dbFile)
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// NewEpoch is a random generation name for a vault. A restored database gives every vault a new one: devices that
// notice start over from what they hold (adding, never deleting), so whatever the copy was too old to know is put
// back by the devices.
func NewEpoch() string {
	b := make([]byte, 9)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// NewEpochs gives every vault a new epoch.
func NewEpochs(ctx context.Context, d *DB) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, "SELECT id FROM vaults")
		if err != nil {
			return err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, id := range ids {
			if _, err := tx.ExecContext(ctx, "UPDATE vaults SET epoch = ? WHERE id = ?", NewEpoch(), id); err != nil {
				return err
			}
		}
		return rows.Err()
	})
}

// Debouncer calls a function shortly after the last of a burst of triggers.
type Debouncer struct {
	delay time.Duration
	run   func(context.Context) error
	log   func(error)

	mu    sync.Mutex // guards timer
	timer *time.Timer
	busy  sync.Mutex // one run at a time
}

// NewDebouncer wraps run; errors are handed to log.
func NewDebouncer(delay time.Duration, run func(context.Context) error, log func(error)) *Debouncer {
	return &Debouncer{delay: delay, run: run, log: log}
}

// Trigger schedules a run unless one is already scheduled.
func (d *Debouncer) Trigger() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.timer == nil {
		d.timer = time.AfterFunc(d.delay, d.fire)
	}
}

func (d *Debouncer) fire() {
	d.mu.Lock()
	d.timer = nil
	d.mu.Unlock()
	d.exec(context.Background())
}

func (d *Debouncer) exec(ctx context.Context) {
	d.busy.Lock()
	defer d.busy.Unlock()
	if err := d.run(ctx); err != nil {
		d.log(err)
	}
}

// Flush runs what is scheduled right now (shutdown) and waits for a run that is in progress.
func (d *Debouncer) Flush(ctx context.Context) {
	d.mu.Lock()
	pending := d.timer != nil
	if pending {
		d.timer.Stop()
		d.timer = nil
	}
	d.mu.Unlock()
	if pending {
		d.exec(ctx)
		return
	}
	d.busy.Lock() // nothing scheduled: only wait for a run that has begun
	d.busy.Unlock()
}
