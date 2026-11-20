package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

var (
	ErrUsernameTaken = errors.New("username_taken")
	ErrPowUsed       = errors.New("pow_used")
	ErrNotFound      = errors.New("not_found")
)

type Account struct {
	ID, Username, PassHash, RecoveryHash string
	CreatedAt, UsedBytes                 int64
}

type Device struct {
	ID, Account, Name, Kind string
	CreatedAt               int64
	LastSeen, RevokedAt     *int64
}

// Principal is who a request is.
type Principal struct {
	AccountID string
	Username  string
	DeviceID  string
	// Dev is the development token: no account, may create workspaces by pushing.
	Dev bool
}

const SessionTTL = 90 * 24 * time.Hour

func (s *Store) ms() int64 { return s.now().UnixMilli() }

// CreateAccount stores a new account with its first device and session in one transaction.
func (s *Store) CreateAccount(ctx context.Context, a Account, d Device, tokenHash string) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	a.CreatedAt = s.ms()
	if _, err := tx.ExecContext(ctx, `INSERT INTO account (id, username, pass_hash, recovery_hash, created_at) VALUES (?,?,?,?,?)`, a.ID, a.Username, a.PassHash, a.RecoveryHash, a.CreatedAt); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return ErrUsernameTaken
		}
		return err
	}
	if err := s.addSession(ctx, tx, d, tokenHash); err != nil {
		return err
	}
	return tx.Commit()
}

type execer interface {
	ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error)
}

