// Command nevis-server is the sync server of Nevis: accounts, per-vault revisions, content-addressed blobs on disk
// and instant change notification, as one self-contained binary. Everything is configured by environment
// variables, see ../../README.md.
//
//	nevis-server                  run the server
//	nevis-server restore [file]   put a backup in place of the database (the newest one by default)
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
	"syscall"
	"time"

	"github.com/0xVexor/Nevis/server/internal/api"
	"github.com/0xVexor/Nevis/server/internal/auth"
	"github.com/0xVexor/Nevis/server/internal/config"
	"github.com/0xVexor/Nevis/server/internal/db"
	"github.com/0xVexor/Nevis/server/internal/hub"
	"github.com/0xVexor/Nevis/server/internal/storage"
	"github.com/0xVexor/Nevis/server/internal/vaults"
)

const (
	dbName          = "nevis.db"
	housekeepingAt  = time.Minute // the first run after start; then every hour
	shutdownTimeout = 30 * time.Second
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, problems := config.Load(os.Getenv)
	if len(os.Args) > 1 && os.Args[1] == "restore" {
		fail(log, restoreCommand(cfg, os.Args[2:]))
		return
	}
	if len(problems) > 0 {
		for _, p := range problems {
			fmt.Fprintln(os.Stderr, "config:", p)
		}
		os.Exit(1)
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	fail(log, err)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	fail(log, run(ctx, cfg, log, ln))
}

func fail(log *slog.Logger, err error) {
	if err != nil {
		log.Error("fatal", "err", err.Error())
		os.Exit(1)
	}
}

// restoreCommand replaces the database with a backup. The server must be stopped: the lock makes sure.
func restoreCommand(cfg config.Config, args []string) error {
	lock, err := storage.Acquire(cfg.DataDir)
	if err != nil {
		return err
	}
	defer lock.Release()
	file := ""
	if len(args) > 0 {
		file = args[0]
	} else if all, err := db.List(backupDir(cfg)); err != nil || len(all) == 0 {
		return errors.Join(err, errors.New("no backup to restore in "+backupDir(cfg)))
	} else {
		file = all[len(all)-1]
	}
	if err := restoreFrom(context.Background(), file, filepath.Join(cfg.DataDir, dbName)); err != nil {
		return err
	}
	fmt.Println("restored", file, "- every vault has a new epoch")
	return nil
}

func backupDir(cfg config.Config) string { return filepath.Join(cfg.DataDir, "backup") }

// restoreFrom puts the backup in place and gives every vault a new epoch: nobody may believe the old numbering
// still holds.
func restoreFrom(ctx context.Context, backup, dbFile string) error {
	if err := db.Restore(backup, dbFile); err != nil {
		return err
	}
	d, err := db.Open(dbFile)
	if err != nil {
		return err
	}
	defer d.Close()
	return db.NewEpochs(ctx, d)
}

// openDatabase opens the database. When the file is missing but backups exist (a lost disk, a new machine with the
// backup folder copied over) the newest backup is restored first.
func openDatabase(ctx context.Context, cfg config.Config, log *slog.Logger) (*db.DB, error) {
	file := filepath.Join(cfg.DataDir, dbName)
	if _, err := os.Stat(file); errors.Is(err, os.ErrNotExist) {
		if all, _ := db.List(backupDir(cfg)); len(all) > 0 {
			log.Warn("no database: restoring the newest backup, every vault gets a new epoch", "backup", all[len(all)-1])
			if err := restoreFrom(ctx, all[len(all)-1], file); err != nil {
				return nil, err
			}
		}
	}
	return db.Open(file)
}

// run serves on ln until ctx ends, then shuts down in order: waiting long polls are released, running requests
// finish, the last writes reach a backup, the database closes, the lock is let go.
func run(ctx context.Context, cfg config.Config, log *slog.Logger, ln net.Listener) error {
	if cfg.Lock {
		lock, err := storage.Acquire(cfg.DataDir)
		if err != nil {
			return err
		}
		defer lock.Release()
	}
	database, err := openDatabase(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer database.Close()
	blobs, err := storage.NewBlobs(cfg.DataDir)
	if err != nil {
		return err
	}

	now := time.Now
	limiter := auth.NewLimiter(now)
	accounts := &auth.Accounts{DB: database, Cfg: cfg, Now: now, Limiter: limiter, Cost: auth.DefaultCost}
	store := &vaults.Store{DB: database, Blobs: blobs, Cfg: cfg, Now: now}
	notifier := hub.New()
	backups := &db.Backups{DB: database, Dir: backupDir(cfg), Keep: cfg.BackupKeep, Now: now}
	debounce := db.NewDebouncer(cfg.BackupDelay, func(ctx context.Context) error {
		path, err := backups.Snapshot(ctx)
		if err == nil {
			log.Info("backup written", "file", path)
		}
		return err
	}, func(err error) { log.Error("backup failed", "err", err.Error()) })

	srv := &http.Server{
		Handler: api.New(api.Deps{Cfg: cfg, Accounts: accounts, Vaults: store, Hub: notifier, Now: now, OnWrite: debounce.Trigger, Log: log}),
		// no read or write timeout: a long poll is held open on purpose and an upload may be slow
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       65 * time.Second,
	}
	background, cancelBackground := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		maintain(background, log, store, limiter)
	}()

	log.Info("listening", "addr", ln.Addr().String(), "data", cfg.DataDir)
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()

	select {
	case err = <-served:
	case <-ctx.Done():
		log.Info("stopping")
		notifier.ReleaseAll() // a held long poll would otherwise keep the shutdown waiting
		grace, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		err = srv.Shutdown(grace)
		cancel()
	}
	cancelBackground()
	<-done
	debounce.Flush(context.Background()) // the last writes reach a backup before the process goes away
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return err
}

// maintain runs housekeeping hourly and forgets expired rate limit windows.
func maintain(ctx context.Context, log *slog.Logger, store *vaults.Store, limiter *auth.Limiter) {
	sweep := time.NewTicker(5 * time.Minute)
	defer sweep.Stop()
	gc := time.NewTimer(housekeepingAt)
	defer gc.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-sweep.C:
			limiter.Sweep()
		case <-gc.C:
			stats, err := store.Housekeeping(ctx, time.Now())
			if err != nil {
				log.Error("housekeeping failed", "err", err.Error())
			} else {
				log.Info("housekeeping done", "removed", stats)
			}
			gc.Reset(time.Hour)
		}
	}
}
