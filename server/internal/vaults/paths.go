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
	roots         = map[string]bool{"pages": true, "pages-state": true, "files": true, "history": true, "kv": true, ".trash": true, "databases": true}
	reserved      = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$`)
	databaseFile  = regexp.MustCompile(`^[A-Za-z0-9_~. ()-]+$`)
	pageStateName = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$`)
)

// the record folders of the desktop client (KINDS in database/mod.rs)
var databaseKinds = map[string]bool{
	"containers": true, "sources": true, "properties": true, "views": true, "relations": true, "edges": true,
	"templates": true, "workflows": true, "comments": true, "principals": true, "grants": true, "events": true, "allocators": true,
}

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
	if parts[0] == "pages-state" && !(len(parts) == 2 && pageStateName.MatchString(parts[1])) {
		return "bad_page_state_path"
	}
	return ""
}

// databasePath: databases/<kind folder>/<name>.json, nothing deeper. It is exactly what the desktop client accepts
// (safe_database_rel): a path the server took but the client refuses would stop the sync on every device.
func databasePath(parts []string) bool {
	if len(parts) != 3 || !databaseKinds[parts[1]] {
		return false
	}
	file := parts[2]
	return strings.HasSuffix(file, ".json") && !strings.HasPrefix(file, ".") && databaseFile.MatchString(file)
}

// foldCase: two paths that differ only in letter case are one file on Windows and macOS, so the server treats them as one.
func foldCase(p string) string { return strings.ToLower(p) }
