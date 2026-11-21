// Package envelope parses and validates the one thing the server reads about an op (ADR-0005). It is deliberately strict
// (ADR-0008): a duplicate key, an unknown field, a float, a number beyond 2^53-1, a lone surrogate or a BOM are all errors.
// It never looks inside `p`.
package envelope

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"unicode/utf8"
)

const MaxPChars = 1_500_000
const maxSafe = 1<<53 - 1

// Envelope is a validated envelope plus the exact bytes it arrived as.
type Envelope struct {
	V   int
	Op  string
	WS  string
	Doc string
	Dev string
	T   string
	SV  int
	KID int
	N   string
	P   string
	Cov *int
	// Pg marks a PURGE op (the permanent deletion of the document): the server then forgets every other op of the doc.
	Pg bool

	Raw    []byte
	SHA256 [32]byte
	// HLCMs is the millisecond part of T.
	HLCMs int64
}

// Error is a bad envelope (always answered 400 bad_envelope).
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

func bad(format string, a ...any) error { return &Error{Msg: fmt.Sprintf(format, a...)} }

var (
	uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	hlcRE  = regexp.MustCompile(`^([0-9a-f]{12})-([0-9a-f]{4})-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)
	b64RE  = regexp.MustCompile(`^[A-Za-z0-9_-]*$`)
	intRE  = regexp.MustCompile(`^-?(0|[1-9][0-9]*)$`)
)

var known = map[string]bool{"v": true, "op": true, "ws": true, "doc": true, "dev": true, "t": true, "sv": true, "kid": true, "n": true, "p": true, "cov": true, "pg": true}

// Parse validates one envelope given as JSON bytes.
func Parse(raw []byte) (*Envelope, error) {
	if bytes.HasPrefix(raw, []byte{0xef, 0xbb, 0xbf}) {
		return nil, bad("byte order mark")
	}
	if !utf8.Valid(raw) {
		return nil, bad("invalid UTF-8")
	}
	if err := checkSurrogates(raw); err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return nil, bad("not JSON: %v", err)
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, bad("envelope must be an object")
	}
	vals := map[string]any{}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, bad("not JSON: %v", err)
		}
		key, ok := kt.(string)
		if !ok {
			return nil, bad("bad key")
		}
		if _, dup := vals[key]; dup {
			return nil, bad("duplicate key %q", key)
		}
		if !known[key] {
			return nil, bad("unknown field %q", key)
		}
		vt, err := dec.Token()
		if err != nil {
			return nil, bad("not JSON: %v", err)
		}
		if _, isDelim := vt.(json.Delim); isDelim {
			return nil, bad("field %q must be a scalar", key)
		}
		vals[key] = vt
	}
	if _, err := dec.Token(); err != nil { // the closing brace
		return nil, bad("not JSON: %v", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, bad("trailing data")
	}

	e := &Envelope{Raw: append([]byte(nil), raw...), SHA256: sha256.Sum256(raw)}
	getInt := func(k string, min int, required bool) (int, bool, error) {
		v, present := vals[k]
		if !present {
			if required {
				return 0, false, bad("%s is required", k)
			}
			return 0, false, nil
		}
		n, ok := v.(json.Number)
		if !ok || !intRE.MatchString(n.String()) || n.String() == "-0" {
			return 0, true, bad("%s must be an integer", k)
		}
		i, err := strconv.ParseInt(n.String(), 10, 64)
		if err != nil || i > maxSafe || i < -maxSafe {
			return 0, true, bad("%s out of range", k)
		}
		if int(i) < min {
			return 0, true, bad("%s must be >= %d", k, min)
		}
		return int(i), true, nil
	}
	getStr := func(k string, re *regexp.Regexp, required bool) (string, bool, error) {
		v, present := vals[k]
		if !present {
			if required {
				return "", false, bad("%s is required", k)
			}
			return "", false, nil
		}
		s, ok := v.(string)
		if !ok || !re.MatchString(s) {
			return "", true, bad("%s is malformed", k)
		}
		return s, true, nil
	}

	var verr error
	check := func(err error) {
		if verr == nil {
			verr = err
		}
	}
	v, _, err := getInt("v", 1, true)
	check(err)
	if verr == nil && v != 1 {
		check(bad("v must be 1"))
	}
	e.V = v
	for _, f := range []struct {
		k string
		p *string
	}{{"op", &e.Op}, {"ws", &e.WS}, {"doc", &e.Doc}, {"dev", &e.Dev}} {
		s, _, err := getStr(f.k, uuidRE, true)
		check(err)
		*f.p = s
	}
	t, _, err := getStr("t", hlcRE, true)
	check(err)
	e.T = t
	e.SV, _, err = getInt("sv", 1, true)
	check(err)
	e.KID, _, err = getInt("kid", 0, true)
	check(err)
	p, _, err := getStr("p", b64RE, true)
	check(err)
	if verr == nil {
		if len(p) > MaxPChars {
			check(bad("p too long"))
		} else if _, derr := base64.RawURLEncoding.Strict().DecodeString(p); derr != nil {
			check(bad("p is not valid base64url"))
		}
	}
	e.P = p
	if n, present, err := getStr("n", b64RE, false); present {
		check(err)
		if e.KID == 0 {
			check(bad("n is only allowed when kid > 0"))
		}
		e.N = n
	}
	if c, present, err := getInt("cov", 0, false); present {
		check(err)
		e.Cov = &c
	}
	if pg, present, err := getInt("pg", 1, false); present {
		check(err)
		if err == nil && pg != 1 {
			check(bad("pg must be 1"))
		}
		e.Pg = true
	}
	if e.Pg && e.Cov != nil {
		check(bad("a purge op has no cov"))
	}
	if verr != nil {
		return nil, verr
	}
	m := hlcRE.FindStringSubmatch(e.T)
	ms, _ := strconv.ParseInt(m[1], 16, 64)
	e.HLCMs = ms
	return e, nil
}

// checkSurrogates rejects a \uD800-\uDFFF escape that is not part of a valid pair.
func checkSurrogates(raw []byte) error {
	s := string(raw)
	hex4 := func(i int) (int, bool) {
		if i+4 > len(s) {
			return 0, false
		}
		n, err := strconv.ParseUint(s[i:i+4], 16, 32)
		return int(n), err == nil
	}
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' {
			continue
		}
		if i+1 >= len(s) {
			break
		}
		if s[i+1] != 'u' {
			i++ // skip the escaped character (this also skips an escaped backslash)
			continue
		}
		n, ok := hex4(i + 2)
		if !ok {
			continue
		}
		switch {
		case n >= 0xd800 && n <= 0xdbff:
			if i+12 <= len(s) && s[i+6] == '\\' && s[i+7] == 'u' {
				if m, ok := hex4(i + 8); ok && m >= 0xdc00 && m <= 0xdfff {
					i += 11
					continue
				}
			}
			return bad("lone surrogate")
		case n >= 0xdc00 && n <= 0xdfff:
			return bad("lone surrogate")
		}
		i += 5
	}
	return nil
}

// ValidWorkspace reports whether s is a UUID in the form the protocol uses.
func ValidWorkspace(s string) bool { return uuidRE.MatchString(s) }
