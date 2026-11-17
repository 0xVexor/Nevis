package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0xVexor/Nevis/server/internal/config"
	"github.com/0xVexor/Nevis/server/internal/db"
	"github.com/0xVexor/Nevis/server/internal/storage"
)

type body map[string]any

func (b body) str(k string) string { s, _ := b[k].(string); return s }

func testCfg(t *testing.T, dir string) config.Config {
	t.Helper()
	env := map[string]string{
		"SESSION_SECRET": strings.Repeat("k", 40), "REGISTRATION": "open", "POW_BITS": "0",
		"DATA_DIR": dir, "BACKUP_DELAY_SEC": "3600", // the backup is taken at shutdown, not by the timer
	}
	cfg, problems := config.Load(func(k string) string { return env[k] })
	if len(problems) > 0 {
		t.Fatal(problems)
	}
	return cfg
}

// server is a real instance of run on a local port.
type server struct {
	base   string
	cancel context.CancelFunc
	done   chan error
}

func start(t *testing.T, cfg config.Config) *server {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &server{base: "http://" + ln.Addr().String(), cancel: cancel, done: make(chan error, 1)}
	go func() { s.done <- run(ctx, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), ln) }()
	t.Cleanup(func() { cancel() })
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if resp, err := http.Get(s.base + "/v1/health"); err == nil {
			resp.Body.Close()
			return s
		}
		select {
		case err := <-s.done:
			t.Fatalf("the server stopped while starting: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("the server did not come up")
		}
	}
}

func (s *server) stop(t *testing.T) error {
	t.Helper()
	s.cancel()
	select {
	case err := <-s.done:
		return err
	case <-time.After(15 * time.Second):
		t.Fatal("the server did not stop")
		return nil
	}
}

func (s *server) call(t *testing.T, method, path, token string, in any, headers ...string) (int, body) {
	t.Helper()
	var r io.Reader
	if raw, ok := in.([]byte); ok {
		r = bytes.NewReader(raw)
	} else if in != nil {
		b, _ := json.Marshal(in)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, s.base+path, r)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out body
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// account registers alice, creates a vault and commits one file; it returns the token, the vault id and its epoch.
func (s *server) account(t *testing.T) (token, vault, epoch string) {
	t.Helper()
	status, reg := s.call(t, "POST", "/v1/auth/register", "", body{"username": "alice", "password": "correct horse battery"})
	if status != 201 {
		t.Fatalf("register: %d %v", status, reg)
	}
	token = reg.str("token")
	vault = "11111111-1111-4111-8111-111111111111"
	if status, b := s.call(t, "POST", "/v1/vaults", token, body{"id": vault, "name": "notes"}); status != 201 {
		t.Fatalf("vault: %d %v", status, b)
	}
	sum := sha256.Sum256([]byte("kept"))
	blob := hex.EncodeToString(sum[:])
	if status, b := s.call(t, "PUT", "/v1/vaults/"+vault+"/blobs/"+blob, token, []byte("kept")); status != 201 {
		t.Fatalf("blob: %d %v", status, b)
	}
	commit := body{"op_id": "first-commit-1", "ops": []body{{"op": "put", "path": "pages/a.json", "sha256": blob, "base_rev": 0}}}
	if status, b := s.call(t, "POST", "/v1/vaults/"+vault+"/commit", token, commit); status != 200 {
		t.Fatalf("commit: %d %v", status, b)
	}
	_, st := s.call(t, "GET", "/v1/vaults/"+vault+"/state", token, nil)
	return token, vault, st.str("epoch")
}

func TestShutdownFinishesLongPollsAndTakesALastBackup(t *testing.T) {
	dir := t.TempDir()
	cfg := testCfg(t, dir)
	s := start(t, cfg)
	token, vault, _ := s.account(t)

	type answer struct {
		status int
		b      body
	}
	poll := make(chan answer, 1)
	go func() {
		req, _ := http.NewRequest("GET", s.base+"/v1/vaults/"+vault+"/state?since=1&wait=25", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			poll <- answer{status: -1}
			return
		}
		defer resp.Body.Close()
		var b body
		_ = json.NewDecoder(resp.Body).Decode(&b)
		poll <- answer{resp.StatusCode, b}
	}()
	time.Sleep(300 * time.Millisecond) // the poll is open

	began := time.Now()
	if err := s.stop(t); err != nil {
		t.Fatalf("run returned %v", err)
	}
	select {
	case a := <-poll:
		if a.status != 200 || time.Since(began) > 5*time.Second {
			t.Fatalf("the long poll got %d after %v", a.status, time.Since(began))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the long poll was never answered")
	}
	if backups, _ := db.List(filepath.Join(dir, "backup")); len(backups) != 1 {
		t.Fatalf("expected one backup written at shutdown, got %v", backups)
	}
	lock, err := storage.Acquire(dir)
	if err != nil {
		t.Fatalf("the lock was not released: %v", err)
	}
	lock.Release()
}

func TestASecondServerOnTheSameDataDirectoryRefusesToStart(t *testing.T) {
	dir := t.TempDir()
	cfg := testCfg(t, dir)
	first := start(t, cfg)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	err := run(context.Background(), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), ln)
	if !errors.Is(err, storage.ErrLocked) {
		t.Fatalf("got %v", err)
	}
	first.stop(t)
}

func TestInstanceLockCanBeSwitchedOff(t *testing.T) {
	dir := t.TempDir()
	cfg := testCfg(t, dir)
	cfg.Lock = false
	held, err := storage.Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	s := start(t, cfg) // INSTANCE_LOCK=off: it does not look at the lock
	if err := s.stop(t); err != nil {
		t.Fatal(err)
	}
}

func TestAMissingDatabaseIsRestoredFromTheNewestBackupWithNewEpochs(t *testing.T) {
	dir := t.TempDir()
	cfg := testCfg(t, dir)
	first := start(t, cfg)
	token, vault, epoch := first.account(t)
	if err := first.stop(t); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"nevis.db", "nevis.db-wal", "nevis.db-shm"} { // the disk was lost
		os.Remove(filepath.Join(dir, name))
	}

	second := start(t, cfg)
	defer second.stop(t)
	status, st := second.call(t, "GET", "/v1/vaults/"+vault+"/state", token, nil)
	if status != 200 {
		t.Fatalf("the account did not come back: %d %v", status, st)
	}
	if st.str("epoch") == "" || st.str("epoch") == epoch {
		t.Fatalf("the epoch must change after a restore (was %q, is %q)", epoch, st.str("epoch"))
	}
	if files, _ := st["files"].(float64); files != 1 {
		t.Fatalf("%v", st)
	}
}

