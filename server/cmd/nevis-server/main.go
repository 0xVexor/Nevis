// nevis-server: the sync log server (M2: push/pull with a development token).
//
//	DEV_MODE=1 DEV_TOKEN=dev PORT=8787 DATA_DIR=./data go run ./cmd/nevis-server
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nevis-app/nevis/server/internal/api"
	"github.com/nevis-app/nevis/server/internal/store"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	st, err := store.Open(env("DATA_DIR", "./data"))
	if err != nil {
		log.Error("open store", "err", err)
		os.Exit(1)
	}
	defer st.Close()
	devMode := os.Getenv("DEV_MODE") == "1"
	handler := api.New(st, api.Config{DevMode: devMode, DevToken: os.Getenv("DEV_TOKEN"), Log: log})
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
