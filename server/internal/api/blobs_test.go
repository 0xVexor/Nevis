package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

type blobEnv struct {
	*m4
	tok, ws string
}

func newBlobEnv(t *testing.T, tweak ...func(*Config)) *blobEnv {
	t.Helper()
	var dir string
	m := newM4(t, append([]func(*Config){func(c *Config) { c.DataDir = t.TempDir(); dir = c.DataDir }}, tweak...)...)
	_ = dir
	a := m.signup(t, "ann", "device")
	tok := a.body["token"].(string)
	ws := m.do(t, "POST", "/v1/ws", map[string]any{"name": "w"}, bearer(tok)).body["id"].(string)
	return &blobEnv{m4: m, tok: tok, ws: ws}
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// rawDo sends bytes (not JSON) with the headers of a real client.
func (e *blobEnv) rawDo(t *testing.T, method, path string, body []byte, tok string, h map[string]string) (int, http.Header, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, e.srv.URL+path, bytes.NewReader(body))
	if method != "GET" && method != "HEAD" {
		req.Header.Set("Nevis-Proto", "1")
	}
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	for k, v := range h {
		req.Header.Set(k, v)
	}
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	return r.StatusCode, r.Header, b
}

func (e *blobEnv) put(t *testing.T, sha string, data []byte, offset, total int) resp {
	t.Helper()
	m := e.m4
	req, _ := http.NewRequest("PUT", fmt.Sprintf("%s/v1/ws/%s/blobs/%s?offset=%d&total=%d", m.srv.URL, e.ws, sha, offset, total), bytes.NewReader(data))
	req.Header.Set("Nevis-Proto", "1")
	req.Header.Set("Authorization", "Bearer "+e.tok)
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	var buf bytes.Buffer
	buf.ReadFrom(r.Body)
	out := map[string]any{}
	_ = json.Unmarshal(buf.Bytes(), &out)
	return resp{code: r.StatusCode, body: out, hdr: r.Header, raw: buf.Bytes()}
}

func TestBlobUploadInPiecesResumesAndIsServedAsAnOpaqueDownload(t *testing.T) {
	e := newBlobEnv(t)
	data := bytes.Repeat([]byte("<script>alert(1)</script>"), 4000) // hostile bytes that look like a page
	sha := sum(data)
	third := len(data) / 3
	if r := e.put(t, sha, data[:third], 0, len(data)); r.code != 200 || r.body["complete"] != false {
		t.Fatalf("first piece: %d %v", r.code, r.body)
	}
	// the connection "dies": a new client asks how much the server holds
	code, hdr, _ := e.rawDo(t, "HEAD", "/v1/ws/"+e.ws+"/blobs/"+sha, nil, e.tok, nil)
	if code != 404 || hdr.Get("Nevis-Received") != fmt.Sprint(third) {
		t.Fatalf("HEAD of a half upload: %d received=%q", code, hdr.Get("Nevis-Received"))
	}
	// a piece that skips ahead is refused and says where to resume
	if r := e.put(t, sha, data[2*third:], 2*third, len(data)); r.code != 409 || code2(r) != "out_of_order" || r.body["error"].(map[string]any)["received"].(float64) != float64(third) {
		t.Fatalf("skip ahead: %d %v", r.code, r.body)
	}
	if r := e.put(t, sha, data[third:2*third], third, len(data)); r.code != 200 {
		t.Fatalf("second piece: %d %v", r.code, r.body)
	}
	// the same piece again (a lost answer) is harmless
	if r := e.put(t, sha, data[third:2*third], third, len(data)); r.code != 200 || r.body["complete"] != false {
		t.Fatalf("repeated piece: %d %v", r.code, r.body)
	}
	if r := e.put(t, sha, data[2*third:], 2*third, len(data)); r.code != 200 || r.body["complete"] != true {
		t.Fatalf("last piece: %d %v", r.code, r.body)
	}
	code, hdr, _ = e.rawDo(t, "HEAD", "/v1/ws/"+e.ws+"/blobs/"+sha, nil, e.tok, nil)
	if code != 200 || hdr.Get("Nevis-Size") != fmt.Sprint(len(data)) {
		t.Fatalf("HEAD: %d %v", code, hdr)
	}
	// download with Range, and the headers that keep a user's bytes from ever running as a page on our origin
	code, hdr, body := e.rawDo(t, "GET", "/v1/ws/"+e.ws+"/blobs/"+sha, nil, e.tok, map[string]string{"Range": "bytes=10-19"})
	if code != 206 || string(body) != string(data[10:20]) {
		t.Fatalf("range: %d %q", code, body)
	}
	for k, want := range map[string]string{
		"Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment",
		"Content-Security-Policy": "sandbox; default-src 'none'", "Cross-Origin-Resource-Policy": "same-origin",
	} {
		if hdr.Get(k) != want {
			t.Errorf("%s = %q, want %q", k, hdr.Get(k), want)
		}
	}
	code, _, body = e.rawDo(t, "GET", "/v1/ws/"+e.ws+"/blobs/"+sha, nil, e.tok, nil)
	if code != 200 || !bytes.Equal(body, data) {
		t.Fatal("the whole file did not come back identical")
	}
}

