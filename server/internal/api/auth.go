package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/nevis-app/nevis/server/internal/apierr"
	"github.com/nevis-app/nevis/server/internal/auth"
	"github.com/nevis-app/nevis/server/internal/store"
)

var usernameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{2,31}$`)

const (
	failWindow   = 15 * time.Minute
	maxFailUser  = 10
	maxFailIP    = 100
	signupWindow = time.Hour
	maxSignupIP  = 30
)

type credentials struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DeviceName  string `json:"deviceName"`
	Client      string `json:"client"` // "web" (a cookie) or "device" (a token)
	Invite      string `json:"invite"`
	Challenge   string `json:"challenge"`
	Counter     any    `json:"counter"`
	RecoveryKey string `json:"recoveryKey"`
	NewPassword string `json:"newPassword"`
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		fail(w, 400, "bad_request", "the body is not the JSON this route expects", false)
		return false
	}
	return true
}

func clip(v string, n int) string {
	if r := []rune(v); len(r) > n {
		return string(r[:n])
	}
	return v
}

func (s *Server) challenge(w http.ResponseWriter, _ *http.Request) {
	if s.PowBits <= 0 {
		writeJSON(w, 200, map[string]any{"challenge": "", "bits": 0})
		return
	}
	writeJSON(w, 200, map[string]any{"challenge": auth.MakeChallenge(s.Secret, s.Now()), "bits": s.PowBits})
}

func counterString(c any) string {
	switch v := c.(type) {
	case string:
		return v
	case float64:
		return fmt.Sprintf("%.0f", v)
	}
	return ""
}

// takePow checks the proof of work and burns its nonce.
func (s *Server) takePow(ctx context.Context, in credentials) *apierr.Error {
	nonce, perr := auth.CheckPow(s.Secret, in.Challenge, counterString(in.Counter), s.PowBits, s.Now())
	if perr != nil {
		return perr
	}
	if nonce != "" {
		if err := s.st.UsePow(ctx, nonce); err != nil {
			if errors.Is(err, store.ErrPowUsed) {
				return apierr.New(400, "bad_challenge")
			}
			return apierr.New(500, "internal")
		}
	}
	return nil
}

func (s *Server) newDevice(account string, in credentials) (store.Device, string) {
	kind, token := "device", auth.NewToken()
	if in.Client == "web" {
		kind, token = "web", "nvw_"+auth.NewToken()[4:]
	}
	name := strings.TrimSpace(clip(in.DeviceName, 60))
	if name == "" {
		name = map[string]string{"web": "Web browser", "device": "Device"}[kind]
	}
	return store.Device{ID: auth.NewID(), Account: account, Name: name, Kind: kind}, token
}

func (s *Server) sessionResponse(w http.ResponseWriter, a *store.Account, d store.Device, token string, extra map[string]any) {
	out := map[string]any{"account": map[string]any{"id": a.ID, "username": a.Username}, "device": map[string]any{"id": d.ID, "name": d.Name, "kind": d.Kind}}
	for k, v := range extra {
		out[k] = v
	}
	if d.Kind == "web" {
		s.setCookie(w, token) // the token is never in JSON for a browser: scripts cannot read it
	} else {
		out["token"] = token
	}
	writeJSON(w, 200, out)
}

func (s *Server) signup(w http.ResponseWriter, r *http.Request) {
	var in credentials
	if !readJSON(w, r, &in) {
		return
	}
	switch s.registration() {
	case "closed":
		fail(w, 403, "registration_closed", "this server does not take new accounts", false)
		return
	case "invite":
		if !s.InviteCodes[in.Invite] {
			fail(w, 400, "bad_invite", "the invite code is wrong", false)
			return
		}
	}
	if ok, retry := s.limiter.Hit("signup:"+clientIP(r), maxSignupIP, signupWindow); !ok {
		failErr(w, apierr.RateLimited(retry))
		return
	}
	username := strings.ToLower(strings.TrimSpace(clip(in.Username, 40)))
	if !usernameRE.MatchString(username) {
		fail(w, 400, "bad_username", "use 3 to 32 letters, digits, dots, dashes or underscores", false)
		return
	}
	if len([]rune(in.Password)) < 8 {
		fail(w, 400, "weak_password", "the password needs at least 8 characters", false)
		return
	}
	if e := s.takePow(r.Context(), in); e != nil {
		failErr(w, e)
		return
	}
	hash, err := auth.HashPassword(in.Password, s.Cost)
	if err != nil {
		fail(w, 500, "internal", "could not hash the password", true)
		return
	}
	recovery := auth.NewRecoveryKey()
	a := store.Account{ID: auth.NewID(), Username: username, PassHash: hash, RecoveryHash: auth.RecoveryHash(recovery)}
	d, token := s.newDevice(a.ID, in)
	if err := s.st.CreateAccount(r.Context(), a, d, auth.SHA256Hex(token)); err != nil {
		if errors.Is(err, store.ErrUsernameTaken) {
			fail(w, 409, "username_taken", "this user name is taken", false)
			return
		}
		s.Log.Error("signup", "err", err)
		fail(w, 500, "internal", "could not create the account", true)
		return
	}
	s.sessionResponse(w, &a, d, token, map[string]any{"recoveryKey": recovery})
}

// A fixed hash, verified when the user name does not exist, so that an unknown user costs the same time as a wrong password.
var dummyHash, _ = auth.HashPassword("not a real password", auth.Cost{N: 16, R: 1, P: 1})

func (s *Server) guard(ip, username string) *apierr.Error {
	if n := s.limiter.Blocked("fail:u:"+username+"|"+ip, maxFailUser); n > 0 {
		return apierr.RateLimited(n)
	}
	if n := s.limiter.Blocked("fail:ip:"+ip, maxFailIP); n > 0 {
		return apierr.RateLimited(n)
	}
	return nil
}

func (s *Server) failed(ip, username string) {
	s.limiter.Hit("fail:u:"+username+"|"+ip, maxFailUser, failWindow)
	s.limiter.Hit("fail:ip:"+ip, maxFailIP, failWindow)
}

func (s *Server) signin(w http.ResponseWriter, r *http.Request) {
	var in credentials
	if !readJSON(w, r, &in) {
		return
	}
	ip := clientIP(r)
	username := strings.ToLower(strings.TrimSpace(clip(in.Username, 40)))
	if e := s.guard(ip, username); e != nil {
		failErr(w, e)
		return
	}
	a, err := s.st.AccountByName(r.Context(), username)
	stored := dummyHash
	if err == nil {
		stored = a.PassHash
	}
	if !auth.VerifyPassword(in.Password, stored) || err != nil {
		s.failed(ip, username)
		fail(w, 401, "bad_credentials", "the user name or password is wrong", false)
		return
	}
	s.limiter.Clear("fail:u:" + username + "|" + ip)
	d, token := s.newDevice(a.ID, in)
	if err := s.st.NewSession(r.Context(), d, auth.SHA256Hex(token)); err != nil {
		fail(w, 500, "internal", "could not start the session", true)
		return
	}
	s.sessionResponse(w, a, d, token, nil)
}

func (s *Server) recoverAccount(w http.ResponseWriter, r *http.Request) {
	var in credentials
	if !readJSON(w, r, &in) {
		return
	}
	ip := clientIP(r)
	username := strings.ToLower(strings.TrimSpace(clip(in.Username, 40)))
	if e := s.guard(ip, username); e != nil {
		failErr(w, e)
		return
	}
	if len([]rune(in.NewPassword)) < 8 {
		fail(w, 400, "weak_password", "the password needs at least 8 characters", false)
		return
	}
	if e := s.takePow(r.Context(), in); e != nil {
		failErr(w, e)
		return
	}
	a, err := s.st.AccountByName(r.Context(), username)
	want := auth.RecoveryHash("") // compared even when the user is unknown
	if err == nil {
		want = a.RecoveryHash
	}
	if err != nil || !auth.SafeEqual(auth.RecoveryHash(in.RecoveryKey), want) {
		s.failed(ip, username)
		fail(w, 401, "bad_recovery_key", "the recovery key is wrong", false)
		return
	}
	hash, err := auth.HashPassword(in.NewPassword, s.Cost)
	if err != nil {
		fail(w, 500, "internal", "could not hash the password", true)
		return
	}
	next := auth.NewRecoveryKey()
	if err := s.st.ResetCredentials(r.Context(), a.ID, hash, auth.RecoveryHash(next)); err != nil {
		fail(w, 500, "internal", "could not reset the account", true)
		return
	}
	s.limiter.Clear("fail:u:" + username + "|" + ip)
	d, token := s.newDevice(a.ID, in)
	if err := s.st.NewSession(r.Context(), d, auth.SHA256Hex(token)); err != nil {
		fail(w, 500, "internal", "could not start the session", true)
		return
	}
	s.sessionResponse(w, a, d, token, map[string]any{"recoveryKey": next})
}

func (s *Server) signout(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	if !p.Dev {
		tok := ""
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			tok = strings.TrimPrefix(h, "Bearer ")
		} else if c, err := r.Cookie(cookieName); err == nil {
			tok = c.Value
		}
		if err := s.st.EndSession(r.Context(), auth.SHA256Hex(tok)); err != nil {
			fail(w, 500, "internal", "could not sign out", true)
			return
		}
	}
	s.clearCookie(w)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	if p.Dev {
		writeJSON(w, 200, map[string]any{"dev": true})
		return
	}
	a, err := s.st.AccountByID(r.Context(), p.AccountID)
	if err != nil {
		fail(w, 401, "unauthorized", "the account is gone", false)
		return
	}
	writeJSON(w, 200, map[string]any{"account": map[string]any{"id": a.ID, "username": a.Username, "createdAt": a.CreatedAt}, "device": map[string]any{"id": p.DeviceID}, "usedBytes": a.UsedBytes, "quotaBytes": s.QuotaBytes})
}
