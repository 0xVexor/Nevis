package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nevis-app/nevis/server/internal/auth"
	"github.com/nevis-app/nevis/server/internal/store"
)

type m4 struct {
	srv  *httptest.Server
	st   *store.Store
	dir  string
	web  string
	conf Config
}

func newM4(t *testing.T, tweak ...func(*Config)) *m4 {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	web := t.TempDir()
	for name, body := range map[string]string{"index.html": "<!doctype html><title>Nevis</title>", "assets/app-1a2b.js": "console.log(1)", "assets/core.wasm": "\x00asm", ".env": "SECRET=1"} {
		p := filepath.Join(web, name)
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(body), 0o644)
	}
	cfg := Config{Secret: strings.Repeat("s", 40), Registration: "open", PowBits: 4, Cost: auth.Cost{N: 16, R: 1, P: 1}, WebDir: web, InsecureCookies: false}
	for _, f := range tweak {
		f(&cfg)
	}
	srv := httptest.NewServer(New(st, cfg))
	t.Cleanup(func() { srv.Close(); st.Close() })
	return &m4{srv: srv, st: st, dir: dir, web: web, conf: cfg}
}

type resp struct {
	code int
	body map[string]any
	hdr  http.Header
	raw  []byte
	ck   []*http.Cookie
}

