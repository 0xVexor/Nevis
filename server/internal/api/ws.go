package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/nevis-app/nevis/server/internal/apierr"
	"github.com/nevis-app/nevis/server/internal/auth"
	"github.com/nevis-app/nevis/server/internal/envelope"
	"github.com/nevis-app/nevis/server/internal/store"
)

func (s *Server) listWorkspaces(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	if p.Dev {
		writeJSON(w, 200, map[string]any{"workspaces": []any{}})
		return
	}
	list, err := s.st.Workspaces(r.Context(), p.AccountID)
	if err != nil {
		fail(w, 500, "internal", "could not list workspaces", true)
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, x := range list {
		out = append(out, map[string]any{"id": x.ID, "name": x.Name, "role": x.Role, "head": x.Head, "minSv": x.MinSV, "createdAt": x.CreatedAt})
	}
	writeJSON(w, 200, map[string]any{"workspaces": out})
}

func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	if p.Dev {
		fail(w, 400, "bad_request", "the development token has no account; push to a new workspace instead", false)
		return
	}
	var in struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	id := in.ID
	if id == "" {
		id = auth.NewID()
	} else if !envelope.ValidWorkspace(id) {
		fail(w, 400, "bad_request", "id must be a UUID", false)
		return
	}
	name := strings.TrimSpace(clip(in.Name, 80))
	if name == "" {
		name = "Workspace"
	}
	if err := s.st.CreateWorkspace(r.Context(), p.AccountID, id, name); err != nil {
		switch {
		case errors.Is(err, store.ErrWorkspaceExists):
			fail(w, 409, "workspace_exists", "a workspace with this id exists", false)
		case errors.Is(err, store.ErrTooManyWorkspaces):
			fail(w, 409, "too_many_workspaces", "the limit of workspaces per account is reached", false)
		default:
			fail(w, 500, "internal", "could not create the workspace", true)
		}
		return
	}
	writeJSON(w, 201, map[string]any{"id": id, "name": name, "role": "owner", "head": 0})
}

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	if p.Dev {
		writeJSON(w, 200, map[string]any{"devices": []any{}})
		return
	}
	list, err := s.st.Devices(r.Context(), p.AccountID)
	if err != nil {
		fail(w, 500, "internal", "could not list devices", true)
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, d := range list {
		out = append(out, map[string]any{"id": d.ID, "name": d.Name, "kind": d.Kind, "createdAt": d.CreatedAt, "lastSeen": d.LastSeen, "current": d.ID == p.DeviceID})
	}
	writeJSON(w, 200, map[string]any{"devices": out})
}

func (s *Server) revokeDevice(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	if p.Dev {
		fail(w, 400, "bad_request", "the development token has no devices", false)
		return
	}
	ok, err := s.st.RevokeDevice(r.Context(), p.AccountID, r.PathValue("id"))
	if err != nil {
		fail(w, 500, "internal", "could not remove the device", true)
		return
	}
	if !ok {
		fail(w, 404, "no_such_device", "no such device", false)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// member checks that the caller may use the workspace; a stranger gets 404, not 403, so that the workspace's existence is not revealed.
func (s *Server) member(w http.ResponseWriter, r *http.Request, p *store.Principal, ws string, write bool) bool {
	if !envelope.ValidWorkspace(ws) {
		fail(w, 400, "bad_request", "workspace id is not a UUID", false)
		return false
	}
	if p.Dev {
		return true
	}
	role, err := s.st.Role(r.Context(), p.AccountID, ws)
	if err != nil {
		fail(w, 500, "internal", "could not check membership", true)
		return false
	}
	if role == "" {
		fail(w, 404, "no_such_workspace", "no such workspace", false)
		return false
	}
	if write && role == "viewer" {
		fail(w, 403, "forbidden", "viewers cannot write", false)
		return false
	}
	return true
}

func (s *Server) push(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	ws := r.PathValue("ws")
	if !s.member(w, r, p, ws, true) {
		return
	}
	key := "push:" + p.AccountID + p.Username
	// The development token is a test harness (DEV_MODE only): thousands of pushes in a minute are its normal load.
	if ok, retry := s.limiter.Hit(key, 3000, time.Minute); !ok && !p.Dev {
		failErr(w, apierr.RateLimited(retry))
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
	opts := store.PushOptions{Create: p.Dev && s.DevMode}
	if !p.Dev {
		opts.AccountID, opts.QuotaBytes = p.AccountID, s.QuotaBytes
	}
	by := p.AccountID
	if p.Dev {
		by = "dev"
	}
	res, head, err := s.st.Push(r.Context(), ws, by, envs, opts)
	var sv *store.SvError
	switch {
	case err == nil:
		writeJSON(w, 200, map[string]any{"results": res, "head": head})
	case errors.Is(err, store.ErrOpConflict):
		fail(w, 409, "op_conflict", "an op id was sent again with different bytes", false)
	case errors.Is(err, store.ErrClockAhead):
		fail(w, 422, "clock_ahead", "the device clock is more than 10 minutes ahead of the server", false)
	case errors.Is(err, store.ErrNoWorkspace):
		fail(w, 404, "no_such_workspace", "no such workspace", false)
	case errors.Is(err, store.ErrQuota):
		fail(w, 507, "quota_exceeded", "the storage of this account is full", false)
	case errors.As(err, &sv):
		fail(w, 426, "upgrade_required", "this app is too old to write to this workspace", false, map[string]any{"minSv": sv.MinSV})
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

func (s *Server) pull(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	ws := r.PathValue("ws")
	if !s.member(w, r, p, ws, false) {
		return
	}
	q := r.URL.Query()
	after := int64(0)
	if v := q.Get("after"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			fail(w, 400, "bad_request", "after must be a non-negative integer", false)
			return
		}
		after = n
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
	wait := 0
	if v := q.Get("wait"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > maxWait {
			fail(w, 400, "bad_request", "wait must be 0..25 seconds", false)
			return
		}
		wait = n
	}
	deadline := time.NewTimer(time.Duration(wait) * time.Second)
	defer deadline.Stop()
	for {
		// subscribe BEFORE reading, so a commit that lands between the read and the wait is not missed
		ch, cancel := s.st.Subscribe(ws)
		ops, head, more, err := s.st.Pull(r.Context(), ws, after, limit, s.DevMode && p.Dev)
		if err != nil {
			cancel()
			if errors.Is(err, store.ErrNoWorkspace) {
				fail(w, 404, "no_such_workspace", "no such workspace", false)
				return
			}
			s.Log.Error("pull", "err", err)
			fail(w, 500, "internal", "reading the log failed", true)
			return
		}
		if len(ops) > 0 || wait == 0 {
			cancel()
			out := make([]pullOp, len(ops))
			for i, o := range ops {
				out[i] = pullOp{Seq: o.Seq, By: o.By, RT: o.RT, Env: json.RawMessage(o.Env)}
			}
			writeJSON(w, 200, map[string]any{"ops": out, "head": head, "more": more})
			return
		}
		select {
		case <-ch:
			cancel()
		case <-deadline.C:
			cancel()
			writeJSON(w, 200, map[string]any{"ops": []pullOp{}, "head": head, "more": false})
			return
		case <-r.Context().Done():
			cancel()
			return
		}
	}
}