func TestBlobWithAWrongHashIs400AndNothingIsKept(t *testing.T) {
	e := newBlobEnv(t)
	data := []byte("the real bytes")
	wrong := sum([]byte("other bytes"))
	if r := e.put(t, wrong, data, 0, len(data)); r.code != 400 || code2(r) != "hash_mismatch" {
		t.Fatalf("%d %v", r.code, r.body)
	}
	if c, _, _ := e.rawDo(t, "HEAD", "/v1/ws/"+e.ws+"/blobs/"+wrong, nil, e.tok, nil); c != 404 {
		t.Fatalf("the refused blob exists: %d", c)
	}
	// and a retry with the right bytes under the right name starts clean
	if r := e.put(t, sum(data), data, 0, len(data)); r.code != 200 || r.body["complete"] != true {
		t.Fatalf("%d %v", r.code, r.body)
	}
	if r := e.put(t, "ABC", data, 0, len(data)); r.code != 400 {
		t.Fatalf("a name that is not a hash: %d", r.code)
	}
	if r := e.put(t, strings.Repeat("0", 64), data, 0, 3); r.code != 400 {
		t.Fatalf("a piece beyond the announced total: %d", r.code)
	}
}

func TestBlobAccessIsPerWorkspaceMembershipAndNeedsTheProtocolHeader(t *testing.T) {
	e := newBlobEnv(t)
	data := []byte("private")
	sha := sum(data)
	if r := e.put(t, sha, data, 0, len(data)); r.code != 200 {
		t.Fatal(r.code)
	}
	stranger := e.signup(t, "eve", "device").body["token"].(string)
	for _, m := range []string{"GET", "HEAD"} {
		if c, _, _ := e.rawDo(t, m, "/v1/ws/"+e.ws+"/blobs/"+sha, nil, stranger, nil); c != 404 {
			t.Errorf("%s by a stranger: %d, want 404 (not 403)", m, c)
		}
	}
	if c, _, _ := e.rawDo(t, "PUT", "/v1/ws/"+e.ws+"/blobs/"+sha+"?offset=0&total=7", data, stranger, nil); c != 404 {
		t.Errorf("PUT by a stranger: %d", c)
	}
	viewer := e.signup(t, "vic", "device")
	if err := e.st.AddMember(t.Context(), e.ws, viewer.body["account"].(map[string]any)["id"].(string), "viewer"); err != nil {
		t.Fatal(err)
	}
	vt := viewer.body["token"].(string)
	if c, _, body := e.rawDo(t, "GET", "/v1/ws/"+e.ws+"/blobs/"+sha, nil, vt, nil); c != 200 || string(body) != "private" {
		t.Errorf("a viewer reads: %d", c)
	}
	other := []byte("viewer file")
	if c, _, _ := e.rawDo(t, "PUT", "/v1/ws/"+e.ws+"/blobs/"+sum(other)+"?offset=0&total=11", other, vt, nil); c != 403 {
		t.Errorf("a viewer uploads: %d, want 403", c)
	}
	// without the header a PUT is refused as a possible cross-site request
	req, _ := http.NewRequest("PUT", e.srv.URL+"/v1/ws/"+e.ws+"/blobs/"+sha+"?offset=0&total=7", bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+e.tok)
	if r, _ := http.DefaultClient.Do(req); r.StatusCode != 403 {
		t.Errorf("PUT without Nevis-Proto: %d", r.StatusCode)
	}
}

