package envelope

import (
	"encoding/json"
	"os"
	"testing"
)

// The same vectors the TypeScript parser passes (packages/protocol/vectors): both languages must agree on every case.
func TestSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/protocol/vectors/envelope.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name  string `json:"name"`
		JSON  string `json:"json"`
		Valid bool   `json:"valid"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) < 20 {
		t.Fatalf("only %d vectors", len(vectors))
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			e, err := Parse([]byte(v.JSON))
			if v.Valid && err != nil {
				t.Fatalf("should be valid: %v", err)
			}
			if !v.Valid && err == nil {
				t.Fatalf("should be refused, got %+v", e)
			}
		})
	}
}

func TestHLCMilliseconds(t *testing.T) {
	e, err := Parse([]byte(`{"v":1,"op":"019a8f3c-2b10-7c3e-8f00-1a2b3c4d5e6f","ws":"019a8f3c-2b10-7c3e-8f00-1a2b3c4d5e01","doc":"019a8f3c-2b10-7c3e-8f00-1a2b3c4d5e02","dev":"019a8f3c-2b10-7c3e-8f00-1a2b3c4d5e03","t":"019a8f3c2b10-0001-019a8f3c-2b10-7c3e-8f00-1a2b3c4d5e03","sv":1,"kid":0,"p":""}`))
	if err != nil {
		t.Fatal(err)
	}
	if e.HLCMs != 0x019a8f3c2b10 {
		t.Fatalf("ms = %x", e.HLCMs)
	}
}
