package auth

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/0xVexor/Nevis/server/internal/apierr"
	"github.com/0xVexor/Nevis/server/internal/config"
	"github.com/0xVexor/Nevis/server/internal/db"
)

const (
	hour         = time.Hour
	failureLimit = 10  // wrong passwords per user name from one address
	failureIPMax = 100 // wrong passwords per address; behind a shared mobile NAT the per-user limit is the real one
	// failureUserMax is the ceiling for one user name across all addresses. It is far above failureLimit so that
	// one attacker cannot lock the owner out, who signs in from another address; it only stops a distributed guess.
	failureUserMax = 100
	failureSpan    = 15 * time.Minute
)

var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{2,31}$`)

// Accounts is everything about users and their devices.
type Accounts struct {
	DB      *db.DB
	Cfg     config.Config
	Now     func() time.Time
	Limiter *Limiter
	Cost    Cost

	dummyOnce sync.Once
	dummy     string
}

// User is the public part of an account.
type User struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

// Device is one signed-in device.
type Device struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Session is what sign-up, sign-in and recovery hand back: the device token is shown only here.
type Session struct {
	User   User   `json:"user"`
	Token  string `json:"token"`
	Device Device `json:"device"`
}

// Principal is the authenticated caller of a request.
type Principal struct {
	User   User
	Device Device
}

// Credentials are the fields of sign-up, sign-in and recovery.
type Credentials struct {
	Username    string
	Password    string
	NewPassword string
	RecoveryKey string
	Invite      string
	DeviceName  string
	Challenge   string
	Counter     string
}

func (a *Accounts) ms() int64 { return a.Now().UnixMilli() }

// clip returns v unless it is longer than max characters (then "": an absurd value is treated as missing).
func clip(v string, max int) string {
	if utf8.RuneCountInString(v) > max {
		return ""
	}
	return v
}

func normalizeUsername(v string) string { return strings.ToLower(strings.TrimSpace(clip(v, 40))) }

func deviceName(v string) string {
	if n := strings.TrimSpace(clip(v, 60)); n != "" {
		return n
	}
	return "device"
}

func (a *Accounts) hash(password string) (string, error) { return HashPassword(password, a.Cost) }

// check burns the same time for an unknown user as for a wrong password, so that the answer does not tell
// whether a user name exists.
func (a *Accounts) check(password, stored string, found bool) bool {
	if !found {
		a.dummyOnce.Do(func() { a.dummy, _ = a.hash("nevis-dummy-password") })
		VerifyPassword(password, a.dummy)
		return false
	}
	return VerifyPassword(password, stored)
}

// ───── challenge, sign-up ─────

// Challenge starts a proof of work.
func (a *Accounts) Challenge(ip string) (string, *apierr.Error) {
	if ok, retry := a.Limiter.Hit("ch:"+ip, 120, hour); !ok {
		return "", apierr.RateLimited(retry)
	}
	return MakeChallenge(a.Cfg.Secret, a.Now()), nil
}

// takePow consumes the proof of work of a request: missing, wrong, old or used before is a 400.
func (a *Accounts) takePow(ctx context.Context, in Credentials) error {
	nonce, aerr := CheckPow(a.Cfg.Secret, in.Challenge, in.Counter, a.Cfg.PowBits, a.Now())
	if aerr != nil {
		return aerr
	}
	if nonce == "" {
		return nil
	}
	if _, err := a.DB.ExecContext(ctx, "INSERT INTO pow_used (nonce, at) VALUES (?, ?)", nonce, a.ms()); err != nil {
		return apierr.New(400, "bad_pow") // the nonce was used before
	}
	return nil
}

func (a *Accounts) checkInvite(ctx context.Context, code string) error {
	limit, known := a.Cfg.InviteCodes[code]
	if !known {
		return apierr.New(403, "bad_invite")
	}
	var used int
	err := a.DB.QueryRowContext(ctx, "SELECT uses FROM invite_uses WHERE code = ?", code).Scan(&used)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if used >= limit {
		return apierr.New(403, "invite_used")
	}
	return nil
}

// Register creates an account and its first device. The recovery key it returns is shown once.
func (a *Accounts) Register(ctx context.Context, ip string, in Credentials) (Session, string, error) {
	if ok, retry := a.Limiter.Hit("reg:"+ip, a.Cfg.RegisterPerHour, hour); !ok {
		return Session{}, "", apierr.RateLimited(retry)
	}
	if a.Cfg.Registration == "closed" {
		return Session{}, "", apierr.New(403, "registration_closed")
	}
	username := normalizeUsername(in.Username)
	password := clip(in.Password, 200)
	if !usernamePattern.MatchString(username) {
		return Session{}, "", apierr.New(400, "bad_username")
	}
	if utf8.RuneCountInString(password) < 8 {
		return Session{}, "", apierr.New(400, "weak_password")
	}
	if err := a.takePow(ctx, in); err != nil {
		return Session{}, "", err
	}
	invite := ""
	if a.Cfg.Registration == "invite" {
		invite = strings.TrimSpace(clip(in.Invite, 80))
		if err := a.checkInvite(ctx, invite); err != nil {
			return Session{}, "", err
		}
	}
	pass, err := a.hash(password)
	if err != nil {
		return Session{}, "", err
	}
	recovery := NewRecoveryKey()
	user := User{ID: NewID(), Username: username}
	var session Session
	err = a.DB.Write(ctx, func(tx *sql.Tx) error {
		var taken int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM users WHERE username = ?", username).Scan(&taken); err != nil {
			return err
		}
		if taken > 0 {
			return apierr.New(409, "username_taken")
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO users (id, username, pass, recovery, created_at) VALUES (?, ?, ?, ?, ?)",
			user.ID, username, pass, RecoveryHash(recovery), a.ms()); err != nil {
			return err
		}
		if invite != "" {
			if _, err := tx.ExecContext(ctx, "INSERT INTO invite_uses (code, uses) VALUES (?, 1) ON CONFLICT (code) DO UPDATE SET uses = uses + 1", invite); err != nil {
				return err
			}
		}
		session, err = a.issueDevice(ctx, tx, user, deviceName(in.DeviceName))
		return err
	})
	return session, recovery, err
}

func (a *Accounts) issueDevice(ctx context.Context, tx *sql.Tx, user User, name string) (Session, error) {
	token, dev := NewToken(), Device{ID: NewID(), Name: name}
	_, err := tx.ExecContext(ctx, "INSERT INTO devices (id, user_id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
		dev.ID, user.ID, name, SHA256Hex(token), a.ms(), a.ms())
	return Session{User: user, Token: token, Device: dev}, err
}

// ───── sign-in, recovery ─────

// failureKey counts the wrong passwords of one user name from one address.
func failureKey(ip, username string) string { return "fail:uip:" + username + "|" + ip }

// guard refuses a caller that has failed too often: per address, per user name from that address, and per user
// name overall.
func (a *Accounts) guard(ip, username string) *apierr.Error {
	wait := max(
		a.Limiter.Blocked("fail:ip:"+ip, failureIPMax),
		a.Limiter.Blocked(failureKey(ip, username), failureLimit),
		a.Limiter.Blocked("fail:u:"+username, failureUserMax))
	if wait > 0 {
		return apierr.RateLimited(wait)
	}
	return nil
}

func (a *Accounts) failed(ip, username string) {
	a.Limiter.Hit("fail:ip:"+ip, failureIPMax, failureSpan)
	a.Limiter.Hit(failureKey(ip, username), failureLimit, failureSpan)
	a.Limiter.Hit("fail:u:"+username, failureUserMax, failureSpan)
}

type userRow struct {
	User
	pass, recovery string
	deleteAfter    sql.NullInt64
}

func (a *Accounts) userByName(ctx context.Context, username string) (*userRow, error) {
	var u userRow
	err := a.DB.QueryRowContext(ctx, "SELECT id, username, pass, recovery, delete_after FROM users WHERE username = ?", username).
		Scan(&u.ID, &u.Username, &u.pass, &u.recovery, &u.deleteAfter)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &u, err
}

func (a *Accounts) userByID(ctx context.Context, id string) (*userRow, error) {
	var u userRow
	err := a.DB.QueryRowContext(ctx, "SELECT id, username, pass, recovery, delete_after FROM users WHERE id = ?", id).
		Scan(&u.ID, &u.Username, &u.pass, &u.recovery, &u.deleteAfter)
	return &u, err
}

// Login signs a device in. restored is true when it brought back an account that was waiting to be deleted.
func (a *Accounts) Login(ctx context.Context, ip string, in Credentials) (s Session, restored bool, err error) {
	if ok, retry := a.Limiter.Hit("login:"+ip, 90, time.Minute); !ok {
		return s, false, apierr.RateLimited(retry)
	}
	username := normalizeUsername(in.Username)
	if aerr := a.guard(ip, username); aerr != nil {
		return s, false, aerr
	}
	user, err := a.userByName(ctx, username)
	if err != nil {
		return s, false, err
	}
	if !a.check(clip(in.Password, 200), userPass(user), user != nil) {
		a.failed(ip, username)
		return s, false, apierr.New(401, "bad_credentials")
	}
	a.Limiter.Clear(failureKey(ip, username))
	restored = user.deleteAfter.Valid
	err = a.DB.Write(ctx, func(tx *sql.Tx) error {
		if restored {
			if _, err := tx.ExecContext(ctx, "UPDATE users SET delete_after = NULL WHERE id = ?", user.ID); err != nil {
				return err
			}
		}
		s, err = a.issueDevice(ctx, tx, user.User, deviceName(in.DeviceName))
		return err
	})
	return s, restored, err
}

func userPass(u *userRow) string {
	if u == nil {
		return ""
	}
	return u.pass
}

// Recover sets a new password with the recovery key, signs every other device out and returns a new recovery key.
func (a *Accounts) Recover(ctx context.Context, ip string, in Credentials) (Session, string, error) {
	username := normalizeUsername(in.Username)
	if aerr := a.guard(ip, username); aerr != nil {
		return Session{}, "", aerr
	}
	next := clip(in.NewPassword, 200)
	if utf8.RuneCountInString(next) < 8 {
		return Session{}, "", apierr.New(400, "weak_password")
	}
	if err := a.takePow(ctx, in); err != nil {
		return Session{}, "", err
	}
	user, err := a.userByName(ctx, username)
	if err != nil {
		return Session{}, "", err
	}
	if user == nil || !SafeEqual(user.recovery, RecoveryHash(in.RecoveryKey)) {
		a.failed(ip, username)
		return Session{}, "", apierr.New(401, "bad_recovery_key")
	}
	pass, err := a.hash(next)
	if err != nil {
		return Session{}, "", err
	}
	recovery := NewRecoveryKey()
	var session Session
	err = a.DB.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "UPDATE users SET pass = ?, recovery = ?, delete_after = NULL WHERE id = ?", pass, RecoveryHash(recovery), user.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", a.ms(), user.ID); err != nil {
			return err
		}
		session, err = a.issueDevice(ctx, tx, user.User, deviceName(in.DeviceName))
		return err
	})
	if err == nil {
		// the old password's failures are moot, whoever made them
		a.Limiter.Clear(failureKey(ip, username))
		a.Limiter.Clear("fail:u:" + username)
	}
	return session, recovery, err
}

// ───── devices and the caller ─────

const deviceLimitPerMinute = 1500

// Authenticate finds the device a token belongs to. A revoked device is out at once.
func (a *Accounts) Authenticate(ctx context.Context, token string) (*Principal, error) {
	var p Principal
	var lastSeen int64
	err := a.DB.QueryRowContext(ctx,
		`SELECT d.id, d.name, d.last_seen, u.id, u.username
		   FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ? AND d.revoked_at IS NULL`, SHA256Hex(token)).
		Scan(&p.Device.ID, &p.Device.Name, &lastSeen, &p.User.ID, &p.User.Username)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apierr.New(401, "unauthorized")
	}
	if err != nil {
		return nil, err
	}
	if now := a.ms(); now-lastSeen > 60_000 { // a minute of precision is enough, and spares a write per request
		if _, err := a.DB.ExecContext(ctx, "UPDATE devices SET last_seen = ? WHERE id = ?", now, p.Device.ID); err != nil {
			return nil, err
		}
	}
	if ok, retry := a.Limiter.Hit("t:"+p.Device.ID, deviceLimitPerMinute, time.Minute); !ok {
		return nil, apierr.RateLimited(retry)
	}
	return &p, nil
}

// DeviceInfo is a device as the account page lists it.
type DeviceInfo struct {
	Device
	CreatedAt int64 `json:"created_at"`
	LastSeen  int64 `json:"last_seen"`
	Current   bool  `json:"current"`
}

// Info is the account page: when the user was created and the active devices.
func (a *Accounts) Info(ctx context.Context, p *Principal) (createdAt int64, devices []DeviceInfo, err error) {
	if err = a.DB.QueryRowContext(ctx, "SELECT created_at FROM users WHERE id = ?", p.User.ID).Scan(&createdAt); err != nil {
		return
	}
	rows, err := a.DB.QueryContext(ctx, "SELECT id, name, created_at, last_seen FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at", p.User.ID)
	if err != nil {
		return
	}
	defer rows.Close()
	devices = []DeviceInfo{}
	for rows.Next() {
		var d DeviceInfo
		if err = rows.Scan(&d.ID, &d.Name, &d.CreatedAt, &d.LastSeen); err != nil {
			return
		}
		d.Current = d.ID == p.Device.ID
		devices = append(devices, d)
	}
	err = rows.Err()
	return
}

// Logout revokes the calling device.
func (a *Accounts) Logout(ctx context.Context, p *Principal) error {
	_, err := a.DB.ExecContext(ctx, "UPDATE devices SET revoked_at = ? WHERE id = ?", a.ms(), p.Device.ID)
	return err
}

// RevokeDevice signs one of the user's devices out.
func (a *Accounts) RevokeDevice(ctx context.Context, p *Principal, id string) error {
	r, err := a.DB.ExecContext(ctx, "UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL", a.ms(), id, p.User.ID)
	if err != nil {
		return err
	}
	if n, _ := r.RowsAffected(); n == 0 {
		return apierr.New(404, "no_such_device")
	}
	return nil
}

// confirm checks the password of the caller, counting failures like a sign-in does.
func (a *Accounts) confirm(ctx context.Context, ip string, p *Principal, password string) (*userRow, error) {
	user, err := a.userByID(ctx, p.User.ID)
	if err != nil {
		return nil, err
	}
	if aerr := a.guard(ip, user.Username); aerr != nil {
		return nil, aerr
	}
	if !VerifyPassword(clip(password, 200), user.pass) {
		a.failed(ip, user.Username)
		return nil, apierr.New(401, "bad_credentials")
	}
	return user, nil
}

// ChangePassword signs every other device out.
func (a *Accounts) ChangePassword(ctx context.Context, ip string, p *Principal, oldPassword, newPassword string) error {
	next := clip(newPassword, 200)
	if utf8.RuneCountInString(next) < 8 {
		return apierr.New(400, "weak_password")
	}
	user, err := a.confirm(ctx, ip, p, oldPassword)
	if err != nil {
		return err
	}
	pass, err := a.hash(next)
	if err != nil {
		return err
	}
	return a.DB.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "UPDATE users SET pass = ? WHERE id = ?", pass, user.ID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "UPDATE devices SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL", a.ms(), user.ID, p.Device.ID)
		return err
	})
}

// NewRecoveryKey replaces the recovery key and returns the new one.
func (a *Accounts) NewRecoveryKey(ctx context.Context, ip string, p *Principal, password string) (string, error) {
	user, err := a.confirm(ctx, ip, p, password)
	if err != nil {
		return "", err
	}
	key := NewRecoveryKey()
	_, err = a.DB.ExecContext(ctx, "UPDATE users SET recovery = ? WHERE id = ?", RecoveryHash(key), user.ID)
	return key, err
}

// Delete schedules the account for removal after the retention period and signs every device out; signing in
// again during that time brings it back.
func (a *Accounts) Delete(ctx context.Context, ip string, p *Principal, password string) (deleteAfter int64, err error) {
	user, err := a.confirm(ctx, ip, p, password)
	if err != nil {
		return 0, err
	}
	deleteAfter = a.Now().Add(time.Duration(a.Cfg.RetentionDays) * 24 * time.Hour).UnixMilli()
	err = a.DB.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "UPDATE users SET delete_after = ? WHERE id = ?", deleteAfter, user.ID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", a.ms(), user.ID)
		return err
	})
	return deleteAfter, err
}
