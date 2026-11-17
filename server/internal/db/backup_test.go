package db

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestListIsOldestFirstAndIgnoresOtherFiles(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"nevis-20261025T102000Z.db", "nevis-20261024T090000Z.db", "nevis-20261026T000000Z.db", "notes.txt", "nevis-20261027T000000Z.db.tmp"} {
		if err := os.WriteFile(filepath.Join(dir, n), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := List(dir)
	if err != nil || len(got) != 3 {
		t.Fatalf("%v %v", got, err)
	}
	if filepath.Base(got[0]) != "nevis-20261024T090000Z.db" || filepath.Base(got[2]) != "nevis-20261026T000000Z.db" {
		t.Fatalf("order: %v", got)
	}
	if none, err := List(filepath.Join(dir, "missing")); err != nil || len(none) != 0 {
		t.Fatalf("a missing folder has no backups: %v %v", none, err)
	}
}

func TestRestoreReplacesTheDatabaseAndDropsItsLog(t *testing.T) {
	dir := t.TempDir()
	backup, target := filepath.Join(dir, "backup.db"), filepath.Join(dir, "data", "nevis.db")
	write := func(name, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(backup, "the backup")
	write(target, "the old database")
	write(target+"-wal", "log of the old database")
	write(target+"-shm", "shared memory of the old database")

	if err := Restore(backup, target); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(target); string(got) != "the backup" {
		t.Fatalf("database is %q", got)
	}
	for _, leftover := range []string{target + "-wal", target + "-shm", target + ".restore"} {
		if _, err := os.Stat(leftover); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s was left behind (it would be replayed onto the restored file)", leftover)
		}
	}
	if err := Restore(filepath.Join(dir, "nope.db"), target); err == nil {
		t.Fatal("restoring from a missing file must fail")
	}
	if got, _ := os.ReadFile(target); string(got) != "the backup" {
		t.Fatal("a failed restore must not damage the database")
	}
}

func TestEpochsAreRandomAndURLSafe(t *testing.T) {
	a, b := NewEpoch(), NewEpoch()
	if a == b || len(a) != 12 {
		t.Fatalf("%q %q", a, b)
	}
}

func TestDebouncerRunsOnceAfterABurst(t *testing.T) {
	var runs atomic.Int32
	d := NewDebouncer(40*time.Millisecond, func(context.Context) error { runs.Add(1); return nil }, func(error) {})
	for range 10 {
		d.Trigger()
		time.Sleep(2 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)
	if runs.Load() != 1 {
		t.Fatalf("%d runs for one burst", runs.Load())
	}
	d.Trigger()
	time.Sleep(200 * time.Millisecond)
	if runs.Load() != 2 {
		t.Fatalf("%d runs after a second burst", runs.Load())
	}
}

func TestDebouncerFlushRunsWhatIsScheduledAndNothingElse(t *testing.T) {
	var runs atomic.Int32
	d := NewDebouncer(time.Hour, func(context.Context) error { runs.Add(1); return nil }, func(error) {})
	d.Flush(context.Background())
	if runs.Load() != 0 {
		t.Fatal("flush ran with nothing scheduled")
	}
	d.Trigger()
	d.Flush(context.Background())
	if runs.Load() != 1 {
		t.Fatalf("flush must run the scheduled backup now (%d)", runs.Load())
	}
	d.Flush(context.Background())
	if runs.Load() != 1 {
		t.Fatal("the scheduled run must not happen twice")
	}
}

func TestDebouncerReportsErrors(t *testing.T) {
	failed := make(chan error, 1)
	boom := errors.New("disk full")
	d := NewDebouncer(time.Millisecond, func(context.Context) error { return boom }, func(err error) { failed <- err })
	d.Trigger()
	select {
	case err := <-failed:
		if !errors.Is(err, boom) {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the error was not reported")
	}
}
