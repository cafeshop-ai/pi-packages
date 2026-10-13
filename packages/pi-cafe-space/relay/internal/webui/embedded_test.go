//go:build webembed

package webui

import (
	"strings"
	"testing"
)

func TestEmbeddedBuild(t *testing.T) {
	a, d, e := Embedded()
	if e != nil || a == nil || len(d) != 64 {
		t.Fatal(e, d)
	}
	body, mime, ok := a.Get("/")
	if !ok || !strings.Contains(mime, "text/html") || !strings.Contains(string(body), "/assets/") {
		t.Fatal("missing built entry")
	}
	if _, _, ok := a.Get("/asset-manifest.json"); ok {
		t.Fatal("private manifest exposed")
	}
}
