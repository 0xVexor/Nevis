package vaults

import (
	"testing"
	"time"

	"github.com/0xVexor/Nevis/server/internal/config"
)

func TestReleaseVaultGivesBackOnlyThatVaultsReservations(t *testing.T) {
	s := &Store{Cfg: config.Config{QuotaBytes: 1 << 30}, Now: time.Now}
	s.pending = map[string]map[string]pendingUpload{
		"u": {"v1/aaa": {total: 5}, "v1/bbb": {total: 5}, "v2/aaa": {total: 5}},
		"x": {"v1/aaa": {total: 5}},
	}
	s.releaseVault("u", "v1")
	if len(s.pending["u"]) != 1 || len(s.pending["x"]) != 1 {
		t.Fatalf("%v", s.pending)
	}
	s.releaseVault("u", "v2")
	if _, there := s.pending["u"]; there {
		t.Fatal("empty map kept")
	}
}
