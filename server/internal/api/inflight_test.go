package api

import (
	"bufio"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/0xVexor/Nevis/server/internal/config"
)

func TestInFlightUploadQuota(t *testing.T) {
	small := func(c *config.Config) { c.MaxBlobBytes = 100; c.QuotaBytes = 150 }
	// firstPiece starts an upload of `content` and stops after 10 bytes
	firstPiece := func(f *fixture, content string) reply {
		return f.call("PUT", fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha(content)), opts{token: f.a.token, raw: []byte(content[:10]),
			headers: map[string]string{"Content-Range": fmt.Sprintf("bytes 0-9/%d", len(content))}})
	}
	rest := func(f *fixture, content string) reply {
		return f.call("PUT", fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha(content)), opts{token: f.a.token, raw: []byte(content[10:]),
			headers: map[string]string{"Content-Range": fmt.Sprintf("bytes 10-%d/%d", len(content)-1, len(content))}})
	}
	quotaRefused := func(t *testing.T, r reply) {
		t.Helper()
		if r.status != 507 || r.body.str("error") != "quota_exceeded" {
			t.Fatalf("%d %v", r.status, r.body)
		}
	}
	a, b := strings.Repeat("a", 80), strings.Repeat("b", 80)

	t.Run("refuses an upload that fits alone but not next to one still in flight", func(t *testing.T) {
		f := newFixture(t, small)
		if r := firstPiece(f, a); r.status != 202 {
			t.Fatalf("%d %v", r.status, r.body)
		}
		quotaRefused(t, firstPiece(f, b))
		if r := rest(f, a); r.status != 201 {
			t.Fatalf("%d %v", r.status, r.body)
		}
	})

	t.Run("gives the room back when an upload completes", func(t *testing.T) {
		f := newFixture(t, func(c *config.Config) { c.MaxBlobBytes = 100; c.QuotaBytes = 200 })
		firstPiece(f, a)
		rest(f, a)
		if r := firstPiece(f, b); r.status != 202 { // 80 stored + 80 in flight fits in 200
			t.Fatalf("%d %v", r.status, r.body)
		}
		if r := rest(f, b); r.status != 201 {
			t.Fatalf("%d %v", r.status, r.body)
		}
	})

	t.Run("gives the room back when an upload fails", func(t *testing.T) {
		f := newFixture(t, small)
		firstPiece(f, a)
		bad := f.call("PUT", fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha(a)), opts{token: f.a.token, raw: []byte(strings.Repeat("z", 70)),
			headers: map[string]string{"Content-Range": "bytes 10-79/80"}})
		if bad.status != 422 {
			t.Fatalf("%d %v", bad.status, bad.body)
		}
		if r := firstPiece(f, b); r.status != 202 {
			t.Fatalf("%d %v", r.status, r.body)
		}
	})

	t.Run("gives the room back when staging is swept", func(t *testing.T) {
		f := newFixture(t, small)
		firstPiece(f, a)
		quotaRefused(t, firstPiece(f, b))
		f.housekeeping(2 * day)
		if r := firstPiece(f, b); r.status != 202 {
			t.Fatalf("%d %v", r.status, r.body)
		}
	})

	t.Run("does not let a request that sends nothing keep a place", func(t *testing.T) {
		f := newFixture(t, small)
		gap := f.call("PUT", fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha(a)), opts{token: f.a.token, raw: []byte(a[:10]),
			headers: map[string]string{"Content-Range": "bytes 40-49/80"}})
		if gap.status != 409 {
			t.Fatalf("%d %v", gap.status, gap.body)
		}
		if r := firstPiece(f, b); r.status != 202 {
			t.Fatalf("%d %v", r.status, r.body)
		}
		if r := firstPiece(f, a); r.status != 507 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("limits how many uploads one account has in flight, and not another account", func(t *testing.T) {
		f := newFixture(t) // the default quota has room for many
		for i := range 8 {
			if r := firstPiece(f, strings.Repeat(string(rune('a'+i)), 20)); r.status != 202 {
				t.Fatalf("upload %d: %d %v", i, r.status, r.body)
			}
		}
		quotaRefused(t, firstPiece(f, strings.Repeat("z", 20)))
		bob := f.register("bob")
		bv := f.newVault(bob.token, "b")
		r := f.call("PUT", fmt.Sprintf("/v1/vaults/%s/blobs/%s", bv, sha(a)), opts{token: bob.token, raw: []byte(a[:10]),
			headers: map[string]string{"Content-Range": "bytes 0-9/80"}})
		if r.status != 202 {
			t.Fatalf("%d %v", r.status, r.body)
		}
	})

	t.Run("holds under concurrent first pieces", func(t *testing.T) {
		f := newFixture(t, small)
		contents := []string{a, b, strings.Repeat("c", 80), strings.Repeat("d", 80)}
		statuses := make(chan int, len(contents))
		for _, c := range contents {
			go func() { statuses <- firstPiece(f, c).status }()
		}
		accepted := 0
		for range contents {
			if <-statuses == 202 {
				accepted++
			}
		}
		if accepted != 1 {
			t.Fatalf("%d uploads of 80 bytes were admitted into a quota of 150", accepted)
		}
	})
}

