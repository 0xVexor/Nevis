package api

import (
	"github.com/nevis-app/nevis/server/internal/store"
	"net/http"
	"strconv"
)

// GET /v1/ws/{ws}/snapshots/candidates?min=N: the documents that have at least N ops no snapshot covers. A client that has pulled and applied
// everything then writes a snapshot op (with `cov`) for each. The server only counts; it never reads a payload.
func (s *Server) snapshotCandidates(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	ws := r.PathValue("ws")
	if !s.member(w, r, p, ws, false) {
		return
	}
	min := int64(100)
	if v := r.URL.Query().Get("min"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			fail(w, 400, "bad_request", "min must be a positive integer", false)
			return
		}
		min = n
	}
	list, err := s.st.SnapshotCandidates(r.Context(), ws, min, 50)
	if err != nil {
		s.Log.Error("snapshot candidates", "err", err)
		fail(w, 500, "internal", "could not list documents", true)
		return
	}
	if list == nil {
		list = []store.Candidate{}
	}
	writeJSON(w, 200, map[string]any{"docs": list})
}
