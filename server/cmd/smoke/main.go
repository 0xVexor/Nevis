// Command smoke is a real client's day against a running server, over HTTP:
//
//	go run ./cmd/smoke [server url] [invite code]
//
// It registers a throw-away account, uploads and commits files, pulls them as a second device would, waits for a
// change by long poll and measures how long a change takes to arrive. It prints one line per step and exits with
// status 1 at the first step that fails.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/0xVexor/Nevis/server/internal/auth"
)

type obj = map[string]any

type reply struct {
	status int
	json   obj
	text   string
}

type client struct{ base string }

func (c client) do(method, path, token string, body any) reply {
	var r io.Reader
	contentType := ""
	switch b := body.(type) {
	case nil:
	case []byte:
		r, contentType = bytes.NewReader(b), "application/octet-stream"
	default:
		raw, _ := json.Marshal(b)
		r, contentType = bytes.NewReader(raw), "application/json"
	}
	req, err := http.NewRequest(method, c.base+path, r)
	if err != nil {
		die("bad request: " + err.Error())
	}
	req.Header.Set("X-Nevis-Api", "1")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		die("the server cannot be reached: " + err.Error())
	}
	defer resp.Body.Close()
	text, _ := io.ReadAll(resp.Body)
	out := reply{status: resp.StatusCode, text: string(text)}
	_ = json.Unmarshal(text, &out.json)
	return out
}

func die(msg string) {
	fmt.Println("FAIL", msg)
	os.Exit(1)
}

func step(name string, ok bool, extra string) {
	line := "ok   " + name
	if !ok {
		line = "FAIL " + name
	}
	if extra != "" {
		line += " - " + extra
	}
	fmt.Println(line)
	if !ok {
		os.Exit(1)
	}
}

func str(o obj, key string) string { s, _ := o[key].(string); return s }

func num(o obj, key string) int64 { f, _ := o[key].(float64); return int64(f) }

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func main() {
	base, invite := "http://localhost:3000", ""
	if len(os.Args) > 1 {
		base = strings.TrimRight(os.Args[1], "/")
	}
	if len(os.Args) > 2 {
		invite = os.Args[2]
	}
	c := client{base}

	health := c.do("GET", "/v1/health", "", nil)
	step("health", health.status == 200 && health.json["ok"] == true, fmt.Sprintf("registration=%s, pow=%d bits", str(health.json, "registration"), num(health.json, "pow_bits")))

	ch := c.do("GET", "/v1/auth/challenge", "", nil).json
	solving := time.Now()
	counter := auth.SolvePow(str(ch, "challenge"), int(num(ch, "bits")))
	name := fmt.Sprintf("smoke%x", time.Now().UnixNano()%1_000_000_000)
	reg := c.do("POST", "/v1/auth/register", "", obj{"username": name, "password": "smoke test password", "invite": invite,
		"device_name": "smoke-A", "challenge": ch["challenge"], "counter": counter})
	step("register", reg.status == 201, fmt.Sprintf("%s, proof of work took %d ms", orElse(str(reg.json, "error"), name), time.Since(solving).Milliseconds()))
	tokenA := str(reg.json, "token")

	login := c.do("POST", "/v1/auth/login", "", obj{"username": name, "password": "smoke test password", "device_name": "smoke-B"})
	step("login on a second device", login.status == 200, "")
	tokenB := str(login.json, "token")

	vault := fmt.Sprintf("%x-smoke-%x", time.Now().UnixNano(), os.Getpid())
	step("create vault", c.do("POST", "/v1/vaults", tokenA, obj{"id": vault, "name": "Smoke"}).status == 201, "")

	upload := func(token, content string) int {
		return c.do("PUT", "/v1/vaults/"+vault+"/blobs/"+sha(content), token, []byte(content)).status
	}
	commit := func(token string, ops ...obj) obj {
		id := fmt.Sprintf("smoke-%d", time.Now().UnixNano())
		return c.do("POST", "/v1/vaults/"+vault+"/commit", token, obj{"op_id": id, "ops": ops}).json
	}
	put := func(path, content string, base int64) obj {
		return obj{"op": "put", "path": path, "sha256": sha(content), "base_rev": base}
	}
	first := func(o obj) obj { r, _ := o["results"].([]any); m, _ := r[0].(map[string]any); return m }

	step("upload blob", upload(tokenA, "first page") == 201, "")
	c1 := first(commit(tokenA, put("pages/one.json", "first page", 0)))
	step("commit", c1["ok"] == true, fmt.Sprintf("rev %d", num(c1, "rev")))

	pulled := c.do("GET", "/v1/vaults/"+vault+"/changes?since=0", tokenB, nil).json
	files, _ := pulled["files"].([]any)
	ok := len(files) == 1
	if ok {
		f, _ := files[0].(map[string]any)
		ok = str(f, "path") == "pages/one.json"
	}
	step("second device sees it", ok, "")
	rev := num(files[0].(map[string]any), "rev")
	got := c.do("GET", fmt.Sprintf("/v1/vaults/%s/rev/%d", vault, rev), tokenB, nil)
	step("second device downloads it", got.text == "first page", "")

	// the instant part: B is waiting when A saves
	type waited struct {
		ms  int64
		seq int64
	}
	waiting := make(chan waited, 1)
	head := num(pulled, "head")
	go func() {
		t := time.Now()
		r := c.do("GET", fmt.Sprintf("/v1/vaults/%s/state?since=%d&wait=20", vault, head), tokenB, nil)
		waiting <- waited{time.Since(t).Milliseconds(), num(r.json, "seq")}
	}()
	time.Sleep(300 * time.Millisecond)
	sent := time.Now()
	upload(tokenA, "second page")
	commit(tokenA, put("pages/two.json", "second page", 0))
	w := <-waiting
	notice := time.Since(sent)
	step("the waiting device is told at once", w.seq > head && notice < 3*time.Second, fmt.Sprintf("%d ms from save to notice", notice.Milliseconds()))

	upload(tokenB, "an edit from a stale base")
	stale := first(commit(tokenB, put("pages/one.json", "an edit from a stale base", 99)))
	step("a stale write is refused, not applied", stale["ok"] == false, "")

	c.do("POST", "/v1/auth/logout", tokenB, obj{})
	step("a logged out device is refused", c.do("GET", "/v1/vaults/"+vault+"/state", tokenB, nil).status == 401, "")
	step("cleanup: vault to trash", c.do("DELETE", "/v1/vaults/"+vault, tokenA, nil).status == 200, "")
	fmt.Println("all good")
}

func orElse(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
