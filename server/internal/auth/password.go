// Package auth holds passwords, device tokens, recovery keys, the sign-up proof of work, a small rate limiter and
// the account operations built on them. Nothing here needs an e-mail address or a phone number: an account is a
// user name, a password and a recovery key.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"math/big"
	"runtime"
	"strconv"
	"strings"

	"golang.org/x/crypto/scrypt"
	"golang.org/x/text/unicode/norm"
)

// Cost is the scrypt work factor. It is written into every stored hash, so it can be raised later without
// locking anyone out.
type Cost struct{ N, R, P int }

// DefaultCost takes about 100 ms and 32 MB per hash.
var DefaultCost = Cost{N: 1 << 15, R: 8, P: 1}

const keyLen = 32

// hashing limits how many scrypt runs are in memory at once: a flood of logins must not become a flood of 32 MB buffers.
var hashing = make(chan struct{}, max(2, runtime.NumCPU()))

func derive(password string, salt []byte, c Cost) ([]byte, error) {
	hashing <- struct{}{}
	defer func() { <-hashing }()
	return scrypt.Key([]byte(norm.NFKC.String(password)), salt, c.N, c.R, c.P, keyLen)
}

// HashPassword returns `scrypt$N$r$p$salt$hash`.
func HashPassword(password string, c Cost) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := derive(password, salt, c)
	if err != nil {
		return "", err
	}
	enc := base64.StdEncoding
	return fmt.Sprintf("scrypt$%d$%d$%d$%s$%s", c.N, c.R, c.P, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

// VerifyPassword compares in constant time; anything it cannot parse is simply "no".
func VerifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 6 || parts[0] != "scrypt" {
		return false
	}
	n, r, p := atoi(parts[1]), atoi(parts[2]), atoi(parts[3])
	salt, err1 := base64.StdEncoding.DecodeString(parts[4])
	want, err2 := base64.StdEncoding.DecodeString(parts[5])
	if err1 != nil || err2 != nil || n < 2 || r < 1 || p < 1 {
		return false
	}
	key, err := derive(password, salt, Cost{N: n, R: r, P: p})
	return err == nil && subtle.ConstantTimeCompare(key, want) == 1
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// NewToken is a device token: 256 random bits. Only its hash is stored.
func NewToken() string {
	return "nvs_" + base64.RawURLEncoding.EncodeToString(randomBytes(32))
}

// NewID is a random UUID (version 4).
func NewID() string {
	b := randomBytes(16)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("no randomness: " + err.Error()) // the system cannot make safe secrets; carrying on would be worse
	}
	return b
}

// SHA256Hex is the hex SHA-256 of a string.
func SHA256Hex(v string) string {
	sum := sha256.Sum256([]byte(v))
	return hex.EncodeToString(sum[:])
}

const keyAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O/1/I

// NewRecoveryKey is 20 characters of a 32 letter alphabet = 100 bits, shown as XXXXX-XXXXX-XXXXX-XXXXX.
func NewRecoveryKey() string {
	chars := make([]byte, 20)
	for i := range chars {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(keyAlphabet))))
		if err != nil {
			panic("no randomness: " + err.Error())
		}
		chars[i] = keyAlphabet[n.Int64()]
	}
	s := string(chars)
	return s[0:5] + "-" + s[5:10] + "-" + s[10:15] + "-" + s[15:]
}

// RecoveryHash is what is stored of a recovery key; letter case, spaces and dashes do not matter.
func RecoveryHash(key string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(key) {
		if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return SHA256Hex("recovery:" + b.String())
}

// SafeEqual compares two strings without leaking where they differ.
func SafeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
