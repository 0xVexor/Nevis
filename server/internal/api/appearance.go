package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"slices"

	"github.com/nevis-app/nevis/server/internal/store"
)

var appearanceColor = regexp.MustCompile("(?i)^#[0-9a-f]{6}$")
var appearanceFonts = []string{"vazir", "estedad", "notosans", "ibm", "kufi", "naskh", "amiri", "inter", "geist", "jakarta", "sourceserif", "jetbrains", "system", "serif", "mono"}

func validAppearance(name string, value json.RawMessage) bool {
	switch name {
	case "accent", "textColor":
		var color *string
		return json.Unmarshal(value, &color) == nil && (color == nil || appearanceColor.MatchString(*color))
	case "font", "fontEn":
		var font *string
		return json.Unmarshal(value, &font) == nil && ((font == nil && name == "fontEn") || (font != nil && slices.Contains(appearanceFonts, *font)))
	case "fontSize":
		var size int
		return json.Unmarshal(value, &size) == nil && size >= 12 && size <= 28
	default:
		return false
	}
}

func (s *Server) appearance(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	if p.Dev || p.AccountID == "" {
		fail(w, http.StatusUnauthorized, "sign_in_required", "sign in to sync appearance", false)
		return
	}
	if r.Method == http.MethodPatch {
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		var input struct {
			AccountID  string                     `json:"accountId"`
			Initialize bool                       `json:"initialize"`
			Values     map[string]json.RawMessage `json:"values"`
		}
		if !readJSON(w, r, &input) {
			return
		}
		if input.AccountID != p.AccountID {
			fail(w, http.StatusConflict, "account_changed", "the signed-in account changed", false)
			return
		}
		for name, value := range input.Values {
			if !validAppearance(name, value) {
				fail(w, http.StatusBadRequest, "bad_appearance", "invalid appearance setting", false)
				return
			}
		}
		if err := s.st.SaveAccountAppearance(r.Context(), p.AccountID, input.Values, input.Initialize); err != nil {
			fail(w, http.StatusInternalServerError, "internal", "could not save appearance", true)
			return
		}
	}
	values, err := s.st.AccountAppearance(r.Context(), p.AccountID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not read appearance", true)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accountId": p.AccountID, "values": values})
}
