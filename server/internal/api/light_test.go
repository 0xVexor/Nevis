package api

// Tests that need no database: the shape of the API, the identifiers the clients depend on, the client address.

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/0xVexor/Nevis/server/internal/config"
)

func lightHandler(tweak ...func(*config.Config)) http.Handler {
	cfg := testConfig("")
	for _, f := range tweak {
		f(&cfg)
	}
	return New(Deps{Cfg: cfg, Now: time.Now, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
}

func lightCall(h http.Handler, method, target string, headers map[string]string) (*httptest.ResponseRecorder, J) {
	req := httptest.NewRequest(method, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var body J
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec, body
}

func TestHealthNamesTheServerTheWayTheClientExpects(t *testing.T) {
	rec, body := lightCall(lightHandler(), "GET", "/v1/health", nil)
	if rec.Code != 200 || !body.flag("ok") {
		t.Fatalf("%d %v", rec.Code, body)
	}
	// the desktop client refuses any server whose name is not this, and asks for the database capability before it syncs databases/
	if body.str("name") != "nevis-sync" {
		t.Fatalf("name %q", body.str("name"))
	}
	caps, _ := body["capabilities"].([]any)
	if len(caps) != 2 || caps[0] != "database_sync" || caps[1] != "page_state" {
		t.Fatalf("capabilities %v", body["capabilities"])
	}
	if body.num("api") != 1 || body.num("min_api") != 1 || body.str("registration") != "open" || body.num("pow_bits") != 4 || body.num("server_time") == 0 {
		t.Fatalf("health %v", body)
	}
	if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("X-Nevis-Api") != "1" || rec.Header().Get("X-Noviq-Api") != "1" {
		t.Fatalf("headers %v", rec.Header())
	}
}

func TestClientsThatAreTooOldAreTold(t *testing.T) {
	h := lightHandler()
	for _, header := range []string{"X-Noviq-Api", "X-Nevis-Api"} {
		rec, body := lightCall(h, "GET", "/v1/health", map[string]string{header: "0"})
		if rec.Code != 426 || body.str("error") != "upgrade_required" || body.num("min") != 1 {
			t.Errorf("%s: %d %v", header, rec.Code, body)
		}
		if rec, _ := lightCall(h, "GET", "/v1/health", map[string]string{header: "1"}); rec.Code != 200 {
			t.Errorf("%s: a current client got %d", header, rec.Code)
		}
	}
	if rec, _ := lightCall(h, "GET", "/v1/health", map[string]string{"X-Noviq-Api": "banana"}); rec.Code != 200 {
		t.Errorf("an unreadable version is not a reason to refuse: %d", rec.Code)
	}
}

func TestUnknownPathsAndMethodsAreJSON404(t *testing.T) {
	h := lightHandler()
	for _, c := range [][2]string{{"GET", "/nothing"}, {"GET", "/v1/nothing"}, {"POST", "/v1/health"}, {"DELETE", "/"}} {
		rec, body := lightCall(h, c[0], c[1], nil)
		if rec.Code != 404 || body.str("error") != "not_found" {
			t.Errorf("%v: %d %v", c, rec.Code, body)
		}
	}
}

func TestRootIsAPlainNameForHumans(t *testing.T) {
	rec, _ := lightCall(lightHandler(), "GET", "/", nil)
	if rec.Code != 200 || rec.Body.String() != "nevis-sync" {
		t.Fatalf("%d %q", rec.Code, rec.Body.String())
	}
}

// Every route that is not public refuses a request without a token with the same JSON; this also proves that the
// GET and HEAD patterns of the blob path do not collide.
func TestProtectedRoutesNeedAToken(t *testing.T) {
	h := lightHandler()
	for _, c := range [][2]string{
		{"GET", "/v1/account"}, {"POST", "/v1/auth/logout"}, {"POST", "/v1/auth/password"}, {"POST", "/v1/auth/recovery-key"},
		{"DELETE", "/v1/account"}, {"DELETE", "/v1/devices/x"}, {"GET", "/v1/vaults"}, {"POST", "/v1/vaults"},
		{"PATCH", "/v1/vaults/x"}, {"DELETE", "/v1/vaults/x"}, {"POST", "/v1/vaults/x/undelete"}, {"GET", "/v1/vaults/x/state"},
		{"GET", "/v1/vaults/x/changes"}, {"GET", "/v1/vaults/x/file"}, {"GET", "/v1/vaults/x/revisions"}, {"POST", "/v1/vaults/x/commit"},
		{"POST", "/v1/vaults/x/restore"}, {"PUT", "/v1/vaults/x/blobs/y"}, {"HEAD", "/v1/vaults/x/blobs/y"}, {"GET", "/v1/vaults/x/blobs/y"},
		{"GET", "/v1/vaults/x/rev/1"},
	} {
		rec, body := lightCall(h, c[0], c[1], nil)
		if rec.Code != 401 {
			t.Errorf("%v: %d", c, rec.Code)
		}
		if c[0] != "HEAD" && body.str("error") != "unauthorized" {
			t.Errorf("%v: %v", c, body)
		}
	}
	rec, _ := lightCall(h, "GET", "/v1/account", map[string]string{"Authorization": "Bearer nvq_" + "x"})
	if rec.Code != 401 {
		t.Fatalf("a token that is not the right shape: %d", rec.Code)
	}
}

func TestCounterKeepsTheDigitsTheClientSent(t *testing.T) {
	for in, want := range map[string]string{`1000000`: "1000000", `"123"`: "123", `18446744073709551615`: "18446744073709551615", `0`: "0", `null`: ""} {
		var b credentialsBody
		if err := json.Unmarshal([]byte(`{"counter":`+in+`}`), &b); err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if got := b.credentials().Counter; got != want {
			t.Errorf("%s: %q, want %q", in, got, want)
		}
	}
}

func TestClientAddress(t *testing.T) {
	proxies, _ := config.ParseTrustProxy("loopback, 10.0.0.0/8")
	cases := []struct {
		name, trust, peer, xff, want string
	}{
		{"nobody trusted: the header is ignored", "", "203.0.113.9:5000", "1.2.3.4", "203.0.113.9"},
		{"trusted proxy: its client", "t", "127.0.0.1:5000", "198.51.100.7", "198.51.100.7"},
		{"a spoofed first entry is not believed", "t", "127.0.0.1:5000", "1.2.3.4, 198.51.100.7", "198.51.100.7"},
		{"trusted hops on the right are skipped", "t", "127.0.0.1:5000", "198.51.100.7, 10.0.0.5", "198.51.100.7"},
		{"untrusted peer: the header is ignored", "t", "203.0.113.9:5000", "1.2.3.4", "203.0.113.9"},
		{"trusted proxy, no header", "t", "127.0.0.1:5000", "", "127.0.0.1"},
		{"garbage in the header", "t", "127.0.0.1:5000", "not-an-ip", "127.0.0.1"},
		{"IPv6 peer and client", "t", "[::1]:5000", "2001:db8::7", "2001:db8::7"},
		{"IPv4 mapped into IPv6", "t", "[::ffff:127.0.0.1]:5000", "198.51.100.7", "198.51.100.7"},
		{"every hop trusted", "t", "127.0.0.1:5000", "10.0.0.2, 10.0.0.3", "127.0.0.1"},
	}
	for _, c := range cases {
		s := &Server{}
		if c.trust != "" {
			s.Cfg.TrustProxy = proxies
		}
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = c.peer
		if c.xff != "" {
			req.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := s.clientIP(req); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
}
