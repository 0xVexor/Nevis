package api

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0xVexor/Nevis/server/internal/db"
)

func count(t *testing.T, e *env, table string) int {
	t.Helper()
	var n int
	if err := e.db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestHousekeeping(t *testing.T) {
	t.Run("keeps a deleted file for the retention period and then forgets it; older devices must start over", func(t *testing.T) {
		f := newFixture(t)
		made := f.commitOps([]op{put("pages/a.json", "a"), put("pages/b.json", "b")})
		f.commitOps([]op{del("pages/a.json", result(made, 0).num("rev"))})
		if st := f.housekeeping(10 * day); st.Tombstones != 0 {
			t.Fatalf("%+v", st)
		}
		if len(f.files(0)) != 2 {
			t.Fatal("the tombstone was dropped early")
		}
		if st := f.housekeeping(31 * day); st.Tombstones != 1 {
			t.Fatalf("%+v", st)
		}
		if ok := f.changes(f.a.token, f.v, 3, 500); ok.status != 200 { // a device that was online recently is fine
			t.Fatalf("%d", ok.status)
		}
		old := f.changes(f.a.token, f.v, 1, 500) // one that was away longer cannot know what was deleted
		if old.status != 410 || old.body.str("error") != "since_too_old" || old.body.str("epoch") == "" || old.body.num("compacted") != 3 {
			t.Fatalf("%d %v", old.status, old.body)
		}
	})

	t.Run("a device starting over (since 0) pages through a compacted vault without ever being told to start over", func(t *testing.T) {
		f := newFixture(t)
		made := f.commitOps([]op{put("pages/a.json", "a"), put("pages/b.json", "b"), put("pages/c.json", "c"), put("pages/d.json", "d")})
		f.commitOps([]op{del("pages/a.json", result(made, 0).num("rev"))}) // rev 5
		if st := f.housekeeping(31 * day); st.Tombstones != 1 {
			t.Fatalf("%+v", st)
		}
		f.commitOps([]op{put("pages/e.json", "e"), put("pages/f.json", "f")})
		seen := map[string]bool{}
		since := int64(0)
		for pages := 0; ; pages++ {
			if pages > 10 {
				t.Fatal("paging does not end")
			}
			r := f.changes(f.a.token, f.v, since, 1)
			if r.status != 200 {
				t.Fatalf("since %d: %d %v", since, r.status, r.body)
			}
			for _, file := range r.body.list("files") {
				if file.flag("deleted") {
					t.Fatalf("a tombstone was sent: %v", file)
				}
				seen[file.str("path")] = true
			}
			if !r.body.flag("has_more") {
				break
			}
			if next := r.body.num("next"); next <= since {
				t.Fatalf("no progress: %d after %d", next, since)
			} else {
				since = next
			}
		}
		if len(seen) != 5 || seen["pages/a.json"] || !seen["pages/b.json"] || !seen["pages/f.json"] {
			t.Fatalf("%v", seen)
		}
	})

	t.Run("a snapshot read pages through the live files in path order, whatever was compacted", func(t *testing.T) {
		f := newFixture(t)
		made := f.commitOps([]op{put("pages/a.json", "a"), put("pages/b.json", "b"), put("pages/c.json", "c"), put("pages/d.json", "d")})
		f.commitOps([]op{del("pages/a.json", result(made, 0).num("rev"))})
		if st := f.housekeeping(31 * day); st.Tombstones != 1 {
			t.Fatalf("%+v", st)
		}
		f.commitOps([]op{put("pages/g.json", "g"), put("pages/f.json", "f")})
		f.commitOps([]op{del("pages/c.json", result(made, 2).num("rev"))}) // a tombstone that is still there
		want := []string{"pages/b.json", "pages/d.json", "pages/f.json", "pages/g.json"}
		if old := f.changes(f.a.token, f.v, 1, 500); old.status != 410 {
			t.Fatalf("since 1 should be too old: %d", old.status)
		}
		snap := func(after string, limit int) reply {
			url := fmt.Sprintf("/v1/vaults/%s/changes?snapshot=1&since=1&limit=%d&after=%s", f.v, limit, after)
			return f.call("GET", url, opts{token: f.a.token})
		}
		for _, limit := range []int{1, 2, 3, 500} {
			var got []string
			after := ""
			for pages := 0; ; pages++ {
				if pages > 10 {
					t.Fatal("paging does not end")
				}
				r := snap(after, limit)
				if r.status != 200 {
					t.Fatalf("limit %d after %q: %d %v", limit, after, r.status, r.body)
				}
				if r.body.num("seq") != f.seq() {
					t.Fatalf("seq %d, want %d", r.body.num("seq"), f.seq())
				}
				files := r.body.list("files")
				if len(files) > limit {
					t.Fatalf("limit %d: %d files", limit, len(files))
				}
				for _, file := range files {
					if file.flag("deleted") {
						t.Fatalf("a tombstone was sent: %v", file)
					}
					got = append(got, file.str("path"))
				}
				if !r.body.flag("has_more") {
					if r.body.str("next_after") != "" {
						t.Fatalf("next_after %q on the last page", r.body.str("next_after"))
					}
					break
				}
				if r.body.str("next_after") != files[len(files)-1].str("path") {
					t.Fatalf("next_after %q after %v", r.body.str("next_after"), files)
				}
				after = r.body.str("next_after")
			}
			if strings.Join(got, ",") != strings.Join(want, ",") {
				t.Fatalf("limit %d: %v, want %v", limit, got, want)
			}
		}
	})

	t.Run("a snapshot read with deleted=1 pages through the tombstones that are still there, in path order", func(t *testing.T) {
		f := newFixture(t)
		made := f.commitOps([]op{put("pages/a.json", "a"), put("pages/b.json", "b"), put("pages/c.json", "c"), put("pages/d.json", "d"), put("pages/e.json", "e")})
		f.commitOps([]op{del("pages/a.json", result(made, 0).num("rev"))})
		if st := f.housekeeping(31 * day); st.Tombstones != 1 { // a is compacted away
			t.Fatalf("%+v", st)
		}
		f.commitOps([]op{del("pages/e.json", result(made, 4).num("rev"))})
		f.commitOps([]op{del("pages/c.json", result(made, 2).num("rev"))})
		want := []string{"pages/c.json", "pages/e.json"}
		for _, limit := range []int{1, 2, 3, 500} {
			var got []string
			after := ""
			for pages := 0; ; pages++ {
				if pages > 10 {
					t.Fatal("paging does not end")
				}
				url := fmt.Sprintf("/v1/vaults/%s/changes?snapshot=1&deleted=1&limit=%d&after=%s", f.v, limit, after)
				r := f.call("GET", url, opts{token: f.a.token})
				if r.status != 200 {
					t.Fatalf("limit %d after %q: %d %v", limit, after, r.status, r.body)
				}
				if r.body.num("seq") != f.seq() || r.body.num("head") != f.seq() {
					t.Fatalf("seq %d head %d, want %d", r.body.num("seq"), r.body.num("head"), f.seq())
				}
				files := r.body.list("files")
				if len(files) > limit {
					t.Fatalf("limit %d: %d files", limit, len(files))
				}
				for _, file := range files {
					if !file.flag("deleted") {
						t.Fatalf("a live file was sent: %v", file)
					}
					got = append(got, file.str("path"))
				}
				if !r.body.flag("has_more") {
					if r.body.str("next_after") != "" {
						t.Fatalf("next_after %q on the last page", r.body.str("next_after"))
					}
					break
				}
				if r.body.str("next_after") != files[len(files)-1].str("path") {
					t.Fatalf("next_after %q after %v", r.body.str("next_after"), files)
				}
				after = r.body.str("next_after")
			}
			if strings.Join(got, ",") != strings.Join(want, ",") {
				t.Fatalf("limit %d: %v, want %v", limit, got, want)
			}
		}
	})

	t.Run("removes old revisions and blobs nothing refers to any more, but not the current ones", func(t *testing.T) {
		f := newFixture(t)
		first := f.commitOps([]op{put("pages/a.json", "one")})
		f.commitOps([]op{put("pages/a.json", "two", result(first, 0).num("rev"))})
		orphan := f.putBlob(f.a.token, f.v, "never committed")
		st := f.housekeeping(31 * day)
		if st.Revisions != 1 || st.Blobs != 2 { // 'one' and the orphan
			t.Fatalf("%+v", st)
		}
		for sum, want := range map[string]bool{sha("one"): false, orphan: false, sha("two"): true} {
			if f.store.Blobs.Has(f.v, sum) != want {
				t.Errorf("blob %s on disk: want %v", sum[:8], want)
			}
		}
		if r := f.call("GET", "/v1/vaults/"+f.v+"/rev/"+"1", opts{token: f.a.token}); r.status != 404 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("does not touch a blob that was uploaded a moment ago and is about to be committed", func(t *testing.T) {
		f := newFixture(t)
		f.putBlob(f.a.token, f.v, "in flight")
		if st := f.housekeeping(0); st.Blobs != 0 {
			t.Fatalf("%+v", st)
		}
	})

	t.Run("an old orphan that is uploaded again is not taken by housekeeping before the commit that follows", func(t *testing.T) {
		f := newFixture(t)
		sum := f.putBlob(f.a.token, f.v, "late")
		// by now it counts as an abandoned upload; the client tries again, and the grace period starts anew
		f.clock.advance(2 * day)
		f.putBlob(f.a.token, f.v, "late")
		if st := f.housekeeping(0); st.Blobs != 0 {
			t.Fatalf("%+v", st)
		}
		if !f.store.Blobs.Has(f.v, sum) {
			t.Fatal("the blob was removed under the client")
		}
		r := f.call("POST", "/v1/vaults/"+f.v+"/commit", opts{token: f.a.token, json: J{"op_id": "late-orphan-1", "ops": []J{{"op": "put", "path": "pages/late.json", "sha256": sum, "base_rev": 0}}}})
		if r.status != 200 || !result(r, 0).flag("ok") {
			t.Fatalf("%d %v", r.status, r.body)
		}
		if !f.store.Blobs.Has(f.v, sum) {
			t.Fatal("a live file lost its content")
		}
	})

	t.Run("removes a trashed vault with its blobs after the retention period", func(t *testing.T) {
		f := newFixture(t)
		f.commitOps([]op{put("pages/a.json", "a")})
		f.call("DELETE", "/v1/vaults/"+f.v, opts{token: f.a.token})
		if st := f.housekeeping(5 * day); st.Vaults != 0 {
			t.Fatalf("%+v", st)
		}
		if !f.store.Blobs.Has(f.v, sha("a")) {
			t.Fatal("removed early")
		}
		if st := f.housekeeping(31 * day); st.Vaults != 1 {
			t.Fatalf("%+v", st)
		}
		if f.store.Blobs.Has(f.v, sha("a")) {
			t.Fatal("the blob was not removed")
		}
		if n := count(t, f.env, "files"); n != 0 {
			t.Fatalf("%d files left (foreign keys must cascade)", n)
		}
	})

	t.Run("removes an account that was deleted, with everything in it, once the grace period is over", func(t *testing.T) {
		f := newFixture(t)
		f.commitOps([]op{put("pages/a.json", "a")})
		f.call("DELETE", "/v1/account", opts{token: f.a.token, json: J{"password": "correct horse battery"}})
		if st := f.housekeeping(5 * day); st.Users != 0 {
			t.Fatalf("%+v", st)
		}
		if st := f.housekeeping(31 * day); st.Users != 1 {
			t.Fatalf("%+v", st)
		}
		if f.store.Blobs.Has(f.v, sha("a")) {
			t.Fatal("the blob was not removed")
		}
		if n := count(t, f.env, "users"); n != 0 {
			t.Fatalf("%d users left", n)
		}
		if r := f.login("alice", "correct horse battery", "x"); r.status != 401 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("forgets old answers to repeated commits and used proofs of work", func(t *testing.T) {
		f := newFixture(t)
		f.commitOps([]op{put("pages/a.json", "a")})
		if count(t, f.env, "ops") == 0 || count(t, f.env, "pow_used") == 0 {
			t.Fatal("nothing to forget")
		}
		if st := f.housekeeping(8 * day); st.Ops != 1 {
			t.Fatalf("%+v", st)
		}
		if n := count(t, f.env, "pow_used"); n != 0 {
			t.Fatalf("%d nonces left", n)
		}
	})

	t.Run("sweeps half-finished uploads nobody continued", func(t *testing.T) {
		f := newFixture(t)
		f.call("PUT", "/v1/vaults/"+f.v+"/blobs/"+sha("long content"), opts{token: f.a.token, raw: []byte("long"),
			headers: map[string]string{"Content-Range": "bytes 0-3/12"}})
		// staging files carry the real modification time of the disk, so this one asks as of the real clock
		fresh, err := f.store.Housekeeping(context.Background(), time.Now())
		if err != nil || fresh.Staging != 0 {
			t.Fatalf("%+v %v", fresh, err)
		}
		later, err := f.store.Housekeeping(context.Background(), time.Now().Add(48*time.Hour))
		if err != nil || later.Staging != 1 {
			t.Fatalf("%+v %v", later, err)
		}
	})
}

// The backup is a file copy made while the server runs. These are the Go server's replacement for the old copy of
// the database to S3.
func TestBackup(t *testing.T) {
	snapshot := func(t *testing.T, e *env, dir string, keep int, at time.Time) string {
		t.Helper()
		b := &db.Backups{DB: e.db, Dir: dir, Keep: keep, Now: func() time.Time { return at }}
		path, err := b.Snapshot(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		return path
	}

	t.Run("a copy of the database brings the whole server back on an empty disk, with new epochs", func(t *testing.T) {
		f := newFixture(t)
		f.commitOps([]op{put("pages/a.json", "kept")})
		before := f.state(f.a.token, f.v).str("epoch")
		backup := snapshot(t, f.env, filepath.Join(f.dir, "backup"), 24, time.Date(2026, 10, 25, 10, 20, 0, 0, time.UTC))
		if filepath.Base(backup) != "nevis-20261025T102000Z.db" {
			t.Fatalf("name %s", backup)
		}

		restored := filepath.Join(t.TempDir(), "nevis.db")
		if err := db.Restore(backup, restored); err != nil {
			t.Fatal(err)
		}
		d, err := db.Open(restored)
		if err != nil {
			t.Fatal(err)
		}
		defer d.Close()
		if err := db.NewEpochs(context.Background(), d); err != nil {
			t.Fatal(err)
		}
		var epoch, username string
		var files int
		if err := d.QueryRow("SELECT epoch FROM vaults").Scan(&epoch); err != nil {
			t.Fatal(err)
		}
		_ = d.QueryRow("SELECT COUNT(*) FROM files").Scan(&files)
		_ = d.QueryRow("SELECT username FROM users").Scan(&username)
		if epoch == before || epoch == "" || files != 1 || username != "alice" {
			t.Fatalf("epoch %q (was %q), %d files, user %q", epoch, before, files, username)
		}
	})

	t.Run("keeps only the most recent copies", func(t *testing.T) {
		f := newFixture(t)
		dir := filepath.Join(f.dir, "backup")
		start := time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)
		for i := range 5 {
			snapshot(t, f.env, dir, 3, start.Add(time.Duration(i)*time.Hour))
		}
		all, err := db.List(dir)
		if err != nil || len(all) != 3 {
			t.Fatalf("%v %v", all, err)
		}
		if filepath.Base(all[0]) != "nevis-20261025T020000Z.db" {
			t.Fatalf("the oldest copies must go: %v", all)
		}
	})

	t.Run("the backup is taken while the server is in use, and no temporary file is left", func(t *testing.T) {
		f := newFixture(t)
		dir := filepath.Join(f.dir, "backup")
		done := make(chan struct{})
		go func() {
			defer close(done)
			for i := range 20 {
				f.commit(f.a.token, f.v, []op{put("pages/p.json", "v"+string(rune('a'+i)), int64(i))})
			}
		}()
		for i := range 5 {
			snapshot(t, f.env, dir, 10, time.Date(2026, 10, 25, 0, 0, i, 0, time.UTC))
		}
		<-done
		all, _ := db.List(dir)
		if len(all) != 5 {
			t.Fatalf("%v", all)
		}
		if tmp, _ := filepath.Glob(filepath.Join(dir, "*.tmp")); len(tmp) != 0 {
			t.Fatalf("left over: %v", tmp)
		}
	})

	t.Run("nothing to restore from when there is no copy", func(t *testing.T) {
		all, err := db.List(filepath.Join(t.TempDir(), "backup"))
		if err != nil || len(all) != 0 {
			t.Fatalf("%v %v", all, err)
		}
	})
}
