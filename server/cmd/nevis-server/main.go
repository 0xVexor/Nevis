// nevis-server: accounts, workspaces and the sync log.
//
//	DEV_MODE=1 DEV_TOKEN=dev REGISTRATION=open POW_BITS=8 PORT=8787 DATA_DIR=./data go run ./cmd/nevis-server
//	SESSION_SECRET=<32+ chars> REGISTRATION=invite INVITE_CODES=abc,def WEB_DIR=./web-dist ./nevis-server
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/nevis-app/nevis/server/internal/api"
	"github.com/nevis-app/nevis/server/internal/store"
)

// backupKeep is how many daily backups of the database stay in DATA_DIR/backup (older ones are removed).
const backupKeep = 14

var version = "dev" // Set by the release build.

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	dataDir := env("DATA_DIR", "./data")
	if len(os.Args) > 1 && os.Args[1] == "backup" { // nevis-server backup [dir]: a consistent copy of the database NOW (safe while the server runs)
		dir := filepath.Join(dataDir, "backup")
		if len(os.Args) > 2 {
			dir = os.Args[2]
		}
		st, err := store.Open(dataDir)
		if err != nil {
			log.Error("open store", "err", err)
			os.Exit(1)
		}
		defer st.Close()
		path, err := st.Backup(context.Background(), dir)
		if err != nil {
			log.Error("backup", "err", err)
			os.Exit(1)
		}
		_, _ = store.PruneBackups(dir, backupKeep)
		fmt.Println(path)
		return
	}
	st, err := store.Open(dataDir)
	if err != nil {
		log.Error("open store", "err", err)
		os.Exit(1)
	}
	defer st.Close()
	devMode := os.Getenv("DEV_MODE") == "1"
	secret := os.Getenv("SESSION_SECRET")
	if !devMode && len(secret) < 32 {
		log.Error("SESSION_SECRET must be a random string of at least 32 characters (it signs the sign-up challenges)")
		os.Exit(1)
	}
	invites := map[string]bool{}
	for _, c := range strings.Split(os.Getenv("INVITE_CODES"), ",") {
		if c = strings.TrimSpace(c); c != "" {
			invites[c] = true
		}
	}
	reg := env("REGISTRATION", "invite")
	if reg == "invite" && len(invites) == 0 && !devMode {
		log.Error("REGISTRATION=invite needs INVITE_CODES (comma separated)")
		os.Exit(1)
	}
	if devMode && secret == "" {
		secret = "development-secret-development-secret"
	}
	// Safari (and iOS) refuse a Secure cookie on plain http, even on localhost: a local demo needs this switch; never set it on a real server.
	insecure := devMode || os.Getenv("INSECURE_COOKIES") == "1"
	if insecure && !devMode {
		log.Warn("INSECURE_COOKIES=1: the session cookie is sent over plain http; use only for a local demo")
	}
	bits, _ := strconv.Atoi(env("POW_BITS", "18"))
	quota, _ := strconv.Atoi(env("QUOTA_MB", "1024"))
	maxBlob, _ := strconv.Atoi(env("MAX_BLOB_MB", "100"))
	handler := api.New(st, api.Config{
		Version: version,
		DevMode: devMode, DevToken: os.Getenv("DEV_TOKEN"), Secret: secret, Registration: reg, InviteCodes: invites, PowBits: bits, SignupsPerHour: envInt("SIGNUPS_PER_HOUR"),
		QuotaBytes: int64(quota) << 20, DataDir: dataDir, MaxBlobBytes: int64(maxBlob) << 20, WebDir: os.Getenv("WEB_DIR"), InsecureCookies: insecure, Log: log,
	})
	go func() { // covered ops older than 30 days are removed; a backup of the database is taken first (once a day at most)
		pruneCtx := context.Background()
		var lastBackup time.Time
		for first := true; ; time.Sleep(time.Hour) { // the first round runs at once: a new server has a backup in its first minutes
			_ = first
			first = false
			if time.Since(lastBackup) > 24*time.Hour {
				if path, err := st.Backup(pruneCtx, filepath.Join(dataDir, "backup")); err != nil {
					log.Error("backup before pruning failed: nothing is pruned", "err", err)
					continue
				} else {
					lastBackup = time.Now()
					log.Info("backup", "path", path)
					if n, err := store.PruneBackups(filepath.Join(dataDir, "backup"), backupKeep); err != nil {
						log.Error("old backups", "err", err)
					} else if n > 0 {
						log.Info("old backups removed", "n", n, "kept", backupKeep)
					}
				}
			}
			if n, err := st.Prune(pruneCtx); err != nil {
				log.Error("prune", "err", err)
			} else if n > 0 {
				log.Info("prune", "removed", n)
			}
		}
	}()
	gcCtx, stopGC := context.WithCancel(context.Background())
	defer stopGC()
	go func() { // attachments nobody refers to for 30 days (store.BlobGraceMs) are removed; a referenced one never is
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			if n, err := api.CollectBlobs(gcCtx, st, dataDir); err != nil {
				log.Error("blob gc", "err", err)
			} else if n > 0 {
				log.Info("blob gc", "removed", n)
			}
			select {
			case <-t.C:
			case <-gcCtx.Done():
				return
			}
		}
	}()
	addr := net.JoinHostPort(env("LISTEN_HOST", "127.0.0.1"), env("PORT", "8787"))
	srv := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second, WriteTimeout: 60 * time.Second}
	go func() {
		log.Info("listening", "addr", addr, "devMode", devMode)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("serve", "err", err)
			os.Exit(1)
		}
	}()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
}

// envInt reads a non-negative integer setting; unset or invalid means 0 (the default).
func envInt(name string) int {
	n, err := strconv.Atoi(os.Getenv(name))
	if err != nil || n < 0 {
		return 0
	}
	return n
}
