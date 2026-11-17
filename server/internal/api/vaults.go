package api

import (
	"net/http"
	"time"

	"github.com/0xVexor/Nevis/server/internal/apierr"
	"github.com/0xVexor/Nevis/server/internal/auth"
	"github.com/0xVexor/Nevis/server/internal/vaults"
)

const (
	maxWait = 30 // seconds a long poll may be held
	maxPath = 300
)

func (s *Server) vaultRoutes() {
	s.authed("GET /v1/vaults", s.listVaults)
	s.authed("POST /v1/vaults", s.createVault)
	s.authed("PATCH /v1/vaults/{id}", s.renameVault)
	s.authed("DELETE /v1/vaults/{id}", s.trashVault)
	s.authed("POST /v1/vaults/{id}/undelete", s.untrashVault)
}

func (s *Server) syncRoutes() {
	s.authed("GET /v1/vaults/{id}/state", s.state)
	s.authed("GET /v1/vaults/{id}/changes", s.changes)
	s.authed("GET /v1/vaults/{id}/file", s.file)
	s.authed("GET /v1/vaults/{id}/revisions", s.revisions)
	s.authed("POST /v1/vaults/{id}/commit", s.commit)
	s.authed("POST /v1/vaults/{id}/restore", s.restore)
}

// vault is the vault named in the path, if it is the caller's.
func (s *Server) vault(r *http.Request, p *auth.Principal) (*vaults.Vault, error) {
	return s.Vaults.Owned(r.Context(), p.User.ID, r.PathValue("id"), false)
}

func (s *Server) listVaults(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	list, err := s.Vaults.List(r.Context(), p.User.ID, r.URL.Query().Get("trashed") == "1")
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"vaults": list})
	return nil
}

func (s *Server) createVault(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var b struct{ ID, Name string }
	if err := readJSON(w, r, &b); err != nil {
		return err
	}
	c, err := s.Vaults.Create(r.Context(), p.User.ID, b.ID, b.Name)
	if err != nil {
		return err
	}
	status := 200
	if c.Created {
		status = 201
	}
	writeJSON(w, status, c)
	return nil
}

func (s *Server) renameVault(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.vault(r, p)
	if err != nil {
		return err
	}
	var b struct{ Name string }
	if err := readJSON(w, r, &b); err != nil {
		return err
	}
	if err := s.Vaults.Rename(r.Context(), v, b.Name); err != nil {
		return err
	}
	return ok(w)
}

func (s *Server) trashVault(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.vault(r, p)
	if err != nil {
		return err
	}
	if err := s.Vaults.Trash(r.Context(), v); err != nil {
		return err
	}
	s.Hub.Notify(v.ID) // devices waiting on it learn at once that it is gone
	return ok(w)
}

func (s *Server) untrashVault(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.Vaults.Owned(r.Context(), p.User.ID, r.PathValue("id"), true)
	if err != nil {
		return err
	}
	if err := s.Vaults.Untrash(r.Context(), v); err != nil {
		return err
	}
	return ok(w)
}

// state answers with the vault's state; with `since` and `wait` it answers as soon as the vault moves past `since`
// (or after `wait` seconds).
func (s *Server) state(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.vault(r, p)
	if err != nil {
		return err
	}
	since, hasSince := intParam(r, "since")
	wait, _ := intParam(r, "wait")
	wait = min(max(wait, 0), maxWait)
	if hasSince && wait > 0 && v.Seq <= since {
		if v, err = s.waitFor(r, v, since, time.Duration(wait)*time.Second); err != nil {
			return err
		}
	}
	st, err := s.Vaults.State(r.Context(), v.ID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, st)
	return nil
}

// waitFor holds the request until the vault passes `since`, the time is up or the client leaves. It subscribes
// before it looks, so that a commit in between cannot slip past.
func (s *Server) waitFor(r *http.Request, v *vaults.Vault, since int64, d time.Duration) (*vaults.Vault, error) {
	waiter := s.Hub.Subscribe(v.ID)
	defer waiter.Close()
	cur, err := s.Vaults.Reload(r.Context(), v.ID)
	if err != nil {
		return nil, err
	}
	if cur != nil && cur.Seq <= since {
		waiter.Wait(r.Context(), d)
		if cur, err = s.Vaults.Reload(r.Context(), v.ID); err != nil {
			return nil, err
		}
	}
	if cur == nil {
		return nil, apierr.New(404, "no_such_vault")
	}
	return cur, nil
}

func (s *Server) changes(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.vault(r, p)
	if err != nil {
		return err
	}
	since, _ := intParam(r, "since")
	limit, hasLimit := intParam(r, "limit")
	if !hasLimit {
		limit = vaults.DefaultPage
	}
	c, err := s.Vaults.Changes(r.Context(), v.ID, since, int(min(limit, 1<<20)))
	if err != nil {
		return err
	}
	writeJSON(w, 200, c)
	return nil
}

// pathParam is the `path` query parameter; an absurdly long one counts as missing.
func pathParam(r *http.Request) string {
	if v := r.URL.Query().Get("path"); len(v) <= maxPath*4 { // bytes; the character limit is enforced by the path rules
		return v
	}
	return ""
}

func (s *Server) file(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.vault(r, p)
	if err != nil {
		return err
	}
	f, err := s.Vaults.File(r.Context(), v, pathParam(r))
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"file": f, "server_time": s.Now().UnixMilli()})
	return nil
}

func (s *Server) revisions(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.vault(r, p)
	if err != nil {
		return err
	}
	list, err := s.Vaults.Revisions(r.Context(), v, pathParam(r))
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"revisions": list})
	return nil
}

func (s *Server) commit(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.vault(r, p)
	if err != nil {
		return err
	}
	var in vaults.CommitIn
	if err := readJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.Vaults.Commit(r.Context(), v, p.Device.ID, in)
	if err != nil {
		return err
	}
	if out.Changed {
		s.changed(v.ID)
	}
	writeJSON(w, 200, out)
	return nil
}

func (s *Server) restore(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.vault(r, p)
	if err != nil {
		return err
	}
	var b struct {
		Path string  `json:"path"`
		Rev  float64 `json:"rev"`
	}
	if err := readJSON(w, r, &b); err != nil {
		return err
	}
	if b.Rev != float64(int64(b.Rev)) {
		return apierr.New(404, "no_such_revision")
	}
	res, seq, changed, err := s.Vaults.Restore(r.Context(), v, p.Device.ID, b.Path, int64(b.Rev))
	if err != nil {
		return err
	}
	if changed {
		s.changed(v.ID)
	}
	res["seq"] = seq
	writeJSON(w, 200, res)
	return nil
}

// changed wakes the devices waiting on a vault and schedules a backup.
func (s *Server) changed(vaultID string) {
	s.Hub.Notify(vaultID)
	s.OnWrite()
}