func TestAnExistingDatabaseIsNeverReplacedByABackup(t *testing.T) {
	dir := t.TempDir()
	cfg := testCfg(t, dir)
	first := start(t, cfg)
	token, vault, epoch := first.account(t)
	if err := first.stop(t); err != nil {
		t.Fatal(err)
	}
	second := start(t, cfg)
	defer second.stop(t)
	if _, st := second.call(t, "GET", "/v1/vaults/"+vault+"/state", token, nil); st.str("epoch") != epoch {
		t.Fatalf("a normal restart changed the epoch: %q -> %q", epoch, st.str("epoch"))
	}
}

func TestRestoreCommandPutsABackupInPlaceWithNewEpochs(t *testing.T) {
	dir := t.TempDir()
	cfg := testCfg(t, dir)
	first := start(t, cfg)
	token, vault, epoch := first.account(t)
	if err := first.stop(t); err != nil {
		t.Fatal(err)
	}
	if err := restoreCommand(cfg, nil); err != nil {
		t.Fatal(err)
	}
	second := start(t, cfg)
	defer second.stop(t)
	_, st := second.call(t, "GET", "/v1/vaults/"+vault+"/state", token, nil)
	if st.str("epoch") == "" || st.str("epoch") == epoch {
		t.Fatalf("epoch %q (was %q)", st.str("epoch"), epoch)
	}
}

func TestRestoreCommandNeedsTheServerStoppedAndABackup(t *testing.T) {
	dir := t.TempDir()
	cfg := testCfg(t, dir)
	if err := restoreCommand(cfg, nil); err == nil {
		t.Fatal("restoring without any backup must fail")
	}
	held, err := storage.Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	if err := restoreCommand(cfg, []string{filepath.Join(dir, "x.db")}); !errors.Is(err, storage.ErrLocked) {
		t.Fatalf("a running server must block a restore: %v", err)
	}
}
