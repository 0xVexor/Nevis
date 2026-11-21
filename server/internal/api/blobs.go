package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/nevis-app/nevis/server/internal/blobs"
	"github.com/nevis-app/nevis/server/internal/store"
)

// Attachments (ADR-0006 §6, ROADMAP M9). Bytes never travel inside an op. A blob is named by its SHA-256 and uploaded in pieces:
//
//	PUT  /v1/ws/{ws}/blobs/{sha}?offset=N&total=T   raw piece; the last piece (offset+len == T) makes the server hash the whole file
//	HEAD /v1/ws/{ws}/blobs/{sha}                    200 + Nevis-Size when stored; 404 + Nevis-Received (bytes of a half upload) when not
//	GET  /v1/ws/{ws}/blobs/{sha}                    the bytes, with Range
//	POST /v1/ws/{ws}/blobs/refs                     {cursor, refs[]}: the hashes the client's workspace still points at (garbage collection)
//
// The bytes of a user are served from OUR origin, so they must never be able to run as a page: every response is an opaque download
// (octet-stream, nosniff, attachment, a sandbox CSP). The client claims no type that the server honours; it shows an image by fetching
// the bytes and wrapping them in an object URL itself.
const (
	maxBlobPiece = 8 << 20
	maxRefs      = 200000
)

func (s *Server) blobsOn(w http.ResponseWriter) bool {
	if s.blobs == nil {
		fail(w, 501, "blobs_off", "attachments are not enabled on this server", false)
		return false
	}
	return true
}

func (s *Server) putBlob(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	ws, sha := r.PathValue("ws"), r.PathValue("sha")
	if !s.blobsOn(w) || !s.member(w, r, p, ws, true) {
		return
	}
	if !blobs.ValidHash(sha) {
		fail(w, 400, "bad_request", "the blob name must be a lowercase SHA-256", false)
		return
	}
	q := r.URL.Query()
	offset, err1 := strconv.ParseInt(q.Get("offset"), 10, 64)
	total, err2 := strconv.ParseInt(q.Get("total"), 10, 64)
	if err1 != nil || err2 != nil || offset < 0 || total < 0 || offset > total {
		fail(w, 400, "bad_request", "offset and total must be integers with 0 <= offset <= total", false)
		return
	}
	if total > s.MaxBlobBytes {
		fail(w, 413, "blob_too_large", "this file is larger than the server accepts", false, map[string]any{"maxBytes": s.MaxBlobBytes})
		return
	}
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(5 * time.Minute)) // a piece on a slow line may take longer than the server's default minute
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBlobPiece))
	if err != nil {
		fail(w, 413, "too_large", "a piece may not exceed 8 MB", false)
		return
	}
	if offset+int64(len(body)) > total {
		fail(w, 400, "bad_request", "the piece goes beyond the announced total", false)
		return
	}
	account := p.AccountID
	if p.Dev {
		account = ""
	}
	unlock := s.blobs.Lock(ws, sha)
	defer unlock()
	ctx := r.Context()
	if size, ok, err := s.st.BlobSize(ctx, ws, sha); err != nil {
		s.Log.Error("blob size", "err", err)
		fail(w, 500, "internal", "could not read the blob index", true)
		return
	} else if ok { // already stored (another device, or a retry after a lost answer): nothing to do, nothing to charge
		_ = s.st.TouchBlob(ctx, ws, sha)
		writeJSON(w, 200, map[string]any{"complete": true, "received": size})
		return
	}
	if offset == 0 {
		room, err := s.st.QuotaRoom(ctx, account, total, s.QuotaBytes)
		if err != nil {
			fail(w, 500, "internal", "could not check the quota", true)
			return
		}
		if !room {
			fail(w, 507, "quota_exceeded", "the storage of this account is full", false)
			return
		}
	}
	if err := s.blobs.Receive(ws, sha, offset, body); err != nil {
		var oo *blobs.OutOfOrder
		if errors.As(err, &oo) {
			fail(w, 409, "out_of_order", "the piece starts after what the server holds", false, map[string]any{"received": oo.Received})
			return
		}
		s.Log.Error("blob receive", "err", err)
		fail(w, 500, "internal", "storing the piece failed", true)
		return
	}
	received := offset + int64(len(body))
	if received < total {
		writeJSON(w, 200, map[string]any{"complete": false, "received": received})
		return
	}
	if err := s.blobs.Finish(ws, sha, total); err != nil {
		switch {
		case errors.Is(err, blobs.ErrHashMismatch):
			fail(w, 400, "hash_mismatch", "the content does not match its name", false)
		case errors.Is(err, blobs.ErrSizeMismatch):
			fail(w, 400, "size_mismatch", "the pieces do not add up to the announced size", false)
		default:
			s.Log.Error("blob finish", "err", err)
			fail(w, 500, "internal", "storing the file failed", true)
		}
		return
	}
	if _, err := s.st.AddBlob(ctx, ws, sha, total, account, s.QuotaBytes); err != nil {
		_ = s.blobs.Remove(ws, sha) // the row is what makes a blob exist; without it the bytes must not stay
		if errors.Is(err, store.ErrQuota) {
			fail(w, 507, "quota_exceeded", "the storage of this account is full", false)
			return
		}
		s.Log.Error("blob index", "err", err)
		fail(w, 500, "internal", "could not record the file", true)
		return
	}
	writeJSON(w, 200, map[string]any{"complete": true, "received": total})
}

