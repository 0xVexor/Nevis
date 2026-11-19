// Package config reads every setting from environment variables. Secrets are only ever read from here,
// never from code or the repository.
package config

import (
	"fmt"
	"math"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

const mb = 1024 * 1024

// Protocol versions: a client that sends a lower X-Nevis-Api than MinAPI is told to upgrade.
const (
	API    = 1
	MinAPI = 1
)

// Config is the whole configuration of a server.
type Config struct {
	Host    string
	Port    int
	DataDir string

	// Secret signs the sign-up challenges.
	Secret string
	// Lock enables the single-instance lock file.
	Lock bool
	// Registration is open, invite or closed.
	Registration string
	// InviteCodes maps a code to how many accounts it may create.
	InviteCodes map[string]int

	MaxBlobBytes    int64
	QuotaBytes      int64
	MaxVaults       int
	RetentionDays   int
	PowBits         int
	RegisterPerHour int

	BackupDelay time.Duration
	BackupKeep  int

	// TrustProxy lists the peers whose X-Forwarded-For header is believed.
	TrustProxy []netip.Prefix
}

// Load reads the settings and returns them together with the problems that make a server unsafe to start.
func Load(getenv func(string) string) (Config, []string) {
	c := Config{
		Host:            str(getenv("LISTEN_HOST"), "0.0.0.0"),
		Port:            integer(getenv("PORT"), 3000),
		DataDir:         str(getenv("DATA_DIR"), "./data"),
		Secret:          getenv("SESSION_SECRET"),
		Lock:            getenv("INSTANCE_LOCK") != "off",
		Registration:    str(getenv("REGISTRATION"), "invite"),
		InviteCodes:     parseInvites(getenv("INVITE_CODES")),
		MaxBlobBytes:    int64(integer(getenv("MAX_BLOB_MB"), 64)) * mb,
		QuotaBytes:      int64(integer(getenv("QUOTA_MB"), 1024)) * mb,
		MaxVaults:       integer(getenv("MAX_VAULTS"), 20),
		RetentionDays:   integer(getenv("RETENTION_DAYS"), 30),
		PowBits:         integer(getenv("POW_BITS"), 18),
		RegisterPerHour: integer(getenv("REGISTER_PER_HOUR"), 30),
		BackupDelay:     time.Duration(integer(getenv("BACKUP_DELAY_SEC"), 20)) * time.Second,
		BackupKeep:      integer(getenv("BACKUP_KEEP"), 24),
	}
	proxies, err := ParseTrustProxy(getenv("TRUST_PROXY"))
	c.TrustProxy = proxies
	return c, c.problems(err)
}

func (c Config) problems(proxyErr error) []string {
	var bad []string
	if len(c.Secret) < 32 {
		bad = append(bad, "SESSION_SECRET must be set to a random string of at least 32 characters")
	}
	if c.Registration != "open" && c.Registration != "invite" && c.Registration != "closed" {
		bad = append(bad, "REGISTRATION must be open, invite or closed")
	}
	if c.Registration == "invite" && len(c.InviteCodes) == 0 {
		bad = append(bad, "REGISTRATION=invite needs INVITE_CODES (comma separated)")
	}
	if proxyErr != nil {
		bad = append(bad, proxyErr.Error())
	}
	return bad
}

// ParseTrustProxy reads a comma separated list of addresses and networks; the word "loopback" stands for
// the local machine (a reverse proxy on the same host). An empty value trusts nobody.
func ParseTrustProxy(raw string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		switch {
		case part == "":
		case part == "loopback":
			out = append(out, netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128"))
		case strings.Contains(part, "/"):
			p, err := netip.ParsePrefix(part)
			if err != nil {
				return nil, fmt.Errorf("TRUST_PROXY: %q is not an address, a network or \"loopback\"", part)
			}
			out = append(out, p.Masked())
		default:
			a, err := netip.ParseAddr(part)
			if err != nil {
				return nil, fmt.Errorf("TRUST_PROXY: %q is not an address, a network or \"loopback\"", part)
			}
			out = append(out, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
		}
	}
	return out, nil
}

// parseInvites reads "code1,code2:5": a code, optionally limited to that many accounts.
func parseInvites(raw string) map[string]int {
	out := map[string]int{}
	for _, part := range strings.Split(raw, ",") {
		code, limit, limited := strings.Cut(strings.TrimSpace(part), ":")
		if code == "" {
			continue
		}
		out[code] = math.MaxInt
		if limited {
			out[code] = integer(limit, 1)
		}
	}
	return out
}

func integer(v string, fallback int) int {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 0 {
		return fallback
	}
	return n
}

func str(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
