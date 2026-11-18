package vaults

import (
	"context"
	"strings"
	"time"

	"github.com/0xVexor/Nevis/server/internal/apierr"
)

// maxPendingUploads is how many half-finished uploads one account may have in flight. Without it a client could
// open as many uploads as the quota has room for, each holding staging space.
const maxPendingUploads = 8

// pendingUpload is the room set aside for an upload that is not complete yet.
type pendingUpload struct {
	total int64
	at    time.Time // last piece, so that an abandoned upload stops counting when staging is swept
}

// reserve sets aside the declared size of an upload for the account, next to what the account already stores
// and what its other pending uploads announced. The check and the booking are one step, so two uploads that
// each fit but not together cannot both pass. known is true when the upload already held a reservation (a later
// piece, or a retried one); its size is then replaced by the one declared now.
func (s *Store) reserve(ctx context.Context, userID, key string, total int64) (known bool, err error) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	mine := s.pending[userID]
	_, known = mine[key]
	var reserved int64
	others := 0
	for k, p := range mine {
		if k != key {
			reserved += p.total
			others++
		}
	}
	// read under the lock: a finishing upload records its blob before it releases, so it is never missed
	used, err := s.UsedBytes(ctx, userID)
	if err != nil {
		return known, err
	}
	if used+reserved+total > s.Cfg.QuotaBytes || others >= maxPendingUploads {
		return known, apierr.With(507, "quota_exceeded", map[string]any{"limit": s.Cfg.QuotaBytes})
	}
	if s.pending == nil {
		s.pending = map[string]map[string]pendingUpload{}
	}
	if mine == nil {
		mine = map[string]pendingUpload{}
		s.pending[userID] = mine
	}
	mine[key] = pendingUpload{total: total, at: s.Now()}
	return known, nil
}

// release gives a reservation back: the upload completed, failed or was thrown away.
func (s *Store) release(userID, key string) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	delete(s.pending[userID], key)
	if len(s.pending[userID]) == 0 {
		delete(s.pending, userID)
	}
}

// releaseVault gives back the reservations of the uploads into a vault that is gone.
func (s *Store) releaseVault(userID, vaultID string) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	for k := range s.pending[userID] {
		if strings.HasPrefix(k, vaultID+"/") {
			delete(s.pending[userID], k)
		}
	}
	if len(s.pending[userID]) == 0 {
		delete(s.pending, userID)
	}
}

// dropStalePending forgets reservations of uploads nobody continued for maxAge, the age at which their staging
// files are swept.
func (s *Store) dropStalePending(now time.Time, maxAge time.Duration) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	for u, mine := range s.pending {
		for k, p := range mine {
			if now.Sub(p.at) > maxAge {
				delete(mine, k)
			}
		}
		if len(mine) == 0 {
			delete(s.pending, u)
		}
	}
}