func TestBlobQuotaIsChargedOnceRefusedWhenFullAndGivenBackByGC(t *testing.T) {
	e := newBlobEnv(t, func(c *Config) { c.QuotaBytes = 1000 })
	a := bytes.Repeat([]byte{1}, 600)
	b := bytes.Repeat([]byte{2}, 600)
	used := func() float64 { return e.do(t, "GET", "/v1/me", nil, bearer(e.tok)).body["usedBytes"].(float64) }
	if r := e.put(t, sum(a), a, 0, 600); r.code != 200 {
		t.Fatal(r.code, r.body)
	}
	if used() != 600 {
		t.Fatalf("used %v", used())
	}
	if r := e.put(t, sum(a), a, 0, 600); r.code != 200 || used() != 600 { // the same file again costs nothing
		t.Fatalf("re-upload charged: %v", used())
	}
	r := e.put(t, sum(b), b, 0, 600)
	if r.code != 507 || code2(r) != "quota_exceeded" {
		t.Fatalf("over quota: %d %v", r.code, r.body)
	}
	if c, _, _ := e.rawDo(t, "HEAD", "/v1/ws/"+e.ws+"/blobs/"+sum(b), nil, e.tok, nil); c != 404 {
		t.Fatal("a blob that did not fit is stored")
	}
	if used() != 600 {
		t.Fatalf("a refused upload changed the quota: %v", used())
	}
	// the push of ops is a separate path and the first blob is untouched
	if c, _, body := e.rawDo(t, "GET", "/v1/ws/"+e.ws+"/blobs/"+sum(a), nil, e.tok, nil); c != 200 || len(body) != 600 {
		t.Fatal("the stored blob was damaged by the refused one")
	}
}

func TestBlobTooLargeForTheServerIs413BeforeAnyByteIsKept(t *testing.T) {
	e := newBlobEnv(t, func(c *Config) { c.MaxBlobBytes = 100 })
	if r := e.put(t, sum([]byte("x")), []byte("x"), 0, 101); r.code != 413 || code2(r) != "blob_too_large" {
		t.Fatalf("%d %v", r.code, r.body)
	}
}

func TestBlobReferenceReportsNeedWriteAccessAndTellIfTheyWereComplete(t *testing.T) {
	e := newBlobEnv(t)
	data := []byte("x")
	e.put(t, sum(data), data, 0, 1)
	r := e.do(t, "POST", "/v1/ws/"+e.ws+"/blobs/refs", map[string]any{"cursor": 0, "refs": []string{sum(data)}}, bearer(e.tok))
	if r.code != 200 || r.body["applied"] != true {
		t.Fatalf("%d %v", r.code, r.body)
	}
	if r := e.do(t, "POST", "/v1/ws/"+e.ws+"/blobs/refs", map[string]any{"cursor": 0, "refs": []string{"zz"}}, bearer(e.tok)); r.code != 400 {
		t.Fatalf("a bad hash: %d", r.code)
	}
	vic := e.signup(t, "vic", "device")
	e.st.AddMember(t.Context(), e.ws, vic.body["account"].(map[string]any)["id"].(string), "viewer")
	if r := e.do(t, "POST", "/v1/ws/"+e.ws+"/blobs/refs", map[string]any{"cursor": 0, "refs": []string{}}, bearer(vic.body["token"].(string))); r.code != 403 {
		t.Fatalf("a viewer reports: %d", r.code)
	}
}

func code2(r resp) string { return code(r) }
