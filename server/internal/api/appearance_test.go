package api

import (
	"net/http"
	"testing"
)

func TestAccountAppearanceIsolationAndInitialization(t *testing.T) {
	server := newM4(t)
	const path = "/v1/me/appearance"
	type account struct {
		id      string
		headers map[string]string
	}
	signup := func(username string) account {
		result := server.signup(t, username, "device")
		if result.code != http.StatusOK {
			t.Fatalf("signup failed: %d", result.code)
		}
		return account{result.body["account"].(map[string]any)["id"].(string), bearer(result.body["token"].(string))}
	}
	owner, other := signup("appearance-owner"), signup("appearance-other")
	patch := func(a account, id string, values map[string]any, initialize bool) resp {
		return server.do(t, http.MethodPatch, path, map[string]any{"accountId": id, "values": values, "initialize": initialize}, a.headers)
	}
	if result := server.do(t, http.MethodGet, path, nil, nil); result.code != 401 {
		t.Fatalf("anonymous access: %d", result.code)
	}
	if result := patch(owner, owner.id, map[string]any{"accent": "#ff8800", "font": "vazir"}, true); result.code != 200 {
		t.Fatalf("initial preferences: %d", result.code)
	}
	result := patch(owner, owner.id, map[string]any{"accent": "#2244ff", "fontEn": "inter"}, true)
	if result.code != 200 || result.body["values"].(map[string]any)["accent"] != "#ff8800" || result.body["values"].(map[string]any)["fontEn"] != "inter" {
		t.Fatalf("second device initialized over existing settings: %v", result.body)
	}
	if result := patch(other, owner.id, map[string]any{"accent": "#2244ff"}, false); result.code != 409 {
		t.Fatalf("cross-account change: %d", result.code)
	}
	if result := patch(owner, owner.id, map[string]any{"unknown": "field"}, false); result.code != 400 {
		t.Fatalf("unknown preference: %d", result.code)
	}
	result = patch(owner, owner.id, map[string]any{"accent": nil}, false)
	if result.code != 200 {
		t.Fatalf("explicit reset: %d", result.code)
	}
	values := result.body["values"].(map[string]any)
	if accent, ok := values["accent"]; !ok || accent != nil || values["font"] != "vazir" {
		t.Fatalf("reset must retain other fields and serialise the default: %v", values)
	}
	result = server.do(t, http.MethodGet, path, nil, other.headers)
	if result.code != 200 || len(result.body["values"].(map[string]any)) != 0 {
		t.Fatalf("other account must not see owner settings: %d %v", result.code, result.body)
	}
}
