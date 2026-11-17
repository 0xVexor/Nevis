package config

import (
	"math"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func env(kv map[string]string) func(string) string { return func(k string) string { return kv[k] } }

func TestDefaultsMatchTheDocumentedOnes(t *testing.T) {
	c, problems := Load(env(map[string]string{"SESSION_SECRET": strings.Repeat("k", 32), "INVITE_CODES": "x"}))
	if len(problems) != 0 {
		t.Fatalf("problems: %v", problems)
	}
	if c.Port != 3000 || c.DataDir != "./data" || c.Registration != "invite" || c.MaxVaults != 20 || c.RetentionDays != 30 ||
		c.PowBits != 18 || c.RegisterPerHour != 30 || c.QuotaBytes != 1024<<20 || c.MaxBlobBytes != 64<<20 ||
		c.BackupDelay != 20*time.Second || c.BackupKeep != 24 || !c.Lock || c.Host != "0.0.0.0" || len(c.TrustProxy) != 0 {
		t.Fatalf("unexpected defaults: %+v", c)
	}
}

func TestSettingsAreRead(t *testing.T) {
	c, _ := Load(env(map[string]string{
		"PORT": "4000", "DATA_DIR": "/srv/nevis", "QUOTA_MB": "5", "MAX_BLOB_MB": "2", "MAX_VAULTS": "3", "RETENTION_DAYS": "7",
		"REGISTER_PER_HOUR": "9", "POW_BITS": "0", "BACKUP_DELAY_SEC": "1", "INSTANCE_LOCK": "off", "REGISTRATION": "open",
	}))
	if c.Port != 4000 || c.DataDir != "/srv/nevis" || c.QuotaBytes != 5<<20 || c.MaxBlobBytes != 2<<20 || c.MaxVaults != 3 ||
		c.RetentionDays != 7 || c.RegisterPerHour != 9 || c.PowBits != 0 || c.BackupDelay != time.Second || c.Lock || c.Registration != "open" {
		t.Fatalf("unexpected: %+v", c)
	}
}

func TestBadNumbersFallBackToDefaults(t *testing.T) {
	c, _ := Load(env(map[string]string{"PORT": "abc", "QUOTA_MB": "-4"}))
	if c.Port != 3000 || c.QuotaBytes != 1024<<20 {
		t.Fatalf("unexpected: %+v", c)
	}
}

func TestInviteCodes(t *testing.T) {
	got := parseInvites("code1, code2:5 ,,code3:x")
	if got["code1"] != math.MaxInt || got["code2"] != 5 || got["code3"] != 1 || len(got) != 3 {
		t.Fatalf("got %v", got)
	}
}

func TestProblemsMakeAServerUnsafeToStart(t *testing.T) {
	_, problems := Load(env(map[string]string{"SESSION_SECRET": "short"}))
	joined := strings.Join(problems, "\n")
	for _, want := range []string{"SESSION_SECRET", "INVITE_CODES"} {
		if !strings.Contains(joined, want) {
			t.Errorf("no problem mentions %s: %v", want, problems)
		}
	}
	_, problems = Load(env(map[string]string{"SESSION_SECRET": strings.Repeat("k", 32), "REGISTRATION": "whenever"}))
	if len(problems) != 1 || !strings.Contains(problems[0], "REGISTRATION") {
		t.Fatalf("got %v", problems)
	}
}

func TestTrustProxy(t *testing.T) {
	got, err := ParseTrustProxy("loopback, 10.0.0.0/8, 192.168.1.7, 2001:db8::/32")
	if err != nil {
		t.Fatal(err)
	}
	for _, in := range []string{"127.0.0.1", "::1", "10.20.30.40", "192.168.1.7", "2001:db8::5"} {
		if !contains(got, netip.MustParseAddr(in)) {
			t.Errorf("%s should be trusted", in)
		}
	}
	for _, in := range []string{"192.168.1.8", "8.8.8.8", "2001:db9::1"} {
		if contains(got, netip.MustParseAddr(in)) {
			t.Errorf("%s should not be trusted", in)
		}
	}
	if none, err := ParseTrustProxy(""); err != nil || len(none) != 0 {
		t.Fatalf("an empty value trusts nobody: %v %v", none, err)
	}
	if _, err := ParseTrustProxy("not-an-address"); err == nil {
		t.Fatal("garbage accepted")
	}
	if _, problems := Load(env(map[string]string{"TRUST_PROXY": "10.0.0.0/99"})); !strings.Contains(strings.Join(problems, " "), "TRUST_PROXY") {
		t.Fatalf("a bad TRUST_PROXY is not reported: %v", problems)
	}
}

func contains(ps []netip.Prefix, a netip.Addr) bool {
	for _, p := range ps {
		if p.Contains(a) {
			return true
		}
	}
	return false
}
