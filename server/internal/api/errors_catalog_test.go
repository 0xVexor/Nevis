package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"testing"
)

// The shared error catalog (packages/protocol/vectors/errors.json) must be exactly what the server can answer: every
// (status, code) pair in the source is in the catalog, and every catalog entry is produced somewhere.
func TestErrorCatalogMatchesTheServer(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/protocol/vectors/errors.json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog []struct {
		Status int    `json:"status"`
		Code   string `json:"code"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{}
	for _, e := range catalog {
		want[strconv.Itoa(e.Status)+" "+e.Code] = true
	}
	re := regexp.MustCompile(`(?:fail\(w, |apierr\.(?:New|With)\()(\d{3}), "([a-z_]+)"`)
	got := map[string]bool{"429 rate_limited": true} // apierr.RateLimited builds this one
	for _, f := range []string{"api.go", "auth.go", "middleware.go", "ws.go", "web.go", "../auth/pow.go"} {
		src, err := os.ReadFile(filepath.Clean(f))
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range re.FindAllStringSubmatch(string(src), -1) {
			got[m[1]+" "+m[2]] = true
		}
	}
	var missing, extra []string
	for k := range got {
		if !want[k] {
			missing = append(missing, k)
		}
	}
	for k := range want {
		if !got[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	if len(missing) > 0 || len(extra) > 0 {
		t.Fatalf("the server answers %v which the catalog lacks; the catalog lists %v which the server never answers", missing, extra)
	}
	if len(catalog) < 25 {
		t.Fatalf("only %d catalog entries", len(catalog))
	}
}