func (s *Store) addSession(ctx context.Context, tx execer, d Device, tokenHash string) error {
	now := s.ms()
	if _, err := tx.ExecContext(ctx, `INSERT INTO device (id, account, name, kind, created_at, last_seen) VALUES (?,?,?,?,?,?)`, d.ID, d.Account, d.Name, d.Kind, now, now); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO session (token_hash, account, device, created_at, expires_at) VALUES (?,?,?,?,?)`, tokenHash, d.Account, d.ID, now, now+SessionTTL.Milliseconds())
	return err
}

// NewSession registers a device and its session (a sign-in).
func (s *Store) NewSession(ctx context.Context, d Device, tokenHash string) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.addSession(ctx, tx, d, tokenHash); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) AccountByName(ctx context.Context, username string) (*Account, error) {
	var a Account
	err := s.r.QueryRowContext(ctx, `SELECT id, username, pass_hash, recovery_hash, created_at, used_bytes FROM account WHERE username = ?`, username).
		Scan(&a.ID, &a.Username, &a.PassHash, &a.RecoveryHash, &a.CreatedAt, &a.UsedBytes)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &a, err
}

func (s *Store) AccountByID(ctx context.Context, id string) (*Account, error) {
	var a Account
	err := s.r.QueryRowContext(ctx, `SELECT id, username, pass_hash, recovery_hash, created_at, used_bytes FROM account WHERE id = ?`, id).
		Scan(&a.ID, &a.Username, &a.PassHash, &a.RecoveryHash, &a.CreatedAt, &a.UsedBytes)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &a, err
}

// Authenticate finds the principal of a session token hash. A revoked device or an expired session is not found. The expiry
// slides, but is written at most once an hour.
func (s *Store) Authenticate(ctx context.Context, tokenHash string) (*Principal, error) {
	var p Principal
	var expires int64
	err := s.r.QueryRowContext(ctx, `SELECT a.id, a.username, d.id, s.expires_at FROM session s
		JOIN device d ON d.id = s.device JOIN account a ON a.id = s.account
		WHERE s.token_hash = ? AND d.revoked_at IS NULL`, tokenHash).Scan(&p.AccountID, &p.Username, &p.DeviceID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	now := s.ms()
	if expires <= now {
		return nil, ErrNotFound
	}
	if expires-now < SessionTTL.Milliseconds()-time.Hour.Milliseconds() {
		_, _ = s.w.ExecContext(ctx, `UPDATE session SET expires_at = ? WHERE token_hash = ?`, now+SessionTTL.Milliseconds(), tokenHash)
		_, _ = s.w.ExecContext(ctx, `UPDATE device SET last_seen = ? WHERE id = ?`, now, p.DeviceID)
	}
	return &p, nil
}

// EndSession signs out one session: its token stops working and its device is marked revoked.
func (s *Store) EndSession(ctx context.Context, tokenHash string) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var dev string
	if err := tx.QueryRowContext(ctx, `SELECT device FROM session WHERE token_hash = ?`, tokenHash).Scan(&dev); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM session WHERE device = ?`, dev); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE device SET revoked_at = ? WHERE id = ?`, s.ms(), dev); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Devices(ctx context.Context, account string) ([]Device, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT id, account, name, kind, created_at, last_seen, revoked_at FROM device WHERE account = ? AND revoked_at IS NULL ORDER BY created_at`, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		var d Device
		var ls, rv sql.NullInt64
		if err := rows.Scan(&d.ID, &d.Account, &d.Name, &d.Kind, &d.CreatedAt, &ls, &rv); err != nil {
			return nil, err
		}
		if ls.Valid {
			d.LastSeen = &ls.Int64
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// RevokeDevice signs a device out for good. It reports whether the account had such a device.
func (s *Store) RevokeDevice(ctx context.Context, account, device string) (bool, error) {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE device SET revoked_at = ? WHERE id = ? AND account = ? AND revoked_at IS NULL`, s.ms(), device, account)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM session WHERE device = ?`, device); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// ResetCredentials sets a new password and recovery key and signs every device out (a password recovery).
func (s *Store) ResetCredentials(ctx context.Context, account, passHash, recoveryHash string) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE account SET pass_hash = ?, recovery_hash = ? WHERE id = ?`, passHash, recoveryHash, account); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM session WHERE account = ?`, account); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE device SET revoked_at = ? WHERE account = ? AND revoked_at IS NULL`, s.ms(), account); err != nil {
		return err
	}
	return tx.Commit()
}

// UsePow records a proof-of-work nonce; a nonce can be used once.
func (s *Store) UsePow(ctx context.Context, nonce string) error {
	_, _ = s.w.ExecContext(ctx, `DELETE FROM pow_used WHERE at < ?`, s.ms()-int64((20*time.Minute)/time.Millisecond))
	if _, err := s.w.ExecContext(ctx, `INSERT INTO pow_used (nonce, at) VALUES (?, ?)`, nonce, s.ms()); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return ErrPowUsed
		}
		return err
	}
	return nil
}

// ---- workspaces and members ----

type WorkspaceInfo struct {
	ID, Name, Role string
	Head           int64
	MinSV          int
	CreatedAt      int64
}

const MaxWorkspacesPerAccount = 20

var ErrTooManyWorkspaces = errors.New("too_many_workspaces")
var ErrWorkspaceExists = errors.New("workspace_exists")

func (s *Store) CreateWorkspace(ctx context.Context, account, id, name string) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM member WHERE account = ? AND role = 'owner'`, account).Scan(&n); err != nil {
		return err
	}
	if n >= MaxWorkspacesPerAccount {
		return ErrTooManyWorkspaces
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workspace (id, name, head, created_at) VALUES (?, ?, 0, ?)`, id, name, s.ms()); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return ErrWorkspaceExists
		}
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO member (ws, account, role) VALUES (?, ?, 'owner')`, id, account); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Workspaces(ctx context.Context, account string) ([]WorkspaceInfo, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT w.id, w.name, m.role, w.head, w.min_sv, w.created_at FROM member m JOIN workspace w ON w.id = m.ws WHERE m.account = ? ORDER BY w.created_at`, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WorkspaceInfo
	for rows.Next() {
		var w WorkspaceInfo
		if err := rows.Scan(&w.ID, &w.Name, &w.Role, &w.Head, &w.MinSV, &w.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// Role is the account's role in a workspace ("" when it is not a member).
func (s *Store) Role(ctx context.Context, account, ws string) (string, error) {
	var role string
	err := s.r.QueryRowContext(ctx, `SELECT role FROM member WHERE ws = ? AND account = ?`, ws, account).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return role, err
}

// RaiseMinSV only ever raises the schema version a workspace's writers must have.
func (s *Store) RaiseMinSV(ctx context.Context, ws string, sv int) error {
	_, err := s.w.ExecContext(ctx, `UPDATE workspace SET min_sv = MAX(min_sv, ?) WHERE id = ?`, sv, ws)
	return err
}

// AddMember gives an account a role in a workspace (sharing comes later; tests and the owner's tools use it).
func (s *Store) AddMember(ctx context.Context, ws, account, role string) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO member (ws, account, role) VALUES (?, ?, ?) ON CONFLICT(ws, account) DO UPDATE SET role = excluded.role`, ws, account, role)
	return err
}
