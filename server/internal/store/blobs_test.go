package store

import (
	"context"
	"fmt"
	"math/rand"
	"testing"
	"time"
)

// The garbage-collection safety property (ROADMAP M9: "GC never deletes a referenced blob"). A random history of uploads, pushes that
// add or drop references, reports from devices that are sometimes behind, HEADs and time passing; at every collection nothing the log
// still refers to may be gone. The assumptions the design rests on are explicit here: (1) the client HEADs a blob right before it
// pushes an op that refers to it; (2) some device that has pulled everything reports the references at least every 20 days while the
// app is in use (the client does it after every sync that changed them). Stale reports are
// part of the history: a report from a device that has not pulled everything may keep a blob, never condemn one.
func TestCollectNeverRemovesAReferencedBlob(t *testing.T) {
	const ws = "019a8f3c-0001-7c3e-8f00-000000000001"
	for seed := int64(1); seed <= 300; seed++ {
		rng := rand.New(rand.NewSource(seed))
		st, err := Open(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		now := time.Unix(1_700_000_000, 0)
		st.SetClock(func() time.Time { return now })
		ctx := context.Background()
		if _, err := st.w.Exec(`INSERT INTO workspace (id, name, head, created_at) VALUES (?, 'w', 0, 0)`, ws); err != nil {
			t.Fatal(err)
		}
		hashes := make([]string, 8)
		for i := range hashes {
			hashes[i] = fmt.Sprintf("%064x", i+1)
		}
		head := int64(0)
		type version struct {
			head  int64
			truth map[string]bool
		}
		truth := map[string]bool{}
		hist := []version{{0, map[string]bool{}}}
		snapshot := func() map[string]bool {
			c := map[string]bool{}
			for k := range truth {
				c[k] = true
			}
			return c
		}
		stored := map[string]bool{}
		lastHonest := now
		honest := func() {
			refs := []string{}
			for h := range truth {
				refs = append(refs, h)
			}
			if _, err := st.ReportRefs(ctx, ws, head, refs); err != nil {
				t.Fatal(err)
			}
			lastHonest = now
		}
		for step := 0; step < 80; step++ {
			h := hashes[rng.Intn(len(hashes))]
			op := rng.Intn(7)
			switch op {
			case 0: // upload
				if _, err := st.AddBlob(ctx, ws, h, 10, "", 0); err != nil {
					t.Fatal(err)
				}
				stored[h] = true
			case 1: // an op that refers to a blob (only a blob that was uploaded: the outbox gate)
				if stored[h] {
					// the gate: the client HEADs every blob right before it pushes the op (restarts the probation), so a reference is
					// never created against a blob whose 30 days are nearly over
					if err := st.TouchBlob(ctx, ws, h); err != nil {
						t.Fatal(err)
					}
					head++
					truth[h] = true
					st.w.Exec(`UPDATE workspace SET head = ? WHERE id = ?`, head, ws)
					hist = append(hist, version{head, snapshot()})
				}
			case 2: // an op that drops the last reference
				if truth[h] {
					head++
					delete(truth, h)
					st.w.Exec(`UPDATE workspace SET head = ? WHERE id = ?`, head, ws)
					hist = append(hist, version{head, snapshot()})
				}
			case 3: // a device that is behind reports what it has seen
				v := hist[rng.Intn(len(hist))]
				refs := []string{}
				for k := range v.truth {
					refs = append(refs, k)
				}
				if _, err := st.ReportRefs(ctx, ws, v.head, refs); err != nil {
					t.Fatal(err)
				}
			case 4:
				honest()
			case 5:
				if err := st.TouchBlob(ctx, ws, h); err != nil {
					t.Fatal(err)
				}
			case 6:
				days := time.Duration(rng.Intn(25)+1) * 24 * time.Hour
				now = now.Add(days)
				if now.Sub(lastHonest) > 20*24*time.Hour {
					honest() // the assumption: someone reports at least every 20 days
				}
				gone, err := st.CollectBlobs(ctx)
				if err != nil {
					t.Fatal(err)
				}
				for _, g := range gone {
					if truth[g.Hash] {
						t.Fatalf("seed %d step %d: blob %s is referenced by the log and was collected", seed, step, g.Hash[:6])
					}
					delete(stored, g.Hash)
				}
			}
		}
		st.Close()
	}
}

// Control: without any report a blob that nothing ever referenced IS collected after the grace, so the property above is not vacuous.
func TestCollectRemovesAnUnreferencedBlobAfter30Days(t *testing.T) {
	const ws = "019a8f3c-0001-7c3e-8f00-000000000001"
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Unix(1_700_000_000, 0)
	st.SetClock(func() time.Time { return now })
	ctx := context.Background()
	st.w.Exec(`INSERT INTO workspace (id, name, head, created_at) VALUES (?, 'w', 0, 0)`, ws)
	h := fmt.Sprintf("%064x", 1)
	if _, err := st.AddBlob(ctx, ws, h, 10, "", 0); err != nil {
		t.Fatal(err)
	}
	now = now.Add(29 * 24 * time.Hour)
	if g, _ := st.CollectBlobs(ctx); len(g) != 0 {
		t.Fatal("collected before 30 days")
	}
	if err := st.TouchBlob(ctx, ws, h); err != nil { // a HEAD restarts the probation
		t.Fatal(err)
	}
	now = now.Add(29 * 24 * time.Hour)
	if g, _ := st.CollectBlobs(ctx); len(g) != 0 {
		t.Fatal("a HEAD must restart the 30 days")
	}
	now = now.Add(2 * 24 * time.Hour)
	if g, _ := st.CollectBlobs(ctx); len(g) != 1 {
		t.Fatalf("an unreferenced blob must go after 30 days, got %d", len(g))
	}
}

// A report from a device that has not pulled everything must not start the probation of a referenced blob.
func TestAStaleReportCannotCondemnABlob(t *testing.T) {
	const ws = "019a8f3c-0001-7c3e-8f00-000000000001"
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Unix(1_700_000_000, 0)
	st.SetClock(func() time.Time { return now })
	ctx := context.Background()
	st.w.Exec(`INSERT INTO workspace (id, name, head, created_at) VALUES (?, 'w', 5, 0)`, ws)
	h := fmt.Sprintf("%064x", 1)
	st.AddBlob(ctx, ws, h, 10, "", 0)
	if ok, _ := st.ReportRefs(ctx, ws, 5, []string{h}); !ok {
		t.Fatal("a complete report is applied")
	}
	if ok, _ := st.ReportRefs(ctx, ws, 4, nil); ok {
		t.Fatal("a report from cursor 4 < head 5 must not be applied for omissions")
	}
	now = now.Add(60 * 24 * time.Hour)
	if g, _ := st.CollectBlobs(ctx); len(g) != 0 {
		t.Fatal("a stale report condemned a referenced blob")
	}
	if ok, _ := st.ReportRefs(ctx, ws, 5, nil); !ok {
		t.Fatal("complete")
	}
	now = now.Add(31 * 24 * time.Hour)
	if g, _ := st.CollectBlobs(ctx); len(g) != 1 {
		t.Fatal("after a complete report that omits it and 30 days, it goes")
	}
}

// Quota: charged once per blob, refused when full, and given back when the collection removes the blob.
func TestBlobQuotaIsGivenBackWhenCollected(t *testing.T) {
	const ws = "019a8f3c-0001-7c3e-8f00-000000000001"
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Unix(1_700_000_000, 0)
	st.SetClock(func() time.Time { return now })
	ctx := context.Background()
	st.w.Exec(`INSERT INTO workspace (id, name, head, created_at) VALUES (?, 'w', 0, 0)`, ws)
	st.w.Exec(`INSERT INTO account (id, username, pass_hash, recovery_hash, created_at) VALUES ('a1','a','x','x',0)`)
	used := func() (n int64) { st.r.QueryRow(`SELECT used_bytes FROM account WHERE id='a1'`).Scan(&n); return }
	h1, h2 := fmt.Sprintf("%064x", 1), fmt.Sprintf("%064x", 2)
	if c, err := st.AddBlob(ctx, ws, h1, 600, "a1", 1000); err != nil || !c || used() != 600 {
		t.Fatal(c, err, used())
	}
	if c, err := st.AddBlob(ctx, ws, h1, 600, "a1", 1000); err != nil || c || used() != 600 {
		t.Fatal("same blob twice must cost once", c, err, used())
	}
	if _, err := st.AddBlob(ctx, ws, h2, 600, "a1", 1000); err != ErrQuota || used() != 600 {
		t.Fatal("must be refused", err, used())
	}
	now = now.Add(31 * 24 * time.Hour)
	if g, _ := st.CollectBlobs(ctx); len(g) != 1 || used() != 0 {
		t.Fatalf("collected %d, used %d", len(g), used())
	}
	if _, err := st.AddBlob(ctx, ws, h2, 600, "a1", 1000); err != nil {
		t.Fatal("room again after the collection", err)
	}
}
