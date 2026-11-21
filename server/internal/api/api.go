// Package api is the HTTP surface of the server (ADR-0005, ADR-0006): accounts and sessions, workspaces and devices, the log
// (push, pull with long-poll), and the web app itself from the same origin.
package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/nevis-app/nevis/server/internal/apierr"
	"github.com/nevis-app/nevis/server/internal/auth"
	"github.com/nevis-app/nevis/server/internal/store"
)

const (
	// MinProto is the lowest `Nevis-Proto` this server speaks; Proto is the one it answers with.
	MinProto = 1
	Proto    = 1

	maxBatchOps   = 500
	maxBatchBytes = 4 << 20
	maxPullLimit  = 1000
	maxWait       = 25
)

type Config struct {
	// DevMode turns on the development bearer token (DevToken) and the creation of a workspace by its first push. Never in production.
	DevMode  bool
	DevToken string

	// Secret signs the sign-up challenges.
	Secret string
	// Registration: "open", "invite" or "closed". InviteCodes are the accepted codes when "invite".
	Registration string
	InviteCodes  map[string]bool
	// PowBits is the difficulty of the sign-up proof of work (0 = off).
	PowBits int
	// SignupsPerHour limits sign-ups from one address (0 = the default, 30). Raised only for automated test runs.
	SignupsPerHour int
	// QuotaBytes is the storage limit per account (0 = none).
	QuotaBytes int64
	// WebDir, when set, is the built web app, served from this origin under a strict Content-Security-Policy.
	WebDir string
	// InsecureCookies lets the session cookie travel over plain http (development on localhost only).
	InsecureCookies bool
	// Cost is the scrypt cost of password hashes (tests use a cheap one).
	Cost auth.Cost

	Now func() time.Time
	Log *slog.Logger
}

type Server struct {
	Config
	st      *store.Store
	mux     *http.ServeMux
	limiter *auth.Limiter
}

func New(st *store.Store, cfg Config) http.Handler {
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Cost == (auth.Cost{}) {
		cfg.Cost = auth.DefaultCost
	}
	s := &Server{Config: cfg, st: st, mux: http.NewServeMux(), limiter: auth.NewLimiter(cfg.Now)}
	s.routes()
	return s.middleware(s.mux)
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /v1/health", s.health)
	s.mux.HandleFunc("GET /v1/auth/challenge", s.challenge)
	s.mux.HandleFunc("POST /v1/auth/signup", s.signup)
	s.mux.HandleFunc("POST /v1/auth/signin", s.signin)
	s.mux.HandleFunc("POST /v1/auth/recover", s.recoverAccount)
	s.mux.HandleFunc("POST /v1/auth/signout", s.authed(s.signout))
	s.mux.HandleFunc("GET /v1/me", s.authed(s.me))
	s.mux.HandleFunc("GET /v1/ws", s.authed(s.listWorkspaces))
	s.mux.HandleFunc("POST /v1/ws", s.authed(s.createWorkspace))
	s.mux.HandleFunc("GET /v1/devices", s.authed(s.listDevices))
	s.mux.HandleFunc("DELETE /v1/devices/{id}", s.authed(s.revokeDevice))
	s.mux.HandleFunc("POST /v1/ws/{ws}/ops", s.authed(s.push))
	s.mux.HandleFunc("GET /v1/ws/{ws}/ops", s.authed(s.pull))
	if s.WebDir != "" {
		s.mux.HandleFunc("/", s.webApp)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		status, b = 500, []byte(`{"error":{"code":"internal","message":"encoding failed","retryable":true}}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

type apiError struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Retryable bool           `json:"retryable"`
	Extra     map[string]any `json:"-"`
}

// fail answers `{"error":{"code","message","retryable", ...extra}}` (ADR-0005).
func fail(w http.ResponseWriter, status int, code, msg string, retryable bool, extra ...map[string]any) {
	body := map[string]any{"code": code, "message": msg, "retryable": retryable}
	for _, e := range extra {
		for k, v := range e {
			body[k] = v
		}
	}
	if status == 429 {
		if r, ok := body["retry"].(int); ok {
			w.Header().Set("Retry-After", itoa(r))
		}
	}
	writeJSON(w, status, map[string]any{"error": body})
}

func failErr(w http.ResponseWriter, e *apierr.Error) {
	extra := map[string]any{}
	for k, v := range e.Extra {
		extra[k] = v
	}
	fail(w, e.Status, e.Code, e.Code, e.Status == 429 || e.Status >= 500, extra)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "name": "nevis", "proto": Proto, "minProto": MinProto, "registration": s.registration(), "powBits": s.PowBits})
}

func (s *Server) registration() string {
	if s.Registration == "" {
		return "closed"
	}
	return s.Registration
}
