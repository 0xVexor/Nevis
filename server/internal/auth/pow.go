package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"math/bits"
	"strconv"
	"strings"
	"time"

	"github.com/0xVexor/Nevis/server/internal/apierr"
)

// Proof of work (registration and recovery): costs a bot time, costs a person a second. The server hands out a
// signed challenge; the client finds a counter so that SHA-256("<challenge>:<counter>") starts with enough zero
// bits. The challenge is a plain string to the client.

const challengeLifetime = 10 * time.Minute

func sign(secret, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// MakeChallenge is `<time in base 36>.<random>.<signature>`.
func MakeChallenge(secret string, now time.Time) string {
	nonce := make([]byte, 12)
	_, _ = rand.Read(nonce)
	body := strconv.FormatInt(now.UnixMilli(), 36) + "." + hex.EncodeToString(nonce)
	return body + "." + sign(secret, body)
}

// LeadingZeroBits counts the zero bits a digest starts with.
func LeadingZeroBits(digest []byte) int {
	n := 0
	for _, b := range digest {
		if b != 0 {
			return n + bits.LeadingZeros8(b)
		}
		n += 8
	}
	return n
}

func meetsDifficulty(challenge, counter string, difficulty int) bool {
	sum := sha256.Sum256([]byte(challenge + ":" + counter))
	return LeadingZeroBits(sum[:]) >= difficulty
}

// CheckPow verifies a solved challenge and returns its nonce; the caller records the nonce so that it cannot be
// used twice. With difficulty 0 there is nothing to check and the nonce is empty.
func CheckPow(secret, challenge, counter string, difficulty int, now time.Time) (string, *apierr.Error) {
	if difficulty <= 0 {
		return "", nil
	}
	parts := strings.Split(challenge, ".")
	if len(parts) != 3 {
		return "", apierr.New(400, "bad_challenge")
	}
	ts, nonce, sig := parts[0], parts[1], parts[2]
	if !SafeEqual(sig, sign(secret, ts+"."+nonce)) {
		return "", apierr.New(400, "bad_challenge")
	}
	made, err := strconv.ParseInt(ts, 36, 64)
	if age := now.UnixMilli() - made; err != nil || age < 0 || age >= challengeLifetime.Milliseconds() {
		return "", apierr.New(400, "challenge_expired")
	}
	if !meetsDifficulty(challenge, counter, difficulty) {
		return "", apierr.New(400, "bad_pow")
	}
	return nonce, nil
}

// SolvePow is the work a client does; used by the tests, by the smoke check and by anyone scripting a registration.
func SolvePow(challenge string, difficulty int) uint64 {
	for counter := uint64(0); ; counter++ {
		if meetsDifficulty(challenge, strconv.FormatUint(counter, 10), difficulty) {
			return counter
		}
	}
}