func (m *m4) do(t *testing.T, method, path string, body any, h map[string]string) resp {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, m.srv.URL+path, rd)
	if method != "GET" && method != "HEAD" {
		req.Header.Set("Nevis-Proto", "1")
	}
	for k, v := range h {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	r, err := (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	var buf bytes.Buffer
	buf.ReadFrom(r.Body)
	var out map[string]any
	_ = json.Unmarshal(buf.Bytes(), &out)
	return resp{code: r.StatusCode, body: out, hdr: r.Header, raw: buf.Bytes(), ck: r.Cookies()}
}

func code(r resp) string {
	if e, ok := r.body["error"].(map[string]any); ok {
		return e["code"].(string)
	}
	return ""
}

// signup solves the proof of work and creates an account; `client` is "web" or "device".
func (m *m4) signup(t *testing.T, user, client string) resp {
	t.Helper()
	c := m.do(t, "GET", "/v1/auth/challenge", nil, nil)
	ch, _ := c.body["challenge"].(string)
	counter := auth.SolvePow(ch, int(c.body["bits"].(float64)))
	return m.do(t, "POST", "/v1/auth/signup", map[string]any{"username": user, "password": "correct horse battery", "client": client, "deviceName": "test " + client, "challenge": ch, "counter": counter}, nil)
}

func bearer(tok string) map[string]string { return map[string]string{"Authorization": "Bearer " + tok} }

func TestSignUpInRecoverLikeTheOldServer(t *testing.T) {
	m := newM4(t)
	r := m.signup(t, "Alice", "device")
	if r.code != 200 || r.body["token"] == nil || r.body["recoveryKey"] == nil || r.body["account"].(map[string]any)["username"] != "alice" {
		t.Fatalf("signup: %d %v", r.code, r.body)
	}
	tok := r.body["token"].(string)
	if me := m.do(t, "GET", "/v1/me", nil, bearer(tok)); me.code != 200 || me.body["account"].(map[string]any)["username"] != "alice" {
		t.Fatalf("me: %d %v", me.code, me.body)
	}
	if again := m.signup(t, "alice", "device"); again.code != 409 || code(again) != "username_taken" {
		t.Fatalf("duplicate: %d %v", again.code, again.body)
	}
	if bad := m.do(t, "POST", "/v1/auth/signup", map[string]any{"username": "x", "password": "correct horse battery", "client": "device"}, nil); code(bad) != "bad_username" && code(bad) != "bad_challenge" {
		t.Fatalf("short name: %v", bad.body)
	}

	in := m.do(t, "POST", "/v1/auth/signin", map[string]any{"username": "alice", "password": "correct horse battery", "client": "device"}, nil)
	if in.code != 200 || in.body["token"] == nil || in.body["token"] == tok {
		t.Fatalf("signin: %d %v", in.code, in.body)
	}
	if wrong := m.do(t, "POST", "/v1/auth/signin", map[string]any{"username": "alice", "password": "nope nope nope", "client": "device"}, nil); wrong.code != 401 || code(wrong) != "bad_credentials" {
		t.Fatalf("wrong password: %d %v", wrong.code, wrong.body)
	}
	if ghost := m.do(t, "POST", "/v1/auth/signin", map[string]any{"username": "nobody", "password": "whatever 123", "client": "device"}, nil); ghost.code != 401 || code(ghost) != "bad_credentials" {
		t.Fatalf("unknown user must look like a wrong password: %d %v", ghost.code, ghost.body)
	}

	// recovery: the old key resets the password, every old session dies, and a NEW recovery key is issued
	key := r.body["recoveryKey"].(string)
	c := m.do(t, "GET", "/v1/auth/challenge", nil, nil)
	counter := auth.SolvePow(c.body["challenge"].(string), int(c.body["bits"].(float64)))
	rec := m.do(t, "POST", "/v1/auth/recover", map[string]any{"username": "alice", "recoveryKey": strings.ToLower(key), "newPassword": "a brand new password", "client": "device", "challenge": c.body["challenge"], "counter": counter}, nil)
	if rec.code != 200 || rec.body["recoveryKey"] == key || rec.body["token"] == nil {
		t.Fatalf("recover: %d %v", rec.code, rec.body)
	}
	if old := m.do(t, "GET", "/v1/me", nil, bearer(tok)); old.code != 401 {
		t.Fatalf("an old session survived the recovery: %d", old.code)
	}
	if ok := m.do(t, "POST", "/v1/auth/signin", map[string]any{"username": "alice", "password": "a brand new password", "client": "device"}, nil); ok.code != 200 {
		t.Fatalf("new password: %d %v", ok.code, ok.body)
	}
	// a solved challenge can be used once
	again := m.do(t, "POST", "/v1/auth/recover", map[string]any{"username": "alice", "recoveryKey": rec.body["recoveryKey"], "newPassword": "yet another password", "challenge": c.body["challenge"], "counter": counter}, nil)
	if code(again) != "bad_challenge" {
		t.Fatalf("a challenge was used twice: %d %v", again.code, again.body)
	}
}

func TestRegistrationModes(t *testing.T) {
	closed := newM4(t, func(c *Config) { c.Registration = "closed" })
	if r := closed.signup(t, "bob", "device"); r.code != 403 || code(r) != "registration_closed" {
		t.Fatalf("closed: %d %v", r.code, r.body)
	}
	invite := newM4(t, func(c *Config) {
		c.Registration = "invite"
		c.InviteCodes = map[string]bool{"abc": true}
		c.PowBits = 0
	})
	post := func(code string) resp {
		return invite.do(t, "POST", "/v1/auth/signup", map[string]any{"username": "carol", "password": "correct horse battery", "client": "device", "invite": code}, nil)
	}
	if r := post("wrong"); r.code != 400 || code(r) != "bad_invite" {
		t.Fatalf("bad invite: %d %v", r.code, r.body)
	}
	if r := post("abc"); r.code != 200 {
		t.Fatalf("good invite: %d %v", r.code, r.body)
	}
}

func TestPasswordGuessingIsRateLimited(t *testing.T) {
	m := newM4(t)
	m.signup(t, "dave", "device")
	for i := 0; i < 10; i++ {
		m.do(t, "POST", "/v1/auth/signin", map[string]any{"username": "dave", "password": "wrong wrong wrong", "client": "device"}, nil)
	}
	r := m.do(t, "POST", "/v1/auth/signin", map[string]any{"username": "dave", "password": "correct horse battery", "client": "device"}, nil)
	if r.code != 429 || r.hdr.Get("Retry-After") == "" {
		t.Fatalf("expected 429 with Retry-After, got %d %v", r.code, r.body)
	}
}

func TestCSRFGuard(t *testing.T) {
	m := newM4(t)
	tok := m.signup(t, "erin", "device").body["token"].(string)
	h := bearer(tok)
	if r := m.do(t, "POST", "/v1/ws", map[string]any{"name": "w"}, merge(h, map[string]string{"Nevis-Proto": ""})); r.code != 403 || code(r) != "csrf" {
		t.Fatalf("missing header: %d %v", r.code, r.body)
	}
	if r := m.do(t, "POST", "/v1/ws", map[string]any{"name": "w"}, merge(h, map[string]string{"Origin": "https://evil.example"})); r.code != 403 || code(r) != "csrf" {
		t.Fatalf("foreign origin: %d %v", r.code, r.body)
	}
	host := strings.TrimPrefix(m.srv.URL, "http://")
	if r := m.do(t, "POST", "/v1/ws", map[string]any{"name": "w"}, merge(h, map[string]string{"Origin": "http://" + host})); r.code != 201 {
		t.Fatalf("same origin must pass: %d %v", r.code, r.body)
	}
}

func merge(a, b map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func TestWebSessionCookieAndTokenAtRest(t *testing.T) {
	m := newM4(t)
	r := m.signup(t, "frank", "web")
	if r.code != 200 || r.body["token"] != nil {
		t.Fatalf("a browser must never get the token in JSON: %d %v", r.code, r.body)
	}
	var c *http.Cookie
	for _, k := range r.ck {
		if k.Name == "nevis_session" {
			c = k
		}
	}
	if c == nil || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.MaxAge < 80*24*3600 {
		t.Fatalf("cookie flags: %+v", c)
	}
	// the cookie works as a session
	if me := m.do(t, "GET", "/v1/me", nil, map[string]string{"Cookie": "nevis_session=" + c.Value}); me.code != 200 {
		t.Fatalf("cookie session: %d %v", me.code, me.body)
	}
	// only a hash of the token is stored
	db, err := sql.Open("sqlite", "file:"+filepath.Join(m.dir, "nevis.db")+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, _ := db.Query(`SELECT token_hash FROM session`)
	defer rows.Close()
	n := 0
	for rows.Next() {
		var h string
		rows.Scan(&h)
		n++
		if h == c.Value || strings.Contains(h, c.Value) || h != auth.SHA256Hex(c.Value) {
			t.Fatalf("the session token is not stored as its hash: %s", h)
		}
	}
	if n != 1 {
		t.Fatalf("sessions: %d", n)
	}
}

func TestDevelopmentCookiesMayTravelOverHTTP(t *testing.T) {
	m := newM4(t, func(c *Config) { c.InsecureCookies = true })
	for _, k := range m.signup(t, "gina", "web").ck {
		if k.Secure {
			t.Fatal("dev mode: the cookie must be usable on http://localhost")
		}
	}
}

func TestAnotherAccountCannotSeeAWorkspaceAndSignOutIsPerDevice(t *testing.T) {
	m := newM4(t)
	a := m.signup(t, "alice2", "device").body["token"].(string)
	b := m.signup(t, "bob2", "device").body["token"].(string)
	ws := m.do(t, "POST", "/v1/ws", map[string]any{"name": "private"}, bearer(a)).body["id"].(string)
	opText := func(n int) string { return pushOp(ws, n, "AQ") }
	push := func(tok string) resp { return m.do(t, "POST", "/v1/ws/"+ws+"/ops", rawOps(opText(1)), bearer(tok)) }
	if r := push(a); r.code != 200 {
		t.Fatalf("owner push: %d %v", r.code, r.body)
	}
	for name, r := range map[string]resp{"push": push(b), "pull": m.do(t, "GET", "/v1/ws/"+ws+"/ops", nil, bearer(b))} {
		if r.code != 404 || code(r) != "no_such_workspace" {
			t.Fatalf("%s by a stranger must be 404, got %d %v", name, r.code, r.body)
		}
	}
	if list := m.do(t, "GET", "/v1/ws", nil, bearer(b)); len(list.body["workspaces"].([]any)) != 0 {
		t.Fatalf("a stranger lists %v", list.body)
	}

	// two devices of one account: signing out one leaves the other signed in
	second := m.do(t, "POST", "/v1/auth/signin", map[string]any{"username": "alice2", "password": "correct horse battery", "client": "device"}, nil).body["token"].(string)
	if r := m.do(t, "POST", "/v1/auth/signout", nil, bearer(second)); r.code != 200 {
		t.Fatalf("signout: %d", r.code)
	}
	if r := m.do(t, "GET", "/v1/me", nil, bearer(second)); r.code != 401 {
		t.Fatalf("the signed-out device still works: %d", r.code)
	}
	if r := m.do(t, "GET", "/v1/me", nil, bearer(a)); r.code != 200 {
		t.Fatalf("the other device was signed out too: %d", r.code)
	}
}

func TestRevokedDeviceIs401OnTheNextRequest(t *testing.T) {
	m := newM4(t)
	a := m.signup(t, "hana", "device").body["token"].(string)
	b := m.do(t, "POST", "/v1/auth/signin", map[string]any{"username": "hana", "password": "correct horse battery", "client": "device", "deviceName": "phone"}, nil)
	phone := b.body["token"].(string)
	devs := m.do(t, "GET", "/v1/devices", nil, bearer(a)).body["devices"].([]any)
	if len(devs) != 2 {
		t.Fatalf("devices: %v", devs)
	}
	phoneID := b.body["device"].(map[string]any)["id"].(string)
	if r := m.do(t, "DELETE", "/v1/devices/"+phoneID, nil, bearer(a)); r.code != 200 {
		t.Fatalf("revoke: %d %v", r.code, r.body)
	}
	if r := m.do(t, "GET", "/v1/me", nil, bearer(phone)); r.code != 401 {
		t.Fatalf("the revoked device still works: %d", r.code)
	}
	if r := m.do(t, "DELETE", "/v1/devices/"+phoneID, nil, bearer(a)); r.code != 404 {
		t.Fatalf("revoking twice: %d", r.code)
	}
}

func TestProtocolVersionGates(t *testing.T) {
	m := newM4(t)
	tok := m.signup(t, "ivan", "device").body["token"].(string)
	if r := m.do(t, "GET", "/v1/me", nil, merge(bearer(tok), map[string]string{"Nevis-Proto": "0"})); r.code != 426 || code(r) != "upgrade_required" || r.body["error"].(map[string]any)["minProto"].(float64) != 1 {
		t.Fatalf("proto 0: %d %v", r.code, r.body)
	}
	ws := m.do(t, "POST", "/v1/ws", map[string]any{"name": "w"}, bearer(tok)).body["id"].(string)
	if err := m.st.RaiseMinSV(t.Context(), ws, 3); err != nil {
		t.Fatal(err)
	}
	r := m.do(t, "POST", "/v1/ws/"+ws+"/ops", rawOps(pushOp(ws, 1, "AQ")), bearer(tok)) // sv = 1 < 3
	if r.code != 426 || r.body["error"].(map[string]any)["minSv"].(float64) != 3 {
		t.Fatalf("sv gate: %d %v", r.code, r.body)
	}
}

func TestViewersCannotWriteAndQuotaIsEnforced(t *testing.T) {
	m := newM4(t, func(c *Config) { c.QuotaBytes = 3000 })
	a := m.signup(t, "judy", "device")
	tok := a.body["token"].(string)
	ws := m.do(t, "POST", "/v1/ws", map[string]any{"name": "w"}, bearer(tok)).body["id"].(string)
	big := strings.Repeat("A", 2000) // 2000 payload chars
	if r := m.do(t, "POST", "/v1/ws/"+ws+"/ops", rawOps(pushOp(ws, 1, big)), bearer(tok)); r.code != 200 {
		t.Fatalf("within quota: %d %v", r.code, r.body)
	}
	if r := m.do(t, "POST", "/v1/ws/"+ws+"/ops", rawOps(pushOp(ws, 2, big)), bearer(tok)); r.code != 507 || code(r) != "quota_exceeded" {
		t.Fatalf("over quota: %d %v", r.code, r.body)
	}
	if r := m.do(t, "GET", "/v1/ws/"+ws+"/ops", nil, bearer(tok)); len(r.body["ops"].([]any)) != 1 {
		t.Fatalf("the refused op was stored: %v", r.body)
	}
	viewer := m.signup(t, "kate", "device")
	vAcc := viewer.body["account"].(map[string]any)["id"].(string)
	if err := m.st.AddMember(t.Context(), ws, vAcc, "viewer"); err != nil {
		t.Fatal(err)
	}
	vt := viewer.body["token"].(string)
	if r := m.do(t, "GET", "/v1/ws/"+ws+"/ops", nil, bearer(vt)); r.code != 200 {
		t.Fatalf("a viewer reads: %d", r.code)
	}
	if r := m.do(t, "POST", "/v1/ws/"+ws+"/ops", rawOps(pushOp(ws, 3, "AQ")), bearer(vt)); r.code != 403 || code(r) != "forbidden" {
		t.Fatalf("a viewer writes: %d %v", r.code, r.body)
	}
}

func TestLongPollWakesOnACommitAndTimesOutEmpty(t *testing.T) {
	m := newM4(t)
	tok := m.signup(t, "liam", "device").body["token"].(string)
	ws := m.do(t, "POST", "/v1/ws", map[string]any{"name": "w"}, bearer(tok)).body["id"].(string)
	m.do(t, "POST", "/v1/ws/"+ws+"/ops", rawOps(pushOp(ws, 1, "AQ")), bearer(tok))

	got := make(chan resp, 1)
	t0 := time.Now()
	go func() { got <- m.do(t, "GET", "/v1/ws/"+ws+"/ops?after=1&wait=10", nil, bearer(tok)) }()
	time.Sleep(200 * time.Millisecond)
	m.do(t, "POST", "/v1/ws/"+ws+"/ops", rawOps(pushOp(ws, 2, "Ag")), bearer(tok))
	r := <-got
	if took := time.Since(t0); r.code != 200 || len(r.body["ops"].([]any)) != 1 || took > 2*time.Second {
		t.Fatalf("long poll: %d %v after %s", r.code, r.body, took)
	}
	t1 := time.Now()
	r = m.do(t, "GET", "/v1/ws/"+ws+"/ops?after=2&wait=1", nil, bearer(tok))
	if r.code != 200 || len(r.body["ops"].([]any)) != 0 || time.Since(t1) < 900*time.Millisecond || time.Since(t1) > 3*time.Second {
		t.Fatalf("an idle long poll must answer empty after its wait: %d %v in %s", r.code, r.body, time.Since(t1))
	}
	if r := m.do(t, "GET", "/v1/ws/"+ws+"/ops?wait=99", nil, bearer(tok)); r.code != 400 {
		t.Fatalf("wait above 25: %d", r.code)
	}
}

func TestWebAppIsServedFromTheSameOriginUnderACSP(t *testing.T) {
	m := newM4(t)
	r := m.do(t, "GET", "/", nil, nil)
	if r.code != 200 || !strings.Contains(string(r.raw), "<title>Nevis</title>") {
		t.Fatalf("/: %d %q", r.code, r.raw)
	}
	csp := r.hdr.Get("Content-Security-Policy")
	for _, want := range []string{"default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP lacks %q: %s", want, csp)
		}
	}
	if strings.Contains(csp, "script-src 'self' 'unsafe") {
		t.Errorf("no inline script or eval: %s", csp)
	}
	if r2 := m.do(t, "GET", "/notes/abc", nil, nil); r2.code != 200 || !strings.Contains(string(r2.raw), "<title>") {
		t.Errorf("app route: %d", r2.code)
	}
	if a := m.do(t, "GET", "/assets/app-1a2b.js", nil, nil); a.code != 200 || !strings.Contains(a.hdr.Get("Cache-Control"), "immutable") {
		t.Errorf("asset: %d %v", a.code, a.hdr)
	}
	if w := m.do(t, "GET", "/assets/core.wasm", nil, nil); w.hdr.Get("Content-Type") != "application/wasm" {
		t.Errorf("wasm type: %s", w.hdr.Get("Content-Type"))
	}
	for _, p := range []string{"/.env", "/assets/../.env", "/%2e%2e/etc/passwd", "/missing.js"} {
		if x := m.do(t, "GET", p, nil, nil); x.code == 200 && strings.Contains(string(x.raw), "SECRET") {
			t.Errorf("%s leaked", p)
		}
	}
	if x := m.do(t, "GET", "/v1/nothing", nil, nil); x.code != 404 || code(x) != "not_found" {
		t.Errorf("/v1/nothing: %d %s", x.code, x.raw)
	}
	if x := m.do(t, "POST", "/", nil, nil); x.code != 405 {
		t.Errorf("POST /: %d", x.code)
	}
}

// ≥ 2000 ops/s through the real stack: accounts, membership, quota accounting, the single writer (ADR-0006).
func TestPushThroughputWithRealAccounts(t *testing.T) {
	m := newM4(t)
	tok := m.signup(t, "mia", "device").body["token"].(string)
	ws := m.do(t, "POST", "/v1/ws", map[string]any{"name": "w"}, bearer(tok)).body["id"].(string)
	const pushers, per, batch = 8, 1250, 50
	var wg sync.WaitGroup
	start := time.Now()
	for p := 0; p < pushers; p++ {
		wg.Add(1)
		go func(p int) {
			defer wg.Done()
			for i := 0; i < per; i += batch {
				var ops []string
				for j := 0; j < batch; j++ {
					ops = append(ops, pushOp(ws, p*per+i+j+1, "AQ"))
				}
				if r := m.do(t, "POST", "/v1/ws/"+ws+"/ops", rawOps(ops...), bearer(tok)); r.code != 200 {
					t.Errorf("push: %d %v", r.code, r.body)
					return
				}
			}
		}(p)
	}
	wg.Wait()
	rate := float64(pushers*per) / time.Since(start).Seconds()
	t.Logf("%d ops by %d pushers with real accounts: %.0f ops/s", pushers*per, pushers, rate)
	if rate < 2000 && !testing.Short() && !raceEnabled {
		t.Fatalf("%.0f ops/s is below the 2000 target", rate)
	}
}

// --- helpers ---

type rawBody map[string]any

func rawOps(ops ...string) any {
	raws := make([]json.RawMessage, len(ops))
	for i, o := range ops {
		raws[i] = json.RawMessage(o)
	}
	return map[string]any{"ops": raws}
}

func pushOp(ws string, n int, p string) string {
	hlc := fmt.Sprintf("%012x-0000-%s", time.Now().UnixMilli(), "019a8f3c-0004-7c3e-8f00-000000000001")
	return fmt.Sprintf(`{"v":1,"op":"019a8f3c-%04x-7c3e-8f00-%012x","ws":%q,"doc":"019a8f3c-0003-7c3e-8f00-%012x","dev":"019a8f3c-0004-7c3e-8f00-000000000001","t":%q,"sv":1,"kid":0,"p":%q}`, n>>16&0xffff|0x2000, n, ws, n%7, hlc, p)
}

func TestPushLimiterAppliesToAccountsButNotToTheDevToken(t *testing.T) {
	m := newM4(t, func(c *Config) { c.DevMode = true; c.DevToken = "dev" })
	push := func(h map[string]string, ws string) int {
		return m.do(t, "POST", "/v1/ws/"+ws+"/ops", map[string]any{"ops": []any{}}, merge(h, map[string]string{"Nevis-Proto": "1"})).code
	}
	dev := bearer("dev")
	for i := 0; i < 3100; i++ {
		if c := push(dev, "00000000-0000-7000-8000-000000000001"); c != 200 {
			t.Fatalf("dev push %d got %d", i, c)
		}
	}
	tok := m.signup(t, "limited", "device").body["token"].(string)
	id := m.do(t, "POST", "/v1/ws", map[string]any{"name": "w"}, merge(bearer(tok), map[string]string{"Nevis-Proto": "1"})).body["id"].(string)
	got429 := false
	for i := 0; i < 3100 && !got429; i++ {
		got429 = push(bearer(tok), id) == 429
	}
	if !got429 {
		t.Fatal("an account was never rate limited")
	}
}

func TestSignupLimitIsConfigurable(t *testing.T) {
	m := newM4(t, func(c *Config) { c.SignupsPerHour = 3 })
	codes := []int{}
	for i := 0; i < 5; i++ {
		codes = append(codes, m.signup(t, "limit"+string(rune('a'+i)), "device").code)
	}
	if codes[2] != 200 || codes[3] != 429 || codes[4] != 429 {
		t.Fatalf("with a limit of 3 the 4th and 5th sign-up must be refused: %v", codes)
	}
}
