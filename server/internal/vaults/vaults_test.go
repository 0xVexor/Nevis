package vaults

import (
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestCheckPath(t *testing.T) {
	good := []string{
		"pages/a.json", "files/ab/cd.bin", "history/records/view/v1/0000000001.json", "kv/srs.json", ".trash/pages/a.json",
		".nevis/vault.json", "pages/Abc.json", "pages/" + strings.Repeat("é", 100) + ".json",
		"databases/views/abc.json", "databases/events/rep~3atpl~7c1.json",
	}
	for _, p := range good {
		if why := checkPath(p); why != "" {
			t.Errorf("%q refused: %s", p, why)
		}
	}
	bad := map[string]string{
		"": "empty", "../x": "outside_vault", "/abs": "absolute", "other/a.json": "outside_vault", "pages/CON": "reserved_name",
		"pages/con.txt": "reserved_name", "pages/LPT3": "reserved_name", "pages/a:b": "bad_char", "pages/a\\b": "bad_char",
		"pages/a\x01b": "bad_char", "pages//a": "bad_segment", "pages/a.": "bad_segment", "pages/a ": "bad_segment",
		"pages/./a": "bad_segment", "pages/../a": "bad_segment", "pages/.x.tmp": "temp_file", "pages": "outside_vault",
		"databases/views/../../x.json": "bad_segment", "databases/nope1/sub/x.json": "bad_database_path", "databases/views/sub/x.json": "bad_database_path",
		"databases/views/x.exe": "bad_database_path", "databases/x.json": "bad_database_path", "databases/Views/x.json": "bad_database_path",
		"pages/é.json": "not_nfc",
	}
	for p, want := range bad {
		if got := checkPath(p); got != want {
			t.Errorf("%q: got %q, want %q", p, got, want)
		}
	}
}

func TestPathLengthCountsUTF16Units(t *testing.T) {
	ascii := "pages/" + strings.Repeat("a", maxPath-len("pages/"))
	if why := checkPath(ascii); why != "" {
		t.Errorf("a path of exactly %d units refused: %s", maxPath, why)
	}
	if why := checkPath(ascii + "a"); why != "too_long" {
		t.Errorf("one unit over: %q", why)
	}
	// bytes would say 240 for 120 two-byte letters and 360 for 120 three-byte ones; the limit is in UTF-16 units, like the client's
	twoByte := "pages/" + strings.Repeat("é", 120)
	if why := checkPath(twoByte); why != "" {
		t.Errorf("non-ASCII path of 126 units refused: %s", why)
	}
	astral := "pages/" + strings.Repeat("\U0001F4C4", 118) // 118 * 2 units + 6 = 242
	if why := checkPath(astral); why != "too_long" {
		t.Errorf("astral characters count two units each: %q", why)
	}
}

// The clients compute the same hash over their mirror of the server's list (hub.rs, root_of), so this value is
// pinned: it is the one their tests assert for these two files.
func TestRootHashMatchesTheClient(t *testing.T) {
	h := sha256.New()
	for _, f := range []struct{ path, content string }{{"pages/a.json", "a"}, {"pages/b.json", "b"}} {
		sum := md5.Sum([]byte(f.content))
		addToRoot(h, f.path, hex.EncodeToString(sum[:]))
	}
	const want = "9ee351a4056cc95744c24c1693184bc11988f3dc98bb1a2dc86136caabca773d"
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		t.Fatalf("root hash %s, want %s", got, want)
	}
}

func TestFoldCase(t *testing.T) {
	if foldCase("pages/Abc.json") != foldCase("pages/aBC.json") {
		t.Fatal("paths that differ in letter case must fold to one")
	}
}
