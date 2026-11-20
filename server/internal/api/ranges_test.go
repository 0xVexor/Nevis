package api

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestBlobRange(t *testing.T) {
	f := newFixture(t)
	srv := f.serve(Timeouts{})
	content := strings.Repeat("0123456789", 100) // 1000 bytes
	path := fmt.Sprintf("%s/v1/vaults/%s/blobs/%s", srv.URL, f.v, sha(content))
	do := func(method, rangeHeader string, body io.Reader) (*http.Response, string) {
		t.Helper()
		req, _ := http.NewRequest(method, path, body)
		req.Header.Set("Authorization", "Bearer "+f.a.token)
		if rangeHeader != "" {
			req.Header.Set("Range", rangeHeader)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		got, _ := io.ReadAll(res.Body)
		return res, string(got)
	}
	if res, _ := do("PUT", "", strings.NewReader(content)); res.StatusCode != 201 {
		t.Fatalf("upload: %d", res.StatusCode)
	}

	t.Run("no Range is the whole body as before", func(t *testing.T) {
		res, got := do("GET", "", nil)
		if res.StatusCode != 200 || got != content || res.Header.Get("Content-Length") != "1000" ||
			res.Header.Get("Content-Type") != "application/octet-stream" || res.Header.Get("X-Sha256") != sha(content) ||
			res.Header.Get("X-Md5") == "" || res.Header.Get("Accept-Ranges") != "bytes" {
			t.Fatalf("%d %v", res.StatusCode, res.Header)
		}
	})

	for _, c := range []struct{ name, header, want, contentRange string }{
		{"from a start", "bytes=990-", content[990:], "bytes 990-999/1000"},
		{"open-ended from zero", "bytes=0-", content, "bytes 0-999/1000"},
		{"start to end", "bytes=10-19", content[10:20], "bytes 10-19/1000"},
		{"end past the size is clamped", "bytes=995-5000", content[995:], "bytes 995-999/1000"},
		{"suffix", "bytes=-5", content[995:], "bytes 995-999/1000"},
	} {
		t.Run(c.name, func(t *testing.T) {
			res, got := do("GET", c.header, nil)
			if res.StatusCode != 206 || got != c.want || res.Header.Get("Content-Range") != c.contentRange ||
				res.Header.Get("Content-Length") != fmt.Sprint(len(c.want)) || res.Header.Get("Accept-Ranges") != "bytes" ||
				res.Header.Get("Content-Type") != "application/octet-stream" || res.Header.Get("X-Md5") == "" {
				t.Fatalf("%d %q %v", res.StatusCode, got, res.Header)
			}
		})
	}

	t.Run("a range outside the blob is 416", func(t *testing.T) {
		for _, h := range []string{"bytes=1000-", "bytes=5000-6000"} {
			res, _ := do("GET", h, nil)
			if res.StatusCode != 416 || res.Header.Get("Content-Range") != "bytes */1000" {
				t.Fatalf("%s: %d %v", h, res.StatusCode, res.Header)
			}
		}
	})

	t.Run("several ranges answer the whole body", func(t *testing.T) {
		res, got := do("GET", "bytes=0-4,10-14", nil)
		if res.StatusCode != 200 || got != content {
			t.Fatalf("%d %d bytes", res.StatusCode, len(got))
		}
	})

	t.Run("a resumed download reassembles the exact bytes", func(t *testing.T) {
		_, first := do("GET", "bytes=0-336", nil)
		res, rest := do("GET", fmt.Sprintf("bytes=%d-", len(first)), nil)
		if res.StatusCode != 206 || first+rest != content {
			t.Fatalf("%d: reassembled %d bytes", res.StatusCode, len(first+rest))
		}
	})

	t.Run("another account still cannot read it", func(t *testing.T) {
		bob := f.register("bob")
		req, _ := http.NewRequest("GET", path, nil)
		req.Header.Set("Authorization", "Bearer "+bob.token)
		req.Header.Set("Range", "bytes=0-")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode == 200 || res.StatusCode == 206 {
			t.Fatalf("%d", res.StatusCode)
		}
	})
}
