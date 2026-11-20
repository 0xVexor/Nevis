// Package api is the HTTP surface of the log (ADR-0005). M2 has the push and pull routes and a development token; accounts,
// sessions and long-poll come in M4.
package api

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/nevis-app/nevis/server/internal/envelope"
	"github.com/nevis-app/nevis/server/internal/store"
)

const (
	maxBatchOps   = 500
	maxBatchBytes = 4 << 20
	maxPullLimit  = 1000
)

type Config struct {
	// DevMode turns on the development bearer token and the creation of a workspace by its first push.
	DevMode  bool
	DevToken string
	Log      *slog.Logger
}

type Server struct {
	Config
	st  *store.Store
	mux *http.ServeMux
}

func New(st *store.Store, cfg Config) http.Handler {
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	s := &Server{Config: cfg, st: st, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /v1/health", s.health)
	s.mux.HandleFunc("POST /v1/ws/{ws}/ops", s.auth(s.push))
	s.mux.HandleFunc("GET /v1/ws/{ws}/ops", s.auth(s.pull))
	return s.mux
}

type apiError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
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

func fail(w http.ResponseWriter, status int, code, msg string, retryable bool) {
	writeJSON(w, status, map[string]any{"error": apiError{Code: code, Message: msg, Retryable: retryable}})
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "name": "nevis", "proto": 1})
}

// auth: in M2 only the development token exists.
func (s *Server) auth(next func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.DevMode || s.DevToken == "" {
			fail(w, 503, "no_auth", "accounts are not implemented yet; start with DEV_MODE=1 and DEV_TOKEN", false)
			return
		}
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(tok), []byte(s.DevToken)) != 1 {
			fail(w, 401, "unauthorized", "bad token", false)
			return
		}
		next(w, r, "dev")
	}
}

func (s *Server) push(w http.ResponseWriter, r *http.Request, by string) {
	ws := r.PathValue("ws")
	if !envelope.ValidWorkspace(ws) {
		fail(w, 400, "bad_envelope", "workspace id is not a UUID", false)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBatchBytes))
	if err != nil {
		fail(w, 413, "too_large", "batch larger than 4 MB", false)
		return
	}
	var req struct {
		Ops []json.RawMessage `json:"ops"`
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil || req.Ops == nil {
		fail(w, 400, "bad_envelope", "body must be {\"ops\":[...]}", false)
		return
	}
	if len(req.Ops) > maxBatchOps {
		fail(w, 400, "bad_envelope", "more than 500 ops in one batch", false)
		return
	}
	envs := make([]*envelope.Envelope, 0, len(req.Ops))
	for i, raw := range req.Ops {
		e, err := envelope.Parse(raw)
		if err != nil {
			fail(w, 400, "bad_envelope", "op "+strconv.Itoa(i)+": "+err.Error(), false)
			return
		}
		if e.WS != ws {
			fail(w, 400, "bad_envelope", "op "+strconv.Itoa(i)+": ws does not match the URL", false)
			return
		}
		envs = append(envs, e)
	}
	res, head, err := s.st.Push(r.Context(), ws, by, envs, s.DevMode)
	switch {
	case err == nil:
		writeJSON(w, 200, map[string]any{"results": res, "head": head})
	case errors.Is(err, store.ErrOpConflict):
		fail(w, 409, "op_conflict", "an op id was sent again with different bytes", false)
	case errors.Is(err, store.ErrClockAhead):
		fail(w, 422, "clock_ahead", "the device clock is more than 10 minutes ahead of the server", false)
	case errors.Is(err, store.ErrNoWorkspace):
		fail(w, 404, "no_such_workspace", "no such workspace", false)
	default:
		s.Log.Error("push", "err", err)
		fail(w, 500, "internal", "storing the batch failed", true)
	}
}

type pullOp struct {
	Seq int64           `json:"seq"`
	By  string          `json:"by"`
	RT  int64           `json:"rt"`
	Env json.RawMessage `json:"env"`
}

func (s *Server) pull(w http.ResponseWriter, r *http.Request, _ string) {
	ws := r.PathValue("ws")
	if !envelope.ValidWorkspace(ws) {
		fail(w, 400, "bad_request", "workspace id is not a UUID", false)
		return
	}
	q := r.URL.Query()
	after, err := strconv.ParseInt(q.Get("after"), 10, 64)
	if q.Get("after") == "" {
		after, err = 0, nil
	}
	if err != nil || after < 0 {
		fail(w, 400, "bad_request", "after must be a non-negative integer", false)
		return
	}
	limit := 500
	if l := q.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 {
			fail(w, 400, "bad_request", "limit must be a positive integer", false)
			return
		}
		limit = min(n, maxPullLimit)
	}
	ops, head, more, err := s.st.Pull(r.Context(), ws, after, limit, s.DevMode)
	switch {
	case err == nil:
		out := make([]pullOp, len(ops))
		for i, o := range ops {
			out[i] = pullOp{Seq: o.Seq, By: o.By, RT: o.RT, Env: json.RawMessage(o.Env)}
		}
		writeJSON(w, 200, map[string]any{"ops": out, "head": head, "more": more})
	case errors.Is(err, store.ErrNoWorkspace):
		fail(w, 404, "no_such_workspace", "no such workspace", false)
	default:
		s.Log.Error("pull", "err", err)
		fail(w, 500, "internal", "reading the log failed", true)
	}
}
