// nevis-server: accounts, workspaces and the sync log.
//
//	DEV_MODE=1 DEV_TOKEN=dev REGISTRATION=open POW_BITS=8 PORT=8787 DATA_DIR=./data go run ./cmd/nevis-server
//	SESSION_SECRET=<32+ chars> REGISTRATION=invite INVITE_CODES=abc,def WEB_DIR=./web-dist ./nevis-server
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
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
	handler := api.New(st, api.Config{
		DevMode: devMode, DevToken: os.Getenv("DEV_TOKEN"), Secret: secret, Registration: reg, InviteCodes: invites, PowBits: bits,
		QuotaBytes: int64(quota) << 20, WebDir: os.Getenv("WEB_DIR"), InsecureCookies: insecure, Log: log,
	})
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
