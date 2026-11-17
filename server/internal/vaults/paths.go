package vaults

import (
	"regexp"
	"strings"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"
)

// Which paths a vault may contain: the places the desktop app syncs, refused early on the server so that a hostile
// or buggy client cannot make a path that breaks another operating system.
//
// The marker is `.nevis/vault.json`, the name the desktop client uses.
const (
	markerPath = ".nevis/vault.json"
	maxPath    = 240 // counted in UTF-16 units, like the client does
)

var (
	roots        = map[string]bool{"pages": true, "files": true, "history": true, "kv": true, ".trash": true, "databases": true}
	reserved     = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$`)
	databaseKind = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
)

func hasBadChar(p string) bool {
	return strings.ContainsFunc(p, func(r rune) bool { return r <= 0x1f || r == 0x7f || strings.ContainsRune(`<>"|?*:\`, r) })
}

// checkPath is "" when the path is fine, otherwise a short reason.
func checkPath(p string) string {
	switch {
	case p == "":
		return "empty"
	case len(utf16.Encode([]rune(p))) > maxPath:
		return "too_long"
	case !norm.NFC.IsNormalString(p):
		return "not_nfc"
	case strings.HasPrefix(p, "/"):
		return "absolute"
	case hasBadChar(p):
		return "bad_char"
	case p == markerPath:
		return ""
	}
	parts := strings.Split(p, "/")
	if len(parts) < 2 || !roots[parts[0]] {
		return "outside_vault"
	}
	for _, seg := range parts {
		switch {
		case seg == "" || seg == "." || seg == ".." || strings.HasSuffix(seg, ".") || strings.HasSuffix(seg, " "):
			return "bad_segment"
		case reserved.MatchString(seg):
			return "reserved_name"
		case strings.HasPrefix(seg, ".") && strings.HasSuffix(seg, ".tmp"):
			return "temp_file"
		}
	}
	if parts[0] == "databases" && !databasePath(parts) {
		return "bad_database_path"
	}
	return ""
}

// databasePath: databases/<kind>/<name>.json, nothing deeper. Which kinds exist is the client's business.
func databasePath(parts []string) bool {
	return len(parts) == 3 && databaseKind.MatchString(parts[1]) && len(parts[2]) > len(".json") && strings.HasSuffix(parts[2], ".json")
}

// foldCase: two paths that differ only in letter case are one file on Windows and macOS, so the server treats them as one.
func foldCase(p string) string { return strings.ToLower(p) }
