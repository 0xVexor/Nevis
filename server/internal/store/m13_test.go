package store

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"testing"
	"time"

	"github.com/nevis-app/nevis/server/internal/envelope"
)

const wsID = "019a8f3c-0001-7c3e-8f00-000000000001"

func uuid(a, b int) string { return fmt.Sprintf("019a8f3c-%04x-7c3e-8f00-%012x", a&0xffff, b) }

// env builds a valid envelope. cov < 0: an ordinary op; pg: a purge op.
func env(t *testing.T, n, doc, sv, cov int, pg bool, at time.Time) *envelope.Envelope {
	t.Helper()
	m := map[string]any{"v": 1, "op": uuid(2, n), "ws": wsID, "doc": uuid(3, doc), "dev": uuid(4, 1), "t": fmt.Sprintf("%012x-0000-%s", at.UnixMilli(), uuid(4, 1)), "sv": sv, "kid": 0, "p": "AQ"}
	if cov >= 0 {
		m["cov"] = cov
	}
	if pg {
		m["pg"] = 1
	}
	b, _ := json.Marshal(m)
	e, err := envelope.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func open(t *testing.T) (*Store, *time.Time) {
	t.Helper()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	st.SetClock(func() time.Time { return now })
	t.Cleanup(func() { st.Close() })
	return st, &now
}

func push(t *testing.T, st *Store, e *envelope.Envelope) Result {
	t.Helper()
	res, _, err := st.Push(context.Background(), wsID, "acct", []*envelope.Envelope{e}, PushOptions{Create: true})
	if err != nil {
		t.Fatal(err)
	}
	return res[0]
}

func seqs(t *testing.T, st *Store, compact bool) []int64 {
	t.Helper()
	ops, _, _, err := st.Pull(context.Background(), wsID, 0, 1000, false, compact)
	if err != nil {
		t.Fatal(err)
	}
	var out []int64
	for _, o := range ops {
		out = append(out, o.Seq)
	}
	return out
}

func TestCompactPullHidesWhatASnapshotCoversButNeverANewerSchemaOp(t *testing.T) {
	st, now := open(t)
	for i := 1; i <= 5; i++ {
		push(t, st, env(t, i, 1, 1, -1, false, *now)) // seq 1..5, doc 1, sv 1
	}
	push(t, st, env(t, 6, 1, 2, -1, false, *now)) // seq 6: written under SCHEMA 2
	push(t, st, env(t, 7, 2, 1, -1, false, *now)) // seq 7: another document
	push(t, st, env(t, 8, 1, 1, 6, false, *now))  // seq 8: a snapshot (sv 1) of doc 1 covering seq <= 6
	push(t, st, env(t, 9, 1, 1, -1, false, *now)) // seq 9: after the snapshot
	got := seqs(t, st, true)
	want := []int64{6, 7, 8, 9} // 1..5 hidden; 6 is sv 2 (> the snapshot's sv 1): never hidden; the other document is untouched
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("compact pull: %v, want %v", got, want)
	}
	if all := seqs(t, st, false); len(all) != 9 {
		t.Fatalf("a normal pull must return everything: %v", all)
	}
}

func TestPruneRemovesOnlyOldCoveredOpsAndAStaleCursorMustResync(t *testing.T) {
	st, now := open(t)
	for i := 1; i <= 4; i++ {
		push(t, st, env(t, i, 1, 1, -1, false, *now))
	}
	push(t, st, env(t, 5, 1, 1, 4, false, *now)) // snapshot covering 1..4
	push(t, st, env(t, 6, 1, 1, -1, false, *now))
	if n, _ := st.Prune(context.Background()); n != 0 {
		t.Fatalf("nothing is 30 days old yet: removed %d", n)
	}
	*now = now.Add(31 * 24 * time.Hour)
	push(t, st, env(t, 7, 1, 1, -1, false, *now)) // young, uncovered
	n, err := st.Prune(context.Background())
	if err != nil || n != 4 {
		t.Fatalf("prune: %d %v", n, err)
	}
	if got := seqs(t, st, false); fmt.Sprint(got) != "[5 6 7]" {
		t.Fatalf("what is left: %v (the snapshot, and the ops above its cov, must stay)", got)
	}
	if _, _, _, err := st.Pull(context.Background(), wsID, 2, 100, false); err != ErrResync {
		t.Fatalf("a cursor inside the removed part must resync, got %v", err)
	}
	if _, _, _, err := st.Pull(context.Background(), wsID, 0, 100, false, true); err != nil {
		t.Fatalf("a compact pull from 0 always works: %v", err)
	}
	if _, _, _, err := st.Pull(context.Background(), wsID, 5, 100, false); err != nil {
		t.Fatalf("a cursor at or after the pruned part is fine: %v", err)
	}
}

