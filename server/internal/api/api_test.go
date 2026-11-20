package api

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/nevis-app/nevis/server/internal/store"
)

const token = "dev"

type env struct {
	srv *httptest.Server
	st  *store.Store
	ws  string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(st, Config{DevMode: true, DevToken: token}))
	t.Cleanup(func() { srv.Close(); st.Close() })
	return &env{srv: srv, st: st, ws: uuid(1, 0)}
}

// uuid makes a deterministic UUIDv7-shaped id.
func uuid(a, b int) string { return fmt.Sprintf("019a8f3c-%04x-7c3e-8f00-%012x", a&0xffff, b) }

func (e *env) op(n int, p string, overs ...map[string]any) string {
	m := map[string]any{"v": 1, "op": uuid(2, n), "ws": e.ws, "doc": uuid(3, n%7), "dev": uuid(4, 1),
		"t": fmt.Sprintf("%012x-0000-%s", time.Now().UnixMilli(), uuid(4, 1)), "sv": 1, "kid": 0, "p": p}
	var over map[string]any
	if len(overs) > 0 {
		over = overs[0]
	}
	for k, v := range over {
		if v == nil {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func (e *env) do(t *testing.T, method, path string, body string) (int, map[string]any, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, e.srv.URL+path, bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Nevis-Proto", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	buf.ReadFrom(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(buf.Bytes(), &out)
	return resp.StatusCode, out, buf.Bytes()
}

func (e *env) push(t *testing.T, ops ...string) (int, map[string]any) {
	t.Helper()
	b := `{"ops":[`
	for i, o := range ops {
		if i > 0 {
			b += ","
		}
		b += o
	}
	code, out, _ := e.do(t, "POST", "/v1/ws/"+e.ws+"/ops", b+"]}")
	return code, out
}

func statuses(out map[string]any) []string {
	var s []string
	for _, r := range out["results"].([]any) {
		s = append(s, r.(map[string]any)["status"].(string))
	}
	return s
}

func errCode(out map[string]any) string {
	if m, ok := out["error"].(map[string]any); ok {
		return m["code"].(string)
	}
	return ""
}

func TestPushAssignsSequentialSeqAndPullReturnsThemInOrder(t *testing.T) {
	e := newEnv(t)
	code, out := e.push(t, e.op(1, "AQ"), e.op(2, "Ag"), e.op(3, "Aw"))
	if code != 200 || out["head"].(float64) != 3 {
		t.Fatalf("%d %v", code, out)
	}
	code, pulled, _ := e.do(t, "GET", "/v1/ws/"+e.ws+"/ops?after=1&limit=10", "")
	ops := pulled["ops"].([]any)
	if code != 200 || len(ops) != 2 || ops[0].(map[string]any)["seq"].(float64) != 2 || pulled["more"].(bool) {
		t.Fatalf("%d %v", code, pulled)
	}
	if by := ops[0].(map[string]any)["by"]; by != "dev" {
		t.Fatalf("by = %v", by)
	}
}

func TestSendingABatchTenTimesChangesNothing(t *testing.T) {
	e := newEnv(t)
	batch := []string{e.op(1, "AQ"), e.op(2, "Ag"), e.op(3, "Aw")}
	_, first := e.push(t, batch...)
	for i := 0; i < 10; i++ {
		code, out := e.push(t, batch...)
		if code != 200 || out["head"] != first["head"] {
			t.Fatalf("round %d: %d %v", i, code, out)
		}
		for _, s := range statuses(out) {
			if s != "dup" {
				t.Fatalf("round %d: status %s", i, s)
			}
		}
		for j, r := range out["results"].([]any) {
			if r.(map[string]any)["seq"] != first["results"].([]any)[j].(map[string]any)["seq"] {
				t.Fatalf("seq changed")
			}
		}
	}
	_, pulled, _ := e.do(t, "GET", "/v1/ws/"+e.ws+"/ops", "")
	if len(pulled["ops"].([]any)) != 3 {
		t.Fatalf("log has %d ops", len(pulled["ops"].([]any)))
	}
}

func TestTheSameOpIdWithOtherBytesIsRefusedAndChangesNothing(t *testing.T) {
	e := newEnv(t)
	e.push(t, e.op(1, "AQ"), e.op(2, "Ag"))
	code, out := e.push(t, e.op(3, "Aw"), e.op(1, "Ag")) // op 1 again, with another payload; op 3 would be new
	if code != 409 || errCode(out) != "op_conflict" {
		t.Fatalf("%d %v", code, out)
	}
	_, pulled, _ := e.do(t, "GET", "/v1/ws/"+e.ws+"/ops", "")
	if pulled["head"].(float64) != 2 || len(pulled["ops"].([]any)) != 2 {
		t.Fatalf("the refused batch changed the log: %v", pulled)
	}
}

func TestClockTooFarAheadRefusesTheWholeBatch(t *testing.T) {
	e := newEnv(t)
	future := fmt.Sprintf("%012x-0000-%s", time.Now().Add(11*time.Minute).UnixMilli(), uuid(4, 1))
	near := fmt.Sprintf("%012x-0000-%s", time.Now().Add(9*time.Minute).UnixMilli(), uuid(4, 1))
	code, out := e.push(t, e.op(1, "AQ", map[string]any{"t": near}), e.op(2, "Ag", map[string]any{"t": future}))
	if code != 422 || errCode(out) != "clock_ahead" {
		t.Fatalf("%d %v", code, out)
	}
	code, out = e.push(t, e.op(1, "AQ", map[string]any{"t": near}))
	if code != 200 || out["head"].(float64) != 1 {
		t.Fatalf("an op 9 minutes ahead is allowed and nothing of the refused batch is stored: %d %v", code, out)
	}
}

func TestBadEnvelopesAreRefusedAndNothingIsStored(t *testing.T) {
	e := newEnv(t)
	bad := []string{
		e.op(1, "AQ", map[string]any{"extra": 1}),
		e.op(1, "AQ=="),
		e.op(1, "AQ", map[string]any{"ws": uuid(9, 9)}), // another workspace than the URL
		`{"v":1}`,
		`[]`,
	}
	for _, b := range bad {
		code, out := e.push(t, e.op(5, "AQ"), b)
		if code != 400 || errCode(out) != "bad_envelope" {
			t.Fatalf("%s: %d %v", b, code, out)
		}
	}
	_, pulled, _ := e.do(t, "GET", "/v1/ws/"+e.ws+"/ops", "")
	if pulled["head"].(float64) != 0 {
		t.Fatalf("something was stored: %v", pulled)
	}
	for _, body := range []string{`{"ops":null}`, `{"ops":[],"x":1}`, `not json`} {
		code, _, _ := e.do(t, "POST", "/v1/ws/"+e.ws+"/ops", body)
		if code != 400 {
			t.Fatalf("%s: %d", body, code)
		}
	}
}

func TestTooManyOpsAndAuth(t *testing.T) {
	e := newEnv(t)
	var ops []string
	for i := 0; i < 501; i++ {
		ops = append(ops, e.op(i, "AQ"))
	}
	if code, out := e.push(t, ops...); code != 400 || errCode(out) != "bad_envelope" {
		t.Fatalf("%d %v", code, out)
	}
	req, _ := http.NewRequest("GET", e.srv.URL+"/v1/ws/"+e.ws+"/ops", nil)
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 401 {
		t.Fatalf("no token: %d", resp.StatusCode)
	}
}

// The server is blind: a payload of random bytes is stored and comes back byte for byte (ADR-0006 §2).
func TestTheServerIsBlindToThePayload(t *testing.T) {
	e := newEnv(t)
	raw := make([]byte, 1024)
	rand.Read(raw)
	p := base64.RawURLEncoding.EncodeToString(raw)
	if code, out := e.push(t, e.op(1, p)); code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	_, pulled, _ := e.do(t, "GET", "/v1/ws/"+e.ws+"/ops", "")
	env := pulled["ops"].([]any)[0].(map[string]any)["env"].(map[string]any)
	back, err := base64.RawURLEncoding.DecodeString(env["p"].(string))
	if err != nil || !bytes.Equal(back, raw) {
		t.Fatal("the payload did not come back unchanged")
	}
}

// 8 pushers and 4 pullers, 10 000 ops: every puller sees a contiguous, ascending seq with no gap that fills in later
// (ADR-0005 "ناوردایی ترتیب"). Prints the throughput.
func TestConcurrentPushersAndPullersNeverSeeAGap(t *testing.T) {
	e := newEnv(t)
	const pushers, perPusher, batch = 8, 1250, 50
	total := pushers * perPusher
	var wg sync.WaitGroup
	for p := 0; p < pushers; p++ {
		wg.Add(1)
		go func(p int) {
			defer wg.Done()
			for i := 0; i < perPusher; i += batch {
				var ops []string
				for j := 0; j < batch; j++ {
					ops = append(ops, e.op(p*perPusher+i+j+1, "AQ"))
				}
				if code, out := e.push(t, ops...); code != 200 {
					t.Errorf("push: %d %v", code, out)
					return
				}
			}
		}(p)
	}
	type seen struct{ seqs []int64 }
	results := make([]seen, 4)
	var pg sync.WaitGroup
	done := make(chan struct{})
	for k := 0; k < 4; k++ {
		pg.Add(1)
		go func(k int) {
			defer pg.Done()
			var after int64
			for {
				code, out, _ := e.do(t, "GET", fmt.Sprintf("/v1/ws/%s/ops?after=%d&limit=300", e.ws, after), "")
				if code != 200 {
					t.Errorf("pull: %d", code)
					return
				}
				for _, o := range out["ops"].([]any) {
					seq := int64(o.(map[string]any)["seq"].(float64))
					if seq != after+1 {
						t.Errorf("puller %d: gap, expected %d got %d", k, after+1, seq)
						return
					}
					after = seq
					results[k].seqs = append(results[k].seqs, seq)
				}
				if int(after) >= total {
					return
				}
				select {
				case <-done:
					if int(after) >= total {
						return
					}
				default:
				}
				time.Sleep(time.Millisecond)
			}
		}(k)
	}
	start := time.Now()
	wg.Wait()
	elapsed := time.Since(start)
	close(done)
	pg.Wait()
	for k, r := range results {
		if len(r.seqs) != total || !sort.SliceIsSorted(r.seqs, func(i, j int) bool { return r.seqs[i] < r.seqs[j] }) {
			t.Fatalf("puller %d saw %d of %d ops", k, len(r.seqs), total)
		}
	}
	t.Logf("%d ops pushed by %d pushers in %s = %.0f ops/s, 4 pullers saw every seq once, in order", total, pushers, elapsed.Round(time.Millisecond), float64(total)/elapsed.Seconds())
}