// serve runs the handler on a real listener, where connection deadlines exist.
func (e *env) serve(timeouts Timeouts) *httptest.Server {
	e.t.Helper()
	srv := httptest.NewServer(New(Deps{Cfg: e.cfg, Accounts: e.accounts, Vaults: e.store, Hub: e.hub, Now: e.clock.now,
		OnWrite: func() {}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Timeouts: timeouts}))
	e.t.Cleanup(srv.Close)
	return srv
}

func TestDeadlines(t *testing.T) {
	f := newFixture(t)
	srv := f.serve(Timeouts{TransferBase: 300 * time.Millisecond, PollSlack: 300 * time.Millisecond})
	blobPath := func(content string) string { return fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha(content)) }

	t.Run("cuts off an upload whose body stalls", func(t *testing.T) {
		conn, err := net.Dial("tcp", srv.Listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer %s\r\nContent-Length: 1000\r\n\r\nonly a few bytes", blobPath("slow"), f.a.token)
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		res, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatalf("the server did not answer: %v", err)
		}
		defer res.Body.Close()
		if res.StatusCode != 408 {
			t.Fatalf("%d", res.StatusCode)
		}
		if f.store.Blobs.Received(f.v, sha("slow")) != 0 {
			t.Fatal("a stalled upload left bytes behind")
		}
	})

	t.Run("lets a normal upload and download through", func(t *testing.T) {
		req, _ := http.NewRequest("PUT", srv.URL+blobPath("hello"), strings.NewReader("hello"))
		req.Header.Set("Authorization", "Bearer "+f.a.token)
		res, err := http.DefaultClient.Do(req)
		if err != nil || res.StatusCode != 201 {
			t.Fatalf("%v %v", res, err)
		}
		res.Body.Close()
		req, _ = http.NewRequest("GET", srv.URL+blobPath("hello"), nil)
		req.Header.Set("Authorization", "Bearer "+f.a.token)
		res, err = http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if string(got) != "hello" {
			t.Fatalf("%q", got)
		}
	})

	t.Run("lets a long poll wait longer than the transfer allowance", func(t *testing.T) {
		req, _ := http.NewRequest("GET", fmt.Sprintf("%s/v1/vaults/%s/state?since=%d&wait=1", srv.URL, f.v, f.seq()), nil)
		req.Header.Set("Authorization", "Bearer "+f.a.token)
		start := time.Now()
		res, err := http.DefaultClient.Do(req)
		if err != nil || res.StatusCode != 200 {
			t.Fatalf("%v %v", res, err)
		}
		res.Body.Close()
		if time.Since(start) < 900*time.Millisecond {
			t.Fatalf("answered after %v, before the wait was over", time.Since(start))
		}
	})
}
