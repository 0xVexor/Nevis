package api

import (
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/0xVexor/Nevis/server/internal/apierr"
	"github.com/0xVexor/Nevis/server/internal/auth"
	"github.com/0xVexor/Nevis/server/internal/vaults"
)

var (
	contentRange = regexp.MustCompile(`^bytes (\d+)-(\d+)/(\d+)$`)
	hex64        = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func (s *Server) blobRoutes() {
	s.authed("PUT /v1/vaults/{id}/blobs/{sha}", s.putBlob)
	s.authed("HEAD /v1/vaults/{id}/blobs/{sha}", s.headBlob)
	s.authed("GET /v1/vaults/{id}/blobs/{sha}", s.getBlob)
	s.authed("GET /v1/vaults/{id}/rev/{rev}", s.getRevision)
}

// parseRange reads `Content-Range: bytes a-b/total`; no header means the whole body.
func parseRange(h string) (*vaults.Range, error) {
	if h == "" {
		return nil, nil
	}
	m := contentRange.FindStringSubmatch(h)
	if m == nil {
		return nil, apierr.New(400, "bad_range")
	}
	var n [3]int64
	for i := range n {
		v, err := strconv.ParseInt(m[i+1], 10, 64)
		if err != nil {
			return nil, apierr.New(400, "bad_range")
		}
		n[i] = v
	}
	return &vaults.Range{Start: n[0], End: n[1], Total: n[2]}, nil
}

func (s *Server) putBlob(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.vault(r, p)
	if err != nil {
		return err
	}
	rng, err := parseRange(r.Header.Get("Content-Range"))
	if err != nil {
		return err
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, s.readIdle(w, r), blobLimit))
	if err != nil {
		return err
	}
	res, err := s.Vaults.ReceiveBlob(r.Context(), p.User.ID, v, r.PathValue("sha"), rng, body)
	if err != nil {
		return err
	}
	status := 202
	if res.Complete {
		status = 201
		if res.Existed {
			status = 200
		} else {
			s.OnWrite()
		}
	}
	writeJSON(w, status, res.Body())
	return nil
}

func (s *Server) headBlob(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.vault(r, p)
	if err != nil {
		return err
	}
	sha := r.PathValue("sha")
	if !hex64.MatchString(sha) {
		return apierr.New(400, "bad_sha")
	}
	b, err := s.Vaults.Blob(r.Context(), v.ID, sha)
	if err != nil {
		return err
	}
	if b == nil || !s.Vaults.Blobs.Has(v.ID, sha) { // a row whose file is gone is not a blob
		// how far a half-finished upload got, so that the client can resume from there
		w.Header().Set("X-Received", strconv.FormatInt(s.Vaults.Received(v.ID, sha), 10))
		w.WriteHeader(http.StatusNotFound)
		return nil
	}
	w.Header().Set("X-Size", strconv.FormatInt(b.Size, 10))
	w.Header().Set("X-Md5", b.MD5)
	w.WriteHeader(http.StatusOK)
	return nil
}

func (s *Server) getBlob(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.vault(r, p)
	if err != nil {
		return err
	}
	return s.sendBlob(w, v.ID, r.PathValue("sha"), r)
}

// getRevision serves the content of one revision (the one the client was told about in `changes`), even if the
// path has moved on since.
func (s *Server) getRevision(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	v, err := s.vault(r, p)
	if err != nil {
		return err
	}
	rev, perr := strconv.ParseInt(r.PathValue("rev"), 10, 64)
	if perr != nil {
		return apierr.New(404, "no_such_revision")
	}
	f, err := s.Vaults.Revision(r.Context(), v, rev)
	if err != nil {
		return err
	}
	return s.sendBlob(w, v.ID, f.SHA256, r)
}

func (s *Server) sendBlob(w http.ResponseWriter, vaultID, sha string, r *http.Request) error {
	info, err := s.Vaults.Blob(r.Context(), vaultID, sha)
	if err != nil {
		return err
	}
	if info == nil {
		return apierr.New(404, "no_such_blob")
	}
	f, err := s.Vaults.Blobs.Open(vaultID, sha)
	if err != nil {
		return apierr.New(404, "no_such_blob")
	}
	defer f.Close()
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("X-Md5", info.MD5)
	h.Set("X-Sha256", sha)
	// A single range (`bytes=N-`, `bytes=N-M`, `bytes=-N`) answers 206 so that an interrupted download resumes where
	// it stopped; an unsatisfiable one answers 416. A multi-range request is answered with the whole body (200)
	// rather than a multipart one, which no client of this API asks for.
	if strings.Contains(r.Header.Get("Range"), ",") {
		r.Header.Del("Range")
	}
	// No modification time: the headers of a whole-body answer stay what they were (no Last-Modified, no ETag).
	// ServeContent sets Content-Length and Accept-Ranges itself. The write deadline moves with every chunk sent.
	http.ServeContent(s.writeIdle(w), r, "", time.Time{}, f)
	// the headers are out: a download the client abandoned halfway is its own business, not an error to answer
	return nil
}
