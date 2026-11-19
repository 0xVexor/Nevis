package api

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/0xVexor/Nevis/server/internal/auth"
	"github.com/0xVexor/Nevis/server/internal/config"
	"github.com/0xVexor/Nevis/server/internal/db"
	"github.com/0xVexor/Nevis/server/internal/hub"
	"github.com/0xVexor/Nevis/server/internal/storage"
	"github.com/0xVexor/Nevis/server/internal/vaults"
)

const day = 24 * time.Hour

// clock is the time the server believes it is; tests move it instead of sleeping.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// env is a whole server on a temporary directory, called in-process.
type env struct {
	t        *testing.T
	cfg      config.Config
	dir      string
	db       *db.DB
	store    *vaults.Store
	accounts *auth.Accounts
	hub      *hub.Hub
	clock    *clock
	writes   atomic.Int32
	handler  http.Handler
}

func testConfig(dir string) config.Config {
	cfg, _ := config.Load(func(string) string { return "" })
	cfg.DataDir = dir
	cfg.Secret = strings.Repeat("k", 40)
	cfg.Registration = "open"
	cfg.PowBits = 4
	return cfg
}

func newEnv(t *testing.T, tweak ...func(*config.Config)) *env {
	t.Helper()
	dir := t.TempDir()
	cfg := testConfig(dir)
	for _, f := range tweak {
		f(&cfg)
	}
	database, err := db.Open(filepath.Join(dir, "nevis.db"))
	if err != nil {
		t.Fatal(err)
	}
	blobs, err := storage.NewBlobs(dir)
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, cfg: cfg, dir: dir, db: database, hub: hub.New(), clock: &clock{t: time.UnixMilli(1_700_000_000_000)}}
	now := e.clock.now
	e.accounts = &auth.Accounts{DB: database, Cfg: cfg, Now: now, Limiter: auth.NewLimiter(now), Cost: auth.Cost{N: 16, R: 1, P: 1}}
	e.store = &vaults.Store{DB: database, Blobs: blobs, Cfg: cfg, Now: now}
	e.handler = New(Deps{Cfg: cfg, Accounts: e.accounts, Vaults: e.store, Hub: e.hub, Now: now,
		OnWrite: func() { e.writes.Add(1) }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	t.Cleanup(func() {
		e.hub.ReleaseAll()
		database.Close()
	})
	return e
}

// J is a decoded JSON object with typed getters, so that assertions read like the Node tests did.
type J map[string]any

func (j J) str(k string) string { s, _ := j[k].(string); return s }
func (j J) num(k string) int64  { f, _ := j[k].(float64); return int64(f) }
func (j J) flag(k string) bool  { b, _ := j[k].(bool); return b }
func (j J) obj(k string) J      { o, _ := j[k].(map[string]any); return o }
func (j J) list(k string) []J {
	var out []J
	items, _ := j[k].([]any)
	for _, it := range items {
		o, _ := it.(map[string]any)
		out = append(out, o)
	}
	return out
}

// reply is what a call returns.
type reply struct {
	status int
	body   J
	header http.Header
	raw    []byte
}

// opts are the optional parts of a call.
type opts struct {
	token   string
	json    any
	raw     []byte
	headers map[string]string
	ip      string
}

func (e *env) call(method, target string, o ...opts) reply {
	e.t.Helper()
	var opt opts
	if len(o) > 0 {
		opt = o[0]
	}
	var body io.Reader
	contentType := ""
	switch {
	case opt.raw != nil:
		body, contentType = bytes.NewReader(opt.raw), "application/octet-stream"
	case opt.json != nil:
		b, err := json.Marshal(opt.json)
		if err != nil {
			e.t.Fatal(err)
		}
		body, contentType = bytes.NewReader(b), "application/json"
	}
	req := httptest.NewRequest(method, target, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if opt.token != "" {
		req.Header.Set("Authorization", "Bearer "+opt.token)
	}
	for k, v := range opt.headers {
		req.Header.Set(k, v)
	}
	if opt.ip != "" {
		req.RemoteAddr = opt.ip + ":4000"
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	out := reply{status: rec.Code, header: rec.Header(), raw: rec.Body.Bytes()}
	_ = json.Unmarshal(out.raw, &out.body)
	return out
}

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func md5hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

// pow solves a sign-up challenge the way a client does.
func (e *env) pow() J {
	r := e.call("GET", "/v1/auth/challenge")
	challenge := r.body.str("challenge")
	return J{"challenge": challenge, "counter": auth.SolvePow(challenge, int(r.body.num("bits")))}
}

func merge(a J, more ...J) J {
	out := J{}
	for k, v := range a {
		out[k] = v
	}
	for _, m := range more {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

// user is a signed-in account on one device.
type user struct {
	name, token, deviceID, userID, recovery string
}

func (e *env) register(name string, extra ...J) user {
	e.t.Helper()
	body := merge(J{"username": name, "password": "correct horse battery", "device_name": "laptop"}, e.pow())
	r := e.call("POST", "/v1/auth/register", opts{json: merge(body, extra...)})
	if r.status != 201 {
		e.t.Fatalf("register %s failed: %d %v", name, r.status, r.body)
	}
	return user{name: name, token: r.body.str("token"), deviceID: r.body.obj("device").str("id"), userID: r.body.obj("user").str("id"), recovery: r.body.str("recovery_key")}
}

func (e *env) login(name, password, device string) reply {
	return e.call("POST", "/v1/auth/login", opts{json: J{"username": name, "password": password, "device_name": device}})
}

func (e *env) newVault(token, name string) string {
	e.t.Helper()
	id := auth.NewID()
	r := e.call("POST", "/v1/vaults", opts{token: token, json: J{"id": id, "name": name}})
	if r.status != 201 {
		e.t.Fatalf("vault failed: %d %v", r.status, r.body)
	}
	return id
}

func (e *env) putBlob(token, vault, content string) string {
	e.t.Helper()
	r := e.call("PUT", fmt.Sprintf("/v1/vaults/%s/blobs/%s", vault, sha(content)), opts{token: token, raw: []byte(content)})
	if r.status != 201 && r.status != 200 {
		e.t.Fatalf("blob failed: %d %v", r.status, r.body)
	}
	return sha(content)
}

// op is one write of a commit: a put of content, or a delete.
type op struct {
	path, content string
	base          int64
	del           bool
}

func put(path, content string, base ...int64) op {
	o := op{path: path, content: content}
	if len(base) > 0 {
		o.base = base[0]
	}
	return o
}

func del(path string, base int64) op { return op{path: path, base: base, del: true} }

var opCounter atomic.Int64

// commit uploads the blobs, then commits the ops in one request.
func (e *env) commit(token, vault string, ops []op, extra ...J) reply {
	e.t.Helper()
	list := make([]J, 0, len(ops))
	for _, o := range ops {
		if o.del {
			list = append(list, J{"op": "delete", "path": o.path, "base_rev": o.base})
			continue
		}
		list = append(list, J{"op": "put", "path": o.path, "sha256": e.putBlob(token, vault, o.content), "base_rev": o.base})
	}
	body := merge(J{"op_id": fmt.Sprintf("op-%d-%s", opCounter.Add(1), auth.NewID()[:8]), "ops": list}, extra...)
	return e.call("POST", "/v1/vaults/"+vault+"/commit", opts{token: token, json: body})
}

func (e *env) changes(token, vault string, since int64, limit int) reply {
	return e.call("GET", fmt.Sprintf("/v1/vaults/%s/changes?since=%d&limit=%d", vault, since, limit), opts{token: token})
}

func (e *env) state(token, vault string) J {
	return e.call("GET", "/v1/vaults/"+vault+"/state", opts{token: token}).body
}

func (e *env) housekeeping(after time.Duration) vaults.GCStats {
	e.t.Helper()
	st, err := e.store.Housekeeping(context.Background(), e.clock.now().Add(after))
	if err != nil {
		e.t.Fatal(err)
	}
	return st
}
