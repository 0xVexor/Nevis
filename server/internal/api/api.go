// Package api is the HTTP layer. Everything under /v1 except /health, /auth/challenge, /auth/register,
// /auth/login and /auth/recover needs `Authorization: Bearer <device token>`. Errors are `{"error": "<code>", ...}`
// with a fitting status.
package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"time"

	"github.com/0xVexor/Nevis/server/internal/apierr"
	"github.com/0xVexor/Nevis/server/internal/auth"
	"github.com/0xVexor/Nevis/server/internal/config"
	"github.com/0xVexor/Nevis/server/internal/hub"
	"github.com/0xVexor/Nevis/server/internal/vaults"
)

const (
	jsonLimit = 2 << 20  // a request body that is not a blob
	blobLimit = 16 << 20 // one upload request; bigger blobs arrive in pieces

	// The desktop client identifies this server by the name `nevis-sync` in /v1/health and sends its protocol
	// version in `X-Noviq-Api`. Those are part of the wire protocol, so they keep their names until the client moves.
	wireName         = "nevis-sync"
	legacyAPIHeader  = "X-Noviq-Api"
	currentAPIHeader = "X-Nevis-Api"
)

var bearer = regexp.MustCompile(`^Bearer (nvs_[A-Za-z0-9_-]{20,})$`)

// Deps is what the handlers work with.
type Deps struct {
	Cfg      config.Config
	Accounts *auth.Accounts
	Vaults   *vaults.Store
	Hub      *hub.Hub
	Now      func() time.Time
	// OnWrite is called after every change that should reach the backup.
	OnWrite func()
	Log     *slog.Logger
	// Timeouts are the per-request deadlines of uploads, downloads and long polls (zero fields: the defaults).
	Timeouts Timeouts
}

// Server answers the API.
type Server struct {
	Deps
	mux *http.ServeMux
}

// New builds the handler of the whole API.
func New(d Deps) http.Handler {
	d.Timeouts = d.Timeouts.withDefaults()
	s := &Server{Deps: d, mux: http.NewServeMux()}
	s.routes()
	return s.middleware(s.mux)
}

type handlerFunc func(w http.ResponseWriter, r *http.Request) error
type authedFunc func(w http.ResponseWriter, r *http.Request, p *auth.Principal) error

func (s *Server) route(pattern string, h handlerFunc) {
	s.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			s.fail(w, r, err)
		}
	})
}

// authed is a route that needs a signed-in device.
func (s *Server) authed(pattern string, h authedFunc) {
	s.route(pattern, func(w http.ResponseWriter, r *http.Request) error {
		m := bearer.FindStringSubmatch(r.Header.Get("Authorization"))
		if m == nil {
			return apierr.New(http.StatusUnauthorized, "unauthorized")
		}
		p, err := s.Accounts.Authenticate(r.Context(), m[1])
		if err != nil {
			return err
		}
		return h(w, r, p)
	})
}

func (s *Server) routes() {
	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { s.fail(w, r, apierr.New(404, "not_found")) })
	s.route("GET /{$}", func(w http.ResponseWriter, r *http.Request) error {
		w.Header().Set("Content-Type", "text/plain")
		_, err := io.WriteString(w, "nevis-sync")
		return err
	})
	s.route("GET /v1/health", s.health)
	s.accountRoutes()
	s.vaultRoutes()
	s.syncRoutes()
	s.blobRoutes()
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) error {
	writeJSON(w, 200, map[string]any{
		"ok": true, "name": wireName, "api": config.API, "min_api": config.MinAPI,
		"registration": s.Cfg.Registration, "pow_bits": s.Cfg.PowBits, "server_time": s.Now().UnixMilli(),
		"capabilities": []string{"database_sync", "page_state"},
	})
	return nil
}

// ───── middleware ─────

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := s.Now()
		rec := &recorder{ResponseWriter: w, status: 200}
		h := rec.Header()
		h.Set("Cache-Control", "no-store")
		h.Set(currentAPIHeader, strconv.Itoa(config.API))
		h.Set(legacyAPIHeader, strconv.Itoa(config.API))
		if tooOld(r) {
			writeJSON(rec, 426, map[string]any{"error": "upgrade_required", "min": config.MinAPI})
		} else {
			next.ServeHTTP(rec, r)
		}
		// the path only: no query (it can name a file) and never the Authorization header
		s.Log.Info("request", "method", r.Method, "path", r.URL.Path, "status", rec.status, "ms", s.Now().Sub(start).Milliseconds())
	})
}

func tooOld(r *http.Request) bool {
	v := r.Header.Get(currentAPIHeader)
	if v == "" {
		v = r.Header.Get(legacyAPIHeader)
	}
	n, err := strconv.Atoi(v)
	return err == nil && n < config.MinAPI
}

type recorder struct {
	http.ResponseWriter
	status int
}

func (r *recorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Unwrap lets http.ResponseController reach the real writer.
func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// ───── answers ─────

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// fail answers an error: the ones the domain code meant for the client as they are, anything else as a 500.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apierr.Error
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &ae):
		if ae.Code == "rate_limited" {
			w.Header().Set("Retry-After", strconv.Itoa(ae.Extra["retry"].(int)))
		}
		writeJSON(w, ae.Status, ae.Body())
	case errors.Is(err, os.ErrDeadlineExceeded):
		// the client was too slow sending the body: the connection is not worth keeping
		w.Header().Set("Connection", "close")
		writeJSON(w, http.StatusRequestTimeout, map[string]any{"error": "request_timeout"})
	case errors.As(err, &tooBig):
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "too_large"})
	default:
		s.Log.Error("unhandled error", "method", r.Method, "path", r.URL.Path, "err", err.Error())
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal"})
	}
}

// readJSON decodes a request body. An empty body is an empty object: several endpoints take no input.
func readJSON(w http.ResponseWriter, r *http.Request, into any) error {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, jsonLimit))
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, into); err != nil {
		return apierr.New(400, "bad_request")
	}
	return nil
}

// intParam reads an integer query parameter; ok is false when it is missing or not a number.
func intParam(r *http.Request, name string) (n int64, ok bool) {
	n, err := strconv.ParseInt(r.URL.Query().Get(name), 10, 64)
	return n, err == nil
}

func ok(w http.ResponseWriter) error {
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}