// The property: for any history, the pruning removes EXACTLY the ops the rule names (old, no cov, covered by a snapshot of the same
// document with cov >= seq and sv >= op.sv) and nothing else; in particular never a snapshot, an op above a cov, or a newer-schema op.
func TestPruneIsExactlyTheRule(t *testing.T) {
	removedTotal, keptCovered := 0, 0
	for seed := int64(1); seed <= 60; seed++ {
		rng := rand.New(rand.NewSource(seed))
		st, now := open(t)
		type op struct {
			seq      int64
			doc, sv  int
			cov      int
			at       time.Time
			snapshot bool
		}
		var ops []op
		head := 0
		for i := 1; i <= 60; i++ {
			*now = now.Add(time.Duration(rng.Intn(5*24)) * time.Hour)
			doc, sv := 1+rng.Intn(3), 1+rng.Intn(2)
			cov := -1
			if head > 0 && rng.Intn(5) == 0 {
				cov = rng.Intn(head + 1)
			}
			push(t, st, env(t, i, doc, sv, cov, false, *now))
			head++
			ops = append(ops, op{int64(head), doc, sv, cov, *now, cov >= 0})
		}
		cut := now.Add(-PruneAfter)
		want := map[int64]bool{}
		for _, o := range ops {
			if o.snapshot || !o.at.Before(cut) {
				continue
			}
			for _, s := range ops {
				if s.snapshot && s.doc == o.doc && int64(s.cov) >= o.seq && s.seq != o.seq && s.sv >= o.sv {
					want[o.seq] = true
					break
				}
			}
		}
		n, err := st.Prune(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		left := map[int64]bool{}
		for _, s := range seqs(t, st, false) {
			left[s] = true
		}
		for _, o := range ops {
			if want[o.seq] == left[o.seq] {
				t.Fatalf("seed %d: op %d (doc %d sv %d snapshot %v): the rule says removed=%v, left=%v", seed, o.seq, o.doc, o.sv, o.snapshot, want[o.seq], left[o.seq])
			}
		}
		if int(n) != len(want) {
			t.Fatalf("seed %d: removed %d, the rule names %d", seed, n, len(want))
		}
		removedTotal += int(n)
		for _, o := range ops {
			if o.snapshot {
				keptCovered++
			}
		}
		st.Close()
	}
	if removedTotal < 100 || keptCovered < 100 {
		t.Fatalf("the histories exercised too little (removed %d, snapshots %d): the property would prove nothing", removedTotal, keptCovered)
	}
}

func TestPurgeForgetsTheDocumentAndRefusesLateWriters(t *testing.T) {
	st, now := open(t)
	for i := 1; i <= 3; i++ {
		push(t, st, env(t, i, 1, 1, -1, false, *now))
	}
	push(t, st, env(t, 4, 2, 1, -1, false, *now))
	push(t, st, env(t, 5, 1, 1, -1, true, *now)) // PURGE of doc 1
	if got := seqs(t, st, false); fmt.Sprint(got) != "[4 5]" {
		t.Fatalf("after the purge: %v", got)
	}
	if r := push(t, st, env(t, 6, 1, 1, -1, false, *now)); r.Status != "purged" {
		t.Fatalf("a late write to a purged document: %q", r.Status)
	}
}

func TestASnapshotCannotCoverOpsTheServerDoesNotHave(t *testing.T) {
	st, now := open(t)
	push(t, st, env(t, 1, 1, 1, -1, false, *now))
	_, _, err := st.Push(context.Background(), wsID, "a", []*envelope.Envelope{env(t, 2, 1, 1, 99, false, *now)}, PushOptions{})
	if err != ErrBadCov {
		t.Fatalf("got %v", err)
	}
}

func TestSnapshotCandidatesAndBackup(t *testing.T) {
	st, now := open(t)
	for i := 1; i <= 7; i++ {
		push(t, st, env(t, i, 1, 1, -1, false, *now))
	}
	push(t, st, env(t, 8, 2, 1, -1, false, *now))
	c, err := st.SnapshotCandidates(context.Background(), wsID, 5, 10)
	if err != nil || len(c) != 1 || c[0].Ops != 7 {
		t.Fatalf("%v %v", c, err)
	}
	push(t, st, env(t, 9, 1, 1, 8, false, *now)) // doc 1 now has a snapshot over everything: no longer a candidate
	if c, _ := st.SnapshotCandidates(context.Background(), wsID, 5, 10); len(c) != 0 {
		t.Fatalf("a covered document is not a candidate: %v", c)
	}
	path, err := st.Backup(context.Background(), t.TempDir())
	if err != nil || path == "" {
		t.Fatalf("backup: %q %v", path, err)
	}
	if st2, err := os.Stat(path); err != nil || st2.Size() == 0 {
		t.Fatalf("the backup file is empty or missing: %v", err)
	}
}
