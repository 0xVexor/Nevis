package api

import (
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

func init() {
	_ = mime.AddExtensionType(".wasm", "application/wasm")
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
	_ = mime.AddExtensionType(".mjs", "text/javascript; charset=utf-8")
}

// contentSecurityPolicy is what the web app runs under. A script injected into the page would hold the user's session, so
// nothing may load from or talk to another origin and no inline script may run.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob: https:; " +
	"media-src 'self' data: blob: https:; " +
	"font-src 'self' data:; " +
	"connect-src 'self'; " +
	"worker-src 'self' blob:; " +
	"manifest-src 'self'; " +
	"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

// webApp serves the built web app: a file when there is one, index.html for the app's own routes (no file extension), 404 for
// anything else. Dot files and anything outside the folder are never served. `/v1` stays the API.
func (s *Server) webApp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		fail(w, 405, "method_not_allowed", "method not allowed", false)
		return
	}
	if r.URL.Path == "/v1" || strings.HasPrefix(r.URL.Path, "/v1/") {
		fail(w, 404, "not_found", "no such route", false)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") {
			fail(w, 404, "not_found", "not found", false)
			return
		}
	}
	root := os.DirFS(s.WebDir)
	if name == "" {
		name = "index.html"
	}
	f, info, err := openFile(root, name)
	if err != nil {
		if path.Ext(name) != "" {
			fail(w, 404, "not_found", "not found", false)
			return
		}
		name = "index.html"
		if f, info, err = openFile(root, name); err != nil {
			fail(w, 404, "not_found", "not found", false)
			return
		}
	}
	defer f.Close()
	h := w.Header()
	h.Set("Content-Security-Policy", contentSecurityPolicy)
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
	if strings.HasPrefix(name, "assets/") {
		h.Set("Cache-Control", "public, max-age=31536000, immutable") // hashed file names never change
	} else {
		h.Set("Cache-Control", "no-cache")
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		fail(w, 500, "internal", "cannot serve this file", false)
		return
	}
	http.ServeContent(w, r, name, info.ModTime().Truncate(time.Second), rs)
}

func openFile(root fs.FS, name string) (fs.File, fs.FileInfo, error) {
	f, err := root.Open(name)
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, nil, fs.ErrNotExist
	}
	return f, info, nil
}
