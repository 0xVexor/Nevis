// smoke: a quick end-to-end check of a running server. Signs up (solving the proof of work) or signs in as a device, creates a
// workspace, pushes one operation, pulls it back and compares. Exit status 0 = the server works.
//
//	go run ./cmd/smoke http://localhost:8787 [user] [password]
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

var base string

func call(method, path, token string, body any) (int, map[string]any) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, base+path, rd)
	req.Header.Set("Nevis-Proto", "1")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		die("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func die(f string, a ...any) { fmt.Fprintf(os.Stderr, "FAIL: "+f+"\n", a...); os.Exit(1) }

func solve(challenge string, bits int) int {
	for c := 0; ; c++ {
		d := sha256.Sum256([]byte(challenge + ":" + strconv.Itoa(c)))
		zeros := 0
		for _, b := range d {
			if b == 0 {
				zeros += 8
				continue
			}
			for m := byte(0x80); m != 0 && b&m == 0; m >>= 1 {
				zeros++
			}
			break
		}
		if zeros >= bits {
			return c
		}
	}
}

func main() {
	base = "http://localhost:8787"
	if len(os.Args) > 1 {
		base = os.Args[1]
	}
	user, pass := "smoke"+strconv.FormatInt(time.Now().UnixNano()%1e9, 36), "correct horse battery"
	if len(os.Args) > 3 {
		user, pass = os.Args[2], os.Args[3]
	}
	if st, h := call("GET", "/v1/health", "", nil); st != 200 || h["ok"] != true {
		die("health: %d %v", st, h)
	}
	_, ch := call("GET", "/v1/auth/challenge", "", nil)
	bits, _ := ch["bits"].(float64)
	body := map[string]any{"username": user, "password": pass, "client": "device", "deviceName": "smoke", "challenge": ch["challenge"], "counter": 0}
	if bits > 0 {
		body["counter"] = solve(ch["challenge"].(string), int(bits))
	}
	st, acc := call("POST", "/v1/auth/signup", "", body)
	if st == 409 {
		st, acc = call("POST", "/v1/auth/signin", "", map[string]any{"username": user, "password": pass, "client": "device", "deviceName": "smoke"})
	}
	tok, _ := acc["token"].(string)
	if st != 200 || tok == "" {
		die("sign-in: %d %v", st, acc)
	}
	ws := fmt.Sprintf("01a1fad9-262d-7000-8%03x-%012x", time.Now().UnixNano()%0xfff, time.Now().UnixNano()&0xffffffffffff)
	if st, r := call("POST", "/v1/ws", tok, map[string]any{"id": ws, "name": "smoke"}); st != 201 {
		die("create workspace: %d %v", st, r)
	}
	// one opaque op: the server never reads the payload (frame kind 0x03 "evt" + any bytes)
	op := map[string]any{"v": 1, "op": "01a1fad9-262d-7000-8000-000000000001", "ws": ws, "doc": "01a1fad9-262d-7000-8000-000000000002", "dev": "01a1fad9-262d-7000-8000-000000000003",
		"t": "0190a1b2c3d4-0000-01a1fad9-262d-7000-8000-000000000003", "sv": 1, "kid": 0, "p": "AQ"}
	st, pr := call("POST", "/v1/ws/"+ws+"/ops", tok, map[string]any{"ops": []any{op}})
	if st != 200 {
		die("push: %d %v", st, pr)
	}
	st, pl := call("GET", "/v1/ws/"+ws+"/ops?after=0&limit=10", tok, nil)
	ops, _ := pl["ops"].([]any)
	if st != 200 || len(ops) != 1 {
		die("pull: %d %v", st, pl)
	}
	got, _ := ops[0].(map[string]any)["env"].(map[string]any)
	if got["op"] != op["op"] || got["p"] != op["p"] {
		die("pulled op differs: %v", got)
	}
	fmt.Printf("ok: signed in as %s, workspace %s, 1 op pushed and pulled back unchanged\n", user, ws)
}
