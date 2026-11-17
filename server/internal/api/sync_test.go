package api

import (
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0xVexor/Nevis/server/internal/config"
)

// fixture is a server with one account and one vault.
type fixture struct {
	*env
	a user
	v string
}

func newFixture(t *testing.T, tweak ...func(*config.Config)) *fixture {
	e := newEnv(t, tweak...)
	a := e.register("alice")
	return &fixture{env: e, a: a, v: e.newVault(a.token, "notes")}
}

func (f *fixture) commitOps(ops []op, extra ...J) reply {
	return f.commit(f.a.token, f.v, ops, extra...)
}

func (f *fixture) files(since int64) []J {
	return f.changes(f.a.token, f.v, since, 500).body.list("files")
}

func (f *fixture) seq() int64 { return f.state(f.a.token, f.v).num("seq") }

// result is the i-th result of a commit reply.
func result(r reply, i int) J { return r.body.list("results")[i] }

func oks(r reply) []bool {
	var out []bool
	for _, x := range r.body.list("results") {
		out = append(out, x.flag("ok"))
	}
	return out
}

func TestVaultsAndCommits(t *testing.T) {
	t.Run("creates a vault once, and answers the same vault when asked again", func(t *testing.T) {
		f := newFixture(t)
		again := f.call("POST", "/v1/vaults", opts{token: f.a.token, json: J{"id": f.v, "name": "notes"}})
		if again.status != 200 || again.body.flag("created") {
			t.Fatalf("%d %v", again.status, again.body)
		}
		if list := f.call("GET", "/v1/vaults", opts{token: f.a.token}); len(list.body.list("vaults")) != 1 {
			t.Fatalf("%v", list.body)
		}
	})

	t.Run("keeps vaults of different users apart, and does not reveal that they exist", func(t *testing.T) {
		f := newFixture(t)
		b := f.register("bob")
		if r := f.call("GET", "/v1/vaults/"+f.v+"/state", opts{token: b.token}); r.status != 404 {
			t.Fatalf("%d", r.status)
		}
		if r := f.changes(b.token, f.v, 0, 500); r.status != 404 {
			t.Fatalf("%d", r.status)
		}
		take := f.call("POST", "/v1/vaults", opts{token: b.token, json: J{"id": f.v, "name": "mine"}})
		if take.status != 409 || take.body.str("error") != "vault_taken" {
			t.Fatalf("%d %v", take.status, take.body)
		}
		if r := f.call("PUT", fmt.Sprintf("/v1/vaults/%s/blobs/%s", f.v, sha("x")), opts{token: b.token, raw: []byte("x")}); r.status != 404 {
			t.Fatalf("%d", r.status)
		}
		intruder := J{"op_id": "intruder-op-1", "ops": []J{{"op": "delete", "path": "pages/x.json", "base_rev": 0}}}
		if r := f.call("POST", "/v1/vaults/"+f.v+"/commit", opts{token: b.token, json: intruder}); r.status != 404 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("a committed file shows up in the changes with its content hash and a rev", func(t *testing.T) {
		f := newFixture(t)
		r := f.commitOps([]op{put("pages/a.json", `{"t":1}`)})
		if r.status != 200 || !result(r, 0).flag("ok") || result(r, 0).num("rev") != 1 {
			t.Fatalf("%d %v", r.status, r.body)
		}
		list := f.files(0)
		if len(list) != 1 || list[0].str("path") != "pages/a.json" || list[0].str("sha256") != sha(`{"t":1}`) || list[0].flag("deleted") {
			t.Fatalf("%v", list)
		}
		if list[0].str("md5") != md5hex(`{"t":1}`) || list[0].num("size") != 7 || list[0].str("by_device") != f.a.deviceID {
			t.Fatalf("%v", list[0])
		}
		if f.writes.Load() == 0 {
			t.Fatal("a backup was not scheduled")
		}
	})

	t.Run("answers a repeated op_id with the same result and changes nothing twice", func(t *testing.T) {
		f := newFixture(t)
		blob := f.putBlob(f.a.token, f.v, "one")
		body := J{"op_id": "same-operation-1", "ops": []J{{"op": "put", "path": "pages/a.json", "sha256": blob, "base_rev": 0}}}
		first := f.call("POST", "/v1/vaults/"+f.v+"/commit", opts{token: f.a.token, json: body})
		second := f.call("POST", "/v1/vaults/"+f.v+"/commit", opts{token: f.a.token, json: body})
		if result(first, 0).num("rev") != 1 || result(second, 0).num("rev") != 1 || !second.body.flag("replay") || first.body.flag("replay") {
			t.Fatalf("%v / %v", first.body, second.body)
		}
		if f.seq() != 1 {
			t.Fatal("the repeat changed something")
		}
	})

	t.Run("refuses a write based on an old rev and shows the current state instead (compare and swap)", func(t *testing.T) {
		f := newFixture(t)
		first := f.commitOps([]op{put("pages/a.json", "v1")})
		rev1 := result(first, 0).num("rev")
		phone := f.commitOps([]op{put("pages/a.json", "phone edit", rev1)})
		if !result(phone, 0).flag("ok") {
			t.Fatalf("%v", phone.body)
		}
		laptop := f.commitOps([]op{put("pages/a.json", "laptop edit", rev1)})
		r := result(laptop, 0)
		if r.flag("ok") || r.str("error") != "conflict" || r.obj("current").str("sha256") != sha("phone edit") || r.obj("current").num("rev") != result(phone, 0).num("rev") {
			t.Fatalf("%v", r)
		}
		if f.files(0)[0].str("sha256") != sha("phone edit") {
			t.Fatal("something was overwritten")
		}
	})

	t.Run("accepts a second write of identical content as a no-op even if its base is stale", func(t *testing.T) {
		f := newFixture(t)
		first := f.commitOps([]op{put("pages/a.json", "same")})
		f.commitOps([]op{put("pages/a.json", "newer", result(first, 0).num("rev"))})
		r := result(f.commitOps([]op{put("pages/a.json", "newer", 1)}), 0)
		if !r.flag("ok") || !r.flag("noop") {
			t.Fatalf("%v", r)
		}
	})

	t.Run("a path that exists cannot be created again from nothing", func(t *testing.T) {
		f := newFixture(t)
		f.commitOps([]op{put("pages/a.json", "v1")})
		if r := result(f.commitOps([]op{put("pages/a.json", "other", 0)}), 0); r.str("error") != "conflict" {
			t.Fatalf("%v", r)
		}
	})

	t.Run("a delete is a tombstone with its own rev, and a stale delete does not remove a newer edit", func(t *testing.T) {
		f := newFixture(t)
		created := f.commitOps([]op{put("pages/a.json", "v1")})
		rev1 := result(created, 0).num("rev")
		edited := f.commitOps([]op{put("pages/a.json", "v2", rev1)})
		stale := f.commitOps([]op{del("pages/a.json", rev1)})
		if result(stale, 0).str("error") != "conflict" || f.files(0)[0].flag("deleted") {
			t.Fatalf("%v", stale.body)
		}
		d := f.commitOps([]op{del("pages/a.json", result(edited, 0).num("rev"))})
		if !result(d, 0).flag("ok") {
			t.Fatalf("%v", d.body)
		}
		file := f.files(0)[0]
		if !file.flag("deleted") || file.num("rev") != result(d, 0).num("rev") || file.str("sha256") != "" {
			t.Fatalf("%v", file)
		}
	})

	t.Run("an edit made before another device deleted the file brings it back, and deleting twice is harmless", func(t *testing.T) {
		f := newFixture(t)
		created := f.commitOps([]op{put("pages/a.json", "v1")})
		rev1 := result(created, 0).num("rev")
		f.commitOps([]op{del("pages/a.json", rev1)})
		stale := result(f.commitOps([]op{put("pages/a.json", "edit after", rev1)}), 0)
		if stale.str("error") != "conflict" || !stale.obj("current").flag("deleted") {
			t.Fatalf("%v", stale)
		}
		back := f.commitOps([]op{put("pages/a.json", "edit after", 0)})
		if !result(back, 0).flag("ok") || f.files(0)[0].flag("deleted") {
			t.Fatalf("%v", back.body)
		}
		backRev := result(back, 0).num("rev")
		del1, del2 := result(f.commitOps([]op{del("pages/a.json", backRev)}), 0), result(f.commitOps([]op{del("pages/a.json", backRev)}), 0)
		if !del1.flag("ok") || !del2.flag("ok") || !del2.flag("noop") {
			t.Fatalf("%v / %v", del1, del2)
		}
	})

	t.Run("an atomic commit applies everything or nothing", func(t *testing.T) {
		f := newFixture(t)
		first := f.commitOps([]op{put("pages/a.json", "v1")})
		r := f.commitOps([]op{put("pages/b.json", "new"), put("pages/a.json", "stale", 0)}, J{"atomic": true})
		if !reflect.DeepEqual(oks(r), []bool{false, false}) {
			t.Fatalf("%v", r.body)
		}
		if result(r, 0).str("error") != "not_applied" || result(r, 1).str("error") != "conflict" {
			t.Fatalf("%v", r.body)
		}
		if len(f.files(0)) != 1 || f.seq() != first.body.num("seq") {
			t.Fatal("something was applied")
		}
		again := f.commitOps([]op{put("pages/b.json", "new"), put("pages/c.json", "new")}, J{"atomic": true})
		if !reflect.DeepEqual(oks(again), []bool{true, true}) {
			t.Fatalf("%v", again.body)
		}
	})

	t.Run("without atomic, the ops that fit are applied and the others report why not", func(t *testing.T) {
		f := newFixture(t)
		f.commitOps([]op{put("pages/a.json", "v1")})
		r := f.commitOps([]op{put("pages/b.json", "new"), put("pages/a.json", "stale", 0)})
		if !reflect.DeepEqual(oks(r), []bool{true, false}) {
			t.Fatalf("%v", r.body)
		}
	})

	t.Run("refuses to commit content that was never uploaded", func(t *testing.T) {
		f := newFixture(t)
		body := J{"op_id": "no-blob-here-1", "ops": []J{{"op": "put", "path": "pages/a.json", "sha256": sha("ghost"), "base_rev": 0}}}
		r := f.call("POST", "/v1/vaults/"+f.v+"/commit", opts{token: f.a.token, json: body})
		if result(r, 0).str("error") != "blob_missing" {
			t.Fatalf("%v", r.body)
		}
	})

	t.Run("refuses paths that are outside the vault, unsafe on another system, or equal when letters are folded", func(t *testing.T) {
		f := newFixture(t)
		for _, bad := range []string{"../x", "/abs", "other/a.json", "pages/CON", "pages/a:b", `pages/a\b`, "pages//a", "pages/a.", "pages/.x.tmp", "pages"} {
			if r := result(f.commitOps([]op{put(bad, "x")}), 0); r.str("error") != "bad_path" {
				t.Errorf("%s: %v", bad, r)
			}
		}
		if r := result(f.commitOps([]op{put(".nevis/vault.json", "{}")}), 0); !r.flag("ok") {
			t.Errorf("the vault marker: %v", r)
		}
		if r := result(f.commitOps([]op{put("pages/Abc.json", "x")}), 0); !r.flag("ok") {
			t.Errorf("%v", r)
		}
		if r := result(f.commitOps([]op{put("pages/aBC.json", "x")}), 0); r.str("error") != "path_case_clash" || r.str("detail") != "pages/Abc.json" {
			t.Errorf("%v", r)
		}
	})

	t.Run("accepts database records, which the desktop client syncs", func(t *testing.T) {
		f := newFixture(t)
		if r := result(f.commitOps([]op{put("databases/views/view1.json", `{"id":"view1"}`)}), 0); !r.flag("ok") {
			t.Fatalf("%v", r)
		}
		if r := result(f.commitOps([]op{put("databases/views/deeper/view1.json", "{}")}), 0); r.str("detail") != "bad_database_path" {
			t.Fatalf("%v", r)
		}
	})

	t.Run("a bad request is a 400, not a crash", func(t *testing.T) {
		f := newFixture(t)
		if r := f.call("POST", "/v1/vaults/"+f.v+"/commit", opts{token: f.a.token, json: J{"op_id": "x", "ops": []J{}}}); r.status != 400 {
			t.Fatalf("%d", r.status)
		}
		r2 := f.call("POST", "/v1/vaults/"+f.v+"/commit", opts{token: f.a.token, json: J{"op_id": "long-enough-id", "ops": []any{nil, 5, J{"op": "launch"}}}})
		var codes []string
		for _, x := range r2.body.list("results") {
			codes = append(codes, x.str("error"))
		}
		if !reflect.DeepEqual(codes, []string{"bad_op", "bad_op", "bad_op"}) {
			t.Fatalf("%v", r2.body)
		}
		if r := f.call("POST", "/v1/vaults/"+f.v+"/commit", opts{token: f.a.token, headers: map[string]string{"Content-Type": "application/json"}, raw: []byte("{not json")}); r.status != 400 || r.body.str("error") != "bad_request" {
			t.Fatalf("%d %v", r.status, r.body)
		}
	})

	t.Run("holds back a mass deletion unless the client confirms it", func(t *testing.T) {
		f := newFixture(t)
		var puts []op
		for i := range 12 {
			puts = append(puts, put(fmt.Sprintf("pages/p%d.json", i), fmt.Sprintf("page %d", i)))
		}
		made := f.commitOps(puts)
		var dels []op
		for i, r := range made.body.list("results") {
			dels = append(dels, del(fmt.Sprintf("pages/p%d.json", i), r.num("rev")))
		}
		refused := f.commitOps(dels)
		for _, r := range refused.body.list("results") {
			if r.str("error") != "bulk_delete" {
				t.Fatalf("%v", refused.body)
			}
		}
		live := 0
		for _, file := range f.files(0) {
			if !file.flag("deleted") {
				live++
			}
		}
		if live != 12 {
			t.Fatalf("%d files left", live)
		}
		if r := f.commitOps(dels[:2]); !allOK(r) {
			t.Fatalf("a few deletes are fine: %v", r.body)
		}
		if r := f.commitOps(dels[2:], J{"confirm_bulk": true}); !allOK(r) {
			t.Fatalf("%v", r.body)
		}
	})

	t.Run("pages through the changes in the order they happened", func(t *testing.T) {
		f := newFixture(t)
		for i := range 5 {
			f.commitOps([]op{put(fmt.Sprintf("pages/p%d.json", i), fmt.Sprintf("page %d", i))})
		}
		one := f.changes(f.a.token, f.v, 0, 2).body
		files1 := one.list("files")
		if len(files1) != 2 || !one.flag("has_more") || one.num("next") != files1[1].num("rev") {
			t.Fatalf("%v", one)
		}
		two := f.changes(f.a.token, f.v, one.num("next"), 2).body
		three := f.changes(f.a.token, f.v, two.num("next"), 2).body
		var paths []string
		for _, page := range []J{one, two, three} {
			for _, file := range page.list("files") {
				paths = append(paths, file.str("path"))
			}
		}
		if !reflect.DeepEqual(paths, []string{"pages/p0.json", "pages/p1.json", "pages/p2.json", "pages/p3.json", "pages/p4.json"}) {
			t.Fatalf("%v", paths)
		}
		if three.flag("has_more") || three.num("next") != three.num("head") {
			t.Fatalf("%v", three)
		}
		empty := f.changes(f.a.token, f.v, three.num("head"), 500).body
		if files, ok := empty["files"].([]any); !ok || len(files) != 0 {
			t.Fatalf("nothing new must be an empty list, not null: %v", empty)
		}
	})

	t.Run("a file that changed twice appears once, with its latest rev", func(t *testing.T) {
		f := newFixture(t)
		first := f.commitOps([]op{put("pages/a.json", "v1")})
		f.commitOps([]op{put("pages/b.json", "b")})
		f.commitOps([]op{put("pages/a.json", "v2", result(first, 0).num("rev"))})
		var got []string
		for _, file := range f.files(0) {
			got = append(got, fmt.Sprintf("%s@%d", file.str("path"), file.num("rev")))
		}
		if !reflect.DeepEqual(got, []string{"pages/b.json@2", "pages/a.json@3"}) {
			t.Fatalf("%v", got)
		}
	})

	t.Run("serves the content of an old revision and can put it back", func(t *testing.T) {
		f := newFixture(t)
		first := f.commitOps([]op{put("pages/a.json", "first version")})
		rev1 := result(first, 0).num("rev")
		second := f.commitOps([]op{put("pages/a.json", "second version", rev1)})
		old := f.call("GET", fmt.Sprintf("/v1/vaults/%s/rev/%d", f.v, rev1), opts{token: f.a.token})
		if string(old.raw) != "first version" {
			t.Fatalf("%q", old.raw)
		}
		hist := f.call("GET", "/v1/vaults/"+f.v+"/revisions?path=pages/a.json", opts{token: f.a.token})
		var revs []int64
		for _, r := range hist.body.list("revisions") {
			revs = append(revs, r.num("rev"))
		}
		if !reflect.DeepEqual(revs, []int64{result(second, 0).num("rev"), rev1}) {
			t.Fatalf("%v", revs)
		}
		back := f.call("POST", "/v1/vaults/"+f.v+"/restore", opts{token: f.a.token, json: J{"path": "pages/a.json", "rev": rev1}})
		if !back.body.flag("ok") || back.body.num("seq") != 3 {
			t.Fatalf("%v", back.body)
		}
		if f.files(0)[0].str("sha256") != sha("first version") {
			t.Fatal("not put back")
		}
		if r := f.call("POST", "/v1/vaults/"+f.v+"/restore", opts{token: f.a.token, json: J{"path": "pages/a.json", "rev": 999}}); r.status != 404 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("answers for one path as it is right now, tombstones included", func(t *testing.T) {
		f := newFixture(t)
		q := func(p string) reply {
			return f.call("GET", "/v1/vaults/"+f.v+"/file?path="+p, opts{token: f.a.token})
		}
		if r := q("pages/a.json"); r.status != 404 || r.body.str("error") != "no_such_file" {
			t.Fatalf("%d %v", r.status, r.body)
		}
		made := f.commitOps([]op{put("pages/a.json", "x")})
		if q("pages/a.json").body.obj("file").str("sha256") != sha("x") {
			t.Fatal("sha")
		}
		f.commitOps([]op{del("pages/a.json", result(made, 0).num("rev"))})
		if !q("pages/a.json").body.obj("file").flag("deleted") {
			t.Fatal("tombstone")
		}
	})

	t.Run("the state has a root hash that changes with the content and not with the order of events", func(t *testing.T) {
		f := newFixture(t)
		r0 := f.state(f.a.token, f.v).str("root")
		f.commitOps([]op{put("pages/a.json", "a"), put("pages/b.json", "b")})
		r1 := f.state(f.a.token, f.v).str("root")
		w := f.newVault(f.a.token, "other")
		f.commit(f.a.token, w, []op{put("pages/b.json", "b")})
		f.commit(f.a.token, w, []op{put("pages/a.json", "a")})
		r2 := f.state(f.a.token, w).str("root")
		if r0 == r1 || r1 != r2 {
			t.Fatalf("%s %s %s", r0, r1, r2)
		}
		// the value the desktop client pins for these two files (hub.rs, root_of)
		if r1 != "9ee351a4056cc95744c24c1693184bc11988f3dc98bb1a2dc86136caabca773d" {
			t.Fatalf("root hash %s", r1)
		}
	})

	t.Run("trashing a vault hides it, and it can be brought back", func(t *testing.T) {
		f := newFixture(t)
		f.commitOps([]op{put("pages/a.json", "a")})
		if r := f.call("DELETE", "/v1/vaults/"+f.v, opts{token: f.a.token}); r.status != 200 {
			t.Fatalf("%d", r.status)
		}
		if r := f.call("GET", "/v1/vaults/"+f.v+"/state", opts{token: f.a.token}); r.status != 404 {
			t.Fatalf("%d", r.status)
		}
		if n := len(f.call("GET", "/v1/vaults", opts{token: f.a.token}).body.list("vaults")); n != 0 {
			t.Fatalf("%d", n)
		}
		if n := len(f.call("GET", "/v1/vaults?trashed=1", opts{token: f.a.token}).body.list("vaults")); n != 1 {
			t.Fatalf("%d", n)
		}
		if r := f.call("POST", "/v1/vaults", opts{token: f.a.token, json: J{"id": f.v, "name": "x"}}); r.body.str("error") != "vault_deleted" {
			t.Fatalf("%v", r.body)
		}
		if r := f.call("POST", "/v1/vaults/"+f.v+"/undelete", opts{token: f.a.token}); r.status != 200 {
			t.Fatalf("%d", r.status)
		}
		if len(f.files(0)) != 1 {
			t.Fatal("the files did not come back")
		}
	})

	t.Run("limits the number of vaults per account", func(t *testing.T) {
		f := newFixture(t, func(c *config.Config) { c.MaxVaults = 2 })
		f.newVault(f.a.token, "two")
		r := f.call("POST", "/v1/vaults", opts{token: f.a.token, json: J{"name": "three"}})
		if r.status != 403 || r.body.str("error") != "too_many_vaults" || r.body.num("limit") != 2 {
			t.Fatalf("%d %v", r.status, r.body)
		}
	})

	t.Run("renames a vault", func(t *testing.T) {
		f := newFixture(t)
		if r := f.call("PATCH", "/v1/vaults/"+f.v, opts{token: f.a.token, json: J{"name": "  Journal  "}}); r.status != 200 {
			t.Fatalf("%d", r.status)
		}
		if f.state(f.a.token, f.v).str("name") != "Journal" {
			t.Fatal("name")
		}
		if r := f.call("PATCH", "/v1/vaults/"+f.v, opts{token: f.a.token, json: J{"name": "   "}}); r.body.str("error") != "bad_name" {
			t.Fatalf("%v", r.body)
		}
	})
}

func allOK(r reply) bool {
	for _, ok := range oks(r) {
		if !ok {
			return false
		}
	}
	return true
}

func TestInstantNotification(t *testing.T) {
	// longPoll starts a request in the background; its answer comes back on the channel (never t.Fatal off the test goroutine)
	longPoll := func(f *fixture, since, wait int) <-chan reply {
		out := make(chan reply, 1)
		go func() {
			out <- f.call("GET", fmt.Sprintf("/v1/vaults/%s/state?since=%d&wait=%d", f.v, since, wait), opts{token: f.a.token})
		}()
		return out
	}
	waiting := func(t *testing.T, f *fixture, n int) {
		t.Helper()
		for deadline := time.Now().Add(2 * time.Second); f.hub.Size() < n; {
			if time.Now().After(deadline) {
				t.Fatalf("only %d requests are waiting, want %d", f.hub.Size(), n)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}

	t.Run("answers a waiting request the moment another device commits", func(t *testing.T) {
		f := newFixture(t)
		start := time.Now()
		poll := longPoll(f, 0, 20)
		waiting(t, f, 1)
		f.commitOps([]op{put("pages/a.json", "hello")})
		r := <-poll
		if r.body.num("seq") != 1 || time.Since(start) > 2*time.Second {
			t.Fatalf("%v after %v", r.body, time.Since(start))
		}
		if f.hub.Size() != 0 {
			t.Fatal("the waiter was not removed")
		}
	})

	t.Run("answers at once when the vault is already past `since`, and after the wait when nothing happens", func(t *testing.T) {
		f := newFixture(t)
		f.commitOps([]op{put("pages/a.json", "hello")})
		t0 := time.Now()
		if r := <-longPoll(f, 0, 20); r.body.num("seq") != 1 || time.Since(t0) > 500*time.Millisecond {
			t.Fatalf("%v after %v", r.body, time.Since(t0))
		}
		t1 := time.Now()
		idle := <-longPoll(f, 1, 1)
		if idle.body.num("seq") != 1 || time.Since(t1) < 900*time.Millisecond {
			t.Fatalf("%v after %v", idle.body, time.Since(t1))
		}
	})

	t.Run("wakes every waiting device, not just one", func(t *testing.T) {
		f := newFixture(t)
		polls := []<-chan reply{longPoll(f, 0, 20), longPoll(f, 0, 20), longPoll(f, 0, 20)}
		waiting(t, f, 3)
		f.commitOps([]op{put("pages/a.json", "hello")})
		for _, p := range polls {
			if r := <-p; r.body.num("seq") != 1 {
				t.Fatalf("%v", r.body)
			}
		}
	})

	t.Run("a commit that changed nothing does not wake anyone", func(t *testing.T) {
		f := newFixture(t)
		f.commitOps([]op{put("pages/a.json", "hello")})
		poll := longPoll(f, 1, 1)
		waiting(t, f, 1)
		noop := f.commitOps([]op{put("pages/a.json", "hello", 1)})
		if !result(noop, 0).flag("noop") {
			t.Fatalf("%v", noop.body)
		}
		t0 := time.Now()
		<-poll
		if time.Since(t0) < 500*time.Millisecond {
			t.Fatal("it did not keep waiting")
		}
	})

	t.Run("a vault that is trashed while a device waits answers 404 at once", func(t *testing.T) {
		f := newFixture(t)
		poll := longPoll(f, 0, 20)
		waiting(t, f, 1)
		f.call("DELETE", "/v1/vaults/"+f.v, opts{token: f.a.token})
		if r := <-poll; r.status != 404 {
			t.Fatalf("%d %v", r.status, r.body)
		}
	})

	t.Run("releasing the hub (shutdown) lets waiting devices go with the current state", func(t *testing.T) {
		f := newFixture(t)
		poll := longPoll(f, 0, 20)
		waiting(t, f, 1)
		start := time.Now()
		f.hub.ReleaseAll()
		if r := <-poll; r.status != 200 || time.Since(start) > time.Second {
			t.Fatalf("%d after %v", r.status, time.Since(start))
		}
	})

	t.Run("many waiters and commits at once stay consistent", func(t *testing.T) {
		f := newFixture(t)
		var wg sync.WaitGroup
		results := make(chan int64, 20)
		for range 10 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results <- f.call("GET", fmt.Sprintf("/v1/vaults/%s/state?since=0&wait=10", f.v), opts{token: f.a.token}).body.num("seq")
			}()
		}
		waiting(t, f, 10)
		for i := range 5 {
			if r := f.commitOps([]op{put(fmt.Sprintf("pages/p%d.json", i), strings.Repeat("x", i+1))}); r.status != 200 {
				t.Fatalf("%d", r.status)
			}
		}
		wg.Wait()
		close(results)
		for seq := range results {
			if seq < 1 {
				t.Fatalf("a waiter was answered without news: seq %d", seq)
			}
		}
		if f.seq() != 5 {
			t.Fatalf("seq %d", f.seq())
		}
	})
}
