package api

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/0xVexor/Nevis/server/internal/config"
)

func TestBlobs(t *testing.T) {
	blobURL := func(f *fixture, content string) string {
		return fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha(content))
	}
	putBlob := func(f *fixture, content string, headers ...map[string]string) reply {
		o := opts{token: f.a.token, raw: []byte(content)}
		if len(headers) > 0 {
			o.headers = headers[0]
		}
		return f.call("PUT", blobURL(f, content), o)
	}

	t.Run("stores a blob under its hash, answers HEAD and GET with its md5, and accepts the same blob again", func(t *testing.T) {
		f := newFixture(t)
		r := putBlob(f, "hello world")
		if r.status != 201 || r.body.str("md5") != md5hex("hello world") || !r.body.flag("complete") || r.body.num("size") != 11 {
			t.Fatalf("%d %v", r.status, r.body)
		}
		if !f.store.Blobs.Has(f.v, sha("hello world")) {
			t.Fatal("not on disk")
		}
		head := f.call("HEAD", blobURL(f, "hello world"), opts{token: f.a.token})
		if head.status != 200 || head.header.Get("X-Md5") != md5hex("hello world") || head.header.Get("X-Size") != "11" {
			t.Fatalf("%d %v", head.status, head.header)
		}
		get := f.call("GET", blobURL(f, "hello world"), opts{token: f.a.token})
		if string(get.raw) != "hello world" || get.header.Get("X-Md5") != md5hex("hello world") || get.header.Get("X-Sha256") != sha("hello world") || get.header.Get("Content-Length") != "11" {
			t.Fatalf("%q %v", get.raw, get.header)
		}
		if again := putBlob(f, "hello world"); again.status != 200 || !again.body.flag("existed") {
			t.Fatalf("%d %v", again.status, again.body)
		}
		if missing := f.call("HEAD", blobURL(f, "nothing"), opts{token: f.a.token}); missing.status != 404 {
			t.Fatalf("%d", missing.status)
		}
	})

	t.Run("refuses a HEAD whose name is not a hash, without looking at the disk", func(t *testing.T) {
		f := newFixture(t)
		for _, name := range []string{"..%2F..%2Fx", "not-a-hash"} {
			r := f.call("HEAD", "/v1/vaults/"+f.v+"/blobs/"+name, opts{token: f.a.token})
			if r.status != 400 || r.header.Get("X-Received") != "" {
				t.Fatalf("%s: %d %v", name, r.status, r.header)
			}
		}
	})

	t.Run("refuses bytes that do not match the name they are uploaded under, and stores nothing", func(t *testing.T) {
		f := newFixture(t)
		r := f.call("PUT", blobURL(f, "real"), opts{token: f.a.token, raw: []byte("fake")})
		if r.status != 422 || r.body.str("error") != "hash_mismatch" {
			t.Fatalf("%d %v", r.status, r.body)
		}
		if f.store.Blobs.Has(f.v, sha("real")) {
			t.Fatal("a blob that does not match its name was stored")
		}
		if r := f.call("PUT", "/v1/vaults/"+f.v+"/blobs/not-a-hash", opts{token: f.a.token, raw: []byte("x")}); r.status != 400 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("takes a blob in pieces, tells how far it got, and survives a piece that is sent again", func(t *testing.T) {
		f := newFixture(t)
		content := strings.Repeat("abcdefghij", 10) // 100 bytes
		send := func(from, to int) reply {
			return f.call("PUT", blobURL(f, content), opts{token: f.a.token, raw: []byte(content[from:to]),
				headers: map[string]string{"Content-Range": fmt.Sprintf("bytes %d-%d/%d", from, to-1, len(content))}})
		}
		one := send(0, 40)
		if one.status != 202 || one.body.num("received") != 40 || one.body.flag("complete") {
			t.Fatalf("%d %v", one.status, one.body)
		}
		head := f.call("HEAD", blobURL(f, content), opts{token: f.a.token})
		if head.status != 404 || head.header.Get("X-Received") != "40" {
			t.Fatalf("%d %v", head.status, head.header)
		}
		gap := send(60, 100)
		if gap.status != 409 || gap.body.num("received") != 40 || gap.body.str("error") != "out_of_order" {
			t.Fatalf("%d %v", gap.status, gap.body)
		}
		for _, p := range [][2]int{{0, 40}, {40, 70}, {40, 70}} { // the first piece again; a lost answer: the same piece once more
			if r := send(p[0], p[1]); r.status != 202 {
				t.Fatalf("%v: %d %v", p, r.status, r.body)
			}
		}
		done := send(70, 100)
		if done.status != 201 || done.body.num("size") != 100 {
			t.Fatalf("%d %v", done.status, done.body)
		}
		if got := f.call("GET", blobURL(f, content), opts{token: f.a.token}); string(got.raw) != content {
			t.Fatalf("%q", got.raw)
		}
	})

	t.Run("discards an upload whose pieces add up to the wrong content", func(t *testing.T) {
		f := newFixture(t)
		content := strings.Repeat("x", 50)
		piece := func(from, to int, body string) reply {
			return f.call("PUT", blobURL(f, content), opts{token: f.a.token, raw: []byte(body),
				headers: map[string]string{"Content-Range": fmt.Sprintf("bytes %d-%d/50", from, to-1)}})
		}
		if r := piece(0, 25, strings.Repeat("x", 25)); r.status != 202 {
			t.Fatalf("%d", r.status)
		}
		if r := piece(25, 50, strings.Repeat("y", 25)); r.status != 422 {
			t.Fatalf("%d", r.status)
		}
		if head := f.call("HEAD", blobURL(f, content), opts{token: f.a.token}); head.header.Get("X-Received") != "0" {
			t.Fatalf("%v", head.header)
		}
	})

	t.Run("refuses a piece that does not fit its range, and a malformed range", func(t *testing.T) {
		f := newFixture(t)
		for _, header := range []string{"bytes 0-9/10", "bytes 5-4/10", "bytes=0-9", "bytes 0-9/*", "bytes 99999999999999999999-1/5"} {
			r := f.call("PUT", blobURL(f, "abc"), opts{token: f.a.token, raw: []byte("abc"), headers: map[string]string{"Content-Range": header}})
			if r.status != 400 || r.body.str("error") != "bad_range" {
				t.Errorf("%q: %d %v", header, r.status, r.body)
			}
		}
	})

	t.Run("refuses a blob that is too large or would exceed the quota of the account", func(t *testing.T) {
		f := newFixture(t, func(c *config.Config) { c.MaxBlobBytes = 100; c.QuotaBytes = 150 })
		if r := putBlob(f, strings.Repeat("x", 101)); r.status != 413 || r.body.str("error") != "too_large" {
			t.Fatalf("%d %v", r.status, r.body)
		}
		if r := putBlob(f, strings.Repeat("a", 80)); r.status != 201 {
			t.Fatalf("%d", r.status)
		}
		over := putBlob(f, strings.Repeat("b", 80))
		if over.status != 507 || over.body.str("error") != "quota_exceeded" {
			t.Fatalf("%d %v", over.status, over.body)
		}
		acc := f.call("GET", "/v1/account", opts{token: f.a.token})
		if acc.body.obj("quota").num("used") != 80 || acc.body.obj("quota").num("limit") != 150 {
			t.Fatalf("%v", acc.body)
		}
	})

	t.Run("does not hand out another vault's blobs", func(t *testing.T) {
		f := newFixture(t)
		putBlob(f, "secret")
		b := f.register("bob")
		w := f.newVault(b.token, "bobs")
		if r := f.call("GET", fmt.Sprintf("/v1/vaults/%s/blobs/%s", w, sha("secret")), opts{token: b.token}); r.status != 404 {
			t.Fatalf("%d", r.status)
		}
		if r := f.call("GET", blobURL(f, "secret"), opts{token: b.token}); r.status != 404 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("the content of a deleted revision is gone from the revision endpoint", func(t *testing.T) {
		f := newFixture(t)
		first := f.commitOps([]op{put("pages/a.json", "x")})
		f.commitOps([]op{del("pages/a.json", result(first, 0).num("rev"))})
		if r := f.call("GET", "/v1/vaults/"+f.v+"/rev/2", opts{token: f.a.token}); r.status != 404 || r.body.str("error") != "no_such_revision" {
			t.Fatalf("%d %v", r.status, r.body)
		}
		if r := f.call("GET", "/v1/vaults/"+f.v+"/rev/1", opts{token: f.a.token}); string(r.raw) != "x" {
			t.Fatalf("%q", r.raw)
		}
		if r := f.call("GET", "/v1/vaults/"+f.v+"/rev/banana", opts{token: f.a.token}); r.status != 404 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("accepts the empty file, which the old server refused", func(t *testing.T) {
		f := newFixture(t)
		r := putBlob(f, "")
		if r.status != 201 || r.body.num("size") != 0 || r.body.str("md5") != md5hex("") {
			t.Fatalf("%d %v", r.status, r.body)
		}
		if c := f.commitOps([]op{put("pages/empty.json", "")}); !result(c, 0).flag("ok") {
			t.Fatalf("%v", c.body)
		}
		bogus := f.call("PUT", fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha("not empty")), opts{token: f.a.token, raw: []byte{}})
		if bogus.status != 422 {
			t.Fatalf("an empty body under another name: %d", bogus.status)
		}
	})

	t.Run("two uploads of the same blob at once end with one good blob", func(t *testing.T) {
		f := newFixture(t)
		content := strings.Repeat("z", 5000)
		var wg sync.WaitGroup
		statuses := make(chan int, 6)
		for range 6 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				statuses <- putBlob(f, content).status
			}()
		}
		wg.Wait()
		close(statuses)
		for s := range statuses {
			if s != 200 && s != 201 {
				t.Fatalf("status %d", s)
			}
		}
		if got := f.call("GET", blobURL(f, content), opts{token: f.a.token}); string(got.raw) != content {
			t.Fatal("the blob is damaged")
		}
	})
}
