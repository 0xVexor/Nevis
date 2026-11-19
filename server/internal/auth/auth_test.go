package auth

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

var cheap = Cost{N: 16, R: 1, P: 1} // fast enough for tests; the cost is part of the stored hash

func TestPasswordRoundTrip(t *testing.T) {
	stored, err := HashPassword("correct horse battery", cheap)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(stored, "scrypt$16$1$1$") {
		t.Fatalf("format: %s", stored)
	}
	if !VerifyPassword("correct horse battery", stored) {
		t.Fatal("the right password was refused")
	}
	if VerifyPassword("correct horse batterz", stored) {
		t.Fatal("a wrong password was accepted")
	}
	other, _ := HashPassword("correct horse battery", cheap)
	if other == stored {
		t.Fatal("two hashes of one password must differ (salt)")
	}
}

func TestPasswordsAreNormalizedBeforeComparing(t *testing.T) {
	stored, _ := HashPassword("fish1234", cheap)
	if !VerifyPassword("ﬁsh1234", stored) { // the "fi" ligature folds to "fi" under NFKC
		t.Fatal("compatibility-equivalent passwords must match")
	}
}

func TestUnparsableStoredHashIsJustNo(t *testing.T) {
	for _, stored := range []string{"", "x", "bcrypt$a$b$c$d$e", "scrypt$x$1$1$AAAA$AAAA", "scrypt$16$1$1$%%%$AAAA", "scrypt$0$1$1$AAAA$AAAA"} {
		if VerifyPassword("anything", stored) {
			t.Errorf("%q accepted", stored)
		}
	}
}

func TestRecoveryKey(t *testing.T) {
	re := regexp.MustCompile(`^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$`)
	seen := map[string]bool{}
	for range 50 {
		k := NewRecoveryKey()
		if !re.MatchString(k) {
			t.Fatalf("bad key %q", k)
		}
		seen[k] = true
	}
	if len(seen) != 50 {
		t.Fatal("recovery keys repeat")
	}
	k := "ABCDE-FGHJK-LMNPQ-RSTUV"
	for _, typed := range []string{k, strings.ToLower(k), strings.ReplaceAll(k, "-", " "), strings.ReplaceAll(k, "-", "")} {
		if RecoveryHash(typed) != RecoveryHash(k) {
			t.Errorf("%q does not match", typed)
		}
	}
	if RecoveryHash(k) == RecoveryHash("ABCDE-FGHJK-LMNPQ-RSTUW") {
		t.Fatal("different keys hash alike")
	}
}

func TestTokensAndIDs(t *testing.T) {
	if tok := NewToken(); !regexp.MustCompile(`^nvs_[A-Za-z0-9_-]{43}$`).MatchString(tok) {
		t.Fatalf("token %q", tok)
	}
	if id := NewID(); !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(id) {
		t.Fatalf("id %q", id)
	}
}

func TestLeadingZeroBits(t *testing.T) {
	for _, c := range []struct {
		in   []byte
		want int
	}{{[]byte{0xff}, 0}, {[]byte{0x0f}, 4}, {[]byte{0x00, 0x01}, 15}, {[]byte{0, 0, 0}, 24}, {nil, 0}} {
		if got := LeadingZeroBits(c.in); got != c.want {
			t.Errorf("%v: %d, want %d", c.in, got, c.want)
		}
	}
}

func TestProofOfWork(t *testing.T) {
	const secret, bits = "s3cret-s3cret-s3cret-s3cret-s3cret", 8
	now := time.UnixMilli(1_700_000_000_000)
	ch := MakeChallenge(secret, now)
	counter := strconv.FormatUint(SolvePow(ch, bits), 10)

	nonce, err := CheckPow(secret, ch, counter, bits, now.Add(time.Second))
	if err != nil || nonce == "" {
		t.Fatalf("a solved challenge was refused: %v", err)
	}
	for name, c := range map[string]struct {
		challenge, counter, secret string
		at                         time.Time
		want                       string
	}{
		"wrong counter":      {ch, "not-the-answer", secret, now, "bad_pow"},
		"too late":           {ch, counter, secret, now.Add(11 * time.Minute), "challenge_expired"},
		"from the future":    {ch, counter, secret, now.Add(-time.Minute), "challenge_expired"},
		"tampered signature": {tampered(ch), counter, secret, now, "bad_challenge"},
		"another secret":     {ch, counter, "another-secret-another-secret-12345", now, "bad_challenge"},
		"not a challenge":    {"nonsense", counter, secret, now, "bad_challenge"},
	} {
		if _, err := CheckPow(c.secret, c.challenge, c.counter, bits, c.at); err == nil || err.Code != c.want || err.Status != 400 {
			t.Errorf("%s: got %v, want %s", name, err, c.want)
		}
	}
	if nonce, err := CheckPow(secret, "", "", 0, now); err != nil || nonce != "" {
		t.Fatalf("difficulty 0 asks for nothing: %q %v", nonce, err)
	}
}

// tampered changes the last character of the signature.
func tampered(challenge string) string {
	last := challenge[len(challenge)-1]
	if last == 'A' {
		return challenge[:len(challenge)-1] + "B"
	}
	return challenge[:len(challenge)-1] + "A"
}

func TestLimiter(t *testing.T) {
	now := time.UnixMilli(0)
	l := NewLimiter(func() time.Time { return now })
	for i := 1; i <= 3; i++ {
		if ok, _ := l.Hit("k", 3, time.Minute); !ok {
			t.Fatalf("hit %d refused", i)
		}
	}
	ok, retry := l.Hit("k", 3, time.Minute)
	if ok || retry != 60 {
		t.Fatalf("the fourth hit: ok=%v retry=%d", ok, retry)
	}
	if l.Blocked("k", 3) != 60 || l.Blocked("other", 3) != 0 {
		t.Fatal("blocked")
	}
	now = now.Add(61 * time.Second)
	if ok, _ := l.Hit("k", 3, time.Minute); !ok {
		t.Fatal("the window did not reset")
	}
	l.Clear("k")
	if l.Blocked("k", 1) != 0 {
		t.Fatal("clear")
	}
	l.Hit("old", 1, time.Second)
	now = now.Add(time.Hour)
	l.Sweep()
	if len(l.m) != 0 {
		t.Fatalf("sweep left %d windows", len(l.m))
	}
}
