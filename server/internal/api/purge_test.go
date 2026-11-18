package api

import "testing"

func TestPurgeVault(t *testing.T) {
	const pw = "correct horse battery"
	purge := func(f *fixture, token, vault string, body any) reply {
		return f.call("POST", "/v1/vaults/"+vault+"/purge", opts{token: token, json: body})
	}
	trashed := func(t *testing.T) *fixture {
		f := newFixture(t)
		f.commitOps([]op{put("pages/a.json", "hello")})
		if r := f.call("DELETE", "/v1/vaults/"+f.v, opts{token: f.a.token}); r.status != 200 {
			t.Fatalf("trash %d", r.status)
		}
		return f
	}
	used := func(f *fixture) int64 {
		return f.call("GET", "/v1/account", opts{token: f.a.token}).body.obj("quota").num("used")
	}

	t.Run("removes a trashed vault with its blobs and frees the quota", func(t *testing.T) {
		f := trashed(t)
		if used(f) == 0 {
			t.Fatal("expected stored bytes")
		}
		r := purge(f, f.a.token, f.v, J{"password": pw})
		if r.status != 200 || !r.body.flag("ok") || r.body.num("files") != 1 || r.body.num("bytes") != 5 {
			t.Fatalf("%d %v", r.status, r.body)
		}
		if f.store.Blobs.Has(f.v, sha("hello")) {
			t.Fatal("the blob was not removed")
		}
		if count(t, f.env, "vaults") != 0 || count(t, f.env, "blobs") != 0 || count(t, f.env, "files") != 0 {
			t.Fatal("rows left")
		}
		if used(f) != 0 {
			t.Fatal("quota not freed")
		}
		if r := purge(f, f.a.token, f.v, J{"password": pw}); r.status != 404 {
			t.Fatalf("a second purge: %d", r.status)
		}
	})

	t.Run("refuses a live vault and removes nothing", func(t *testing.T) {
		f := newFixture(t)
		f.commitOps([]op{put("pages/a.json", "hello")})
		r := purge(f, f.a.token, f.v, J{"password": pw})
		if r.status != 409 || r.body.str("error") != "not_in_trash" {
			t.Fatalf("%d %v", r.status, r.body)
		}
		if !f.store.Blobs.Has(f.v, sha("hello")) || count(t, f.env, "vaults") != 1 {
			t.Fatal("something was removed")
		}
	})

	t.Run("refuses a wrong password and removes nothing", func(t *testing.T) {
		f := trashed(t)
		for _, body := range []any{J{"password": "wrong"}, J{}} {
			if r := purge(f, f.a.token, f.v, body); r.status != 401 || r.body.str("error") != "bad_credentials" {
				t.Fatalf("%d %v", r.status, r.body)
			}
		}
		if r := purge(f, "", f.v, J{"password": pw}); r.status != 401 {
			t.Fatalf("no token: %d", r.status)
		}
		if !f.store.Blobs.Has(f.v, sha("hello")) || count(t, f.env, "vaults") != 1 {
			t.Fatal("something was removed")
		}
	})

	t.Run("does not touch another account's trashed vault", func(t *testing.T) {
		f := trashed(t)
		bob := f.register("bob")
		r := purge(f, bob.token, f.v, J{"password": "correct horse battery"})
		if r.status != 404 || r.body.str("error") != "no_such_vault" {
			t.Fatalf("%d %v", r.status, r.body)
		}
		if r := purge(f, bob.token, "no-such-vault-id", J{"password": pw}); r.status != 404 {
			t.Fatalf("unknown id: %d", r.status)
		}
		if !f.store.Blobs.Has(f.v, sha("hello")) || count(t, f.env, "vaults") != 1 {
			t.Fatal("something was removed")
		}
	})

	t.Run("counts wrong passwords like account deletion and locks out", func(t *testing.T) {
		f := trashed(t)
		for i := range 10 {
			if r := purge(f, f.a.token, f.v, J{"password": "wrong"}); r.status != 401 {
				t.Fatalf("attempt %d: %d", i, r.status)
			}
		}
		r := purge(f, f.a.token, f.v, J{"password": pw})
		if r.status != 429 || r.header.Get("Retry-After") == "" {
			t.Fatalf("%d", r.status)
		}
		if count(t, f.env, "vaults") != 1 {
			t.Fatal("removed while locked out")
		}
	})

	t.Run("a purged vault cannot be restored", func(t *testing.T) {
		f := trashed(t)
		purge(f, f.a.token, f.v, J{"password": pw})
		if r := f.call("POST", "/v1/vaults/"+f.v+"/undelete", opts{token: f.a.token}); r.status != 404 {
			t.Fatalf("%d", r.status)
		}
	})
}
