package api

import (
	"encoding/json"
	"net/http"

	"github.com/0xVexor/Nevis/server/internal/auth"
)

// counter is the proof-of-work counter. It is kept as the text the client sent: the server hashes the digits it was
// given, and a number that went through a float would print as 1e+06 and never match.
type counter string

func (c *counter) UnmarshalJSON(raw []byte) error {
	if len(raw) > 0 && raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return err
		}
		*c = counter(s)
		return nil
	}
	if string(raw) != "null" {
		*c = counter(raw)
	}
	return nil
}

type credentialsBody struct {
	Username    string  `json:"username"`
	Password    string  `json:"password"`
	OldPassword string  `json:"old_password"`
	NewPassword string  `json:"new_password"`
	RecoveryKey string  `json:"recovery_key"`
	Invite      string  `json:"invite"`
	DeviceName  string  `json:"device_name"`
	Challenge   string  `json:"challenge"`
	Counter     counter `json:"counter"`
}

func (b credentialsBody) credentials() auth.Credentials {
	return auth.Credentials{
		Username: b.Username, Password: b.Password, NewPassword: b.NewPassword, RecoveryKey: b.RecoveryKey,
		Invite: b.Invite, DeviceName: b.DeviceName, Challenge: b.Challenge, Counter: string(b.Counter),
	}
}

func (s *Server) accountRoutes() {
	s.route("GET /v1/auth/challenge", s.challenge)
	s.route("POST /v1/auth/register", s.register)
	s.route("POST /v1/auth/login", s.login)
	s.route("POST /v1/auth/recover", s.recoverAccount)
	s.authed("POST /v1/auth/logout", s.logout)
	s.authed("GET /v1/account", s.account)
	s.authed("POST /v1/auth/password", s.changePassword)
	s.authed("POST /v1/auth/recovery-key", s.newRecoveryKey)
	s.authed("DELETE /v1/devices/{id}", s.revokeDevice)
	s.authed("DELETE /v1/account", s.deleteAccount)
}

func (s *Server) challenge(w http.ResponseWriter, r *http.Request) error {
	c, aerr := s.Accounts.Challenge(s.clientIP(r))
	if aerr != nil {
		return aerr
	}
	writeJSON(w, 200, map[string]any{"challenge": c, "bits": s.Cfg.PowBits})
	return nil
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) error {
	var b credentialsBody
	if err := readJSON(w, r, &b); err != nil {
		return err
	}
	session, recovery, err := s.Accounts.Register(r.Context(), s.clientIP(r), b.credentials())
	if err != nil {
		return err
	}
	writeJSON(w, 201, struct {
		auth.Session
		RecoveryKey string `json:"recovery_key"`
	}{session, recovery})
	return nil
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) error {
	var b credentialsBody
	if err := readJSON(w, r, &b); err != nil {
		return err
	}
	session, restored, err := s.Accounts.Login(r.Context(), s.clientIP(r), b.credentials())
	if err != nil {
		return err
	}
	writeJSON(w, 200, struct {
		auth.Session
		Restored bool `json:"restored"`
	}{session, restored})
	return nil
}

func (s *Server) recoverAccount(w http.ResponseWriter, r *http.Request) error {
	var b credentialsBody
	if err := readJSON(w, r, &b); err != nil {
		return err
	}
	session, recovery, err := s.Accounts.Recover(r.Context(), s.clientIP(r), b.credentials())
	if err != nil {
		return err
	}
	writeJSON(w, 200, struct {
		auth.Session
		RecoveryKey string `json:"recovery_key"`
	}{session, recovery})
	return nil
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	if err := s.Accounts.Logout(r.Context(), p); err != nil {
		return err
	}
	return ok(w)
}

func (s *Server) account(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	created, devices, err := s.Accounts.Info(r.Context(), p)
	if err != nil {
		return err
	}
	used, err := s.Vaults.UsedBytes(r.Context(), p.User.ID)
	if err != nil {
		return err
	}
	vaultCount, err := s.Vaults.CountLive(r.Context(), p.User.ID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{
		"user":        map[string]any{"id": p.User.ID, "username": p.User.Username, "created_at": created},
		"devices":     devices,
		"quota":       map[string]any{"used": used, "limit": s.Cfg.QuotaBytes},
		"vaults":      vaultCount,
		"server_time": s.Now().UnixMilli(),
	})
	return nil
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var b credentialsBody
	if err := readJSON(w, r, &b); err != nil {
		return err
	}
	if err := s.Accounts.ChangePassword(r.Context(), s.clientIP(r), p, b.OldPassword, b.NewPassword); err != nil {
		return err
	}
	return ok(w)
}

func (s *Server) newRecoveryKey(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var b credentialsBody
	if err := readJSON(w, r, &b); err != nil {
		return err
	}
	key, err := s.Accounts.NewRecoveryKey(r.Context(), s.clientIP(r), p, b.Password)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"recovery_key": key})
	return nil
}

func (s *Server) revokeDevice(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	if err := s.Accounts.RevokeDevice(r.Context(), p, r.PathValue("id")); err != nil {
		return err
	}
	return ok(w)
}

func (s *Server) deleteAccount(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var b credentialsBody
	if err := readJSON(w, r, &b); err != nil {
		return err
	}
	after, err := s.Accounts.Delete(r.Context(), s.clientIP(r), p, b.Password)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"ok": true, "delete_after": after})
	return nil
}
