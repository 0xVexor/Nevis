package api

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/0xVexor/Nevis/server/internal/config"
)

// startPiece sends the first 10 of 20 bytes of an upload that is then abandoned.
func startPiece(f *fixture, content string) reply {
	return f.call("PUT", fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha(content)), opts{token: f.a.token, raw: []byte(content[:10]),
		headers: map[string]string{"Content-Range": "bytes 0-9/20"}})
}

func TestAbandonedUploadsDoNotBlockTheAccount(t *testing.T) {
	fill := func(t *testing.T, f *fixture) {
		t.Helper()
		for i := range 8 {
			if r := startPiece(f, strings.Repeat(string(rune('a'+i)), 20)); r.status != 202 {
				t.Fatalf("piece %d: %d %v", i, r.status, r.body)
			}
		}
	}

	t.Run("a complete single request upload is not held back by eight pending ones", func(t *testing.T) {
		f := newFixture(t)
		fill(t, f)
		small := "hello"
		r := f.call("PUT", fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha(small)), opts{token: f.a.token, raw: []byte(small)})
		if r.status != 201 {
			t.Fatalf("a complete 5-byte upload was refused: %d %v", r.status, r.body)
		}
	})

	t.Run("a new multi-piece upload is refused with its own code while the others are fresh", func(t *testing.T) {
		f := newFixture(t)
		fill(t, f)
		r := startPiece(f, strings.Repeat("z", 20))
		if r.status != 429 || r.body.str("error") != "too_many_uploads" {
			t.Fatalf("%d %v", r.status, r.body)
		}
	})

	t.Run("a silent upload gives its place to a new one", func(t *testing.T) {
		f := newFixture(t)
		fill(t, f)
		f.clock.advance(11 * time.Minute)
		if r := startPiece(f, strings.Repeat("z", 20)); r.status != 202 {
			t.Fatalf("%d %v", r.status, r.body)
		}
	})

	t.Run("a silent upload does not count against the quota", func(t *testing.T) {
		f := newFixture(t, func(c *config.Config) { c.MaxBlobBytes = 100; c.QuotaBytes = 150 })
		big := strings.Repeat("x", 100)
		if r := f.call("PUT", fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha(big)), opts{token: f.a.token, raw: []byte(big[:10]),
			headers: map[string]string{"Content-Range": "bytes 0-9/100"}}); r.status != 202 {
			t.Fatalf("%d %v", r.status, r.body)
		}
		other := strings.Repeat("y", 100)
		put := func() reply {
			return f.call("PUT", fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha(other)), opts{token: f.a.token, raw: []byte(other)})
		}
		if r := put(); r.status != 507 || r.body.str("error") != "quota_exceeded" {
			t.Fatalf("%d %v", r.status, r.body)
		}
		f.clock.advance(11 * time.Minute)
		if r := put(); r.status != 201 {
			t.Fatalf("%d %v", r.status, r.body)
		}
	})
}

// A blob row whose file is gone (a database restored from a backup after the blobs were purged) is not a blob:
// uploading the same bytes again repairs it.
func TestABlobRowWithoutItsFileCanBeRepairedByUploadingAgain(t *testing.T) {
	setup := func(t *testing.T) (*fixture, float64) {
		f := newFixture(t)
		c := f.commitOps([]op{put("pages/a.json", "content of a")})
		if c.status != 200 {
			t.Fatalf("%d %v", c.status, c.body)
		}
		rev := c.body.list("results")[0].num("rev")
		if err := f.store.Blobs.Remove(f.v, sha("content of a")); err != nil {
			t.Fatal(err)
		}
		return f, float64(rev)
	}
	blobURL := func(f *fixture) string { return fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha("content of a")) }

	t.Run("HEAD does not claim it and a re-upload stores it again", func(t *testing.T) {
		f, rev := setup(t)
		if r := f.call("GET", fmt.Sprintf("/v1/vaults/%s/rev/%d", f.v, int64(rev)), opts{token: f.a.token}); r.status != 404 {
			t.Fatalf("precondition: %d", r.status)
		}
		if head := f.call("HEAD", blobURL(f), opts{token: f.a.token}); head.status != 404 {
			t.Fatalf("HEAD: %d", head.status)
		}
		if again := f.call("PUT", blobURL(f), opts{token: f.a.token, raw: []byte("content of a")}); again.status != 201 {
			t.Fatalf("re-upload: %d %v", again.status, again.body)
		}
		got := f.call("GET", fmt.Sprintf("/v1/vaults/%s/rev/%d", f.v, int64(rev)), opts{token: f.a.token})
		if got.status != 200 || string(got.raw) != "content of a" {
			t.Fatalf("download: %d %s", got.status, got.raw)
		}
		if head := f.call("HEAD", blobURL(f), opts{token: f.a.token}); head.status != 200 {
			t.Fatalf("HEAD after repair: %d", head.status)
		}
	})

	t.Run("a commit cannot point at it", func(t *testing.T) {
		f, _ := setup(t)
		c := f.call("POST", "/v1/vaults/"+f.v+"/commit", opts{token: f.a.token, json: J{"op_id": "dangling-ref-1",
			"ops": []J{{"op": "put", "path": "pages/b.json", "sha256": sha("content of a"), "base_rev": 0}}}})
		res := c.body.list("results")[0]
		if res.str("error") != "blob_missing" {
			t.Fatalf("%d %v", c.status, c.body)
		}
	})
}
