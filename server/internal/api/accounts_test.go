package api

import (
	"math"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/0xVexor/Nevis/server/internal/config"
)

const secretPhrase = "my secret phrase"

func registerBody(e *env, name, password string, more ...J) J {
	return merge(J{"username": name, "password": password}, append([]J{e.pow()}, more...)...)
}

func TestAccounts(t *testing.T) {
	t.Run("registers with a username and a password, and shows a recovery key once", func(t *testing.T) {
		e := newEnv(t)
		a := e.register("alice")
		if !strings.HasPrefix(a.token, "nvs_") {
			t.Fatalf("token %q", a.token)
		}
		if !regexp.MustCompile(`^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$`).MatchString(a.recovery) {
			t.Fatalf("recovery key %q", a.recovery)
		}
		me := e.call("GET", "/v1/account", opts{token: a.token})
		devices := me.body.list("devices")
		if me.status != 200 || me.body.obj("user").str("username") != "alice" || len(devices) != 1 || !devices[0].flag("current") {
			t.Fatalf("account %d %v", me.status, me.body)
		}
		if me.body.obj("quota").num("limit") != e.cfg.QuotaBytes || me.body.num("vaults") != 0 {
			t.Fatalf("account %v", me.body)
		}
	})

	t.Run("refuses a taken user name (any letter case), a weak password and a missing proof of work", func(t *testing.T) {
		e := newEnv(t)
		e.register("alice")
		again := e.call("POST", "/v1/auth/register", opts{json: registerBody(e, "ALICE", "another password")})
		if again.status != 409 || again.body.str("error") != "username_taken" {
			t.Fatalf("%d %v", again.status, again.body)
		}
		weak := e.call("POST", "/v1/auth/register", opts{json: registerBody(e, "bob", "short")})
		if weak.body.str("error") != "weak_password" {
			t.Fatalf("%v", weak.body)
		}
		bad := e.call("POST", "/v1/auth/register", opts{json: J{"username": "bob", "password": "long enough pw"}})
		if bad.status != 400 {
			t.Fatalf("%d", bad.status)
		}
		odd := e.call("POST", "/v1/auth/register", opts{json: registerBody(e, "a b", "long enough pw")})
		if odd.body.str("error") != "bad_username" {
			t.Fatalf("%v", odd.body)
		}
	})

	t.Run("does not accept the same proof of work twice", func(t *testing.T) {
		e := newEnv(t)
		work := e.pow()
		first := e.call("POST", "/v1/auth/register", opts{json: merge(J{"username": "one", "password": "long enough pw"}, work)})
		if first.status != 201 {
			t.Fatalf("%d %v", first.status, first.body)
		}
		second := e.call("POST", "/v1/auth/register", opts{json: merge(J{"username": "two", "password": "long enough pw"}, work)})
		if second.status != 400 {
			t.Fatalf("%d", second.status)
		}
	})

	t.Run("needs an invite code in invite mode, and a code can be limited to a number of accounts", func(t *testing.T) {
		e := newEnv(t, func(c *config.Config) {
			c.Registration = "invite"
			c.InviteCodes = map[string]int{"golden": 1, "forever": math.MaxInt}
		})
		try := func(name, invite string) reply {
			return e.call("POST", "/v1/auth/register", opts{json: registerBody(e, name, "long enough pw", J{"invite": invite})})
		}
		if r := try("bob", "nope"); r.body.str("error") != "bad_invite" {
			t.Fatalf("%v", r.body)
		}
		if r := try("bob", "golden"); r.status != 201 {
			t.Fatalf("%d %v", r.status, r.body)
		}
		if r := try("carl", "golden"); r.body.str("error") != "invite_used" {
			t.Fatalf("%v", r.body)
		}
		if r := try("dora", "forever"); r.status != 201 {
			t.Fatalf("%d", r.status)
		}
		if r := try("eve", "constructor"); r.body.str("error") != "bad_invite" {
			t.Fatalf("%v", r.body)
		}
	})

	t.Run("is closed when registration is closed", func(t *testing.T) {
		e := newEnv(t, func(c *config.Config) { c.Registration = "closed" })
		r := e.call("POST", "/v1/auth/register", opts{json: registerBody(e, "bob", "long enough pw")})
		if r.status != 403 || r.body.str("error") != "registration_closed" {
			t.Fatalf("%d %v", r.status, r.body)
		}
	})

	t.Run("limits sign-ups per address", func(t *testing.T) {
		e := newEnv(t, func(c *config.Config) { c.RegisterPerHour = 2 })
		for i := range 2 {
			e.register("user" + strconv.Itoa(i))
		}
		r := e.call("POST", "/v1/auth/register", opts{json: registerBody(e, "user9", "long enough pw")})
		if r.status != 429 || r.header.Get("Retry-After") == "" {
			t.Fatalf("%d %v", r.status, r.header)
		}
		if other := e.call("POST", "/v1/auth/register", opts{ip: "198.51.100.4", json: registerBody(e, "user9", "long enough pw")}); other.status != 201 {
			t.Fatalf("another address must not be affected: %d", other.status)
		}
	})

	t.Run("logs in, and answers an unknown user like a wrong password", func(t *testing.T) {
		e := newEnv(t)
		e.register("alice", J{"password": secretPhrase})
		if ok := e.login("Alice", secretPhrase, "phone"); ok.status != 200 {
			t.Fatalf("%d %v", ok.status, ok.body)
		}
		wrong, none := e.login("alice", "not it", "phone"), e.login("nobody", "not it", "phone")
		if wrong.status != 401 || !reflect.DeepEqual(wrong.body, none.body) {
			t.Fatalf("%d %v / %d %v", wrong.status, wrong.body, none.status, none.body)
		}
	})

	t.Run("locks a user name after ten wrong passwords, even for the right one", func(t *testing.T) {
		e := newEnv(t)
		e.register("alice", J{"password": secretPhrase})
		for i := range 10 {
			if r := e.login("alice", "wrong", "phone"); r.status != 401 {
				t.Fatalf("attempt %d: %d", i, r.status)
			}
		}
		locked := e.login("alice", secretPhrase, "phone")
		retry, _ := strconv.Atoi(locked.header.Get("Retry-After"))
		if locked.status != 429 || retry <= 0 {
			t.Fatalf("%d %v", locked.status, locked.header)
		}
	})

	t.Run("a lock on a user name ends after the window", func(t *testing.T) {
		e := newEnv(t)
		e.register("alice", J{"password": secretPhrase})
		for range 10 {
			e.login("alice", "wrong", "phone")
		}
		e.clock.advance(16 * time.Minute)
		if r := e.login("alice", secretPhrase, "phone"); r.status != 200 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("needs a token, and a revoked device is out at once", func(t *testing.T) {
		e := newEnv(t)
		a := e.register("alice")
		if r := e.call("GET", "/v1/account"); r.status != 401 {
			t.Fatalf("%d", r.status)
		}
		if r := e.call("GET", "/v1/account", opts{token: "nvs_" + strings.Repeat("x", 30)}); r.status != 401 {
			t.Fatalf("%d", r.status)
		}
		if r := e.call("POST", "/v1/auth/logout", opts{token: a.token}); r.status != 200 {
			t.Fatalf("%d", r.status)
		}
		if r := e.call("GET", "/v1/account", opts{token: a.token}); r.status != 401 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("lists and revokes devices", func(t *testing.T) {
		e := newEnv(t)
		a := e.register("alice", J{"password": secretPhrase})
		phone := e.login("alice", secretPhrase, "phone").body
		list := e.call("GET", "/v1/account", opts{token: a.token})
		var names []string
		for _, d := range list.body.list("devices") {
			names = append(names, d.str("name"))
		}
		if !reflect.DeepEqual(names, []string{"laptop", "phone"}) {
			t.Fatalf("%v", names)
		}
		phoneID, phoneToken := phone.obj("device").str("id"), phone.str("token")
		if r := e.call("DELETE", "/v1/devices/"+phoneID, opts{token: a.token}); r.status != 200 {
			t.Fatalf("%d", r.status)
		}
		if r := e.call("GET", "/v1/account", opts{token: phoneToken}); r.status != 401 {
			t.Fatalf("%d", r.status)
		}
		if r := e.call("GET", "/v1/account", opts{token: a.token}); r.status != 200 {
			t.Fatalf("%d", r.status)
		}
		if r := e.call("DELETE", "/v1/devices/"+phoneID, opts{token: a.token}); r.status != 404 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("changing the password logs the other devices out", func(t *testing.T) {
		e := newEnv(t)
		a := e.register("alice", J{"password": secretPhrase})
		phone := e.login("alice", secretPhrase, "phone").body
		bad := e.call("POST", "/v1/auth/password", opts{token: a.token, json: J{"old_password": "wrong", "new_password": "a brand new phrase"}})
		if bad.status != 401 {
			t.Fatalf("%d", bad.status)
		}
		ok := e.call("POST", "/v1/auth/password", opts{token: a.token, json: J{"old_password": secretPhrase, "new_password": "a brand new phrase"}})
		if ok.status != 200 {
			t.Fatalf("%d %v", ok.status, ok.body)
		}
		if r := e.call("GET", "/v1/account", opts{token: phone.str("token")}); r.status != 401 {
			t.Fatalf("%d", r.status)
		}
		if r := e.call("GET", "/v1/account", opts{token: a.token}); r.status != 200 {
			t.Fatalf("%d", r.status)
		}
		if r := e.login("alice", secretPhrase, "x"); r.status != 401 {
			t.Fatalf("%d", r.status)
		}
		if r := e.login("alice", "a brand new phrase", "x"); r.status != 200 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("recovers an account with the recovery key, which then changes", func(t *testing.T) {
		e := newEnv(t)
		a := e.register("alice", J{"password": secretPhrase})
		typed := strings.ToLower(strings.ReplaceAll(a.recovery, "-", " "))
		r := e.call("POST", "/v1/auth/recover", opts{json: merge(J{"username": "alice", "recovery_key": typed, "new_password": "after recovery pw"}, e.pow())})
		if r.status != 200 || r.body.str("recovery_key") == a.recovery || r.body.str("recovery_key") == "" {
			t.Fatalf("%d %v", r.status, r.body)
		}
		if got := e.call("GET", "/v1/account", opts{token: a.token}); got.status != 401 {
			t.Fatalf("the old device must be out: %d", got.status)
		}
		if got := e.call("GET", "/v1/account", opts{token: r.body.str("token")}); got.status != 200 {
			t.Fatalf("%d", got.status)
		}
		if got := e.login("alice", "after recovery pw", "x"); got.status != 200 {
			t.Fatalf("%d", got.status)
		}
		again := e.call("POST", "/v1/auth/recover", opts{json: merge(J{"username": "alice", "recovery_key": a.recovery, "new_password": "yet another pw"}, e.pow())})
		if again.status != 401 {
			t.Fatalf("the used key must not work again: %d", again.status)
		}
	})

	t.Run("wrong recovery keys are counted like wrong passwords", func(t *testing.T) {
		e := newEnv(t)
		e.register("alice")
		try := func() reply {
			return e.call("POST", "/v1/auth/recover", opts{json: merge(J{"username": "alice", "recovery_key": "AAAAA-AAAAA-AAAAA-AAAAA", "new_password": "whatever pw 1"}, e.pow())})
		}
		for i := range 10 {
			if r := try(); r.status != 401 {
				t.Fatalf("attempt %d: %d", i, r.status)
			}
		}
		if r := try(); r.status != 429 {
			t.Fatalf("%d", r.status)
		}
	})

	t.Run("the recovery key can be replaced with the password", func(t *testing.T) {
		e := newEnv(t)
		a := e.register("alice", J{"password": secretPhrase})
		if r := e.call("POST", "/v1/auth/recovery-key", opts{token: a.token, json: J{"password": "wrong"}}); r.status != 401 {
			t.Fatalf("%d", r.status)
		}
		r := e.call("POST", "/v1/auth/recovery-key", opts{token: a.token, json: J{"password": secretPhrase}})
		if r.status != 200 || r.body.str("recovery_key") == a.recovery {
			t.Fatalf("%d %v", r.status, r.body)
		}
		old := e.call("POST", "/v1/auth/recover", opts{json: merge(J{"username": "alice", "recovery_key": a.recovery, "new_password": "yet another pw"}, e.pow())})
		if old.status != 401 {
			t.Fatalf("the replaced key must not work: %d", old.status)
		}
	})

	t.Run("a deleted account can be brought back by logging in during the grace period", func(t *testing.T) {
		e := newEnv(t)
		a := e.register("alice", J{"password": secretPhrase})
		del := e.call("DELETE", "/v1/account", opts{token: a.token, json: J{"password": secretPhrase}})
		wantAfter := e.clock.now().Add(30 * day).UnixMilli()
		if del.status != 200 || del.body.num("delete_after") != wantAfter {
			t.Fatalf("%d %v (want %d)", del.status, del.body, wantAfter)
		}
		if r := e.call("GET", "/v1/account", opts{token: a.token}); r.status != 401 {
			t.Fatalf("%d", r.status)
		}
		back := e.login("alice", secretPhrase, "phone")
		if back.status != 200 || !back.body.flag("restored") {
			t.Fatalf("%d %v", back.status, back.body)
		}
	})

	t.Run("refuses a client that is too old", func(t *testing.T) {
		e := newEnv(t)
		if r := e.call("GET", "/v1/health", opts{headers: map[string]string{"X-Noviq-Api": "0"}}); r.status != 426 {
			t.Fatalf("%d", r.status)
		}
		if r := e.call("GET", "/v1/health"); !r.body.flag("ok") {
			t.Fatalf("%v", r.body)
		}
	})

	t.Run("limits sign-ups and sign-ins by the address behind a trusted proxy, not by the proxy", func(t *testing.T) {
		proxies, _ := config.ParseTrustProxy("loopback")
		e := newEnv(t, func(c *config.Config) { c.RegisterPerHour = 1; c.TrustProxy = proxies })
		at := func(client string) opts {
			return opts{ip: "127.0.0.1", headers: map[string]string{"X-Forwarded-For": client}}
		}
		sign := func(name, client string) int {
			o := at(client)
			o.json = registerBody(e, name, "long enough pw")
			return e.call("POST", "/v1/auth/register", o).status
		}
		if s := sign("first", "198.51.100.1"); s != 201 {
			t.Fatalf("%d", s)
		}
		if s := sign("second", "198.51.100.1"); s != 429 {
			t.Fatalf("the same client behind the proxy must be limited: %d", s)
		}
		if s := sign("third", "198.51.100.2"); s != 201 {
			t.Fatalf("another client behind the same proxy must not be: %d", s)
		}
	})

	t.Run("without a trusted proxy a forged X-Forwarded-For does not buy a new allowance", func(t *testing.T) {
		e := newEnv(t, func(c *config.Config) { c.RegisterPerHour = 1 })
		sign := func(name, forged string) int {
			return e.call("POST", "/v1/auth/register", opts{headers: map[string]string{"X-Forwarded-For": forged}, json: registerBody(e, name, "long enough pw")}).status
		}
		if s := sign("first", "198.51.100.1"); s != 201 {
			t.Fatalf("%d", s)
		}
		if s := sign("second", "198.51.100.99"); s != 429 {
			t.Fatalf("a client chose its own address: %d", s)
		}
	})
}