func (s *Server) headBlob(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	ws, sha := r.PathValue("ws"), r.PathValue("sha")
	if !s.blobsOn(w) || !s.member(w, r, p, ws, false) {
		return
	}
	if !blobs.ValidHash(sha) {
		fail(w, 400, "bad_request", "the blob name must be a lowercase SHA-256", false)
		return
	}
	size, ok, err := s.st.BlobSize(r.Context(), ws, sha)
	if err != nil {
		fail(w, 500, "internal", "could not read the blob index", true)
		return
	}
	if !ok {
		w.Header().Set("Nevis-Received", strconv.FormatInt(s.blobs.Received(ws, sha), 10))
		fail(w, 404, "no_such_blob", "no such file", false)
		return
	}
	_ = s.st.TouchBlob(r.Context(), ws, sha) // someone is about to point an op at it
	w.Header().Set("Nevis-Size", strconv.FormatInt(size, 10))
	w.WriteHeader(200)
}

func (s *Server) getBlob(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	ws, sha := r.PathValue("ws"), r.PathValue("sha")
	if !s.blobsOn(w) || !s.member(w, r, p, ws, false) {
		return
	}
	if !blobs.ValidHash(sha) {
		fail(w, 400, "bad_request", "the blob name must be a lowercase SHA-256", false)
		return
	}
	if _, ok, err := s.st.BlobSize(r.Context(), ws, sha); err != nil {
		fail(w, 500, "internal", "could not read the blob index", true)
		return
	} else if !ok {
		fail(w, 404, "no_such_blob", "no such file", false)
		return
	}
	f, err := s.blobs.Open(ws, sha)
	if err != nil {
		fail(w, 404, "no_such_blob", "no such file", false)
		return
	}
	defer f.Close()
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Minute)) // a large file on a slow line
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", "attachment")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Etag", `"`+sha+`"`) // content-addressed: the name is the validator
	http.ServeContent(w, r, "", time.Time{}, f)
}

func (s *Server) blobRefs(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	ws := r.PathValue("ws")
	if !s.blobsOn(w) || !s.member(w, r, p, ws, true) {
		return
	}
	var in struct {
		Cursor int64    `json:"cursor"`
		Refs   []string `json:"refs"`
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
	if err != nil || json.Unmarshal(body, &in) != nil || in.Cursor < 0 || len(in.Refs) > maxRefs {
		fail(w, 400, "bad_request", `body must be {"cursor":n,"refs":["<sha256>",…]}`, false)
		return
	}
	for _, h := range in.Refs {
		if !blobs.ValidHash(h) {
			fail(w, 400, "bad_request", "a reference is not a SHA-256", false)
			return
		}
	}
	applied, err := s.st.ReportRefs(r.Context(), ws, in.Cursor, in.Refs)
	switch {
	case err == nil:
		writeJSON(w, 200, map[string]any{"applied": applied})
	case errors.Is(err, store.ErrNoWorkspace):
		fail(w, 404, "no_such_workspace", "no such workspace", false)
	default:
		s.Log.Error("blob refs", "err", err)
		fail(w, 500, "internal", "could not record the references", true)
	}
}

// CollectBlobs removes the blobs whose probation is over (see store.ReportRefs) and returns how many went. main calls it on a timer;
// the files go after the rows, so a crash in between leaves orphan bytes the API can no longer see, never a row without bytes.
func CollectBlobs(ctx context.Context, st *store.Store, dataDir string) (int, error) {
	bs, err := blobs.New(dataDir)
	if err != nil {
		return 0, err
	}
	gone, err := st.CollectBlobs(ctx)
	for _, b := range gone {
		_ = bs.Remove(b.WS, b.Hash)
	}
	_, _ = bs.SweepStaging(time.Now(), 48*time.Hour)
	return len(gone), err
}
